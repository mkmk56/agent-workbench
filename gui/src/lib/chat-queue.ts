/**
 * Composer message queue (task §2: "输入框排队芯片").
 *
 * Pure helpers only (no React, no DOM globals) so the rules can be exercised
 * with `node --test`. The React wiring lives in Composer.tsx.
 *
 * Behaviour the task fixes:
 *  - Tab in the composer queues the current text instead of sending it, so the
 *    running round is not interrupted.
 *  - A queued message can be put back into the input ("插入") or deleted.
 *  - Queued messages flush by themselves when the running round finishes. The
 *    only "round finished" signal the engine gives us is the per-agent state in
 *    `chat_status`, so the flush decision is made from those states — never from
 *    a local timer that would pretend a round ended.
 *  - Nothing is marked as sent unless `send_chat_message` returned ok; the queue
 *    item that failed stays in the queue.
 */

export type QueuedMessage = {
  /** Local, stable id (also the React key of the chip). */
  id: string;
  text: string;
  /**
   * True when the text was queued while a round was running: only armed items
   * flush automatically, so pressing Tab on an idle chat can never make a
   * message fire by itself a second later.
   */
  armed: boolean;
  /** Epoch ms, used for a stable order and for the "N 分钟前" hint. */
  queuedAt: number;
};

/** Cap so the chip row cannot grow over the message stream. */
export const CHAT_QUEUE_LIMIT = 5;

/**
 * Agent states that mean "a round is running right now".
 * `waiting` is deliberately NOT here: it means the agent is paused asking the
 * user something, and flushing an unrelated queued line then would answer the
 * question by accident (see QUEUE_HOLD_STATES).
 */
export const QUEUE_BUSY_STATES = ['queued', 'starting', 'working'] as const;

/** States where auto-send must hold: the agent is waiting for the user. */
export const QUEUE_HOLD_STATES = ['waiting'] as const;

export type QueueRejection = 'empty' | 'full' | 'duplicate';

type StateLike = string;

export function isRoundBusy(states: readonly StateLike[]): boolean {
  return states.some((state) => (QUEUE_BUSY_STATES as readonly string[]).includes(state));
}

export function isRoundHeld(states: readonly StateLike[]): boolean {
  return states.some((state) => (QUEUE_HOLD_STATES as readonly string[]).includes(state));
}

/** Auto-send is blocked while a round runs or while an agent waits for us. */
export function roundBlocksAutoSend(states: readonly StateLike[]): boolean {
  return isRoundBusy(states) || isRoundHeld(states);
}

export function queuedTextIsEmpty(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Append one message. Returns the queue unchanged plus a rejection reason when
 * the text is blank, already queued verbatim, or the cap is reached.
 */
export function enqueueMessage(
  queue: readonly QueuedMessage[],
  text: string,
  options: {
    id: string;
    armed: boolean;
    now: number;
    limit?: number;
  },
): { queue: QueuedMessage[]; added: QueuedMessage | null; rejected: QueueRejection | null } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { queue: [...queue], added: null, rejected: 'empty' };
  }
  const limit = options.limit ?? CHAT_QUEUE_LIMIT;
  if (queue.length >= limit) {
    return { queue: [...queue], added: null, rejected: 'full' };
  }
  if (queue.some((item) => item.text === trimmed)) {
    return { queue: [...queue], added: null, rejected: 'duplicate' };
  }
  const added: QueuedMessage = {
    id: options.id,
    text: trimmed,
    armed: options.armed,
    queuedAt: options.now,
  };
  return { queue: [...queue, added], added, rejected: null };
}

export function removeMessage(
  queue: readonly QueuedMessage[],
  id: string,
): QueuedMessage[] {
  return queue.filter((item) => item.id !== id);
}

/** The next item auto-send may take: the oldest armed one. */
export function nextArmedMessage(queue: readonly QueuedMessage[]): QueuedMessage | null {
  return queue.find((item) => item.armed) ?? null;
}

/**
 * "插入": move a queued message back into the composer input.
 *
 * A non-empty draft is kept and the queued line is appended on a new line, so
 * nothing the user already typed is destroyed.
 */
export function insertIntoDraft(
  queue: readonly QueuedMessage[],
  id: string,
  draft: string,
): { queue: QueuedMessage[]; text: string; inserted: QueuedMessage | null } {
  const item = queue.find((entry) => entry.id === id) ?? null;
  if (item == null) {
    return { queue: [...queue], text: draft, inserted: null };
  }
  const head = draft.replace(/\s+$/, '');
  const text = head.length === 0 ? item.text : `${head}\n${item.text}`;
  return { queue: removeMessage(queue, id), text, inserted: item };
}

/**
 * Auto-send decision for one status poll.
 *
 * `sawBusy` is the latch the caller keeps: it becomes true when a round was
 * observed running, and only a genuine busy → idle transition may flush one
 * queued message. Without the latch a single idle window (the status poll lags
 * the send) would fire every queued line at once.
 */
export function shouldFlush(
  queue: readonly QueuedMessage[],
  options: { blocked: boolean; sawBusy: boolean },
): QueuedMessage | null {
  if (options.blocked || !options.sawBusy) {
    return null;
  }
  return nextArmedMessage(queue);
}

/** Display shortening for the chip label; the full text stays in the queue. */
export function chipText(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/* ------------------------------------------------------------------ *
 * Persistence (view-layer preference, like the sidebar layout)
 * ------------------------------------------------------------------ */

export const CHAT_QUEUE_STORAGE_PREFIX = 'agent-workbench.chatQueue.';

/** Minimal storage surface so the helpers stay testable outside a browser. */
export type ChatQueueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function queueStorageKey(chatId: string): string {
  return `${CHAT_QUEUE_STORAGE_PREFIX}${chatId}`;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.text === 'string' &&
    record.text.trim().length > 0 &&
    typeof record.armed === 'boolean' &&
    typeof record.queuedAt === 'number' &&
    Number.isFinite(record.queuedAt)
  );
}

export function parseQueue(raw: string | null): QueuedMessage[] {
  if (raw == null || raw.trim().length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isQueuedMessage).slice(0, CHAT_QUEUE_LIMIT);
}

export function serializeQueue(queue: readonly QueuedMessage[]): string {
  return JSON.stringify(queue.slice(0, CHAT_QUEUE_LIMIT));
}

export function readQueue(storage: ChatQueueStorage | null, chatId: string): QueuedMessage[] {
  if (storage == null || chatId.length === 0) {
    return [];
  }
  try {
    return parseQueue(storage.getItem(queueStorageKey(chatId)));
  } catch {
    return [];
  }
}

export function writeQueue(
  storage: ChatQueueStorage | null,
  chatId: string,
  queue: readonly QueuedMessage[],
): void {
  if (storage == null || chatId.length === 0) {
    return;
  }
  try {
    const key = queueStorageKey(chatId);
    if (queue.length === 0) {
      if (typeof storage.removeItem === 'function') {
        storage.removeItem(key);
      } else {
        storage.setItem(key, '[]');
      }
      return;
    }
    storage.setItem(key, serializeQueue(queue));
  } catch {
    // Non-fatal: the queue still works for this session.
  }
}