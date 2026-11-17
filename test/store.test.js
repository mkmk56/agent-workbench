import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { authMuse, tempDir, makeServices, seedTask } from './helpers.js';
import { Store } from '../src/store.js';

function createLegacyChatDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT,
      prompt TEXT, state TEXT NOT NULL, process_state TEXT NOT NULL, turn_state TEXT NOT NULL,
      blocker TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT,
      exit_code INTEGER, pid INTEGER, tokens_json TEXT, files_modified_json TEXT, summary TEXT,
      timeout_ms INTEGER, stale_after_ms INTEGER, resume INTEGER DEFAULT 0, model TEXT
    );
    CREATE TABLE chat_tasks (
      chat_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT,
      PRIMARY KEY (chat_id, task_id)
    );
    CREATE TABLE chats (
      chat_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT,
      status TEXT DEFAULT 'active', last_message_at TEXT, last_message_preview TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      task_id TEXT, reply_to TEXT, summary TEXT NOT NULL, files_json TEXT, question TEXT,
      summary_tokens INTEGER NOT NULL DEFAULT 0, summary_truncated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, delivery_task_id TEXT, error TEXT, is_final INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, chat_id TEXT
    );
    CREATE UNIQUE INDEX idx_messages_reply_unique ON messages(reply_to) WHERE reply_to IS NOT NULL;
    CREATE TABLE approval_grants (
      thread_id TEXT NOT NULL, category TEXT NOT NULL, source_approval_id TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (thread_id, category)
    );
    INSERT INTO chats (chat_id, name, created_at, updated_at)
      VALUES ('legacy-chat', 'Legacy', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    INSERT INTO messages (id, thread_id, from_agent, to_agent, task_id, summary, status, created_at, updated_at, chat_id)
      VALUES
        ('m1', 'chat:legacy-chat', 'user', 'muse', NULL, 'hello', 'stored', '2026-11-01T00:00:01.000Z', '2026-11-01T00:00:01.000Z', 'legacy-chat'),
        ('m2', 'chat:legacy-chat', 'muse', 'user', NULL, 'hi', 'stored', '2026-11-01T00:00:02.000Z', '2026-11-01T00:00:02.000Z', 'legacy-chat'),
        ('m3', 't1', 'claude', 'muse', 't1', 'outside', 'stored', '2026-11-01T00:00:03.000Z', '2026-11-01T00:00:03.000Z', NULL);
    INSERT INTO approval_grants (thread_id, category, source_approval_id, created_at)
      VALUES ('thread-1', 'merge', 'a1', '2026-11-01T00:00:00.000Z');
  `);
  db.close();
}

test('legacy chat database migrates without data loss', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'legacy.db');
  createLegacyChatDb(dbPath);
  const store = new Store(dbPath, dir);
  try {
    const columns = store.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    for (const column of [
      'seq', 'body', 'mentions_json', 'root_message_id', 'depth', 'epoch', 'client_msg_id', 'context_version'
    ]) {
      assert.ok(columns.includes(column), `missing messages.${column}`);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
    const indexes = store.db.prepare('PRAGMA index_list(messages)').all().map((row) => row.name);
    assert.ok(!indexes.includes('idx_messages_reply_unique'), 'old reply uniqueness index must be dropped');
    const m1 = store.getMessage('m1');
    const m2 = store.getMessage('m2');
    assert.equal(m1.body, 'hello');
    assert.equal(Number(m1.seq), 1);
    assert.equal(Number(m2.seq), 2);
    assert.equal(Number(store.getChat('legacy-chat').epoch), 0);
    assert.ok(store.isChatParticipant('legacy-chat', 'user'));
    assert.ok(store.isChatParticipant('legacy-chat', 'muse'));
    const grant = store.getApprovalGrant('thread:thread-1', '', 'merge');
    assert.equal(grant.source_approval_id, 'a1');

    // The dropped unique index means two replies may now point at the same
    // message, which broadcast requires.
    const now = new Date().toISOString();
    for (const id of ['r1', 'r2']) {
      store.insertMessage({
        id, thread_id: 'chat:legacy-chat', from_agent: 'claude', to_agent: 'muse', task_id: null,
        reply_to: 'm1', summary: id, body: id, status: 'stored', created_at: now, updated_at: now,
        chat_id: 'legacy-chat'
      });
    }
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE reply_to='m1'").get().n, 2);
  } finally {
    store.close();
  }
});

test('seq is per-chat monotonic and client_msg_id is idempotent without bumping epoch', () => {
  const dir = tempDir();
  const { store, chats, config } = makeServices(dir);
  try {
    const chatA = chats.create({ name: 'A' });
    const chatB = chats.create({ name: 'B' });
    const a1 = chats.send({ chat_id: chatA.chat_id, from: 'user', to: 'muse', body: 'one', client_msg_id: 'k1' });
    const a2 = chats.send({ chat_id: chatA.chat_id, from: 'user', to: 'muse', body: 'two' });
    const b1 = chats.send({ chat_id: chatB.chat_id, from: 'user', to: 'muse', body: 'other' });
    assert.deepEqual([a1.seq, a2.seq, b1.seq], [1, 2, 1]);
    assert.deepEqual([a1.epoch, a2.epoch, b1.epoch], [1, 2, 1]);
    const repeated = chats.send({
      chat_id: chatA.chat_id, from: 'user', to: 'muse', body: 'one retry', client_msg_id: 'k1'
    });
    assert.equal(repeated.message_id, a1.message_id);
    assert.equal(repeated.deduplicated, true);
    assert.equal(store.chatEpoch(chatA.chat_id), 2, 'a duplicate retry must not bump the epoch');
    assert.equal(store.listChatMessages({ chatId: chatA.chat_id }).length, 2);
    assert.equal(config.agentAutoDeliver, false);
  } finally {
    store.close();
  }
});

test('message + deliveries write atomically', () => {
  const dir = tempDir();
  const { store } = makeServices(dir);
  try {
    store.insertChat({ chat_id: 'c1', name: 'C' });
    const now = new Date().toISOString();
    const base = {
      id: 'm-atomic', thread_id: 'chat:c1', from_agent: 'user', to_agent: 'muse', task_id: null,
      reply_to: null, summary: 'x', files_json: '[]', status: 'stored', created_at: now, updated_at: now,
      chat_id: 'c1', body: 'x', epoch: 1
    };
    const row = store.insertChatMessageBundle(base, {
      deliveries: [
        { agent: 'muse', status: 'visible', epoch: 1 },
        { agent: 'claude', status: 'pending', epoch: 1 }
      ]
    });
    assert.equal(Number(row.seq), 1);
    assert.equal(store.listMessageDeliveries('m-atomic').length, 2);
    assert.equal(store.getDelivery('m-atomic', 'claude').status, 'pending');

    assert.throws(() => store.insertChatMessageBundle({ ...base, id: 'm-rollback' }, {
      deliveries: [{ agent: null, status: 'visible', epoch: 1 }]
    }));
    assert.equal(store.getMessage('m-rollback'), null, 'failed delivery insert must roll back the message');
  } finally {
    store.close();
  }
});

test('agent identity and task ownership are enforced', () => {
  const dir = tempDir();
  const { store, messages } = makeServices(dir);
  try {
    store.insertChat({ chat_id: 'c1', name: 'C' });
    store.upsertChatParticipant({ chat_id: 'c1', participant_id: 'claude', kind: 'agent', role: 'claude' });
    seedTask(store, { id: 'task-claude', agent: 'claude', chatId: 'c1', cwd: dir });

    assert.throws(
      () => messages.send({ from: 'claude', to: 'muse', chat_id: 'c1', body: 'no task' }),
      /require an owned task_id|must include the task_id/i
    );
    assert.throws(
      () => messages.send({
        from: 'muse', to: 'claude', chat_id: 'c1', body: 'impersonate', task_id: 'task-claude'
      }),
      /belongs to claude|not muse/i
    );
    const ok = messages.send({
      from: 'claude', to: 'muse', chat_id: 'c1', task_id: 'task-claude', body: 'my conclusion'
    });
    assert.equal(ok.from, 'claude');
    assert.equal(ok.task_id, 'task-claude');
  } finally {
    store.close();
  }
});

test('stale epoch dispatches are rejected', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'E' });
    chats.send({ chat_id: chat.chat_id, from: 'user', to: 'muse', body: 'first' });
    assert.throws(() => chats.send({
      chat_id: chat.chat_id,
      from: 'muse',
      to: 'claude',
      body: 'stale dispatch',
      act_recipients: ['claude'],
      epoch: 0,
      client_msg_id: 'store-stale-1',
      auth: authMuse
    }), /epoch mismatch/i);
    assert.equal(store.listMessages({ chatId: chat.chat_id }).length, 1);
  } finally {
    store.close();
  }
});