import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAgentToken, deriveHumanToken, deriveMuseToken,
  identifyToken, resolveSender, canDispatch, assertChatAccess, assertTaskAccess,
  requireMaster, requireOperator
} from '../src/auth.js';
import {
  authClaude, authHuman, authMaster, authMuse, tempDir, makeServices, seedTask
} from './helpers.js';
import { ApprovalService } from '../src/approvals.js';

const MASTER = 'm'.repeat(48);

function authConfig() {
  return {
    token: MASTER,
    humanToken: deriveHumanToken(MASTER),
    museToken: deriveMuseToken(MASTER),
    legacyMasterEnabled: true,
    legacyAgentTokensEnabled: true,
    humanCanOperate: false,
    agentTokens: {
      claude: deriveAgentToken(MASTER, 'claude'),
      dsh: deriveAgentToken(MASTER, 'dsh')
    }
  };
}

test('tokens map to distinct principals and unknown tokens are rejected', () => {
  const config = authConfig();
  const claude = config.agentTokens.claude;
  const dsh = config.agentTokens.dsh;
  assert.notEqual(claude, MASTER);
  assert.notEqual(dsh, MASTER);
  assert.notEqual(claude, dsh);
  assert.notEqual(config.humanToken, config.museToken);

  const master = identifyToken(MASTER, config);
  assert.equal(master.master, true);
  assert.equal(master.participant, 'user');
  assert.equal(master.token_kind, 'master');
  assert.equal(master.deprecated, true);

  const human = identifyToken(config.humanToken, config);
  assert.equal(human.master, false);
  assert.equal(human.token_kind, 'human');
  assert.equal(human.can_dispatch, false);
  assert.equal(human.can_operate, false);

  const muse = identifyToken(config.museToken, config);
  assert.equal(muse.token_kind, 'muse');
  assert.equal(muse.can_dispatch, true);

  const claudeAuth = identifyToken(claude, config);
  assert.equal(claudeAuth.master, false);
  assert.equal(claudeAuth.participant, 'claude');

  assert.equal(identifyToken('not-a-token', config), null);
  assert.equal(identifyToken('', config), null);
});

test('legacy master can be revoked and cannot post as muse by default', () => {
  const config = authConfig();
  assert.equal(identifyToken(MASTER, { ...config, legacyMasterEnabled: false }), null);
  assert.throws(() => resolveSender(authMaster, 'muse'), /legacy master token may post/);
  const rollback = identifyToken(MASTER, { ...config, legacyMasterAllowMuse: true });
  assert.equal(rollback.can_post_as.includes('muse'), true);
});

test('resolveSender rejects impersonation from every principal', () => {
  assert.equal(resolveSender(authMaster, 'user'), 'user');
  assert.throws(() => resolveSender(authMaster, 'muse'), /legacy master token may post/);
  assert.equal(resolveSender(authHuman, 'user'), 'user');
  assert.throws(() => resolveSender(authHuman, 'muse'), /human token may only post/);
  assert.equal(resolveSender(authMuse, 'muse'), 'muse');
  assert.throws(() => resolveSender(authMuse, 'user'), /muse token may only post/);
  assert.equal(resolveSender(authClaude, 'claude'), 'claude');
  assert.throws(() => resolveSender(authClaude, 'muse'), /identifies as 'claude'/i);
  assert.throws(() => resolveSender(authClaude, 'dsh'), /identifies as 'claude'/i);
});

test('human cannot operate or approve; only Muse can dispatch', () => {
  assert.equal(canDispatch(authMuse), true);
  assert.equal(canDispatch(authHuman), false);
  assert.equal(canDispatch(authMaster), false);
  assert.equal(canDispatch(authClaude), false);

  assert.throws(() => requireOperator(authHuman, 'task_start'), /operator token/);
  assert.throws(() => requireOperator(authMuse, 'task_start'), /operator token/);
  assert.throws(() => requireOperator(authClaude, 'task_start'), /operator token/);
  assert.doesNotThrow(() => requireOperator(authMaster, 'task_start'));
  assert.doesNotThrow(() => requireOperator(
    { ...authHuman, can_operate: true }, 'task_start'
  ));

  assert.throws(() => requireMaster(authHuman, 'respond_approval'), /master token/);
  assert.throws(() => requireMaster(authMuse, 'respond_approval'), /master token/);
});

test('agent chat and task scope is limited to its participation', () => {
  const dir = tempDir();
  const { store } = makeServices(dir);
  try {
    store.insertChat({ chat_id: 'joined', name: 'Joined' });
    store.insertChat({ chat_id: 'other', name: 'Other' });
    store.upsertChatParticipant({ chat_id: 'joined', participant_id: 'claude', kind: 'agent', role: 'claude' });
    assert.doesNotThrow(() => assertChatAccess(store, authClaude, 'joined'));
    assert.throws(() => assertChatAccess(store, authClaude, 'other'), /not a participant/i);
    assert.deepEqual(store.listParticipantChatIds('claude'), ['joined']);

    seedTask(store, { id: 'mine', agent: 'claude', chatId: 'joined', cwd: dir });
    seedTask(store, { id: 'theirs', agent: 'dsh', chatId: 'joined', cwd: dir });
    assert.doesNotThrow(() => assertTaskAccess(store, authClaude, 'mine'));
    assert.throws(() => assertTaskAccess(store, authClaude, 'theirs'), /cannot access task/i);
    assert.doesNotThrow(() => assertTaskAccess(store, authMaster, 'theirs'));
    assert.doesNotThrow(() => assertTaskAccess(store, authHuman, 'theirs'));
  } finally {
    store.close();
  }
});

test('an executor token cannot respond to its own approval', () => {
  const dir = tempDir();
  const { store, messages, scheduler } = makeServices(dir);
  try {
    const approvals = new ApprovalService({
      store,
      config: { agentApprovalGate: true, approvalTimeoutMs: 1000, agentSummaryMaxTokens: 500 },
      messages,
      scheduler
    });
    for (const auth of [authClaude, authMuse, authHuman]) {
      assert.throws(
        () => approvals.respond({
          auth,
          decision: 'once',
          approval_id: 'anything'
        }),
        /respond_approval requires the master token|agents may not approve themselves/i
      );
    }
  } finally {
    store.close();
  }
});

test('approval session grants are keyed by chat, agent and category', () => {
  const dir = tempDir();
  const { store } = makeServices(dir);
  try {
    store.addApprovalGrant('chat-1', 'claude', 'merge', 'a1');
    assert.ok(store.getApprovalGrant('chat-1', 'claude', 'merge'));
    assert.equal(store.getApprovalGrant('chat-1', 'dsh', 'merge'), null);
    assert.equal(store.getApprovalGrant('chat-1', 'claude', 'delete'), null);
    assert.equal(store.getApprovalGrant('chat-2', 'claude', 'merge'), null);
  } finally {
    store.close();
  }
});