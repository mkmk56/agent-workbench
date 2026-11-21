import { UserRound } from '../ui/icons';
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
import type { ChatMember } from '../types';

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

/** States that count as offline for the green dot. */
const OFFLINE_STATES = new Set<AgentState>(['failed', 'stale', 'unknown']);

function stateFromFallback(raw: string | undefined): ChatAgentState {
  const state = normalizeAgentState(raw);
  return { state, label: AGENT_STATE_LABELS[state], task_id: null, updated_at: null };
}

const MARKS = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

/** Avatar image for a built-in handle; paired agents have no local glyph. */
function markFor(handle: string | null): string | null {
  if (handle === 'muse' || handle === 'claude' || handle === 'dsh') {
    return MARKS[handle];
  }
  return null;
}

export type PresenceMember = {
  /** `user`, a built-in handle, or a paired agent id (agent_xxx). */
  id: string;
  name: string;
  mark: string | null;
  state: AgentState | 'user';
  label: string;
  taskId: string | null;
  online: boolean;
};

/**
 * Turn one canonical membership row into a presence entry.
 *
 * A built-in agent borrows its live state from `chat_status`; a paired agent
 * has no local executor, so its presence is derived from the membership row
 * itself (`active` = 可用, anything else = 不可用). No invented heartbeat.
 */
function memberToPresence(
  member: ChatMember,
  status: ChatStatus | null,
): PresenceMember {
  const handle = (member.participant_id ?? member.agent_id).replace(/^agent_/, '');
  const isUser = member.role === 'owner' || member.agent_id === 'agent_user';
  const builtin = handle === 'muse' || handle === 'claude' || handle === 'dsh' ? handle : null;
  const live = builtin != null ? (status?.[builtin] ?? null) : null;
  const active = member.status === 'active';
  const state: AgentState | 'user' = isUser
    ? 'user'
    : (live?.state ?? (active ? 'idle' : 'stale'));
  return {
    id: isUser ? 'user' : (builtin ?? member.agent_id),
    name: isUser ? '你' : member.display_name,
    mark: isUser ? null : markFor(builtin),
    state,
    label: isUser
      ? '当前查看'
      : (live?.label ?? (active ? '已配对' : member.status)),
    taskId: live?.task_id ?? null,
    online: isUser ? true : active && !OFFLINE_STATES.has(state as AgentState),
  };
}

export function resolveMembers(
  status: ChatStatus | null,
  fallback: ChatAgentStatuses | undefined,
  needsMuse: boolean,
  /** Canonical `chat_members` rows; null/empty falls back to the built-ins. */
  members?: ChatMember[] | null,
): PresenceMember[] {
  if (members != null && members.length > 0) {
    const ordered = [...members].sort((left, right) => {
      const leftUser = left.role === 'owner' ? 0 : 1;
      const rightUser = right.role === 'owner' ? 0 : 1;
      if (leftUser !== rightUser) {
        return leftUser - rightUser;
      }
      return left.display_name.localeCompare(right.display_name, 'zh-Hans-CN');
    });
    return ordered.map((member) => memberToPresence(member, status));
  }
  const museWaiting = status?.needs_muse ?? needsMuse;
  const muse = status?.muse ?? {
    state: museWaiting ? ('waiting' as AgentState) : ('idle' as AgentState),
    label: museWaiting ? '等 Muse 回复' : AGENT_STATE_LABELS.idle,
    task_id: null,
    updated_at: null,
  };
  const claude = status?.claude ?? stateFromFallback(fallback?.claude);
  const dsh = status?.dsh ?? stateFromFallback(fallback?.dsh);
  const online = (state: AgentState) => !OFFLINE_STATES.has(state);
  return [
    {
      id: 'user',
      name: '你',
      mark: null,
      state: 'user',
      label: '当前查看',
      taskId: null,
      online: true,
    },
    {
      id: 'muse',
      name: 'Muse',
      mark: MARKS.muse,
      state: muse.state,
      label: muse.label,
      taskId: muse.task_id,
      online: online(muse.state),
    },
    {
      id: 'claude',
      name: 'Claude',
      mark: MARKS.claude,
      state: claude.state,
      label: claude.label,
      taskId: claude.task_id,
      online: online(claude.state),
    },
    {
      id: 'dsh',
      name: 'dsh',
      mark: MARKS.dsh,
      state: dsh.state,
      label: dsh.label,
      taskId: dsh.task_id,
      online: online(dsh.state),
    },
  ];
}

/**
 * Compact member row for the chat header: avatar + name + online dot.
 * The full state text lives in the title tooltip and in the detail list
 * (AgentPresenceList), so the header stays as compact as the target design
 * while every dot still reflects a real derived state.
 */
export function AgentPresence({
  status,
  fallback,
  needsMuse = false,
  loading = false,
  members = null,
}: {
  status: ChatStatus | null;
  fallback?: ChatAgentStatuses;
  needsMuse?: boolean;
  loading?: boolean;
  members?: ChatMember[] | null;
}) {
  const resolved = resolveMembers(status, fallback, needsMuse, members);
  return (
    <ul className="chat-presence chat-presence--row" aria-label="群聊参与者状态">
      {resolved.map((member) => (
        <li
          key={member.id}
          className={`chat-presence__item chat-presence__item--${member.id}`}
          title={
            member.taskId != null
              ? `${member.name} · 当前任务 #${member.taskId}`
              : `${member.name} · ${loading && status == null ? '读取中' : member.label}`
          }
        >
          <span
            className={`chat-avatar chat-avatar--sm chat-avatar--${member.mark != null ? member.id : 'user'}`}
            aria-hidden="true"
          >
            {member.mark != null ? (
              <img src={member.mark} alt="" draggable={false} />
            ) : (
              <UserRound size={14} strokeWidth={2} />
            )}
          </span>
          <span className="chat-presence__name">{member.name}</span>
          <span
            className={`chat-presence__online-dot${member.online ? '' : ' chat-presence__online-dot--off'}`}
            aria-hidden="true"
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Detailed member list (name + real state text), used inside the "4 人"
 * popover in the chat header.
 */
export function AgentPresenceList({
  status,
  fallback,
  needsMuse = false,
  loading = false,
  members = null,
}: {
  status: ChatStatus | null;
  fallback?: ChatAgentStatuses;
  needsMuse?: boolean;
  loading?: boolean;
  members?: ChatMember[] | null;
}) {
  const resolved = resolveMembers(status, fallback, needsMuse, members);
  return (
    <ul className="chat-presence" aria-label="群聊参与者详细状态">
      {resolved.map((member) => {
        const tone: PresenceTone = member.state === 'user' ? 'neutral' : TONE_BY_STATE[member.state];
        return (
          <li
            key={member.id}
            className={`chat-presence__item chat-presence__item--${member.state}`}
            title={member.taskId != null ? `${member.name} · 当前任务 #${member.taskId}` : `${member.name} · ${member.label}`}
          >
            <span
              className={`chat-avatar chat-avatar--sm chat-avatar--${member.mark != null ? member.id : 'user'}`}
              aria-hidden="true"
            >
              {member.mark != null ? (
                <img src={member.mark} alt="" draggable={false} />
              ) : (
                <UserRound size={13} strokeWidth={2} />
              )}
            </span>
            <span className="chat-presence__text">
              <span className="chat-presence__name">{member.name}</span>
              <span className={`chat-presence__state chat-presence__state--${tone}`}>
                <span className="chat-presence__dot" aria-hidden="true" />
                {loading && status == null ? '读取中' : member.label}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
