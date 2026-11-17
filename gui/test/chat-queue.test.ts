/**
 * Spec checks for the composer queue (task §2: 输入框排队芯片).
 *
 * Run with: npm run test:chat   (node --test, no new dependencies)
 *
 * These pin the rules the task fixes: Tab queues instead of sending, a queued
 * message can be inserted back or deleted, auto-send only fires after a round
 * that was actually observed running, and nothing is dropped unless the send
 * succeeded (the caller only removes on ok, tested here through removeMessage).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_QUEUE_LIMIT,
  CHAT_QUEUE_STORAGE_PREFIX,
  chipText,
  enqueueMessage,
  insertIntoDraft,
  isRoundBusy,
  isRoundHeld,
  nextArmedMessage,
  parseQueue,
  queueStorageKey,
  readQueue,
  removeMessage,
  roundBlocksAutoSend,
  serializeQueue,
  shouldFlush,
  writeQueue,
  type ChatQueueStorage,
  type QueuedMessage,
} from '../src/lib/chat-queue.ts';

function memoryStorage(): ChatQueueStorage & { value: Record<string, string> } {
  const value: Record<string, string> = {};
  return {
    value,
    getItem: (key) => (key in value ? value[key] : null),
    setItem: (key, next) => {
      value[key] = next;
    },
    removeItem: (key) => {
      delete value[key];
    },
  };
}

const queued = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'q1',
  text: '继续下一步',
  armed: true,
  queuedAt: 1_700_000_000_000,
  ...overrides,
});

test('tab-queued text is trimmed and keeps queue order', () => {
  const first = enqueueMessage([], '  先跑测试  ', {
    id: 'a',
    armed: true,
    now: 1,
  });
  assert.equal(first.rejected, null);
  assert.deepEqual(first.queue, [{ id: 'a', text: '先跑测试', armed: true, queuedAt: 1 }]);

  const second = enqueueMessage(first.queue, '再跑构建', {
    id: 'b',
    armed: true,
    now: 2,
  });
  assert.deepEqual(
    second.queue.map((item) => item.id),
    ['a', 'b'],
  );
});

test('blank, duplicate and over-cap enqueues are rejected without losing the queue', () => {
  const start = [queued({ id: 'a', text: '同一条' })];

  const blank = enqueueMessage(start, '   ', { id: 'b', armed: true, now: 1 });
  assert.equal(blank.rejected, 'empty');
  assert.equal(blank.added, null);
  assert.equal(blank.queue.length, 1);

  const duplicate = enqueueMessage(start, '同一条', { id: 'b', armed: true, now: 1 });
  assert.equal(duplicate.rejected, 'duplicate');
  assert.equal(duplicate.queue.length, 1);

  const full: QueuedMessage[] = Array.from({ length: CHAT_QUEUE_LIMIT }, (_value, index) =>
    queued({ id: `q${index}`, text: `消息 ${index}` }),
  );
  const overflow = enqueueMessage(full, '再来一条', { id: 'extra', armed: true, now: 1 });
  assert.equal(overflow.rejected, 'full');
  assert.equal(overflow.queue.length, CHAT_QUEUE_LIMIT);
});

test('insert puts the queued text back without destroying a non-empty draft', () => {
  const queue = [queued({ id: 'a', text: '排队的话' })];

  const emptyDraft = insertIntoDraft(queue, 'a', '   ');
  assert.equal(emptyDraft.text, '排队的话');
  assert.equal(emptyDraft.queue.length, 0);

  const withDraft = insertIntoDraft(queue, 'a', '我正在写');
  assert.equal(withDraft.text, '我正在写\n排队的话');
  assert.equal(withDraft.queue.length, 0);

  const missing = insertIntoDraft(queue, 'nope', '保留');
  assert.equal(missing.inserted, null);
  assert.equal(missing.text, '保留');
  assert.equal(missing.queue.length, 1);
});

test('delete removes exactly one chip', () => {
  const queue = [queued({ id: 'a' }), queued({ id: 'b' })];
  assert.deepEqual(
    removeMessage(queue, 'a').map((item) => item.id),
    ['b'],
  );
});

test('only an armed item is eligible for auto-send', () => {
  const queue = [queued({ id: 'idle', armed: false }), queued({ id: 'busy', armed: true })];
  assert.equal(nextArmedMessage(queue)?.id, 'busy');
  assert.equal(nextArmedMessage([queued({ id: 'x', armed: false })]), null);
});

test('auto-send needs an observed round: no latch, no flush', () => {
  const queue = [queued()];
  assert.equal(shouldFlush(queue, { blocked: false, sawBusy: false }), null);
  assert.equal(shouldFlush(queue, { blocked: true, sawBusy: true }), null);
  assert.equal(shouldFlush(queue, { blocked: false, sawBusy: true })?.id, 'q1');
  assert.equal(shouldFlush([], { blocked: false, sawBusy: true }), null);
});

test('a running or waiting round blocks auto-send', () => {
  assert.equal(isRoundBusy(['working']), true);
  assert.equal(isRoundBusy(['queued']), true);
  assert.equal(isRoundBusy(['starting']), true);
  assert.equal(isRoundBusy(['completed', 'idle']), false);
  assert.equal(isRoundHeld(['waiting']), true);
  assert.equal(roundBlocksAutoSend(['idle', 'waiting', 'idle']), true);
  assert.equal(roundBlocksAutoSend(['idle', 'completed', 'failed']), false);
  assert.equal(roundBlocksAutoSend([]), false);
});

test('chip label collapses whitespace and shortens with an ellipsis', () => {
  assert.equal(chipText('  一行\n\n文字  '), '一行 文字');
  assert.equal(chipText('abcdef', 4), 'abc…');
});

test('queue survives a storage round-trip and rejects corrupt payloads', () => {
  const storage = memoryStorage();
  const queue = [queued({ id: 'a', text: '一' }), queued({ id: 'b', text: '二', armed: false })];

  writeQueue(storage, 'chat-1', queue);
  assert.equal(queueStorageKey('chat-1'), `${CHAT_QUEUE_STORAGE_PREFIX}chat-1`);
  assert.deepEqual(readQueue(storage, 'chat-1'), queue);

  writeQueue(storage, 'chat-1', []);
  assert.equal(storage.value[queueStorageKey('chat-1')], undefined);
  assert.deepEqual(readQueue(storage, 'chat-1'), []);

  assert.deepEqual(parseQueue('not json'), []);
  assert.deepEqual(parseQueue(null), []);
  assert.deepEqual(parseQueue('{"id":"x"}'), []);
  assert.deepEqual(parseQueue('[{"id":"x","text":"好","armed":true,"queuedAt":1}]'), [
    { id: 'x', text: '好', armed: true, queuedAt: 1 },
  ]);
  // Entries that do not match the shape are dropped, not repaired.
  assert.deepEqual(parseQueue('[{"id":"x"}]'), []);
});

test('serialisation caps the queue at the limit', () => {
  const long = Array.from({ length: CHAT_QUEUE_LIMIT + 3 }, (_value, index) =>
    queued({ id: `q${index}`, text: `m${index}` }),
  );
  assert.equal(JSON.parse(serializeQueue(long)).length, CHAT_QUEUE_LIMIT);
});