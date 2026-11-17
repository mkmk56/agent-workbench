/**
 * Spec checks for the chat session-list layout (task book §4).
 *
 * Run with: npm run test:layout   (node --test, no new dependencies)
 *
 * These pin the numbers the task fixes: 260–480px range, 8px drag steps,
 * ±16px keyboard steps, 336px reset, 12px collapsed strip, ≤1180px → 280px,
 * ≤1080px auto-collapse, and the localStorage fallback rules.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_SIDEBAR_COLLAPSED_WIDTH,
  CHAT_SIDEBAR_DEFAULT_WIDTH,
  CHAT_SIDEBAR_MAX_WIDTH,
  CHAT_SIDEBAR_MIN_WIDTH,
  CHAT_SIDEBAR_STORAGE_KEY,
  applyViewportWidth,
  chatSidebarColumnWidth,
  clampChatSidebarWidth,
  defaultChatSidebarLayout,
  dragChatSidebarWidth,
  initialChatSidebarLayout,
  nudgeChatSidebarWidth,
  parseChatSidebarLayout,
  readChatSidebarLayout,
  writeChatSidebarLayout,
  type ChatSidebarStorage,
} from '../src/lib/chat-sidebar-layout.ts';

function memoryStorage(initial: Record<string, string> = {}): ChatSidebarStorage & {
  value: Record<string, string>;
  writes: number;
} {
  const value: Record<string, string> = { ...initial };
  const storage = {
    value,
    writes: 0,
    getItem(key: string) {
      return key in value ? value[key] : null;
    },
    setItem(key: string, next: string) {
      storage.writes += 1;
      value[key] = next;
    },
  };
  return storage;
}

test('width range is 260–480px and clamps anything else', () => {
  assert.equal(clampChatSidebarWidth(200), CHAT_SIDEBAR_MIN_WIDTH);
  assert.equal(clampChatSidebarWidth(260), 260);
  assert.equal(clampChatSidebarWidth(480), 480);
  assert.equal(clampChatSidebarWidth(900), CHAT_SIDEBAR_MAX_WIDTH);
  assert.equal(clampChatSidebarWidth(333.4), 333);
  assert.equal(clampChatSidebarWidth(Number.NaN), CHAT_SIDEBAR_DEFAULT_WIDTH);
});

test('drag moves in 8px steps and stops at both extremes', () => {
  assert.equal(dragChatSidebarWidth(336, 0), 336);
  assert.equal(dragChatSidebarWidth(336, 8), 344);
  assert.equal(dragChatSidebarWidth(336, 17), 352, 'delta rounds to the nearest 8px step');
  assert.equal(dragChatSidebarWidth(336, -9), 328);
  assert.equal(dragChatSidebarWidth(336, -300), CHAT_SIDEBAR_MIN_WIDTH);
  assert.equal(dragChatSidebarWidth(336, 300), CHAT_SIDEBAR_MAX_WIDTH);
});

test('keyboard arrows move ±16px, Home returns the 336px default', () => {
  assert.equal(nudgeChatSidebarWidth(336, 1), 352);
  assert.equal(nudgeChatSidebarWidth(336, -1), 320);
  assert.equal(nudgeChatSidebarWidth(CHAT_SIDEBAR_MIN_WIDTH, -1), CHAT_SIDEBAR_MIN_WIDTH);
  assert.equal(nudgeChatSidebarWidth(CHAT_SIDEBAR_MAX_WIDTH, 1), CHAT_SIDEBAR_MAX_WIDTH);
  assert.equal(nudgeChatSidebarWidth(400, 0), 400);
  assert.equal(CHAT_SIDEBAR_DEFAULT_WIDTH, 336);
});

test('collapsed column is the 12px strip, expanded is the real width', () => {
  assert.equal(chatSidebarColumnWidth({ width: 400, collapsed: true }), CHAT_SIDEBAR_COLLAPSED_WIDTH);
  assert.equal(chatSidebarColumnWidth({ width: 400, collapsed: false }), 400);
});

test('storage key and round-trip', () => {
  assert.equal(CHAT_SIDEBAR_STORAGE_KEY, 'agent-workbench.chatSidebar');
  const storage = memoryStorage();
  writeChatSidebarLayout(storage, { width: 400, collapsed: true });
  assert.deepEqual(JSON.parse(storage.value[CHAT_SIDEBAR_STORAGE_KEY]), {
    width: 400,
    collapsed: true,
  });
  assert.deepEqual(readChatSidebarLayout(storage), { width: 400, collapsed: true });
});

test('stored width is clamped before it is written', () => {
  const storage = memoryStorage();
  writeChatSidebarLayout(storage, { width: 5000, collapsed: false });
  assert.deepEqual(readChatSidebarLayout(storage), { width: CHAT_SIDEBAR_MAX_WIDTH, collapsed: false });
});

test('corrupt or out-of-range values fall back to the 336px default', () => {
  assert.equal(parseChatSidebarLayout(null), null);
  assert.equal(parseChatSidebarLayout('not json'), null);
  assert.equal(parseChatSidebarLayout('[]'), null);
  assert.equal(parseChatSidebarLayout('"336"'), null);
  assert.equal(parseChatSidebarLayout('{"width":336}'), null, 'collapsed is required');
  assert.equal(parseChatSidebarLayout('{"width":"336","collapsed":false}'), null);
  assert.equal(parseChatSidebarLayout('{"width":259,"collapsed":false}'), null);
  assert.equal(parseChatSidebarLayout('{"width":481,"collapsed":false}'), null);
  assert.deepEqual(parseChatSidebarLayout('{"width":260,"collapsed":false}'), {
    width: 260,
    collapsed: false,
  });
  assert.deepEqual(parseChatSidebarLayout('{"width":480,"collapsed":true}'), {
    width: 480,
    collapsed: true,
  });
});

test('a broken storage does not throw', () => {
  const storage: ChatSidebarStorage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readChatSidebarLayout(storage), null);
  writeChatSidebarLayout(storage, { width: 336, collapsed: false });
  assert.equal(readChatSidebarLayout(null), null);
  writeChatSidebarLayout(null, { width: 336, collapsed: false });
});

test('breakpoints: ≤1180px is 280px, ≤1080px is collapsed, above is 336px', () => {
  assert.deepEqual(defaultChatSidebarLayout(1440), { width: 336, collapsed: false });
  assert.deepEqual(defaultChatSidebarLayout(1181), { width: 336, collapsed: false });
  assert.deepEqual(defaultChatSidebarLayout(1180), { width: 280, collapsed: false });
  assert.deepEqual(defaultChatSidebarLayout(1081), { width: 280, collapsed: false });
  assert.deepEqual(defaultChatSidebarLayout(1080), { width: 280, collapsed: true });
  assert.deepEqual(defaultChatSidebarLayout(900), { width: 280, collapsed: true });
});

test('startup keeps a stored width but collapses at ≤1080px', () => {
  const wide = initialChatSidebarLayout(1440, { width: 420, collapsed: false });
  assert.deepEqual(wide, { layout: { width: 420, collapsed: false }, autoCollapsed: false });

  const storedCollapsed = initialChatSidebarLayout(1440, { width: 420, collapsed: true });
  assert.deepEqual(storedCollapsed.layout, { width: 420, collapsed: true });

  const narrow = initialChatSidebarLayout(1080, { width: 420, collapsed: false });
  assert.deepEqual(narrow, { layout: { width: 420, collapsed: true }, autoCollapsed: true });
});

test('viewport crossing 1080px collapses, and only an auto-collapse restores', () => {
  const expanded = { width: 336, collapsed: false };

  const down = applyViewportWidth(1080, expanded, false);
  assert.deepEqual(down, { layout: { width: 336, collapsed: true }, autoCollapsed: true });

  const up = applyViewportWidth(1200, down.layout, down.autoCollapsed);
  assert.deepEqual(up, { layout: { width: 336, collapsed: false }, autoCollapsed: false });

  // A manual collapse is never undone by widening the window.
  const manual = applyViewportWidth(1200, { width: 336, collapsed: true }, false);
  assert.deepEqual(manual, { layout: { width: 336, collapsed: true }, autoCollapsed: false });

  // Already collapsed: nothing to do.
  const steady = applyViewportWidth(1000, { width: 336, collapsed: true }, true);
  assert.deepEqual(steady.layout, { width: 336, collapsed: true });
});