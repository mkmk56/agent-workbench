import {
  ArrowLeft,
  CircleAlert,
  Power,
  RefreshCw,
  Save,
} from '../ui/icons';
import { useCallback, useEffect, useState } from 'react';
import {
  listChatsOnce,
  normalizeChatSettings,
  renameChat,
  updateChatSettings,
  type ChatSettings,
  type ChatSummary,
} from '../lib/chat';
import { useEngineEventSignal } from '../lib/engine';
import { formatRelative } from '../lib/labels';
import { navigate } from '../lib/router';
import {
  formatWakeKinds,
  listenerStatusOnce,
  setWakeEnabled,
  wakeEventStatusLabel,
  wakeKindLabel,
  wakeStatusOnce,
  wakeToggleFailureText,
} from '../lib/wake';
import type { ChatMember, ListenerStatusPayload, WakeChatStatus } from '../types';
import { chatMembersOnce } from '../lib/chat';
import '../styles/chat.css';
import '../styles/chat-phase4.css';

const AGENTS = ['claude', 'dsh', 'muse'] as const;
type AgentHandle = (typeof AGENTS)[number];

const AGENT_LABELS: Record<AgentHandle, string> = {
  claude: 'Claude',
  dsh: 'dsh',
  muse: 'Muse',
};

interface AgentWakeRow {
  agent: AgentHandle;
  status: WakeChatStatus | null;
  checkin: ListenerStatusPayload['checkin'];
  error: string | null;
}

/**
 * REA Phase 4 [D]: the per-chat settings page.
 *
 * Everything here is a real engine write or a read-only display of engine data:
 *  - name  → `rename_chat`
 *  - description / announcement → `chat_update_settings` (chats.settings JSON)
 *  - wake switch per agent → `wake_enable` / `wake_disable` (owner-only)
 *  - check-in interval → read-only (`listener_status`), because it is an agent
 *    level setting and D7 decided not to expose it for editing here
 *  - throttle / failure counters → read-only (`wake_status`), never adjustable
 *
 * The Inbox keeps its cross-chat overview; this page is the per-chat home.
 */
export function ChatSettingsPage({ id }: { id: string }) {
  const [chat, setChat] = useState<ChatSummary | null>(null);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ChatSettings>({ description: '', announcement: '' });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<AgentWakeRow[]>([]);
  const [wakeBusy, setWakeBusy] = useState<string | null>(null);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const signal = useEngineEventSignal();

  const loadChat = useCallback(async () => {
    const result = await listChatsOnce();
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    const found = result.data.find((item) => item.chat_id === id) ?? null;
    setLoadError(found == null ? '找不到这个群聊（可能已归档）。' : null);
    setChat(found);
    if (found != null) {
      setName(found.name);
      setDraft(normalizeChatSettings(found.settings));
    }
  }, [id]);

  const loadWake = useCallback(async () => {
    const results = await Promise.all(
      AGENTS.map(async (agent) => {
        const [wake, listener] = await Promise.all([
          wakeStatusOnce(agent, id),
          listenerStatusOnce(agent),
        ]);
        const row = wake.ok ? (wake.data.chats.find((item) => item.chat_id === id) ?? null) : null;
        return {
          agent,
          status: row,
          checkin: listener.ok ? listener.data.checkin : null,
          error: wake.ok ? null : wake.error,
        } satisfies AgentWakeRow;
      }),
    );
    setRows(results);
  }, [id]);

  const loadMembers = useCallback(async () => {
    const result = await chatMembersOnce(id);
    if (result.ok) {
      setMembers(result.data);
    }
  }, [id]);

  useEffect(() => {
    void loadChat();
    void loadWake();
    void loadMembers();
  }, [loadChat, loadWake, loadMembers]);

  useEffect(() => {
    if (signal > 0) {
      void loadWake();
    }
  }, [signal, loadWake]);

  const saveName = async () => {
    const next = name.trim();
    if (next.length === 0 || chat == null || next === chat.name) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const result = await renameChat(id, next);
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setChat(result.data);
      setSaved('群名已保存。');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    setBusy(true);
    setSaveError(null);
    setSaved(null);
    try {
      const result = await updateChatSettings({
        chatId: id,
        description: draft.description,
        announcement: draft.announcement,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setDraft(result.data);
      setSaved('群描述与公告已保存。');
    } finally {
      setBusy(false);
    }
  };

  const toggleWake = async (row: AgentWakeRow) => {
    const enabled = row.status?.enabled !== true;
    setWakeBusy(row.agent);
    setWakeError(null);
    try {
      const result = await setWakeEnabled({ agentId: row.agent, chatId: id, enabled });
      if (!result.ok) {
        setWakeError(`${AGENT_LABELS[row.agent]}：${wakeToggleFailureText(result.error)}`);
        return;
      }
      await loadWake();
    } finally {
      setWakeBusy(null);
    }
  };

  return (
    <section className="chat-settings-page" aria-label="群聊设置">
      <header className="page-head">
        <div className="page-head__text">
          <h1>群聊设置</h1>
          <p>{chat != null ? chat.name : id}</p>
        </div>
        <div className="chat-settings-page__actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/chats/${encodeURIComponent(id)}`)}
          >
            <ArrowLeft size={14} aria-hidden="true" />
            返回群聊
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              void loadChat();
              void loadWake();
              void loadMembers();
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            刷新
          </button>
        </div>
      </header>

      {loadError != null && (
        <p className="chat-settings-page__error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {loadError}
        </p>
      )}

      <div className="chat-settings-page__grid">
        <section className="chat-settings-card" aria-label="群资料">
          <h2 className="chat-settings-card__title">群资料</h2>
          <label className="chat-settings-field">
            <span>群名</span>
            <input
              type="text"
              value={name}
              maxLength={80}
              disabled={busy || chat == null}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || chat == null || name.trim() === (chat?.name ?? '')}
            onClick={() => void saveName()}
          >
            保存群名
          </button>

          <label className="chat-settings-field">
            <span>群描述</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.description}
              placeholder="这个群是做什么的（成员可见）"
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </label>
          <label className="chat-settings-field">
            <span>群公告</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.announcement}
              placeholder="置顶公告（例如今天的目标、禁止事项）"
              onChange={(event) =>
                setDraft((current) => ({ ...current, announcement: event.target.value }))
              }
            />
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void saveSettings()}
          >
            <Save size={14} aria-hidden="true" />
            {busy ? '保存中…' : '保存描述与公告'}
          </button>
          <p className="chat-settings-card__hint">
            存在 chats.settings（JSON）里；引擎未提供写入工具时会直接报错，不会只改本地。
          </p>
          {saveError != null && (
            <p className="chat-settings-page__error" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              {saveError}
            </p>
          )}
          {saved != null && (
            <p className="chat-settings-card__ok" role="status">
              {saved}
            </p>
          )}
        </section>

        <section className="chat-settings-card" aria-label="唤醒设置">
          <h2 className="chat-settings-card__title">唤醒设置（按 Agent）</h2>
          <p className="chat-settings-card__hint">
            开关复用引擎 wake_enable / wake_disable，仅群主可改。收件箱仍保留跨群总览。
          </p>
          {wakeError != null && (
            <p className="chat-settings-page__error" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              {wakeError}
            </p>
          )}
          <ul className="chat-settings-wake">
            {rows.map((row) => (
              <li key={row.agent} className="chat-settings-wake__row">
                <span className="chat-settings-wake__name">{AGENT_LABELS[row.agent]}</span>
                <button
                  type="button"
                  className={`chat-settings-wake__switch${row.status?.enabled === true ? ' is-on' : ''}`}
                  aria-pressed={row.status?.enabled === true}
                  disabled={wakeBusy === row.agent || row.status == null}
                  onClick={() => void toggleWake(row)}
                >
                  <Power
                    size={12}
                    weight={row.status?.enabled === true ? 'Filled' : 'Outline'}
                    aria-hidden="true"
                  />
                  {row.status == null
                    ? '不可用'
                    : row.status.enabled
                      ? '已开启'
                      : '已关闭'}
                </button>
                <dl className="chat-settings-wake__meta">
                  <div>
                    <dt>唤醒类型</dt>
                    <dd>{formatWakeKinds(row.status?.wake_kinds ?? []) || '—'}</dd>
                  </div>
                  <div>
                    <dt>今日唤醒</dt>
                    <dd>{row.status?.today_runs ?? 0} 次</dd>
                  </div>
                  <div>
                    <dt>连续失败</dt>
                    <dd>{row.status?.consecutive_failures ?? 0}</dd>
                  </div>
                  <div>
                    <dt>最近事件</dt>
                    <dd>
                      {row.status?.last_event != null
                        ? `${wakeKindLabel(row.status.last_event.kind)} · ` +
                          wakeEventStatusLabel(row.status.last_event.status)
                        : '无'}
                    </dd>
                  </div>
                  <div>
                    <dt>check-in 间隔</dt>
                    <dd>
                      {row.checkin != null
                        ? `${row.checkin.every_minutes} 分钟（只读）`
                        : '未记录'}
                    </dd>
                  </div>
                  <div>
                    <dt>最近 check-in</dt>
                    <dd>
                      {row.checkin?.last_checkin_at != null
                        ? formatRelative(row.checkin.last_checkin_at)
                        : '无'}
                    </dd>
                  </div>
                </dl>
                {row.error != null && (
                  <span className="chat-settings-wake__error">{row.error}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="chat-settings-card__hint">
            check-in 间隔是 Agent 级设置，这里只读；节流（今日次数 / 连续失败）仅展示，不提供调小入口。
          </p>
        </section>

        <section className="chat-settings-card" aria-label="成员概览">
          <h2 className="chat-settings-card__title">成员（{members.length}）</h2>
          <ul className="chat-settings-members">
            {members.map((member) => (
              <li key={member.agent_id}>
                <span className="chat-settings-members__name">{member.display_name}</span>
                <span className="chat-settings-members__meta">
                  {member.role === 'owner' ? '群主' : (member.platform ?? member.agent_id)} ·{' '}
                  {member.status}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(`/chats/${encodeURIComponent(id)}`)}
          >
            在群聊里增删成员
          </button>
        </section>
      </div>
    </section>
  );
}