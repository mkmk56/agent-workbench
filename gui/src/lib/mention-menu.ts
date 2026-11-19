/**
 * Avatar right-click "@ this agent" (Muse, mouse-on-avatar menu).
 *
 * Two pieces of pure logic live here so they can be unit-tested without a DOM
 * (gui/test/mention-menu.test.ts):
 *
 *  - which message senders are @-able, and with which handle. The handle list is
 *    deliberately the same three the composer and the message renderer already
 *    understand (`@muse` / `@claude` / `@dsh`); nothing new is invented.
 *  - where a fixed-position menu may be painted: near the right (or bottom)
 *    window edge it flips to the other side instead of overflowing.
 */
import type { ChatAgentId } from '../types';

/** The only three @ handles the chat UI parses and colours. */
export const MENTION_HANDLES: Record<ChatAgentId, string> = {
  muse: 'muse',
  claude: 'claude',
  dsh: 'dsh',
};

/** Stable picker order (the same order the composer's mention list uses). */
export const MENTION_AGENT_IDS: readonly ChatAgentId[] = ['muse', 'claude', 'dsh'];

const HANDLE_TO_AGENT = new Map<string, ChatAgentId>(
  MENTION_AGENT_IDS.map((id) => [MENTION_HANDLES[id], id]),
);

/**
 * The @-able agent behind a message sender, or null when there is none.
 * `user` and `unknown` are never mentionable — you cannot @ yourself, and an
 * unrecognised sender has no handle.
 */
export function mentionAgentFor(sender: string | null | undefined): ChatAgentId | null {
  if (sender == null) {
    return null;
  }
  return HANDLE_TO_AGENT.get(sender.toLowerCase()) ?? null;
}

/** Current caret / selection of the composer textarea. */
export interface TextSelection {
  start: number;
  end: number;
}

export interface MentionInsertion {
  /** The whole draft after the insertion. */
  text: string;
  /** Caret position right after the inserted `@handle ` (so typing continues there). */
  caret: number;
  agent: ChatAgentId;
  handle: string;
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) {
    return length;
  }
  return Math.min(Math.max(Math.trunc(value), 0), length);
}

/**
 * Insert `@handle ` into the draft at the caret, replacing an active selection
 * and leaving the caret after the trailing space. A separator space is added
 * when the caret sits directly after a non-space character, because the @ parser
 * only recognises a whole handle (`foo@muse` is not a mention).
 */
export function insertMentionAt(
  text: string,
  agent: ChatAgentId,
  selection?: TextSelection,
): MentionInsertion {
  const length = text.length;
  const start = clampIndex(selection?.start ?? length, length);
  const end = Math.max(start, clampIndex(selection?.end ?? start, length));
  const handle = MENTION_HANDLES[agent];
  const previous = start > 0 ? text.charAt(start - 1) : '';
  const prefix = previous.length > 0 && !/\s/.test(previous) ? ' ' : '';
  const insertion = `${prefix}@${handle} `;
  return {
    text: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    caret: start + insertion.length,
    agent,
    handle,
  };
}

/** Distance kept between the menu and the window edges. */
export const MENU_VIEWPORT_MARGIN = 8;

/**
 * One "@ this agent" pick, travelling from the message stream to the composer.
 * `seq` makes repeated picks of the same agent distinct, and `chatId` keeps a
 * stale request from landing in another chat's draft.
 */
export interface MentionRequest {
  chatId: string;
  agent: ChatAgentId;
  seq: number;
}

/** Pointer position of a `contextmenu` event, in fixed (viewport) coordinates. */
export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuPlacementInput {
  /** Pointer position (fixed coordinates). */
  x: number;
  y: number;
  /** Measured menu box. */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** True when the menu had to open to the left of the pointer. */
  flippedX: boolean;
  /** True when the menu had to open above the pointer. */
  flippedY: boolean;
}

/**
 * Keep a fixed-position menu inside the viewport: flip to the left of the
 * pointer when it would cross the right edge, flip above it near the bottom,
 * then clamp so the box stays visible even when it is larger than the window.
 */
export function clampMenuPosition(input: MenuPlacementInput): MenuPlacement {
  const margin = input.margin ?? MENU_VIEWPORT_MARGIN;
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const maxLeft = Math.max(margin, input.viewportWidth - width - margin);
  const maxTop = Math.max(margin, input.viewportHeight - height - margin);

  let left = input.x;
  const flippedX = input.x + width > input.viewportWidth - margin;
  if (flippedX) {
    left = input.x - width;
  }
  left = Math.min(Math.max(left, margin), maxLeft);

  let top = input.y;
  const flippedY = input.y + height > input.viewportHeight - margin;
  if (flippedY) {
    top = input.y - height;
  }
  top = Math.min(Math.max(top, margin), maxTop);

  return { left, top, flippedX, flippedY };
}