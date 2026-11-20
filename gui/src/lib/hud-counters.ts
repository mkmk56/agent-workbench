import type { ChatInboxPayload, EngineEvent } from '../types';

/**
 * REA Phase 4 §7.3 (HUD 500-row saturation fix) — pure counter helpers.
 *
 * Why this module exists (cross-review must-fix M1):
 *  - The 500-row bug was fixed by polling `list_chat_messages({after_seq})`, but
 *    that tool is **pull-to-read**: it advances the authenticated viewer's read
 *    cursor (`src/tools.js:566-579`), and the GUI polls with the master token,
 *    whose participant is `user`. The chat list computes unread from that very
 *    cursor (`src/chats.js:331-352`), so a background HUD poll silently marked
 *    every chat read and the sidebar unread badges (and the 未读 filter) went
 *    permanently empty.
 *  - A background glance view must never mutate read state. The only read-only
 *    engine sources are `inbox` (per-agent per-chat counters; "reading the inbox
 *    does not mark messages read") and `list_chats` (its `unread` field is a
 *    plain SQL count for the viewer). This module turns those payloads into HUD
 *    numbers, and derives the paper-plane animation from the pushed wake events
 *    instead of from a message window.
 *  - Because the counters are absolute (not a row window), the saturation class
 *    of bug cannot come back: history length is irrelevant.
 *
 * No React, no `window`, no IPC at import time, so `node --test` drives it
 * directly.
 */

export type HudCounterId = 'muse' | 'claude' | 'dsh';
export type HudCounterExecutorId = 'claude' | 'dsh';

/** Canvas agent ids behind the three built-in HUD slots (src/agents.js). */
export const HUD_AGENT_IDS: Readonly<Record<HudCounterId, string>> = Object.freeze({
  muse: 'agent_muse',
  claude: 'agent_claude',
  dsh: 'agent_dsh',
});

export const HUD_COUNTER_IDS: readonly HudCounterId[] = Object.freeze([
  'muse',
  'claude',
  'dsh',
]);

/** Built-in agent ids the engine refuses to revoke / remap via chat handles. */
const PARTICIPANT_BY_AGENT_ID: Readonly<Record<string, HudCounterExecutorId>> = Object.freeze({
  agent_claude: 'claude',
  agent_dsh: 'dsh',
});

function finiteCount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.floor(number));
}

function isExecutor(value: string | null | undefined): value is HudCounterExecutorId {
  return value === 'claude' || value === 'dsh';
}

/**
 * Total unread of one agent, straight from an `inbox` payload.
 *
 * `total_unread` is authoritative when the engine sent a number; otherwise the
 * per-chat counters are summed (old engines omitted the field). Garbage never
 * becomes an invented number: it clamps to 0.
 */
export function inboxUnreadTotal(payload: ChatInboxPayload | null | undefined): number {
  if (payload == null) {
    return 0;
  }
  const total = payload.total_unread;
  if (typeof total === 'number' && Number.isFinite(total)) {
    return finiteCount(total);
  }
  const chats = Array.isArray(payload.chats) ? payload.chats : [];
  return chats.reduce((sum, entry) => sum + finiteCount(entry?.unread), 0);
}

/**
 * Read-only unread badge = engine count minus what the user already dismissed.
 *
 * The HUD badge is a glance indicator: clicking a slot clears it locally
 * (the engine's read cursor is never touched from a background poll). A new
 * message arrives ⇒ the absolute count grows past the dismissed floor ⇒ the
 * badge comes back; nothing is ever negative.
 */
export function unreadBadge(absolute: number, dismissedFloor: number): number {
  const abs = finiteCount(absolute);
  const floor = Math.min(finiteCount(dismissedFloor), abs);
  return abs - floor;
}

/**
 * Keep the dismissed floor from swallowing future messages.
 *
 * If the engine count drops below the floor (the agent read its inbox, or the
 * rows were pruned), the floor follows it down. Otherwise a later message would
 * be counted against a stale floor and the badge would stay hidden.
 */
export function reconciledFloor(dismissedFloor: number, absolute: number): number {
  return Math.min(finiteCount(dismissedFloor), finiteCount(absolute));
}

export interface HudFlightHint {
  from: HudCounterExecutorId;
  to: HudCounterExecutorId;
  /** Identity used to de-duplicate replays; never a synthetic person. */
  messageId: string | null;
}

/** Default freshness window for animating a pushed event. */
export const FLIGHT_WINDOW_MS = 120_000;

/**
 * Derive one agent-to-agent paper plane from a pushed wake event.
 *
 * `GET /events` envelopes carry `from` (message author participant) and
 * `agent_id` (the woken recipient). Only executor → executor traffic flies:
 * user posts and Muse events are not "between two executors". Events older than
 * `windowMs` are ignored so an SSE replay (resume after a disconnect) does not
 * animate a burst of history. Replays of the same message are de-duplicated by
 * the caller through `messageId`.
 */
export function flightFromEvent(
  event: EngineEvent | null | undefined,
  now: number,
  windowMs: number = FLIGHT_WINDOW_MS,
): HudFlightHint | null {
  if (event == null) {
    return null;
  }
  const from = event.from;
  if (!isExecutor(from)) {
    return null;
  }
  const target = isExecutor(event.agent_id)
    ? event.agent_id
    : PARTICIPANT_BY_AGENT_ID[String(event.agent_id ?? '')] ?? null;
  if (target == null || target === from) {
    return null;
  }
  const createdAt = Number(event.created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  if (now - createdAt > Math.max(0, windowMs)) {
    return null;
  }
  const messageId =
    typeof event.message_id === 'string' && event.message_id.length > 0
      ? event.message_id
      : null;
  return { from, to: target, messageId };
}