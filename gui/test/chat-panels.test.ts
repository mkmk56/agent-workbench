import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage } from '../src/types.ts';
import {
  GROUP_WINDOW_MS,
  HIDE_SYSTEM_STORAGE_KEY,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_STORAGE_KEY,
  buildChatStream,
  canGroupWithPrevious,
  clampInspectorWidth,
  countSystemMessages,
  dayLabel,
  dragInspectorWidth,
  draftStorageKey,
  isSameDay,
  nudgeInspectorWidth,
  parseInspectorLayout,
  retryCwdOf,
  retryPromptOf,
  readDraft,
  readHideSystemMessages,
  readInspectorLayout,
  writeDraft,
  writeHideSystemMessages,
  writeInspectorLayout,
  type PanelStorage,
} from '../src/lib/chat-panels.ts';

function memoryStorage(seed: Record<string, string> = {}): PanelStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function message(patch: Partial<ChatMessage> & { created_at: string }): ChatMessage {
  return {
    message_id: patch.message_id ?? `m-${patch.created_at}-${patch.from ?? 'user'}`,
    seq: patch.seq ?? 1,
    from: patch.from ?? 'user',
    to: patch.to ?? 'muse',
    summary: patch.summary ?? 'hello',
    files: [],
    mentions: [],
    status: patch.status ?? 'stored',
    ...patch,
  };
}

// ---------------------------------------------------------------- inspector

test('inspector width clamps to the documented range', () => {
  assert.equal(clampInspectorWidth(Number.NaN), INSPECTOR_DEFAULT_WIDTH);
  assert.equal(clampInspectorWidth(10), INSPECTOR_MIN_WIDTH);
  assert.equal(clampInspectorWidth(5_000), INSPECTOR_MAX_WIDTH);
  assert.equal(clampInspectorWidth(455.4), 455);
});

test('inspector drag is quantised to 8px steps from the drag origin', () => {
  assert.equal(dragInspectorWidth(400, 0), 400);
  assert.equal(dragInspectorWidth(400, 3), 400);
  assert.equal(dragInspectorWidth(400, 5), 408);
  // Math.round(-1.5) is -1, so 12px left is one step, 16px is two.
  assert.equal(dragInspectorWidth(400, -12), 392);
  assert.equal(dragInspectorWidth(400, -16), 384);
  // Both extremes stay reachable.
  assert.equal(dragInspectorWidth(400, -10_000), INSPECTOR_MIN_WIDTH);
  assert.equal(dragInspectorWidth(400, 10_000), INSPECTOR_MAX_WIDTH);
});

test('inspector keyboard resize uses 16px steps', () => {
  assert.equal(nudgeInspectorWidth(400, 1), 416);
  assert.equal(nudgeInspectorWidth(400, -2), 368);
  assert.equal(nudgeInspectorWidth(INSPECTOR_MIN_WIDTH, -1), INSPECTOR_MIN_WIDTH);
});

test('inspector layout round-trips and rejects corrupt values', () => {
  const storage = memoryStorage();
  writeInspectorLayout(storage, { width: 520 });
  assert.deepEqual(readInspectorLayout(storage), { width: 520 });
  assert.equal(
    storage.data.get(INSPECTOR_STORAGE_KEY),
    JSON.stringify({ width: 520 }),
  );

  assert.equal(parseInspectorLayout(null), null);
  assert.equal(parseInspectorLayout('not json'), null);
  assert.equal(parseInspectorLayout('{"width":"520"}'), null);
  // Out-of-range stored widths fall back to the default instead of applying.
  assert.equal(parseInspectorLayout('{"width":120}'), null);
  assert.equal(parseInspectorLayout('{"width":4000}'), null);
  assert.equal(readInspectorLayout(null), null);
});

// ------------------------------------------------------- hide system switch

test('hide-system preference defaults to showing system messages', () => {
  assert.equal(readHideSystemMessages(null), false);
  assert.equal(readHideSystemMessages(memoryStorage()), false);
  assert.equal(readHideSystemMessages(memoryStorage({ [HIDE_SYSTEM_STORAGE_KEY]: 'x' })), false);
  assert.equal(
    readHideSystemMessages(memoryStorage({ [HIDE_SYSTEM_STORAGE_KEY]: '1' })),
    true,
  );
});

test('hide-system preference persists both directions', () => {
  const storage = memoryStorage();
  writeHideSystemMessages(storage, true);
  assert.equal(readHideSystemMessages(storage), true);
  writeHideSystemMessages(storage, false);
  assert.equal(readHideSystemMessages(storage), false);
});

// -------------------------------------------------------------------- drafts

test('drafts are stored per chat and cleared when empty', () => {
  const storage = memoryStorage();
  writeDraft(storage, 'chat-a', 'half typed');
  writeDraft(storage, 'chat-b', 'other chat');
  assert.equal(readDraft(storage, 'chat-a'), 'half typed');
  assert.equal(readDraft(storage, 'chat-b'), 'other chat');
  assert.equal(readDraft(storage, 'chat-c'), '');
  assert.notEqual(draftStorageKey('chat-a'), draftStorageKey('chat-b'));

  writeDraft(storage, 'chat-a', '');
  assert.equal(readDraft(storage, 'chat-a'), '');
  assert.equal(storage.data.has(draftStorageKey('chat-a')), false);
  // The other chat is untouched.
  assert.equal(readDraft(storage, 'chat-b'), 'other chat');
});

test('draft helpers tolerate a missing storage or chat id', () => {
  assert.equal(readDraft(null, 'chat-a'), '');
  assert.equal(readDraft(memoryStorage(), null), '');
  assert.doesNotThrow(() => writeDraft(null, 'chat-a', 'x'));
  assert.doesNotThrow(() => writeDraft(memoryStorage(), null, 'x'));
});

// ------------------------------------------------------------ stream shaping

test('system messages are hidden only when the switch is on', () => {
  const messages = [
    message({ created_at: '2026-11-20T09:00:00.000Z' }),
    message({ created_at: '2026-11-20T09:01:00.000Z', kind: 'system', from: 'claude' }),
    message({ created_at: '2026-11-20T09:02:00.000Z', kind: 'user' }),
  ];
  const shown = buildChatStream(messages);
  assert.equal(shown.filter((item) => item.type === 'message').length, 3);

  const hidden = buildChatStream(messages, { hideSystem: true });
  const bodies = hidden
    .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
    .map((item) => item.message.created_at);
  assert.deepEqual(bodies, ['2026-11-20T09:00:00.000Z', '2026-11-20T09:02:00.000Z']);
  assert.equal(countSystemMessages(messages), 1);
});

test('a day separator is emitted once per local day', () => {
  const messages = [
    message({ created_at: '2026-11-19T09:00:00.000Z', message_id: 'a' }),
    message({ created_at: '2026-11-19T23:59:00.000Z', message_id: 'b' }),
    message({ created_at: '2026-11-20T00:01:00.000Z', message_id: 'c' }),
  ];
  const items = buildChatStream(messages);
  assert.equal(items.filter((item) => item.type === 'day').length, 2);
  assert.equal(items[0].type, 'day');
});

test('same sender within five minutes is grouped, a new sender is not', () => {
  const first = message({ created_at: '2026-11-20T09:00:00.000Z', from: 'claude' });
  const second = message({ created_at: '2026-11-20T09:04:00.000Z', from: 'claude' });
  const third = message({ created_at: '2026-11-20T09:06:00.000Z', from: 'claude' });
  const other = message({ created_at: '2026-11-20T09:07:00.000Z', from: 'dsh' });

  assert.equal(canGroupWithPrevious(null, first), false);
  assert.equal(canGroupWithPrevious(first, second), true);
  // 6 minutes after the *previous* message: a new group even though the first
  // message is only 6 minutes old too.
  assert.equal(canGroupWithPrevious(second, third), true);
  assert.equal(canGroupWithPrevious(first, third), false);
  assert.equal(canGroupWithPrevious(third, other), false);
  assert.ok(GROUP_WINDOW_MS === 5 * 60 * 1000);

  const items = buildChatStream([first, second, third, other]);
  const grouped = items
    .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
    .map((item) => item.grouped);
  assert.deepEqual(grouped, [false, true, true, false]);
});

test('a recalled message never groups and never absorbs its neighbour', () => {
  const before = message({ created_at: '2026-11-20T09:00:00.000Z', from: 'claude' });
  const recalled = message({
    created_at: '2026-11-20T09:01:00.000Z',
    from: 'claude',
    recalled: true,
  });
  const after = message({ created_at: '2026-11-20T09:02:00.000Z', from: 'claude' });
  assert.equal(canGroupWithPrevious(before, recalled), false);
  assert.equal(canGroupWithPrevious(recalled, after), false);
});

test('day labels are 今天 / 昨天 / absolute date', () => {
  const now = new Date(2026, 10, 20, 12, 0, 0);
  assert.equal(dayLabel(new Date(2026, 10, 20, 9, 0, 0).toISOString(), now), '今天');
  assert.equal(dayLabel(new Date(2026, 10, 19, 23, 0, 0).toISOString(), now), '昨天');
  assert.equal(dayLabel(new Date(2026, 10, 1, 9, 0, 0).toISOString(), now), '2026-11-01');
  assert.equal(dayLabel('not-a-date', now), 'not-a-date');
});

test('isSameDay compares local calendar days, not 24h windows', () => {
  assert.equal(isSameDay('2026-11-20T00:00:01', '2026-11-20T23:59:59'), true);
  assert.equal(isSameDay('2026-11-20T23:59:59', '2026-11-21T00:00:01'), false);
  assert.equal(isSameDay('garbage', 'garbage'), true);
});

test('retry reuses the stored prompt, never the finished summary', () => {
  // `summary` is the result text of a finished run (src/scheduler.js); feeding it
  // back as the prompt starts a different task, which is exactly what M2 fixed.
  assert.equal(
    retryPromptOf({ prompt: '修复登录超时', summary: '已经修好了' }),
    '修复登录超时',
  );
  // Verbatim: an internal newline / trailing space is part of the prompt.
  assert.equal(retryPromptOf({ prompt: '  keep  me \n' }), '  keep  me \n');
  assert.equal(retryPromptOf({ prompt: '   ', summary: '结论' }), null);
  assert.equal(retryPromptOf({ prompt: null, summary: '结论' }), null);
  assert.equal(retryPromptOf({ summary: '结论' }), null, 'an old engine has no prompt');
  assert.equal(retryPromptOf(null), null);
  assert.equal(retryPromptOf(undefined), null);
});

test('retry reads the stored cwd and omits it when the engine has none', () => {
  assert.equal(retryCwdOf({ prompt: 'p', cwd: 'C:\\work' }), 'C:\\work');
  assert.equal(retryCwdOf({ prompt: 'p', cwd: '   ' }), null);
  assert.equal(retryCwdOf({ prompt: 'p' }), null);
  assert.equal(retryCwdOf(null), null);
});
