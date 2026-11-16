import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { MessageService } from '../src/messages.js';
import { ChatService } from '../src/chats.js';
import {
  FakeScheduler, authClaude, authMaster, makeConfig, seedChat, seedTask, tempDir
} from './helpers.js';

function build(dir, overrides = {}) {
  const config = makeConfig(dir, overrides);
  const store = new Store(config.dbPath, config.dataDir);
  const scheduler = new FakeScheduler();
  scheduler.config = config;
  const messages = new MessageService({ store, scheduler, config });
  const chats = new ChatService({ store, messages, config });
  return { config, store, scheduler, messages, chats };
}

test('user message bumps epoch, keeps full body and truncated preview', () => {
  const dir = tempDir();
  const { store, messages } = build(dir);
  try {
    const chatId = seedChat(store);
    const longBody = '这是一个很长的用户请求。'.repeat(200);
    const result = messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'preview', body: longBody
    });
    assert.equal(result.epoch, 1);
    assert.equal(result.seq, 1);
    assert.equal(result.body.length, longBody.length);
    assert.ok(result.summary.length < result.body.length, 'summary is a truncated preview');
    assert.equal(store.chatEpoch(chatId), 1);
    assert.equal(store.chatNeedsMuse(chatId), true);

    const muse = messages.send({
      auth: authMaster, from: 'muse', to: 'user', chat_id: chatId, summary: 'muse reply'
    });
    assert.equal(muse.epoch, 1);
    assert.equal(store.chatNeedsMuse(chatId), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('visibility and action are separate: only act_recipients start sub-tasks', () => {
  const dir = tempDir();
  const { store, scheduler, chats } = build(dir, { agentAutoDeliver: true });
  try {
    const chatId = seedChat(store);
    const visible = chats.send({
      auth: authMaster, from: 'muse', to: 'claude', chat_id: chatId,
      summary: 'everyone sees this', act_recipients: []
    });
    assert.equal(scheduler.created.length, 0, 'no action recipient means no sub-task');
    const deliveries = store.listMessageDeliveries(visible.message_id);
    assert.equal(deliveries.find((d) => d.agent === 'claude').status, 'visible');

    const acted = chats.send({
      auth: authMaster, from: 'muse', to: 'claude', chat_id: chatId,
      summary: 'claude please act', act_recipients: ['claude'], epoch: store.chatEpoch(chatId)
    });
    assert.equal(scheduler.created.length, 1);
    assert.equal(scheduler.created[0].agent, 'claude');
    assert.equal(scheduler.created[0].chatId, chatId);
    const actedDeliveries = store.listMessageDeliveries(acted.message_id);
    assert.equal(actedDeliveries.find((d) => d.agent === 'claude').status, 'delivered');
    assert.equal(actedDeliveries.find((d) => d.agent === 'user').status, 'visible');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent identity, task ownership and participation are enforced', () => {
  const dir = tempDir();
  const { store, messages } = build(dir);
  try {
    const chatId = seedChat(store);
    const taskId = seedTask(store, { agent: 'claude', chatId }).id;

    assert.throws(() => messages.send({
      auth: authClaude, from: 'muse', to: 'user', chat_id: chatId, summary: 'impersonation'
    }), /token identifies as 'claude'/);

    assert.throws(() => messages.send({
      auth: authClaude, from: 'claude', to: 'muse', chat_id: chatId, summary: 'no task'
    }), /require an owned task_id/);

    const own = messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId,
      summary: 'own conclusion'
    });
    assert.equal(own.from, 'claude');

    assert.throws(() => messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId,
      summary: 'try to dispatch', act_recipients: ['dsh']
    }), /may not dispatch sub-tasks/);

    const otherChat = seedChat(store, { name: 'other' });
    assert.throws(() => messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: otherChat,
      summary: 'cross-chat leak'
    }), /not a participant/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale epoch dispatch is rejected', () => {
  const dir = tempDir();
  const { store, chats } = build(dir);
  try {
    const chatId = seedChat(store);
    chats.send({ auth: authMaster, from: 'user', to: 'muse', chat_id: chatId, summary: 'hello' });
    const current = store.chatEpoch(chatId);
    assert.throws(() => chats.send({
      auth: authMaster, from: 'muse', to: 'claude', chat_id: chatId,
      summary: 'stale dispatch', act_recipients: ['claude'], epoch: current - 1
    }), /epoch mismatch/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client_msg_id is idempotent per chat', () => {
  const dir = tempDir();
  const { store, chats } = build(dir);
  try {
    const chatId = seedChat(store);
    const first = chats.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'retry me', client_msg_id: 'client-abc'
    });
    const second = chats.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'retry me', client_msg_id: 'client-abc'
    });
    assert.equal(second.message_id, first.message_id);
    assert.equal(second.deduplicated, true);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId).n,
      1
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one message may have several replies (broadcast)', () => {
  const dir = tempDir();
  const { store, messages } = build(dir);
  try {
    const chatId = seedChat(store);
    const claudeTask = seedTask(store, { agent: 'claude', chatId }).id;
    const dshTask = seedTask(store, { agent: 'dsh', chatId }).id;
    const request = messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'who can help?', mentions: ['claude', 'dsh']
    });
    const a = messages.send({
      auth: authClaude, from: 'claude', to: 'user', task_id: claudeTask,
      chat_id: chatId, reply_to: request.message_id, summary: 'claude here'
    });
    const dshAuth = { role: 'agent', master: false, participant: 'dsh', token_kind: 'agent' };
    const b = messages.send({
      auth: dshAuth, from: 'dsh', to: 'user', task_id: dshTask,
      chat_id: chatId, reply_to: request.message_id, summary: 'dsh here'
    });
    assert.notEqual(a.message_id, b.message_id);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE reply_to = ?').get(request.message_id).n,
      2
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat epoch agent budget stops runaway loops until the next user message', () => {
  const dir = tempDir();
  const { store, messages } = build(dir, { chatEpochAgentBudget: 2 });
  try {
    const chatId = seedChat(store);
    const taskId = seedTask(store, { agent: 'claude', chatId }).id;
    messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'start', mentions: ['claude']
    });
    messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId, summary: 'one'
    });
    messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId, summary: 'two'
    });
    assert.throws(() => messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId, summary: 'three'
    }), /agent message budget/);
    messages.send({ auth: authMaster, from: 'user', to: 'muse', chat_id: chatId, summary: 'new epoch' });
    const after = messages.send({
      auth: authClaude, from: 'claude', to: 'muse', task_id: taskId, chat_id: chatId, summary: 'after reset'
    });
    assert.equal(after.from, 'claude');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare file paths are rejected in chat attachments', () => {
  const dir = tempDir();
  const { store, messages } = build(dir);
  try {
    const chatId = seedChat(store);
    assert.throws(() => messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'with a path', files: ['C:\\Users\\secret.txt']
    }), /bare file paths are not accepted/);
    assert.throws(() => messages.send({
      auth: authMaster, from: 'user', to: 'muse', chat_id: chatId,
      summary: 'with traversal', files: ['../../etc/passwd']
    }), /bare file paths are not accepted/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});