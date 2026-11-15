import { UserRound } from 'lucide-react';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import {
  AGENT_STATE_LABELS,
  normalizeAgentState,
  type AgentState,
  type ChatAgentState,
  type ChatAgentStatuses,
  type ChatStatus,
} from '../lib/chat';

type PresenceTone = 'neutral' | 'accent' | 'warning' | 'success' | 'error';

const TONE_BY_STATE: Record<AgentState, PresenceTone> = {
  idle: 'neutral',
  queued: 'neutral',
  starting: 'neutral',
  working: 'accent',
  waiting: 'warning',
  blocked: 'error',
  stale: 'error',
  completed: 'success',
  failed: 'error',
  cancelled: 'neutral',
  unknown: 'neutral',
};

function stateFromFallback(raw: string | undefined): ChatAgentState {
  const state = normalizeAgentState(raw);
  return { state, label: AGENT_STATE_LABELS[state], task_id: null, updated_at: null };
}

const MARKS = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

function PresenceItem({
  name,
  mark,
  state,
  label,
  taskId,
  isLoading,
}: {
  name: string;
  mark: string | null;
  state: AgentState | 'user';
  label: string;
  taskId?: string | null;
  isLoading?: boolean;
}) {
  const tone: PresenceTone =
    state === 'user' ? 'neutral' : TONE_BY_STATE[state];
  return (
    <li
      className={`chat-presence__item chat-presence__item--${state}`}
      title={taskId != null ? `${name} · 当前任务 #${taskId}` : `${name} · ${label}`}
    >
      <span className={`chat-avatar chat-avatar--sm chat-avatar--${mark != null ? 'agent' : 'user'}`} aria-hidden="true">
        {mark != null ? <img src={mark} alt="" draggable={false} /> : <UserRound size={13} strokeWidth={2} />}
      </span>
      <span className="chat-presence__text">
        <span className="chat-presence__name">{name}</span>
        <span className={`chat-presence__state chat-presence__state--${tone}`}>
          <span className="chat-presence__dot" aria-hidden="true" />
          {isLoading ? '读取中' : label}
        </span>
      </span>
    </li>
  );
}

/**
 * Participants and their real states. Agent status comes from `chat_status`
 * (falling back to the chat list's agent fields); the user row only states that
 * this page is open — no typing indicator, no invented presence.
 */
export function AgentPresence({
  status,
  fallback,
  needsMuse = false,
  loading = false,
}: {
  status: ChatStatus | null;
  fallback?: ChatAgentStatuses;
  needsMuse?: boolean;
  loading?: boolean;
}) {
  const museWaiting = status?.needs_muse ?? needsMuse;
  const muse = status?.muse ?? {
    state: museWaiting ? ('waiting' as AgentState) : ('idle' as AgentState),
    label: museWaiting ? '等 Muse 回复' : AGENT_STATE_LABELS.idle,
    task_id: null,
    updated_at: null,
  };
  const claude = status?.claude ?? stateFromFallback(fallback?.claude);
  const dsh = status?.dsh ?? stateFromFallback(fallback?.dsh);

  return (
    <ul className="chat-presence" aria-label="群聊参与者状态">
      <PresenceItem
        name="Muse"
        mark={MARKS.muse}
        state={muse.state}
        label={muse.label}
        taskId={muse.task_id}
        isLoading={loading && status == null}
      />
      <PresenceItem
        name="Claude"
        mark={MARKS.claude}
        state={claude.state}
        label={claude.label}
        taskId={claude.task_id}
        isLoading={loading && status == null}
      />
      <PresenceItem
        name="dsh"
        mark={MARKS.dsh}
        state={dsh.state}
        label={dsh.label}
        taskId={dsh.task_id}
        isLoading={loading && status == null}
      />
      <PresenceItem
        name="你"
        mark={null}
        state="user"
        label="当前查看"
      />
    </ul>
  );
}