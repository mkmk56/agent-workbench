/**
 * Spec checks for the agent status models behind the rail status card and the
 * sidebar status strip (task §1 / §4).
 *
 * Run with: npm run test:chat   (node --test, no new dependencies)
 *
 * These pin what the card may say: the latest message is a real message from
 * that agent, "最近动态" has two visually distinct styles (check + wording for
 * done, alert + wording for blocked), and nothing anywhere produces a quota,
 * usage or token number — the engine has no such source.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentActivity,
  agentStateTone,
  availabilityTone,
  executorAvailability,
  latestAgentMessage,
  summarizeForCard,
} from '../src/lib/agent-status.ts';
import type { ChatMessage } from '../src/types.ts';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  message_id: 'msg-1',
  chat_id: 'chat-1',
  seq: 1,
  from: 'claude',
  to: 'user',
  summary: '修复已推送 48e6154',
  files: [],
  mentions: [],
  status: 'answered',
  created_at: '2026-11-17T11:50:00.000Z',
  task_id: null,
  ...overrides,
});

test('completed and blocked activities use different icons and wording', () => {
  const done = agentActivity('completed');
  assert.equal(done.kind, 'done');
  assert.equal(done.icon, 'check');
  assert.match(done.label, /已完成/);

  for (const state of ['blocked', 'failed', 'stale'] as const) {
    const activity = agentActivity(state);
    assert.equal(activity.kind, 'blocked', state);
    assert.equal(activity.icon, 'alert', state);
  }

  for (const state of ['idle', 'queued', 'working', 'waiting', 'cancelled', 'unknown'] as const) {
    assert.equal(agentActivity(state).kind, 'neutral', state);
    assert.equal(agentActivity(state).icon, 'clock', state);
  }
});

test('the waiting wording follows who owes the reply', () => {
  assert.match(agentActivity('waiting', 'claude').label, /等待你回复/);
  assert.match(agentActivity('waiting', 'dsh').label, /等待你回复/);
  // chat_status uses the same state for needs_muse, where Muse owes the reply.
  assert.match(agentActivity('waiting', 'muse').label, /等待 Muse 回复/);
  assert.equal(agentActivity('waiting', 'muse').kind, 'neutral');
});

test('state tones keep colour as a second channel only', () => {
  assert.equal(agentStateTone('working'), 'accent');
  assert.equal(agentStateTone('waiting'), 'warning');
  assert.equal(agentStateTone('blocked'), 'error');
  assert.equal(agentStateTone('failed'), 'error');
  assert.equal(agentStateTone('completed'), 'success');
  assert.equal(agentStateTone('idle'), 'neutral');
});

test('the newest real message from that agent wins', () => {
  const messages = [
    message({ message_id: 'a', summary: '旧消息', created_at: '2026-11-17T11:00:00.000Z' }),
    message({ message_id: 'b', summary: '新消息', created_at: '2026-11-17T11:55:00.000Z' }),
    message({
      message_id: 'c',
      from: 'dsh',
      summary: '不是他说的',
      created_at: '2026-11-17T11:59:00.000Z',
    }),
  ];
  const latest = latestAgentMessage(messages, 'claude', NOW);
  assert.equal(latest?.text, '新消息');
  assert.equal(latest?.relative, '5 分钟前');
});

test('empty summaries are not used as the "latest message"', () => {
  const messages = [
    message({ message_id: 'a', summary: '有内容', created_at: '2026-11-17T11:00:00.000Z' }),
    message({ message_id: 'b', summary: '   ', created_at: '2026-11-17T11:59:00.000Z' }),
  ];
  assert.equal(latestAgentMessage(messages, 'claude', NOW)?.text, '有内容');
  assert.equal(latestAgentMessage(messages, 'muse', NOW), null);
  assert.equal(latestAgentMessage([], 'claude', NOW), null);
});

test('card preview collapses whitespace and shortens long text', () => {
  assert.equal(summarizeForCard('  第一行\n\n第二行  '), '第一行 第二行');
  assert.equal(summarizeForCard('abcdef', 4), 'abc…');
  // File paths are the only thing the UI must never shorten; this is message text.
  const latest = latestAgentMessage([message({ summary: 'x'.repeat(400) })], 'claude', NOW);
  assert.ok((latest?.text.length ?? 0) <= 160);
});

test('executor availability is derived from agent_info, never invented', () => {
  const agents = [
    {
      name: 'claude',
      available: true,
      version: '1.2.3',
      gateway: { base_url: 'https://example', model: 'claude-sonnet-4' },
    },
    { name: 'dsh', available: false, version: null },
  ];

  assert.deepEqual(executorAvailability(agents, 'claude'), {
    available: true,
    detail: '执行器可用 · claude-sonnet-4',
  });
  assert.deepEqual(executorAvailability(agents, 'dsh'), {
    available: false,
    detail: '执行器不可用',
  });
  // Muse has no local executor row: unknown, and the detail says why.
  const muse = executorAvailability(agents, 'muse');
  assert.equal(muse.available, null);
  assert.match(muse.detail, /云端编排器/);

  const missing = executorAvailability([], 'claude');
  assert.equal(missing.available, null);
  assert.match(missing.detail, /未返回/);

  assert.equal(availabilityTone({ available: true, detail: '' }), 'success');
  assert.equal(availabilityTone({ available: false, detail: '' }), 'error');
  assert.equal(availabilityTone({ available: null, detail: '' }), 'neutral');
});

test('no status model produces a quota, usage or percentage number', () => {
  const serialized = JSON.stringify([
    agentActivity('working'),
    agentActivity('completed'),
    executorAvailability([], 'claude'),
  ]);
  assert.doesNotMatch(serialized, /quota|额度|usage|token|%/i);
});