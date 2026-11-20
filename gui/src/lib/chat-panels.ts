/**
 * REA Phase 4: pure helpers behind the chat inspector, the system-message
 * switch, per-chat drafts and the stream grouping / day separators.
 *
 * No React and no DOM globals, so `node --test` can exercise every rule
 * directly; the components only wire state and rendering.
 */

import type { ChatMessage } from '../types';

/* ------------------------------------------------------------------ *
 * Task inspector drawer: width, drag, persistence
 * ------------------------------------------------------------------ */

export const INSPECTOR_STORAGE_KEY = 'agent-workbench.taskInspector';
export const INSPECTOR_DEFAULT_WIDTH = 460;
export const INSPECTOR_MIN_WIDTH = 320;
export const INSPECTOR_MAX_WIDTH = 760;
export const INSPECTOR_DRAG_STEP = 8;
export const INSPECTOR_KEY_STEP = 16;

export type InspectorLayout = { readonly width: number };

export type PanelStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return INSPECTOR_DEFAULT_WIDTH;
  }
  return Math.min(
    INSPECTOR_MAX_WIDTH,
    Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)),
  );
}

/** Drag: pointer delta quantised to 8px steps measured from the drag origin. */
export function dragInspectorWidth(startWidth: number, deltaX: number): number {
  const base = clampInspectorWidth(startWidth);
  const delta = Number.isFinite(deltaX) ? deltaX : 0;
  const steps = Math.round(delta / INSPECTOR_DRAG_STEP);
  return clampInspectorWidth(base + steps * INSPECTOR_DRAG_STEP);
}

/** Keyboard resize: one 16px step per arrow press. */
export function nudgeInspectorWidth(width: number, steps: number): number {
  const base = clampInspectorWidth(width);
  const count = Number.isFinite(steps) ? Math.round(steps) : 0;
  return clampInspectorWidth(base + count * INSPECTOR_KEY_STEP);
}

export function parseInspectorLayout(raw: string | null): InspectorLayout | null {
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
  const width = (parsed as Record<string, unknown>).width;
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return null;
  }
  if (width < INSPECTOR_MIN_WIDTH || width > INSPECTOR_MAX_WIDTH) {
    return null;
  }
  return { width: Math.round(width) };
}

export function readInspectorLayout(storage: PanelStorage | null): InspectorLayout | null {
  if (storage == null) {
    return null;
  }
  try {
    return parseInspectorLayout(storage.getItem(INSPECTOR_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeInspectorLayout(
  storage: PanelStorage | null,
  layout: InspectorLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(
      INSPECTOR_STORAGE_KEY,
      JSON.stringify({ width: clampInspectorWidth(layout.width) }),
    );
  } catch {
    // Preference only: the drawer still works for this session.
  }
}

/* ------------------------------------------------------------------ *
 * "隐藏系统消息" switch (default: show)
 * ------------------------------------------------------------------ */

export const HIDE_SYSTEM_STORAGE_KEY = 'agent-workbench.hideSystemMessages';

export function readHideSystemMessages(storage: PanelStorage | null): boolean {
  if (storage == null) {
    return false;
  }
  try {
    // Anything other than an explicit "1" keeps the documented default (show):
    // hiding reminders by default would make the stream look empty after an
    // upgrade and the user would have no idea why.
    return storage.getItem(HIDE_SYSTEM_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeHideSystemMessages(
  storage: PanelStorage | null,
  hidden: boolean,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(HIDE_SYSTEM_STORAGE_KEY, hidden ? '1' : '0');
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ *
 * Per-chat composer drafts
 * ------------------------------------------------------------------ */

export const DRAFT_STORAGE_PREFIX = 'agent-workbench.chatDraft:';

export function draftStorageKey(chatId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${chatId}`;
}

export function readDraft(storage: PanelStorage | null, chatId: string | null): string {
  if (storage == null || chatId == null || chatId.length === 0) {
    return '';
  }
  try {
    return storage.getItem(draftStorageKey(chatId)) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(
  storage: PanelStorage | null,
  chatId: string | null,
  text: string,
): void {
  if (storage == null || chatId == null || chatId.length === 0) {
    return;
  }
  try {
    if (text.length === 0) {
      storage.removeItem?.(draftStorageKey(chatId));
      return;
    }
    storage.setItem(draftStorageKey(chatId), text);
  } catch {
    // Storage full / denied: the draft simply stays in memory.
  }
}

/* ------------------------------------------------------------------ *
 * Stream shaping: hide-system filter, day separators, same-sender grouping
 * ------------------------------------------------------------------ */

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type StreamItem =
  | { type: 'day'; key: string; label: string; iso: string }
  | { type: 'message'; key: string; message: ChatMessage; grouped: boolean };

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function isSameDay(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return a === b;
  }
  return startOfDay(new Date(left)) === startOfDay(new Date(right));
}

/** 今天 / 昨天 / 2026-11-20 — computed against `now` so tests stay stable. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  const day = startOfDay(new Date(parsed));
  const today = startOfDay(now);
  const oneDay = 24 * 60 * 60 * 1000;
  if (day === today) {
    return '今天';
  }
  if (day === today - oneDay) {
    return '昨天';
  }
  const date = new Date(parsed);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/**
 * Two consecutive messages share one avatar + name when the same person wrote
 * both inside five minutes without a day boundary in between. Recalled
 * messages always start a new group: their placeholder says nothing about the
 * original author's train of thought.
 */
export function canGroupWithPrevious(
  previous: ChatMessage | null,
  current: ChatMessage,
): boolean {
  if (previous == null || previous.recalled === true || current.recalled === true) {
    return false;
  }
  if (previous.from !== current.from) {
    return false;
  }
  if (!isSameDay(previous.created_at, current.created_at)) {
    return false;
  }
  const left = Date.parse(previous.created_at);
  const right = Date.parse(current.created_at);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  return Math.abs(right - left) <= GROUP_WINDOW_MS;
}

/** Filter + decorate the stream once, so rendering stays a plain map. */
export function buildChatStream(
  messages: ChatMessage[],
  options: { hideSystem?: boolean; now?: Date } = {},
): StreamItem[] {
  const hideSystem = options.hideSystem === true;
  const items: StreamItem[] = [];
  let previousVisible: ChatMessage | null = null;
  let previousDay: string | null = null;

  for (const message of messages) {
    if (hideSystem && message.kind === 'system') {
      continue;
    }
    if (previousDay == null || !isSameDay(previousDay, message.created_at)) {
      items.push({
        type: 'day',
        key: `day-${message.created_at}-${message.message_id}`,
        label: dayLabel(message.created_at, options.now),
        iso: message.created_at,
      });
      // A day break always starts a fresh visual group.
      previousVisible = null;
    }
    items.push({
      type: 'message',
      key: message.message_id,
      message,
      grouped: canGroupWithPrevious(previousVisible, message),
    });
    previousVisible = message;
    previousDay = message.created_at;
  }
  return items;
}

/** Count of hidden system messages, for the "隐藏后整条不渲染" hint. */
export function countSystemMessages(messages: ChatMessage[]): number {
  return messages.filter((message) => message.kind === 'system').length;
}