import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { buildMetrics } from '../src/executors/claude.js';
import { dshSessionIdFor } from '../src/executors/dsh.js';
import { classifyDeliveryError, retryDelayMs } from '../src/messages.js';
import {
  authClaude, authMuse, makeConfig, makeServices, seedChat, seedTask, StubScheduler, tempDir
} from './helpers.js';

// SQLite keeps its files open on Windows; close before removing the temp dir.
function cleanup(dir, ...stores) {
  for (const store of stores) {
    try { store?.close?.(); } catch { /* ignore */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir is disposable */ }
}

function failingScheduler(error) {
  return new (class extends StubScheduler {
    createTask() {
      throw error;
    }
  })();
}

function insertOriginMessage(store, {
  chatId, threadId = randomUUID(), status = 'delivered', delivery = null
}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  store.insertChatMessageBundle({
    id, thread_id: threadId, from_agent: 'muse', to_agent: 'claude', task_id: null,
    reply_to: null, summary: 'origin', files_json: '[]', status,
    created_at: now, updated_at: now, chat_id: chatId, body: 'origin', epoch: 0
  }, { deliveries: delivery ? [{ agent: 'claude', ...delivery, epoch: 0 }] : [] });
  return id;
}

// ------------------------------------------------------------------- schema
test('P1 schema: versioned migrations register 1-6 and are idempotent', () => {
  const dir = tempDir();
  try {
    const store = new Store(join(dir, 'workbench.db'), dir);
    // v6 is the Phase 3 wake/listener/check-in tables; P1 itself is v1-v4.
    assert.equal(store.schemaVersion(), 6);
    const messageColumns = store._columns('messages');
    for (const column of ['provider', 'model', 'token_usage_json', 'latency_ms']) {
      assert.ok(messageColumns.includes(column), `messages.${column} missing`);
    }
    const deliveryColumns = store._columns('chat_deliveries');
    for (const column of ['error_kind', 'next_attempt_at', 'dead_lettered_at']) {
      assert.ok(deliveryColumns.includes(column), `chat_deliveries.${column} missing`);
    }
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('executions','model_calls','schema_version')"
    ).all().map((row) => row.name).sort();
    assert.deepEqual(tables, ['executions', 'model_calls', 'schema_version']);
    store.close();

    // Re-opening runs every migration again; the ledger must not duplicate.
    const reopened = new Store(join(dir, 'workbench.db'), dir);
    assert.equal(Number(reopened.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n), 6);
    reopened.close();
  } finally {
    cleanup(dir);
  }
});

test('P1 migration upgrades a pre-P1 database without a fresh-schema shortcut', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'workbench.db');
    const legacy = new DatabaseSync(dbPath);
    // Minimal pre-P1 schema: chat_deliveries and messages exist WITHOUT the
    // retry/metric columns. Index creation must therefore wait for the
    // migration, not the constructor DDL.
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL, task_id TEXT, reply_to TEXT, summary TEXT NOT NULL,
        files_json TEXT, question TEXT, summary_tokens INTEGER NOT NULL DEFAULT 0,
        summary_truncated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        delivery_task_id TEXT, error TEXT, is_final INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_deliveries (
        message_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible',
        task_id TEXT, error TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, agent)
      );
      INSERT INTO messages
        (id, thread_id, from_agent, to_agent, summary, status, created_at, updated_at)
      VALUES ('m1', 't1', 'user', 'muse', 'old', 'stored', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    legacy.close();

    const store = new Store(dbPath, dir);
    assert.equal(store.schemaVersion(), 6);
    assert.ok(store._columns('chat_deliveries').includes('next_attempt_at'));
    assert.ok(store._columns('messages').includes('token_usage_json'));
    const indexes = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chat_deliveries_retry'"
    ).all();
    assert.equal(indexes.length, 1, 'retry index must exist after migration');
    assert.equal(store.getMessage('m1').summary, 'old', 'existing rows survive the migration');
    store.close();
  } finally {
    cleanup(dir);
  }
});

// -------------------------------------------------------- P1-5 executions
test('P1-5 an agent message carries provider/model/usage from its execution', () => {
  const dir = tempDir();
  try {
    const { store, messages } = makeServices(dir, { config: { agentAutoDeliver: false } });
    const chatId = seedChat(store);
    const task = seedTask(store, { agent: 'claude', chatId });
    store.insertExecution({
      execution_id: task.id,
      task_id: task.id,
      agent: 'claude',
      provider: 'gateway',
      model: 'deepseek-v4.1-flash',
      token_usage_json: JSON.stringify({
        input: 10, output: 20, cache_read: 30, cache_creation: 0
      }),
      cost_usd: 0.0123,
      latency_ms: 1234,
      session_id: task.session_id,
      usage_source: 'stream'
    });

    const message = messages.send({
      auth: authClaude, from: 'claude', to: 'muse', chat_id: chatId,
      task_id: task.id, body: 'the conclusion'
    });
    assert.equal(message.provider, 'gateway');
    assert.equal(message.model, 'deepseek-v4.1-flash');
    assert.deepEqual(message.token_usage, { input: 10, output: 20, cache_read: 30, cache_creation: 0 });
    assert.equal(message.latency_ms, 1234);

    // A later execution update fills only the gaps, never overwrites.
    store.backfillMessageMetrics(task.id, { tokenUsageJson: JSON.stringify({ input: 999 }), latencyMs: 9999 });
    const row = store.getMessage(message.message_id);
    assert.equal(JSON.parse(row.token_usage_json).input, 10);
    assert.equal(row.latency_ms, 1234);

    const execution = store.getExecutionForTask(task.id);
    assert.equal(execution.cost_usd, 0.0123);
    assert.equal(store.listModelCalls({ taskId: task.id }).length, 0, 'no model call row without a result event');
  } finally {
    cleanup(dir);
  }
});

test('P1-5 Claude stream-json result is parsed without inventing numbers', () => {
  const metrics = buildMetrics({
    type: 'result',
    is_error: false,
    result: 'done',
    uuid: 'result-uuid',
    session_id: 'session-1',
    total_cost_usd: 0.0163,
    duration_ms: 1242,
    duration_api_ms: 1142,
    ttft_ms: 1207,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      'deepseek-v4.1-flash': {
        inputTokens: 662, outputTokens: 9,
        cacheReadInputTokens: 25600, cacheCreationInputTokens: 0,
        provider: 'firstParty'
      }
    }
  }, 'done');
  assert.equal(metrics.model, 'deepseek-v4.1-flash');
  assert.equal(metrics.provider, 'firstParty');
  assert.equal(metrics.provider_request_id, 'result-uuid');
  assert.deepEqual(metrics.token_usage, {
    input: 662, output: 9, cache_read: 25600, cache_creation: 0
  });
  assert.equal(metrics.cost_usd, 0.0163);
  assert.equal(metrics.latency_ms, 1142);
  assert.equal(metrics.ttft_ms, 1207);
  assert.equal(metrics.usage_source, 'stream');

  const bare = buildMetrics({ type: 'result', result: 'x' }, 'x');
  assert.equal(bare.token_usage, null);
  assert.equal(bare.cost_usd, null);
  assert.equal(bare.usage_source, 'unknown');
});

test('P1-5 dsh session directory id is resolved from the workspace layout', () => {
  const home = tempDir('dsh-home-');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const escaped = '--C-Claude-agent-workbench-workspace--';
    const session = join(home, 'sessions', escaped, 'session-abc-123');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'session.jsonl.zstd'), 'x');
    assert.equal(dshSessionIdFor('C:\\Claude\\agent-workbench\\workspace', Date.now()), 'abc-123');
    assert.equal(dshSessionIdFor('C:\\somewhere\\else', Date.now()), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- P1-2 retry
test('P1-2 transient failure schedules a backoff retry, then dead-letters', () => {
  const dir = tempDir();
  try {
    const scheduler = failingScheduler(new Error('socket hang up'));
    const { store, messages } = makeServices(dir, {
      scheduler,
      config: {
        agentAutoDeliver: true, deliveryMaxAttempts: 2,
        deliveryRetryBaseMs: 1000, deliveryRetryMaxMs: 1000
      }
    });
    const chatId = seedChat(store);
    const result = messages.send({
      auth: authMuse, from: 'muse', to: 'claude', chat_id: chatId,
      body: 'please act', act_recipients: ['claude'], client_msg_id: 'retry-1'
    });

    let delivery = store.getDelivery(result.message_id, 'claude');
    assert.equal(delivery.status, 'retry');
    assert.equal(delivery.error_kind, 'transient');
    assert.ok(delivery.next_attempt_at, 'retry must carry a next_attempt_at');
    assert.equal(store.getMessage(result.message_id).status, 'queued');
    assert.equal(store.listDeliveryAttempts(result.message_id, 'claude').length, 2, 'pending + retry attempts');

    // Not due yet: the sweep must respect the backoff window.
    const early = messages.attemptChatDelivery(result.message_id, 'claude');
    assert.equal(early.status, 'retry_wait');

    store.updateDelivery(result.message_id, 'claude', {
      next_attempt_at: new Date(Date.now() - 1000).toISOString()
    });
    messages.attemptChatDelivery(result.message_id, 'claude');
    delivery = store.getDelivery(result.message_id, 'claude');
    assert.equal(delivery.status, 'dead_letter');
    assert.ok(delivery.dead_lettered_at);
    assert.equal(store.getMessage(result.message_id).status, 'failed');

    const statuses = store.listDeliveryAttempts(result.message_id, 'claude').map((row) => row.status);
    assert.deepEqual(statuses, ['pending', 'retry', 'dead_letter'], 'attempt history is append-only');
  } finally {
    cleanup(dir);
  }
});

test('P1-2 permanent failure goes straight to dead-letter', () => {
  const dir = tempDir();
  try {
    const scheduler = failingScheduler(new Error('cwd does not exist or is not a directory: X'));
    const { store, messages } = makeServices(dir, {
      scheduler, config: { agentAutoDeliver: true, deliveryMaxAttempts: 3 }
    });
    const chatId = seedChat(store);
    const result = messages.send({
      auth: authMuse, from: 'muse', to: 'claude', chat_id: chatId,
      body: 'go', act_recipients: ['claude'], client_msg_id: 'perm-1'
    });
    const delivery = store.getDelivery(result.message_id, 'claude');
    assert.equal(delivery.status, 'dead_letter');
    assert.equal(delivery.error_kind, 'permanent');
    assert.equal(store.getMessage(result.message_id).status, 'failed');
    assert.equal(classifyDeliveryError(new Error('SQLITE_BUSY: database is locked')), 'transient');
    assert.equal(classifyDeliveryError(new Error('session not found: x')), 'permanent');
    assert.equal(retryDelayMs(1, { deliveryRetryBaseMs: 2000, deliveryRetryMaxMs: 60000 }), 2000);
    assert.equal(retryDelayMs(3, { deliveryRetryBaseMs: 2000, deliveryRetryMaxMs: 60000 }), 8000);
    assert.equal(retryDelayMs(10, { deliveryRetryBaseMs: 2000, deliveryRetryMaxMs: 60000 }), 60000);
  } finally {
    cleanup(dir);
  }
});

test('P1-2 message status aggregates deliveries instead of last-writer-wins', () => {
  const dir = tempDir();
  try {
    const { store, messages } = makeServices(dir, { config: { agentAutoDeliver: false } });
    const chatId = seedChat(store);
    const now = new Date().toISOString();
    const messageId = randomUUID();
    store.insertChatMessageBundle({
      id: messageId, thread_id: `chat:${chatId}`, from_agent: 'muse', to_agent: 'claude',
      task_id: null, reply_to: null, summary: 'x', files_json: '[]', status: 'stored',
      created_at: now, updated_at: now, chat_id: chatId, body: 'x', epoch: 0
    }, {
      deliveries: [
        { agent: 'claude', status: 'delivered', epoch: 0 },
        { agent: 'dsh', status: 'queued', epoch: 0 }
      ]
    });
    assert.equal(messages.aggregateMessageStatus(messageId), 'delivered');
    store.updateDelivery(messageId, 'claude', { status: 'queued' });
    assert.equal(messages.aggregateMessageStatus(messageId), 'queued');
    store.updateDelivery(messageId, 'claude', { status: 'dead_letter' });
    store.updateDelivery(messageId, 'dsh', { status: 'dead_letter' });
    assert.equal(messages.aggregateMessageStatus(messageId), 'failed');
  } finally {
    cleanup(dir);
  }
});

// --------------------------------------------------------- P1-1 reconcile
test('P1-1 reconcile fails in-flight tasks, origin messages and deliveries, then replays', () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { deliverySweepMs: 60000 });
    const store = new Store(join(dir, 'workbench.db'), dir);
    const chatId = seedChat(store);
    const task = seedTask(store, { agent: 'claude', chatId, state: 'WORKING' });
    const threadId = `chat:${chatId}`;
    const originId = insertOriginMessage(store, {
      chatId, threadId, status: 'delivered', delivery: { status: 'delivered', task_id: task.id }
    });
    store.setTaskThread(task.id, threadId, originId);

    const scheduler = new Scheduler(store, config);
    let replayCalls = 0;
    scheduler.messages = {
      replayPendingDeliveries() { replayCalls += 1; return { legacy: 1, chat: 2 }; },
      sweepDeliveries() {}
    };
    const summary = scheduler.reconcile({ reason: 'test restart' });

    assert.deepEqual(summary.failed_tasks, [task.id]);
    assert.equal(summary.replayed.legacy, 1);
    assert.equal(summary.replayed.chat, 2);
    assert.equal(replayCalls, 1);
    assert.equal(summary.sweep_interval_ms, 60000);
    const failedTask = store.getTask(task.id);
    assert.equal(failedTask.state, 'FAILED');
    assert.equal(failedTask.blocker, 'tooling');
    assert.equal(store.getMessage(originId).status, 'failed');
    assert.match(store.getMessage(originId).error, /did not finish: test restart/);

    const delivery = store.getDelivery(originId, 'claude');
    assert.equal(delivery?.status, 'failed');
    assert.equal(delivery?.error_kind, 'task_failed');

    // shutdown reconciles too: a queued task cannot survive the process.
    const queued = seedTask(store, { agent: 'dsh', state: 'WORKING' });
    scheduler.queue.push(queued.id);
    const shutdown = scheduler.shutdown({ reason: 'test shutdown' });
    assert.ok(shutdown.failed_tasks.includes(queued.id));
    assert.equal(store.getTask(queued.id).state, 'FAILED');
    store.close();
  } finally {
    cleanup(dir);
  }
});

test('P1-1 replayPendingDeliveries only touches actionable rows', () => {
  const dir = tempDir();
  try {
    const { store, messages } = makeServices(dir, { config: { agentAutoDeliver: false } });
    const chatId = seedChat(store);
    const now = new Date().toISOString();
    const messageId = randomUUID();
    store.insertChatMessageBundle({
      id: messageId, thread_id: `chat:${chatId}`, from_agent: 'muse', to_agent: 'claude',
      task_id: null, reply_to: null, summary: 'x', files_json: '[]', status: 'stored',
      created_at: now, updated_at: now, chat_id: chatId, body: 'x', epoch: 0
    }, {
      deliveries: [
        { agent: 'claude', status: 'pending', epoch: 0 },
        { agent: 'dsh', status: 'delivered', epoch: 0 }
      ]
    });
    const result = messages.replayPendingDeliveries({ reason: 'test' });
    assert.equal(result.chat, 1);
    // auto-delivery is off, so the pending row becomes skipped, not delivered.
    assert.equal(store.getDelivery(messageId, 'claude').status, 'skipped');
    assert.equal(store.getDelivery(messageId, 'dsh').status, 'delivered');
  } finally {
    cleanup(dir);
  }
});