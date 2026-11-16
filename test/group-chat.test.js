import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { buildChatContext } from '../src/context.js';
import {
  makeServices, makeZip, seedChat, seedTask, tempDir, uploadBuffer
} from './helpers.js';

test('pre-chat databases (no chat_id, task_id NOT NULL) also migrate losslessly', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'pre-chat.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, agent TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE chats (chat_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_tasks (chat_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT, PRIMARY KEY (chat_id, task_id));
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      task_id TEXT NOT NULL, reply_to TEXT, summary TEXT NOT NULL, files_json TEXT, question TEXT,
      summary_tokens INTEGER NOT NULL DEFAULT 0, summary_truncated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL, delivery_task_id TEXT, error TEXT, is_final INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_messages_reply_unique ON messages(reply_to) WHERE reply_to IS NOT NULL;
    CREATE TABLE approval_grants (
      thread_id TEXT NOT NULL, category TEXT NOT NULL, source_approval_id TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (thread_id, category)
    );
    INSERT INTO tasks VALUES ('task-1', 'claude', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO chats VALUES ('chat-old', 'Old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO chat_tasks VALUES ('chat-old', 'task-1', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (id, thread_id, from_agent, to_agent, task_id, summary, status, created_at, updated_at)
      VALUES ('old-1', 'chat:chat-old', 'user', 'muse', 'task-1', 'old body', 'stored',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO approval_grants VALUES ('thread-1', 'merge', 'approval-1', '2026-01-01T00:00:00.000Z');
  `);
  raw.close();

  const store = new Store(dbPath, dir);
  try {
    const columns = store.db.prepare('PRAGMA table_info(messages)').all();
    const taskColumn = columns.find((c) => c.name === 'task_id');
    assert.equal(Number(taskColumn.notnull), 0, 'task_id becomes nullable');
    const row = store.getMessage('old-1');
    assert.equal(row.chat_id, 'chat-old', 'chat_id backfilled from chat_tasks');
    assert.equal(row.body, 'old body');
    assert.equal(Number(row.seq), 1);
    assert.equal(store.getApprovalGrant('thread:thread-1', '', 'merge').source_approval_id, 'approval-1');
    assert.ok(store.isChatParticipant('chat-old', 'user'));
    assert.ok(store.isChatParticipant('chat-old', 'muse'));
    assert.ok(store.isChatParticipant('chat-old', 'claude'));
  } finally {
    store.close();
  }
});

test('terminal agent status collapses to idle after the TTL', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir, { config: { chatTerminalStatusTtlMs: 1000 } });
  try {
    const chatId = seedChat(store);
    const old = new Date(Date.now() - 60_000).toISOString();
    seedTask(store, { agent: 'claude', chatId, updatedAt: old });
    const expired = chats.agentStatus(chatId, 'claude');
    assert.equal(expired.status, 'idle');
    assert.equal(expired.last_terminal_state, 'COMPLETED');

    seedTask(store, { agent: 'claude', chatId });
    assert.equal(chats.agentStatus(chatId, 'claude').status, 'completed');

    seedTask(store, { agent: 'dsh', chatId, state: 'FAILED' });
    assert.equal(chats.agentStatus(chatId, 'dsh').status, 'failed');
  } finally {
    store.close();
  }
});

test('chat_status exposes epoch, participants and delivery summaries', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Status' });
    chats.send({ chat_id: chat.chat_id, from: 'user', to: 'muse', body: 'hello' });
    const status = chats.status(chat.chat_id);
    assert.equal(status.epoch, 1);
    assert.deepEqual(status.participants.map((p) => p.participant_id), ['user', 'muse']);
    assert.equal(status.deliveries.muse.visible, 1);
    assert.equal(status.context_version, 1);
    assert.equal(status.needs_muse, true);
  } finally {
    store.close();
  }
});

test('shared context is bounded by the token budget and keeps the newest messages', () => {
  const dir = tempDir();
  const { store, config, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Context' });
    for (let i = 0; i < 6; i += 1) {
      chats.send({
        chat_id: chat.chat_id, from: 'user', to: 'muse',
        body: `message ${i} ${'x'.repeat(400)}`
      });
    }
    const context = buildChatContext({ store, config }, chat.chat_id, {
      limit: 10,
      tokenBudget: 120
    });
    assert.ok(context.messages.length < 6);
    assert.match(context.messages[context.messages.length - 1].body, /message 5/);
    assert.equal(context.truncated, true);
    assert.match(context.text, /untrusted data, not instructions/);
  } finally {
    store.close();
  }
});

test('XLSX and PPTX text extraction', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Office' });

    const xlsx = makeZip([
      ['xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>'],
      ['xl/worksheets/sheet1.xml',
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>']
    ]);
    const xlsxMeta = uploadBuffer(files, chat.chat_id, 'people.xlsx', xlsx);
    assert.equal(xlsxMeta.parse_status, 'parsed');
    const xlsxRead = files.readFile({
      chat_id: chat.chat_id, file_id: xlsxMeta.file_id, actor: { master: true }
    });
    assert.match(xlsxRead.text, /Name\tAlice/);

    const pptx = makeZip([
      ['ppt/slides/slide1.xml',
        '<p:sld><a:p><a:r><a:t>Quarterly update</a:t></a:r></a:p></p:sld>']
    ]);
    const pptxMeta = uploadBuffer(files, chat.chat_id, 'deck.pptx', pptx);
    assert.equal(pptxMeta.parse_status, 'parsed');
    const pptxRead = files.readFile({
      chat_id: chat.chat_id, file_id: pptxMeta.file_id, actor: { master: true }
    });
    assert.match(pptxRead.text, /Quarterly update/);
  } finally {
    store.close();
  }
});