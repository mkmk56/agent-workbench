/**
 * Spec checks for the REA Phase 3 wake / listener status normalizers
 * (docs/rea/PHASE3_DESIGN.md §13).
 *
 * Run with: npm run test:chat
 *
 * The fixtures mirror the engine payloads shipped in 2cccea4:
 *  - `wake_status` in src/tools.js (agent_id / enabled / chats[] with
 *    enabled, wake_kinds, consecutive_failures, disabled_at, today_runs,
 *    last_event{id,seq,kind,status,created_at}),
 *  - `listener_status` in src/tools.js (agent_id / online / last_event_seq /
 *    checkin / sessions[]).
 *
 * The engine stores epoch milliseconds; the normalizer must turn them into ISO
 * strings without inventing a timestamp when the value is 0/null. A missing
 * `agent_id` must fail the payload rather than guess an identity, and rows
 * without an id must be dropped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canManageWake,
  formatWakeKinds,
  normalizeListenerStatus,
  normalizeWakeChat,
  normalizeWakeStatus,
  setWakeEnabled,
  wakeEventStatusLabel,
  wakeKindLabel,
  wakeStatusOnce,
  wakeToggleFailureText,
} from '../src/lib/wake.ts';

const wakePayload = {
  agent_id: 'agent_claude',
  participant_id: 'claude',
  enabled: true,
  chats: [
    {
      chat_id: 'chat-1',
      name: '四人小组',
      enabled: true,
      wake_kinds: ['mention', 'reply', 'owner_post'],
      consecutive_failures: 0,
      disabled_at: null,
      today_runs: 3,
      last_event: {
        id: 'wake-evt-1',
        seq: 12,
        kind: 'mention',
        status: 'delivered',
        created_at: 1763000000000,
      },
    },
    {
      chat_id: 'chat-2',
      name: '维护群',
      enabled: false,
      wake_kinds: ['mention'],
      consecutive_failures: 3,
      disabled_at: 1763003600000,
      today_runs: 0,
      last_event: null,
    },
  ],
};

const listenerPayload = {
  agent_id: 'agent_dsh',
  participant_id: 'dsh',
  online: true,
  last_event_seq: 42,
  checkin: {
    every_minutes: 10,
    last_checkin_at: 1763000000000,
    consecutive_empty: 2,
  },
  sessions: [
    {
      id: 'session-1',
      chat_id: null,
      status: 'connected',
      last_event_seq: 42,
      connected_at: 1762999000000,
      last_seen_at: 1763000000000,
    },
  ],
};

test('wake normalizer keeps the engine rows and converts ms to ISO', () => {
  const status = normalizeWakeStatus(wakePayload);
  assert.ok(status != null);
  assert.equal(status.agent_id, 'agent_claude');
  assert.equal(status.participant_id, 'claude');
  assert.equal(status.enabled, true);
  assert.equal(status.chats.length, 2);

  const first = status.chats[0];
  assert.equal(first.chat_id, 'chat-1');
  assert.equal(first.name, '四人小组');
  assert.equal(first.enabled, true);
  assert.deepEqual(first.wake_kinds, ['mention', 'reply', 'owner_post']);
  assert.equal(first.today_runs, 3);
  assert.equal(first.consecutive_failures, 0);
  assert.equal(first.disabled_at, null);
  assert.ok(first.last_event != null);
  assert.equal(first.last_event.kind, 'mention');
  assert.equal(first.last_event.status, 'delivered');
  assert.equal(first.last_event.seq, 12);
  assert.equal(first.last_event.created_at, new Date(1763000000000).toISOString());

  const second = status.chats[1];
  assert.equal(second.enabled, false);
  assert.equal(second.consecutive_failures, 3);
  assert.equal(second.disabled_at, new Date(1763003600000).toISOString());
  assert.equal(second.last_event, null);
});

test('wake status without an agent id is rejected rather than guessed', () => {
  assert.equal(normalizeWakeStatus({ enabled: true, chats: [] }), null);
  assert.equal(normalizeWakeStatus(null), null);
});

test('wake chat row without a chat id is dropped', () => {
  assert.equal(normalizeWakeChat({ name: '无 id 的群', enabled: true }), null);
  const status = normalizeWakeStatus({
    agent_id: 'agent_muse',
    chats: [{ name: 'orphan', enabled: true }, wakePayload.chats[0]],
  });
  assert.ok(status != null);
  assert.equal(status.chats.length, 1);
  assert.equal(status.chats[0].chat_id, 'chat-1');
});

test('a missing enabled flag never claims wake is on', () => {
  const row = normalizeWakeChat({ chat_id: 'chat-9', name: '未配置' });
  assert.ok(row != null);
  assert.equal(row.enabled, false);
  assert.equal(row.today_runs, 0);
  assert.equal(row.consecutive_failures, 0);
  assert.deepEqual(row.wake_kinds, []);
  assert.equal(row.last_event, null);
});

test('a wake event without an id is not rendered as an event', () => {
  const row = normalizeWakeChat({
    chat_id: 'chat-9',
    last_event: { seq: 1, kind: 'reply', status: 'merged', created_at: 0 },
  });
  assert.ok(row != null);
  assert.equal(row.last_event, null);
});

test('a zero timestamp stays null instead of 1970', () => {
  const row = normalizeWakeChat({ chat_id: 'chat-9', disabled_at: 0 });
  assert.ok(row != null);
  assert.equal(row.disabled_at, null);
});

test('listener normalizer mirrors listener_status', () => {
  const status = normalizeListenerStatus(listenerPayload);
  assert.ok(status != null);
  assert.equal(status.agent_id, 'agent_dsh');
  assert.equal(status.online, true);
  assert.equal(status.last_event_seq, 42);
  assert.ok(status.checkin != null);
  assert.equal(status.checkin.every_minutes, 10);
  assert.equal(status.checkin.consecutive_empty, 2);
  assert.equal(status.checkin.last_checkin_at, new Date(1763000000000).toISOString());
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].id, 'session-1');
  assert.equal(status.sessions[0].status, 'connected');
  assert.equal(status.sessions[0].connected_at, new Date(1762999000000).toISOString());
});

test('listener status without a check-in keeps it null', () => {
  const status = normalizeListenerStatus({
    agent_id: 'agent_muse',
    online: false,
    last_event_seq: 0,
    checkin: null,
    sessions: [],
  });
  assert.ok(status != null);
  assert.equal(status.checkin, null);
  assert.equal(status.online, false);
  assert.equal(status.sessions.length, 0);
});

test('listener status rejects a missing agent id and drops id-less sessions', () => {
  assert.equal(normalizeListenerStatus({ online: true, sessions: [] }), null);
  const status = normalizeListenerStatus({
    agent_id: 'agent_muse',
    online: false,
    sessions: [{ status: 'connected' }, listenerPayload.sessions[0]],
  });
  assert.ok(status != null);
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].id, 'session-1');
});

test('wake switch is only offered for agents owned by this workstation', () => {
  assert.equal(canManageWake('user'), true);
  assert.equal(canManageWake('someone-else'), false);
  assert.equal(canManageWake(null), false);
  assert.equal(canManageWake(undefined), false);
});

test('wake labels fall back to the raw engine value', () => {
  assert.equal(wakeKindLabel('mention'), '提及');
  assert.equal(wakeKindLabel('unknown-kind'), 'unknown-kind');
  assert.equal(wakeEventStatusLabel('throttled'), '已节流');
  assert.equal(wakeEventStatusLabel('weird'), 'weird');
  assert.equal(formatWakeKinds(['mention', 'owner_post']), '提及、群主发言');
  assert.equal(formatWakeKinds([]), '');
});

test('manual wakes and cancelled runs have Chinese labels', () => {
  // `manual` is a wake *kind* written by the wake_now tool; `cancelled` is a
  // terminal *status* added with the queued-cancel fix (engine a3888a5).
  assert.equal(wakeKindLabel('manual'), '手动唤醒');
  assert.equal(wakeEventStatusLabel('cancelled'), '已取消');
  assert.equal(formatWakeKinds(['mention', 'manual']), '提及、手动唤醒');
});

test('a permission refusal is explained as owner-only without hiding the reason', () => {
  const refused = wakeToggleFailureText('wake_enable requires a human or master token');
  assert.match(refused, /仅群主/);
  assert.match(refused, /human or master token/);
  // Non-permission failures keep the engine's own text.
  assert.equal(wakeToggleFailureText('socket hang up'), 'socket hang up');
});

/* ------------------------------------------------------------------ *
 * IPC wiring: the renderer calls the bridge with camelCase args and the
 * engine tool names are selected by the switch direction.
 * ------------------------------------------------------------------ */

function withBridge<T>(workbench: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const scope = globalThis as unknown as { window?: { workbench?: unknown } };
  scope.window = { workbench };
  return run().finally(() => {
    delete scope.window;
  });
}

test('wakeStatusOnce asks for the displayed agent and normalizes the reply', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await withBridge(
    {
      wakeStatus: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { ok: true, data: wakePayload };
      },
    },
    () => wakeStatusOnce('claude'),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ agentId: 'claude' }]);
  assert.ok(result.ok);
  assert.equal(result.data.agent_id, 'agent_claude');
  assert.equal(result.data.chats.length, 2);
});

test('setWakeEnabled uses wake_enable on and wake_disable off', async () => {
  const calls: string[] = [];
  const workbench = {
    wakeEnable: async (input: { agentId: string; chatId: string }) => {
      calls.push(`enable:${input.agentId}:${input.chatId}`);
      return {
        ok: true,
        data: {
          agent_id: 'agent_claude',
          chat_id: 'chat-1',
          enabled: true,
          wake_kinds: ['mention'],
          consecutive_failures: 0,
          disabled_at: null,
        },
      };
    },
    wakeDisable: async (input: { agentId: string; chatId: string }) => {
      calls.push(`disable:${input.agentId}:${input.chatId}`);
      return {
        ok: true,
        data: {
          agent_id: 'agent_claude',
          chat_id: 'chat-1',
          enabled: false,
          wake_kinds: ['mention'],
          consecutive_failures: 0,
          disabled_at: 1763003600000,
        },
      };
    },
  };

  const enabled = await withBridge(workbench, () =>
    setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: true }),
  );
  const disabled = await withBridge(workbench, () =>
    setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: false }),
  );

  assert.equal(enabled.ok, true);
  assert.equal(disabled.ok, true);
  assert.deepEqual(calls, ['enable:claude:chat-1', 'disable:claude:chat-1']);
  assert.ok(disabled.ok);
  assert.equal(disabled.data.enabled, false);
  assert.equal(disabled.data.disabled_at, new Date(1763003600000).toISOString());
});

test('a refused switch surfaces the engine error instead of a fake toggle', async () => {
  const result = await withBridge(
    {
      wakeEnable: async () => ({ ok: false, error: 'wake_enable requires a human or master token' }),
    },
    () => setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: true }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /human or master token/);
});

test('setWakeEnabled accepts a reply for the requested handle or its canonical id', async () => {
  const toggle = (agentId: string) =>
    withBridge(
      {
        wakeEnable: async () => ({
          ok: true,
          data: {
            agent_id: agentId,
            chat_id: 'chat-1',
            enabled: true,
            wake_kinds: ['mention'],
            consecutive_failures: 0,
            disabled_at: null,
          },
        }),
      },
      () => setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: true }),
    );

  // The engine answers with `agent_claude`; a future engine that echoes the
  // participant handle must not be rejected either.
  assert.equal((await toggle('agent_claude')).ok, true);
  assert.equal((await toggle('claude')).ok, true);
});

test('setWakeEnabled rejects a reply for a different agent', async () => {
  const result = await withBridge(
    {
      wakeEnable: async () => ({
        ok: true,
        data: {
          agent_id: 'agent_dsh',
          chat_id: 'chat-1',
          enabled: true,
          wake_kinds: ['mention'],
          consecutive_failures: 0,
          disabled_at: null,
        },
      }),
    },
    () => setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: true }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /不一致/);
  assert.match(result.error, /agent_claude|claude/);
  assert.match(result.error, /agent_dsh/);
});

test('setWakeEnabled rejects a reply for a different chat', async () => {
  const result = await withBridge(
    {
      wakeDisable: async () => ({
        ok: true,
        data: {
          agent_id: 'agent_claude',
          chat_id: 'chat-2',
          enabled: false,
          wake_kinds: ['mention'],
          consecutive_failures: 0,
          disabled_at: 1763003600000,
        },
      }),
    },
    () => setWakeEnabled({ agentId: 'claude', chatId: 'chat-1', enabled: false }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /chat-1/);
  assert.match(result.error, /chat-2/);
});
