import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { WakeService, wakeEventEnvelope } from '../src/wake.js';
import {
  computeCheckin, eventScope, handleEvents, normalizeCheckinEvery, sseReplay
} from '../src/events.js';
import { registerTools } from '../src/tools.js';
import { agentIdForParticipant } from '../src/agents.js';
import { runMigration } from '../scripts/migrate-rea-phase3.mjs';
import {
  authClaude, authMaster, authMuse, makeServices, seedChat, tempDir
} from './helpers.js';
import {
  createStateStore, parseArgs, parseSseBuffer, readTokenFile
} from '../scripts/listener.mjs';

function makeHarness(configOverrides = {}) {
  const dir = tempDir('rea3-');
  const services = makeServices(dir, {
    config: { agentAutoDeliver: true, wakeMinIntervalMs: 0, ...configOverrides }
  });
  const clock = { now: Date.now() };
  const wake = new WakeService({
    store: services.store,
    scheduler: services.scheduler,
    config: services.config,
    agents: services.agents,
    messages: services.messages,
    now: () => clock.now
  });
  services.scheduler.wake = wake;
  // Wire the Phase 3 hooks the same way server.js does.
  services.messages.onMention = (event) => wake.onMention(event);
  services.messages.onWakeEvent = (event) => wake.onWakeEvent(event);
  return { ...services, wake, clock, dir };
}

function addAgent(store, chatId, agent) {
  store.upsertChatParticipant({
    chat_id: chatId, participant_id: agent, kind: 'agent', role: agent, display_name: agent
  });
  store.insertChatMember({
    chat_id: chatId, agent_id: agentIdForParticipant(agent), role: 'member'
  });
  store.ensureInboxCursor({ chatId, agentId: agentIdForParticipant(agent), now: Date.now() });
}

function eventsFor(store, chatId, agent = 'agent_claude') {
  return store.listWakeEvents({ chatId, agentId: agent, order: 'asc', limit: 100 });
}

function cleanupDir(dir, ...stores) {
  for (const store of stores) {
    try { store?.close?.(); } catch { /* ignore */ }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------
test('Phase 3 migration creates four tables, snapshots first and is rerunnable', () => {
  const dir = tempDir('rea3-mig-');
  let store = null;
  try {
    store = new Store(join(dir, 'workbench.db'), dir);
    assert.equal(store.schemaVersion(), 6);
    store.close();
    store = null;

    const backupDir = join(dir, 'backups');
    const first = runMigration({ dbPath: join(dir, 'workbench.db'), dataDir: dir, backupDir });
    assert.equal(first.schema_version, 6);
    assert.ok(existsSync(first.backup_path), 'pre-migration snapshot exists');
    assert.deepEqual(first.tables, ['agent_wake', 'checkins', 'listener_sessions', 'wake_events']);

    // State written after the first run must survive a rerun.
    store = new Store(join(dir, 'workbench.db'), dir);
    const event = store.insertWakeEvent({
      id: 'wake_mig_1', chat_id: 'chat-1', agent_id: 'agent_claude', kind: 'mention',
      message_id: null, message_seq: 1, created_at: 1000
    });
    store.upsertAgentWake({ agent_id: 'agent_claude', chat_id: 'chat-1', enabled: false });
    store.upsertCheckin({ agent_id: 'agent_claude', every_minutes: 7, updated_at: 1000 });
    assert.equal(Number(event.seq), 1);
    store.close();
    store = null;

    const second = runMigration({
      dbPath: join(dir, 'workbench.db'), dataDir: dir, backupDir, backup: false
    });
    assert.equal(second.schema_version, 6);
    assert.equal(second.counts.wake_events, 1);
    assert.equal(second.counts.agent_wake, 1);
    assert.equal(second.counts.checkins, 1);
    store = new Store(join(dir, 'workbench.db'), dir);
    assert.equal(store.getAgentWake('agent_claude', 'chat-1').enabled, 0);
    assert.equal(Number(store.getCheckin('agent_claude').every_minutes), 7);
  } finally {
    cleanupDir(dir, store);
  }
});

// ---------------------------------------------------------------------------
// Event intake / wake dispatch
// ---------------------------------------------------------------------------
test('a user @mention records one event and starts one wake task with chat context', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-mention' });
    addAgent(h.store, chatId, 'claude');
    h.chats.send({
      chat_id: chatId, from: 'user', to: 'muse', body: 'please @claude look at this', mentions: ['claude']
    });

    assert.equal(h.scheduler.calls.length, 1, 'one wake task');
    const call = h.scheduler.calls[0];
    assert.equal(call.agent, 'claude');
    assert.equal(call.chatId, chatId);
    assert.match(call.prompt, /group chat wake event/);
    assert.match(call.prompt, /please @claude look at this/);
    assert.equal(call.timeoutMs, 60 * 60 * 1000);

    const events = eventsFor(h.store, chatId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'mention');
    assert.equal(events[0].status, 'delivered');
    assert.equal(Number(events[0].attempts), 1);
    assert.equal(events[0].delivery_task_id, 'task-1');

    // Completion resets the failure counter and clears the active slot.
    h.wake.onTaskFinished('task-1', 'COMPLETED');
    assert.equal(h.wake.active.size, 0);
    assert.equal(Number(h.store.getAgentWake('agent_claude', chatId).consecutive_failures), 0);
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('the message path emits reply and owner_post events in addition to mentions', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-events' });
    addAgent(h.store, chatId, 'claude');
    const threadId = `chat:${chatId}`;
    const now = new Date().toISOString();
    h.store.insertChatMessageBundle({
      id: 'agent-msg-1', thread_id: threadId, from_agent: 'claude', to_agent: 'user',
      summary: 'agent said something', body: 'agent said something', status: 'stored',
      chat_id: chatId, mentions_json: '[]', created_at: now, updated_at: now
    });

    const emitted = [];
    h.messages.onMention = () => {};
    h.messages.onWakeEvent = (event) => emitted.push(event);
    h.messages.send({
      from: 'user', to: 'claude', chat_id: chatId, body: 'replying to you', reply_to: 'agent-msg-1'
    });
    assert.ok(emitted.some((event) => event.kind === 'reply' && event.reply_from === 'claude'),
      'a reply event targets the replied-to agent');
    assert.ok(emitted.some((event) => event.kind === 'owner_post'), 'an owner_post event is emitted');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('a disabled wake switch records the event but starts no task', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-disabled' });
    addAgent(h.store, chatId, 'claude');
    h.wake.setEnabled({ agentId: 'claude', chatId, enabled: false });
    const now = h.clock.now;
    const [row] = h.wake.record({
      chat_id: chatId, kind: 'mention', message_id: 'missing', message_seq: 1,
      mentions: ['claude'], created_at: now
    });
    assert.equal(h.scheduler.calls.length, 0);
    assert.equal(row.status, 'disabled');
    assert.equal(h.store.countWakeEvents({ chatId, agentId: 'agent_claude' }), 1,
      'the event is still in the pull buffer');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// Throttle / coalescing
// ---------------------------------------------------------------------------
test('10-minute throttle and per-agent coalescing hold under repeated @s', () => {
  const h = makeHarness({ wakeMinIntervalMs: 10 * 60 * 1000 });
  try {
    const chatId = seedChat(h.store, { id: 'chat-throttle' });
    addAgent(h.store, chatId, 'claude');
    const mention = (body) => h.chats.send({
      chat_id: chatId, from: 'user', to: 'muse', body, mentions: ['claude']
    });

    mention('first @claude');
    assert.equal(h.scheduler.calls.length, 1);
    mention('second @claude while running');
    assert.equal(h.scheduler.calls.length, 1, 'active run coalesces instead of queueing');
    let events = eventsFor(h.store, chatId);
    assert.equal(events[1].status, 'merged');

    h.wake.onTaskFinished('task-1', 'COMPLETED');
    mention('third @claude immediately after');
    assert.equal(h.scheduler.calls.length, 1, 'interval throttle blocks the immediate third');
    events = eventsFor(h.store, chatId);
    assert.equal(events[2].status, 'throttled');

    h.clock.now += 11 * 60 * 1000;
    mention('fourth @claude after the interval');
    assert.equal(h.scheduler.calls.length, 2, 'wake resumes after 10 minutes');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('daily per-chat cap stops wake runs and records them as throttled', () => {
  const h = makeHarness({
    wakeMinIntervalMs: 0, wakeDailyPerAgentChat: 2, wakeDailyPerChat: 100
  });
  try {
    const chatId = seedChat(h.store, { id: 'chat-daily' });
    addAgent(h.store, chatId, 'claude');
    const record = () => h.wake.record({
      chat_id: chatId, kind: 'mention', message_id: 'missing', message_seq: 1, mentions: ['claude']
    });
    record(); h.wake.onTaskFinished('task-1', 'COMPLETED');
    record(); h.wake.onTaskFinished('task-2', 'COMPLETED');
    h.clock.now += 1000;
    record();
    assert.equal(h.scheduler.calls.length, 2, 'the third run exceeds the daily per-agent/chat cap');
    const events = eventsFor(h.store, chatId);
    assert.equal(events[2].status, 'throttled');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------
test('a failed run retries once; three consecutive failures disable wake and notify the owner', () => {
  const h = makeHarness({ wakeMinIntervalMs: 0 });
  try {
    const chatId = seedChat(h.store, { id: 'chat-failures' });
    addAgent(h.store, chatId, 'claude');
    const record = () => h.wake.record({
      chat_id: chatId, kind: 'mention', message_id: 'missing', message_seq: 1, mentions: ['claude']
    });

    record();
    assert.equal(h.scheduler.calls.length, 1);
    h.wake.onTaskFinished('task-1', 'FAILED');
    assert.equal(h.scheduler.calls.length, 2, 'the first failure retries once');
    h.wake.onTaskFinished('task-2', 'FAILED');
    assert.equal(h.scheduler.calls.length, 2, 'no second retry');
    assert.equal(Number(h.store.getAgentWake('agent_claude', chatId).consecutive_failures), 2);

    record();
    h.wake.onTaskFinished('task-3', 'FAILED');
    const config = h.wake.getConfig('claude', chatId);
    assert.equal(config.enabled, false, 'wake is disabled after three failures');
    assert.ok(config.disabled_at);
    const last = h.store.lastChatMessage(chatId);
    assert.equal(last.from_agent, 'muse');
    assert.match(last.body, /disabled/);
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('the no-output watchdog cancels the run and counts it as a failure', () => {
  const h = makeHarness({ wakeMinIntervalMs: 0 });
  try {
    const chatId = seedChat(h.store, { id: 'chat-watchdog' });
    addAgent(h.store, chatId, 'claude');
    h.wake.record({
      chat_id: chatId, kind: 'mention', message_id: 'missing', message_seq: 1, mentions: ['claude']
    });
    const info = h.wake.tracked.get('task-1');
    assert.ok(info);
    h.scheduler.lastActivity = h.clock.now - 16 * 60 * 1000;
    info.lastOutputAt = h.scheduler.lastActivity;
    h.wake._checkWatchdog(info);
    assert.deepEqual(h.scheduler.cancelled, ['task-1']);
    assert.equal(info.watchdogFired, true);

    h.wake.onTaskFinished('task-1', 'CANCELLED');
    assert.equal(h.scheduler.calls.length, 2, 'watchdog cancellation retries once');
    assert.equal(Number(h.store.getAgentWake('agent_claude', chatId).consecutive_failures), 1);
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------
test('check-in stores 2-1440 minutes, returns an Inbox summary and suggests backoff after 3 empty runs', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-checkin' });
    addAgent(h.store, chatId, 'claude');

    assert.throws(() => normalizeCheckinEvery(1), /between 2 and 1440/);
    assert.throws(() => normalizeCheckinEvery(1441), /between 2 and 1440/);
    assert.equal(normalizeCheckinEvery(2), 2);
    assert.equal(normalizeCheckinEvery(undefined), 10);

    const first = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude', every: 10, now: 1000
    });
    assert.equal(first.every_minutes, 10);
    assert.equal(first.last_checkin_at, 1000);
    assert.equal(first.consecutive_empty, 1);
    assert.equal(first.suggested_every_minutes, 10);
    assert.ok(first.inbox && Array.isArray(first.inbox.chats));

    computeCheckin({ store: h.store, agents: h.agents, agentId: 'claude', now: 2000 });
    const third = computeCheckin({ store: h.store, agents: h.agents, agentId: 'agent_claude', now: 3000 });
    assert.equal(third.agent_id, 'agent_claude');
    assert.equal(third.consecutive_empty, 3);
    assert.equal(third.suggested_every_minutes, 20, 'three empty check-ins suggest doubling' );
    assert.equal(Number(h.store.getCheckin('agent_claude').every_minutes), 10, 'stored interval is unchanged');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------
test('event scope and replay only expose an agent its own event stream', () => {
  const h = makeHarness();
  try {
    const mine = seedChat(h.store, { id: 'chat-mine' });
    const other = seedChat(h.store, { id: 'chat-other' });
    addAgent(h.store, mine, 'claude');
    addAgent(h.store, other, 'dsh');
    h.store.insertWakeEvent({ id: 'wake-a', chat_id: mine, agent_id: 'agent_claude', kind: 'mention', created_at: 10 });
    h.store.insertWakeEvent({ id: 'wake-b', chat_id: other, agent_id: 'agent_dsh', kind: 'mention', created_at: 20 });
    h.store.insertWakeEvent({ id: 'wake-c', chat_id: mine, agent_id: 'agent_dsh', kind: 'mention', created_at: 30 });

    const scope = eventScope(h.store, authClaude);
    assert.equal(scope.all, false);
    assert.equal(scope.agentId, 'agent_claude');
    assert.deepEqual(scope.chatIds, [mine]);
    const replay = sseReplay(h.store, { afterSeq: 0, scope, limit: 100 });
    assert.deepEqual(replay.map((row) => row.id), ['wake-a']);
    const pinned = eventScope(h.store, {
      ...authClaude, token_kind: 'agent-task', chat_id: other
    });
    assert.deepEqual(pinned.chatIds, [other], 'a per-task token stays pinned to its chat');
    assert.deepEqual(
      sseReplay(h.store, { afterSeq: 0, scope: eventScope(h.store, authMaster), limit: 100 })
        .map((row) => row.id),
      ['wake-a', 'wake-b', 'wake-c']
    );
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('wakeEventEnvelope carries the message sender and mentions', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-envelope' });
    addAgent(h.store, chatId, 'claude');
    const now = new Date().toISOString();
    h.store.insertChatMessageBundle({
      id: 'msg-env', thread_id: `chat:${chatId}`, from_agent: 'user', to_agent: 'muse',
      summary: 'hello', body: 'hello @claude', status: 'stored', chat_id: chatId,
      mentions_json: '["claude"]', created_at: now, updated_at: now
    });
    const row = h.store.insertWakeEvent({
      id: 'wake-env', chat_id: chatId, agent_id: 'agent_claude', kind: 'mention',
      message_id: 'msg-env', message_seq: 1, created_at: 10
    });
    const envelope = wakeEventEnvelope(h.store, row);
    assert.equal(envelope.from, 'user');
    assert.deepEqual(envelope.mentions, ['claude']);
    assert.equal(envelope.chat_id, chatId);
    assert.equal(envelope.agent_id, 'agent_claude');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.chunks = [];
    this.ended = false;
  }

  writeHead(status) { this.status = status; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end() { this.ended = true; this.emit('close'); }
  body() { return this.chunks.join(''); }
}

test('GET /events rejects a non-member chat subscription with an audit line', () => {
  const h = makeHarness();
  try {
    const other = seedChat(h.store, { id: 'chat-not-mine' });
    addAgent(h.store, other, 'dsh');
    const req = new EventEmitter();
    req.headers = {};
    const res = new FakeResponse();
    handleEvents({
      req, res, url: new URL(`http://x/events?chat_id=${other}`),
      store: h.store, wake: h.wake, config: h.config, auth: authClaude
    });
    assert.equal(res.status, 403);
    const audit = h.store.dataDir;
    assert.ok(existsSync(join(audit, 'security-audit.log')));
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('GET /events replays retained events and records a listener session', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-sse' });
    addAgent(h.store, chatId, 'claude');
    h.store.insertWakeEvent({
      id: 'wake-sse-1', chat_id: chatId, agent_id: 'agent_claude',
      kind: 'mention', message_id: null, message_seq: 1, created_at: 10
    });
    const req = new EventEmitter();
    req.headers = {};
    const res = new FakeResponse();
    handleEvents({
      req, res, url: new URL(`http://x/events?chat_id=${chatId}&since_seq=0`),
      store: h.store, wake: h.wake, config: h.config, auth: authClaude
    });
    const body = res.body();
    assert.equal(res.status, 200);
    assert.match(body, /id: 1/);
    assert.match(body, /"kind":"mention"/);
    const sessions = h.store.listListenerSessions({ agentId: 'agent_claude' });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'connected');
    res.emit('close');
    const after = h.store.listListenerSessions({ agentId: 'agent_claude' });
    assert.equal(after[0].status, 'disconnected');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
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
    wake: services.wake
  }, auth);
  return {
    invoke(name, args) {
      const handler = handlers.get(name);
      assert.ok(handler, `tool ${name} is registered`);
      return handler(args);
    }
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('wake MCP tools enforce ownership and self-scoping', async () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-tools' });
    addAgent(h.store, chatId, 'claude');
    const claude = makeToolRunner(h, authClaude);
    const master = makeToolRunner(h, authMaster);
    const muse = makeToolRunner(h, authMuse);

    const checkin = payload(await claude.invoke('agent_checkin', { every: 5 }));
    assert.equal(checkin.agent_id, 'agent_claude');
    assert.equal(checkin.every_minutes, 5);

    const disabled = await claude.invoke('wake_enable', { agent_id: 'claude', chat_id: chatId });
    assert.equal(disabled.isError, true, 'an agent token cannot change the switch');
    const enabled = payload(await master.invoke('wake_enable', { agent_id: 'claude', chat_id: chatId }));
    assert.equal(enabled.enabled, true);

    const forbidden = await claude.invoke('wake_status', { agent_id: 'agent_dsh' });
    assert.equal(forbidden.isError, true, 'an agent token cannot read another agent\'s wake state');
    const status = payload(await claude.invoke('wake_status', { chat_id: chatId }));
    assert.equal(status.agent_id, 'agent_claude');
    assert.equal(status.chats.length, 1);

    const listener = payload(await claude.invoke('listener_status', {}));
    assert.equal(listener.agent_id, 'agent_claude');
    assert.deepEqual(listener.sessions, []);

    const selfWakeForbidden = await claude.invoke('wake_now', { agent_id: 'agent_dsh', chat_id: chatId });
    assert.equal(selfWakeForbidden.isError, true);
    const manual = payload(await master.invoke('wake_now', { agent_id: 'claude', chat_id: chatId }));
    assert.equal(manual.woken, true);
    assert.ok(manual.task_id);
    const thirdPartyManual = payload(await master.invoke('wake_now', {
      agent_id: 'agent_thirdparty1', chat_id: chatId
    }));
    assert.equal(thirdPartyManual.woken, false);
    assert.match(thirdPartyManual.reason, /no local executor/);

    // Muse is a full reader and may inspect status, but wake_now remains
    // owner-only for another agent.
    const museView = payload(await muse.invoke('wake_status', { agent_id: 'agent_claude' }));
    assert.equal(museView.agent_id, 'agent_claude');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

// ---------------------------------------------------------------------------
// Listener CLI helpers
// ---------------------------------------------------------------------------
test('listener CLI parses args, requires a 600 token file and resumes from its state file', () => {
  const dir = tempDir('rea3-listener-');
  try {
    const parsed = parseArgs(['--agent', 'agent_demo', '--chat', 'chat-1']);
    assert.equal(parsed.agent, 'agent_demo');
    assert.equal(parsed.chat, 'chat-1');
    assert.ok(parsed.stateFile.endsWith('listener-state.json'));
    assert.throws(() => parseArgs([]), /--agent is required/);

    const tokenPath = join(dir, 'listener-token');
    writeFileSync(tokenPath, 'pachat_test_token\n', { mode: 0o600 });
    assert.equal(readTokenFile(tokenPath), 'pachat_test_token');
    if (process.platform !== 'win32') {
      writeFileSync(tokenPath, 'pachat_test_token\n', { mode: 0o644 });
      assert.throws(() => readTokenFile(tokenPath), /chmod 600/);
    }

    const statePath = join(dir, 'listener-state.json');
    const state = createStateStore(statePath);
    assert.equal(state.get().last_event_seq, 0);
    state.save({ last_event_seq: 42, agent: 'agent_demo' });
    const reopened = createStateStore(statePath);
    assert.equal(reopened.get().last_event_seq, 42);

    const parsedSse = parseSseBuffer(
      'retry: 3000\n\n: ping\n\nid: 7\ndata: {"seq":7,"kind":"mention"}\n\ndata: {"seq":8,'
    );
    assert.equal(parsedSse.events.length, 1);
    assert.equal(parsedSse.events[0].id, '7');
    assert.equal(parsedSse.events[0].json.seq, 7);
    assert.match(parsedSse.rest, /seq":8/);
  } finally {
    cleanupDir(dir);
  }
});