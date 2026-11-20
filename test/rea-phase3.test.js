import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { WakeService, wakeEventEnvelope } from '../src/wake.js';
import {
  computeCheckin, eventScope, handleCheckin, handleEvents, normalizeCheckinEvery, sseReplay
} from '../src/events.js';
import { registerTools } from '../src/tools.js';
import { agentIdForParticipant } from '../src/agents.js';
import { runMigration } from '../scripts/migrate-rea-phase3.mjs';
import {
  authClaude, authMaster, authMuse, makeConfig, makeServices, seedChat, seedTask, tempDir
} from './helpers.js';
import {
  LOCAL_DAILY_PER_CHAT, createStateStore, localDayKey, parseArgs, parseSseBuffer,
  readTokenFile, reserveLocalRun, startLocalRun
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

    const [firstEvent] = record();
    assert.equal(h.scheduler.calls.length, 1);
    h.wake.onTaskFinished('task-1', 'FAILED');
    assert.equal(h.scheduler.calls.length, 2, 'the first failure retries once');
    const afterRetry = h.store.getWakeEvent(firstEvent.id);
    assert.equal(afterRetry.delivery_task_id, 'task-1',
      'a retry keeps the first delivery task id for audit');
    assert.equal(Number(afterRetry.attempts), 2);
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
// Cross-review regressions (M1-M12)
// ---------------------------------------------------------------------------
test('M1: the wake watchdog uses real output time, not heartbeat time', async () => {
  const dir = tempDir('rea3-m1-');
  let store = null;
  let scheduler = null;
  let wake = null;
  try {
    const config = makeConfig(dir, {
      agentAutoDeliver: true,
      wakeMinIntervalMs: 0,
      maxParallel: 4,
      dshParallel: 2,
      heartbeatMs: 20,
      taskTimeoutMs: 60 * 60 * 1000,
      staleAfterMs: 60 * 60 * 1000
    });
    store = new Store(join(dir, 'workbench.db'), dir);
    // A real Scheduler around an executor that starts and then says nothing.
    // Only the executor is faked; launch/heartbeat/lastActivityAt are real.
    scheduler = new Scheduler(store, config, {
      executors: { claude: { start() { return { cancel() {}, pid: null }; } } }
    });
    const clock = { now: Date.now() };
    wake = new WakeService({ store, scheduler, config, now: () => clock.now });
    scheduler.wake = wake;

    const chatId = seedChat(store, { id: 'chat-m1' });
    addAgent(store, chatId, 'claude');
    wake.record({ chat_id: chatId, kind: 'mention', mentions: ['claude'], message_seq: 1 });
    const info = [...wake.active.values()][0];
    assert.ok(info, 'a wake task is active');

    const first = scheduler.lastActivityAt(info.taskId);
    assert.ok(Number.isFinite(first));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(store.getLogs(info.taskId).some((row) => /heartbeat: no output/.test(row.line)),
      'the real heartbeat did run while the task was silent');
    assert.equal(scheduler.lastActivityAt(info.taskId), first,
      'silent heartbeats must not refresh the real last-output timestamp');

    clock.now = first + 16 * 60 * 1000;
    wake._checkWatchdog(info);
    assert.equal(info.watchdogFired, true);
    assert.equal(scheduler.running.get(info.taskId)?.cancelled, true,
      'a silent task is cancelled by the 15-minute breaker');
  } finally {
    try { wake?.stop(); } catch { /* ignore */ }
    try { scheduler?.shutdown(); } catch { /* ignore */ }
    cleanupDir(dir, store);
  }
});

test('M2: cancelling a queued wake task frees the (chat, agent) slot', () => {
  const dir = tempDir('rea3-m2-');
  let store = null;
  let scheduler = null;
  let wake = null;
  try {
    const config = makeConfig(dir, {
      agentAutoDeliver: true,
      wakeMinIntervalMs: 0,
      maxParallel: 1,
      dshParallel: 1,
      heartbeatMs: 60_000,
      taskTimeoutMs: 60 * 60 * 1000,
      staleAfterMs: 60 * 60 * 1000
    });
    store = new Store(join(dir, 'workbench.db'), dir);
    scheduler = new Scheduler(store, config, {
      executors: { claude: { start() { return { cancel() {}, pid: null }; } } }
    });
    wake = new WakeService({ store, scheduler, config, now: () => Date.now() });
    scheduler.wake = wake;

    // Occupy the only parallel slot so the wake task stays queued.
    scheduler.createTask({ agent: 'claude', prompt: 'occupy the slot', cwd: dir });
    let created = 0;
    const createTask = scheduler.createTask.bind(scheduler);
    scheduler.createTask = (input) => { created += 1; return createTask(input); };

    const chatId = seedChat(store, { id: 'chat-m2' });
    addAgent(store, chatId, 'claude');
    wake.record({ chat_id: chatId, kind: 'mention', mentions: ['claude'], message_seq: 1 });
    const info = wake.active.get(`${chatId}:claude`);
    assert.ok(info, 'the wake run is tracked even while queued');
    assert.equal(created, 1);
    assert.equal(store.getTask(info.taskId).state, 'PENDING');

    scheduler.cancel(info.taskId);
    assert.equal(store.getTask(info.taskId).state, 'CANCELLED');
    assert.equal(wake.active.size, 0, 'a queued cancellation releases the active slot');
    assert.equal(store.getWakeEvent(info.eventId).status, 'cancelled');

    wake.record({ chat_id: chatId, kind: 'mention', mentions: ['claude'], message_seq: 2 });
    assert.equal(created, 2, 'the next @ starts a new task instead of being merged');
    const events = eventsFor(store, chatId);
    assert.equal(events[1].status, 'delivered');
  } finally {
    try { wake?.stop(); } catch { /* ignore */ }
    try { scheduler?.shutdown(); } catch { /* ignore */ }
    cleanupDir(dir, store);
  }
});

test('M3: the live SSE callback obeys a per-task token chat binding', () => {
  const h = makeHarness();
  try {
    const chatA = seedChat(h.store, { id: 'chat-live-a' });
    const chatB = seedChat(h.store, { id: 'chat-live-b' });
    addAgent(h.store, chatA, 'claude');
    addAgent(h.store, chatB, 'claude');
    const req = new EventEmitter();
    req.headers = {};
    const res = new FakeResponse();
    handleEvents({
      req,
      res,
      url: new URL('http://x/events?since_seq=0'),
      store: h.store,
      wake: h.wake,
      config: h.config,
      auth: { ...authClaude, token_kind: 'agent-task', chat_id: chatA }
    });
    h.wake.emit('event', {
      id: 'evt-other-chat', seq: 100, chat_id: chatB, agent_id: 'agent_claude', kind: 'mention'
    });
    h.wake.emit('event', {
      id: 'evt-my-chat', seq: 101, chat_id: chatA, agent_id: 'agent_claude', kind: 'mention'
    });
    const body = res.body();
    assert.doesNotMatch(body, /evt-other-chat/,
      'a pinned token does not receive live events from another chat');
    assert.match(body, /evt-my-chat/);
    res.emit('close');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M5: @muse records an external event and never starts a local task', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-muse' });
    h.chats.send({
      chat_id: chatId, from: 'user', to: 'muse', body: 'hello @muse', mentions: ['muse']
    });
    const events = eventsFor(h.store, chatId, 'agent_muse');
    assert.equal(events.length, 1, '@muse produces a wake event');
    assert.equal(events[0].kind, 'mention');
    assert.equal(events[0].status, 'pending', 'Muse consumes it over SSE / check-in');
    assert.equal(h.scheduler.calls.length, 0, 'Muse has no local executor');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M6: restart reconciliation settles in-flight wake events by delivery_task_id', () => {
  const dir = tempDir('rea3-m6-');
  let store = null;
  try {
    const config = makeConfig(dir, {});
    store = new Store(join(dir, 'workbench.db'), dir);
    const chatId = seedChat(store, { id: 'chat-m6' });
    const task = seedTask(store, { id: 'task-m6', agent: 'claude', chatId, state: 'WORKING' });
    store.insertWakeEvent({
      id: 'wake-m6', chat_id: chatId, agent_id: 'agent_claude', kind: 'mention',
      status: 'delivered', attempts: 1, delivery_task_id: task.id, created_at: Date.now()
    });

    const scheduler = new Scheduler(store, config);
    scheduler.reconcile({ replay: false });
    assert.equal(store.getTask(task.id).state, 'FAILED');

    const wake = new WakeService({ store, scheduler, config });
    const summary = wake.reconcile();
    assert.equal(summary.reconciled_events, 1);
    const row = store.getWakeEvent('wake-m6');
    assert.equal(row.status, 'failed');
    assert.equal(Number(store.getAgentWake('agent_claude', chatId).consecutive_failures), 1,
      'the lost run counts against the failure circuit breaker');
  } finally {
    cleanupDir(dir, store);
  }
});

test('M7: the wake event seq counter survives pruning the whole table', () => {
  const h = makeHarness();
  try {
    const first = h.store.insertWakeEvent({
      id: 'wake-seq-1', chat_id: 'chat-seq', agent_id: 'agent_claude', kind: 'mention', created_at: 1000
    });
    assert.equal(Number(first.seq), 1);
    h.store.pruneWakeEvents(Date.now() + 10_000_000);
    assert.equal(h.store.countWakeEvents({ chatId: 'chat-seq' }), 0);
    const second = h.store.insertWakeEvent({
      id: 'wake-seq-2', chat_id: 'chat-seq', agent_id: 'agent_claude', kind: 'mention', created_at: 2000
    });
    assert.equal(Number(second.seq), 2, 'the counter does not rewind after retention pruning');
    assert.equal(h.store.maxWakeEventSeq(), 2);
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M8: an unauthenticated /events or /checkin writes an audit line', () => {
  const h = makeHarness();
  try {
    const req = new EventEmitter();
    req.headers = {};
    const eventsRes = new FakeResponse();
    handleEvents({
      req, res: eventsRes, url: new URL('http://x/events'),
      store: h.store, wake: h.wake, config: h.config, auth: null
    });
    assert.equal(eventsRes.status, 401);
    const checkinRes = new FakeResponse();
    handleCheckin({
      res: checkinRes, store: h.store, agents: h.agents, auth: null, config: h.config, body: {}
    });
    assert.equal(checkinRes.status, 401);
    const audit = readFileSync(join(h.store.dataDir, 'security-audit.log'), 'utf8');
    assert.match(audit, /GET \/events|surface=GET \/events/);
    assert.match(audit, /surface=PUT \/checkin/);
    assert.equal((audit.match(/status=401/g) ?? []).length >= 2, true);
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M10: check-in falls back to config.checkinDefaultMinutes and filters every counter', () => {
  const h = makeHarness({ checkinDefaultMinutes: 25 });
  try {
    const chatId = seedChat(h.store, { id: 'chat-m10' });
    addAgent(h.store, chatId, 'claude');
    const result = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude',
      defaultMinutes: h.config.checkinDefaultMinutes, now: 1000
    });
    assert.equal(result.every_minutes, 25, 'the configured default is used instead of a hard-coded 10');
    assert.equal(Number(h.store.getCheckin('agent_claude').every_minutes), 25);

    const filtered = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude', chatId, now: 2000
    });
    assert.deepEqual(filtered.inbox.chats.map((chat) => chat.chat_id), [chatId]);
    assert.equal(typeof filtered.inbox.mentions_you, 'number');
    assert.equal(typeof filtered.inbox.replies_to_you, 'number');
    assert.equal(typeof filtered.inbox.from_owner, 'number');
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M11: an unknown wake kind is ignored, not coerced to a mention', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-m11' });
    addAgent(h.store, chatId, 'claude');
    const rows = h.wake.record({
      chat_id: chatId, kind: 'recall', message_id: 'msg', message_seq: 1, mentions: ['claude']
    });
    assert.deepEqual(rows, []);
    assert.equal(h.store.countWakeEvents({ chatId }), 0);
    assert.equal(h.scheduler.calls.length, 0);
  } finally {
    cleanupDir(h.dir, h.store);
  }
});

test('M4: listener local runs honour the daily cap, silence breaker and hard cap', async () => {
  const dir = tempDir('rea3-m4-');
  try {
    const statePath = join(dir, 'listener-state.json');
    const state = createStateStore(statePath);
    const day1 = new Date(2026, 10, 19, 12, 0, 0).getTime();
    assert.equal(localDayKey(day1), '2026-11-19');
    assert.equal(reserveLocalRun(state, 'chat-1', { now: day1, limit: 2 }).allowed, true);
    assert.equal(reserveLocalRun(state, 'chat-1', { now: day1, limit: 2 }).allowed, true);
    const blocked = reserveLocalRun(state, 'chat-1', { now: day1, limit: 2 });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.count, 2);
    const day2 = new Date(2026, 10, 20, 12, 0, 0).getTime();
    assert.equal(reserveLocalRun(state, 'chat-1', { now: day2, limit: 2 }).allowed, true,
      'the counter resets on a new local day');
    assert.equal(createStateStore(statePath).get().local_runs['chat-1'].count, 1,
      'the counter is persisted across restarts');
    assert.equal(LOCAL_DAILY_PER_CHAT, 100);

    const silent = join(dir, 'silent.mjs');
    const ok = join(dir, 'ok.mjs');
    writeFileSync(silent, 'setTimeout(() => {}, 4000);\n');
    writeFileSync(ok, 'process.exit(0);\n');
    const quiet = `"${process.execPath}" "${silent}"`;

    await assert.rejects(
      startLocalRun({ command: quiet, agent: 'agent_x', event: { chat_id: 'c' }, noOutputMs: 100, hardCapMs: 3000 }),
      /15 minutes without output/
    );
    await assert.rejects(
      startLocalRun({ command: quiet, agent: 'agent_x', event: { chat_id: 'c' }, noOutputMs: 10_000, hardCapMs: 100 }),
      /1-hour hard cap/
    );
    const done = await startLocalRun({
      command: `"${process.execPath}" "${ok}"`, agent: 'agent_x', event: { chat_id: 'c' }
    });
    assert.equal(done.code, 0);
  } finally {
    cleanupDir(dir);
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
// ---------------------------------------------------------------------------
// Phase 3 leftovers (P1/P2/P3)
// ---------------------------------------------------------------------------
test('P1: unread-@ reminders skip external participants and survive a restart', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-p1' });
    addAgent(h.store, chatId, 'claude');
    const old = h.clock.now - 11 * 60 * 1000;
    h.store.insertWakeEvent({
      id: 'evt-muse', chat_id: chatId, agent_id: 'agent_muse', kind: 'mention',
      message_seq: 1, status: 'pending', created_at: old
    });
    h.store.insertWakeEvent({
      id: 'evt-claude', chat_id: chatId, agent_id: 'agent_claude', kind: 'mention',
      message_seq: 2, status: 'pending', created_at: old
    });

    const notices = [];
    h.wake._notifyOwner = (_chatId, body, key) => {
      notices.push({ body, key });
      return { message_id: `notice-${key}` };
    };
    h.wake._checkUnreadMentions();
    assert.deepEqual(notices.map((notice) => notice.key), ['wake-unread:evt-claude'],
      '@muse is external: it must not produce a false "has not read" notice');
    assert.match(notices[0].body, /claude has not read the @/);
    assert.equal(h.store.hasWakeNotice('evt-claude'), true);
    assert.equal(h.store.hasWakeNotice('evt-muse'), false);

    // A restart gets a fresh in-memory cache; the persisted notice must hold.
    const restarted = new WakeService({ store: h.store, now: () => h.clock.now });
    const repeated = [];
    restarted._notifyOwner = (_chatId, _body, key) => { repeated.push(key); return {}; };
    restarted._checkUnreadMentions();
    assert.deepEqual(repeated, [], 'a restart must not repeat an already-notified event');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('P2: the unread-@ sweep pages past 500 expired mentions', () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-p2a' });
    addAgent(h.store, chatId, 'claude');
    const old = h.clock.now - 11 * 60 * 1000;
    for (let i = 0; i < 600; i += 1) {
      h.store.insertWakeEvent({
        id: `evt-p2a-${i}`, chat_id: chatId, agent_id: 'agent_claude', kind: 'mention',
        message_seq: i + 1, status: 'pending',
        // Duplicate timestamps exercise the (created_at, id) keyset cursor.
        created_at: old + (i % 5)
      });
    }
    const keys = [];
    h.wake._notifyOwner = (_chatId, _body, key) => { keys.push(key); return { message_id: key }; };
    h.wake._checkUnreadMentions();
    assert.equal(keys.length, 600, 'every expired mention is covered, not only the newest 500');
    assert.equal(new Set(keys).size, 600);

    const beforeSecond = keys.length;
    h.wake._checkUnreadMentions();
    assert.equal(keys.length, beforeSecond, 'persisted notices are not repeated');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('P2: chat_mark_read returns an exact unread count beyond 500', async () => {
  const h = makeHarness();
  try {
    const chatId = seedChat(h.store, { id: 'chat-p2b' });
    addAgent(h.store, chatId, 'claude');
    const now = new Date().toISOString();
    for (let i = 0; i < 600; i += 1) {
      h.store.insertChatMessageBundle({
        id: `p2b-${i}`, thread_id: `chat:${chatId}`, from_agent: 'user', to_agent: 'claude',
        summary: `m${i}`, body: `m${i}`, status: 'stored', chat_id: chatId,
        mentions_json: '[]', created_at: now, updated_at: now
      });
    }
    const tools = makeToolRunner(h, authClaude);
    const result = payload(await tools.invoke('chat_mark_read', { chat_id: chatId, up_to_seq: 0 }));
    assert.equal(result.last_read_seq, 0);
    assert.equal(result.unread, 600, 'COUNT(*) must not stop at the old 500-row page');
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});

test('P3: a chat-scoped check-in never rewrites the agent-level empty counter', () => {
  const h = makeHarness();
  try {
    const chatA = seedChat(h.store, { id: 'chat-p3-a' });
    const chatB = seedChat(h.store, { id: 'chat-p3-b' });
    addAgent(h.store, chatA, 'claude');
    addAgent(h.store, chatB, 'claude');
    const now = new Date().toISOString();
    h.store.insertChatMessageBundle({
      id: 'p3-a-1', thread_id: `chat:${chatA}`, from_agent: 'user', to_agent: 'claude',
      summary: 'hi', body: 'hi', status: 'stored', chat_id: chatA,
      mentions_json: JSON.stringify(['claude']), created_at: now, updated_at: now
    });

    const scopedEmpty = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude', chatId: chatB, now: 1000
    });
    assert.equal(scopedEmpty.inbox.total_unread, 0, 'the scoped view still shows only chat B');
    assert.equal(scopedEmpty.consecutive_empty, 0, 'the agent still has unread mail in chat A');
    assert.equal(Number(h.store.getCheckin('agent_claude').consecutive_empty), 0);

    // Once chat A is read the agent really is idle, and the scoped call counts it.
    const last = h.store.lastChatMessage(chatA);
    h.agents.markRead({ chatId: chatA, agentId: 'agent_claude', upToSeq: last.seq });
    const scopedIdle = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude', chatId: chatB, now: 2000
    });
    assert.equal(scopedIdle.consecutive_empty, 1);

    // Unread in the scoped chat resets the counter exactly like the full view.
    h.store.insertChatMessageBundle({
      id: 'p3-b-1', thread_id: `chat:${chatB}`, from_agent: 'user', to_agent: 'claude',
      summary: 'ping', body: 'ping', status: 'stored', chat_id: chatB,
      mentions_json: '[]', created_at: now, updated_at: now
    });
    const scopedBusy = computeCheckin({
      store: h.store, agents: h.agents, agentId: 'claude', chatId: chatB, now: 3000
    });
    assert.equal(scopedBusy.consecutive_empty, 0);
    assert.equal(Number(h.store.getCheckin('agent_claude').consecutive_empty), 0);
  } finally {
    h.wake.stop();
    cleanupDir(h.dir, h.store);
  }
});
