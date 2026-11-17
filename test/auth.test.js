import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import {
  deriveAgentToken, deriveAgentTokens, deriveHumanToken, deriveMuseToken,
  identifyToken, issueAgentToken, resolveSender, verifyAgentToken
} from '../src/auth.js';
import { assertChatAccess, assertTaskAccess } from '../src/auth.js';
import {
  authClaude, authHuman, authMaster, authMuse, makeConfig, seedChat, seedTask, tempDir
} from './helpers.js';
import { join } from 'node:path';

test('agent, human and muse tokens are distinct and identify as their principal', () => {
  const config = makeConfig('C:\\tmp\\unused');
  const tokens = deriveAgentTokens(config.token);
  assert.notEqual(tokens.claude, tokens.dsh);
  assert.notEqual(tokens.claude, config.token);
  assert.equal(tokens.claude, deriveAgentToken(config.token, 'claude'));
  assert.equal(config.humanToken, deriveHumanToken(config.token));
  assert.equal(config.museToken, deriveMuseToken(config.token));
  assert.notEqual(config.humanToken, config.museToken);

  assert.equal(identifyToken(config.token, config).participant, 'user');
  assert.equal(identifyToken(config.token, config).token_kind, 'master');
  assert.equal(identifyToken(config.humanToken, config).token_kind, 'human');
  assert.equal(identifyToken(config.museToken, config).token_kind, 'muse');
  assert.equal(identifyToken(tokens.claude, config).participant, 'claude');
  assert.equal(identifyToken(tokens.dsh, config).participant, 'dsh');
  assert.equal(identifyToken('unknown-token', config), null);
  assert.equal(identifyToken('', config), null);
});

test('legacy and human tokens can only post as user; muse only as muse', () => {
  assert.equal(resolveSender(authMaster, 'user'), 'user');
  assert.throws(() => resolveSender(authMaster, 'muse'), /legacy master token may post/);
  assert.throws(() => resolveSender(authMaster, 'claude'), /legacy master token may post/);
  assert.equal(resolveSender(authHuman, 'user'), 'user');
  assert.throws(() => resolveSender(authHuman, 'muse'), /human token may only post/);
  assert.equal(resolveSender(authMuse, 'muse'), 'muse');
  assert.throws(() => resolveSender(authMuse, 'user'), /muse token may only post/);
  assert.equal(resolveSender(authClaude, 'claude'), 'claude');
  assert.throws(() => resolveSender(authClaude, 'muse'), /token identifies as 'claude'/);
  // Internal callers (the task-finish auto-reply path) call without an auth
  // object; tool handlers always pass one.
  assert.equal(resolveSender(null, 'claude'), 'claude');
});

test('per-task agent tokens are bound, expiring and cannot be forged', () => {
  const master = 'm'.repeat(48);
  const now = Date.now();
  const token = issueAgentToken(master, {
    agent: 'claude', taskId: 'task-1', chatId: 'chat-1', scope: 'chat:chat-1', ttlMs: 60_000, now
  });
  const auth = verifyAgentToken(token, master, now + 1000);
  assert.equal(auth.participant, 'claude');
  assert.equal(auth.task_id, 'task-1');
  assert.equal(auth.chat_id, 'chat-1');
  assert.equal(auth.token_kind, 'agent-task');
  assert.equal(auth.expires_at, now + 60_000);

  // Expired.
  assert.equal(verifyAgentToken(token, master, now + 60_001), null);
  // Wrong signing secret.
  assert.equal(verifyAgentToken(token, 'x'.repeat(48), now + 1000), null);
  // Tampered payload.
  const parts = token.split('.');
  const forged = [parts[0], parts[1], 'A'.repeat(parts[2].length)].join('.');
  assert.equal(verifyAgentToken(forged, master, now + 1000), null);
});

test('agent chat and task access is scoped; human/master/muse read everything', () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const store = new Store(join(dir, 'scope.db'), dir);
  try {
    const chatA = seedChat(store, { name: 'A' });
    const chatB = seedChat(store, { name: 'B' });
    const taskClaude = seedTask(store, { agent: 'claude', chatId: chatA }).id;
    const taskDsh = seedTask(store, { agent: 'dsh', chatId: chatA }).id;
    store.upsertChatParticipant({
      chat_id: chatA, participant_id: 'claude', kind: 'agent', role: 'claude'
    });

    assert.doesNotThrow(() => assertChatAccess(store, authMaster, chatB));
    assert.doesNotThrow(() => assertChatAccess(store, authHuman, chatB));
    assert.doesNotThrow(() => assertChatAccess(store, authMuse, chatB));
    assert.doesNotThrow(() => assertChatAccess(store, authClaude, chatA));
    assert.throws(() => assertChatAccess(store, authClaude, chatB), /not a participant/);

    assert.doesNotThrow(() => assertTaskAccess(store, authClaude, taskClaude));
    assert.throws(() => assertTaskAccess(store, authClaude, taskDsh), /cannot access task/);
    assert.doesNotThrow(() => assertTaskAccess(store, authMaster, taskDsh));
    assert.doesNotThrow(() => assertTaskAccess(store, authHuman, taskDsh));

    // A per-task token is pinned to exactly one task.
    const bound = verifyAgentToken(issueAgentToken(config.token, {
      agent: 'claude', taskId: taskClaude, chatId: chatA
    }), config.token);
    assert.doesNotThrow(() => assertTaskAccess(store, bound, taskClaude));
    assert.throws(() => assertTaskAccess(store, bound, taskDsh), /bound to task/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});