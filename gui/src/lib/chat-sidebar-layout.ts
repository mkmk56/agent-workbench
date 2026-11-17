/**
 * Chat session-list layout: width, collapse and persistence.
 *
 * Pure helpers only (no React, no DOM globals) so the rules can be exercised
 * directly with `node --test`. The React wiring lives in ChatSidebar.tsx.
 *
 * Spec (task book §4):
 *  - drag 260–480px in 8px steps, keyboard ←/→ ±16px, Home / double-click = 336px
 *  - collapsed keeps a 12px clickable strip; width + collapsed survive a restart
 *  - ≤1180px defaults to 280px, ≤1080px auto-collapses
 */

export const CHAT_SIDEBAR_STORAGE_KEY = 'agent-workbench.chatSidebar';
export const CHAT_SIDEBAR_DEFAULT_WIDTH = 336;
export const CHAT_SIDEBAR_MIN_WIDTH = 260;
export const CHAT_SIDEBAR_MAX_WIDTH = 480;
export const CHAT_SIDEBAR_DRAG_STEP = 8;
export const CHAT_SIDEBAR_KEY_STEP = 16;
export const CHAT_SIDEBAR_COLLAPSED_WIDTH = 12;
export const CHAT_SIDEBAR_NARROW_WIDTH = 280;
export const CHAT_SIDEBAR_NARROW_BREAKPOINT = 1180;
export const CHAT_SIDEBAR_COLLAPSE_BREAKPOINT = 1080;

export type ChatSidebarLayout = {
  readonly width: number;
  readonly collapsed: boolean;
};

/** Minimal storage surface so the helpers stay testable outside a browser. */
export type ChatSidebarStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function round(value: number): number {
  return Math.round(value);
}

export function clampChatSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return CHAT_SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(CHAT_SIDEBAR_MAX_WIDTH, Math.max(CHAT_SIDEBAR_MIN_WIDTH, round(width)));
}

/** Width the grid column should use right now (collapsed = the 12px strip). */
export function chatSidebarColumnWidth(layout: ChatSidebarLayout): number {
  return layout.collapsed
    ? CHAT_SIDEBAR_COLLAPSED_WIDTH
    : clampChatSidebarWidth(layout.width);
}

/**
 * Drag: the pointer delta is quantised to 8px steps measured from the drag
 * origin, so the width never moves by a fraction of a step and both extremes
 * stay reachable.
 */
export function dragChatSidebarWidth(startWidth: number, deltaX: number): number {
  const base = clampChatSidebarWidth(startWidth);
  const delta = Number.isFinite(deltaX) ? deltaX : 0;
  const steps = round(delta / CHAT_SIDEBAR_DRAG_STEP);
  return clampChatSidebarWidth(base + steps * CHAT_SIDEBAR_DRAG_STEP);
}

/** Keyboard: one step per arrow press (← / →), clamped to the legal range. */
export function nudgeChatSidebarWidth(width: number, steps: number): number {
  const base = clampChatSidebarWidth(width);
  const count = Number.isFinite(steps) ? round(steps) : 0;
  return clampChatSidebarWidth(base + count * CHAT_SIDEBAR_KEY_STEP);
}

/**
 * Parse one stored value. `null` means "no usable preference": absent, corrupt
 * JSON, wrong shape, or a width outside 260–480px — all of which fall back to
 * the 336px default rather than silently keeping a bogus width.
 */
export function parseChatSidebarLayout(raw: string | null): ChatSidebarLayout | null {
  if (raw == null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const width = record.width;
  const collapsed = record.collapsed;
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return null;
  }
  if (typeof collapsed !== 'boolean') {
    return null;
  }
  if (width < CHAT_SIDEBAR_MIN_WIDTH || width > CHAT_SIDEBAR_MAX_WIDTH) {
    return null;
  }
  return { width: round(width), collapsed };
}

export function readChatSidebarLayout(
  storage: ChatSidebarStorage | null,
): ChatSidebarLayout | null {
  if (storage == null) {
    return null;
  }
  try {
    return parseChatSidebarLayout(storage.getItem(CHAT_SIDEBAR_STORAGE_KEY));
  } catch {
    // localStorage can be unavailable in restricted contexts.
    return null;
  }
}

export function writeChatSidebarLayout(
  storage: ChatSidebarStorage | null,
  layout: ChatSidebarLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(
      CHAT_SIDEBAR_STORAGE_KEY,
      JSON.stringify({
        width: clampChatSidebarWidth(layout.width),
        collapsed: layout.collapsed,
      }),
    );
  } catch {
    // Non-fatal: the layout still applies for this session.
  }
}

/** Defaults for a viewport where the user has not chosen a width yet. */
export function defaultChatSidebarLayout(viewportWidth: number): ChatSidebarLayout {
  if (!Number.isFinite(viewportWidth)) {
    return { width: CHAT_SIDEBAR_DEFAULT_WIDTH, collapsed: false };
  }
  if (viewportWidth <= CHAT_SIDEBAR_COLLAPSE_BREAKPOINT) {
    return { width: CHAT_SIDEBAR_NARROW_WIDTH, collapsed: true };
  }
  if (viewportWidth <= CHAT_SIDEBAR_NARROW_BREAKPOINT) {
    return { width: CHAT_SIDEBAR_NARROW_WIDTH, collapsed: false };
  }
  return { width: CHAT_SIDEBAR_DEFAULT_WIDTH, collapsed: false };
}

/**
 * Startup state. A stored preference wins (width and collapse are meant to
 * survive a restart); the ≤1080px breakpoint still forces the collapsed state
 * because a 260–480px column does not fit there.
 */
export function initialChatSidebarLayout(
  viewportWidth: number,
  stored: ChatSidebarLayout | null,
): { layout: ChatSidebarLayout; autoCollapsed: boolean } {
  const fallback = defaultChatSidebarLayout(viewportWidth);
  const base = stored ?? fallback;
  if (Number.isFinite(viewportWidth) && viewportWidth <= CHAT_SIDEBAR_COLLAPSE_BREAKPOINT) {
    return { layout: { width: base.width, collapsed: true }, autoCollapsed: true };
  }
  return { layout: base, autoCollapsed: false };
}

/**
 * Viewport change → layout. Crossing below 1080px collapses, crossing back
 * above it restores — but only a collapse this rule caused (`autoCollapsed`),
 * never one the user made by hand. Manual toggles clear `autoCollapsed`.
 */
export function applyViewportWidth(
  viewportWidth: number,
  current: ChatSidebarLayout,
  autoCollapsed: boolean,
): { layout: ChatSidebarLayout; autoCollapsed: boolean } {
  if (!Number.isFinite(viewportWidth)) {
    return { layout: current, autoCollapsed };
  }
  const narrow = viewportWidth <= CHAT_SIDEBAR_COLLAPSE_BREAKPOINT;
  if (narrow && !current.collapsed) {
    return { layout: { width: current.width, collapsed: true }, autoCollapsed: true };
  }
  if (!narrow && autoCollapsed && current.collapsed) {
    return { layout: { width: current.width, collapsed: false }, autoCollapsed: false };
  }
  return { layout: current, autoCollapsed };
}