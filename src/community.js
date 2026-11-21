// REA Phase 5A: community foundation.
//
// Everything here is local-only and single-user: visibility tiers, the 10
// category labels, group invite codes, join requests/notices and the narrowed
// admin role. No central server, no multi-user account model.
//
// Design references: docs/rea/PHASE5_DESIGN.md §2 (D1–D7), §3.2 (frozen tool
// contracts), §3.3 (system notices), §5 (audit/rate limits). The service owns
// the protocol errors so tools only translate an error into an MCP result.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ProtocolError, agentIdForParticipant, participantForAgentId } from './agents.js';
import { isMaster } from './auth.js';
import { auditEvent } from './audit.js';

export const CHAT_VISIBILITIES = Object.freeze(['private', 'link', 'public']);

// Phase 1's draft mentioned "19 categories" but never listed them. The design
// freezes these 10; chats.category stays a free TEXT column (app-level enum).
export const CHAT_CATEGORIES = Object.freeze([
  '开发', '研究', '审查', '学习', '生活', '创作', '运营', '测试', '社区', '其他'
]);

const INVITE_TTL_HOURS_DEFAULT = 24;
const INVITE_TTL_HOURS_MAX = 168;
const INVITE_MAX_USES_DEFAULT = 10;
const INVITE_MAX_USES_MAX = 50;
const JOIN_MESSAGE_MAX = 500;
const DECLINE_REASON_MAX = 200;
const Q_MAX = 40;

// Token-like strings are refused at every community write surface (names,
// descriptions, announcements, join messages and decline reasons). This is a
// content check, not authentication: the goal is to keep credentials out of
// chat text and audit logs.
const TOKEN_LIKE_PATTERNS = Object.freeze([
  /\bpachat_[A-Za-z0-9_-]{8,}/,
  /\bwbt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[0-9a-fA-F]{64}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i
]);

export function looksTokenLike(value) {
  if (typeof value !== 'string' || value === '') return false;
  return TOKEN_LIKE_PATTERNS.some((pattern) => pattern.test(value));
}

export function isChatCategory(value) {
  return typeof value === 'string' && CHAT_CATEGORIES.includes(value);
}

export function isChatVisibility(value) {
  return typeof value === 'string' && CHAT_VISIBILITIES.includes(value);
}

function parseChatSettings(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export class CommunityService {
  constructor({ store, config = {}, agents, messages, now = Date.now }) {
    this.store = store;
    this.config = config;
    this.agents = agents;
    this.messages = messages;
    this.now = typeof now === 'function' ? now : () => now;
    // list_public_chats is a read-only discovery surface. A tiny per-process
    // sliding window is enough for the local engine; nothing is persisted.
    this._publicChatHits = new Map();
  }

  // ------------------------------------------------------------- helpers
  _nowMs() {
    const value = this.now();
    return value instanceof Date ? value.getTime() : Number(value);
  }

  _now() {
    return new Date(this._nowMs()).toISOString();
  }

  _dayStartIso() {
    const date = new Date(this._nowMs());
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }

  _hourAgoIso() {
    return new Date(this._nowMs() - 60 * 60 * 1000).toISOString();
  }

  _audit(event, fields = {}) {
    try {
      auditEvent(this.config?.dataDir ?? this.store?.dataDir, event, fields);
    } catch { /* auditing is best effort */ }
  }

  _deny(code, status, message, details = {}, audit = null) {
    const error = new ProtocolError(code, status, message, details);
    if (audit) this._audit('access_denied', audit);
    return error;
  }

  _chat(chatId) {
    if (typeof chatId !== 'string' || chatId === '') {
      throw new ProtocolError('invalid_param', 400, 'chat_id is required');
    }
    const chat = this.store.getChat(chatId);
    if (!chat) throw new ProtocolError('chat_not_found', 404, `chat not found: ${chatId}`);
    return chat;
  }

  _humanMaster(auth) {
    return isMaster(auth) || auth?.role === 'human';
  }

  // principal_id for attempts/audit: master/human/muse keep their names, an
  // agent uses its canonical agent id.
  _principal(auth) {
    if (auth?.token_kind === 'master' || auth?.master === true) return 'master';
    if (auth?.role === 'human') return 'user';
    if (auth?.role === 'muse' || auth?.token_kind === 'muse') return 'muse';
    return auth?.agent_id ?? agentIdForParticipant(auth?.participant) ?? auth?.participant ?? 'unknown';
  }

  // Notice recipient for "my own notices". The human owner is the canonical
  // agent id 'user' regardless of which of the human/master tokens is used.
  _recipient(auth) {
    if (this._humanMaster(auth)) return 'user';
    return auth?.agent_id ?? agentIdForParticipant(auth?.participant) ?? null;
  }

  _applicantId(auth) {
    if (auth?.role !== 'agent') {
      throw new ProtocolError('unauthorized', 401, 'a paired agent identity is required to apply');
    }
    return auth.agent_id ?? agentIdForParticipant(auth.participant);
  }

  _requireHumanMaster(auth, action) {
    if (!this._humanMaster(auth)) {
      throw this._deny('not_admin', 403, `${action} requires a human or master token`, {}, {
        surface: `tool:${action}`,
        code: 'not_admin',
        status: 403,
        detail: `${action} requires a human or master token`
      });
    }
  }

  // #6/#12: human/master or a paired/static agent token. agent-task and the
  // muse token are rejected.
  _requireCommunityReader(auth, action) {
    if (this._humanMaster(auth)) return;
    if (auth?.role === 'agent'
      && (auth.token_kind === 'access' || auth.token_kind === 'agent')) return;
    throw this._deny('forbidden', 403, `${action} requires a human/master or paired agent token`, {}, {
      surface: `tool:${action}`,
      code: auth?.token_kind === 'agent-task' ? 'forbidden' : 'not_admin',
      status: 403,
      detail: `${action} requires a human/master or paired agent token`
    });
  }

  // #7: only an agent may apply. human/master cannot apply on someone's behalf.
  _requireApplicant(auth) {
    if (this._humanMaster(auth)) {
      throw this._deny('forbidden', 403, 'human/master cannot file a join request on behalf of an agent', {}, {
        surface: 'tool:chat_join_request',
        code: 'forbidden',
        status: 403,
        detail: 'human/master cannot file a join request'
      });
    }
    if (auth?.token_kind === 'agent-task') {
      throw this._deny('forbidden', 403, 'agent-task tokens cannot file join requests', {}, {
        surface: 'tool:chat_join_request',
        code: 'forbidden',
        status: 403,
        detail: 'agent-task tokens cannot file join requests'
      });
    }
    if (auth?.role !== 'agent' || (auth.token_kind !== 'access' && auth.token_kind !== 'agent')) {
      throw new ProtocolError('unauthorized', 401, 'a paired agent identity is required to apply');
    }
    return this._applicantId(auth);
  }

  // requireChatRole semantics (S2/S3): human/master pass; agent-task is always
  // 403; a paired/static agent must hold one of the requested roles.
  _requireChatRole(auth, chatId, roles, action) {
    if (this._humanMaster(auth)) return { role: 'owner' };
    if (auth?.token_kind === 'agent-task') {
      throw this._deny('not_admin', 403, `${action} is not available to agent-task tokens`, {}, {
        surface: `tool:${action}`,
        code: 'not_admin',
        status: 403,
        chat_id: chatId,
        detail: 'agent-task tokens are pinned to a task, not chat administration'
      });
    }
    if (auth?.role !== 'agent') {
      throw this._deny('not_admin', 403, `${action} requires a human/master or chat admin token`, {}, {
        surface: `tool:${action}`,
        code: 'not_admin',
        status: 403,
        chat_id: chatId
      });
    }
    const agentId = auth.agent_id ?? agentIdForParticipant(auth.participant);
    const member = this.store.getChatMember(chatId, agentId);
    if (!member || !roles.includes(member.role)) {
      throw this._deny('not_admin', 403, `${action} requires role ${roles.join(' or ')} in chat ${chatId}`, {}, {
        surface: `tool:${action}`,
        code: 'not_admin',
        status: 403,
        chat_id: chatId,
        principal_id: agentId,
        detail: `${action} requires role ${roles.join(' or ')}`
      });
    }
    return member;
  }

  _hashCode(code) {
    return createHash('sha256').update(String(code).trim()).digest('hex');
  }

  _inviteState(invite, nowIso) {
    if (!invite) return 'invalid';
    if (invite.revoked_at) return 'revoked';
    if (String(invite.expires_at) < nowIso) return 'expired';
    if (Number(invite.uses) >= Number(invite.max_uses)) return 'exhausted';
    return 'valid';
  }

  _inviteLimit() {
    return Math.max(1, Number(this.config.inviteAttemptsPerHour) || 5);
  }

  _recordAttempt({ chatId, principalId, code, success, at }) {
    this.store.insertInviteAttempt({
      id: randomUUID(),
      chat_id: chatId,
      principal_id: principalId,
      code_hash_prefix: code ? this._hashCode(code).slice(0, 8) : null,
      created_at: at,
      success: Boolean(success)
    });
  }

  _checkInviteAttemptRate({ chatId, principalId, action }) {
    const failed = this.store.countFailedInviteAttempts({
      principalId,
      chatId,
      sinceIso: this._hourAgoIso()
    });
    if (failed >= this._inviteLimit()) {
      this._audit('invite_rate_limited', { chat_id: chatId, principal_id: principalId, action });
      return false;
    }
    return true;
  }

  // Only an *invalid* code consumes the attempt budget. A valid request must
  // never be blocked because earlier bad guesses exhausted the window.
  _rejectInviteAttempt({
    chatId, principalId, code, at, action, errorCode, status, message, auditEvent, reason
  }) {
    if (!this._checkInviteAttemptRate({ chatId, principalId, action })) {
      throw new ProtocolError(
        action === 'preview' ? 'invite_rate_limited' : 'join_rate_limited', 429,
        'too many invalid invite attempts; try again later');
    }
    this._recordAttempt({ chatId, principalId, code, success: false, at });
    this._audit(auditEvent, { chat_id: chatId, principal_id: principalId, reason });
    throw new ProtocolError(errorCode, status, message);
  }

  _writeNotice({ chatId, requestId, noticeType, recipientId, at }) {
    if (!recipientId) return null;
    return this.store.insertJoinNotice({
      id: randomUUID(),
      chat_id: chatId,
      request_id: requestId,
      notice_type: noticeType,
      recipient_id: recipientId,
      created_at: at
    });
  }

  _notifyRequested({ chatId, requestId, at }) {
    const recipients = new Set(['user', ...this.store.listChatAdminIds(chatId)]);
    for (const recipientId of recipients) {
      this._writeNotice({
        chatId, requestId, noticeType: 'requested', recipientId, at
      });
    }
  }

  // Auto-decline is the normal path when an invite is revoked/exhausted or the
  // visibility changes. Runs inside the caller's transaction.
  _declinePending(requests, { reason, at, actor = 'system' }) {
    const declined = [];
    for (const request of requests) {
      if (!request || request.status !== 'pending') continue;
      this.store.updateJoinRequest(request.id, {
        status: 'declined',
        decision_reason: reason,
        updated_at: at,
        decided_by: actor,
        decided_at: at
      });
      this._writeNotice({
        chatId: request.chat_id,
        requestId: request.id,
        noticeType: 'declined',
        recipientId: request.applicant_id,
        at
      });
      this.store.markJoinRequestNoticesRead(request.id, at);
      this._audit('chat_join_auto_declined', {
        chat_id: request.chat_id,
        request_id: request.id,
        reason
      });
      declined.push(request.id);
    }
    return declined;
  }

  _pendingForChat(chatId) {
    return this.store.listJoinRequests({ chatId, status: 'pending', limit: 500 });
  }

  // MF3: an expired invite is terminal for the requests that used it. #8 and
  // #10 read the invite state and settle it here instead of leaving the rows
  // pending forever. Runs in its own transaction so a caller that subsequently
  // rejects an approval does not roll the settlement back.
  _sweepExpiredInvites({ chatId = null, inviteId = null, now = this._now() } = {}) {
    const pending = this.store.listJoinRequests({
      chatId, status: 'pending', inviteId, limit: 500
    }).filter((request) => request.invite_id);
    const expired = [];
    for (const request of pending) {
      const invite = this.store.getGroupInvite(request.invite_id);
      if (!invite || invite.revoked_at) continue;
      if (String(invite.expires_at) < now) expired.push(request);
    }
    if (expired.length === 0) return [];
    return this.store._transaction(() => this._declinePending(expired, {
      reason: 'invite_expired', at: now
    }));
  }

  _systemNotice(chatId, body, opKey) {
    if (!this.messages?.sendSystemNotice) return null;
    return this.messages.sendSystemNotice({ chatId, body, opKey });
  }

  // ------------------------------------------------------- #1 visibility
  setVisibility({ auth, chatId, visibility }) {
    this._requireHumanMaster(auth, 'chat_set_visibility');
    if (!isChatVisibility(visibility)) {
      throw new ProtocolError('invalid_visibility', 400,
        `visibility must be one of ${CHAT_VISIBILITIES.join(', ')}`);
    }
    const chat = this._chat(chatId);
    const oldVisibility = chat.visibility ?? 'link';
    // Same-value call is a no-op: no audit, no notice, no pending side effects.
    if (oldVisibility === visibility) return { chat_id: chat.chat_id, visibility };
    const now = this._now();
    return this.store._transaction(() => {
      this.store.updateChat(chat.chat_id, { visibility });
      if (visibility === 'private') {
        this._declinePending(this._pendingForChat(chat.chat_id), {
          reason: 'visibility_changed_to_private', at: now
        });
        this.store.revokeActiveGroupInvites(chat.chat_id, now);
      } else if (oldVisibility === 'public' && visibility === 'link') {
        const withoutCode = this._pendingForChat(chat.chat_id)
          .filter((request) => !request.invite_id);
        this._declinePending(withoutCode, { reason: 'visibility_changed_to_link', at: now });
      }
      this._systemNotice(chat.chat_id, '本群可见性已变更。',
        `chat:${chat.chat_id}:visibility:${oldVisibility}->${visibility}:${now}`);
      this._audit('chat_visibility_changed', {
        chat_id: chat.chat_id, old: oldVisibility, new: visibility, by: this._principal(auth)
      });
      return { chat_id: chat.chat_id, visibility };
    });
  }

  // --------------------------------------------------------- #2 category
  setCategory({ auth, chatId, category }) {
    const chat = this._chat(chatId);
    this._requireChatRole(auth, chat.chat_id, ['owner', 'admin'], 'chat_set_category');
    if (category !== null && !isChatCategory(category)) {
      throw new ProtocolError('invalid_category', 400,
        `category must be one of ${CHAT_CATEGORIES.join(', ')} or null`);
    }
    const updated = this.store.updateChat(chat.chat_id, { category: category ?? null });
    this._audit('chat_settings_updated', {
      chat_id: chat.chat_id, by: this._principal(auth), fields: 'category'
    });
    return { chat_id: updated.chat_id, category: updated.category ?? null };
  }

  // ------------------------------------------------------ #3 invite create
  createInvite({ auth, chatId, ttlHours, maxUses }) {
    this._requireHumanMaster(auth, 'group_invite_create');
    const chat = this._chat(chatId);
    if ((chat.status ?? 'active') === 'archived') {
      throw new ProtocolError('chat_archived', 400, `chat ${chat.chat_id} is archived`);
    }
    if ((chat.visibility ?? 'link') === 'private') {
      throw new ProtocolError('invite_not_allowed', 400,
        'invite codes are not allowed for a private chat');
    }
    const ttl = ttlHours === undefined || ttlHours === null
      ? INVITE_TTL_HOURS_DEFAULT : Number(ttlHours);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > INVITE_TTL_HOURS_MAX) {
      throw new ProtocolError('invalid_param', 400,
        `ttl_hours must be between 1 and ${INVITE_TTL_HOURS_MAX}`);
    }
    const uses = maxUses === undefined || maxUses === null
      ? INVITE_MAX_USES_DEFAULT : Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_MAX_USES_MAX) {
      throw new ProtocolError('invalid_param', 400,
        `max_uses must be between 1 and ${INVITE_MAX_USES_MAX}`);
    }
    const perDay = Math.max(1, Number(this.config.groupInvitesPerChatPerDay) || 20);
    if (this.store.countGroupInvitesSince(chat.chat_id, this._dayStartIso()) >= perDay) {
      this._audit('invite_rate_limited', {
        chat_id: chat.chat_id, principal_id: this._principal(auth), action: 'create'
      });
      throw new ProtocolError('invite_create_rate_limited', 429,
        `chat ${chat.chat_id} reached ${perDay} invite codes today`, { limit: perDay });
    }
    const now = this._now();
    const code = randomBytes(16).toString('hex'); // 128-bit, shown once
    const expiresAt = new Date(this._nowMs() + ttl * 60 * 60 * 1000).toISOString();
    return this.store._transaction(() => {
      const invite = this.store.insertGroupInvite({
        id: randomUUID(),
        chat_id: chat.chat_id,
        code_hash: this._hashCode(code),
        created_by: this._principal(auth),
        max_uses: uses,
        uses: 0,
        expires_at: expiresAt,
        created_at: now
      });
      this._systemNotice(chat.chat_id, '本群邀请码已更新（创建/撤销）。',
        `invite:${invite.id}:created`);
      this._audit('group_invite_created', {
        chat_id: chat.chat_id,
        invite_id: invite.id,
        max_uses: uses,
        ttl_hours: ttl,
        by: this._principal(auth)
      });
      return {
        invite_id: invite.id,
        chat_id: chat.chat_id,
        code,
        expires_at: invite.expires_at,
        max_uses: Number(invite.max_uses)
      };
    });
  }

  // ------------------------------------------------------ #4 invite revoke
  revokeInvite({ auth, inviteId }) {
    this._requireHumanMaster(auth, 'group_invite_revoke');
    const invite = this.store.getGroupInvite(inviteId);
    if (!invite) throw new ProtocolError('invite_not_found', 404, `invite not found: ${inviteId}`);
    if (invite.revoked_at) {
      throw new ProtocolError('invite_already_revoked', 409, `invite ${inviteId} is already revoked`);
    }
    const now = this._now();
    return this.store._transaction(() => {
      const changed = this.store.revokeGroupInvite(invite.id, now);
      if (!changed) {
        throw new ProtocolError('invite_already_revoked', 409, `invite ${inviteId} is already revoked`);
      }
      const dependents = this.store.listJoinRequests({
        chatId: invite.chat_id, status: 'pending', inviteId: invite.id, limit: 500
      });
      this._declinePending(dependents, { reason: 'invite_revoked', at: now });
      this._systemNotice(invite.chat_id, '本群邀请码已更新（创建/撤销）。',
        `invite:${invite.id}:revoked`);
      this._audit('group_invite_revoked', {
        chat_id: invite.chat_id, invite_id: invite.id, by: this._principal(auth)
      });
      return { invite_id: invite.id, revoked_at: now };
    });
  }

  // -------------------------------------------------------- #5 invite list
  listInvites({ auth, chatId, limit, offset }) {
    this._requireHumanMaster(auth, 'group_invite_list');
    if (chatId) this._chat(chatId);
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const o = Math.max(0, Number(offset) || 0);
    const total = this.store.countGroupInvites({ chatId: chatId ?? null });
    const rows = this.store.listGroupInvites({ chatId: chatId ?? null, limit: n, offset: o });
    return {
      invites: rows.map((row) => ({
        invite_id: row.id,
        chat_id: row.chat_id,
        uses: Number(row.uses),
        max_uses: Number(row.max_uses),
        expires_at: row.expires_at,
        revoked_at: row.revoked_at ?? null,
        created_by: row.created_by
      })),
      total,
      has_more: o + rows.length < total
    };
  }

  // ----------------------------------------------------- #6 invite preview
  previewInvite({ auth, chatId, inviteCode }) {
    this._requireCommunityReader(auth, 'group_invite_preview');
    if (typeof chatId !== 'string' || chatId === '') {
      throw new ProtocolError('invalid_param', 400, 'chat_id is required');
    }
    if (typeof inviteCode !== 'string' || inviteCode.trim() === '') {
      throw new ProtocolError('invalid_param', 400, 'invite_code is required');
    }
    const principalId = this._principal(auth);
    const now = this._now();
    const chat = this.store.getChat(chatId);
    // Missing, private and archived are indistinguishable where the code is
    // invalid. An archived public chat is a distinct 404 after a valid code.
    if (!chat || (chat.visibility ?? 'link') === 'private') {
      this._rejectInviteAttempt({
        chatId, principalId, code: inviteCode, at: now, action: 'preview',
        errorCode: 'not_found', status: 404, message: 'invite is not valid',
        auditEvent: 'group_invite_preview_rejected', reason: 'invalid'
      });
    }
    const invite = this.store.getGroupInviteByHash(this._hashCode(inviteCode));
    const state = this._inviteState(invite, now);
    if (state !== 'valid' || invite.chat_id !== chatId) {
      this._rejectInviteAttempt({
        chatId, principalId, code: inviteCode, at: now, action: 'preview',
        errorCode: 'not_found', status: 404, message: 'invite is not valid',
        auditEvent: 'group_invite_preview_rejected', reason: 'invalid'
      });
    }
    this._recordAttempt({ chatId, principalId, code: inviteCode, success: true, at: now });
    if ((chat.status ?? 'active') === 'archived') {
      throw new ProtocolError('chat_archived', 404, `chat ${chatId} is archived`);
    }
    const settings = parseChatSettings(chat.settings);
    return {
      chat_id: chat.chat_id,
      name: chat.name,
      category: chat.category ?? null,
      description: settings.description ?? null,
      member_count: this.store.countChatMembers(chat.chat_id)
    };
  }

  // ------------------------------------------------------ #7 join request
  requestJoin({ auth, chatId, inviteCode, message }) {
    const applicantId = this._requireApplicant(auth);
    const chat = this.store.getChat(chatId);
    // Anti-probing: a private chat and a missing chat are the same 404.
    if (!chat || (chat.visibility ?? 'link') === 'private') {
      throw new ProtocolError('chat_not_found', 404, `chat not found: ${chatId}`);
    }
    if ((chat.status ?? 'active') === 'archived') {
      throw new ProtocolError('chat_archived', 400, `chat ${chatId} is archived`);
    }
    if (this.store.getChatMember(chat.chat_id, applicantId)) {
      throw new ProtocolError('already_member', 409, `agent ${applicantId} is already a member`);
    }
    const agent = this.store.getAgent(applicantId);
    if (!agent || agent.status !== 'active') {
      throw new ProtocolError('agent_inactive', 403, `agent ${applicantId} is not active`);
    }
    let text = message === undefined || message === null ? null : String(message);
    if (text !== null && text.length > JOIN_MESSAGE_MAX) {
      throw new ProtocolError('invalid_content', 400,
        `message must be at most ${JOIN_MESSAGE_MAX} characters`);
    }
    if (text !== null && looksTokenLike(text)) {
      this._audit('token_like_rejected', {
        chat_id: chat.chat_id, tool: 'chat_join_request', field: 'message',
        principal_id: this._principal(auth)
      });
      throw new ProtocolError('invalid_content', 400, 'message looks like a credential');
    }
    const principalId = this._principal(auth);
    const now = this._now();

    let invite = null;
    if (inviteCode !== undefined && inviteCode !== null && String(inviteCode).trim() !== '') {
      invite = this.store.getGroupInviteByHash(this._hashCode(inviteCode));
      const state = this._inviteState(invite, now);
      if (state !== 'valid' || invite.chat_id !== chat.chat_id) {
        this._rejectInviteAttempt({
          chatId: chat.chat_id, principalId, code: inviteCode, at: now, action: 'join_request',
          errorCode: 'invite_invalid', status: 400, message: 'invite code is not valid',
          auditEvent: 'group_invite_rejected',
          reason: state === 'valid' ? 'invalid' : state
        });
      }
    } else if ((chat.visibility ?? 'link') === 'link') {
      throw new ProtocolError('invite_required', 400,
        'this chat requires an invite code');
    }

    // Daily limits: 3 per applicant per chat, 10 per agent site-wide.
    const dayStart = this._dayStartIso();
    const perChat = Math.max(1, Number(this.config.joinRequestsPerChatPerDay) || 3);
    const perAgent = Math.max(1, Number(this.config.joinRequestsPerDay) || 10);
    if (this.store.countJoinRequestsSince({
      applicantId, chatId: chat.chat_id, sinceIso: dayStart
    }) >= perChat) {
      throw new ProtocolError('join_rate_limited', 429,
        `agent ${applicantId} reached ${perChat} requests for this chat today`, { limit: perChat });
    }
    if (this.store.countJoinRequestsSince({ applicantId, sinceIso: dayStart }) >= perAgent) {
      throw new ProtocolError('join_rate_limited', 429,
        `agent ${applicantId} reached ${perAgent} requests today`, { limit: perAgent });
    }
    const pendingCap = Math.max(1, Number(this.config.joinRequestsPendingPerChat) || 50);
    if (this.store.countPendingJoinRequests(chat.chat_id) >= pendingCap) {
      throw new ProtocolError('join_rate_limited', 429,
        `chat ${chat.chat_id} already has ${pendingCap} pending requests`, { limit: pendingCap });
    }
    if (this.store.getPendingJoinRequest(chat.chat_id, applicantId)) {
      throw new ProtocolError('duplicate_request', 409,
        'a pending request already exists for this chat');
    }

    return this.store._transaction(() => {
      let request;
      try {
        request = this.store.insertJoinRequest({
          id: randomUUID(),
          chat_id: chat.chat_id,
          applicant_id: applicantId,
          invite_id: invite?.id ?? null,
          message: text,
          status: 'pending',
          created_at: now,
          updated_at: now
        });
      } catch (error) {
        // The partial unique index is the real guard against two concurrent
        // requests from the same applicant.
        if (/UNIQUE constraint failed/i.test(error?.message ?? '')) {
          throw new ProtocolError('duplicate_request', 409,
            'a pending request already exists for this chat');
        }
        throw error;
      }
      // A successful request is the only attempt row for this call.
      this._recordAttempt({
        chatId: chat.chat_id, principalId, code: inviteCode, success: true, at: now
      });
      this._notifyRequested({ chatId: chat.chat_id, requestId: request.id, at: now });
      this._systemNotice(chat.chat_id, '收到一份加入申请，群主可在群设置页查看。',
        `join:${request.id}:requested`);
      this._audit('chat_join_requested', {
        chat_id: chat.chat_id,
        request_id: request.id,
        applicant_id: applicantId,
        invite_id: invite?.id ?? null
      });
      return { request_id: request.id, status: 'pending' };
    });
  }

  // ------------------------------------------------------ #8 join approve
  approveJoin({ auth, requestId }) {
    this._requireHumanMaster(auth, 'chat_join_approve');
    const actor = this._principal(auth);
    const now = this._now();
    // MF3: if the request's code has expired, decline it (and every sibling on
    // the same code) instead of approving. The settlement is committed before
    // the 409 below, so the decline is not rolled back.
    const preflight = this.store.getJoinRequest(requestId);
    if (preflight?.status === 'pending' && preflight.invite_id) {
      const invite = this.store.getGroupInvite(preflight.invite_id);
      if (invite && !invite.revoked_at && String(invite.expires_at) < now) {
        this._sweepExpiredInvites({
          chatId: preflight.chat_id, inviteId: invite.id, now
        });
        throw new ProtocolError('invite_expired', 409,
          'the invite expired; the pending request was declined');
      }
    }
    return this.store._transaction(() => {
      const request = this.store.getJoinRequest(requestId);
      if (!request) {
        throw new ProtocolError('request_not_found', 404, `request not found: ${requestId}`);
      }
      if (request.status !== 'pending') {
        throw new ProtocolError('request_already_decided', 409,
          `request ${requestId} is already ${request.status}`);
      }
      // Re-read the chat inside the transaction: visibility/status may have
      // changed since the request was filed.
      const chat = this.store.getChat(request.chat_id);
      if (!chat) throw new ProtocolError('chat_not_found', 404, `chat not found: ${request.chat_id}`);
      if ((chat.status ?? 'active') === 'archived') {
        throw new ProtocolError('chat_archived', 400, `chat ${chat.chat_id} is archived`);
      }
      const visibility = chat.visibility ?? 'link';
      if (visibility === 'private') {
        throw new ProtocolError('chat_private', 409,
          `chat ${chat.chat_id} is private; the request cannot be approved`);
      }
      let invite = null;
      if (visibility === 'link') {
        invite = request.invite_id ? this.store.getGroupInvite(request.invite_id) : null;
        const state = this._inviteState(invite, now);
        if (state !== 'valid') {
          throw new ProtocolError('invite_invalid', 409,
            'the invite attached to this request is no longer valid');
        }
      }
      // ① Conditional update is the concurrency guard.
      const changed = this.store.approveJoinRequest(request.id, { decidedBy: actor, now });
      if (!changed) {
        throw new ProtocolError('request_already_decided', 409,
          `request ${requestId} was already decided`);
      }
      // ② Member insert (also writes chat_participants + inbox_cursors).
      const member = this.agents.addMember({
        chatId: chat.chat_id, agentId: request.applicant_id
      });
      // ③ Consume the invite only for link chats.
      if (invite) {
        const consumed = this.store.consumeGroupInvite(invite.id, now);
        this._audit('group_invite_used', {
          chat_id: chat.chat_id, invite_id: invite.id, applicant_id: request.applicant_id
        });
        // ⑥ Exhaustion sweep: pending requests holding the same code are no
        // longer approvable.
        if (Number(consumed.uses) >= Number(consumed.max_uses)) {
          const exhausted = this.store.listJoinRequests({
            chatId: chat.chat_id, status: 'pending', inviteId: invite.id, limit: 500
          }).filter((row) => row.id !== request.id);
          this._declinePending(exhausted, { reason: 'invite_exhausted', at: now });
        }
      }
      // ④ System notice (generic, no applicant data).
      this._systemNotice(chat.chat_id, '一份加入申请已通过，欢迎新成员加入本群。',
        `join:${request.id}:approved`);
      // ⑤ Applicant notice + retire the owners' pending reminder.
      this._writeNotice({
        chatId: chat.chat_id,
        requestId: request.id,
        noticeType: 'approved',
        recipientId: request.applicant_id,
        at: now
      });
      this.store.markJoinRequestNoticesRead(request.id, now);
      this._audit('chat_join_approved', {
        chat_id: chat.chat_id,
        request_id: request.id,
        applicant_id: request.applicant_id,
        by: actor
      });
      return {
        request_id: request.id,
        status: 'approved',
        chat_id: chat.chat_id,
        agent_id: member?.agent_id ?? request.applicant_id
      };
    });
  }

  // ------------------------------------------------------ #9 join decline
  declineJoin({ auth, requestId, reason }) {
    this._requireHumanMaster(auth, 'chat_join_decline');
    let text = reason === undefined || reason === null ? null : String(reason);
    if (text !== null && text.length > DECLINE_REASON_MAX) {
      throw new ProtocolError('invalid_reason', 400,
        `reason must be at most ${DECLINE_REASON_MAX} characters`);
    }
    if (text !== null && looksTokenLike(text)) {
      this._audit('token_like_rejected', {
        tool: 'chat_join_decline', field: 'reason', principal_id: this._principal(auth)
      });
      throw new ProtocolError('invalid_reason', 400, 'reason looks like a credential');
    }
    const actor = this._principal(auth);
    const now = this._now();
    return this.store._transaction(() => {
      const request = this.store.getJoinRequest(requestId);
      if (!request) {
        throw new ProtocolError('request_not_found', 404, `request not found: ${requestId}`);
      }
      if (request.status !== 'pending') {
        throw new ProtocolError('request_already_decided', 409,
          `request ${requestId} is already ${request.status}`);
      }
      this.store.updateJoinRequest(request.id, {
        status: 'declined',
        decision_reason: text,
        updated_at: now,
        decided_by: actor,
        decided_at: now
      });
      this._systemNotice(request.chat_id, '一份加入申请已被拒绝。',
        `join:${request.id}:declined`);
      this._writeNotice({
        chatId: request.chat_id,
        requestId: request.id,
        noticeType: 'declined',
        recipientId: request.applicant_id,
        at: now
      });
      this.store.markJoinRequestNoticesRead(request.id, now);
      this._audit('chat_join_declined', {
        chat_id: request.chat_id,
        request_id: request.id,
        applicant_id: request.applicant_id,
        by: actor,
        reason: text ?? undefined
      });
      return { request_id: request.id, status: 'declined' };
    });
  }

  // ---------------------------------------------------------- #10 join list
  listJoinRequests({ auth, chatId, status, limit, offset }) {
    if (status !== undefined && status !== null
      && !['pending', 'approved', 'declined'].includes(status)) {
      throw new ProtocolError('invalid_param', 400,
        'status must be pending, approved or declined');
    }
    let applicantFilter = null;
    let scopedChat = chatId ?? null;
    if (!this._humanMaster(auth)) {
      if (auth?.token_kind === 'agent-task') {
        if (!scopedChat || auth.chat_id !== scopedChat) {
          throw this._deny('forbidden', 403,
            'agent-task tokens must pass the chat they are bound to', {}, {
              surface: 'tool:chat_join_list', code: 'forbidden', status: 403,
              chat_id: scopedChat ?? ''
            });
        }
        applicantFilter = this._applicantId(auth);
      } else if (auth?.role === 'agent') {
        const own = auth.agent_id ?? agentIdForParticipant(auth.participant);
        let admin = false;
        const isAdminSomewhere = this.store.listAgentAdminChatIds(own).length > 0;
        if (scopedChat) {
          const member = this.store.getChatMember(scopedChat, own);
          admin = Boolean(member && (member.role === 'admin' || member.role === 'owner'));
          if (!admin && isAdminSomewhere) {
            // T5: an admin cannot use a chat they do not administer as an
            // admin scope, and cannot fall back to a cross-chat view.
            throw this._deny('forbidden', 403,
              'a chat admin must pass the chat_id they administer', {}, {
                surface: 'tool:chat_join_list', code: 'forbidden', status: 403,
                chat_id: scopedChat, principal_id: own
              });
          }
        } else if (isAdminSomewhere) {
          throw this._deny('forbidden', 403,
            'a chat admin must pass the chat_id they administer', {}, {
              surface: 'tool:chat_join_list', code: 'forbidden', status: 403,
              principal_id: own
            });
        } else {
          // A plain applicant may list its own requests across chats.
          applicantFilter = own;
        }
        if (scopedChat && !admin) applicantFilter = own;
      } else {
        throw this._deny('not_admin', 403, 'chat_join_list requires a human/master, admin or applicant token', {}, {
          surface: 'tool:chat_join_list', code: 'not_admin', status: 403
        });
      }
    }
    // MF3: reading the list settles expired-invite pendings first. A scoped
    // read touches only that chat; a human/master global read sweeps all.
    if (this._humanMaster(auth) || scopedChat) {
      this._sweepExpiredInvites({ chatId: scopedChat ?? null });
    }
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const o = Math.max(0, Number(offset) || 0);
    const filter = {
      chatId: scopedChat ?? null,
      status: status ?? null,
      applicantId: applicantFilter,
      limit: n,
      offset: o
    };
    const total = this.store.countJoinRequests(filter);
    const rows = this.store.listJoinRequests(filter);
    return {
      requests: rows.map((row) => {
        const agent = row.applicant_id === 'user' ? null : this.store.getAgent(row.applicant_id);
        return {
          request_id: row.id,
          chat_id: row.chat_id,
          applicant: {
            id: row.applicant_id,
            display_name: agent?.display_name ?? (row.applicant_id === 'user' ? 'User' : row.applicant_id),
            platform: agent?.platform ?? null,
            profile: agent?.profile ?? null
          },
          invite_id: row.invite_id ?? null,
          message: row.message ?? null,
          status: row.status,
          decision_reason: row.decision_reason ?? null,
          created_at: row.created_at,
          decided_by: row.decided_by ?? null
        };
      }),
      total,
      has_more: o + rows.length < total
    };
  }

  // ------------------------------------------------------ #11 join notices
  listJoinNotices({ auth, chatId, read, markRead, noticeId, limit, offset }) {
    const ownRecipient = this._recipient(auth);
    let recipientFilter = null;
    let scopedChat = chatId ?? null;
    if (!this._humanMaster(auth)) {
      if (auth?.token_kind === 'agent-task') {
        if (!scopedChat || auth.chat_id !== scopedChat) {
          throw this._deny('forbidden', 403,
            'agent-task tokens must pass the chat they are bound to', {}, {
              surface: 'tool:chat_join_notices', code: 'forbidden', status: 403,
              chat_id: scopedChat ?? ''
            });
        }
        recipientFilter = ownRecipient;
      } else if (auth?.role === 'agent') {
        const own = auth.agent_id ?? agentIdForParticipant(auth.participant);
        let admin = false;
        const isAdminSomewhere = this.store.listAgentAdminChatIds(own).length > 0;
        if (scopedChat) {
          const member = this.store.getChatMember(scopedChat, own);
          admin = Boolean(member && (member.role === 'admin' || member.role === 'owner'));
          if (!admin && isAdminSomewhere) {
            throw this._deny('forbidden', 403,
              'a chat admin must pass the chat_id they administer', {}, {
                surface: 'tool:chat_join_notices', code: 'forbidden', status: 403,
                chat_id: scopedChat, principal_id: own
              });
          }
        } else if (isAdminSomewhere) {
          throw this._deny('forbidden', 403,
            'a chat admin must pass the chat_id they administer', {}, {
              surface: 'tool:chat_join_notices', code: 'forbidden', status: 403,
              principal_id: own
            });
        }
        if (!admin) recipientFilter = own;
      } else {
        throw this._deny('not_admin', 403, 'chat_join_notices requires a human/master, admin or applicant token', {}, {
          surface: 'tool:chat_join_notices', code: 'not_admin', status: 403
        });
      }
    }
    const now = this._now();
    if (markRead === 'one') {
      if (!noticeId) {
        throw new ProtocolError('missing_notice_id',
          400, "notice_id is required when mark_read='one'");
      }
      const notice = this.store.getJoinNotice(noticeId);
      if (!notice || notice.recipient_id !== ownRecipient) {
        throw new ProtocolError('forbidden', 403, 'you can only mark your own notices as read');
      }
      this.store.markJoinNoticeRead(notice.id, now);
    } else if (markRead === 'all') {
      this.store.markJoinNoticesRead({
        chatId: scopedChat ?? null, recipientId: ownRecipient, readAt: now
      });
    } else if (markRead !== undefined && markRead !== null) {
      throw new ProtocolError('invalid_param', 400, 'mark_read must be one or all');
    }
    const filter = {
      chatId: scopedChat ?? null,
      recipientId: recipientFilter,
      read: read === undefined ? null : Boolean(read),
      limit: Math.max(1, Math.min(500, Number(limit) || 50)),
      offset: Math.max(0, Number(offset) || 0)
    };
    const total = this.store.countJoinNotices(filter);
    const rows = this.store.listJoinNotices(filter);
    return {
      notices: rows.map((row) => ({
        id: row.id,
        chat_id: row.chat_id,
        request_id: row.request_id,
        notice_type: row.notice_type,
        recipient_id: row.recipient_id,
        created_at: row.created_at,
        read_at: row.read_at ?? null
      })),
      total,
      has_more: filter.offset + rows.length < total
    };
  }

  // ---------------------------------------------------- #12 public chats
  listPublicChats({ auth, category, q, limit, offset }) {
    this._requireCommunityReader(auth, 'list_public_chats');
    const principalId = this._principal(auth);
    const nowMs = this._nowMs();
    const windowStart = nowMs - 60 * 1000;
    const hits = (this._publicChatHits.get(principalId) ?? []).filter((at) => at >= windowStart);
    const perMinute = Math.max(1, Number(this.config.listPublicChatsPerMinute) || 30);
    if (hits.length >= perMinute) {
      this._publicChatHits.set(principalId, hits);
      this._audit('list_public_chats_rate_limited', { principal_id: principalId });
      throw new ProtocolError('rate_limited', 429,
        `list_public_chats is limited to ${perMinute} calls per minute`, { limit: perMinute });
    }
    hits.push(nowMs);
    this._publicChatHits.set(principalId, hits);

    if (category !== undefined && category !== null
      && category !== 'uncategorized' && !isChatCategory(category)) {
      throw new ProtocolError('invalid_category', 400,
        `category must be one of ${CHAT_CATEGORIES.join(', ')} or uncategorized`);
    }
    let query = null;
    if (q !== undefined && q !== null && String(q) !== '') {
      query = String(q).trim().toLowerCase();
      if (query.length > Q_MAX) {
        throw new ProtocolError('invalid_param', 400, `q must be at most ${Q_MAX} characters`);
      }
    }
    const chats = this.store.listPublicChats().filter((chat) => {
      if (category === 'uncategorized') {
        if (chat.category !== null && chat.category !== undefined) return false;
      } else if (category) {
        if (chat.category !== category) return false;
      }
      if (query) {
        const description = parseChatSettings(chat.settings).description ?? '';
        const haystack = `${chat.name ?? ''}\n${description}`.toLowerCase();
        if (!haystack.split('\n').some((part) => part.startsWith(query))) return false;
      }
      return true;
    });
    const o = Math.max(0, Number(offset) || 0);
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const pageRows = chats.slice(o, o + n);
    const total = chats.length;
    this._audit('list_public_chats_accessed', {
      principal_id: principalId,
      q: query ?? undefined,
      result_count: total
    });
    return {
      chats: pageRows.map((chat) => ({
        chat_id: chat.chat_id,
        name: chat.name,
        category: chat.category ?? null,
        description: parseChatSettings(chat.settings).description ?? null,
        member_count: this.store.countChatMembers(chat.chat_id),
        created_at: chat.created_at
      })),
      total,
      has_more: o + pageRows.length < total
    };
  }

  // --------------------------------------------------------- #13 list agents
  listAgents({ auth, limit, offset, status }) {
    if (status !== undefined && status !== null
      && !['active', 'revoked', 'disabled'].includes(status)) {
      throw new ProtocolError('invalid_param', 400,
        'status must be active, revoked or disabled');
    }
    let ids = null;
    if (!this._humanMaster(auth)) {
      if (auth?.role === 'agent') {
        const own = auth.agent_id ?? agentIdForParticipant(auth.participant);
        const chatIds = auth.token_kind === 'agent-task'
          ? (auth.chat_id ? [auth.chat_id] : [])
          : this.store.listChatsForAgent(own).map((chat) => chat.chat_id);
        const visible = new Set([own]);
        for (const chatId of chatIds) {
          for (const member of this.store.listChatMembers(chatId)) visible.add(member.agent_id);
        }
        ids = [...visible];
      } else {
        throw this._deny('forbidden', 403, 'list_agents requires a human/master or agent token', {}, {
          surface: 'tool:list_agents', code: 'forbidden', status: 403
        });
      }
    }
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const o = Math.max(0, Number(offset) || 0);
    const rows = this.store.listAgentsPaged({
      status: status ?? null, ids, limit: n, offset: o
    });
    const total = this.store.countAgentsFiltered({ status: status ?? null, ids });
    return {
      agents: rows.map((row) => ({
        agent_id: row.id,
        participant_id: participantForAgentId(row.id),
        display_name: row.display_name,
        platform: row.platform,
        status: row.status,
        owner: row.owner,
        profile: row.profile ?? null,
        chat_count: this.store.countChatsForAgent(row.id)
      })),
      total,
      has_more: o + rows.length < total
    };
  }

  // ---------------------------------------------------------- #14 set role
  setRole({ auth, chatId, agentId, role }) {
    this._requireHumanMaster(auth, 'chat_set_role');
    if (role !== 'admin' && role !== 'member') {
      throw new ProtocolError('invalid_role', 400, 'role must be admin or member');
    }
    const chat = this._chat(chatId);
    const canonical = agentIdForParticipant(agentId) || agentId;
    if (!canonical) throw new ProtocolError('invalid_param', 400, 'agent_id is required');
    if (canonical === 'user') {
      throw new ProtocolError('cannot_change_owner', 403, 'the human owner role cannot be changed');
    }
    const member = this.store.getChatMember(chat.chat_id, canonical);
    if (!member) {
      throw new ProtocolError('member_not_found', 404,
        `agent ${canonical} is not a member of chat ${chat.chat_id}`);
    }
    if (member.role === 'owner') {
      throw new ProtocolError('cannot_change_owner', 403, 'the human owner role cannot be changed');
    }
    if (member.role === role) {
      return { chat_id: chat.chat_id, agent_id: canonical, role };
    }
    const now = this._now();
    return this.store._transaction(() => {
      this.store.updateChatMemberRole(chat.chat_id, canonical, role);
      this._systemNotice(chat.chat_id, '本群成员角色已变更。',
        `role:${chat.chat_id}:${canonical}:${role}:${now}`);
      this._audit('chat_role_changed', {
        chat_id: chat.chat_id,
        agent_id: canonical,
        old_role: member.role,
        new_role: role,
        by: this._principal(auth)
      });
      return { chat_id: chat.chat_id, agent_id: canonical, role };
    });
  }
}