import { AtSign, CircleAlert, CornerUpLeft, Inbox, RefreshCw, RotateCcw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chatInboxOnce,
  markChatRead,
  type ChatInboxEntry,
  type ChatInboxPayload,
} from '../lib/chat';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import '../styles/chat.css';

/**
 * Inbox (REA Phase 2, docs/rea/TARGET_ARCHITECTURE.md D3).
 *
 * One agent's per-chat unread counters straight from the engine `inbox` tool:
 * mentions_you / replies_to_you / from_owner / recalled. The response's `you`
 * block is shown as an identity self-check, so the UI never claims to show a
 * different agent than the one the engine answered for.
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

export function InboxPage() {
  const [agent, setAgent] = useState<AgentHandle>('muse');
  const [inbox, setInbox] = useState<ChatInboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
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
        const result = await chatInboxOnce(handle);
        if (id !== requestId.current || handle !== activeAgent.current) {
          return; // Stale: a newer request or another tab owns the view.
        }
        if (result.ok) {
          setInbox(result.data);
          setError(null);
        } else {
          setError(result.error);
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
    // Switching tabs must not keep showing the previous agent's counters under
    // the new agent's name.
    setInbox(null);
    setLoading(true);
    void load(agent);
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void load(agent);
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [agent, load]);

  const entries = useMemo(() => sortEntries(inbox?.chats ?? []), [inbox]);
  const totalUnread = inbox?.total_unread ?? 0;

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