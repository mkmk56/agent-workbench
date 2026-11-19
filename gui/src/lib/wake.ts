import type {
  EngineResult,
  ListenerCheckin,
  ListenerSession,
  ListenerStatusPayload,
  WakeChatStatus,
  WakeLastEvent,
  WakeStatusPayload,
  WakeToggleResult,
} from '../types';

/**
 * REA Phase 3 wake / listener status (docs/rea/PHASE3_DESIGN.md §13).
 *
 * Contract (engine commit 2cccea4, src/tools.js `wake_status` / `listener_status`):
 *  - Both tools answer per agent; the GUI always passes `agent_id` because its
 *    token is the owner token, not the agent's own token.
 *  - `wake_status.chats[]` is the authoritative per-chat switch: `enabled`,
 *    `consecutive_failures`, `today_runs`, `last_event`. The engine stores epoch
 *    milliseconds for timestamps; this module normalizes them to ISO strings so
 *    the shared `formatRelative` formatter can be used unchanged.
 *  - `listener_status.checkin` is agent-level (one interval per agent), so the
 *    last check-in is shown once per agent, not per chat.
 *  - Nothing here invents state: a missing `agent_id` rejects the payload,
 *    rows without a `chat_id` are dropped, and an absent `last_event` stays null.
 *  - The wake switch itself is owner-only in the engine (`wake_enable` /
 *    `wake_disable` require a human/master token). `canManageWake` is only the
 *    UI gate that hides the control for agents this workstation does not own;
 *    the engine remains the authority.
 */

const NO_MAIN = '主进程未连接（浏览器预览）。';
const NO_WAKE_BRIDGE = '唤醒接口尚未接通（IPC 桥未就绪）。';

/** Owner identity of the local workstation (mirrors ProfileCard's OWNER_ID). */
export const WAKE_OWNER_ID = 'user';

export const WAKE_KIND_LABELS: Record<string, string> = {
  mention: '提及',
  reply: '回复',
  owner_post: '群主发言',
};

export const WAKE_EVENT_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  delivered: '已送达',
  throttled: '已节流',
  merged: '已合并',
  failed: '失败',
  disabled: '已禁用',
};

export function wakeKindLabel(kind: string): string {
  return WAKE_KIND_LABELS[kind] ?? kind;
}

export function wakeEventStatusLabel(status: string): string {
  return WAKE_EVENT_STATUS_LABELS[status] ?? status;
}

export function formatWakeKinds(kinds: string[]): string {
  return kinds.map(wakeKindLabel).join('、');
}

/**
 * UI gate for the wake switch. An agent owned by `user` belongs to this
 * workstation's owner, so the switch may be shown; for any other owner the
 * Inbox falls back to a read-only state. `wake_enable` / `wake_disable` still
 * re-check the token server-side.
 */
export function canManageWake(owner: string | null | undefined): boolean {
  return owner === WAKE_OWNER_ID;
}

interface WakeBridge {
  wakeStatus?: (input?: {
    agentId?: string;
    chatId?: string;
  }) => Promise<EngineResult<unknown>>;
  listenerStatus?: (input?: { agentId?: string }) => Promise<EngineResult<unknown>>;
  wakeEnable?: (input: { agentId: string; chatId: string }) => Promise<EngineResult<unknown>>;
  wakeDisable?: (input: { agentId: string; chatId: string }) => Promise<EngineResult<unknown>>;
}

function bridge(): WakeBridge | null {
  if (!window.workbench) {
    return null;
  }
  return window.workbench as unknown as WakeBridge;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/**
 * Engine timestamps are epoch milliseconds; formatRelative wants ISO. A zero /
 * missing value is "never", which must stay null rather than 1970.
 */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  return null;
}

function isWakeChat(row: WakeChatStatus | null): row is WakeChatStatus {
  return row != null;
}

function isListenerSession(row: ListenerSession | null): row is ListenerSession {
  return row != null;
}

export function normalizeWakeEvent(raw: unknown): WakeLastEvent | null {
  const record = asRecord(raw);
  const id = readString(record, 'id', 'event_id', 'eventId');
  if (id == null) {
    return null;
  }
  return {
    id,
    seq: readNumber(record, 'seq') ?? 0,
    kind: readString(record, 'kind') ?? 'unknown',
    status: readString(record, 'status') ?? 'unknown',
    created_at: toIsoTimestamp(record.created_at ?? record.createdAt),
  };
}

export function normalizeWakeChat(raw: unknown): WakeChatStatus | null {
  const record = asRecord(raw);
  const chatId = readString(record, 'chat_id', 'chatId');
  if (chatId == null) {
    return null;
  }
  return {
    chat_id: chatId,
    name: readString(record, 'name'),
    // Only an explicit `true` turns the switch on; a missing field must not
    // claim wake is enabled.
    enabled: readBoolean(record, 'enabled') === true,
    wake_kinds: readStringArray(record.wake_kinds ?? record.wakeKinds),
    consecutive_failures:
      readNumber(record, 'consecutive_failures', 'consecutiveFailures') ?? 0,
    disabled_at: toIsoTimestamp(record.disabled_at ?? record.disabledAt),
    today_runs: readNumber(record, 'today_runs', 'todayRuns') ?? 0,
    last_event: normalizeWakeEvent(record.last_event ?? record.lastEvent),
  };
}

export function normalizeWakeStatus(raw: unknown): WakeStatusPayload | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId');
  if (agentId == null) {
    return null;
  }
  const chats = (Array.isArray(record.chats) ? record.chats : [])
    .map(normalizeWakeChat)
    .filter(isWakeChat);
  const enabled = readBoolean(record, 'enabled');
  return {
    agent_id: agentId,
    participant_id: readString(record, 'participant_id', 'participantId'),
    enabled: enabled ?? chats.some((chat) => chat.enabled),
    chats,
  };
}

export function normalizeCheckin(raw: unknown): ListenerCheckin | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const record = asRecord(raw);
  return {
    every_minutes: readNumber(record, 'every_minutes', 'everyMinutes') ?? 10,
    last_checkin_at: toIsoTimestamp(record.last_checkin_at ?? record.lastCheckinAt),
    consecutive_empty: readNumber(record, 'consecutive_empty', 'consecutiveEmpty') ?? 0,
  };
}

export function normalizeListenerSession(raw: unknown): ListenerSession | null {
  const record = asRecord(raw);
  const id = readString(record, 'id', 'session_id', 'sessionId');
  if (id == null) {
    return null;
  }
  return {
    id,
    chat_id: readString(record, 'chat_id', 'chatId'),
    status: readString(record, 'status') ?? 'unknown',
    last_event_seq: readNumber(record, 'last_event_seq', 'lastEventSeq') ?? 0,
    connected_at: toIsoTimestamp(record.connected_at ?? record.connectedAt),
    last_seen_at: toIsoTimestamp(record.last_seen_at ?? record.lastSeenAt),
  };
}

export function normalizeListenerStatus(raw: unknown): ListenerStatusPayload | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId');
  if (agentId == null) {
    return null;
  }
  return {
    agent_id: agentId,
    participant_id: readString(record, 'participant_id', 'participantId'),
    online: readBoolean(record, 'online') === true,
    last_event_seq: readNumber(record, 'last_event_seq', 'lastEventSeq') ?? 0,
    checkin: normalizeCheckin(record.checkin),
    sessions: (Array.isArray(record.sessions) ? record.sessions : [])
      .map(normalizeListenerSession)
      .filter(isListenerSession),
  };
}

export function normalizeWakeToggle(raw: unknown): WakeToggleResult | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId');
  const chatId = readString(record, 'chat_id', 'chatId');
  if (agentId == null || chatId == null) {
    return null;
  }
  return {
    agent_id: agentId,
    chat_id: chatId,
    enabled: readBoolean(record, 'enabled') === true,
    wake_kinds: readStringArray(record.wake_kinds ?? record.wakeKinds),
    consecutive_failures:
      readNumber(record, 'consecutive_failures', 'consecutiveFailures') ?? 0,
    disabled_at: toIsoTimestamp(record.disabled_at ?? record.disabledAt),
  };
}

function failureMessage(error: string | null | undefined, fallback: string): string {
  return error != null && error.trim().length > 0 ? error : fallback;
}

/** Per-chat wake state for one agent (`wake_status`). Reading never mutates. */
export async function wakeStatusOnce(
  agentId?: string,
  chatId?: string,
): Promise<EngineResult<WakeStatusPayload>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.wakeStatus) {
    return { ok: false, error: NO_WAKE_BRIDGE };
  }
  const input: { agentId?: string; chatId?: string } = {};
  if (agentId != null) {
    input.agentId = agentId;
  }
  if (chatId != null) {
    input.chatId = chatId;
  }
  try {
    const result = await api.wakeStatus(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取唤醒状态失败。') };
    }
    const status = normalizeWakeStatus(result.data);
    return status != null
      ? { ok: true, data: status }
      : { ok: false, error: '引擎未返回有效的唤醒状态。' };
  } catch {
    return { ok: false, error: '读取唤醒状态失败（主进程调用异常）。' };
  }
}

/** Listener sessions + check-in interval for one agent (`listener_status`). */
export async function listenerStatusOnce(
  agentId?: string,
): Promise<EngineResult<ListenerStatusPayload>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.listenerStatus) {
    return { ok: false, error: NO_WAKE_BRIDGE };
  }
  try {
    const result = await api.listenerStatus(agentId == null ? {} : { agentId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取 Listener 状态失败。') };
    }
    const status = normalizeListenerStatus(result.data);
    return status != null
      ? { ok: true, data: status }
      : { ok: false, error: '引擎未返回有效的 Listener 状态。' };
  } catch {
    return { ok: false, error: '读取 Listener 状态失败（主进程调用异常）。' };
  }
}

/**
 * Toggle wake for one (agent, chat). The engine's `wake_enable` / `wake_disable`
 * are owner-only, so a non-owner token is rejected there even if the UI gate is
 * bypassed.
 */
export async function setWakeEnabled(input: {
  agentId: string;
  chatId: string;
  enabled: boolean;
}): Promise<EngineResult<WakeToggleResult>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  const action = input.enabled ? api?.wakeEnable : api?.wakeDisable;
  if (!api || action == null) {
    return { ok: false, error: NO_WAKE_BRIDGE };
  }
  try {
    const result = await action({ agentId: input.agentId, chatId: input.chatId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '切换唤醒开关失败。') };
    }
    const toggled = normalizeWakeToggle(result.data);
    return toggled != null
      ? { ok: true, data: toggled }
      : { ok: false, error: '引擎未返回有效的唤醒开关结果。' };
  } catch {
    return { ok: false, error: '切换唤醒开关失败（主进程调用异常）。' };
  }
}

export { NO_MAIN, NO_WAKE_BRIDGE };