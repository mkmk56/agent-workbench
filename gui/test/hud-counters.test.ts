/**
 * Spec checks for the HUD counter fix (REA Phase 4 §7.3, cross-review M1).
 *
 * Run with:
 *   node --test --experimental-strip-types --experimental-test-isolation=none \
 *     test/hud-counters.test.ts
 *
 * What is pinned here:
 *  - Unread comes from absolute `inbox` counters, so history length can never
 *    saturate it (the original 500-row bug).
 *  - The dismissed floor math keeps a cleared badge cleared, brings it back for
 *    a genuinely new message, and never goes negative.
 *  - Paper planes are derived from pushed wake events (executor → executor
 *    only), with a freshness window and a replay identity.
 *  - A source guard: the background HUD must not read `list_chat_messages`
 *    again. That tool is pull-to-read and its read cursor is what the sidebar
 *    unread badges are computed from, so polling it silently marked every chat
 *    read (the M1 regression).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  FLIGHT_WINDOW_MS,
  HUD_AGENT_IDS,
  HUD_COUNTER_IDS,
  flightFromEvent,
  inboxUnreadTotal,
  reconciledFloor,
  unreadBadge,
} from '../src/lib/hud-counters.ts';

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);

test('slot ids map to the canonical engine agent ids', () => {
  assert.deepEqual([...HUD_COUNTER_IDS], ['muse', 'claude', 'dsh']);
  assert.equal(HUD_AGENT_IDS.muse, 'agent_muse');
  assert.equal(HUD_AGENT_IDS.claude, 'agent_claude');
  assert.equal(HUD_AGENT_IDS.dsh, 'agent_dsh');
});

test('inboxUnreadTotal trusts total_unread and never invents a number', () => {
  assert.equal(inboxUnreadTotal(null), 0);
  assert.equal(inboxUnreadTotal(undefined), 0);
  assert.equal(
    inboxUnreadTotal({
      you: { agent_id: 'agent_claude' },
      total_unread: 7,
      chats: [{ chat_id: 'a', unread: 3 }, { chat_id: 'b', unread: 4 }],
    } as never),
    7,
  );
  // An older engine that omits total_unread: sum the per-chat counters.
  assert.equal(
    inboxUnreadTotal({
      you: { agent_id: 'agent_claude' },
      chats: [{ chat_id: 'a', unread: 2 }, { chat_id: 'b', unread: 5 }],
    } as never),
    7,
  );
  assert.equal(
    inboxUnreadTotal({
      you: { agent_id: 'agent_claude' },
      total_unread: Number.NaN,
      chats: [{ chat_id: 'a', unread: 1 }],
    } as never),
    1,
  );
  assert.equal(
    inboxUnreadTotal({
      you: { agent_id: 'agent_claude' },
      total_unread: -4,
      chats: [],
    } as never),
    0,
    'a negative counter is clamped, not shown',
  );
});

test('the badge is absolute unread minus the dismissed floor', () => {
  assert.equal(unreadBadge(0, 0), 0);
  assert.equal(unreadBadge(5, 0), 5);
  assert.equal(unreadBadge(5, 5), 0, 'a dismissed badge stays cleared');
  assert.equal(unreadBadge(6, 5), 1, 'a new message brings the badge back');
  assert.equal(unreadBadge(3, 9), 0, 'a floor above the count never goes negative');
  assert.equal(unreadBadge(3.9, 0), 3);
  assert.equal(unreadBadge(Number.NaN, Number.NaN), 0);
});

test('reconciledFloor follows the engine count down so new messages still show', () => {
  assert.equal(reconciledFloor(10, 10), 10);
  assert.equal(reconciledFloor(10, 2), 2, 'the agent read its inbox: floor drops');
  assert.equal(reconciledFloor(0, 4), 0, 'never raises the floor by itself');
  // After the drop a new message is visible again.
  const floor = reconciledFloor(10, 2);
  assert.equal(unreadBadge(3, floor), 1);
  assert.equal(reconciledFloor(Number.NaN, 5), 0);
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    seq: 41,
    chat_id: 'chat-1',
    kind: 'mention',
    from: 'claude',
    agent_id: 'agent_dsh',
    message_id: 'msg-1',
    message_seq: 12,
    mentions: ['dsh'],
    created_at: NOW - 1_000,
    ...overrides,
  } as never;
}

test('flights only cover executor-to-executor traffic', () => {
  assert.deepEqual(flightFromEvent(event(), NOW), {
    from: 'claude',
    to: 'dsh',
    messageId: 'msg-1',
  });
  assert.deepEqual(flightFromEvent(event({ from: 'dsh', agent_id: 'agent_claude' }), NOW), {
    from: 'dsh',
    to: 'claude',
    messageId: 'msg-1',
  });
  // Handles are accepted as well as canonical agent ids.
  assert.deepEqual(flightFromEvent(event({ agent_id: 'dsh' }), NOW), {
    from: 'claude',
    to: 'dsh',
    messageId: 'msg-1',
  });

  assert.equal(flightFromEvent(event({ from: 'user' }), NOW), null, 'owner posts do not fly');
  assert.equal(
    flightFromEvent(event({ from: 'muse', agent_id: 'agent_claude' }), NOW),
    null,
    'Muse is not an executor',
  );
  assert.equal(
    flightFromEvent(event({ agent_id: 'agent_muse' }), NOW),
    null,
    'a flight needs two executors',
  );
  assert.equal(
    flightFromEvent(event({ agent_id: 'agent_claude' }), NOW),
    null,
    'a message never flies to its own author',
  );
  assert.equal(flightFromEvent(event({ from: null }), NOW), null);
  assert.equal(flightFromEvent(null, NOW), null);
});

test('flights ignore stale events so an SSE replay does not animate history', () => {
  assert.equal(
    flightFromEvent(event({ created_at: NOW - FLIGHT_WINDOW_MS - 1 }), NOW),
    null,
  );
  assert.notEqual(
    flightFromEvent(event({ created_at: NOW - FLIGHT_WINDOW_MS }), NOW),
    null,
    'the window boundary is inclusive',
  );
  assert.equal(flightFromEvent(event({ created_at: 0 }), NOW), null);
  assert.equal(flightFromEvent(event({ created_at: 'nope' }), NOW), null);
  assert.deepEqual(flightFromEvent(event({ message_id: '' }), NOW), {
    from: 'claude',
    to: 'dsh',
    messageId: null,
    // The caller falls back to the event id for de-duplication.
  });
});

test('the background HUD never pull-reads the chat message stream', () => {
  // `list_chat_messages` advances the viewer's read cursor (src/tools.js), and
  // the chat list computes unread from that cursor (src/chats.js). Polling it
  // from the HUD is the exact regression M1 fixed, so this guard is deliberate.
  const source = readFileSync(new URL('../src/lib/hud.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /listChatMessages/,
    'the HUD must not even import the pull-to-read helper',
  );
  const chatImport = /import \{([^}]*)\} from '\.\/chat';/.exec(source)?.[1] ?? '';
  assert.match(chatImport, /chatInboxOnce/, 'unread must come from the inbox counters');
  assert.match(chatImport, /listChatsOnce/, 'waiting-for-user comes from the chat list');
  assert.match(source, /flightFromEvent/, 'paper planes must come from pushed events');
});