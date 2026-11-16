import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAgentToken, identifyToken, resolveSender, assertChatAccess, assertTaskAccess
} from '../src/auth.js';
import { tempDir, makeServices, seedTask } from './helpers.js';
import { ApprovalService } from '../src/approvals.js';

const MASTER = 'm'.repeat(48);

function authConfig() {
  return {
    token: MASTER,
    agentTokens: {
      claude: deriveAgentToken(MASTER, 'claude'),
      dsh: deriveAgentToken(MASTER, 'dsh')
    }
  };
}

test('tokens map to distinct identities and unknown tokens are rejected', () => {
  const config = authConfig();
  const claude = config.agentTokens.claude;
  const dsh = config.agentTokens.dsh;
  assert.notEqual(claude, MASTER);
  assert.notEqual(dsh, MASTER);
  assert.notEqual(claude, dsh);

  const master = identifyToken(MASTER, config);
  assert.equal(master.master, true);
  assert.equal(master.participant, 'muse');

  const claudeAuth = identifyToken(claude, config);
  assert.equal(claudeAuth.master, false);
  assert.equal(claudeAuth.participant, 'claude');

  assert.equal(identifyToken('not-a-token', config), null);
  assert.equal(identifyToken('', config), null);
});

test('resolveSender rejects impersonation from either side', () => {
  const config = authConfig();
  const master = identifyToken(MASTER, config);
  const claude = identifyToken(config.agentTokens.claude, config);

  assert.equal(resolveSender(master, 'user'), 'user');
  assert.equal(resolveSender(master, 'muse'), 'muse');
  assert.throws(() => resolveSender(master, 'claude'), /master token may post as/i);
  assert.equal(resolveSender(claude, 'claude'), 'claude');
  assert.throws(() => resolveSender(claude, 'muse'), /identifies as 'claude'/i);
  assert.throws(() => resolveSender(claude, 'dsh'), /identifies as 'claude'/i);
});

test('agent chat and task scope is limited to its participation', () => {
  const dir = tempDir();
  const { store } = makeServices(dir);
  try {
    store.insertChat({ chat_id: 'joined', name: 'Joined' });
    store.insertChat({ chat_id: 'other', name: 'Other' });
    store.upsertChatParticipant({ chat_id: 'joined', participant_id: 'claude', kind: 'agent', role: 'claude' });
    const claude = { master: false, participant: 'claude', role: 'agent' };
    assert.doesNotThrow(() => assertChatAccess(store, claude, 'joined'));
    assert.throws(() => assertChatAccess(store, claude, 'other'), /not a participant/i);
    assert.deepEqual(store.listParticipantChatIds('claude'), ['joined']);

    seedTask(store, { id: 'mine', agent: 'claude', chatId: 'joined', cwd: dir });
    seedTask(store, { id: 'theirs', agent: 'dsh', chatId: 'joined', cwd: dir });
    assert.doesNotThrow(() => assertTaskAccess(store, claude, 'mine'));
    assert.throws(() => assertTaskAccess(store, claude, 'theirs'), /cannot access task/i);
    assert.doesNotThrow(() => assertTaskAccess(store, { master: true }, 'theirs'));
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
    assert.throws(
      () => approvals.respond({
        auth: { master: false, participant: 'claude', role: 'agent' },
        decision: 'once',
        approval_id: 'anything'
      }),
      /respond_approval requires the master token|agents may not approve themselves/i
    );
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