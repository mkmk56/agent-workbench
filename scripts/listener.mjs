#!/usr/bin/env node
// REA Phase 3 Listener CLI.
//
// Single file, Node 18+, zero dependencies. It holds the engine's SSE stream
// (GET /events) and reacts to events targeted at one agent:
//
//   1. it calls the engine MCP tool wake_now for the agent;
//   2. if the engine has no local executor for that agent (third-party) and a
//      --command is configured, it runs that command locally with the event
//      JSON in LISTENER_EVENT; otherwise it logs the event as actionable.
//
// A failed run is logged as failed. This tool never reports success for an
// action it did not perform. The token is read from a 600-permission file and
// is never printed or stored in the log/state files.
//
// Usage:
//   node scripts/listener.mjs --agent agent_demo --token-file ~/.agent-workbench/listener-token
//   node scripts/listener.mjs --agent agent_demo --chat <chat_id> --command "my-agent --headless"
//
// See docs/rea/PHASE3_LISTENER.md for install / pause / uninstall / logs.

import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = process.env.WORKBENCH_URL || 'http://127.0.0.1:8080';
const CONNECT_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

// Design §6: the local execution path enforces the same numbers as the engine
// side. The engine cannot see a process it did not start, so the listener has
// to stop a silent or runaway local run itself.
export const LOCAL_NO_OUTPUT_MS = 15 * 60 * 1000;
export const LOCAL_HARD_CAP_MS = 60 * 60 * 1000;
export const LOCAL_DAILY_PER_CHAT = 100;

export function parseArgs(argv) {
  const args = {
    agent: null,
    chat: null,
    baseUrl: DEFAULT_BASE_URL,
    mcpUrl: null,
    tokenFile: process.env.LISTENER_TOKEN_FILE || join(homedir(), '.agent-workbench', 'listener-token'),
    stateFile: null,
    logFile: null,
    command: null,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    once: false,
    wakeNow: true,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent') args.agent = argv[++i];
    else if (arg === '--chat') args.chat = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--mcp-url') args.mcpUrl = argv[++i];
    else if (arg === '--token-file') args.tokenFile = argv[++i];
    else if (arg === '--state-file') args.stateFile = argv[++i];
    else if (arg === '--log-file') args.logFile = argv[++i];
    else if (arg === '--command') args.command = argv[++i];
    else if (arg === '--connect-timeout-ms') args.connectTimeoutMs = Number(argv[++i]) || CONNECT_TIMEOUT_MS;
    else if (arg === '--once') args.once = true;
    else if (arg === '--no-wake-now') args.wakeNow = false;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.agent) throw new Error('--agent is required');
  const dir = dirname(args.tokenFile);
  args.stateFile = args.stateFile || join(dir, 'listener-state.json');
  args.logFile = args.logFile || join(dir, 'listener.log');
  args.mcpUrl = args.mcpUrl || `${String(args.baseUrl).replace(/\/+$/, '')}/mcp`;
  return args;
}

// A token file readable by group/others is refused on POSIX. Windows ACLs do
// not expose a meaningful mode, so the listener warns instead of failing there.
export function readTokenFile(path, { platform = process.platform } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw new Error(`cannot read token file ${path}: ${error.code || error.message}`);
  }
  if (!stat.isFile()) throw new Error(`token path is not a regular file: ${path}`);
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`token file ${path} must not be readable by group/others (chmod 600)`);
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!token) throw new Error(`token file is empty: ${path}`);
  return token;
}

export function createStateStore(path) {
  let state = { last_event_seq: 0, agent: null, chat: null, local_runs: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') state = { ...state, ...parsed };
  } catch { /* first run, or a state file we cannot use */ }
  function save(patch = {}) {
    state = { ...state, ...patch };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return state;
  }
  return {
    get: () => ({ ...state }),
    save
  };
}

// Incremental SSE parser. Returns completed events and keeps the partial tail.
export function parseSseBuffer(buffer) {
  const events = [];
  // Tunnels and HTTP libraries may normalize line endings; the engine writes
  // LF, but accepting CRLF keeps the parser transport-independent.
  let rest = String(buffer).replace(/\r\n/g, '\n');
  for (;;) {
    const index = rest.indexOf('\n\n');
    if (index < 0) break;
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    let id = null;
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat / comment
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) continue;
    const text = data.join('\n');
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw for the log */ }
    events.push({ id, data: text, json });
  }
  return { events, rest };
}

// Local-date key for the per-chat daily counter. The counter is persisted in
// listener-state.json so a restart does not reset the day.
export function localDayKey(now = Date.now()) {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// Reserve one local run for a chat. Returns {allowed:false} at the cap; the
// event is then left to check-in instead of being silently dropped.
export function reserveLocalRun(state, chatKey, { now = Date.now(), limit = LOCAL_DAILY_PER_CHAT } = {}) {
  const current = state.get();
  const runs = current.local_runs && typeof current.local_runs === 'object' ? current.local_runs : {};
  const day = localDayKey(now);
  const entry = runs[chatKey];
  const used = entry && entry.day === day ? Math.max(0, Number(entry.count) || 0) : 0;
  if (used >= limit) return { allowed: false, count: used, day, limit };
  state.save({ local_runs: { ...runs, [chatKey]: { day, count: used + 1 } } });
  return { allowed: true, count: used + 1, day, limit };
}

// A shell-spawned command has children of its own. On Windows child.kill()
// only ends the shell, so the agent process would keep running; taskkill /T
// takes the tree with it.
function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore'
      });
      return;
    } catch { /* fall through to kill() */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}

// Spawn one local agent command with the §6 limits: kill after 15 minutes
// without output and after the 1-hour hard cap. Output on stdout or stderr
// counts as activity; silence is what the breaker measures.
export function startLocalRun({
  command, agent, event, log = () => {},
  noOutputMs = LOCAL_NO_OUTPUT_MS,
  hardCapMs = LOCAL_HARD_CAP_MS,
  onChild = null
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        LISTENER_EVENT: JSON.stringify(event),
        LISTENER_AGENT: agent,
        LISTENER_CHAT_ID: event?.chat_id || ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (onChild) onChild(child);

    let settled = false;
    let stoppedFor = null;
    let lastOutputAt = Date.now();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearInterval(watchdog);
      fn(value);
    };
    const stop = (reason) => {
      if (stoppedFor || settled) return;
      stoppedFor = reason;
      log(`local run stopped after ${reason}`);
      stopChild(child);
    };

    child.stdout?.on('data', (chunk) => {
      lastOutputAt = Date.now();
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      lastOutputAt = Date.now();
      process.stderr.write(chunk);
    });
    const hardTimer = setTimeout(() => stop('the 1-hour hard cap'), hardCapMs);
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt >= noOutputMs) stop('15 minutes without output');
    }, Math.max(20, Math.min(30_000, noOutputMs)));
    hardTimer.unref?.();
    watchdog.unref?.();

    child.on('error', (error) => finish(reject, error));
    child.on('exit', (code, signal) => {
      if (stoppedFor) {
        finish(reject, new Error(`local command stopped after ${stoppedFor}`));
      } else if (code === 0) {
        finish(resolve, { code });
      } else {
        finish(reject, new Error(`local command exited ${code}${signal ? ` (${signal})` : ''}`));
      }
    });
  });
}

function logLine(logFile, line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, text, 'utf8');
  } catch { /* the console line below still reports the failure */ }
  process.stdout.write(text);
}

// POST one JSON-RPC message and return the parsed response. The stateless MCP
// endpoint may answer as JSON or as a one-event SSE stream.
async function postMcp(url, token, message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(message)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 200)}`);
  if (!text.trim()) return null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { last = JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function mcpInitialize(url, token) {
  try {
    await postMcp(url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rea-listener', version: '0.1.0' }
      }
    });
    await postMcp(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch {
    // Some stateless deployments answer tools/call without a handshake. The
    // actual call below reports the real failure.
  }
}

async function mcpToolCall({ url, token, name, args }) {
  const response = await postMcp(url, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args }
  });
  if (!response) throw new Error('empty MCP response');
  if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
  const text = response.result?.content?.find((entry) => entry?.type === 'text')?.text;
  if (!text) return response.result ?? null;
  try { return JSON.parse(text); } catch { return text; }
}

function shouldHandle(event, agent) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'resync') return true;
  if (event.agent_id && event.agent_id !== agent) return false;
  return ['mention', 'reply', 'owner_post', 'manual'].includes(event.kind);
}

export async function runListener(options) {
  const {
    agent, chat, baseUrl, mcpUrl, tokenFile, stateFile, logFile, command,
    connectTimeoutMs, once, wakeNow
  } = options;
  const token = readTokenFile(tokenFile);
  const state = createStateStore(stateFile);
  state.save({ agent, chat });

  const log = (line) => logLine(logFile, line);
  if (process.platform === 'win32') {
    // readTokenFile cannot enforce POSIX modes here; say so instead of
    // pretending the token file is protected.
    log('warning: Windows does not expose POSIX file modes; protect listener-token with an ACL');
  }
  const eventUrl = new URL('/events', baseUrl);
  if (chat) eventUrl.searchParams.set('chat_id', chat);
  const since = Number(state.get().last_event_seq) || 0;
  if (since > 0) eventUrl.searchParams.set('since_seq', String(since));

  let closed = false;
  let request = null;
  let connectionLostAt = null;
  let retryIndex = 0;
  const running = new Map(); // chat_id -> child process

  const finish = (code, reason) => {
    if (closed) return;
    closed = true;
    try { request?.destroy(); } catch { /* ignore */ }
    for (const child of running.values()) {
      stopChild(child);
    }
    log(`listener stopping (${reason}) code=${code}`);
    process.exit(code);
  };

  const connect = () => {
    if (closed) return;
    const mod = eventUrl.protocol === 'https:' ? https : http;
    request = mod.get(eventUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'cache-control': 'no-cache'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        connectionLostAt = connectionLostAt ?? Date.now();
        log(`connect rejected status=${res.statusCode}; retrying`);
        res.on('end', scheduleReconnect);
        return;
      }
      connectionLostAt = null;
      retryIndex = 0;
      log(`connected agent=${agent}${chat ? ` chat=${chat}` : ''} since_seq=${state.get().last_event_seq}`);
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const item of parsed.events) {
          handleEvent(item.json, item.id).catch((error) => {
            log(`event handling failed: ${error.message}`);
          });
        }
      });
      res.on('end', () => {
        connectionLostAt = connectionLostAt ?? Date.now();
        log('stream ended; reconnecting');
        scheduleReconnect();
      });
      res.on('error', (error) => {
        connectionLostAt = connectionLostAt ?? Date.now();
        log(`stream error: ${error.message}; reconnecting`);
        scheduleReconnect();
      });
    });
    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(new Error('connect timeout'));
    });
    request.on('error', (error) => {
      connectionLostAt = connectionLostAt ?? Date.now();
      log(`connect failed: ${error.message}`);
      scheduleReconnect();
    });
  };

  function scheduleReconnect() {
    if (closed) return;
    const now = Date.now();
    if (connectionLostAt && now - connectionLostAt >= connectTimeoutMs) {
      // Design §6: do not idle forever. Exit so a service manager/uninstall
      // step sees the failure; it never pretends to be connected.
      finish(2, `no connection for ${Math.round(connectTimeoutMs / 1000)}s`);
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    setTimeout(connect, delay);
  }

  async function handleEvent(event, id) {
    if (!event) {
      log(`ignored malformed SSE event id=${id ?? 'none'}`);
      return;
    }
    if (event.type === 'resync') {
      log(`resync requested last_seq=${event.last_seq ?? '?'}; falling back to check-in`);
      await callCheckin();
      return;
    }
    if (!shouldHandle(event, agent)) return;
    if (event.seq && Number(event.seq) <= (Number(state.get().last_event_seq) || 0)) return;

    log(`event seq=${event.seq ?? '?'} kind=${event.kind} chat=${event.chat_id ?? '-'} message=${event.message_id ?? '-'}`);

    if (wakeNow) {
      try {
        const result = await mcpToolCall({
          url: mcpUrl,
          token,
          name: 'wake_now',
          args: {
            agent_id: event.agent_id || agent,
            chat_id: event.chat_id,
            ...(event.message_id ? { message_id: event.message_id } : {})
          }
        });
        if (result?.woken) {
          log(`wake_now started task=${result.task_id ?? '?'} attempt=${result.attempt ?? 1}`);
          state.save({ last_event_seq: Number(event.seq) || Number(state.get().last_event_seq) || 0 });
          if (once) finish(0, 'once mode');
          return;
        }
        const reason = result?.reason ?? 'unknown reason';
        log(`wake_now did not start a run: ${reason}`);
        // Only a "no local executor" answer invites a local run. Disabled,
        // throttled, daily-cap and already-running answers are owner decisions
        // and must not be bypassed by the listener.
        if (!/no local executor/i.test(reason)) {
          state.save({ last_event_seq: Number(event.seq) || Number(state.get().last_event_seq) || 0 });
          if (once) finish(0, 'once mode');
          return;
        }
      } catch (error) {
        log(`wake_now failed: ${error.message}`);
      }
    }

    if (command) {
      runLocalCommand(event).catch((error) => log(`local command failed: ${error.message}`));
    } else {
      log('no local executor and no --command configured; event left to the agent\'s own polling');
    }
    state.save({ last_event_seq: Number(event.seq) || Number(state.get().last_event_seq) || 0 });
    if (once) finish(0, 'once mode');
  }

  async function callCheckin() {
    try {
      const result = await mcpToolCall({
        url: mcpUrl, token, name: 'agent_checkin', args: { agent_id: agent }
      });
      log(`check-in ok unread=${result?.inbox?.total_unread ?? '?'} latest_seq=${result?.latest_event_seq ?? '?'}`);
    } catch (error) {
      log(`check-in failed: ${error.message}`);
    }
  }

  async function runLocalCommand(event) {
    const chatKey = event.chat_id || '-';
    if (running.has(chatKey)) {
      log(`local run already active for chat ${chatKey}; event coalesced`);
      return { skipped: true };
    }
    const budget = reserveLocalRun(state, chatKey);
    if (!budget.allowed) {
      log(`daily local-run cap reached for chat ${chatKey} `
        + `(${budget.count}/${budget.limit} on ${budget.day}); event left to check-in`);
      return { skipped: true, reason: 'daily local-run cap reached' };
    }
    log(`local run starting chat=${chatKey} today=${budget.count}/${budget.limit}`);
    try {
      const result = await startLocalRun({
        command,
        agent,
        event,
        log,
        onChild: (child) => running.set(chatKey, child)
      });
      log(`local run finished chat=${chatKey}`);
      return result;
    } finally {
      running.delete(chatKey);
    }
  }

  log(`listener starting agent=${agent}${chat ? ` chat=${chat}` : ''} token_file=${tokenFile}`);
  await mcpInitialize(mcpUrl, token).catch(() => {});
  await callCheckin();
  connect();

  process.on('SIGINT', () => finish(0, 'SIGINT'));
  process.on('SIGTERM', () => finish(0, 'SIGTERM'));
  return { stop: () => finish(0, 'stop') };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (options.help) {
    console.log('node scripts/listener.mjs --agent <id|agent_id> [--chat <chat_id>] '
      + '[--base-url URL] [--mcp-url URL] [--token-file PATH] [--state-file PATH] '
      + '[--log-file PATH] [--command CMD] [--no-wake-now] [--once]');
    return;
  }
  runListener(options).catch((error) => {
    logLine(options.logFile, `fatal: ${error.message}`);
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}