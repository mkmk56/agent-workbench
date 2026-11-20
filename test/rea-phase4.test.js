import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { WakeService } from '../src/wake.js';
import { registerTools } from '../src/tools.js';
import { agentIdForParticipant } from '../src/agents.js';
import { Scheduler } from '../src/scheduler.js';
import { runMigration } from '../scripts/migrate-rea-phase4.mjs';
import {
  authClaude, authMaster, makeConfig, makeServices, seedChat, seedTask, tempDir, uploadBuffer
} from './helpers.js';

function makeHarness(configOverrides = {}) {
  const dir = tempDir('rea4-');
  const services = makeServices(dir, {
    config: { agentAutoDeliver: true, wakeMinIntervalMs: 0, ...configOverrides }
  });
  const clock = { now: Date.now() };
  const wake = new WakeService({
    store: services.store,
    scheduler: services.scheduler,
    config: services.config,
    agents: services.agents,
    messages: services.messages,
    now: () => clock.now
  });
  services.scheduler.wake = wake;
  return { ...services, wake, clock, dir };
}

function addAgent(store, chatId, agent) {
  store.upsertChatParticipant({
    chat_id: chatId, participant_id: agent, kind: 'agent', role: agent, display_name: agent
  });
  store.insertChatMember({
    chat_id: chatId, agent_id: agentIdForParticipant(agent), role: 'member'
  });
  store.ensureInboxCursor({ chatId, agentId: agentIdForParticipant(agent), now: Date.now() });
}

function makeToolRunner(services, auth) {
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, handler) { handlers.set(name, handler); }
  };
  registerTools(server, {
    scheduler: services.scheduler,
    store: services.store,
    messages: services.messages,
    approvals: {},
    chats: services.chats,
    files: services.files,
    config: services.config,
    agents: services.agents,
    wake: services.wake
  }, auth);
  return {
    invoke(name, args) {
      const handler = handlers.get(name);
      assert.ok(handler, `tool ${name} is registered`);
      return handler(args);
    }
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function cleanupDir(dir, store) {
  try { store?.close?.(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
}

// ---------------------------------------------------------------------------
// Migration v6 -> v7
// ---------------------------------------------------------------------------
test('Phase 4 migration adds kind/settings with a backup, preserves data and is rerunnable', () => {
  const dir = tempDir('rea4-mig-');
  let store = null;
  try {
    const dbPath = join(dir, 'workbench.db');
    store = new Store(dbPath, dir);
    assert.equal(store.schemaVersion(), 7);
    const chatId = seedChat(store, { id: 'chat-mig' });
    const now = new Date().toISOString();
    store.insertChatMessageBundle({
      id: 'msg-mig', thread_id: `chat:${chatId}`, from_agent: 'user', to_agent: 'muse',
      summary: 'old row', body: 'old row', status: 'stored', chat_id: chatId,
      mentions_json: '[]', created_at: now, updated_at: now
    });
    store.close();
    store = null;

    // Roll the schema back to a real v6 shape: the two new columns and the v7
    // ledger row are gone, the data stays.
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('ALTER TABLE messages DROP COLUMN kind');
      raw.exec('ALTER TABLE chats DROP COLUMN settings');
      raw.prepare('DELETE FROM schema_version WHERE version = 7').run();
      assert.equal(Number(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v), 6);
    } finally {
      raw.close();
    }

    const backupDir = join(dir, 'backups');
    const first = runMigration({ dbPath, dataDir: dir, backupDir });
    assert.equal(first.schema_version, 7);
    assert.ok(existsSync(first.backup_path), 'a pre-migration snapshot exists');
    assert.match(first.backup_path, /\.pre-rea-phase4-/);
    assert.deepEqual(first.columns, { messages: ['kind'], chats: ['settings'] });
    assert.equal(first.counts.messages, 1);
    assert.equal(first.counts.chats, 1);

    store = new Store(dbPath, dir);
    // Historical rows keep their content and default to kind=user.
    assert.equal(store.getMessage('msg-mig').kind, 'user');
    assert.equal(store.getChat(chatId).settings, null);
    store.close();
    store = null;

    // Re-running must not touch data and must not add a second ledger row.
    const second = runMigration({ dbPath, dataDir: dir, backupDir, backup: false });
    assert.equal(second.schema_version, 7);
    assert.equal(second.counts.messages, 1);
    assert.equal(second.counts.chats, 1);
    store = new Store(dbPath, dir);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 7').get().n, 1);
    assert.equal(store.getMessage('msg-mig').body, 'old row');
  } finally {
    cleanupDir(dir, store);
  }
});

// ---------------------------------------------------------------------------
// Message kind and chat settings
// ---------------------------------------------------------------------------
test('message kind defaults to user, system is writable internally and both are exposed', () => {
  const dir = tempDir('rea4-kind-');
  const { store, chats, messages } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Kind' });
    const normal = chats.send({ chat_id: chat.chat_id, from: 'user', to: 'muse', body: 'hello' });
    assert.equal(normal.kind, 'user');

    const system = messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chat.chat_id,
      body: 'internal notice', kind: 'system', client_msg_id: 'sys-1'
    });
    assert.equal(system.kind, 'system');
    assert.throws(() => messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chat.chat_id,
      body: 'bad kind', kind: 'robot'
    }), /kind must be 'user' or 'system'/);

    const listed = chats.listMessages({ chat_id: chat.chat_id });
    assert.deepEqual(listed.messages.map((message) => message.kind), ['user', 'system']);
    assert.equal(store.getMessage(normal.message_id).kind, 'user');
  } finally {
    cleanupDir(dir, store);
  }
});

test('chat settings are stored as JSON, round-trip, and malformed JSON reads as an empty object', () => {
  const dir = tempDir('rea4-settings-');
  const { store, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Settings' });
    assert.deepEqual(chat.settings, {});

    const updated = chats.updateSettings({
      chat_id: chat.chat_id, description: 'what this group is for', announcement: 'standup at 10'
    });
    assert.deepEqual(updated.settings, {
      description: 'what this group is for', announcement: 'standup at 10'
    });
    const reread = chats.describe(store.getChat(chat.chat_id));
    assert.deepEqual(reread.settings, updated.settings);

    // null clears one field without losing the other.
    const cleared = chats.updateSettings({ chat_id: chat.chat_id, description: null });
    assert.deepEqual(cleared.settings, { description: null, announcement: 'standup at 10' });
    assert.throws(() => chats.updateSettings({ chat_id: chat.chat_id }), /description or announcement/);

    // A corrupt value can never break the chat list.
    store.updateChat(chat.chat_id, { settings: '{not json' });
    assert.deepEqual(chats.describe(store.getChat(chat.chat_id)).settings, {});
  } finally {
    cleanupDir(dir, store);
  }
});

// ---------------------------------------------------------------------------
// File delete
// ---------------------------------------------------------------------------
test('chat_delete_file allows the owner or uploader only, removes the body and both tables, and audits', async () => {
  const dir = tempDir('rea4-delete-');
  const { store, chats, files } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Delete' });
    addAgent(store, chat.chat_id, 'claude');

    const userFile = uploadBuffer(files, chat.chat_id, 'user.txt', Buffer.from('owned by user'));
    const claudeFile = uploadBuffer(
      files, chat.chat_id, 'claude.txt', Buffer.from('owned by claude'), { uploader: 'claude' }
    );
    const sent = chats.send({
      chat_id: chat.chat_id, from: 'user', to: 'muse', body: 'see attachment',
      files: [userFile.file_id]
    });
    assert.equal(store.listMessageFiles(sent.message_id).length, 1);

    const userRow = store.getChatFile(userFile.file_id);
    const userPath = join(dir, userRow.stored_path);

    const claude = makeToolRunner({ store, chats, files, messages: {}, scheduler: {}, agents: {}, config: {} }, authClaude);
    const master = makeToolRunner({ store, chats, files, messages: {}, scheduler: {}, agents: {}, config: {} }, authMaster);

    // A non-owner non-uploader is rejected and the denial is audited.
    const denied = await claude.invoke('chat_delete_file', {
      chat_id: chat.chat_id, file_id: userFile.file_id
    });
    assert.equal(denied.isError, true);
    const deniedBody = JSON.parse(denied.content[0].text);
    assert.equal(deniedBody.error, 'file_delete_forbidden');
    assert.equal(deniedBody.status, 403);
    assert.ok(existsSync(userPath), 'a denied delete leaves the body in place');
    assert.ok(store.getChatFile(userFile.file_id));

    // The owner may delete any file in the chat.
    const removed = payload(await master.invoke('chat_delete_file', {
      chat_id: chat.chat_id, file_id: userFile.file_id
    }));
    assert.equal(removed.deleted, true);
    assert.equal(removed.file_id, userFile.file_id);
    assert.equal(existsSync(userPath), false, 'the stored body is removed');
    assert.equal(store.getChatFile(userFile.file_id), null);
    assert.equal(store.listMessageFiles(sent.message_id).length, 0,
      'message_files references are removed');

    // An uploader may delete their own file.
    const own = payload(await claude.invoke('chat_delete_file', {
      chat_id: chat.chat_id, file_id: claudeFile.file_id
    }));
    assert.equal(own.deleted, true);
    assert.equal(store.getChatFile(claudeFile.file_id), null);

    // A file can only be deleted through its own chat.
    const otherChat = chats.create({ name: 'Other' });
    const other = uploadBuffer(files, chat.chat_id, 'other.txt', Buffer.from('x'));
    assert.throws(
      () => files.deleteFile({
        chat_id: otherChat.chat_id, file_id: other.file_id, actor: authMaster
      }),
      /belongs to chat/
    );
    assert.ok(store.getChatFile(other.file_id), 'a mismatched chat id is a no-op');
  } finally {
    cleanupDir(dir, store);
  }
});

test('a wrong chat id is rejected and a successful delete writes an audit line', async () => {
  const dir = tempDir('rea4-delete2-');
  const { store, chats, files, config } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Audit' });
    const other = chats.create({ name: 'Other' });
    const file = uploadBuffer(files, chat.chat_id, 'audit.txt', Buffer.from('audit me'));
    const master = makeToolRunner({ store, chats, files, messages: {}, scheduler: {}, agents: {}, config }, authMaster);

    const mismatch = await master.invoke('chat_delete_file', {
      chat_id: other.chat_id, file_id: file.file_id
    });
    assert.equal(mismatch.isError, true);
    const mismatchBody = JSON.parse(mismatch.content[0].text);
    assert.equal(mismatchBody.error, 'file_chat_mismatch');
    assert.ok(store.getChatFile(file.file_id), 'a mismatched delete is a no-op');

    payload(await master.invoke('chat_delete_file', {
      chat_id: chat.chat_id, file_id: file.file_id
    }));
    const audit = readFileSync(join(store.dataDir, 'security-audit.log'), 'utf8');
    assert.match(audit, /event=chat_file_deleted/);
    assert.match(audit, new RegExp(`file_id=${file.file_id}`));
    assert.match(audit, /event=chat_file_delete_denied/);
  } finally {
    cleanupDir(dir, store);
  }
});

// ---------------------------------------------------------------------------
// Owner notices move out of the chat stream
// ---------------------------------------------------------------------------
test('_notifyOwner and unread-@ reminders never write chat messages; wake_status exposes notices', async () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-notices' });
    addAgent(h.store, chatId, 'claude');

    // Direct owner notice: logged, not posted.
    h.wake._notifyOwner(chatId, '[wake] something happened', 'test-key');
    assert.equal(h.store.lastChatMessage(chatId), null);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);

    // An expired unread mention becomes a persisted notice, still no message.
    h.store.insertWakeEvent({
      id: 'evt-unread', chat_id: chatId, agent_id: 'agent_claude', kind: 'mention',
      message_seq: 3, status: 'pending', created_at: h.clock.now - 11 * 60 * 1000
    });
    h.wake._checkUnreadMentions();
    assert.equal(h.store.hasWakeNotice('evt-unread'), true);
    assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0,
      'the chat stream stays free of [wake] notices');
    assert.equal(h.store.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"
    ).get().n, 0);

    const tools = makeToolRunner(h, authClaude);
    const status = payload(await tools.invoke('wake_status', { chat_id: chatId }));
    const row = status.chats.find((chat) => chat.chat_id === chatId);
    assert.ok(row, 'the chat is present in wake_status');
    assert.equal(row.unread_notice_count, 1);
    assert.equal(row.unread_notices.length, 1);
    assert.equal(row.unread_notices[0].event_id, 'evt-unread');
    assert.equal(row.unread_notices[0].message_seq, 3);
    assert.equal(row.unread_notices[0].kind, 'mention');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});
// ---------------------------------------------------------------------------
// Phase 4 must-fix: circuit breaker owner notice + retry source of truth
// ---------------------------------------------------------------------------
test('dsh M1: the auto-disable circuit breaker persists an owner notice without a chat message', async () => {
  const h = makeHarness({ wakeMinIntervalMs: 0 });
  try {
    const chatId = seedChat(h.store, { id: 'chat-auto-disabled' });
    addAgent(h.store, chatId, 'claude');
    const record = () => h.wake.record({
      chat_id: chatId, kind: 'mention', message_id: 'missing', message_seq: 1, mentions: ['claude']
    });

    record();
    h.wake.onTaskFinished('task-1', 'FAILED'); // first run fails, retried once
    h.wake.onTaskFinished('task-2', 'FAILED'); // second consecutive failure
    const [disabledEvent] = record();
    h.wake.onTaskFinished('task-3', 'FAILED'); // third failure trips the breaker

    assert.equal(h.wake.getConfig('claude', chatId).enabled, false,
      'wake is auto-disabled after three consecutive failures');
    assert.equal(h.store.hasWakeNotice(disabledEvent.id), true,
      'the event that tripped the breaker becomes an owner notice');

    const tools = makeToolRunner({ ...h, wake: h.wake }, authClaude);
    const status = payload(await tools.invoke('wake_status', { chat_id: chatId }));
    const row = status.chats.find((chat) => chat.chat_id === chatId);
    assert.equal(row.unread_notice_count, 1, 'wake_status surfaces the disable notice');
    assert.equal(row.unread_notices[0].event_id, disabledEvent.id);
    assert.equal(row.unread_notices[0].status, 'disabled');

    assert.equal(h.store.lastChatMessage(chatId), null,
      'the disable notice must not enter the chat message stream');
    assert.equal(h.store.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE kind = 'system'"
    ).get().n, 0);
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('Claude M2: task_status exposes the original prompt and cwd untruncated for retry', async () => {
  const dir = tempDir('rea4-task-');
  let services = null;
  try {
    services = makeServices(dir);
    const scheduler = new Scheduler(services.store, services.config);
    const chatId = seedChat(services.store, { id: 'chat-task-status' });
    const task = seedTask(services.store, {
      id: 'task-status-prompt', agent: 'claude', chatId, cwd: dir, state: 'COMPLETED'
    });
    const prompt = 'original prompt line 1\nline 2: ' + 'x'.repeat(5000);
    services.store.updateTask(task.id, { prompt });

    const tools = makeToolRunner({ ...services, scheduler }, authMaster);
    const status = payload(await tools.invoke('task_status', { task_id: task.id }));
    assert.equal(status.prompt, prompt, 'the stored prompt is returned verbatim');
    assert.equal(status.cwd, dir, 'the stored cwd is returned verbatim');
  } finally {
    cleanupDir(dir, services?.store);
  }
});
