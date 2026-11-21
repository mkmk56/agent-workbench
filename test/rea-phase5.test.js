import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { CommunityService, looksTokenLike } from '../src/community.js';
import { registerTools } from '../src/tools.js';
import { runMigration } from '../scripts/migrate-rea-phase5.mjs';
import {
  authClaude, authMaster, authMuse, makeServices, seedChat, tempDir
} from './helpers.js';

const authAccessClaude = {
  role: 'agent', master: false, participant: 'claude', agent_id: 'agent_claude',
  principal_id: 'agent_claude', token_kind: 'access', can_post_as: ['claude'],
  can_dispatch: false, can_operate: false, deprecated: false
};
const authAccessDsh = {
  role: 'agent', master: false, participant: 'dsh', agent_id: 'agent_dsh',
  principal_id: 'agent_dsh', token_kind: 'access', can_post_as: ['dsh'],
  can_dispatch: false, can_operate: false, deprecated: false
};

function makeHarness(configOverrides = {}) {
  const dir = tempDir('rea5-');
  const services = makeServices(dir, { config: configOverrides });
  const community = new CommunityService({
    store: services.store,
    config: services.config,
    agents: services.agents,
    messages: services.messages
  });
  return { ...services, community, dir };
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
    community: services.community
  }, auth);
  return {
    invoke(name, args) {
      const handler = handlers.get(name);
      assert.ok(handler, `tool ${name} is registered`);
      return handler(args);
    }
  };
}

function ok(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function fail(result) {
  assert.equal(result.isError, true, 'expected an error result');
  const text = result.content[0].text;
  if (text.startsWith('{')) return JSON.parse(text);
  return { error: text, status: null };
}

function cleanup(dir, store) {
  try { store?.close?.(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
}

function addMember(store, chatId, agentId, role = 'member') {
  store.insertChatMember({ chat_id: chatId, agent_id: agentId, role });
  store.ensureInboxCursor({ chatId, agentId, now: Date.now() });
}

function createChat(services, overrides = {}) {
  return services.chats.create({ name: 'phase5', ...overrides });
}

// ---------------------------------------------------------------------------
// Migration v7 -> v8
// ---------------------------------------------------------------------------
test('Phase 5 migration creates four tables, backs up first and is rerunnable', async () => {
  const dir = tempDir('rea5-mig-');
  let store = null;
  try {
    const dbPath = join(dir, 'workbench.db');
    store = new Store(dbPath, dir);
    const chatId = seedChat(store, { id: 'chat-mig' });
    const now = new Date().toISOString();
    store.insertChatMessageBundle({
      id: 'msg-mig', thread_id: `chat:${chatId}`, from_agent: 'user', to_agent: 'muse',
      summary: 'old row', body: 'old row', status: 'stored', chat_id: chatId,
      mentions_json: '[]', created_at: now, updated_at: now
    });
    store.close();
    store = null;

    // Roll the schema back to a real v7 shape: the four Phase 5 tables and the
    // ledger row (plus nothing above it) are removed; the data stays.
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec('DROP TABLE IF EXISTS invite_attempts');
      raw.exec('DROP TABLE IF EXISTS join_request_notices');
      raw.exec('DROP TABLE IF EXISTS join_requests');
      raw.exec('DROP TABLE IF EXISTS group_invites');
      raw.prepare('DELETE FROM schema_version WHERE version >= 8').run();
      assert.equal(Number(raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v), 7);
    } finally {
      raw.close();
    }

    const backupDir = join(dir, 'backups');
    const first = runMigration({ dbPath, dataDir: dir, backupDir });
    assert.equal(first.schema_version, 8);
    assert.ok(existsSync(first.backup_path), 'a pre-migration snapshot exists');
    assert.match(first.backup_path, /\.pre-rea-phase5-/);
    assert.deepEqual(first.tables, [
      'group_invites', 'join_requests', 'join_request_notices', 'invite_attempts'
    ]);
    assert.equal(first.counts.messages, 1);
    assert.equal(first.counts.chats, 1);
    assert.equal(first.counts.group_invites, 0);

    store = new Store(dbPath, dir);
    assert.equal(store.schemaVersion(), 8);
    assert.equal(store.getMessage('msg-mig').body, 'old row', 'existing data survives');
    // Every time column is TEXT (ISO), matching _now().
    const info = store.db.prepare('PRAGMA table_info(join_requests)').all();
    for (const name of ['created_at', 'updated_at', 'decided_at']) {
      assert.equal(String(info.find((column) => column.name === name).type).toUpperCase(), 'TEXT');
    }
    assert.equal(store.getChat(chatId).visibility, 'link', 'existing chat visibility is untouched');
    store.close();
    store = null;

    const second = runMigration({ dbPath, dataDir: dir, backupDir, backup: false });
    assert.equal(second.schema_version, 8);
    assert.equal(Number(new DatabaseSync(dbPath).prepare(
      "SELECT COUNT(*) AS n FROM schema_version WHERE version = 8"
    ).get().n), 1);
  } finally {
    if (store) store.close();
    cleanup(dir, null);
  }
});

test('the v8 inverse drops exactly the four community tables', async () => {
  const dir = tempDir('rea5-inverse-');
  let store = null;
  try {
    store = new Store(join(dir, 'workbench.db'), dir);
    const inverse = store.db.prepare(
      'SELECT inverse FROM schema_version WHERE version = 8'
    ).get().inverse;
    store.db.exec(inverse);
    for (const table of ['group_invites', 'join_requests', 'join_request_notices', 'invite_attempts']) {
      const row = store.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(table);
      assert.equal(row, undefined, `${table} was not dropped`);
    }
  } finally {
    if (store) store.close();
    cleanup(dir, null);
  }
});

// ---------------------------------------------------------------------------
// Visibility, discovery and permissions
// ---------------------------------------------------------------------------
test('visibility defaults to private; public chats appear on discovery; agent-task is rejected', async () => {
  const services = makeHarness();
  const { store, community } = services;
  try {
    const human = makeToolRunner(services, authMaster);
    const privateChat = ok(await human.invoke('create_chat', { name: 'private one' }));
    assert.equal(privateChat.visibility, 'private');
    assert.equal(privateChat.category, null);

    const publicChat = ok(await human.invoke('create_chat', {
      name: '公开研究', category: '研究', visibility: 'public'
    }));
    assert.equal(publicChat.visibility, 'public');

    // Private chats are not discoverable and a non-member cannot read them.
    const discovered = ok(await human.invoke('list_public_chats', {}));
    assert.equal(discovered.chats.length, 1);
    assert.equal(discovered.chats[0].chat_id, publicChat.chat_id);
    assert.equal(discovered.chats[0].category, '研究');

    // A static agent token is treated like a paired access token (S1).
    const staticAgent = makeToolRunner(services, authClaude);
    assert.equal((await staticAgent.invoke('list_public_chats', {})).isError, undefined);
    // The Muse token is neither human/master nor an agent token.
    assert.equal(fail(await makeToolRunner(services, authMuse).invoke(
      'list_public_chats', {}
    )).error, 'forbidden');
    const taskToken = makeToolRunner(services, {
      ...authClaude, token_kind: 'agent-task', chat_id: publicChat.chat_id, task_id: 't1'
    });
    assert.equal(fail(await taskToken.invoke('list_public_chats', {})).error, 'forbidden');

    // Paired/static agent tokens may read discovery metadata.
    const paired = makeToolRunner(services, authAccessClaude);
    const asAgent = ok(await paired.invoke('list_public_chats', {}));
    assert.equal(asAgent.chats.length, 1);

    // Agent tokens cannot change visibility at all.
    assert.equal(
      fail(await paired.invoke('chat_set_visibility', {
        chat_id: publicChat.chat_id, visibility: 'private'
      })).error,
      'not_admin'
    );
    // Muse without a master token is not a community administrator.
    assert.equal(
      fail(await makeToolRunner(services, authMuse).invoke('chat_set_visibility', {
        chat_id: publicChat.chat_id, visibility: 'private'
      })).error,
      'not_admin'
    );

    // Same-value visibility is a no-op (no system message).
    const before = store.maxChatSeq(publicChat.chat_id);
    assert.equal(ok(await human.invoke('chat_set_visibility', {
      chat_id: publicChat.chat_id, visibility: 'public'
    })).visibility, 'public');
    assert.equal(store.maxChatSeq(publicChat.chat_id), before);
  } finally {
    cleanup(services.dir, store);
  }
});

test('token-like names and categories are rejected; category enum is enforced', async () => {
  const services = makeHarness();
  const { store } = services;
  try {
    const human = makeToolRunner(services, authMaster);
    const chat = ok(await human.invoke('create_chat', { name: 'normal' }));
    const created = fail(await human.invoke('create_chat', {
      name: 'leak pachat_abcdefghijklmnop'
    }));
    assert.equal(created.error, 'invalid_content');
    assert.equal(fail(await human.invoke('create_chat', {
      name: 'x', category: 'not-a-category'
    })).error, 'invalid_category');
    assert.equal(fail(await human.invoke('rename_chat', {
      chat_id: chat.chat_id, name: 'ghp_' + 'a'.repeat(30)
    })).error, 'invalid_content');
    assert.equal(ok(await human.invoke('chat_set_category', {
      chat_id: chat.chat_id, category: '测试'
    })).category, '测试');
    assert.equal(ok(await human.invoke('chat_set_category', {
      chat_id: chat.chat_id, category: null
    })).category, null);
    assert.ok(looksTokenLike('Bearer abcdefghijklmnopqrstuvwxyz012345'));
    assert.equal(looksTokenLike('普通的群名与说明'), false);

    const audit = readFileSync(join(services.dir, 'security-audit.log'), 'utf8');
    assert.match(audit, /event=token_like_rejected/);
    assert.equal(audit.includes('pachat_abcdefghijklmnop'), false, 'the credential is never written');
  } finally {
    cleanup(services.dir, store);
  }
});

// ---------------------------------------------------------------------------
// Invite lifecycle and join flow
// ---------------------------------------------------------------------------
test('invite codes are shown once, preview, apply, approve and consume once', async () => {
  const services = makeHarness();
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    const human = makeToolRunner(services, authMaster);
    const chat = createChat(services, { name: 'invite flow', visibility: 'link' });
    addMember(store, chat.chat_id, 'user', 'owner');

    const invite = ok(await human.invoke('group_invite_create', {
      chat_id: chat.chat_id, ttl_hours: 2, max_uses: 2
    }));
    assert.match(invite.code, /^[0-9a-f]{32}$/, '128-bit hex code');
    assert.equal(invite.max_uses, 2);

    const listed = ok(await human.invoke('group_invite_list', { chat_id: chat.chat_id }));
    assert.equal(listed.invites.length, 1);
    assert.equal(JSON.stringify(listed).includes(invite.code), false, 'the code is never listed again');

    const agent = makeToolRunner(services, authAccessClaude);
    const preview = ok(await agent.invoke('group_invite_preview', {
      chat_id: chat.chat_id, invite_code: invite.code
    }));
    assert.equal(preview.name, 'invite flow');
    assert.equal(preview.member_count >= 1, true);

    // A bad code, a missing chat and a private chat are indistinguishable.
    const badPreview = fail(await agent.invoke('group_invite_preview', {
      chat_id: chat.chat_id, invite_code: 'f'.repeat(32)
    }));
    assert.equal(badPreview.status, 404);

    // Link chats require a code.
    assert.equal(fail(await agent.invoke('chat_join_request', { chat_id: chat.chat_id })).error,
      'invite_required');

    const request = ok(await agent.invoke('chat_join_request', {
      chat_id: chat.chat_id, invite_code: invite.code, message: 'please add me'
    }));
    assert.equal(request.status, 'pending');

    // A second request while pending is a 409 (partial unique index).
    assert.equal(fail(await agent.invoke('chat_join_request', {
      chat_id: chat.chat_id, invite_code: invite.code
    })).error, 'duplicate_request');

    // The applicant still cannot read the chat before approval.
    assert.ok((await agent.invoke('list_chat_messages', { chat_id: chat.chat_id })).isError);

    // Applicant identity cannot be forged: the extra field is not in the schema
    // and the service derives it from the token.
    assert.equal(store.getJoinRequest(request.request_id).applicant_id, 'agent_claude');

    // Request produced a generic system message and an owner notice.
    const stream = services.chats.listMessages({ chat_id: chat.chat_id, limit: 50 });
    const systemRows = stream.messages.filter((message) => message.kind === 'system');
    assert.ok(systemRows.length >= 2, 'invite + request notices are system messages');
    const requestRow = systemRows.find((message) => message.body.includes('收到一份加入申请'));
    assert.ok(requestRow);
    assert.equal(requestRow.body.includes('please add me'), false, 'no applicant data in system text');
    assert.equal(requestRow.to, '*');
    assert.equal(requestRow.status, 'stored');
    assert.equal(store.listJoinNotices({ recipientId: 'user' }).length, 1);

    // Full approval: conditional update -> member -> uses+1 -> system -> notice.
    const approved = ok(await human.invoke('chat_join_approve', { request_id: request.request_id }));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.agent_id, 'agent_claude');
    assert.ok(store.getChatMember(chat.chat_id, 'agent_claude'));
    assert.ok(store.getChatParticipant(chat.chat_id, 'claude'));
    assert.ok(store.getInboxCursor(chat.chat_id, 'agent_claude'));
    assert.equal(Number(store.getGroupInvite(invite.invite_id).uses), 1);

    const approvedNotice = store.listJoinNotices({
      recipientId: 'agent_claude', read: false
    }).find((notice) => notice.notice_type === 'approved');
    assert.ok(approvedNotice);

    // Deciding twice is a 409.
    assert.equal(fail(await human.invoke('chat_join_approve', { request_id: request.request_id })).error,
      'request_already_decided');
    // The applicant can now read the chat and its own notice.
    assert.equal((await agent.invoke('list_chat_messages', { chat_id: chat.chat_id })).isError, undefined);
    const ownNotices = ok(await agent.invoke('chat_join_notices', { chat_id: chat.chat_id }));
    assert.ok(ownNotices.notices.length >= 1);
    assert.ok(ownNotices.notices.every((notice) => notice.recipient_id === 'agent_claude'));
    // mark_read only affects the caller's own notices.
    assert.equal(fail(await human.invoke('chat_join_notices', {
      mark_read: 'one', notice_id: approvedNotice.id
    })).error, 'forbidden');
    assert.equal(ok(await agent.invoke('chat_join_notices', {
      chat_id: chat.chat_id, mark_read: 'one', notice_id: approvedNotice.id
    })).notices.every((notice) => notice.recipient_id === 'agent_claude'), true);
  } finally {
    cleanup(services.dir, store);
  }
});

test('invite revocation, expiry, exhaustion and invalid-code rate limiting', async () => {
  const services = makeHarness({ inviteAttemptsPerHour: 2, groupInvitesPerChatPerDay: 3 });
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    const human = makeToolRunner(services, authMaster);
    const agent = makeToolRunner(services, authAccessClaude);

    const privateChat = createChat(services, { name: 'private' });
    assert.equal(fail(await human.invoke('group_invite_create', { chat_id: privateChat.chat_id })).error,
      'invite_not_allowed');

    const linkChat = createChat(services, { name: 'link', visibility: 'link' });
    const first = ok(await human.invoke('group_invite_create', { chat_id: linkChat.chat_id }));
    const second = ok(await human.invoke('group_invite_create', { chat_id: linkChat.chat_id }));
    const thirdInvite = ok(await human.invoke('group_invite_create', { chat_id: linkChat.chat_id }));
    assert.equal(fail(await human.invoke('group_invite_create', { chat_id: linkChat.chat_id })).error,
      'invite_create_rate_limited');

    const revoked = ok(await human.invoke('group_invite_revoke', { invite_id: first.invite_id }));
    assert.ok(revoked.revoked_at);
    assert.equal(fail(await human.invoke('group_invite_revoke', { invite_id: first.invite_id })).error,
      'invite_already_revoked');
    assert.equal(fail(await agent.invoke('chat_join_request', {
      chat_id: linkChat.chat_id, invite_code: first.code
    })).error, 'invite_invalid');

    // Third invalid code in the window trips the per-principal limit.
    const bad = async (code) => fail(await agent.invoke('chat_join_request', {
      chat_id: linkChat.chat_id, invite_code: code
    }));
    const third = await bad('a'.repeat(32));
    assert.equal(third.error, 'invite_invalid');
    const limited = await bad('b'.repeat(32));
    assert.equal(limited.error, 'join_rate_limited');
    assert.equal(limited.status, 429);

    // MF3: approve settles an expired invite before its own transaction; the
    // pending request is declined as invite_expired and the approval is 409.
    const expiring = thirdInvite;
    const expiringRequest = ok(await agent.invoke('chat_join_request', {
      chat_id: linkChat.chat_id, invite_code: expiring.code
    }));
    store.db.prepare('UPDATE group_invites SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), expiring.invite_id);
    assert.equal(fail(await human.invoke('chat_join_approve', {
      request_id: expiringRequest.request_id
    })).error, 'invite_expired');
    // MF3: the expired request is declined (not left pending), with a
    // decision_reason that the audit trail can classify.
    const expiredRow = store.getJoinRequest(expiringRequest.request_id);
    assert.equal(expiredRow.status, 'declined');
    assert.equal(expiredRow.decision_reason, 'invite_expired');
    assert.ok(store.listJoinNotices({ recipientId: 'agent_claude' })
      .some((notice) => notice.notice_type === 'declined'));
    // A second approve sees an already-decided request.
    assert.equal(fail(await human.invoke('chat_join_approve', {
      request_id: expiringRequest.request_id
    })).error, 'request_already_decided');

    // Exhausted codes are rejected for the next applicant.
    const exhausted = second;
    store.db.prepare('UPDATE group_invites SET max_uses = 1 WHERE id = ?')
      .run(exhausted.invite_id);
    const request = ok(await agent.invoke('chat_join_request', {
      chat_id: linkChat.chat_id, invite_code: exhausted.code
    }));
    ok(await human.invoke('chat_join_approve', { request_id: request.request_id }));
    assert.equal(Number(store.getGroupInvite(exhausted.invite_id).uses), 1);
    const dsh = makeToolRunner(services, authAccessDsh);
    assert.equal(fail(await dsh.invoke('chat_join_request', {
      chat_id: linkChat.chat_id, invite_code: exhausted.code
    })).error, 'invite_invalid');
  } finally {
    cleanup(services.dir, store);
  }
});

test('declining an application writes a notice and keeps the member out', async () => {
  const services = makeHarness();
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    const human = makeToolRunner(services, authMaster);
    const agent = makeToolRunner(services, authAccessClaude);
    const chat = createChat(services, { name: 'decline', visibility: 'public' });
    const request = ok(await agent.invoke('chat_join_request', {
      chat_id: chat.chat_id, message: 'hello'
    }));
    const declined = ok(await human.invoke('chat_join_decline', {
      request_id: request.request_id, reason: 'not now'
    }));
    assert.equal(declined.status, 'declined');
    assert.equal(store.getChatMember(chat.chat_id, 'agent_claude'), null);
    const notices = store.listJoinNotices({ recipientId: 'agent_claude' });
    assert.ok(notices.some((notice) => notice.notice_type === 'declined'));
    // The applicant can apply again (different request; daily limit allows 3).
    const again = ok(await agent.invoke('chat_join_request', { chat_id: chat.chat_id }));
    assert.notEqual(again.request_id, request.request_id);
    assert.equal(fail(await human.invoke('chat_join_decline', {
      request_id: request.request_id, reason: 'x'
    })).error, 'request_already_decided');
  } finally {
    cleanup(services.dir, store);
  }
});

// ---------------------------------------------------------------------------
// Admin role boundary
// ---------------------------------------------------------------------------
test('admin can edit content and view requests, but cannot manage membership', async () => {
  const services = makeHarness();
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    const human = makeToolRunner(services, authMaster);
    const admin = makeToolRunner(services, authAccessClaude);
    const chat = createChat(services, { name: 'admin boundary', visibility: 'link' });
    addMember(store, chat.chat_id, 'agent_claude', 'admin');

    assert.equal(ok(await admin.invoke('chat_set_category', {
      chat_id: chat.chat_id, category: '运营'
    })).category, '运营');
    assert.equal(ok(await admin.invoke('chat_update_settings', {
      chat_id: chat.chat_id, description: 'admin edit'
    })).settings.description, 'admin edit');

    // Content/read only: owner-only management stays closed.
    for (const [tool, args] of [
      ['group_invite_create', { chat_id: chat.chat_id }],
      ['chat_set_visibility', { chat_id: chat.chat_id, visibility: 'public' }],
      ['chat_set_role', { chat_id: chat.chat_id, agent_id: 'agent_claude', role: 'member' }],
      ['chat_join_approve', { request_id: 'missing' }]
    ]) {
      assert.equal(fail(await admin.invoke(tool, args)).error, 'not_admin', `${tool} must stay owner-only`);
    }
    // Admin may list requests/notices but only for a chat they administer.
    assert.equal(ok(await admin.invoke('chat_join_list', { chat_id: chat.chat_id })).requests.length, 0);
    assert.equal(fail(await admin.invoke('chat_join_list', {})).error, 'forbidden');
    // #11 is also available to the admin of this chat...
    assert.equal((await admin.invoke('chat_join_notices', {
      chat_id: chat.chat_id
    })).isError, undefined);
    const other = createChat(services, { name: 'other' });
    // ...but a chat they do not administer is a cross-chat admin attempt (T5).
    assert.equal(fail(await admin.invoke('chat_join_list', {
      chat_id: other.chat_id
    })).error, 'forbidden');
    assert.equal(fail(await admin.invoke('chat_join_notices', {
      chat_id: other.chat_id
    })).error, 'forbidden');

    // agent-task tokens are 403 even when bound to this chat and the agent is
    // an admin here (requireChatRole semantics).
    const taskToken = makeToolRunner(services, {
      ...authAccessClaude, token_kind: 'agent-task', chat_id: chat.chat_id, task_id: 't1'
    });
    assert.equal(fail(await taskToken.invoke('chat_set_category', {
      chat_id: chat.chat_id, category: '测试'
    })).error, 'not_admin');
    // ...but the pinned chat is readable through #10/#11 own path.
    assert.equal((await taskToken.invoke('chat_join_list', { chat_id: chat.chat_id })).isError, undefined);
    assert.equal(fail(await taskToken.invoke('chat_join_list', {
      chat_id: other.chat_id
    })).error, 'forbidden');

    // chat_set_role protections.
    assert.equal(fail(await human.invoke('chat_set_role', {
      chat_id: chat.chat_id, agent_id: 'user', role: 'member'
    })).error, 'cannot_change_owner');
    assert.equal(fail(await human.invoke('chat_set_role', {
      chat_id: chat.chat_id, agent_id: 'agent_dsh', role: 'admin'
    })).error, 'member_not_found');
    assert.equal(ok(await human.invoke('chat_set_role', {
      chat_id: chat.chat_id, agent_id: 'agent_claude', role: 'member'
    })).role, 'member');
    // Removing an admin is refused until they are demoted.
    addMember(store, chat.chat_id, 'agent_dsh', 'admin');
    assert.equal(fail(await human.invoke('chat_remove_member', {
      chat_id: chat.chat_id, agent_id: 'agent_dsh'
    })).error, 'cannot_remove_admin');
    ok(await human.invoke('chat_set_role', {
      chat_id: chat.chat_id, agent_id: 'agent_dsh', role: 'member'
    }));
    assert.equal(ok(await human.invoke('chat_remove_member', {
      chat_id: chat.chat_id, agent_id: 'agent_dsh'
    })).removed, true);
  } finally {
    cleanup(services.dir, store);
  }
});

// ---------------------------------------------------------------------------
// Visibility transitions, system message semantics and discovery limits
// ---------------------------------------------------------------------------
test('switching to private auto-declines pending requests and revokes invites', async () => {
  const services = makeHarness();
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    const human = makeToolRunner(services, authMaster);
    const agent = makeToolRunner(services, authAccessClaude);
    const chat = createChat(services, { name: 'transition', visibility: 'public' });
    const pending = ok(await agent.invoke('chat_join_request', { chat_id: chat.chat_id }));
    const invite = ok(await human.invoke('group_invite_create', { chat_id: chat.chat_id }));

    const changed = ok(await human.invoke('chat_set_visibility', {
      chat_id: chat.chat_id, visibility: 'private'
    }));
    assert.equal(changed.visibility, 'private');
    assert.equal(store.getJoinRequest(pending.request_id).status, 'declined');
    assert.equal(store.getJoinRequest(pending.request_id).decision_reason,
      'visibility_changed_to_private');
    assert.ok(store.getGroupInvite(invite.invite_id).revoked_at);
    const declinedNotice = store.listJoinNotices({ recipientId: 'agent_claude' })
      .find((notice) => notice.notice_type === 'declined');
    assert.ok(declinedNotice, 'the applicant is notified');
    // Private chats disappear from discovery.
    assert.equal(ok(await human.invoke('list_public_chats', {})).chats.length, 0);
    // The private chat now answers like a missing chat to an applicant.
    const probe = fail(await agent.invoke('chat_join_request', { chat_id: chat.chat_id }));
    assert.equal(probe.status, 404);
    assert.equal(probe.error, 'chat_not_found');

    // public -> link declines only pending requests without a code.
    const publicChat = createChat(services, { name: 'public to link', visibility: 'public' });
    const noCode = ok(await agent.invoke('chat_join_request', { chat_id: publicChat.chat_id }));
    ok(await human.invoke('chat_set_visibility', {
      chat_id: publicChat.chat_id, visibility: 'link'
    }));
    assert.equal(store.getJoinRequest(noCode.request_id).decision_reason,
      'visibility_changed_to_link');
  } finally {
    cleanup(services.dir, store);
  }
});

test('system notices: seq/status/to contract, no epoch bump, excluded from limits', async () => {
  const services = makeHarness();
  const { store, messages } = services;
  try {
    const chat = createChat(services, { name: 'system' });
    const epoch = store.chatEpoch(chat.chat_id);
    const first = messages.sendSystemNotice({
      chatId: chat.chat_id, body: '收到一份加入申请，群主可在群设置页查看。', opKey: 'test:one'
    });
    assert.equal(first.kind, 'system');
    assert.equal(first.to, '*');
    assert.equal(first.status, 'stored');
    assert.equal(first.seq, 1);
    assert.equal(store.chatEpoch(chat.chat_id), epoch, 'system notices do not bump the epoch');
    const duplicate = messages.sendSystemNotice({
      chatId: chat.chat_id, body: 'different body must not win', opKey: 'test:one'
    });
    assert.equal(duplicate.message_id, first.message_id, 'op_key is idempotent');
    assert.equal(store.maxChatSeq(chat.chat_id), 1);

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    assert.equal(store.countChatMessagesSince(chat.chat_id, since, true), 0,
      'system messages do not consume the 100/h budget');
    assert.equal(store.countChatMessagesSince(chat.chat_id, since, false), 1);
    assert.equal(store.countUnreadMessages(chat.chat_id, 'claude', 0, true), 0,
      'system-only unread does not arm the 409 gate');
    assert.equal(store.countUnreadMessages(chat.chat_id, 'claude', 0, false), 1,
      'the display layer still counts system unread');
  } finally {
    cleanup(services.dir, store);
  }
});

test('list_public_chats limits a caller and list_agents scopes an agent to shared chats', async () => {
  const services = makeHarness({ listPublicChatsPerMinute: 2 });
  const { store, agents } = services;
  try {
    agents.ensureBuiltins();
    createChat(services, { name: 'public', visibility: 'public' });
    const agent = makeToolRunner(services, authAccessClaude);
    assert.equal((await agent.invoke('list_public_chats', {})).isError, undefined);
    assert.equal((await agent.invoke('list_public_chats', {})).isError, undefined);
    const limited = fail(await agent.invoke('list_public_chats', {}));
    assert.equal(limited.error, 'rate_limited');
    assert.equal(limited.status, 429);

    // The agent sees itself; it is not in any chat, so no other agent is listed.
    const own = ok(await agent.invoke('list_agents', {}));
    assert.deepEqual(own.agents.map((entry) => entry.agent_id), ['agent_claude']);

    // Joining a chat widens visibility to that chat's members only.
    const chat = createChat(services, { name: 'shared' });
    agents.addMember({ chatId: chat.chat_id, agentId: 'claude' });
    agents.addMember({ chatId: chat.chat_id, agentId: 'dsh' });
    const shared = ok(await agent.invoke('list_agents', {}));
    assert.deepEqual(shared.agents.map((entry) => entry.agent_id).sort(),
      ['agent_claude', 'agent_dsh', 'agent_muse']);
    // Human/master sees every agent row, including Muse.
    const all = ok(await makeToolRunner(services, authMaster).invoke('list_agents', {}));
    assert.ok(all.agents.some((entry) => entry.agent_id === 'agent_muse'));
    assert.ok(all.total >= 3);
  } finally {
    cleanup(services.dir, store);
  }
});