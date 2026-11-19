import { randomUUID } from 'node:crypto';
import { appendAuditFile } from './audit.js';
import {
  agentIdForParticipant, participantForAgentId
} from './agents.js';
import { wakeEventEnvelope } from './wake.js';

// ---------------------------------------------------------------------------
// REA Phase 3 GET /events (SSE) and PUT /checkin.
//
// Both endpoints authenticate with the same bearer tokens as /mcp. An agent
// token may only see events targeted at itself inside chats it is a member of;
// master / human / muse tokens are full collaborators. The pure helpers
// (eventScope, sseReplay, computeCheckin) are exported so tests can drive the
// protocol without binding a port.
// ---------------------------------------------------------------------------

export const CHECKIN_MIN_MINUTES = 2;
export const CHECKIN_MAX_MINUTES = 1440;
export const CHECKIN_DEFAULT_MINUTES = 10;

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function isFullReader(auth) {
  return Boolean(auth) && (auth.master === true || auth.role === 'human' || auth.role === 'muse');
}

// A read-all token has no chat filter; an executor/third-party token is scoped
// to its own chats and its own wake events.
export function eventScope(store, auth) {
  if (!auth) return { all: false, agentId: null, chatIds: [] };
  if (isFullReader(auth)) return { all: true, agentId: null, chatIds: null };
  const canonical = auth.agent_id ?? agentIdForParticipant(auth.participant);
  const participant = participantForAgentId(canonical);
  if (!canonical || !participant) return { all: false, agentId: null, chatIds: [] };
  // A per-task token is pinned to the chat in its signed payload; membership
  // in other chats must not widen its event scope.
  const chatIds = auth.token_kind === 'agent-task' && auth.chat_id
    ? [auth.chat_id]
    : store.listParticipantChatIds(participant);
  return {
    all: false,
    agentId: canonical,
    participant,
    chatIds
  };
}

export function canReadChat(scope, chatId) {
  if (!chatId) return true;
  if (scope.all) return true;
  return Array.isArray(scope.chatIds) && scope.chatIds.includes(chatId);
}

function auditDeny(config, store, auth, fields = {}) {
  appendAuditFile(config?.dataDir ?? store?.dataDir, 'security-audit.log', 'access_denied', {
    auth: `${auth?.token_kind ?? 'none'}:${auth?.participant ?? 'none'}`,
    ...fields
  });
}

// Replay selection shared by SSE and tests. Returns at most `limit + 1` rows so
// the caller can detect backpressure without loading an unbounded backlog.
export function sseReplay(store, { afterSeq = 0, scope = null, limit = 1000, chatId = null } = {}) {
  const chatIds = scope && !scope.all ? scope.chatIds : null;
  if (scope && !scope.all && Array.isArray(chatIds) && chatIds.length === 0) return [];
  const rows = store.listWakeEvents({
    chatIds: chatId ? [chatId] : chatIds,
    agentId: scope && !scope.all ? scope.agentId : null,
    afterSeq: Number(afterSeq) || 0,
    limit: Math.max(1, Number(limit) || 1000) + 1,
    order: 'asc'
  });
  return rows;
}

export function writeSseEnvelope(res, envelope) {
  const payload = JSON.stringify(envelope);
  return res.write(`id: ${envelope.seq}\ndata: ${payload}\n\n`);
}

function writeResync(res, lastSeq) {
  res.write(`event: resync\ndata: ${JSON.stringify({ type: 'resync', last_seq: lastSeq })}\n\n`);
}

// GET /events. The caller has already resolved `auth` from the bearer token.
export function handleEvents({ req, res, url, store, wake, config, auth }) {
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const scope = eventScope(store, auth);
  const chatId = url.searchParams.get('chat_id') || null;
  if (chatId && !canReadChat(scope, chatId)) {
    auditDeny(config, store, auth, {
      surface: 'GET /events',
      code: 'sse_chat_denied',
      status: 403,
      chat_id: chatId
    });
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const rawSince = url.searchParams.get('since_seq') ?? req.headers['last-event-id'] ?? null;
  const parsedSince = rawSince === null || rawSince === '' ? null : Number(rawSince);
  if (parsedSince !== null && (!Number.isFinite(parsedSince) || parsedSince < 0)) {
    sendJson(res, 400, { error: 'since_seq must be a non-negative integer' });
    return;
  }

  const maxBacklog = Math.max(1, Number(config.wakeMaxBacklog) || 1000);
  const heartbeatMs = Math.max(1000, Number(config.wakeSseHeartbeatMs) || 25_000);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  let since = parsedSince;
  const defaultSince = store.maxWakeEventSeq();
  if (since === null) since = defaultSince;

  // A resume cursor older than everything still retained cannot be repaired
  // from the stream; tell the client to fall back to check-in.
  const minSeq = store.minWakeEventSeq();
  if (since > 0 && minSeq !== null && since < minSeq - 1) {
    writeResync(res, defaultSince);
    res.end();
    return;
  }

  const sessionId = `ls_${randomUUID()}`;
  try {
    store.insertListenerSession({
      id: sessionId,
      agent_id: scope.all ? (auth.agent_id ?? auth.participant ?? 'user') : scope.agentId,
      chat_id: chatId,
      last_event_seq: since,
      status: 'connected',
      connected_at: Date.now(),
      last_seen_at: Date.now()
    });
  } catch { /* session telemetry must not block the stream */ }

  let closed = false;
  let blocked = 0;
  let lastSeq = since;

  // Subscribe before replay so an event inserted between the replay query and
  // listener registration is not lost. Duplicates are suppressed by lastSeq.
  const onEvent = (envelope) => {
    if (closed || !envelope) return;
    if (chatId && envelope.chat_id !== chatId) return;
    if (!scope.all && envelope.agent_id !== scope.agentId) return;
    if (Number(envelope.seq) <= lastSeq) return;
    lastSeq = Number(envelope.seq) || lastSeq;
    try {
      if (!writeSseEnvelope(res, envelope)) blocked += 1;
    } catch {
      cleanup();
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    if (blocked > maxBacklog) {
      // Unconsumed backlog: disconnect; the client reconnects with since_seq.
      cleanup();
      try { res.end(); } catch { /* ignore */ }
    }
  };
  wake?.on?.('event', onEvent);

  const replay = sseReplay(store, { afterSeq: since, scope, limit: maxBacklog, chatId });
  if (replay.length > maxBacklog) {
    writeResync(res, defaultSince);
    cleanup();
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  try {
    for (const row of replay) {
      const envelope = wakeEventEnvelope(store, row);
      if (!envelope) continue;
      lastSeq = Math.max(lastSeq, Number(envelope.seq) || 0);
      if (!writeSseEnvelope(res, envelope)) blocked += 1;
    }
  } catch {
    cleanup();
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  if (blocked > maxBacklog) {
    writeResync(res, defaultSince);
    cleanup();
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
      store.updateListenerSession(sessionId, { last_event_seq: lastSeq, last_seen_at: Date.now() });
    } catch { /* the close handler cleans up */ }
  }, heartbeatMs);
  heartbeat.unref?.();

  res.on?.('drain', () => { blocked = 0; });

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    wake?.off?.('event', onEvent);
    try {
      store.updateListenerSession(sessionId, { status: 'disconnected', last_seen_at: Date.now() });
    } catch { /* ignore */ }
  }

  req.on?.('close', cleanup);
  res.on?.('close', cleanup);
  res.on?.('error', cleanup);
}

export function normalizeCheckinEvery(value, fallback = CHECKIN_DEFAULT_MINUTES) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < CHECKIN_MIN_MINUTES || n > CHECKIN_MAX_MINUTES) {
    throw new Error(`every must be an integer between ${CHECKIN_MIN_MINUTES} and ${CHECKIN_MAX_MINUTES} minutes`);
  }
  return n;
}

// Core check-in computation, shared by PUT /checkin and agent_checkin.
export function computeCheckin({
  store, agents = null, agentId, every = undefined, now = Date.now()
} = {}) {
  const canonical = agentIdForParticipant(agentId) || agentId;
  if (!canonical) throw new Error('agent id is required');
  const previous = store.getCheckin(canonical);
  const everyMinutes = normalizeCheckinEvery(
    every, Number(previous?.every_minutes) || CHECKIN_DEFAULT_MINUTES
  );
  let inbox = { total_unread: 0, chats: [] };
  if (agents?.inbox) {
    inbox = agents.inbox({ agentId: canonical });
  }
  const empty = Number(inbox.total_unread) === 0;
  const consecutiveEmpty = empty ? Number(previous?.consecutive_empty ?? 0) + 1 : 0;
  store.upsertCheckin({
    agent_id: canonical,
    every_minutes: everyMinutes,
    last_checkin_at: now,
    consecutive_empty: consecutiveEmpty,
    updated_at: now
  });
  const lastEvent = store.lastWakeEvent({ agentId: canonical });
  const latestSeq = lastEvent ? Number(lastEvent.seq) : store.maxWakeEventSeq();
  // Design §7: after three empty check-ins, suggest doubling the interval.
  // This is advisory only; the stored value is never changed behind the
  // client's back.
  const suggested = consecutiveEmpty >= 3
    ? Math.min(CHECKIN_MAX_MINUTES, everyMinutes * 2)
    : everyMinutes;
  return {
    agent_id: canonical,
    participant_id: participantForAgentId(canonical),
    every_minutes: everyMinutes,
    last_checkin_at: now,
    next_checkin_at: now + everyMinutes * 60_000,
    consecutive_empty: consecutiveEmpty,
    suggested_every_minutes: suggested,
    latest_event_seq: latestSeq,
    inbox: {
      total_unread: Number(inbox.total_unread ?? 0),
      mentions_you: (inbox.chats ?? []).reduce((sum, chat) => sum + Number(chat.mentions_you ?? 0), 0),
      replies_to_you: (inbox.chats ?? []).reduce((sum, chat) => sum + Number(chat.replies_to_you ?? 0), 0),
      from_owner: (inbox.chats ?? []).reduce((sum, chat) => sum + Number(chat.from_owner ?? 0), 0),
      chats: inbox.chats ?? []
    }
  };
}

// PUT /checkin. Body: { every?, agent_id?, chat_id? }. An agent token may only
// check in as itself; a full reader may target any agent id.
export function handleCheckin({ res, store, agents, auth, config, body = {} }) {
  if (!auth) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  const own = auth.agent_id ?? agentIdForParticipant(auth.participant);
  const requested = body?.agent_id ? (agentIdForParticipant(body.agent_id) || body.agent_id) : own;
  if (!isFullReader(auth) && requested !== own) {
    auditDeny(config, store, auth, {
      surface: 'PUT /checkin',
      code: 'forbidden_checkin',
      status: 403,
      target: String(requested ?? '')
    });
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!requested) {
    sendJson(res, 400, { error: 'agent id is required' });
    return;
  }
  try {
    const result = computeCheckin({
      store, agents, agentId: requested, every: body?.every, now: Date.now()
    });
    if (body?.chat_id) {
      result.inbox.chats = result.inbox.chats.filter((chat) => chat.chat_id === body.chat_id);
      result.inbox.total_unread = result.inbox.chats.reduce((sum, chat) => sum + Number(chat.unread ?? 0), 0);
      result.inbox.mentions_you = result.inbox.chats
        .reduce((sum, chat) => sum + Number(chat.mentions_you ?? 0), 0);
      result.inbox.replies_to_you = result.inbox.chats
        .reduce((sum, chat) => sum + Number(chat.replies_to_you ?? 0), 0);
      result.inbox.from_owner = result.inbox.chats
        .reduce((sum, chat) => sum + Number(chat.from_owner ?? 0), 0);
    }
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}