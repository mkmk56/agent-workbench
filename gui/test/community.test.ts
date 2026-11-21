/**
 * Spec checks for the REA Phase 5 community layer
 * (docs/rea/PHASE5_DESIGN.md D1–D7, frozen contract §3.2).
 *
 * Run with: npm run test:chat
 *
 * Fixtures mirror the engine payloads and the frozen field names. The tests
 * pin the parts the UI must not improvise: the ten-category enum, three
 * visibility tiers, invite state derivation, join-request/notice normalization
 * and the unread grouping used by the Inbox summary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_CATEGORIES,
  UNCATEGORIZED,
  categoryLabel,
  countUnreadByChat,
  inviteShareText,
  inviteStatus,
  joinStatusLabel,
  memberCountLabel,
  memberRoleLabel,
  normalizeAgentDirectoryEntry,
  normalizeCreatedInvite,
  normalizeGroupInvite,
  normalizeJoinNotice,
  normalizeJoinRequest,
  normalizePublicChat,
  unreadNotices,
  viewerIsOwner,
  visibilityLabel,
} from '../src/lib/community.ts';

const NOW = Date.parse('2026-11-21T08:00:00.000Z');

test('category enum is exactly the ten frozen labels, unique', () => {
  assert.equal(CHAT_CATEGORIES.length, 10);
  assert.equal(new Set(CHAT_CATEGORIES).size, 10);
  assert.deepEqual([...CHAT_CATEGORIES], [
    '开发',
    '研究',
    '审查',
    '学习',
    '生活',
    '创作',
    '运营',
    '测试',
    '社区',
    '其他',
  ]);
  assert.equal(UNCATEGORIZED, 'uncategorized');
});

test('null/empty category renders as 未分类, a real label passes through', () => {
  assert.equal(categoryLabel(null), '未分类');
  assert.equal(categoryLabel(''), '未分类');
  assert.equal(categoryLabel('开发'), '开发');
});

test('visibility tiers map to the Chinese labels used by the settings radios', () => {
  assert.equal(visibilityLabel('private'), '私有');
  assert.equal(visibilityLabel('link'), '邀请码');
  assert.equal(visibilityLabel('public'), '本机公开');
  // Older engines omit visibility; the historical forced value is link.
  assert.equal(visibilityLabel(undefined), '邀请码');
});

test('member roles include the Phase 5 admin tier', () => {
  assert.equal(memberRoleLabel('owner'), '群主');
  assert.equal(memberRoleLabel('admin'), '管理员');
  assert.equal(memberRoleLabel('member'), '成员');
  assert.equal(memberRoleLabel('anything-else'), '成员');
});

test('join status and member count labels', () => {
  assert.equal(joinStatusLabel('pending'), '待处理');
  assert.equal(joinStatusLabel('approved'), '已通过');
  assert.equal(joinStatusLabel('declined'), '已拒绝');
  assert.equal(memberCountLabel(0), '0 位成员');
  assert.equal(memberCountLabel(7), '7 位成员');
});

test('invite state machine: active, revoked, exhausted, expired', () => {
  const base = {
    invite_id: 'inv-1',
    chat_id: 'chat-1',
    uses: 1,
    max_uses: 10,
    expires_at: '2026-11-22T08:00:00.000Z',
    revoked_at: null,
    created_by: 'user',
  };
  assert.equal(inviteStatus(base, NOW).state, 'active');
  assert.equal(inviteStatus(base, NOW).tone, 'success');
  assert.equal(
    inviteStatus({ ...base, revoked_at: '2026-11-21T07:00:00.000Z' }, NOW).state,
    'revoked',
  );
  assert.equal(inviteStatus({ ...base, uses: 10 }, NOW).state, 'exhausted');
  assert.equal(inviteStatus({ ...base, expires_at: '2026-11-21T07:00:00.000Z' }, NOW).state, 'expired');
  // uses wins over expiry: an already-exhausted invite is reported as such.
  assert.equal(
    inviteStatus({ ...base, uses: 10, expires_at: '2026-11-21T07:00:00.000Z' }, NOW).state,
    'exhausted',
  );
});

test('invite share text follows the frozen `chat_id + space + code` format', () => {
  assert.equal(inviteShareText('chat-1', 'a'.repeat(32)), `chat-1 ${'a'.repeat(32)}`);
});

test('public chat normalizer keeps metadata only and defaults member_count', () => {
  const chat = normalizePublicChat({
    chat_id: 'chat-1',
    name: '研究组',
    category: '研究',
    description: '读论文',
    member_count: 4,
    created_at: '2026-11-20T00:00:00.000Z',
  });
  assert.ok(chat != null);
  assert.equal(chat.chat_id, 'chat-1');
  assert.equal(chat.category, '研究');
  assert.equal(chat.member_count, 4);
  const camel = normalizePublicChat({ chatId: 'chat-2', memberCount: 2 });
  assert.ok(camel != null);
  assert.equal(camel.chat_id, 'chat-2');
  assert.equal(camel.member_count, 2);
  assert.equal(normalizePublicChat({ name: '无 id' }), null);
});

test('group invite normalizer accepts engine and camelCase fields', () => {
  const invite = normalizeGroupInvite({
    invite_id: 'inv-1',
    chat_id: 'chat-1',
    uses: 2,
    max_uses: 5,
    expires_at: '2026-11-22T00:00:00.000Z',
    revoked_at: null,
    created_by: 'user',
  });
  assert.ok(invite != null);
  assert.equal(invite.uses, 2);
  assert.equal(invite.max_uses, 5);
  assert.equal(invite.revoked_at, null);
  assert.equal(normalizeGroupInvite({ chat_id: 'chat-1' }), null);
});

test('created invite requires the one-time plaintext code', () => {
  const created = normalizeCreatedInvite({
    invite_id: 'inv-1',
    chat_id: 'chat-1',
    uses: 0,
    max_uses: 10,
    code: '0123456789abcdef0123456789abcdef',
  });
  assert.ok(created != null);
  assert.equal(created.code, '0123456789abcdef0123456789abcdef');
  // A listing row without a code is not a creation result.
  assert.equal(normalizeCreatedInvite({ invite_id: 'inv-1', chat_id: 'chat-1' }), null);
});

test('join request normalizer joins the applicant profile', () => {
  const request = normalizeJoinRequest({
    request_id: 'req-1',
    chat_id: 'chat-1',
    applicant: {
      id: 'agent_x',
      display_name: 'X',
      platform: 'codex',
      profile: '外部 Agent',
    },
    invite_id: null,
    message: '想加入',
    status: 'pending',
    decision_reason: null,
    created_at: '2026-11-21T07:00:00.000Z',
    decided_by: null,
  });
  assert.ok(request != null);
  assert.equal(request.status, 'pending');
  assert.equal(request.applicant.id, 'agent_x');
  assert.equal(request.applicant.display_name, 'X');
  assert.equal(request.applicant.platform, 'codex');
  assert.equal(request.message, '想加入');

  // Legacy/defensive shape: flat applicant_id with no nested block.
  const flat = normalizeJoinRequest({
    request_id: 'req-2',
    chat_id: 'chat-1',
    applicant_id: 'agent_y',
    status: 'weird',
  });
  assert.ok(flat != null);
  assert.equal(flat.applicant.id, 'agent_y');
  assert.equal(flat.applicant.display_name, 'agent_y');
  assert.equal(flat.status, 'pending');
  assert.equal(normalizeJoinRequest({ chat_id: 'chat-1' }), null);
});

test('join notice normalizer defaults unknown types to requested', () => {
  const notice = normalizeJoinNotice({
    id: 'notice-1',
    chat_id: 'chat-1',
    request_id: 'req-1',
    notice_type: 'requested',
    recipient_id: 'user',
    created_at: '2026-11-21T07:00:00.000Z',
    read_at: null,
  });
  assert.ok(notice != null);
  assert.equal(notice.notice_type, 'requested');
  assert.equal(notice.read_at, null);

  const unknown = normalizeJoinNotice({
    id: 'notice-2',
    chat_id: 'chat-1',
    request_id: 'req-1',
    notice_type: 'other',
    recipient_id: 'user',
    created_at: null,
    read_at: null,
  });
  assert.ok(unknown != null);
  assert.equal(unknown.notice_type, 'requested');
  assert.equal(normalizeJoinNotice({ chat_id: 'chat-1' }), null);
});

test('agent directory normalizer keeps ownership and chat count', () => {
  const agent = normalizeAgentDirectoryEntry({
    agent_id: 'agent_dsh',
    display_name: 'dsh',
    platform: 'dsh',
    status: 'active',
    owner: 'user',
    profile: 'executor',
    chat_count: 3,
  });
  assert.ok(agent != null);
  assert.equal(agent.owner, 'user');
  assert.equal(agent.chat_count, 3);
  assert.equal(normalizeAgentDirectoryEntry({ display_name: 'no id' }), null);
});

test('unread notice grouping counts only unread rows, per chat', () => {
  const notices = [
    normalizeJoinNotice({
      id: 'n1',
      chat_id: 'chat-a',
      request_id: 'r1',
      notice_type: 'requested',
      recipient_id: 'user',
      read_at: null,
    }),
    normalizeJoinNotice({
      id: 'n2',
      chat_id: 'chat-a',
      request_id: 'r2',
      notice_type: 'requested',
      recipient_id: 'user',
      read_at: '2026-11-21T07:30:00.000Z',
    }),
  ].filter((item) => item != null);
  assert.equal(unreadNotices(notices).length, 1);
  assert.deepEqual(countUnreadByChat(notices), [{ chatId: 'chat-a', count: 1 }]);
});

test("another recipient's notice is never counted as my unread", () => {
  // A human/master token reads the engine feed without a recipient filter, so
  // rows written for someone else (the applicant's approved/declined notice)
  // are returned too. They can never be marked read by us, so counting them
  // produced the ghost unread badge that no action could clear.
  const theirs = normalizeJoinNotice({
    id: 'n3',
    chat_id: 'chat-b',
    request_id: 'r3',
    notice_type: 'declined',
    recipient_id: 'agent_x',
    read_at: null,
  });
  assert.ok(theirs != null);
  assert.equal(unreadNotices([theirs]).length, 0);
  assert.deepEqual(countUnreadByChat([theirs]), []);

  // The same row addressed to this viewer (e.g. a human applicant) does count.
  const mine = { ...theirs, recipient_id: 'user' };
  assert.equal(unreadNotices([mine]).length, 1);
  assert.deepEqual(countUnreadByChat([mine]), [{ chatId: 'chat-b', count: 1 }]);
});

test('viewer owner detection drives the owner-only controls', () => {
  assert.equal(viewerIsOwner([{ role: 'owner' }, { role: 'member' }]), true);
  assert.equal(viewerIsOwner([{ role: 'admin' }, { role: 'member' }]), false);
  assert.equal(viewerIsOwner([]), false);
});