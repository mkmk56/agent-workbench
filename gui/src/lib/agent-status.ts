/**
 * Agent status view models for the new surfaces (task §1 rail status card,
 * task §4 sidebar status strip).
 *
 * Pure helpers only (no React, no DOM globals) so the rules can be exercised
 * with `node --test`. Everything here is derived from data the engine really
 * returns:
 *
 *  - `chat_status.agents.<id>` (state / task_id / updated_at) — the only
 *    per-agent live state the engine has;
 *  - the chat message stream (the agent's newest message);
 *  - `agent_info` (executor availability + model), used when no chat is open.
 *
 * There is **no quota / usage / token-budget source** in the engine, so nothing
 * in this module produces a percentage, a bar or a token counter. A card that
 * has no data shows fewer rows instead of an invented number.
 */
import type { ChatMessage } from '../types';
import type { AgentState } from './chat';

export type AgentId = 'muse' | 'claude' | 'dsh';

/** Two visual styles are enough for the footer: done vs blocked, plus neutral. */
export type ActivityKind = 'done' | 'blocked' | 'neutral';

export type AgentActivity = {
  kind: ActivityKind;
  /** Icon name the component maps to a lucide icon (icon + text, never colour only). */
  icon: 'check' | 'alert' | 'clock';
  label: string;
};

/**
 * "最近动态" — derived from the real agent state. Completion and blockage get
 * their own icon + wording so the two are distinguishable without colour.
 *
 * `agentId` only changes the wording of `waiting`: for an executor, `waiting`
 * means the agent is waiting for the user, while for Muse the same state means
 * the chat is waiting for Muse's own reply (`needs_muse`).
 */
export function agentActivity(state: AgentState, agentId?: AgentId): AgentActivity {
  switch (state) {
    case 'completed':
      return { kind: 'done', icon: 'check', label: '最近：任务已完成' };
    case 'failed':
      return { kind: 'blocked', icon: 'alert', label: '最近：执行失败' };
    case 'blocked':
      return { kind: 'blocked', icon: 'alert', label: '最近：遇到阻塞' };
    case 'stale':
      return { kind: 'blocked', icon: 'alert', label: '最近：执行器静默' };
    case 'cancelled':
      return { kind: 'neutral', icon: 'clock', label: '最近：任务已取消' };
    case 'waiting':
      return {
        kind: 'neutral',
        icon: 'clock',
        label: agentId === 'muse' ? '最近：等待 Muse 回复' : '最近：等待你回复',
      };
    case 'working':
      return { kind: 'neutral', icon: 'clock', label: '最近：正在执行' };
    case 'starting':
      return { kind: 'neutral', icon: 'clock', label: '最近：正在启动' };
    case 'queued':
      return { kind: 'neutral', icon: 'clock', label: '最近：排队等待调度' };
    case 'idle':
      return { kind: 'neutral', icon: 'clock', label: '最近：待命' };
    case 'unknown':
      return { kind: 'neutral', icon: 'clock', label: '最近：状态未知' };
  }
}

export type LatestMessage = {
  text: string;
  createdAt: string;
  /** "3 分钟前" — real timestamp, relative label only. */
  relative: string;
} | null;

/** Collapse whitespace and shorten for the card preview (display only). */
export function summarizeForCard(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * The agent's newest non-empty message in the loaded window. `now` is passed in
 * so the relative label is deterministic in tests.
 */
export function latestAgentMessage(
  messages: readonly ChatMessage[],
  agentId: string,
  now: number = Date.now(),
  options: { max?: number } = {},
): LatestMessage {
  let best: ChatMessage | null = null;
  for (const message of messages) {
    if (message.from !== agentId || message.summary.trim().length === 0) {
      continue;
    }
    if (best == null) {
      best = message;
      continue;
    }
    const bestAt = Date.parse(best.created_at);
    const at = Date.parse(message.created_at);
    if (Number.isFinite(at) && (!Number.isFinite(bestAt) || at >= bestAt)) {
      best = message;
    }
  }
  if (best == null) {
    return null;
  }
  return {
    text: summarizeForCard(best.summary, options.max ?? 160),
    createdAt: best.created_at,
    relative: relativeLabel(best.created_at, now),
  };
}

/**
 * Relative label against an explicit `now`. The wording matches
 * `lib/labels.ts:formatRelative`; it is repeated here (rather than imported) so
 * this module stays dependency-free for `node --test` — same approach as
 * lib/chat-sidebar-layout.ts.
 */
function relativeLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) {
    return '刚刚';
  }
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3_600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)} 小时前`;
  }
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

/**
 * Colour tone for a state dot. Purely a second channel: every surface that uses
 * it also prints the state text, so a reader who cannot see colour still gets
 * the state (VISUAL_SCHEME.md §3, §6).
 */
export function agentStateTone(state: AgentState): StatusTone {
  switch (state) {
    case 'working':
    case 'starting':
      return 'accent';
    case 'waiting':
      return 'warning';
    case 'blocked':
    case 'stale':
    case 'failed':
      return 'error';
    case 'completed':
      return 'success';
    case 'idle':
    case 'queued':
    case 'cancelled':
    case 'unknown':
      return 'neutral';
  }
}

export type ExecutorAgent = {
  name: string;
  available: boolean;
  version?: string | null;
  gateway?: { base_url: string; model: string | null } | null;
};

export type ExecutorAvailability = {
  /** null = the engine has no record for this id (Muse has no local executor). */
  available: boolean | null;
  detail: string;
};

/**
 * `agent_info` fallback for when no chat is open: the only per-agent fact the
 * engine still reports is whether the executor itself can be used.
 */
export function executorAvailability(
  agents: readonly ExecutorAgent[],
  agentId: AgentId,
): ExecutorAvailability {
  if (agentId === 'muse') {
    return {
      available: null,
      detail: '云端编排器 · 引擎不提供 Muse 的本地执行器状态',
    };
  }
  const meta = agents.find((agent) => agent.name === agentId) ?? null;
  if (meta == null) {
    return { available: null, detail: '引擎未返回该执行器的信息' };
  }
  const model = meta.gateway?.model ?? meta.version ?? null;
  if (!meta.available) {
    return { available: false, detail: model != null ? `执行器不可用 · ${model}` : '执行器不可用' };
  }
  return {
    available: true,
    detail: model != null ? `执行器可用 · ${model}` : '执行器可用',
  };
}

/**
 * Dot on the rail avatar: real availability when we have it, neutral when the
 * engine simply has nothing to say (Muse / not loaded yet).
 */
export function availabilityTone(
  availability: ExecutorAvailability,
): 'neutral' | 'success' | 'error' {
  if (availability.available === true) {
    return 'success';
  }
  if (availability.available === false) {
    return 'error';
  }
  return 'neutral';
}