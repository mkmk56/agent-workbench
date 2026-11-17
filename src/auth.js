import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Bearer tokens and principals
//
// The old design had one master token that represented both the human and the
// Muse coordinator, plus static HMAC-derived executor tokens. A local executor
// could read the master token from workbench.env and post as `user` or `muse`
// (docs/ARCHITECTURE_AUDIT.md §1.3).
//
// The engine now recognises four principal kinds:
//
//   human        -> may post only as `user`; cannot dispatch, approve or (by
//                   default) start/cancel tasks. This is the GUI/browser token.
//   muse         -> may post only as `muse`; may dispatch sub-tasks; every
//                   message needs client_msg_id and a fresh heartbeat lease.
//   agent-task   -> signed, short-lived token bound to task/agent/chat/expiry.
//                   Injected into the executor process through a private file
//                   or environment variable, never persisted in shared data.
//   agent (old)  -> static HMAC token, kept for one compatibility version so
//                   existing verification scripts can authenticate. Logged as
//                   deprecated and can be revoked with WORKBENCH_LEGACY_AGENT_TOKENS=0.
//
// `master` (MCP_BEARER_TOKEN) is the legacy GUI token. It is accepted for one
// compatibility version as a human principal (post as `user` only), and is
// logged as `deprecated-master-token`. WORKBENCH_LEGACY_MASTER=0 revokes it.
// ---------------------------------------------------------------------------

export const MASTER_PARTICIPANT = 'muse';
export const AGENT_PARTICIPANTS = Object.freeze(['claude', 'dsh']);

export function deriveAgentToken(masterToken, agent) {
  if (!masterToken) throw new Error('master token is required to derive agent tokens');
  if (!AGENT_PARTICIPANTS.includes(agent)) throw new Error(`unknown agent: ${agent}`);
  return createHmac('sha256', masterToken).update(`agent-token:${agent}`).digest('hex');
}

export function deriveAgentTokens(masterToken) {
  return Object.fromEntries(AGENT_PARTICIPANTS.map((agent) => [agent, deriveAgentToken(masterToken, agent)]));
}

// Human and Muse must be independent random secrets stored next to the master
// (MCP_HUMAN_TOKEN / MCP_MUSE_TOKEN). Deriving them from the master is a
// rollback-only legacy mode: reading the master token used to yield the Muse
// dispatch capability and human impersonation for free. The derivation helpers
// are kept for that explicit opt-in (WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1) and
// for old tests, but identifyToken never derives unless the caller opts in.
export function deriveHumanToken(masterToken) {
  if (!masterToken) throw new Error('master token is required to derive the human token');
  return createHmac('sha256', masterToken).update('principal-token:human').digest('hex');
}

export function deriveMuseToken(masterToken) {
  if (!masterToken) throw new Error('master token is required to derive the muse token');
  return createHmac('sha256', masterToken).update('principal-token:muse').digest('hex');
}

function configuredPrincipalToken(config, kind) {
  const explicit = kind === 'human' ? config.humanToken : config.museToken;
  if (explicit) return explicit;
  if (config.allowDerivedPrincipalTokens === true) {
    return kind === 'human' ? deriveHumanToken(config.token) : deriveMuseToken(config.token);
  }
  return null;
}

function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractBearer(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const credential = header.trim().replace(/^bearer\s+/i, '').trim();
  return credential || null;
}

// ---------------------------------------------------------------------------
// Per-task agent tokens
//
// Format: wbt1.<base64url(payload)>.<base64url(hmac-sha256)>. Stateless: the
// server verifies the signature with the master secret and checks `exp`, so a
// leaked token stops working when the task's lease ends. The payload carries
// task/agent/chat/scope so a token cannot be replayed for another task.
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'wbt1';
const MAX_AGENT_TOKEN_MS = 24 * 60 * 60 * 1000;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function signTokenPayload(masterToken, payloadPart) {
  return b64url(createHmac('sha256', masterToken).update(`${TOKEN_PREFIX}.${payloadPart}`).digest());
}

export function issueAgentToken(masterToken, {
  agent, taskId, chatId = null, scope = 'task', ttlMs = 2 * 60 * 60 * 1000, now = Date.now()
} = {}) {
  if (!masterToken) throw new Error('master token is required to issue an agent token');
  if (!AGENT_PARTICIPANTS.includes(agent)) throw new Error(`unknown agent: ${agent}`);
  if (typeof taskId !== 'string' || taskId === '') throw new Error('taskId is required to issue an agent token');
  const ttl = Math.max(60_000, Math.min(MAX_AGENT_TOKEN_MS, Number(ttlMs) || 2 * 60 * 60 * 1000));
  const payload = {
    v: 1,
    k: 'agent',
    a: agent,
    tid: taskId,
    cid: chatId || null,
    sc: scope || 'task',
    iat: now,
    exp: now + ttl,
    jti: randomUUID()
  };
  const body = b64url(JSON.stringify(payload));
  return `${TOKEN_PREFIX}.${body}.${signTokenPayload(masterToken, body)}`;
}

export function verifyAgentToken(token, masterToken, now = Date.now()) {
  if (typeof token !== 'string' || !token.startsWith(`${TOKEN_PREFIX}.`)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, body, signature] = parts;
  if (!safeEqual(signature, signTokenPayload(masterToken, body))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || payload.k !== 'agent') return null;
  if (!AGENT_PARTICIPANTS.includes(payload.a)) return null;
  if (typeof payload.tid !== 'string' || payload.tid === '') return null;
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return null;
  return {
    role: 'agent',
    master: false,
    participant: payload.a,
    principal_id: payload.a,
    token_kind: 'agent-task',
    task_id: payload.tid,
    chat_id: payload.cid || null,
    scope: payload.sc || 'task',
    issued_at: payload.iat ?? null,
    expires_at: payload.exp,
    jti: payload.jti ?? null,
    can_post_as: [payload.a],
    can_dispatch: false,
    can_operate: false,
    deprecated: false
  };
}

// Returns null for an unknown/absent/expired token. The shape intentionally
// contains no token material so it is safe to log or return in diagnostics.
export function identifyToken(provided, config) {
  if (!provided) return null;

  // Legacy master (one compatibility version).
  if (safeEqual(provided, config.token)) {
    if (config.legacyMasterEnabled === false) return null;
    const allowMuse = config.legacyMasterAllowMuse === true;
    return {
      role: 'master',
      master: true,
      participant: 'user',
      principal_id: 'user',
      token_kind: 'master',
      can_post_as: allowMuse ? ['user', 'muse'] : ['user'],
      can_dispatch: false,
      can_operate: true,
      deprecated: true
    };
  }

  const humanToken = configuredPrincipalToken(config, 'human');
  if (humanToken && safeEqual(provided, humanToken)) {
    return {
      role: 'human',
      master: false,
      participant: 'user',
      principal_id: 'user',
      token_kind: 'human',
      can_post_as: ['user'],
      can_dispatch: false,
      can_operate: config.humanCanOperate === true,
      deprecated: false
    };
  }

  const museToken = configuredPrincipalToken(config, 'muse');
  if (museToken && safeEqual(provided, museToken)) {
    return {
      role: 'muse',
      master: false,
      participant: 'muse',
      principal_id: 'muse',
      token_kind: 'muse',
      can_post_as: ['muse'],
      can_dispatch: true,
      can_operate: false,
      deprecated: false
    };
  }

  const taskToken = verifyAgentToken(provided, config.token);
  if (taskToken) return taskToken;

  // Static per-agent tokens: compatibility only. They are static and
  // unexpiring, so they are logged as deprecated and will be removed.
  if (config.legacyAgentTokensEnabled !== false) {
    const tokens = config.agentTokens ?? deriveAgentTokens(config.token);
    for (const agent of AGENT_PARTICIPANTS) {
      if (safeEqual(provided, tokens[agent])) {
        return {
          role: 'agent',
          master: false,
          participant: agent,
          principal_id: agent,
          token_kind: 'agent',
          can_post_as: [agent],
          can_dispatch: false,
          can_operate: false,
          deprecated: true
        };
      }
    }
  }
  return null;
}

export function isMaster(auth) {
  return Boolean(auth?.master);
}

// Read scope: the legacy master, the human and Muse are all full collaborators
// (they may read every chat/task). Executor tokens are scoped.
export function isReadAll(auth) {
  return Boolean(auth) && (auth.master || auth.role === 'human' || auth.role === 'muse');
}

export function requireMaster(auth, action = 'this operation') {
  if (!isMaster(auth)) throw new Error(`${action} requires the master token`);
}

// Operational actions (starting/following tasks). A human token may perform
// them only when explicitly enabled; Muse and executors never may.
export function requireOperator(auth, action = 'this operation') {
  if (isMaster(auth)) return;
  if (auth?.role === 'human' && auth.can_operate === true) return;
  throw new Error(`${action} requires an operator token`);
}

export function requireParticipant(auth) {
  if (!auth?.participant) throw new Error('unauthenticated');
  return auth.participant;
}

export function canDispatch(auth) {
  return auth?.can_dispatch === true;
}

export function requireDispatch(auth, action = 'dispatching sub-tasks') {
  if (!canDispatch(auth)) {
    throw new Error(`${action} requires an orchestrator (Muse) token`);
  }
}

// The sender identity comes from the token, never from the request body.
export function resolveSender(auth, requestedFrom) {
  const from = requestedFrom;
  if (!['user', 'muse', 'claude', 'dsh'].includes(from)) throw new Error(`invalid from: ${from}`);
  if (!auth) return from;
  if (isMaster(auth)) {
    const allowed = auth.can_post_as ?? ['user'];
    if (!allowed.includes(from)) {
      throw new Error(
        `the legacy master token may post as ${allowed.map((v) => `'${v}'`).join(' or ')}, not '${from}'`
      );
    }
    return from;
  }
  if (auth.role === 'human') {
    if (from !== 'user') throw new Error(`the human token may only post as 'user', not '${from}'`);
    return 'user';
  }
  if (auth.role === 'muse') {
    if (from !== 'muse') throw new Error(`the muse token may only post as 'muse', not '${from}'`);
    return 'muse';
  }
  if (auth.role === 'agent') {
    if (from !== auth.participant) {
      throw new Error(`token identifies as '${auth.participant}' but the request claims from='${from}'`);
    }
    return auth.participant;
  }
  throw new Error('unauthenticated');
}

// Provenance written next to every message. The values are derived from the
// authenticated principal, not from body fields.
export function authKindFor(auth, from) {
  if (auth?.token_kind === 'muse' || from === 'muse') return 'muse';
  if (auth?.master || auth?.role === 'human' || from === 'user') return 'human';
  if (AGENT_PARTICIPANTS.includes(from)) return `agent:${from}`;
  return 'system';
}

export function principalIdFor(auth, from) {
  // Provenance follows the effective sender. A legacy master posting as the
  // coordinator (rollback mode) is attributed to Muse, not to the human.
  if (auth?.role === 'agent') return auth.principal_id || auth.participant || from || null;
  if (from === 'muse') return 'muse';
  if (from === 'user') return 'user';
  return auth?.principal_id || from || null;
}

export function assertChatAccess(store, auth, chatId) {
  if (!auth) throw new Error('unauthenticated');
  if (!store.getChat(chatId)) throw new Error(`chat not found: ${chatId}`);
  // A per-task token is pinned to the chat embedded in its signed payload.
  // Participation alone must not let it read or write a second chat.
  if (auth.token_kind === 'agent-task' && auth.chat_id && auth.chat_id !== chatId) {
    throw new Error(`this token is bound to chat ${auth.chat_id}, not ${chatId}`);
  }
  if (isReadAll(auth)) return;
  if (!store.isChatParticipant(chatId, auth.participant)) {
    throw new Error(`agent '${auth.participant}' is not a participant of chat ${chatId}`);
  }
}

// Agent tokens see only their own tasks. A per-task token is additionally
// pinned to exactly one task id. Human/Muse/master are full readers.
export function assertTaskAccess(store, auth, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (auth?.token_kind === 'agent-task' && auth.task_id !== taskId) {
    throw new Error(`this token is bound to task ${auth.task_id}, not ${taskId}`);
  }
  if (!isReadAll(auth) && task.agent !== auth?.participant) {
    throw new Error(`agent '${auth?.participant ?? 'unknown'}' cannot access task ${taskId}`);
  }
  return task;
}

export function accessibleChatIds(store, auth) {
  if (!auth) return [];
  if (isReadAll(auth)) return null; // null means "no filter"
  if (auth.token_kind === 'agent-task' && auth.chat_id) return [auth.chat_id];
  return store.listParticipantChatIds(auth.participant);
}

// Tool-side helper: executor tokens are scoped to their own tasks.
export function agentScope(auth) {
  return auth && auth.role === 'agent' ? auth.participant : null;
}