import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import {
  deriveAgentToken, deriveAgentTokens, identifyToken, resolveSender
} from '../src/auth.js';
import { assertChatAccess, assertTaskAccess } from '../src/auth.js';
import { authClaude, authMaster, makeConfig, seedChat, seedTask, tempDir } from './helpers.js';
import { join } from 'node:path';

test('agent tokens are distinct, deterministic and identify as their executor', () => {
  const config = makeConfig('C:\\tmp\\unused');
  const tokens = deriveAgentTokens(config.token);
  assert.notEqual(tokens.claude, tokens.dsh);
  assert.notEqual(tokens.claude, config.token);
  assert.equal(tokens.claude, deriveAgentToken(config.token, 'claude'));

  assert.equal(identifyToken(config.token, config).participant, 'muse');
  assert.equal(identifyToken(tokens.claude, config).participant, 'claude');
  assert.equal(identifyToken(tokens.dsh, config).participant, 'dsh');
  assert.equal(identifyToken('unknown-token', config), null);
  assert.equal(identifyToken('', config), null);
});

test('the sender identity is derived from the token, not the request body', () => {
  assert.equal(resolveSender(authMaster, 'user'), 'user');
  assert.equal(resolveSender(authMaster, 'muse'), 'muse');
  assert.throws(() => resolveSender(authMaster, 'claude'), /master token may post/);
  assert.equal(resolveSender(authClaude, 'claude'), 'claude');
  assert.throws(() => resolveSender(authClaude, 'muse'), /token identifies as 'claude'/);
  assert.throws(() => resolveSender(authClaude, 'dsh'), /token identifies as 'claude'/);
  // Internal callers (the task-finish auto-reply path) call without an auth
  // object; tool handlers always pass one.
  assert.equal(resolveSender(null, 'claude'), 'claude');
});

test('agent chat and task access is scoped', () => {
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
    assert.doesNotThrow(() => assertChatAccess(store, authClaude, chatA));
    assert.throws(() => assertChatAccess(store, authClaude, chatB), /not a participant/);

    assert.doesNotThrow(() => assertTaskAccess(store, authClaude, taskClaude));
    assert.throws(() => assertTaskAccess(store, authClaude, taskDsh), /cannot access task/);
    assert.doesNotThrow(() => assertTaskAccess(store, authMaster, taskDsh));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});