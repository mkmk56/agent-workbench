import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { identifyToken } from '../src/auth.js';
import { registerTools } from '../src/tools.js';
import { RECALLED_PLACEHOLDER } from '../src/messages.js';
import { ProtocolError } from '../src/agents.js';
import { runMigration } from '../scripts/migrate-rea-phase2.mjs';
import {
  authClaude, authHuman, authMaster, authMuse, makeServices, seedChat, seedTask, tempDir
} from './helpers.js';

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
    config: services.config,
    agents: services.agents
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

function cleanup(dir, ...stores) {
  for (const store of stores) {
    try { store?.close?.(); } catch { /* ignore */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
}

test('Phase 2 migration adds the tables, backfills built-ins/members/cursors and is rerunnable', () => {
  const dir = tempDir();
  let store = null;
  let reopened = null;
  try {
    const services = makeServices(dir);
    store = services.store;
    const { chats } = services;
    const chatId = seedChat(store, { id: 'chat-mig' });
    chats.send({ chat_id: chatId, from: 'user', to: 'muse', body: 'one' });
    chats.send({ chat_id: chatId, from: 'muse', to: 'user', body: 'two', client_msg_id: 'm2' });
    store.upsertChatParticipant({
      chat_id: chatId, participant_id: 'claude', kind: 'agent', role: 'claude', display_name: 'Claude'
    });
    const maxSeq = store.maxChatSeq(chatId);
    assert.equal(maxSeq, 2);

    const messageColumns = store._columns('messages');
    for (const column of ['recalled_at', 'recalled_by', 'op_key']) {
      assert.ok(messageColumns.includes(column), `messages.${column} missing`);
    }
    const chatColumns = store._columns('chats');
    assert.ok(chatColumns.includes('category'));
    assert.ok(chatColumns.includes('visibility'));
    assert.equal(store.schemaVersion(), 5);
    store.close();
    store = null;

    const backupDir = join(dir, 'backups');
    const first = runMigration({
      dbPath: services.config.dbPath, dataDir: dir, backupDir, readToMax: true
    });
    assert.equal(first.schema_version, 5);
    assert.ok(existsSync(first.backup_path), 'a consistent pre-migration snapshot exists');
    assert.deepEqual(first.tables, ['agents', 'chat_members', 'inbox_cursors', 'pairing_code_uses', 'pairing_codes']);
    assert.equal(first.counts.agents, 3, 'muse/claude/dsh built-ins are seeded');
    assert.ok(first.counts.chat_members >= 3, 'user + muse + claude membership rows');
    assert.ok(first.counts.inbox_cursors >= 3);

    reopened = new Store(services.config.dbPath, dir);
    assert.equal(reopened.schemaVersion(), 5);
    for (const id of ['agent_muse', 'agent_claude', 'agent_dsh']) {
      assert.ok(reopened.getAgent(id), `${id} exists`);
    }
    const claudeMember = reopened.getChatMember(chatId, 'agent_claude');
    assert.equal(claudeMember.role, 'member');
    assert.equal(reopened.getChatMember(chatId, 'user').role, 'owner');
    assert.equal(
      Number(reopened.getInboxCursor(chatId, 'agent_claude').last_read_seq),
      maxSeq,
      'backfill starts read at the current maximum seq'
    );
    reopened.close();
    reopened = null;

    // A rerun must not reset a cursor or duplicate rows.
    const insert = new Store(services.config.dbPath, dir);
    insert.insertChatMessageBundle({
      id: 'm3',
      thread_id: `chat:${chatId}`,
      from_agent: 'user',
      to_agent: 'muse',
      task_id: null,
      reply_to: null,
      summary: 'three',
      body: 'three',
      status: 'stored',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      chat_id: chatId,
      epoch: 1
    });
    insert.close();

    const second = runMigration({
      dbPath: services.config.dbPath, dataDir: dir, backupDir, backup: false, readToMax: true
    });
    assert.equal(second.agents.memberships_inserted, 0);
    assert.equal(second.agents.cursors_inserted, 0);
    assert.equal(second.counts.agents, 3);
    reopened = new Store(services.config.dbPath, dir);
    assert.equal(
      Number(reopened.getInboxCursor(chatId, 'agent_claude').last_read_seq),
      maxSeq,
      'rerun keeps the existing cursor'
    );
  } finally {
    cleanup(dir, store, reopened);
  }
});

test('pairing issues one token, stores only a hash, reclaims and revokes', () => {
  const dir = tempDir();
  const { store, agents } = makeServices(dir);
  try {
    const code = agents.createPairingCode({ maxAgents: 2 });
    assert.match(code.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(code.max_agents, 2);

    const first = agents.redeemPairingCode({
      code: code.code, name: 'Researcher', platform: 'custom', profile: 'reads things'
    });
    assert.match(first.token, /^pachat_/);
    assert.equal(first.reclaim, false);
    const row = store.getAgent(first.agent.agent_id);
    assert.ok(row.token_hash, 'hash stored');
    assert.equal(row.token_hash.includes(first.token), false, 'plaintext token is not stored');
    const authFirst = agents.identifyAccessToken(first.token);
    assert.equal(authFirst.token_kind, 'access');
    assert.equal(authFirst.participant, first.agent.agent_id);
    // The HTTP identity resolver accepts the same token when given the store.
    const viaIdentify = identifyToken(first.token, {
      token: 'unrelated-master', legacyMasterEnabled: false, legacyAgentTokensEnabled: false
    }, store);
    assert.equal(viaIdentify?.token_kind, 'access');
    assert.equal(viaIdentify.participant, first.agent.agent_id);

    assert.throws(
      () => agents.redeemPairingCode({ code: code.code, name: 'Researcher' }),
      (error) => error instanceof ProtocolError && error.code === 'member_exists' && error.status === 409
    );

    const reclaimed = agents.redeemPairingCode({
      code: code.code, name: 'researcher', reclaim: true
    });
    assert.equal(reclaimed.reclaim, true);
    assert.equal(reclaimed.agent.agent_id, first.agent.agent_id);
    assert.equal(agents.identifyAccessToken(first.token), null, 'old token is invalidated');
    assert.ok(agents.identifyAccessToken(reclaimed.token), 'new token works');
    assert.equal(
      store.getAgent(first.agent.agent_id).profile,
      'reads things',
      'omitting profile preserves it on reclaim'
    );
    assert.equal(store.countPairingUses(code.pairing_id), 1, 'reclaim does not consume a second slot');

    const reprofiled = agents.redeemPairingCode({
      code: code.code, name: 'Researcher', reclaim: true,
      profile: 'new profile', platform: 'claude-code'
    });
    assert.equal(store.getAgent(first.agent.agent_id).profile, 'new profile');
    assert.equal(store.getAgent(first.agent.agent_id).platform, 'claude-code');
    assert.ok(agents.identifyAccessToken(reprofiled.token));

    const revoked = agents.revokeToken(reclaimed.agent.agent_id);
    assert.equal(revoked.status, 'revoked');
    assert.equal(agents.identifyAccessToken(reprofiled.token), null);
    assert.equal(store.getAgent(reclaimed.agent.agent_id).token_hash, null);

    agents.ensureBuiltins();
    assert.throws(
      () => agents.revokeToken('agent_claude'),
      (error) => error.code === 'cannot_revoke_builtin' && error.status === 403
    );
  } finally {
    cleanup(dir, store);
  }
});

test('pairing codes expire, enforce the agent cap and reserve built-in names', () => {
  const dir = tempDir();
  const { store, agents } = makeServices(dir);
  try {
    assert.throws(
      () => agents.redeemPairingCode({ code: 'NOPE-NOPE', name: 'X' }),
      (error) => error.code === 'invalid_pairing_code' && error.status === 401
    );
    assert.throws(
      () => agents.redeemPairingCode({ code: 'AAAA-AAAA', name: 'Claude' }),
      (error) => error.code === 'invalid_pairing_code'
    );

    const reserved = agents.createPairingCode();
    assert.throws(
      () => agents.redeemPairingCode({ code: reserved.code, name: 'Claude' }),
      (error) => error.code === 'name_reserved' && error.status === 409
    );

    const expiring = agents.createPairingCode();
    store.db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, expiring.pairing_id);
    assert.throws(
      () => agents.redeemPairingCode({ code: expiring.code, name: 'Late' }),
      (error) => error.code === 'pairing_code_expired' && error.status === 410
    );

    const capped = agents.createPairingCode({ maxAgents: 1 });
    agents.redeemPairingCode({ code: capped.code, name: 'First' });
    assert.throws(
      () => agents.redeemPairingCode({ code: capped.code, name: 'Second' }),
      (error) => error.code === 'pairing_code_exhausted' && error.status === 409
    );
  } finally {
    cleanup(dir, store);
  }
});

test('op_key and client_msg_id are the same idempotency key', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir);
  try {
    const chatId = seedChat(store);
    const first = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'send once', op_key: 'op-1'
    });
    const againByOp = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'retry', op_key: 'op-1'
    });
    const againByClient = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'retry 2', client_msg_id: 'op-1'
    });
    assert.equal(againByOp.message_id, first.message_id);
    assert.equal(againByOp.deduplicated, true);
    assert.equal(againByClient.message_id, first.message_id);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId).n, 1
    );
    assert.equal(store.getMessage(first.message_id).op_key, 'op-1');
    assert.equal(store.getMessage(first.message_id).client_msg_id, 'op-1');

    assert.throws(() => chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'conflict',
      op_key: 'a', client_msg_id: 'b'
    }), (error) => error.code === 'op_key_conflict' && error.status === 400);
  } finally {
    cleanup(dir, store);
  }
});

test('per-chat message rate limit returns 429', () => {
  const dir = tempDir();
  const { store, chats } = makeServices(dir, { config: { chatMessagesPerHour: 2 } });
  try {
    const chatId = seedChat(store);
    const first = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'one', op_key: 'one'
    });
    chats.send({ auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'two' });
    assert.throws(
      () => chats.send({ auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'three' }),
      (error) => error.code === 'rate_limited' && error.status === 429
    );
    // A retry of an already-accepted key is answered before the limiter.
    const retry = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'one again', op_key: 'one'
    });
    assert.equal(retry.message_id, first.message_id);
    assert.equal(retry.deduplicated, true);
  } finally {
    cleanup(dir, store);
  }
});

test('409 new_messages blocks an agent until it reads; ignore_new is owner-only', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, chats } = services;
  try {
    agents.ensureBuiltins();
    const chatId = seedChat(store);
    agents.addMember({ chatId, agentId: 'claude' });
    const taskId = seedTask(store, { agent: 'claude', chatId }).id;
    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse',
      body: 'please look', mentions: ['claude']
    });

    const tools = makeToolRunner(services, authClaude);
    const blocked = await tools.invoke('send_chat_message', {
      chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId, body: 'working'
    });
    assert.equal(blocked.isError, true);
    const errorBody = payload(blocked);
    assert.equal(errorBody.error, 'new_messages');
    assert.equal(errorBody.status, 409);
    assert.equal(errorBody.unread, 1);
    assert.equal(errorBody.latest_seq, 1);

    const ignore = await tools.invoke('send_chat_message', {
      chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId, body: 'force', ignore_new: true
    });
    assert.equal(payload(ignore).error, 'forbidden_ignore_new');
    assert.equal(payload(ignore).status, 403);

    const read = await tools.invoke('chat_mark_read', { chat_id: chatId });
    assert.equal(read.isError, undefined);
    assert.equal(payload(read).unread, 0);
    assert.equal(store.getInboxCursor(chatId, 'agent_claude').last_read_seq, 1);

    const allowed = await tools.invoke('send_chat_message', {
      chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId, body: 'working'
    });
    assert.equal(allowed.isError, undefined);
  } finally {
    cleanup(dir, store);
  }
});

test('recall enforces the 2-minute window and replaces the body', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, chats, messages } = services;
  try {
    agents.ensureBuiltins();
    const chatId = seedChat(store);
    agents.addMember({ chatId, agentId: 'claude' });
    const sent = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'delete me', mentions: ['claude']
    });

    const humanTools = makeToolRunner(services, authHuman);
    const recalled = await humanTools.invoke('chat_recall', {
      chat_id: chatId, message_id: sent.message_id
    });
    assert.equal(recalled.isError, undefined);
    const body = payload(recalled);
    assert.equal(body.recalled, true);
    assert.equal(body.recalled_by, 'user');
    assert.match(body.body, /撤回/);
    const row = store.getMessage(sent.message_id);
    assert.equal(row.body, RECALLED_PLACEHOLDER);
    assert.equal(typeof row.recalled_at, 'number');

    const claudeInbox = agents.inbox({ agentId: 'agent_claude' });
    const entry = claudeInbox.chats.find((chat) => chat.chat_id === chatId);
    assert.equal(entry.recalled, 1);
    assert.equal(entry.unread, 1);

    const again = await humanTools.invoke('chat_recall', {
      chat_id: chatId, message_id: sent.message_id
    });
    assert.equal(payload(again).already_recalled, true);

    // The window is measured from the stored created_at.
    const second = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'too old'
    });
    store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), second.message_id);
    const expired = await humanTools.invoke('chat_recall', {
      chat_id: chatId, message_id: second.message_id
    });
    assert.equal(payload(expired).error, 'recall_window_expired');
    assert.equal(payload(expired).status, 403);

    // A non-author agent cannot recall someone else's message.
    seedTask(store, { agent: 'claude', chatId });
    agents.markRead({ chatId, agentId: 'agent_claude' });
    const claudeTools = makeToolRunner(services, authClaude);
    const forbidden = await claudeTools.invoke('chat_recall', {
      chat_id: chatId, message_id: second.message_id
    });
    assert.equal(payload(forbidden).error, 'recall_forbidden');

    // Direct service call also rejects a foreign author.
    assert.throws(
      () => messages.recall({ chatId, messageId: second.message_id, auth: authMuse }),
      (error) => error.code === 'recall_forbidden'
    );
  } finally {
    cleanup(dir, store);
  }
});

test('mentions, owner messages and replies update inbox counts and fire the hook', () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, chats, messages } = services;
  try {
    agents.ensureBuiltins();
    const events = [];
    messages.onMention = (event) => events.push(event);
    const chatId = seedChat(store);
    agents.addMember({ chatId, agentId: 'claude' });
    const taskId = seedTask(store, { agent: 'claude', chatId }).id;

    const request = chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse',
      body: 'read this', mentions: ['claude']
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].mentions, ['claude']);
    assert.equal(events[0].chat_id, chatId);

    let entry = agents.inbox({ agentId: 'agent_claude' }).chats.find((c) => c.chat_id === chatId);
    assert.equal(entry.mentions_you, 1);
    assert.equal(entry.from_owner, 1);
    assert.equal(entry.unread, 1);

    agents.markRead({ chatId, agentId: 'agent_claude' });
    const reply = chats.send({
      auth: authClaude, chat_id: chatId, from: 'claude', to: 'user', task_id: taskId,
      reply_to: request.message_id, body: 'claude reply'
    });

    // The user answers Claude's message: that is one reply-to-you and one
    // mention for Claude.
    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'claude',
      reply_to: reply.message_id, body: 'follow up', mentions: ['claude']
    });

    entry = agents.inbox({ agentId: 'agent_claude' }).chats.find((c) => c.chat_id === chatId);
    assert.equal(entry.replies_to_you, 1);
    assert.equal(entry.mentions_you, 1);
    assert.equal(entry.from_owner, 1);
    assert.equal(entry.unread, 1);
  } finally {
    cleanup(dir, store);
  }
});

test('author.human is server-derived and a forged human identity is rejected', () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, messages } = services;
  try {
    agents.ensureBuiltins();
    const chatId = seedChat(store);
    const taskId = seedTask(store, { agent: 'claude', chatId }).id;

    const fromUser = messages.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'hi',
      author: { id: 'user', human: true }
    });
    assert.equal(fromUser.author.human, true);
    assert.equal(fromUser.author.agent, false);

    const fromAgent = messages.send({
      auth: authClaude, chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId,
      body: 'agent here', author: { human: false }
    });
    assert.equal(fromAgent.author.human, false);
    assert.equal(fromAgent.author.agent, true);

    assert.throws(() => messages.send({
      auth: authClaude, chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId,
      body: 'I am human', author: { human: true }
    }), (error) => error.code === 'forged_identity' && error.status === 403);

    assert.throws(() => messages.send({
      auth: authClaude, chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId,
      body: 'wrong id', author: { id: 'dsh', human: false }
    }), (error) => error.code === 'forged_identity');

    assert.throws(() => messages.send({
      auth: authClaude, chat_id: chatId, from: 'claude', to: 'muse', task_id: taskId,
      body: 'flag', human: true
    }), (error) => error.code === 'forged_identity');
  } finally {
    cleanup(dir, store);
  }
});

test('profiles are limited to 300 characters and readable through the tool', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents } = services;
  try {
    const code = agents.createPairingCode();
    const paired = agents.redeemPairingCode({ code: code.code, name: 'Scout' });
    const agentAuth = agents.identifyAccessToken(paired.token);
    const tools = makeToolRunner(services, agentAuth);

    const ok = await tools.invoke('agent_profile', { profile: 'x'.repeat(300) });
    assert.equal(ok.isError, undefined);
    assert.equal(payload(ok).profile.length, 300);

    const tooLong = await tools.invoke('agent_profile', { profile: 'x'.repeat(301) });
    assert.equal(payload(tooLong).error, 'invalid_profile');
    assert.equal(payload(tooLong).status, 400);

    const read = await tools.invoke('agent_profile', {});
    assert.equal(payload(read).display_name, 'Scout');
    assert.equal(payload(read).agent_id, paired.agent.agent_id);

    // Built-ins are seeded by reconciliation, not by pairing.
    agents.ensureBuiltins();
    const otherTools = makeToolRunner(services, authMaster);
    const claudeProfile = await otherTools.invoke('agent_profile', { agent_id: 'agent_claude' });
    assert.equal(claudeProfile.isError, undefined);
    assert.equal(payload(claudeProfile).display_name, 'Claude');
  } finally {
    cleanup(dir, store);
  }
});

test('membership caps, owner-only administration and third-party sending', async () => {
  const dir = tempDir();
  // Three built-ins already count against the owner quota; leave room for one
// paired agent (the member cap is the constraint under test here).
  const services = makeServices(dir, { config: { chatMaxMembers: 3, ownerMaxAgents: 4 } });
  const { store, agents, chats } = services;
  try {
    agents.ensureBuiltins();
    const chatId = seedChat(store);
    agents.addMember({ chatId, agentId: 'user' });
    agents.addMember({ chatId, agentId: 'muse' });
    agents.addMember({ chatId, agentId: 'claude' });
    assert.throws(
      () => agents.addMember({ chatId, agentId: 'dsh' }),
      (error) => error.code === 'chat_member_limit' && error.status === 403
    );
    agents.removeMember({ chatId, agentId: 'claude' });
    agents.addMember({ chatId, agentId: 'dsh' });
    assert.throws(
      () => agents.removeMember({ chatId, agentId: 'user' }),
      (error) => error.code === 'cannot_remove_owner'
    );

    const museTools = makeToolRunner(services, authMuse);
    const notAdmin = await museTools.invoke('chat_add_member', { chat_id: chatId, agent_id: 'claude' });
    assert.match(notAdmin.content[0].text, /requires a human or master token/);

    // A paired agent: membership, token identity and a real message.
    const code = agents.createPairingCode({ maxAgents: 2 });
    const paired = agents.redeemPairingCode({
      code: code.code, name: 'Scout', platform: 'custom'
    });
    const agentAuth = agents.identifyAccessToken(paired.token);
    assert.ok(agentAuth);
    // Remove dsh so the member cap is not in the way.
    agents.removeMember({ chatId, agentId: 'dsh' });
    agents.addMember({ chatId, agentId: paired.agent.agent_id });

    const agentTools = makeToolRunner(services, agentAuth);
    const sent = await agentTools.invoke('send_chat_message', {
      chat_id: chatId, from: paired.agent.agent_id, to: 'muse', body: 'hello from scout'
    });
    assert.equal(sent.isError, undefined);
    const stored = store.getMessage(payload(sent).message_id);
    assert.equal(stored.from_agent, paired.agent.agent_id);
    const listedMessage = chats.listMessages({ chat_id: chatId, limit: 50 }).messages
      .find((message) => message.message_id === stored.id);
    assert.equal(listedMessage.author.human, false);
    assert.equal(listedMessage.author.agent, true);

    // It cannot post into a chat it has not joined.
    const otherChat = seedChat(store, { name: 'other' });
    const outsider = await agentTools.invoke('send_chat_message', {
      chat_id: otherChat, from: paired.agent.agent_id, to: 'muse', body: 'sneak'
    });
    assert.equal(outsider.isError, true);
    assert.match(outsider.content[0].text, /not a participant/);

    // A user message after joining arms the 409 gate for the third-party agent.
    chats.send({ auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'new one' });
    const blocked = await agentTools.invoke('send_chat_message', {
      chat_id: chatId, from: paired.agent.agent_id, to: 'muse', body: 'reply'
    });
    assert.equal(payload(blocked).error, 'new_messages');
    const read = await agentTools.invoke('chat_mark_read', { chat_id: chatId });
    assert.equal(read.isError, undefined);
    const allowed = await agentTools.invoke('send_chat_message', {
      chat_id: chatId, from: paired.agent.agent_id, to: 'muse', body: 'reply'
    });
    assert.equal(allowed.isError, undefined);
  } finally {
    cleanup(dir, store);
  }
});

test('the owner-agent quota is enforced at pairing time', () => {
  const dir = tempDir();
  // Built-ins are not seeded here: the quota counts active agents owned by
  // 'user', and this test isolates the pairing path.
  const { store, agents } = makeServices(dir, { config: { ownerMaxAgents: 2 } });
  try {
    const c1 = agents.createPairingCode();
    agents.redeemPairingCode({ code: c1.code, name: 'One' });
    const c2 = agents.createPairingCode();
    agents.redeemPairingCode({ code: c2.code, name: 'Two' });
    const c3 = agents.createPairingCode();
    assert.throws(
      () => agents.redeemPairingCode({ code: c3.code, name: 'Three' }),
      (error) => error.code === 'owner_agent_limit' && error.status === 403
    );
  } finally {
    cleanup(dir, store);
  }
});

test('list_chats returns unread, chat_mark_read syncs inbox, and pulling messages marks read', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, chats } = services;
  try {
    agents.ensureBuiltins();
    const chatId = seedChat(store, { name: 'Inbox chat' });
    agents.addMember({ chatId, agentId: 'claude' });
    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse',
      body: 'one', mentions: ['claude']
    });
    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'two'
    });

    const tools = makeToolRunner(services, authClaude);
    const listed = await tools.invoke('list_chats', {});
    const entry = payload(listed).chats.find((chat) => chat.chat_id === chatId);
    assert.equal(entry.unread, 2);
    assert.equal(entry.inbox.mentions_you, 1);
    assert.equal(entry.inbox.from_owner, 2);

    const marked = await tools.invoke('chat_mark_read', { chat_id: chatId });
    assert.equal(marked.isError, undefined);
    assert.equal(payload(marked).unread, 0);
    assert.equal(store.getInboxCursor(chatId, 'agent_claude').last_read_seq, 2);
    const afterRead = payload(await tools.invoke('list_chats', {}))
      .chats.find((chat) => chat.chat_id === chatId);
    assert.equal(afterRead.unread, 0);

    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'three'
    });
    const page = await tools.invoke('list_chat_messages', { chat_id: chatId });
    assert.equal(page.isError, undefined);
    assert.equal(payload(page).messages.length, 3);
    assert.equal(store.getInboxCursor(chatId, 'agent_claude').last_read_seq, 3);
    assert.equal(store.getChatParticipant(chatId, 'claude').last_read_seq, 3);

    // The canonical agent id is accepted for the same participant.
    const canonical = await tools.invoke('chat_mark_read', {
      chat_id: chatId, participant_id: 'agent_claude'
    });
    assert.equal(canonical.isError, undefined);
    assert.equal(payload(canonical).participant_id, 'claude');

    // chat_get_context is also a pull: it clears the unread gate.
    chats.send({
      auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'four'
    });
    const context = await tools.invoke('chat_get_context', { chat_id: chatId });
    assert.equal(context.isError, undefined);
    assert.equal(store.getInboxCursor(chatId, 'agent_claude').last_read_seq, 4);
  } finally {
    cleanup(dir, store);
  }
});

test('P1-1 reconciliation repairs missing membership and inbox rows', () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store, agents, chats } = services;
  try {
    const chatId = seedChat(store);
    chats.send({ auth: authMaster, chat_id: chatId, from: 'user', to: 'muse', body: 'one' });
    store.upsertChatParticipant({
      chat_id: chatId, participant_id: 'claude', kind: 'agent', role: 'claude', display_name: 'Claude'
    });
    store.db.exec('DELETE FROM inbox_cursors; DELETE FROM chat_members;');
    assert.equal(store.listChatMembers(chatId).length, 0);

    const summary = agents.reconcile();
    assert.equal(summary.builtins_inserted, 3);
    assert.ok(summary.memberships_inserted >= 3);
    assert.ok(summary.cursors_inserted >= 3);
    assert.equal(store.getChatMember(chatId, 'user').role, 'owner');
    assert.ok(store.getChatMember(chatId, 'agent_muse'));
    assert.ok(store.getChatMember(chatId, 'agent_claude'));
    assert.equal(store.getInboxCursor(chatId, 'agent_claude').last_read_seq, 1);

    const again = agents.reconcile();
    assert.equal(again.builtins_inserted, 0);
    assert.equal(again.memberships_inserted, 0);
    assert.equal(again.cursors_inserted, 0);
  } finally {
    cleanup(dir, store);
  }
});

test('create_chat stores a category and always creates a link-visible chat', async () => {
  const dir = tempDir();
  const services = makeServices(dir);
  const { store } = services;
  try {
    const tools = makeToolRunner(services, authMaster);
    const created = await tools.invoke('create_chat', { name: 'Research', category: 'research' });
    const body = payload(created);
    assert.equal(body.category, 'research');
    assert.equal(body.visibility, 'link');
    assert.equal(store.getChat(body.chat_id).visibility, 'link');
    assert.equal(store.getChat(body.chat_id).category, 'research');
  } finally {
    cleanup(dir, store);
  }
});