import { agentStateTone, type StatusTone } from '../lib/agent-status';
import { useChatStatusView } from '../lib/chat-store';
import { useEngineEventsStatus } from '../lib/engine';
import type { ChatSummary } from '../types';
import { AppStatus } from '../ui/astryx';
import { resolveMembers } from './AgentPresence';

/** AppStatus speaks Astryx tones; the running one is our "working" accent. */
const STATUS_TONE: Record<StatusTone, 'running' | 'success' | 'warning' | 'error' | 'neutral'> = {
  neutral: 'neutral',
  accent: 'running',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/**
 * Persistent mini status strip at the foot of the session list (task §4).
 *
 * One row per agent: avatar glyph + name + the live state text. The state comes
 * from `chat_status` through the shared ChatStore — the same real source the
 * chat header uses — and `AppStatus` prints the state as text next to its dot,
 * so the strip stays readable when colour is not available (VISUAL_SCHEME §3).
 *
 * There is no quota / usage source in the engine, so the strip shows no bar and
 * no percentage: state text only.
 *
 * Rows are keyboard focusable (task §4: 键盘可聚焦) and repeat the text in
 * aria-label for assistive tech.
 */
export function SidebarStatusStrip({
  chatId,
  chat,
}: {
  chatId: string | null;
  chat: ChatSummary | null;
}) {
  const { status, loading, error } = useChatStatusView(chatId);
  // Phase 4 §7.2: the pushed stream is an accelerator, polling is the floor. The
  // strip is where the user can see WHICH of the two is currently in effect.
  const events = useEngineEventsStatus();
  const members = resolveMembers(status, chat?.agents, chat?.needs_muse === true).filter(
    (member) => member.id !== 'user',
  );
  const hasChat = chatId != null;

  return (
    <section className="status-strip" aria-labelledby="status-strip-title">
      <h2 className="status-strip__title" id="status-strip-title">
        Agent 状态
      </h2>
      <ul className="status-strip__list">
        {members.map((member) => {
          const label = !hasChat ? '—' : loading && status == null ? '读取中…' : member.label;
          const tone = member.state === 'user' ? 'neutral' : agentStateTone(member.state);
          return (
            <li
              key={member.id}
              className="status-strip__row"
              tabIndex={0}
              aria-label={`${member.name}：${label}`}
              title={`${member.name} · ${label}`}
            >
              <span className="status-strip__avatar" aria-hidden="true">
                {member.mark != null ? (
                  <img src={member.mark} alt="" draggable={false} />
                ) : (
                  <span className="status-strip__glyph">{member.name.slice(0, 1)}</span>
                )}
              </span>
              <span className="status-strip__name">{member.name}</span>
              <AppStatus tone={STATUS_TONE[tone]} label={label} />
            </li>
          );
        })}
      </ul>
      {!hasChat && <p className="status-strip__note">选中一个群聊后显示实时状态。</p>}
      {hasChat && error != null && (
        <p className="status-strip__note status-strip__note--error">状态读取失败：{error}</p>
      )}
      {events.degraded && (
        <p className="status-strip__note status-strip__note--warn" role="status">
          实时推送不可用，已降级为轮询
          {events.error != null ? `（${events.error}）` : ''}
        </p>
      )}
      {!events.degraded && events.state === 'connecting' && (
        <p className="status-strip__note">实时推送连接中…（此前由轮询兜底）</p>
      )}
    </section>
  );
}