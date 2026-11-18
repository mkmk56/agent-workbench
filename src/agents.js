import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { auditEvent } from './audit.js';

// ---------------------------------------------------------------------------
// REA Phase 2: agent identity, pairing, membership and inbox
//
// The engine already has four fixed participants (user/muse/claude/dsh). This
// module adds the persistent identity layer required by the Phase 1 design:
//
//   agents          one row per built-in or paired agent (token hash only)
//   chat_members    canonical membership (user is the owner row)
//   inbox_cursors   per-agent/per-chat read cursor and unread counters
//
// chat_participants remains the legacy projection used by the message and
// delivery code. AgentService keeps both tables in step so a third-party agent
// can use the same message protocol as Claude and dsh without rewriting the
// delivery path.
// ---------------------------------------------------------------------------

export const OWNER_ID = 'user';

// Built-in identities. The id follows DATABASE_DESIGN.md (agent_claude); the
// participant handle is what messages and chat_participants already store.
export const BUILTIN_AGENTS = Object.freeze([
  {
    id: 'agent_muse', participant: 'muse', owner: OWNER_ID, platform: 'muse',
    display_name: 'Muse', profile: 'Group coordinator and architect.',
    color: '#3f3a36'
  },
  {
    id: 'agent_claude', participant: 'claude', owner: OWNER_ID, platform: 'claude-code',
    display_name: 'Claude', profile: 'Backend and core engineering executor.',
    color: '#b26a4e'
  },
  {
    id: 'agent_dsh', participant: 'dsh', owner: OWNER_ID, platform: 'dsh',
    display_name: 'dsh', profile: 'Frontend implementation and independent review executor.',
    color: '#5b7184'
  }
]);

const BUILTIN_BY_PARTICIPANT = new Map(BUILTIN_AGENTS.map((agent) => [agent.participant, agent]));
const BUILTIN_BY_ID = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
const BUILTIN_NAMES = new Set(BUILTIN_AGENTS.map((agent) => agent.display_name.toLowerCase()));
const USER_COLOR = '#7a7a76';

// Restrained third-party palette (bubble identity colours only; the rest of the
// GUI stays colourless per decision A).
const PALETTE = ['#7c6a53', '#6b7f6e', '#8a6f8e', '#5f7a7a', '#8a7350', '#6d728a'];

const PROFILE_MAX = 300;
const NAME_MAX = 80;
const PLATFORM_MAX = 40;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class ProtocolError extends Error {
  constructor(code, status, message = null, details = {}) {
    super(message || code);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isThirdPartyAgentId(value) {
  return typeof value === 'string' && /^agent_[A-Za-z0-9_-]{6,64}$/.test(value)
    && !BUILTIN_BY_ID.has(value);
}

export function isAgentParticipant(value) {
  return value === 'claude' || value === 'dsh' || isThirdPartyAgentId(value);
}

// Map between the canonical agents.id and the participant handle used by
// messages/chat_participants. Third-party ids are their own handle.
export function agentIdForParticipant(participant) {
  if (!participant) return null;
  if (participant === OWNER_ID) return OWNER_ID;
  if (BUILTIN_BY_PARTICIPANT.has(participant)) return BUILTIN_BY_PARTICIPANT.get(participant).id;
  return participant;
}

export function participantForAgentId(agentId) {
  if (!agentId) return null;
  if (agentId === OWNER_ID) return OWNER_ID;
  const builtin = BUILTIN_BY_ID.get(agentId);
  if (builtin) return builtin.participant;
  return agentId;
}

export function isKnownParticipant(value) {
  return value === OWNER_ID || value === 'muse' || value === 'claude' || value === 'dsh'
    || isThirdPartyAgentId(value);
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function colorFor(seed) {
  const digest = createHash('sha256').update(String(seed)).digest();
  return PALETTE[digest[0] % PALETTE.length];
}

function publicAgent(row) {
  if (!row) return null;
  return {
    agent_id: row.id,
    participant_id: participantForAgentId(row.id),
    owner: row.owner,
    platform: row.platform,
    display_name: row.display_name,
    profile: row.profile ?? null,
    color: row.color ?? null,
    status: row.status,
    created_at: Number(row.created_at)
  };
}

// Server-derived author block. A client-supplied value is never trusted; see
// MessageService.send for the forgery check.
export function describeAuthor(store, participant) {
  if (participant === OWNER_ID) {
    return {
      id: OWNER_ID,
      participant_id: OWNER_ID,
      human: true,
      agent: false,
      display_name: 'User',
      platform: null,
      color: USER_COLOR
    };
  }
  const agent = store?.getAgent?.(agentIdForParticipant(participant)) ?? null;
  return {
    id: participant,
    participant_id: participant,
    human: false,
    agent: true,
    display_name: agent?.display_name ?? participant,
    platform: agent?.platform ?? null,
    color: agent?.color ?? null
  };
}

// Shared by AgentService and auth.identifyToken(..., store) so both the HTTP
// layer and direct callers resolve `pachat_` tokens the same way.
export function identifyAccessTokenWithStore(provided, store) {
  if (typeof provided !== 'string' || !provided.startsWith('pachat_')) return null;
  if (provided.length < 16 || provided.length > 200) return null;
  const agent = store?.getAgentByTokenHash?.(hashToken(provided)) ?? null;
  if (!agent || agent.status !== 'active') return null;
  const participant = participantForAgentId(agent.id);
  return {
    role: 'agent',
    master: false,
    participant,
    agent_id: agent.id,
    principal_id: agent.id,
    token_kind: 'access',
    can_post_as: [participant],
    can_dispatch: false,
    can_operate: false,
    deprecated: false
  };
}

function normalizePairingCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function newPairingCode() {
  const pick = () => PAIRING_ALPHABET[randomInt(0, PAIRING_ALPHABET.length)];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

export class AgentService {
  constructor({ store, config = {} }) {
    this.store = store;
    this.config = config;
    // Connection-layer audit (SECURITY_DESIGN.md §5). Tests may inject a
    // collector; production appends to data/security-audit.log.
    this.audit = typeof config.audit === 'function'
      ? config.audit
      : (event, fields) => auditEvent(store?.dataDir ?? config.dataDir, event, fields);
  }

  // Auditing is best effort: a full disk or a locked file must never turn a
  // rejected pairing into a crash.
  _audit(event, fields = {}) {
    try { this.audit?.(event, fields); } catch { /* ignore */ }
  }

  _now() {
    return Date.now();
  }

  _ttl() {
    const configured = Number(this.config.pairingTtlMs) || 24 * 60 * 60 * 1000;
    return Math.max(60_000, Math.min(24 * 60 * 60 * 1000, configured));
  }

  _maxAgentsPerCode() {
    const configured = Number(this.config.pairingMaxAgents) || 10;
    return Math.max(1, Math.min(10, configured));
  }

  _maxChatMembers() {
    return Math.max(2, Number(this.config.chatMaxMembers) || 50);
  }

  _maxOwnedAgents() {
    return Math.max(1, Number(this.config.ownerMaxAgents) || 10);
  }

  builtinFor(participant) {
    return BUILTIN_BY_PARTICIPANT.get(participant) ?? null;
  }

  // Insert the three built-in identities if they are missing. Re-running never
  // overwrites a profile, colour or token hash that already exists.
  ensureBuiltins() {
    let inserted = 0;
    for (const agent of BUILTIN_AGENTS) {
      if (this.store.getAgent(agent.id)) continue;
      try {
        this.store.insertAgent({
          id: agent.id,
          owner: agent.owner,
          platform: agent.platform,
          display_name: agent.display_name,
          profile: agent.profile,
          color: agent.color,
          status: 'active',
          created_at: this._now()
        });
        inserted += 1;
      } catch (error) {
        // A database that already contains the same owner+display_name under a
        // different id is left untouched; reconciliation reports it instead.
        if (!/UNIQUE constraint failed/i.test(error.message)) throw error;
      }
    }
    return inserted;
  }

  // P1-1 startup reconciliation, extended to the Phase 2 tables. Existing
  // chat participants gain membership rows and, when missing, an inbox cursor.
  // A missing cursor starts at the participant's legacy read cursor; when that
  // is still 0 the chat's current maximum is used so old history is not shown
  // as an unread backlog. `readToMax` is the one-time migration behaviour.
  reconcile({ readToMax = false } = {}) {
    const summary = { builtins_inserted: 0, memberships_inserted: 0, cursors_inserted: 0, participants_inserted: 0 };
    summary.builtins_inserted = this.ensureBuiltins();

    const chats = this.store.allChats();
    for (const chat of chats) {
      const maxSeq = this.store.maxChatSeq(chat.chat_id);
      for (const participant of this.store.listChatParticipants(chat.chat_id)) {
        const agentId = agentIdForParticipant(participant.participant_id);
        if (!this.store.getChatMember(chat.chat_id, agentId)) {
          this.store.insertChatMember({
            chat_id: chat.chat_id,
            agent_id: agentId,
            role: participant.participant_id === OWNER_ID ? 'owner' : 'member',
            joined_at: Date.parse(participant.joined_at) || this._now()
          });
          summary.memberships_inserted += 1;
        }
        if (!this.store.getInboxCursor(chat.chat_id, agentId)) {
          const legacyRead = Number(participant.last_read_seq) || 0;
          const initial = readToMax ? maxSeq : (legacyRead > 0 ? legacyRead : maxSeq);
          this.store.ensureInboxCursor({
            chatId: chat.chat_id,
            agentId,
            lastReadSeq: initial,
            now: this._now()
          });
          this.store.recomputeInboxCounts(chat.chat_id, agentId, participant.participant_id);
          summary.cursors_inserted += 1;
        }
      }

      // Reverse direction: a member added through the Phase 2 API must also be
      // visible to the legacy participant/delivery path.
      for (const member of this.store.listChatMembers(chat.chat_id)) {
        const participantId = participantForAgentId(member.agent_id);
        if (!this.store.getChatParticipant(chat.chat_id, participantId)) {
          const agent = member.agent_id === OWNER_ID ? null : this.store.getAgent(member.agent_id);
          this.store.upsertChatParticipant({
            chat_id: chat.chat_id,
            participant_id: participantId,
            kind: member.agent_id === OWNER_ID ? 'human' : 'agent',
            role: member.agent_id === OWNER_ID ? 'user' : (agent?.platform === 'muse' ? 'muse' : participantId),
            display_name: member.agent_id === OWNER_ID ? 'User' : (agent?.display_name ?? participantId)
          });
          summary.participants_inserted += 1;
        }
        if (!this.store.getInboxCursor(chat.chat_id, member.agent_id)) {
          this.store.ensureInboxCursor({
            chatId: chat.chat_id,
            agentId: member.agent_id,
            lastReadSeq: readToMax ? maxSeq : 0,
            now: this._now()
          });
          this.store.recomputeInboxCounts(chat.chat_id, member.agent_id, participantId);
          summary.cursors_inserted += 1;
        }
      }
    }
    return summary;
  }

  // ------------------------------------------------------------- pairing
  createPairingCode({ createdBy = OWNER_ID, ttlMs = null, maxAgents = null } = {}) {
    const ttl = ttlMs === null || ttlMs === undefined
      ? this._ttl()
      : Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(ttlMs) || this._ttl()));
    const max = maxAgents === null || maxAgents === undefined
      ? this._maxAgentsPerCode()
      : Math.max(1, Math.min(10, Number(maxAgents) || this._maxAgentsPerCode()));
    const id = randomUUID();
    const code = newPairingCode();
    const now = this._now();
    this.store.insertPairingCode({
      id,
      code_hash: hashToken(normalizePairingCode(code)),
      owner: createdBy || OWNER_ID,
      max_agents: max,
      uses: 0,
      created_at: now,
      expires_at: now + ttl
    });
    this._audit('pairing_code_created', {
      pairing_id: id,
      owner: createdBy || OWNER_ID,
      max_agents: max,
      expires_at: now + ttl
    });
    return {
      pairing_id: id,
      code,
      expires_at: now + ttl,
      expires_in_ms: ttl,
      max_agents: max,
      uses: 0
    };
  }

  // Exchange a pairing code for an access token. The returned token is the only
  // copy: the agents row stores its SHA-256 hash. Every attempt is audited;
  // the pairing code, the token and the code hash never reach the audit line.
  redeemPairingCode(input = {}) {
    try {
      const result = this._redeemPairingCode(input);
      this._audit('agent_pair', {
        surface: 'agent_pair',
        pairing_id: result.pairing_id,
        agent_id: result.agent?.agent_id ?? null,
        display_name: result.agent?.display_name ?? null,
        owner: result.agent?.owner ?? null,
        platform: result.agent?.platform ?? null,
        reclaim: result.reclaim === true
      });
      if (result.reclaim) {
        this._audit('agent_reclaim', {
          surface: 'agent_pair',
          pairing_id: result.pairing_id,
          agent_id: result.agent?.agent_id ?? null,
          display_name: result.agent?.display_name ?? null,
          owner: result.agent?.owner ?? null
        });
      }
      return result;
    } catch (error) {
      this._audit('agent_pair_failed', {
        surface: 'agent_pair',
        code: error?.code ?? 'error',
        status: error?.status ?? null,
        display_name: typeof input?.name === 'string' ? input.name : null,
        reclaim: input?.reclaim === true
      });
      if (error && typeof error === 'object') error.audited = true;
      throw error;
    }
  }

  _redeemPairingCode({
    code, name, platform = undefined, profile = undefined, reclaim = false, chatIds = []
  } = {}) {
    const normalized = normalizePairingCode(code);
    const pairing = normalized ? this.store.getPairingCodeByHash(hashToken(normalized)) : null;
    if (!pairing) throw new ProtocolError('invalid_pairing_code', 401, 'pairing code is not valid');
    if (pairing.revoked_at) throw new ProtocolError('pairing_code_revoked', 401, 'pairing code was revoked');
    if (this._now() > Number(pairing.expires_at)) {
      throw new ProtocolError('pairing_code_expired', 410, 'pairing code has expired');
    }

    const displayName = String(name ?? '').trim();
    if (!displayName) throw new ProtocolError('invalid_name', 400, 'name must be a non-empty string');
    if (displayName.length > NAME_MAX) {
      throw new ProtocolError('invalid_name', 400, `name must be at most ${NAME_MAX} characters`);
    }
    if (BUILTIN_NAMES.has(displayName.toLowerCase())) {
      throw new ProtocolError('name_reserved', 409, `'${displayName}' is a built-in agent name`);
    }
    if (profile !== null && profile !== undefined) {
      if (typeof profile !== 'string' || profile.length > PROFILE_MAX) {
        throw new ProtocolError('invalid_profile', 400, `profile must be a string of at most ${PROFILE_MAX} characters`);
      }
    }

    const existing = this.store.findAgentByName(pairing.owner, displayName);
    if (existing && reclaim !== true) {
      throw new ProtocolError('member_exists', 409, `agent '${displayName}' already exists`, {
        reclaim: true,
        agent_id: existing.id
      });
    }
    // An omitted platform/profile preserves the reclaimed identity; only an
    // explicit value replaces it.
    const platformName = String(platform ?? existing?.platform ?? 'custom').trim() || 'custom';
    if (platformName.length > PLATFORM_MAX) {
      throw new ProtocolError('invalid_platform', 400, `platform must be at most ${PLATFORM_MAX} characters`);
    }

    const token = `pachat_${randomBytes(32).toString('base64url')}`;
    const tokenHash = hashToken(token);
    let agentId = existing?.id ?? null;
    let isNew = false;

    const row = this.store._transaction(() => {
      if (!agentId) {
        if (this.store.countActiveOwnedAgents(pairing.owner) >= this._maxOwnedAgents()) {
          throw new ProtocolError('owner_agent_limit', 403,
            `owner already has ${this._maxOwnedAgents()} active agents`);
        }
        if (this.store.countPairingUses(pairing.id) >= Number(pairing.max_agents)) {
          throw new ProtocolError('pairing_code_exhausted', 409,
            `pairing code has reached its ${pairing.max_agents}-agent limit`);
        }
        agentId = `agent_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        isNew = true;
        this.store.insertAgent({
          id: agentId,
          owner: pairing.owner,
          platform: platformName,
          display_name: displayName,
          profile: profile ?? null,
          color: colorFor(agentId),
          token_hash: tokenHash,
          status: 'active',
          created_at: this._now()
        });
      } else {
        if (!this.store.hasPairingUse(pairing.id, agentId)
          && this.store.countPairingUses(pairing.id) >= Number(pairing.max_agents)) {
          throw new ProtocolError('pairing_code_exhausted', 409,
            `pairing code has reached its ${pairing.max_agents}-agent limit`);
        }
        this.store.updateAgent(agentId, {
          platform: platformName,
          profile: profile === undefined ? existing.profile : profile,
          token_hash: tokenHash,
          status: 'active'
        });
      }
      this.store.insertPairingUse(pairing.id, agentId);
      // Join the requested chats inside the same transaction: a bad chat id or
      // a full chat must not leave a half-paired agent behind.
      for (const chatId of Array.isArray(chatIds) ? chatIds : []) {
        this.addMember({ chatId, agentId });
      }
      return this.store.getAgent(agentId);
    });

    return {
      agent: publicAgent(row),
      token,
      reclaim: !isNew,
      pairing_id: pairing.id
    };
  }

  identifyAccessToken(provided) {
    return identifyAccessTokenWithStore(provided, this.store);
  }

  revokeToken(agentId) {
    try {
      const canonical = agentIdForParticipant(agentId) || agentId;
      const agent = this.store.getAgent(canonical);
      if (!agent) throw new ProtocolError('agent_not_found', 404, `agent not found: ${agentId}`);
      // Built-in identities are part of the engine, not paired integrations.
      // Revoking one would remove it from chat membership and crash the pairing
      // reclaim path; only their (nonexistent) access token is ever revocable.
      if (BUILTIN_BY_ID.has(agent.id)) {
        throw new ProtocolError('cannot_revoke_builtin', 403,
          `${agent.display_name} is a built-in agent and has no access token to revoke`);
      }
      const updated = this.store.updateAgent(agent.id, { status: 'revoked', token_hash: null });
      this._audit('agent_revoke', {
        surface: 'agent_revoke',
        agent_id: agent.id,
        display_name: agent.display_name,
        owner: agent.owner
      });
      return publicAgent(updated);
    } catch (error) {
      if (error?.status === 403 || error?.status === 404) {
        this._audit('access_denied', {
          surface: 'agent_revoke',
          agent_id: String(agentId ?? ''),
          code: error.code ?? 'error',
          status: error.status,
          detail: error.message
        });
        if (error && typeof error === 'object') error.audited = true;
      }
      throw error;
    }
  }

  updateProfile(agentId, profile) {
    const canonical = agentIdForParticipant(agentId) || agentId;
    const agent = this.store.getAgent(canonical);
    if (!agent) throw new ProtocolError('agent_not_found', 404, `agent not found: ${agentId}`);
    if (profile === null || profile === undefined) {
      return publicAgent(this.store.updateAgent(agent.id, { profile: null }));
    }
    if (typeof profile !== 'string' || profile.length > PROFILE_MAX) {
      throw new ProtocolError('invalid_profile', 400,
        `profile must be a string of at most ${PROFILE_MAX} characters`);
    }
    return publicAgent(this.store.updateAgent(agent.id, { profile }));
  }

  profile(agentId) {
    const canonical = agentIdForParticipant(agentId) || agentId;
    if (canonical === OWNER_ID) {
      return { agent_id: OWNER_ID, participant_id: OWNER_ID, owner: OWNER_ID, human: true, display_name: 'User' };
    }
    if (!this.store.getAgent(canonical) && BUILTIN_BY_ID.has(canonical)) this.ensureBuiltins();
    return publicAgent(this.store.getAgent(canonical));
  }

  // ------------------------------------------------------------ membership
  addMember({ chatId, agentId, role = 'member' } = {}) {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new ProtocolError('chat_not_found', 404, `chat not found: ${chatId}`);
    const canonical = agentIdForParticipant(agentId) || agentId;
    if (!canonical) throw new ProtocolError('invalid_agent', 400, 'agent_id is required');

    if (canonical === OWNER_ID) {
      // The human owner is the only role=owner row.
      return this._insertMember(chatId, canonical, 'owner');
    }

    let agent = this.store.getAgent(canonical);
    if (!agent && BUILTIN_BY_ID.has(canonical)) {
      // A fresh test database or a database that has not been reconciled yet
      // still knows the built-in identities; create the row on demand.
      this.ensureBuiltins();
      agent = this.store.getAgent(canonical);
    }
    if (!agent) throw new ProtocolError('agent_not_found', 404, `agent not found: ${agentId}`);
    if (agent.status !== 'active') {
      throw new ProtocolError('agent_inactive', 403, `agent ${agent.display_name} is ${agent.status}`);
    }
    if (role === 'owner') throw new ProtocolError('invalid_role', 400, 'only the human owner may be owner');
    return this._insertMember(chatId, canonical, 'member');
  }

  _insertMember(chatId, agentId, role) {
    const existing = this.store.getChatMember(chatId, agentId);
    if (existing) return this._memberView(existing);
    if (this.store.countChatMembers(chatId) >= this._maxChatMembers()) {
      throw new ProtocolError('chat_member_limit', 403,
        `chat already has ${this._maxChatMembers()} members`);
    }
    const joinedAt = this._now();
    const joinReadSeq = this.store.maxChatSeq(chatId);
    this.store.insertChatMember({ chat_id: chatId, agent_id: agentId, role, joined_at: joinedAt });

    const participantId = participantForAgentId(agentId);
    const agent = agentId === OWNER_ID ? null : this.store.getAgent(agentId);
    this.store.upsertChatParticipant({
      chat_id: chatId,
      participant_id: participantId,
      kind: agentId === OWNER_ID ? 'human' : 'agent',
      role: agentId === OWNER_ID ? 'user' : (agent?.platform === 'muse' ? 'muse' : participantId),
      display_name: agentId === OWNER_ID ? 'User' : (agent?.display_name ?? participantId),
      joined_at: new Date(joinedAt).toISOString(),
      last_read_seq: joinReadSeq
    });
    // Joining does not create an unread backlog; everything already in the
    // chat is considered read up to the current maximum.
    this.store.ensureInboxCursor({
      chatId,
      agentId,
      lastReadSeq: joinReadSeq,
      now: joinedAt
    });
    this.store.recomputeInboxCounts(chatId, agentId, participantId);
    return this._memberView(this.store.getChatMember(chatId, agentId));
  }

  removeMember({ chatId, agentId } = {}) {
    const canonical = agentIdForParticipant(agentId) || agentId;
    if (canonical === OWNER_ID) {
      throw new ProtocolError('cannot_remove_owner', 403, 'the human owner cannot be removed');
    }
    const member = this.store.getChatMember(chatId, canonical);
    if (!member) throw new ProtocolError('member_not_found', 404, `agent is not in chat ${chatId}`);
    this.store.deleteChatMember(chatId, canonical);
    this.store.deleteChatParticipant(chatId, participantForAgentId(canonical));
    this.store.deleteInboxCursor(chatId, canonical);
    return { removed: true, chat_id: chatId, agent_id: canonical };
  }

  members(chatId) {
    return this.store.listChatMembers(chatId).map((member) => this._memberView(member));
  }

  _memberView(member) {
    if (!member) return null;
    const agent = member.agent_id === OWNER_ID ? null : this.store.getAgent(member.agent_id);
    return {
      agent_id: member.agent_id,
      participant_id: participantForAgentId(member.agent_id),
      role: member.role,
      owner: agent?.owner ?? (member.agent_id === OWNER_ID ? OWNER_ID : null),
      platform: agent?.platform ?? null,
      display_name: member.display_name ?? agent?.display_name
        ?? (member.agent_id === OWNER_ID ? 'User' : member.agent_id),
      color: agent?.color ?? (member.agent_id === OWNER_ID ? USER_COLOR : null),
      status: agent?.status ?? 'active',
      joined_at: member.joined_at
    };
  }

  // ----------------------------------------------------------------- inbox
  inbox({ agentId = OWNER_ID } = {}) {
    const canonical = agentIdForParticipant(agentId) || agentId;
    const participantId = participantForAgentId(canonical);
    if (canonical !== OWNER_ID && !this.store.getAgent(canonical) && BUILTIN_BY_ID.has(canonical)) {
      this.ensureBuiltins();
    }
    if (canonical !== OWNER_ID && !this.store.getAgent(canonical)) {
      throw new ProtocolError('agent_not_found', 404, `agent not found: ${agentId}`);
    }

    // Membership comes from the canonical table; the legacy owner fallback
    // keeps a pre-migration chat visible until reconciliation has run.
    let chats = canonical === OWNER_ID
      ? []
      : this.store.listChatsForAgent(canonical);
    if (canonical === OWNER_ID || chats.length === 0) {
      const ids = this.store.listParticipantChatIds(participantId);
      if (ids.length > 0) {
        const byId = new Map(chats.map((chat) => [chat.chat_id, chat]));
        for (const chat of this.store.listChats({ status: null, chatIds: ids, limit: 200 })) {
          if (!byId.has(chat.chat_id)) chats.push(chat);
        }
      }
    }

    const entries = [];
    let totalUnread = 0;
    for (const chat of chats) {
      if (!this.store.getChatMember(chat.chat_id, canonical)) {
        this.store.insertChatMember({
          chat_id: chat.chat_id,
          agent_id: canonical,
          role: canonical === OWNER_ID ? 'owner' : 'member',
          joined_at: this._now()
        });
      }
      if (!this.store.getInboxCursor(chat.chat_id, canonical)) {
        const legacy = this.store.getChatParticipant(chat.chat_id, participantId);
        this.store.ensureInboxCursor({
          chatId: chat.chat_id,
          agentId: canonical,
          lastReadSeq: Number(legacy?.last_read_seq) || 0,
          now: this._now()
        });
      }
      const counts = this.store.recomputeInboxCounts(chat.chat_id, canonical, participantId);
      totalUnread += counts.unread;
      entries.push({
        chat_id: chat.chat_id,
        name: chat.name,
        status: chat.status ?? 'active',
        last_read_seq: counts.last_read_seq,
        unread: counts.unread,
        mentions_you: counts.mentions_you,
        replies_to_you: counts.replies_to_you,
        from_owner: counts.from_owner,
        recalled: counts.recalled,
        last_message_at: chat.last_message_at ?? null
      });
    }

    const agent = canonical === OWNER_ID ? null : this.store.getAgent(canonical);
    return {
      you: {
        agent_id: canonical,
        participant_id: participantId,
        owner: agent?.owner ?? OWNER_ID,
        platform: agent?.platform ?? null,
        display_name: agent?.display_name ?? 'User',
        human: canonical === OWNER_ID,
        status: agent?.status ?? 'active'
      },
      total_unread: totalUnread,
      chats: entries
    };
  }

  markRead({ chatId, agentId = OWNER_ID, upToSeq = null } = {}) {
    const canonical = agentIdForParticipant(agentId) || agentId;
    const participantId = participantForAgentId(canonical);
    if (!this.store.getChat(chatId)) throw new ProtocolError('chat_not_found', 404, `chat not found: ${chatId}`);
    if (!this.store.isChatParticipant(chatId, participantId)) {
      throw new ProtocolError('not_a_member', 403, `'${participantId}' is not a participant of chat ${chatId}`);
    }
    const target = upToSeq === null || upToSeq === undefined
      ? this.store.maxChatSeq(chatId)
      : Number(upToSeq) || 0;
    this.store.updateParticipantRead(chatId, participantId, target);
    return this.store.markInboxRead(chatId, canonical, target, participantId);
  }

  // Called after a delivery starts: the task prompt already contains the chat
  // context, so the agent is considered read up to the chat's current maximum.
  advanceOnDelivery({ chatId, participantId }) {
    const canonical = agentIdForParticipant(participantId);
    const maxSeq = this.store.maxChatSeq(chatId);
    this.store.ensureInboxCursor({ chatId, agentId: canonical, now: this._now() });
    const counts = this.store.advanceInboxToMax(chatId, canonical, participantId);
    this.store.updateParticipantRead(chatId, participantId, maxSeq);
    return counts;
  }

  unreadFor(chatId, participantId) {
    const canonical = agentIdForParticipant(participantId);
    const cursor = this.store.getInboxCursor(chatId, canonical);
    if (cursor) {
      return this.store.countUnreadMessages(chatId, participantId, cursor.last_read_seq);
    }
    const legacy = this.store.getChatParticipant(chatId, participantId);
    if (!legacy) return 0;
    return this.store.countUnreadMessages(chatId, participantId, legacy.last_read_seq);
  }
}