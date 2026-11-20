/**
 * Spec checks for the REA Phase 4 §6.3 [E] "Agent 管理" data layer
 * (`gui/src/lib/agent-registry.ts`).
 *
 * Run with:
 *   node --test --experimental-strip-types --experimental-test-isolation=none \
 *     test/agent-registry.test.ts
 *
 * What is pinned here:
 *  - The paired-agent list is the union of `chat_members` over all chats (the
 *    engine has no global agent list tool). A chat that fails is reported, not
 *    papered over, and no row without an `agent_id` becomes an agent.
 *  - Dedupe keeps the first non-null color / platform / status / joined_at; the
 *    order is owners first, then display name.
 *  - Muse (`platform === 'muse'` / `agent_id === 'agent_muse'`) and the human
 *    owner are read-only, so neither exposes the revoke action that "停用" maps
 *    onto (the engine has no enable/disable tool).
 *  - Pairing helpers never invent values: an unknown status/platform is echoed
 *    verbatim, and 0 / empty timestamps stay null.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_LIST_SOURCE_NOTE,
  BUILTIN_AGENT_IDS,
  MUSE_AGENT_ID,
  OWNER_AGENT_ID,
  agentReadOnlyReason,
  agentRoleLabel,
  agentStatusLabel,
  agentStatusTone,
  canRevokeAgent,
  describePairResult,
  formatJoinedAt,
  formatPairingExpiry,
  isBuiltinAgent,
  isExternalAgent,
  isOwnerAgent,
  isReadOnlyAgent,
  loadPairedAgents,
  mergePairedAgents,
  pairChatOptions,
  platformLabel,
  toIsoTimestamp,
  toPairedAgent,
  validatePairChatSelection,
  validatePairForm,
} from '../src/lib/agent-registry.ts';

const MINUTE = 60_000;

function member(overrides = {}) {
  return {
    agent_id: 'agent_claude',
    participant_id: 'claude',
    role: 'member',
    owner: null,
    platform: 'claude',
    display_name: 'Claude Code',
    color: '#5f656e',
    status: 'active',
    joined_at: 1_735_689_600_000,
    ...overrides,
  };
}

test('source note names the real data source', () => {
  assert.match(AGENT_LIST_SOURCE_NOTE, /各群成员/);
  assert.match(AGENT_LIST_SOURCE_NOTE, /引擎暂无全局 Agent 列表工具/);
});

test('toIsoTimestamp converts epoch ms and refuses to invent a time', () => {
  assert.equal(toIsoTimestamp(1_735_689_600_000), '2025-01-01T00:00:00.000Z');
  assert.equal(toIsoTimestamp('1735689600000'), '2025-01-01T00:00:00.000Z');
  assert.equal(toIsoTimestamp('2026-11-20T08:00:00.000Z'), '2026-11-20T08:00:00.000Z');
  assert.equal(toIsoTimestamp(0), null);
  assert.equal(toIsoTimestamp('0'), null);
  assert.equal(toIsoTimestamp(null), null);
  assert.equal(toIsoTimestamp(undefined), null);
  assert.equal(toIsoTimestamp(''), null);
});

test('toPairedAgent maps one membership row and drops rows without an agent_id', () => {
  const agent = toPairedAgent(member());
  assert.equal(agent?.agent_id, 'agent_claude');
  assert.equal(agent?.display_name, 'Claude Code');
  assert.equal(agent?.platform, 'claude');
  assert.equal(agent?.status, 'active');
  assert.equal(agent?.role, 'member');
  assert.equal(agent?.external, false);
  assert.equal(agent?.joined_at, '2025-01-01T00:00:00.000Z');

  assert.equal(toPairedAgent(member({ agent_id: '   ' })), null);
  assert.equal(toPairedAgent({ ...member(), agent_id: undefined }), null);

  const bare = toPairedAgent(
    member({
      display_name: ' ',
      platform: '',
      color: null,
      status: '',
      role: '',
      joined_at: null,
    }),
  );
  assert.equal(bare?.display_name, 'agent_claude', 'falls back to the id, not a made-up name');
  assert.equal(bare?.platform, null);
  assert.equal(bare?.color, null);
  assert.equal(bare?.status, 'unknown');
  assert.equal(bare?.role, 'member');
  assert.equal(bare?.joined_at, null);
});

test('mergePairedAgents dedupes by agent_id and keeps the first non-null fields', () => {
  const merged = mergePairedAgents([
    member({ agent_id: 'agent_dsh', display_name: 'dsh', platform: null, color: null }),
    member({ agent_id: 'agent_dsh', display_name: 'dsh', platform: 'dsh', color: '#111111' }),
    member({ agent_id: 'agent_dsh', display_name: 'ignored', platform: 'claude', status: 'revoked' }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.platform, 'dsh', 'first non-null platform wins');
  assert.equal(merged[0]?.color, '#111111');
  assert.equal(merged[0]?.status, 'active', 'first non-empty status wins');
  assert.equal(merged[0]?.display_name, 'dsh');
});

test('mergePairedAgents fills a missing status from a later chat', () => {
  const merged = mergePairedAgents([
    member({ agent_id: 'agent_x', status: '' }),
    member({ agent_id: 'agent_x', status: 'active' }),
    member({ agent_id: 'agent_y', status: 'revoked' }),
  ]);
  assert.equal(merged.find((agent) => agent.agent_id === 'agent_x')?.status, 'active');
  assert.equal(
    merged.find((agent) => agent.agent_id === 'agent_y')?.status,
    'revoked',
    'a known status is never overwritten by a later row',
  );
});

test('mergePairedAgents fills gaps from later chats and sorts owners first', () => {
  const merged = mergePairedAgents([
    member({ agent_id: 'agent_muse', display_name: 'Muse', platform: null, role: 'member' }),
    member({ agent_id: 'agent_muse', display_name: 'Muse', platform: 'muse' }),
    member({ agent_id: 'agent_claude', display_name: 'Claude Code' }),
    member({
      agent_id: OWNER_AGENT_ID,
      display_name: '我',
      platform: null,
      role: 'owner',
      owner: 'user',
    }),
  ]);
  assert.deepEqual(
    merged.map((agent) => agent.agent_id),
    [OWNER_AGENT_ID, 'agent_claude', MUSE_AGENT_ID],
    'owner row first, the rest by display name',
  );
  const muse = merged.find((agent) => agent.agent_id === MUSE_AGENT_ID);
  assert.equal(muse?.platform, 'muse', 'platform filled from the later chat');
  assert.equal(muse?.external, true, 'external is derived after the merge');
});

test('built-in identities and the human owner are read-only, so revoke is never offered', () => {
  const museById = toPairedAgent(member({ agent_id: MUSE_AGENT_ID, platform: null }));
  const museByPlatform = toPairedAgent(
    member({ agent_id: 'agent_muse_external', platform: 'muse' }),
  );
  const claude = toPairedAgent(member()); // agent_claude: built-in
  const dsh = toPairedAgent(member({ agent_id: 'agent_dsh', participant_id: 'dsh', platform: 'dsh' }));
  const owner = toPairedAgent(member({ agent_id: OWNER_AGENT_ID, role: 'owner' }));
  // A genuinely paired agent: the engine will revoke its token.
  const paired = toPairedAgent(
    member({ agent_id: 'agent_reviewer', participant_id: 'agent_reviewer', platform: 'custom' }),
  );

  assert.deepEqual([...BUILTIN_AGENT_IDS], ['agent_muse', 'agent_claude', 'agent_dsh']);
  assert.equal(isExternalAgent(museById!), true);
  assert.equal(isExternalAgent(museByPlatform!), true);
  assert.equal(isOwnerAgent(owner!), true);
  assert.equal(isBuiltinAgent(museById!), true);
  assert.equal(isBuiltinAgent(claude!), true, 'Claude is built in');
  assert.equal(isBuiltinAgent(dsh!), true, 'dsh is built in');
  assert.equal(isBuiltinAgent(paired!), false);
  assert.equal(isReadOnlyAgent(museById!), true);
  assert.equal(isReadOnlyAgent(claude!), true);
  assert.equal(isReadOnlyAgent(dsh!), true);
  assert.equal(isReadOnlyAgent(owner!), true);
  assert.equal(isReadOnlyAgent(paired!), false);

  // The engine answers cannot_revoke_builtin 403 for all three built-ins, so no
  // revoke button may be rendered for them (M3: no control that can only fail).
  assert.equal(canRevokeAgent(museById!), false);
  assert.equal(canRevokeAgent(claude!), false);
  assert.equal(canRevokeAgent(dsh!), false);
  assert.equal(
    canRevokeAgent(museByPlatform!),
    true,
    'a paired agent whose platform label says muse still owns a revocable token',
  );
  assert.equal(canRevokeAgent(owner!), false);
  assert.equal(canRevokeAgent(paired!), true);
  assert.equal(
    canRevokeAgent(toPairedAgent(member({ agent_id: 'agent_reviewer', status: 'revoked' }))!),
    false,
    'nothing left to revoke once the token is gone',
  );
});

test('the read-only label states the real reason, never a generic "只读"', () => {
  assert.equal(
    agentReadOnlyReason(toPairedAgent(member())!),
    '内置执行器，无独立 Token',
  );
  assert.equal(
    agentReadOnlyReason(toPairedAgent(member({ agent_id: MUSE_AGENT_ID, platform: 'muse' }))!),
    '内置外部 Agent，无独立 Token',
  );
  assert.equal(
    agentReadOnlyReason(toPairedAgent(member({ agent_id: OWNER_AGENT_ID, role: 'owner' }))!),
    '所有者，只读',
  );
  assert.equal(
    agentReadOnlyReason(toPairedAgent(member({ agent_id: 'agent_reviewer', status: 'revoked' }))!),
    'Token 已撤销，只读',
  );
  assert.equal(
    agentReadOnlyReason(
      toPairedAgent(member({ agent_id: 'agent_reviewer', platform: 'custom' }))!,
    ),
    null,
    'an actionable row has no read-only reason',
  );
});

test('labels echo the engine value instead of inventing one', () => {
  assert.equal(platformLabel('claude'), 'Claude Code');
  assert.equal(platformLabel('dsh'), 'dsh');
  assert.equal(platformLabel('muse'), 'Muse');
  assert.equal(platformLabel('custom-platform'), 'custom-platform');
  assert.equal(platformLabel(null), '未标注');

  assert.equal(agentStatusLabel('active'), '启用中');
  assert.equal(agentStatusLabel('revoked'), '已注销');
  assert.equal(agentStatusLabel('quarantined'), 'quarantined');
  assert.equal(agentStatusLabel(''), '未知');

  assert.equal(agentStatusTone('active'), 'success');
  assert.equal(agentStatusTone('revoked'), 'neutral');
  assert.equal(agentStatusTone('pending'), 'warning');
  assert.equal(agentStatusTone('failed'), 'error');

  assert.equal(agentRoleLabel('owner'), '所有者');
  assert.equal(agentRoleLabel('member'), '成员');
  assert.equal(agentRoleLabel('admin'), 'admin');
});

test('formatPairingExpiry shows the deadline and the remaining time', () => {
  const now = Date.UTC(2026, 10, 20, 8, 0, 0);
  const inNinety = formatPairingExpiry(now + 90 * MINUTE, now);
  assert.match(inNinety, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（剩余 1 小时 30 分）$/);

  assert.match(formatPairingExpiry(now + 5 * MINUTE, now), /剩余 5 分钟/);
  assert.match(formatPairingExpiry(now + 20_000, now), /剩余 不足 1 分钟/);
  assert.match(formatPairingExpiry(now - 1, now), /已过期/);
  assert.equal(formatPairingExpiry(0, now), '有效期未知');
  assert.equal(formatPairingExpiry(Number.NaN, now), '有效期未知');
});

test('formatJoinedAt formats ISO and passes odd values through', () => {
  const rendered = formatJoinedAt('2026-11-20T08:05:00.000Z');
  assert.match(rendered, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatJoinedAt(null), '—');
  assert.equal(formatJoinedAt('engine text'), 'engine text');
});

test('validatePairForm guards the client-side minimum only', () => {
  assert.equal(validatePairForm({ code: 'ABCD-1234', name: 'Reviewer' }), null);
  assert.equal(validatePairForm({ code: 'ABCD-1234', name: 'Reviewer', platform: 'dsh' }), null);
  assert.match(validatePairForm({ code: '  ', name: 'Reviewer' })!, /配对码不能为空/);
  assert.match(validatePairForm({ code: 'ABCD', name: '   ' })!, /名称不能为空/);
  assert.match(validatePairForm({ code: 'ABCD', name: 'x'.repeat(65) })!, /最多 64/);
  assert.match(
    validatePairForm({ code: 'ABCD', name: 'ok', platform: 'p'.repeat(33) })!,
    /最多 32/,
  );
});

test('describePairResult reads the real agent_pair envelope without inventing fields', () => {
  // Live engine shape (src/agents.js `_redeemPairingCode`):
  //   { agent: publicAgent(row), token, reclaim, pairing_id }
  assert.deepEqual(
    describePairResult({
      agent: {
        agent_id: 'agent_x',
        participant_id: 'agent_x',
        display_name: 'Reviewer',
        platform: 'custom',
        status: 'active',
        created_at: 1_735_689_600_000,
      },
      token: 'pachat_abc',
      reclaim: false,
      pairing_id: 'pair-1',
    }),
    { agentId: 'agent_x', displayName: 'Reviewer', token: 'pachat_abc' },
  );
  // Flat shapes from older engine builds stay readable.
  assert.deepEqual(describePairResult({ agent_id: 'agent_x', display_name: 'X', token: 't' }), {
    agentId: 'agent_x',
    displayName: 'X',
    token: 't',
  });
  assert.deepEqual(describePairResult({ name: 'Y' }), {
    agentId: null,
    displayName: 'Y',
    token: null,
  });
  // A nested block wins over a stale flat duplicate.
  assert.deepEqual(
    describePairResult({ agent: { agent_id: 'agent_new', display_name: 'New' }, agent_id: 'agent_old' }),
    { agentId: 'agent_new', displayName: 'New', token: null },
  );
  assert.deepEqual(describePairResult({}), { agentId: null, displayName: null, token: null });
});

test('pairChatOptions lists active chats, name-ordered, and never invents one', () => {
  const options = pairChatOptions([
    { chat_id: 'chat-b', name: 'Beta', status: 'active' },
    { chat_id: 'chat-a', name: 'Alpha', status: 'active' },
    { chat_id: 'chat-old', name: 'Old', status: 'archived' },
    { chat_id: '', name: 'No id', status: 'active' },
    { chat_id: 'chat-c', name: '  ', status: 'active' },
  ] as never);
  assert.deepEqual(
    options.map((option) => option.chat_id),
    ['chat-a', 'chat-b', 'chat-c'],
  );
  assert.equal(options[2]?.name, 'chat-c', 'an unnamed chat falls back to its id');
  assert.deepEqual(pairChatOptions(null), []);
  assert.deepEqual(pairChatOptions(undefined), []);
});

test('pairing must join at least one chat so the new agent is visible', () => {
  assert.match(validatePairChatSelection([])!, /至少选择一个群/);
  assert.match(validatePairChatSelection(null)!, /至少选择一个群/);
  assert.match(validatePairChatSelection(undefined)!, /至少选择一个群/);
  assert.equal(validatePairChatSelection(['chat-1']), null);
});

test('loadPairedAgents unions chat_members over all chats (archived included)', async () => {
  const calls = { includeArchived: undefined as boolean | undefined, chatIds: [] as string[] };
  const snapshot = await loadPairedAgents({
    listChatsOnce: async (includeArchived) => {
      calls.includeArchived = includeArchived;
      return {
        ok: true,
        data: [
          { chat_id: 'chat-1' },
          { chat_id: 'chat-2' },
        ] as never,
      };
    },
    chatMembersOnce: async (chatId) => {
      calls.chatIds.push(chatId);
      if (chatId === 'chat-1') {
        return {
          ok: true,
          data: [
            member({ agent_id: 'agent_claude', display_name: 'Claude Code' }),
            member({ agent_id: OWNER_AGENT_ID, role: 'owner', display_name: '我', platform: null }),
          ],
        };
      }
      return {
        ok: true,
        data: [
          member({ agent_id: 'agent_claude', display_name: 'Claude Code', platform: null }),
          member({ agent_id: MUSE_AGENT_ID, platform: 'muse', display_name: 'Muse' }),
        ],
      };
    },
  });

  assert.equal(calls.includeArchived, true);
  assert.deepEqual(calls.chatIds, ['chat-1', 'chat-2']);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) {
    return;
  }
  assert.equal(snapshot.data.chatCount, 2);
  assert.deepEqual(snapshot.data.errors, []);
  assert.deepEqual(
    snapshot.data.agents.map((agent) => agent.agent_id),
    [OWNER_AGENT_ID, 'agent_claude', MUSE_AGENT_ID],
  );
  const claude = snapshot.data.agents.find((agent) => agent.agent_id === 'agent_claude');
  assert.equal(claude?.platform, 'claude', 'union keeps the first non-null platform');
});

test('loadPairedAgents reports per-chat failures verbatim and stays partial', async () => {
  const snapshot = await loadPairedAgents({
    listChatsOnce: async () => ({ ok: true, data: [{ chat_id: 'chat-1' }, { chat_id: 'chat-2' }] as never }),
    chatMembersOnce: async (chatId) =>
      chatId === 'chat-1'
        ? { ok: true, data: [member()] }
        : { ok: false, error: '引擎返回 403：需要群管理员' },
  });

  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) {
    return;
  }
  assert.equal(snapshot.data.agents.length, 1);
  assert.deepEqual(snapshot.data.errors, ['chat-2：引擎返回 403：需要群管理员']);
});

test('loadPairedAgents surfaces list_chats errors instead of an empty list', async () => {
  const failed = await loadPairedAgents({
    listChatsOnce: async () => ({ ok: false, error: '读取群聊列表失败。' }),
    chatMembersOnce: async () => ({ ok: true, data: [] }),
  });
  assert.deepEqual(failed, { ok: false, error: '读取群聊列表失败。' });

  const threw = await loadPairedAgents({
    listChatsOnce: async () => {
      throw new Error('ipc down');
    },
    chatMembersOnce: async () => ({ ok: true, data: [] }),
  });
  assert.equal(threw.ok, false);
  if (!threw.ok) {
    assert.match(threw.error, /主进程调用异常/);
  }
});