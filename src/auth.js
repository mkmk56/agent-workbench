import { createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Scoped bearer tokens
//
// One master token belongs to the human/Muse coordinator. Every executor gets
// its own token, derived from the master with HMAC-SHA256 so no plaintext
// agent token ever needs to be stored. The server maps the presented token to
// an identity; `from` in a request body is only ever a consistency check.
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

// Returns null for an unknown/absent token. The shape intentionally contains
// no token material so it is safe to log or return in diagnostics.
export function identifyToken(provided, config) {
  if (!provided) return null;
  if (safeEqual(provided, config.token)) {
    return {
      role: 'master',
      master: true,
      participant: MASTER_PARTICIPANT,
      token_kind: 'master'
    };
  }
  const tokens = config.agentTokens ?? deriveAgentTokens(config.token);
  for (const agent of AGENT_PARTICIPANTS) {
    if (safeEqual(provided, tokens[agent])) {
      return {
        role: 'agent',
        master: false,
        participant: agent,
        token_kind: 'agent'
      };
    }
  }
  return null;
}

export function isMaster(auth) {
  return Boolean(auth?.master);
}

export function requireMaster(auth, action = 'this operation') {
  if (!isMaster(auth)) throw new Error(`${action} requires the master token`);
}

export function requireParticipant(auth) {
  if (!auth?.participant) throw new Error('unauthenticated');
  return auth.participant;
}

// An agent token may only speak as itself. The master token represents the
// human plus the Muse coordinator, never an executor.
export function resolveSender(auth, requestedFrom) {
  const from = requestedFrom;
  if (!['user', 'muse', 'claude', 'dsh'].includes(from)) throw new Error(`invalid from: ${from}`);
  if (!auth) return from;
  if (isMaster(auth)) {
    if (from !== 'user' && from !== 'muse') {
      throw new Error(`the master token may post as 'user' or 'muse', not '${from}'`);
    }
    return from;
  }
  if (auth.role === 'agent') {
    if (from !== auth.participant) {
      throw new Error(`token identifies as '${auth.participant}' but the request claims from='${from}'`);
    }
    return auth.participant;
  }
  throw new Error('unauthenticated');
}

export function assertChatAccess(store, auth, chatId) {
  if (!auth) throw new Error('unauthenticated');
  if (isMaster(auth)) {
    if (!store.getChat(chatId)) throw new Error(`chat not found: ${chatId}`);
    return;
  }
  if (!store.getChat(chatId)) throw new Error(`chat not found: ${chatId}`);
  if (!store.isChatParticipant(chatId, auth.participant)) {
    throw new Error(`agent '${auth.participant}' is not a participant of chat ${chatId}`);
  }
}

// Agent tokens see only their own tasks. The master sees everything.
export function assertTaskAccess(store, auth, taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!auth?.master && task.agent !== auth?.participant) {
    throw new Error(`agent '${auth?.participant ?? 'unknown'}' cannot access task ${taskId}`);
  }
  return task;
}

export function accessibleChatIds(store, auth) {
  if (!auth) return [];
  if (isMaster(auth)) return null; // null means "no filter"
  return store.listParticipantChatIds(auth.participant);
}