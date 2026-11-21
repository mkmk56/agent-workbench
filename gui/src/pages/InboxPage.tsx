import {
  Activity,
  AlarmClock,
  AtSign,
  BellRing,
  Check,
  CircleAlert,
  CornerUpLeft,
  Inbox,
  RefreshCw,
  RotateCcw,
  UserRound,
} from '../ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chatInboxOnce,
  markChatRead,
  type ChatInboxEntry,
  type ChatInboxPayload,
} from '../lib/chat';
import { formatRelative } from '../lib/labels';
import { countUnreadByChat } from '../lib/community';
import { useJoinNotices } from '../lib/join-notices';
import { useEngineEventSignal, useEngineEventsStatus } from '../lib/engine';
import { navigate } from '../lib/router';
import {
  canManageWake,
  formatWakeKinds,
  listenerStatusOnce,
  setWakeEnabled,
  wakeEventStatusLabel,
  wakeKindLabel,
  wakeStatusOnce,
  wakeToggleFailureText,
} from '../lib/wake';
import type {
  ListenerStatusPayload,
  WakeChatStatus,
  WakeLastEvent,
  WakeStatusPayload,
} from '../types';
import '../styles/chat.css';

/**
 * Inbox (REA Phase 2, docs/rea/TARGET_ARCHITECTURE.md D3) plus the Phase 3
 * wake status row (docs/rea/PHASE3_DESIGN.md §13).
 *
 * One agent's per-chat unread counters straight from the engine `inbox` tool:
 * mentions_you / replies_to_you / from_owner / recalled. The response's `you`
 * block is shown as an identity self-check, so the UI never claims to show a
 * different agent than the one the engine answered for.
 *
 * Phase 3 adds three wake facts per chat, all from `wake_status` (no local
 * derivation): the wake switch, the last event time, and today's run count plus
 * the consecutive-failure counter. The agent-level last check-in comes from
 * `listener_status.checkin`. Disabled wake is marked red. The switch is hidden
 * unless this workstation owns the agent (`you.owner === 'user'`); the engine's
 * `wake_enable` / `wake_disable` are owner-only and stay the authority.
 *
 * "打开群即已读": opening a chat only advances the viewer's own cursor through
 * `chat_mark_read` (the same call the chat page makes after pulling messages).
 * Clearing an *agent's* cursor is a separate, explicit action — the owner may
 * do it per row, and it is never done silently, because that cursor drives the
 * agent's own delivery/wake decisions (Phase 3).
 */

const AGENTS = [
  { id: 'muse', label: 'Muse' },
  { id: 'claude', label: 'Claude' },
  { id: 'dsh', label: 'dsh' },
] as const;

type AgentHandle = (typeof AGENTS)[number]['id'];

const POLL_MS = 5_000;

interface CategoryChip {
  key: 'mentions_you' | 'replies_to_you' | 'from_owner' | 'recalled';
  label: string;
  icon: typeof AtSign;
}

const CHIPS: CategoryChip[] = [
  { key: 'mentions_you', label: '@ 提及', icon: AtSign },
  { key: 'replies_to_you', label: '回复', icon: CornerUpLeft },
  { key: 'from_owner', label: '群主', icon: UserRound },
  { key: 'recalled', label: '撤回', icon: RotateCcw },
];

function sortEntries(entries: ChatInboxEntry[]): ChatInboxEntry[] {
  return [...entries].sort((a, b) => {
    if (b.unread !== a.unread) {
      return b.unread - a.unread;
    }
    const aTime = a.last_message_at != null ? Date.parse(a.last_message_at) : 0;
    const bTime = b.last_message_at != null ? Date.parse(b.last_message_at) : 0;
    return bTime - aTime;
  });
}

/** Last wake event for one chat, in the same relative-time vocabulary as the list. */
function lastEventText(event: WakeLastEvent | null): string {
  if (event == null) {
    return '暂无唤醒事件';
  }
  const at = event.created_at != null ? formatRelative(event.created_at) : '时间未知';
  return `${wakeKindLabel(event.kind)} · ${wakeEventStatusLabel(event.status)} · ${at}`;
}

export function InboxPage() {
  const [agent, setAgent] = useState<AgentHandle>('muse');
  const [inbox, setInbox] = useState<ChatInboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  // Phase 3 wake status. Kept separate from the inbox payload so a wake read
  // failure never hides the unread counters (and vice versa).
  const [wake, setWake] = useState<WakeStatusPayload | null>(null);
  const [listener, setListener] = useState<ListenerStatusPayload | null>(null);
  // Reading the status and flipping the switch are different operations with
  // different failures (the switch is owner-only and can be refused). Keep
  // their banners apart so a poll that succeeds never hides a refusal.
  const [wakeLoadError, setWakeLoadError] = useState<string | null>(null);
  const [wakeToggleError, setWakeToggleError] = useState<string | null>(null);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [wakeBusy, setWakeBusy] = useState<string | null>(null);
  // Monotonic id per inbox request. A response that is no longer the newest one
  // — the owner switched tab or hit refresh — is dropped instead of overwriting
  // the counters of the agent now on screen.
  const requestId = useRef(0);
  // The agent whose tab is displayed, mirrored into a ref so a late `load()`
  // still pending for the previous agent (e.g. the reload after clearing its
  // cursor) cannot win the race against a tab switch.
  const activeAgent = useRef<AgentHandle>(agent);

  const load = useCallback(
    async (handle: AgentHandle) => {
      const id = (requestId.current += 1);
      try {
        // The three reads are independent tools; run them together but treat
        // their results separately (one failing tool must not blank the others).
        const [inboxResult, wakeResult, listenerResult] = await Promise.all([
          chatInboxOnce(handle),
          wakeStatusOnce(handle),
          listenerStatusOnce(handle),
        ]);
        if (id !== requestId.current || handle !== activeAgent.current) {
          return; // Stale: a newer request or another tab owns the view.
        }
        if (inboxResult.ok) {
          setInbox(inboxResult.data);
          setError(null);
        } else {
          setError(inboxResult.error);
        }
        if (wakeResult.ok) {
          setWake(wakeResult.data);
          setWakeLoadError(null);
        } else {
          setWake(null);
          setWakeLoadError(wakeResult.error);
        }
        if (listenerResult.ok) {
          setListener(listenerResult.data);
          setListenerError(null);
        } else {
          setListener(null);
          setListenerError(listenerResult.error);
        }
      } finally {
        if (id === requestId.current && handle === activeAgent.current) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    activeAgent.current = agent;
    // Switching tabs must not keep showing the previous agent's counters,
    // wake switches or listener state under the new agent's name.
    setInbox(null);
    setWake(null);
    setListener(null);
    setWakeLoadError(null);
    setWakeToggleError(null);
    setListenerError(null);
    setWakeBusy(null);
    setLoading(true);
    void load(agent);
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void load(agent);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [agent, load]);

  // Phase 4 §7.2: a pushed wake event refreshes the inbox immediately; the
  // 15 s poll above stays as the floor when the stream is unavailable.
  const eventSignal = useEngineEventSignal();
  const events = useEngineEventsStatus();
  useEffect(() => {
    if (eventSignal === 0) {
      return;
    }
    void load(agent);
  }, [eventSignal, agent, load]);

  const entries = useMemo(() => sortEntries(inbox?.chats ?? []), [inbox]);
  const totalUnread = inbox?.total_unread ?? 0;

  // REA Phase 5 §4.7: join-request notices are a separate feed (not messages),
  // polled on the same cadence as the counters. They are shown per chat and
  // marked read through `chat_join_notices` mark_read.
  const joinNotices = useJoinNotices({ pollMs: POLL_MS });
  const joinGroups = useMemo(
    () => countUnreadByChat(joinNotices.notices),
    [joinNotices.notices],
  );
  const chatNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of inbox?.chats ?? []) {
      map.set(entry.chat_id, entry.name);
    }
    return map;
  }, [inbox]);

  // The switch is only meaningful — and only allowed — for agents this
  // workstation's owner owns. Until the inbox identity is known the control is
  // hidden rather than guessed, and the engine re-checks the token role anyway.
  const canManage =
    inbox != null && inbox.you.status !== 'revoked' && canManageWake(inbox.you.owner);

  const listenerText = (() => {
    if (listener != null) {
      if (listener.online) {
        return `Listener 在线 · ${listener.sessions.length} 个会话`;
      }
      return listener.sessions.length > 0
        ? `Listener 离线 · ${listener.sessions.length} 个会话`
        : '无 Listener 会话（内置 Agent 由引擎直接唤醒）';
    }
    return listenerError != null ? `Listener 状态不可用：${listenerError}` : 'Listener 状态读取中…';
  })();

  const checkinText = (() => {
    if (listener == null) {
      return listenerError != null ? 'check-in 状态不可用' : 'check-in 状态读取中…';
    }
    if (listener.checkin == null) {
      return '尚未设置 check-in';
    }
    const last =
      listener.checkin.last_checkin_at != null
        ? formatRelative(listener.checkin.last_checkin_at)
        : null;
    return last != null
      ? `每 ${listener.checkin.every_minutes} 分钟 · 最后 check-in ${last}`
      : `每 ${listener.checkin.every_minutes} 分钟 · 尚未 check-in`;
  })();

  // Owner-only switch. The reload after a successful toggle re-reads the engine
  // state instead of flipping local state optimistically, so the UI can never
  // claim wake is on when the engine refused.
  const toggleWake = async (row: WakeChatStatus) => {
    if (!canManage || wakeBusy != null) {
      return;
    }
    setWakeBusy(row.chat_id);
    // A new attempt supersedes the previous rejection; the banner is rebuilt
    // from this attempt's outcome only.
    setWakeToggleError(null);
    const result = await setWakeEnabled({
      agentId: agent,
      chatId: row.chat_id,
      enabled: !row.enabled,
    });
    setWakeBusy(null);
    if (agent !== activeAgent.current) {
      return; // The owner switched tabs while the toggle was in flight.
    }
    if (!result.ok) {
      setWakeToggleError(result.error);
      return;
    }
    setWakeToggleError(null);
    await load(agent);
  };

  // Opening the chat is the read action for the viewer; the agent counters stay
  // until the owner clears them explicitly.
  const openChat = async (entry: ChatInboxEntry) => {
    setActing(entry.chat_id);
    await markChatRead({ chatId: entry.chat_id });
    setActing(null);
    navigate(`/chats/${encodeURIComponent(entry.chat_id)}`);
  };

  const clearAgentCursor = async (entry: ChatInboxEntry) => {
    setActing(entry.chat_id);
    const result = await markChatRead({ chatId: entry.chat_id, participantId: agent });
    setActing(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await load(agent);
  };

  return (
    <section className="inbox-page" aria-label="收件箱">
      <header className="page-head">
        <div className="page-head__text">
          <h1>收件箱</h1>
          <p>
            每个 Agent 每个群的未读计数：@ 提及、回复、群主消息与撤回。打开群聊会把你看的这一份标为已读。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void load(agent)}
          disabled={loading}
        >
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </header>

      <div className="inbox-page__tabs" role="tablist" aria-label="选择 Agent">
        {AGENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={agent === item.id}
            className={`inbox-page__tab${agent === item.id ? ' is-active' : ''}`}
            onClick={() => setAgent(item.id)}
          >
            {item.label}
            {agent === item.id && totalUnread > 0 && (
              <span className="inbox-page__tab-count">{totalUnread > 99 ? '99+' : totalUnread}</span>
            )}
          </button>
        ))}
      </div>

      {error != null && (
        <p className="inbox-page__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          Inbox 读取失败：{error}
        </p>
      )}

      {inbox != null && (
        <p className="inbox-page__identity" role="status">
          身份自检：{inbox.you.display_name}
          <span className="inbox-page__identity-id">
            {inbox.you.agent_id}
            {inbox.you.platform != null ? ` · ${inbox.you.platform}` : ''}
          </span>
          {inbox.you.status.length > 0 && (
            <span className="inbox-page__identity-state">{inbox.you.status}</span>
          )}
        </p>
      )}

      {/* Phase 5 §4.7: join-request notices (owner/admin view, cross-chat). */}
      {(joinGroups.length > 0 || joinNotices.error != null) && (
        <section className="inbox-join-panel" aria-labelledby="inbox-join-title">
          <div className="inbox-join-panel__head">
            <h2 className="inbox-join-panel__title" id="inbox-join-title">
              <BellRing size={14} aria-hidden="true" />
              加入申请通知
              <span className="inbox-join-panel__count">{joinNotices.unread.length}</span>
            </h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={joinNotices.loading || joinNotices.unread.length === 0}
              onClick={() => void joinNotices.markAllRead()}
            >
              <Check size={12} aria-hidden="true" />
              全部标为已读
            </button>
          </div>
          {joinNotices.error != null && (
            <p className="community-error" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              {joinNotices.error}
            </p>
          )}
          {joinGroups.length > 0 && (
            <ul className="community-list">
              {joinGroups.map((group) => (
                <li key={group.chatId} className="community-row">
                  <span className="community-row__main">
                    <span className="community-row__title">
                      {chatNames.get(group.chatId) ?? group.chatId}
                    </span>
                    <span className="community-row__meta">
                      {group.count} 条未读加入申请通知
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm community-row__action"
                    onClick={() =>
                      navigate(`/chats/${encodeURIComponent(group.chatId)}/settings`)
                    }
                  >
                    查看申请
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm community-row__action"
                    disabled={joinNotices.loading}
                    onClick={() => void joinNotices.markChatRead(group.chatId)}
                  >
                    标为已读
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Phase 3 wake status. Three facts per chat (switch, last event, today's
          runs + failures) come straight from `wake_status`; the last check-in is
          agent-level and comes from `listener_status.checkin`. */}
      <section className="wake-panel" aria-labelledby="wake-panel-title">
        <header className="wake-panel__head">
          <h2 className="wake-panel__title" id="wake-panel-title">
            <Activity size={14} aria-hidden="true" />
            唤醒状态
          </h2>
          <span className={`wake-panel__listener${listener?.online === true ? ' is-online' : ''}`}>
            {listenerText}
          </span>
          <span className="wake-panel__checkin">
            <AlarmClock size={12} aria-hidden="true" />
            {checkinText}
          </span>
        </header>

        {/*
          Phase 4 §7.2: the inbox refreshes on pushed wake events, but polling
          stays the floor. Say which one is active instead of leaving the user
          to guess why the counters lag.
        */}
        {events.degraded && (
          <p className="wake-panel__status wake-panel__status--warn" role="status">
            实时推送不可用，已降级为轮询{events.error != null ? `（${events.error}）` : ''}
          </p>
        )}

        {wakeLoadError != null && (
          <p className="wake-panel__error" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            读取唤醒状态失败：{wakeLoadError}
          </p>
        )}

        {wakeToggleError != null && (
          <p className="wake-panel__error" role="alert">
            <CircleAlert size={14} aria-hidden="true" />
            切换唤醒开关失败：{wakeToggleFailureText(wakeToggleError)}
          </p>
        )}

        {wake == null ? (
          wakeLoadError == null ? (
            <p className="wake-panel__status" role="status">
              正在读取唤醒状态…
            </p>
          ) : null
        ) : wake.chats.length === 0 ? (
          <p className="wake-panel__status">这个 Agent 还没有可唤醒的群聊。</p>
        ) : (
          <ul className="wake-list" aria-label={`${agent} 的群聊唤醒开关`}>
            {wake.chats.map((row) => (
              <li key={row.chat_id} className={`wake-row${row.enabled ? '' : ' is-disabled'}`}>
                <span className="wake-row__name" title={row.chat_id}>
                  {row.name ?? row.chat_id}
                </span>
                <span className="wake-row__event">最后事件：{lastEventText(row.last_event)}</span>
                <span className="wake-row__kinds">
                  可唤醒：{row.wake_kinds.length > 0 ? formatWakeKinds(row.wake_kinds) : '—'}
                </span>
                <span className="wake-row__runs">
                  今日唤醒 <strong>{row.today_runs}</strong> 次
                </span>
                <span
                  className={`wake-row__failures${row.consecutive_failures > 0 ? ' is-bad' : ''}`}
                >
                  连续失败 <strong>{row.consecutive_failures}</strong>
                </span>
                {row.disabled_at != null && (
                  <span className="wake-row__disabled-at">
                    {formatRelative(row.disabled_at)}禁用
                  </span>
                )}
                <span className="wake-row__control">
                  {canManage ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.enabled}
                      aria-label={`${row.name ?? row.chat_id} 的自动唤醒`}
                      title={
                        row.enabled
                          ? '关闭自动唤醒（仅群主可切换）'
                          : '开启自动唤醒（仅群主可切换）'
                      }
                      className={`switch wake-toggle${row.enabled ? ' is-on' : ' is-off'}`}
                      disabled={wakeBusy != null}
                      onClick={() => void toggleWake(row)}
                    />
                  ) : null}
                  <span className={`wake-row__state${row.enabled ? '' : ' is-off'}`}>
                    {row.enabled ? '已开启' : '已禁用'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {inbox != null && !canManage && (
          <p className="wake-panel__note">仅群主可以切换唤醒开关；当前只能查看状态。</p>
        )}
      </section>

      {loading && inbox == null ? (
        <p className="inbox-page__status" role="status">
          正在读取 Inbox…
        </p>
      ) : entries.length === 0 ? (
        <div className="inbox-page__empty">
          <Inbox size={28} strokeWidth={1.6} aria-hidden="true" />
          <p>这个 Agent 还没有加入任何群聊，所以没有未读。</p>
        </div>
      ) : (
        <ul className="inbox-list" aria-label={`${agent} 的未读群聊`}>
          {entries.map((entry) => {
            const busy = acting === entry.chat_id;
            return (
              <li key={entry.chat_id} className="inbox-row">
                <button
                  type="button"
                  className="inbox-row__open"
                  disabled={busy}
                  onClick={() => void openChat(entry)}
                >
                  <span className="inbox-row__head">
                    <span className="inbox-row__name">{entry.name}</span>
                    {entry.unread > 0 ? (
                      <span className="inbox-row__unread" aria-label={`${entry.unread} 条未读`}>
                        {entry.unread > 99 ? '99+' : entry.unread}
                      </span>
                    ) : (
                      <span className="inbox-row__read">已读</span>
                    )}
                    <span className="inbox-row__time">
                      {entry.last_message_at != null ? formatRelative(entry.last_message_at) : ''}
                    </span>
                  </span>
                  <span className="inbox-row__counts">
                    {CHIPS.map((chip) => {
                      const value = entry[chip.key];
                      const Icon = chip.icon;
                      return (
                        <span
                          key={chip.key}
                          className={`inbox-chip inbox-chip--${chip.key}${value > 0 ? ' is-hot' : ''}`}
                        >
                          <Icon size={11} aria-hidden="true" />
                          {chip.label}
                          <span className="inbox-chip__value">{value}</span>
                        </span>
                      );
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className="inbox-row__clear"
                  disabled={busy}
                  title={`把 ${agent} 在这个群的游标推进到最新（仅群主可做）`}
                  onClick={() => void clearAgentCursor(entry)}
                >
                  {busy ? '处理中…' : '标为已读'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}