import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.js';
import {
  authClaude, authHuman, makeServices, seedChat, tempDir
} from './helpers.js';

// Minimal MCP server stand-in: registerTools only needs registerTool().
function makeToolRunner(services, auth) {
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    }
  };
  registerTools(server, {
    scheduler: services.scheduler,
    store: services.store,
    messages: services.messages,
    approvals: {},
    chats: services.chats,
    files: services.files,
    config: services.config
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

test('chat_mark_read advances the caller cursor to a seq, message id, or the latest seq', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, chats } = services;
  try {
    const chatId = seedChat(store);
    const first = chats.send({ chat_id: chatId, from: 'user', to: 'muse', body: 'first' });
    const second = chats.send({ chat_id: chatId, from: 'user', to: 'muse', body: 'second' });
    const tools = makeToolRunner(services, authHuman);

    const byMessage = await tools.invoke('chat_mark_read', {
      chat_id: chatId,
      message_id: first.message_id
    });
    assert.equal(byMessage.isError, undefined);
    const firstRead = payload(byMessage);
    assert.equal(firstRead.ok, true);
    assert.equal(firstRead.participant_id, 'user');
    assert.equal(firstRead.last_read_seq, first.seq);
    assert.equal(firstRead.unread, 1, 'the second message is still unread');
    assert.equal(store.getChatParticipant(chatId, 'user').last_read_seq, first.seq);

    const bySeq = await tools.invoke('chat_mark_read', {
      chat_id: chatId,
      up_to_seq: second.seq
    });
    const secondRead = payload(bySeq);
    assert.equal(secondRead.last_read_seq, second.seq);
    assert.equal(secondRead.unread, 0);

    // No seq / message id: advance to the chat's current newest seq.
    const third = chats.send({ chat_id: chatId, from: 'user', to: 'muse', body: 'third' });
    const latest = payload(await tools.invoke('chat_mark_read', { chat_id: chatId }));
    assert.equal(latest.last_read_seq, third.seq);
    assert.equal(latest.unread, 0);
  } finally {
    store.close();
  }
});

test('chat_mark_read only lets an agent token mark itself read', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, chats } = services;
  try {
    const chatId = seedChat(store);
    store.upsertChatParticipant({
      chat_id: chatId, participant_id: 'claude', kind: 'agent', role: 'claude', display_name: 'Claude'
    });
    store.upsertChatParticipant({
      chat_id: chatId, participant_id: 'dsh', kind: 'agent', role: 'dsh', display_name: 'dsh'
    });
    const sent = chats.send({ chat_id: chatId, from: 'user', to: 'muse', body: 'hello' });
    const tools = makeToolRunner(services, authClaude);

    const own = await tools.invoke('chat_mark_read', {
      chat_id: chatId,
      up_to_seq: sent.seq
    });
    assert.equal(own.isError, undefined);
    assert.equal(payload(own).participant_id, 'claude');
    assert.equal(store.getChatParticipant(chatId, 'claude').last_read_seq, sent.seq);

    const other = await tools.invoke('chat_mark_read', {
      chat_id: chatId,
      participant_id: 'dsh',
      up_to_seq: sent.seq
    });
    assert.equal(other.isError, true);
    assert.match(other.content[0].text, /can only mark its own read state/);
    assert.equal(store.getChatParticipant(chatId, 'dsh').last_read_seq, 0);

    const outsider = await tools.invoke('chat_mark_read', {
      chat_id: seedChat(store),
      up_to_seq: sent.seq
    });
    assert.equal(outsider.isError, true);
    assert.match(outsider.content[0].text, /is not a participant/);
  } finally {
    store.close();
  }
});