import type {
  AgentDirectoryEntry,
  AgentDirectoryPage,
  ChatCategory,
  ChatVisibility,
  CreatedGroupInvite,
  EngineResult,
  GroupInvite,
  GroupInvitePage,
  JoinNotice,
  JoinNoticePage,
  JoinNoticeType,
  JoinRequest,
  JoinRequestPage,
  JoinRequestStatus,
  PublicChat,
  PublicChatPage,
} from '../types';

/**
 * REA Phase 5 community client (docs/rea/PHASE5_DESIGN.md §3.2 frozen contract).
 *
 * The renderer never decides permissions: every wrapper below forwards to the
 * engine tool, and a refusal surfaces as a real error (the same rule as the
 * Phase 4 chat bridge). Normalizers accept snake_case (engine) and camelCase
 * (older bridges) and never invent rows.
 */

const NO_MAIN = '主进程未连接（浏览器预览）。';
const NO_COMMUNITY_BRIDGE = '社区接口尚未接通（IPC 桥未就绪）。';

/** D2: the ten enforced categories. */
export const CHAT_CATEGORIES: readonly ChatCategory[] = [
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
];

/** Discovery filter value for chats whose category is NULL. */
export const UNCATEGORIZED = 'uncategorized' as const;

export interface VisibilityOption {
  value: ChatVisibility;
  label: string;
  hint: string;
}

/** D1: three tiers, creation default private. */
export const VISIBILITY_OPTIONS: readonly VisibilityOption[] = [
  {
    value: 'private',
    label: '私有',
    hint: '仅成员可见，不可搜索、不可申请。切换到这里会作废待处理申请与邀请码。',
  },
  {
    value: 'link',
    label: '邀请码',
    hint: '持邀请码可申请加入；批准前不能读群消息。本机发现页不会列出。',
  },
  {
    value: 'public',
    label: '本机公开',
    hint: '出现在本机发现页（不联网、不对外发布），可无码申请。',
  },
];

export function isChatCategory(value: string): value is ChatCategory {
  return (CHAT_CATEGORIES as readonly string[]).includes(value);
}

export function categoryLabel(category: string | null | undefined): string {
  if (category == null || category.length === 0) {
    return '未分类';
  }
  return category;
}

export function visibilityLabel(visibility: string | null | undefined): string {
  switch (visibility) {
    case 'private':
      return '私有';
    case 'public':
      return '本机公开';
    case 'link':
      return '邀请码';
    default:
      return '邀请码';
  }
}

export function memberRoleLabel(role: string): string {
  if (role === 'owner') {
    return '群主';
  }
  if (role === 'admin') {
    return '管理员';
  }
  return '成员';
}

export function joinStatusLabel(status: string): string {
  switch (status) {
    case 'approved':
      return '已通过';
    case 'declined':
      return '已拒绝';
    default:
      return '待处理';
  }
}

export function noticeTypeLabel(type: JoinNoticeType | string): string {
  switch (type) {
    case 'approved':
      return '申请已通过';
    case 'declined':
      return '申请被拒绝';
    default:
      return '新的加入申请';
  }
}

export type InviteState = 'active' | 'expired' | 'exhausted' | 'revoked';

export interface InviteStatus {
  state: InviteState;
  label: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
}

/** Pure status derivation; `now` is injectable so tests stay deterministic. */
export function inviteStatus(invite: GroupInvite, now: number = Date.now()): InviteStatus {
  if (invite.revoked_at != null && invite.revoked_at.length > 0) {
    return { state: 'revoked', label: '已撤销', tone: 'error' };
  }
  if (invite.uses >= invite.max_uses) {
    return { state: 'exhausted', label: '已用完', tone: 'warning' };
  }
  if (invite.expires_at != null) {
    const expires = Date.parse(invite.expires_at);
    if (Number.isFinite(expires) && expires <= now) {
      return { state: 'expired', label: '已过期', tone: 'neutral' };
    }
  }
  return { state: 'active', label: '有效', tone: 'success' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function unwrapList(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const list = asRecord(payload)[key];
  return Array.isArray(list) ? list : [];
}

function unwrapPage(payload: unknown, key: string): { list: unknown[]; total: number; hasMore: boolean } {
  const record = asRecord(payload);
  const list = unwrapList(payload, key);
  return {
    list,
    total: readNumber(record, 'total') ?? list.length,
    hasMore: readBoolean(record, 'has_more', 'hasMore') ?? false,
  };
}

function failureMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

/* ------------------------------------------------------------------ *
 * Normalizers (pure — exported for tests)
 * ------------------------------------------------------------------ */

export function normalizePublicChat(raw: unknown): PublicChat | null {
  const record = asRecord(raw);
  const chatId = readString(record, 'chat_id', 'chatId', 'id');
  if (chatId == null) {
    return null;
  }
  return {
    chat_id: chatId,
    name: readString(record, 'name') ?? '未命名群聊',
    category: readString(record, 'category'),
    description: readString(record, 'description'),
    member_count: readNumber(record, 'member_count', 'memberCount', 'members') ?? 0,
    created_at: readString(record, 'created_at', 'createdAt'),
  };
}

export function normalizeGroupInvite(raw: unknown): GroupInvite | null {
  const record = asRecord(raw);
  const inviteId = readString(record, 'invite_id', 'inviteId', 'id');
  if (inviteId == null) {
    return null;
  }
  return {
    invite_id: inviteId,
    chat_id: readString(record, 'chat_id', 'chatId') ?? '',
    uses: readNumber(record, 'uses') ?? 0,
    max_uses: readNumber(record, 'max_uses', 'maxUses') ?? 0,
    expires_at: readString(record, 'expires_at', 'expiresAt'),
    revoked_at: readString(record, 'revoked_at', 'revokedAt'),
    created_by: readString(record, 'created_by', 'createdBy'),
  };
}

export function normalizeCreatedInvite(raw: unknown): CreatedGroupInvite | null {
  const invite = normalizeGroupInvite(raw);
  const code = readString(asRecord(raw), 'code');
  if (invite == null || code == null) {
    return null;
  }
  return { ...invite, code };
}

export function normalizeJoinRequest(raw: unknown): JoinRequest | null {
  const record = asRecord(raw);
  const requestId = readString(record, 'request_id', 'requestId', 'id');
  if (requestId == null) {
    return null;
  }
  const applicant = asRecord(record.applicant);
  const status = readString(record, 'status');
  return {
    request_id: requestId,
    chat_id: readString(record, 'chat_id', 'chatId') ?? '',
    applicant: {
      id:
        readString(applicant, 'id', 'agent_id', 'agentId') ??
        readString(record, 'applicant_id', 'applicantId') ??
        '',
      display_name:
        readString(applicant, 'display_name', 'displayName', 'name') ??
        readString(record, 'applicant_id', 'applicantId') ??
        '未知 Agent',
      platform: readString(applicant, 'platform'),
      profile: readString(applicant, 'profile'),
    },
    invite_id: readString(record, 'invite_id', 'inviteId'),
    message: readString(record, 'message'),
    status:
      status === 'approved' || status === 'declined' || status === 'pending'
        ? status
        : 'pending',
    decision_reason: readString(record, 'decision_reason', 'decisionReason'),
    created_at: readString(record, 'created_at', 'createdAt'),
    decided_by: readString(record, 'decided_by', 'decidedBy'),
  };
}

export function normalizeJoinNotice(raw: unknown): JoinNotice | null {
  const record = asRecord(raw);
  const id = readString(record, 'id', 'notice_id', 'noticeId');
  if (id == null) {
    return null;
  }
  const type = readString(record, 'notice_type', 'noticeType');
  return {
    id,
    chat_id: readString(record, 'chat_id', 'chatId') ?? '',
    request_id: readString(record, 'request_id', 'requestId') ?? '',
    notice_type:
      type === 'approved' || type === 'declined' || type === 'requested'
        ? type
        : 'requested',
    recipient_id: readString(record, 'recipient_id', 'recipientId') ?? '',
    created_at: readString(record, 'created_at', 'createdAt'),
    read_at: readString(record, 'read_at', 'readAt'),
  };
}

export function normalizeAgentDirectoryEntry(raw: unknown): AgentDirectoryEntry | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId', 'id');
  if (agentId == null) {
    return null;
  }
  const chats = record.chats;
  const chatCount =
    readNumber(record, 'chat_count', 'chatCount', 'group_count', 'groupCount') ??
    (Array.isArray(chats) ? chats.length : 0);
  return {
    agent_id: agentId,
    display_name:
      readString(record, 'display_name', 'displayName', 'name') ?? agentId,
    platform: readString(record, 'platform'),
    status: readString(record, 'status') ?? 'active',
    owner: readString(record, 'owner'),
    profile: readString(record, 'profile'),
    chat_count: chatCount,
  };
}

/* ------------------------------------------------------------------ *
 * Pure derivations used by the UI (and unit tests)
 * ------------------------------------------------------------------ */

/** Unread notices only; `read=false` is the caller's filter, this is a guard. */
export function unreadNotices(notices: JoinNotice[]): JoinNotice[] {
  return notices.filter((notice) => notice.read_at == null || notice.read_at.length === 0);
}

/** Count unread notices per chat, newest chat first (stable by first sighting). */
export function countUnreadByChat(notices: JoinNotice[]): Array<{ chatId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const notice of unreadNotices(notices)) {
    counts.set(notice.chat_id, (counts.get(notice.chat_id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([chatId, count]) => ({ chatId, count }));
}

/** The GUI holds the human token; a group with an owner row is owner-manageable. */
export function viewerIsOwner(members: Array<{ role: string }>): boolean {
  return members.some((member) => member.role === 'owner');
}

/** Copy format frozen by D3: `chat_id + ' ' + code`. */
export function inviteShareText(chatId: string, code: string): string {
  return `${chatId} ${code}`;
}

/** Display helper: 0 members is a real state, not a missing value. */
export function memberCountLabel(count: number): string {
  return `${count} 位成员`;
}

/* ------------------------------------------------------------------ *
 * Engine calls
 * ------------------------------------------------------------------ */

function api(): Window['workbench'] | null {
  return window.workbench ?? null;
}

export async function listPublicChatsOnce(input?: {
  category?: ChatCategory | 'uncategorized';
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<EngineResult<PublicChatPage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.listPublicChats == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.listPublicChats(input ?? {});
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取公开群列表失败。') };
    }
    const page = unwrapPage(result.data, 'chats');
    return {
      ok: true,
      data: {
        chats: page.list
          .map(normalizePublicChat)
          .filter((chat): chat is PublicChat => chat != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '读取公开群列表失败（主进程调用异常）。' };
  }
}

export async function setChatVisibility(input: {
  chatId: string;
  visibility: ChatVisibility;
}): Promise<EngineResult<{ chat_id: string; visibility: ChatVisibility }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatSetVisibility == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatSetVisibility(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '修改可见性失败。') };
    }
    const record = asRecord(result.data);
    const visibility = readString(record, 'visibility');
    return {
      ok: true,
      data: {
        chat_id: readString(record, 'chat_id', 'chatId') ?? input.chatId,
        visibility:
          visibility === 'private' || visibility === 'link' || visibility === 'public'
            ? visibility
            : input.visibility,
      },
    };
  } catch {
    return { ok: false, error: '修改可见性失败（主进程调用异常）。' };
  }
}

export async function setChatCategory(input: {
  chatId: string;
  category: ChatCategory | null;
}): Promise<EngineResult<{ chat_id: string; category: string | null }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatSetCategory == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatSetCategory(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '修改分类失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: {
        chat_id: readString(record, 'chat_id', 'chatId') ?? input.chatId,
        category: readString(record, 'category'),
      },
    };
  } catch {
    return { ok: false, error: '修改分类失败（主进程调用异常）。' };
  }
}

export async function createGroupInvite(input: {
  chatId: string;
  ttlHours?: number;
  maxUses?: number;
}): Promise<EngineResult<CreatedGroupInvite>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.groupInviteCreate == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.groupInviteCreate(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '创建邀请码失败。') };
    }
    const invite = normalizeCreatedInvite(result.data);
    return invite != null
      ? { ok: true, data: invite }
      : { ok: false, error: '引擎未返回邀请码，创建结果无法确认。' };
  } catch {
    return { ok: false, error: '创建邀请码失败（主进程调用异常）。' };
  }
}

export async function revokeGroupInvite(inviteId: string): Promise<EngineResult<{ invite_id: string }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.groupInviteRevoke == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.groupInviteRevoke({ inviteId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '撤销邀请码失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: { invite_id: readString(record, 'invite_id', 'inviteId') ?? inviteId },
    };
  } catch {
    return { ok: false, error: '撤销邀请码失败（主进程调用异常）。' };
  }
}

export async function listGroupInvitesOnce(input?: {
  chatId?: string;
  limit?: number;
  offset?: number;
}): Promise<EngineResult<GroupInvitePage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.groupInviteList == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.groupInviteList(input ?? {});
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取邀请码失败。') };
    }
    const page = unwrapPage(result.data, 'invites');
    return {
      ok: true,
      data: {
        invites: page.list
          .map(normalizeGroupInvite)
          .filter((invite): invite is GroupInvite => invite != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '读取邀请码失败（主进程调用异常）。' };
  }
}

export async function listJoinRequestsOnce(input?: {
  chatId?: string;
  status?: JoinRequestStatus;
  limit?: number;
  offset?: number;
}): Promise<EngineResult<JoinRequestPage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatJoinList == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatJoinList(input ?? {});
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取加入申请失败。') };
    }
    const page = unwrapPage(result.data, 'requests');
    return {
      ok: true,
      data: {
        requests: page.list
          .map(normalizeJoinRequest)
          .filter((request): request is JoinRequest => request != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '读取加入申请失败（主进程调用异常）。' };
  }
}

export async function approveJoinRequest(
  requestId: string,
): Promise<EngineResult<{ request_id: string; status: string; chat_id: string; agent_id: string }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatJoinApprove == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatJoinApprove({ requestId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '批准申请失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: {
        request_id: readString(record, 'request_id', 'requestId') ?? requestId,
        status: readString(record, 'status') ?? 'approved',
        chat_id: readString(record, 'chat_id', 'chatId') ?? '',
        agent_id: readString(record, 'agent_id', 'agentId') ?? '',
      },
    };
  } catch {
    return { ok: false, error: '批准申请失败（主进程调用异常）。' };
  }
}

export async function declineJoinRequest(input: {
  requestId: string;
  reason?: string;
}): Promise<EngineResult<{ request_id: string; status: string }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatJoinDecline == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatJoinDecline(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '拒绝申请失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: {
        request_id: readString(record, 'request_id', 'requestId') ?? input.requestId,
        status: readString(record, 'status') ?? 'declined',
      },
    };
  } catch {
    return { ok: false, error: '拒绝申请失败（主进程调用异常）。' };
  }
}

export async function listJoinNoticesOnce(input?: {
  chatId?: string;
  read?: boolean;
  limit?: number;
  offset?: number;
}): Promise<EngineResult<JoinNoticePage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatJoinNotices == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatJoinNotices(input ?? {});
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取申请通知失败。') };
    }
    const page = unwrapPage(result.data, 'notices');
    return {
      ok: true,
      data: {
        notices: page.list
          .map(normalizeJoinNotice)
          .filter((notice): notice is JoinNotice => notice != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '读取申请通知失败（主进程调用异常）。' };
  }
}

export async function markJoinNoticesRead(input: {
  markRead: 'one' | 'all';
  noticeId?: string;
  chatId?: string;
}): Promise<EngineResult<JoinNoticePage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatJoinNotices == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatJoinNotices({
      chatId: input.chatId,
      markRead: input.markRead,
      noticeId: input.noticeId,
    });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '标记通知已读失败。') };
    }
    const page = unwrapPage(result.data, 'notices');
    return {
      ok: true,
      data: {
        notices: page.list
          .map(normalizeJoinNotice)
          .filter((notice): notice is JoinNotice => notice != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '标记通知已读失败（主进程调用异常）。' };
  }
}

export async function listAgentsDirectoryOnce(input?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<EngineResult<AgentDirectoryPage>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.listAgentsDirectory == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.listAgentsDirectory(input ?? {});
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取 Agent 目录失败。') };
    }
    const page = unwrapPage(result.data, 'agents');
    return {
      ok: true,
      data: {
        agents: page.list
          .map(normalizeAgentDirectoryEntry)
          .filter((agent): agent is AgentDirectoryEntry => agent != null),
        total: page.total,
        has_more: page.hasMore,
      },
    };
  } catch {
    return { ok: false, error: '读取 Agent 目录失败（主进程调用异常）。' };
  }
}

export async function setChatRole(input: {
  chatId: string;
  agentId: string;
  role: 'admin' | 'member';
}): Promise<EngineResult<{ chat_id: string; agent_id: string; role: string }>> {
  const bridge = api();
  if (bridge == null) {
    return { ok: false, error: NO_MAIN };
  }
  if (bridge.chatSetRole == null) {
    return { ok: false, error: NO_COMMUNITY_BRIDGE };
  }
  try {
    const result = await bridge.chatSetRole(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '修改成员角色失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: {
        chat_id: readString(record, 'chat_id', 'chatId') ?? input.chatId,
        agent_id: readString(record, 'agent_id', 'agentId') ?? input.agentId,
        role: readString(record, 'role') ?? input.role,
      },
    };
  } catch {
    return { ok: false, error: '修改成员角色失败（主进程调用异常）。' };
  }
}