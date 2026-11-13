// End-to-end verification for the Agent HUD phase-1 message protocol.
//
// Runs an isolated engine on VERIFY_PORT (default 18091) with its own data
// directory, then:
//   1. starts a real claude task that calls the local MCP send_message tool;
//   2. lets the engine deliver the conclusion to a real dsh task and route the
//      review back to claude (reply_to chain);
//   3. checks summary truncation, the 10-message exchange cap, the WAITING_USER
//      state and the user reset;
//   4. restarts the engine and confirms messages are still queryable.
//
// Token material stays in this process and the gitignored run directory; it is
// never printed.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const runDir = join(root, 'data', `agent-hud-verify-${stamp}`);
const logDir = join(runDir, 'logs');
const dbPath = join(runDir, 'workbench.db');
const serverLogPath = join(runDir, 'server.log');
const port = Number(process.env.VERIFY_PORT || 18091);
const skipAgents = process.env.VERIFY_SKIP_AGENTS === '1';
const token = randomBytes(24).toString('hex');
const baseUrl = `http://127.0.0.1:${port}`;

mkdirSync(logDir, { recursive: true });
const serverLog = createWriteStream(serverLogPath, { flags: 'a' });
const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: { port, data_dir: runDir, db_path: dbPath },
  tools: [],
  real_flow: {},
  mcp_evidence: {},
  cap: {},
  summary_limit: {},
  persistence: {},
  errors: []
};
let server = null;
let client = null;
let store = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '';

function startServer() {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_BEARER_TOKEN: token,
      MCP_DATA_DIR: runDir,
      MCP_DB_PATH: dbPath,
      MCP_LOG_DIR: logDir,
      AGENT_MESSAGE_LIMIT: '10',
      AGENT_AUTO_DELIVER: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  server.on('exit', (code) => {
    serverLog.write(`[verify] server pid=${server?.pid} exited code=${code}\n`);
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`server exited early with code ${server.exitCode}; see ${serverLogPath}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('server did not become healthy');
}

async function connect() {
  const transport = StreamableHTTPTransport();
  const c = new Client({ name: 'aw-agent-hud-verify', version: '0.0.1' });
  await c.connect(transport);
  return c;
}

function StreamableHTTPTransport() {
  return new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
}

async function call(c, name, args = {}) {
  const raw = await c.callTool({ name, arguments: args });
  const text = textOf(raw);
  if (raw?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function callError(c, name, args = {}) {
  try {
    const raw = await c.callTool({ name, arguments: args });
    if (raw?.isError) return textOf(raw);
    return null;
  } catch (error) {
    return error.message;
  }
}

async function status(c, taskId) {
  return call(c, 'task_status', { task_id: taskId });
}

async function waitTask(c, taskId, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await status(c, taskId);
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(last.state)) return last;
    await sleep(2000);
  }
  return last;
}

async function listMessages(c, threadId) {
  return call(c, 'list_messages', { thread_id: threadId, limit: 100 });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    try { child.kill(); } catch { resolvePromise(); }
  });
  serverLog.write('[verify] server stopped\n');
}

function readServerLog() {
  try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; }
}

function insertDummyTask(st, { id, sessionId, agent, threadId }) {
  const now = new Date().toISOString();
  st.insertTask({
    id,
    session_id: sessionId,
    agent,
    cwd: root,
    prompt: 'verification placeholder task created directly in SQLite',
    state: 'COMPLETED',
    process_state: 'exited_success',
    turn_state: 'idle',
    blocker: null,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    exit_code: 0,
    pid: null,
    tokens_json: null,
    files_modified_json: null,
    summary: 'placeholder',
    timeout_ms: 1000,
    stale_after_ms: 600000,
    resume: 0,
    model: null
  });
  st.setTaskThread(id, threadId, null);
}

async function main() {
  startServer();
  await waitForHealth();
  client = await connect();

  const toolList = await client.listTools();
  result.tools = toolList.tools.map((t) => t.name).sort();
  for (const required of ['send_message', 'list_messages']) {
    if (!result.tools.includes(required)) throw new Error(`missing tool: ${required}`);
  }

  const info = await call(client, 'agent_info');
  result.agent_info = info.message_protocol;

  // ---------------------------------------------------------------- real flow
  let claudeTask = null;
  let threadId = null;
  if (!skipAgents) {
  const initialPrompt = [
    'This is a live test of the agent message protocol. Do not modify any files.',
    'First call the MCP tool mcp__agent-workbench__agent_info once to prove the local MCP server is reachable.',
    'Then call mcp__agent-workbench__send_message with exactly these arguments:',
    JSON.stringify({
      from: 'claude',
      to: 'dsh',
      task_id: '{{task_id}}',
      summary: 'Reviewed src/messages.js: conclusion-only hand-off, 500-token summary cap and reply_to chaining are implemented. No blocking code change needed yet.',
      files: ['src/messages.js'],
      question: 'Do you see any blocking correctness issue in this message protocol? '
        + 'Answer briefly and you MUST set done:false in your reply because claude will respond.'
    }),
    'After the tool call succeeds, reply with exactly one line: SENT <message_id>.'
  ].join('\n');

  claudeTask = await call(client, 'task_start', {
    agent: 'claude',
    prompt: initialPrompt,
    cwd: root
  });
  result.real_flow.claude_task_id = claudeTask.task_id;
  result.real_flow.claude_session_id = claudeTask.session_id;

  const firstStatus = await waitTask(client, claudeTask.task_id, 300000);
  result.real_flow.claude_state = firstStatus.state;
  result.real_flow.claude_tokens = firstStatus.tokens;

  threadId = claudeTask.task_id;
  const twoMessages = await waitFor(async () => {
    const listed = await listMessages(client, threadId);
    const root = listed.messages.find((m) => !m.reply_to);
    const reply = root && listed.messages.find((m) => m.reply_to === root.message_id);
    return root && reply ? { listed, root, reply } : null;
  }, 300000, 'claude -> dsh message and dsh reply');
  const first = twoMessages.root;
  const second = twoMessages.reply;
  result.real_flow.message_1_id = first.message_id;
  result.real_flow.message_2_id = second.message_id;
  result.real_flow.message_2_reply_to = second.reply_to;
  result.real_flow.dsh_task_id = first.delivery_task_id;

  if (second.reply_to !== first.message_id) {
    throw new Error('reply_to chain is wrong for the dsh review');
  }
  if (!first.delivery_task_id) throw new Error('claude message was not delivered to dsh');

  const dshStatus = await waitTask(client, first.delivery_task_id, 300000);
  result.real_flow.dsh_state = dshStatus.state;
  result.real_flow.dsh_session_id = dshStatus.session_id;

  // The dsh review is either delivered to claude (revision task) or marked
  // final. Wait for the revision task when present.
  const revisionInfo = await waitFor(async () => {
    const listed = await listMessages(client, threadId);
    const msg2 = listed.messages.find((m) => m.message_id === second.message_id);
    if (!msg2) return null;
    if (msg2.delivery_task_id) return { listed, revisionTaskId: msg2.delivery_task_id };
    if (msg2.is_final || msg2.status === 'stored' || msg2.status === 'held') {
      return { listed, revisionTaskId: null };
    }
    return null;
  }, 120000, 'dsh review delivery');

  if (revisionInfo.revisionTaskId) {
    result.real_flow.revision_task_id = revisionInfo.revisionTaskId;
    const revisionStatus = await waitTask(client, revisionInfo.revisionTaskId, 300000);
    result.real_flow.revision_state = revisionStatus.state;
  }

  const finalList = await waitFor(async () => {
    const listed = await listMessages(client, threadId);
    return listed.messages.length >= 3 ? listed : null;
  }, 180000, 'claude revision conclusion');
  result.real_flow.messages = finalList.messages.map((m) => ({
    message_id: m.message_id,
    from: m.from,
    to: m.to,
    reply_to: m.reply_to,
    status: m.status,
    summary_tokens: m.summary_tokens,
    summary_truncated: m.summary_truncated,
    delivery_task_id: m.delivery_task_id,
    is_final: m.is_final
  }));
  result.real_flow.thread_state = finalList.thread.state;
  result.real_flow.exchange_count = finalList.thread.exchange_count;

  const claudeLogs = await call(client, 'task_logs', { task_id: claudeTask.task_id, limit: 1000 });
  const claudeLogText = claudeLogs.entries.map((e) => e.line).join('\n');
  result.mcp_evidence.init_connected = /"name":"agent-workbench","status":"connected"/.test(claudeLogText);
  result.mcp_evidence.tool_use_send_message = claudeLogText.includes('mcp__agent-workbench__send_message');
  result.mcp_evidence.tool_use_agent_info = claudeLogText.includes('mcp__agent-workbench__agent_info');
  result.mcp_evidence.server_tools_list_requests = (readServerLog().match(/MCP .*tools\/list/g) || []).length;
  result.mcp_evidence.server_tools_call_requests = (readServerLog().match(/MCP .*tools\/call/g) || []).length;

  if (!result.mcp_evidence.init_connected) throw new Error('claude did not report a connected workbench MCP server');
  if (!result.mcp_evidence.tool_use_send_message) throw new Error('claude did not call send_message');
  if (result.mcp_evidence.server_tools_list_requests < 1) {
    throw new Error('server never saw a tools/list request from claude');
  }
  if (result.real_flow.revision_state && result.real_flow.revision_state !== 'COMPLETED') {
    throw new Error(`claude revision task ended ${result.real_flow.revision_state}`);
  }
  }

  // Stop any task that is still running before the persistence restart.
  if (threadId && claudeTask) {
    await sleep(5000);
    const cleanupList = await listMessages(client, threadId);
    const taskIds = new Set([claudeTask.task_id, ...cleanupList.messages.map((m) => m.delivery_task_id).filter(Boolean)]);
    for (const taskId of taskIds) {
      const st = await status(client, taskId).catch(() => null);
      if (st && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(st.state)) {
        await call(client, 'task_cancel', { task_id: taskId }).catch(() => {});
        result.real_flow.cancelled_leftover_task = taskId;
      }
    }
  }

  // ------------------------------------------------------------ cap + summary
  store = new Store(dbPath, runDir);
  const capThread = randomUUID();
  const claudeDummy = `dummy-claude-${capThread.slice(0, 8)}`;
  const dshDummy = `dummy-dsh-${capThread.slice(0, 8)}`;
  insertDummyTask(store, {
    id: claudeDummy, sessionId: randomUUID(), agent: 'claude', threadId: capThread
  });
  insertDummyTask(store, {
    id: dshDummy, sessionId: randomUUID(), agent: 'dsh', threadId: capThread
  });
  store.close();
  store = null;

  let lastReply = null;
  const sent = [];
  for (let i = 1; i <= 10; i += 1) {
    const fromClaude = i % 2 === 1;
    const longSummary = i === 3 ? 'A'.repeat(5000) : `cap verification message ${i}`;
    const message = await call(client, 'send_message', {
      from: fromClaude ? 'claude' : 'dsh',
      to: fromClaude ? 'dsh' : 'claude',
      task_id: fromClaude ? claudeDummy : dshDummy,
      ...(lastReply ? { reply_to: lastReply } : {}),
      summary: longSummary,
      files: ['src/messages.js'],
      deliver: false
    });
    sent.push(message);
    lastReply = message.message_id;
    if (i === 3) {
      result.summary_limit = {
        message_id: message.message_id,
        summary_tokens: message.summary_tokens,
        summary_truncated: message.summary_truncated,
        stored_chars: message.summary.length
      };
      if (!message.summary_truncated || message.summary_tokens > 500) {
        throw new Error('summary was not truncated to 500 tokens');
      }
    }
  }

  const tenth = sent[9];
  result.cap = {
    thread_id: capThread,
    claude_placeholder_task_id: claudeDummy,
    dsh_placeholder_task_id: dshDummy,
    messages_sent: sent.length,
    tenth_status: tenth.status,
    exchange_count: tenth.exchange_count,
    thread_state: tenth.thread_state,
    waiting_for_user: tenth.waiting_for_user,
    message_ids: sent.map((m) => m.message_id),
    reply_chain_ok: sent.every((m, idx) => (idx === 0 ? m.reply_to === null : m.reply_to === sent[idx - 1].message_id))
  };
  if (tenth.thread_state !== 'WAITING_USER' || !tenth.waiting_for_user) {
    throw new Error('thread did not enter WAITING_USER at the 10-message limit');
  }
  if (tenth.status !== 'held') {
    throw new Error(`10th message should be held, got ${tenth.status}`);
  }
  // The 10th message was held, so the 9th must not be reported as answered.
  const capList = await call(client, 'list_messages', { thread_id: capThread, limit: 50 });
  const ninth = capList.messages.find((m) => m.message_id === sent[8].message_id);
  result.cap.ninth_status_after_held = ninth?.status ?? null;
  if (!ninth || ninth.status === 'answered') {
    throw new Error('held reply incorrectly marked its origin message answered');
  }

  // A final report to the user is not agent-to-agent traffic: it must pass
  // even while the thread is waiting for the user, and must not move the counter.
  const userReport = await call(client, 'send_message', {
    from: 'claude',
    to: 'user',
    task_id: claudeDummy,
    summary: 'final report to the user',
    deliver: false
  });
  result.cap.user_report = {
    status: userReport.status,
    exchange_count: userReport.exchange_count,
    thread_state: userReport.thread_state,
    waiting_for_user: userReport.waiting_for_user
  };
  if (userReport.status === 'held') throw new Error('report to user was held at the exchange limit');
  if (userReport.exchange_count !== 10 || !userReport.waiting_for_user) {
    throw new Error('report to user changed the exchange counter or waiting state');
  }

  const eleventhError = await callError(client, 'send_message', {
    from: 'claude',
    to: 'dsh',
    task_id: claudeDummy,
    summary: 'this should be rejected',
    deliver: false
  });
  result.cap.eleventh_rejected = Boolean(eleventhError);
  result.cap.eleventh_error = eleventhError || null;
  if (!eleventhError) throw new Error('11th message was not rejected');

  const taskStatus = await status(client, claudeDummy);
  result.cap.task_status_waiting_for_user = taskStatus.waiting_for_user;
  result.cap.task_status_thread_state = taskStatus.thread_state;
  if (!taskStatus.waiting_for_user) throw new Error('task_status does not expose waiting_for_user');

  const userMessage = await call(client, 'send_message', {
    from: 'user',
    to: 'claude',
    task_id: claudeDummy,
    summary: 'continue',
    deliver: false
  });
  result.cap.user_reset = {
    exchange_count: userMessage.exchange_count,
    thread_state: userMessage.thread_state,
    waiting_for_user: userMessage.waiting_for_user
  };
  if (userMessage.waiting_for_user || userMessage.exchange_count !== 0) {
    throw new Error('user message did not reset the exchange counter');
  }

  const afterReset = await call(client, 'send_message', {
    from: 'claude',
    to: 'dsh',
    task_id: claudeDummy,
    summary: 'after user reset',
    deliver: false
  });
  result.cap.after_reset_exchange_count = afterReset.exchange_count;
  if (afterReset.exchange_count !== 1) throw new Error('agent message after reset was not counted from 1');

  // ------------------------------------------------------------- persistence
  const beforeRestart = await listMessages(client, capThread);
  result.persistence.before_restart_count = beforeRestart.messages.length;
  await client.close().catch(() => {});
  client = null;
  await stopServer();
  await sleep(1500);

  startServer();
  await waitForHealth();
  client = await connect();
  const afterRestart = await listMessages(client, capThread);
  result.persistence.after_restart_count = afterRestart.messages.length;
  result.persistence.reply_chain_ok = afterRestart.messages
    .filter((m) => m.reply_to)
    .every((m) => afterRestart.messages.some((other) => other.message_id === m.reply_to));
  result.persistence.thread_state = afterRestart.thread.state;
  if (afterRestart.messages.length < beforeRestart.messages.length) {
    throw new Error('messages did not survive an engine restart');
  }
  if (!result.persistence.reply_chain_ok) throw new Error('reply_to chain broke after restart');

  result.ok = true;
}

try {
  await main();
} catch (error) {
  result.errors.push(error.stack || error.message);
} finally {
  try { await client?.close(); } catch { /* ignore */ }
  await stopServer();
  try { store?.close(); } catch { /* ignore */ }
  result.finished_at = new Date().toISOString();
  const resultPath = join(runDir, 'verify-result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  serverLog.end();
  console.log(JSON.stringify({
    ok: result.ok,
    result_path: resultPath,
    server_log: serverLogPath,
    engine: result.engine,
    tools: result.tools,
    real_flow: result.real_flow,
    mcp_evidence: result.mcp_evidence,
    cap: { ...result.cap, message_ids: undefined },
    summary_limit: result.summary_limit,
    persistence: result.persistence,
    errors: result.errors
  }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}