/**
 * Spec checks for the REA Phase 2 Inbox and Profile Card normalizers
 * (docs/rea/TARGET_ARCHITECTURE.md D1/D3, MESSAGE_PROTOCOL.md §5).
 *
 * Run with: npm run test:chat
 *
 * The fixtures mirror the engine's real payloads: `inbox` in src/agents.js
 * (you / total_unread / chats[]) and `agent_profile` (publicAgent in
 * src/agents.js). The normalizer must pass those fields through unchanged —
 * counters are never recomputed in the renderer, and a missing `you` block
 * must fail instead of inventing an identity.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAgentProfile,
  normalizeInbox,
  normalizeInboxEntry,
} from '../src/lib/chat.ts';

const inboxEntry = {
  chat_id: 'chat-1',
  name: '四人小组',
  status: 'active',
  last_read_seq: 41,
  unread: 3,
  mentions_you: 1,
  replies_to_you: 2,
  from_owner: 1,
  recalled: 1,
  last_message_at: '2026-11-18T17:45:37.762Z',
};

const inboxPayload = {
  you: {
    agent_id: 'agent_dsh',
    participant_id: 'dsh',
    owner: 'user',
    platform: 'dsh',
    display_name: 'dsh',
    human: false,
    status: 'active',
  },
  total_unread: 3,
  chats: [inboxEntry],
};

test('inbox normalizer keeps the engine counters verbatim', () => {
  const inbox = normalizeInbox(inboxPayload);
  assert.ok(inbox != null);
  assert.equal(inbox.you.agent_id, 'agent_dsh');
  assert.equal(inbox.you.human, false);
  assert.equal(inbox.total_unread, 3);
  assert.equal(inbox.chats.length, 1);
  const entry = inbox.chats[0];
  assert.equal(entry.chat_id, 'chat-1');
  assert.equal(entry.unread, 3);
  assert.equal(entry.mentions_you, 1);
  assert.equal(entry.replies_to_you, 2);
  assert.equal(entry.from_owner, 1);
  assert.equal(entry.recalled, 1);
  assert.equal(entry.last_read_seq, 41);
});

test('inbox without a you block is rejected rather than guessed', () => {
  assert.equal(normalizeInbox({ total_unread: 0, chats: [] }), null);
  assert.equal(normalizeInbox(null), null);
});

test('inbox total falls back to the per-chat sum only when absent', () => {
  const withoutTotal = normalizeInbox({ ...inboxPayload, total_unread: undefined });
  assert.ok(withoutTotal != null);
  assert.equal(withoutTotal.total_unread, 3);
});

test('inbox entry without a chat id is dropped', () => {
  assert.equal(normalizeInboxEntry({ name: '无 id 的群' }), null);
});

test('profile normalizer mirrors publicAgent', () => {
  const card = normalizeAgentProfile({
    agent_id: 'agent_claude',
    participant_id: 'claude',
    owner: 'user',
    platform: 'claude-code',
    display_name: 'Claude',
    profile: 'Backend and core engineering executor.',
    color: '#b26a4e',
    status: 'active',
    created_at: 1763000000000,
  });
  assert.ok(card != null);
  assert.equal(card.agent_id, 'agent_claude');
  assert.equal(card.participant_id, 'claude');
  assert.equal(card.owner, 'user');
  assert.equal(card.profile, 'Backend and core engineering executor.');
  assert.equal(card.status, 'active');
});

test('profile with no text stays null instead of becoming empty prose', () => {
  const card = normalizeAgentProfile({
    agent_id: 'agent_muse',
    display_name: 'Muse',
    profile: null,
    status: 'active',
  });
  assert.ok(card != null);
  assert.equal(card.profile, null);
  assert.equal(card.owner, null);
});

test('profile without an agent id is rejected', () => {
  assert.equal(normalizeAgentProfile({ profile: 'orphan' }), null);
});