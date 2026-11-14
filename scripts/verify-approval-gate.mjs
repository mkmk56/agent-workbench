// End-to-end verification for the Agent HUD phase-2 chat approval gate.
//
// This script never calls an agent LLM. It starts isolated engines with dummy
// task rows written directly to SQLite, then drives the approval tools over MCP:
//   off: request_approval returns immediately, sends nothing, never waits;
//   on:  once / deny / session / chat free-text / timeout / cap interaction /
//        restart persistence / abandoned-pending recovery.
//
// The production :8080 engine is not touched.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import {
  APPROVAL_CATEGORIES,
  buildApprovalPromptBlock,
  parseApprovalDecision
} from '../src/approvals.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const runDir = join(root, 'data', `approval-verify-${stamp}`);
const offDir = join(runDir, 'off');
const onDir = join(runDir, 'on');
const offPort = Number(process.env.VERIFY_APPROVAL_OFF_PORT || 18101);
const onPort = Number(process.env.VERIFY_APPROVAL_ON_PORT || 18102);
const approvalTimeoutMs = Number(process.env.VERIFY_APPROVAL_TIMEOUT_MS || 5000);
const token = randomBytes(24).toString('hex');

for (const dir of [offDir, onDir]) {
  mkdirSync(join(dir, 'logs'), { recursive: true });
}

const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: {
    off: { port: offPort, data_dir: offDir, db_path: join(offDir, 'workbench.db') },
    on: { port: onPort, data_dir: onDir, db_path: join(onDir, 'workbench.db') }
  },
  catalog: {},
  static_checks: {},
  off: {},
  on: {},
  errors: []
};

let engine = null;
const clients = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '';

function startServer({ port, dataDir, gate }) {
  const serverLog = createWriteStream(join(dataDir, 'server.log'), { flags: 'a' });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_BEARER_TOKEN: token,
      MCP_DATA_DIR: dataDir,
      MCP_DB_PATH: join(dataDir, 'workbench.db'),
      MCP_LOG_DIR: join(dataDir, 'logs'),
      AGENT_MESSAGE_LIMIT: '10',
      AGENT_AUTO_DELIVER: '1',
      AGENT_APPROVAL_GATE: gate ? '1' : '0',
      APPROVAL_TIMEOUT_MS: String(approvalTimeoutMs)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  child.on('exit', (code) => {
    serverLog.write(`[verify] server pid=${child.pid} exited code=${code}\n`);
  });
  engine = { child, serverLog, port };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (engine?.child?.exitCode !== null && engine?.child?.exitCode !== undefined) {
      throw new Error(`server on ${port} exited early with code ${engine.child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`server on ${port} did not become healthy`);
}

function transport(port) {
  return new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
  );
}

async function connect(port, name) {
  const client = new Client({ name: `aw-approval-verify-${name}`, version: '0.0.1' });
  await client.connect(transport(port));
  clients.add(client);
  return client;
}

async function call(client, name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  const text = textOf(raw);
  if (raw?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function callError(client, name, args = {}) {
  try {
    const raw = await client.callTool({ name, arguments: args });
    if (raw?.isError) return textOf(raw);
    return null;
  } catch (error) {
    return error.message;
  }
}

async function stopServer() {
  for (const client of clients) {
    // A pending request_approval call keeps a transport busy; never let client
    // teardown hold the verification session open.
    await Promise.race([client.close().catch(() => {}), sleep(1000)]);
  }
  clients.clear();
  if (!engine) return;
  const { child, serverLog } = engine;
  engine = null;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5000);
    child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    try { child.kill(); } catch { resolvePromise(); }
  });
  serverLog.end();
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function insertDummyTask(st, { id, sessionId, agent, threadId }) {
  const now = new Date().toISOString();
  st.insertTask({
    id,
    session_id: sessionId,
    agent,
    cwd: root,
    prompt: 'approval verification placeholder task created directly in SQLite',
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
  if (threadId) st.setTaskThread(id, threadId, null);
}

function seedTasks(dataDir, tasks) {
  const st = new Store(join(dataDir, 'workbench.db'), dataDir);
  try {
    for (const task of tasks) insertDummyTask(st, task);
  } finally {
    st.close();
  }
}

async function listMessages(client, threadId) {
  return call(client, 'list_messages', { thread_id: threadId, limit: 100 });
}

async function listApprovals(client, filters = {}) {
  return call(client, 'list_approvals', { limit: 100, ...filters });
}

async function pendingApproval(client, taskId, timeoutMs = 5000) {
  return waitFor(async () => {
    const listed = await listApprovals(client, { task_id: taskId, status: 'pending' });
    return listed.approvals?.[0] || null;
  }, timeoutMs, `pending approval for ${taskId}`);
}

async function taskStatus(client, taskId) {
  return call(client, 'task_status', { task_id: taskId });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCardFormat(message, messageId) {
  const prefix = `[Agent HUD · 来自 claude · 合并登录分支 ${messageId}]`;
  assert(message.summary.startsWith(prefix), `card prefix missing; got ${message.summary.slice(0, 120)}`);
  assert(message.summary.includes('类别：merge（合并代码）'), 'card does not name the category');
  assert(message.summary.includes('想做什么：'), 'card does not say what will be done');
  assert(message.summary.includes('涉及文件：'), 'card does not list files');
  assert(message.summary.includes('为什么：'), 'card does not say why');
  assert(message.question.includes('允许一次'), 'question does not offer the three decisions');
}

async function runStaticChecks() {
  const categories = Object.keys(APPROVAL_CATEGORIES).sort();
  result.catalog = {
    categories,
    merge_includes: APPROVAL_CATEGORIES.merge.includes,
    merge_excludes: APPROVAL_CATEGORIES.merge.excludes,
    delete_includes: APPROVAL_CATEGORIES.delete.includes,
    delete_excludes: APPROVAL_CATEGORIES.delete.excludes,
    dependencies_includes: APPROVAL_CATEGORIES.dependencies.includes,
    dependencies_excludes: APPROVAL_CATEGORIES.dependencies.excludes
  };
  assert(JSON.stringify(categories) === JSON.stringify(['delete', 'dependencies', 'merge']),
    `category catalog must be exactly merge/delete/dependencies, got ${categories}`);

  const offBlock = buildApprovalPromptBlock({ agentApprovalGate: false }, { agent: 'claude' });
  const onBlock = buildApprovalPromptBlock(
    { agentApprovalGate: true, approvalTimeoutMs }, { agent: 'claude' }
  );
  const dshBlock = buildApprovalPromptBlock(
    { agentApprovalGate: true, approvalTimeoutMs }, { agent: 'dsh' }
  );
  assert(offBlock === '', 'gate-off prompt block must be empty');
  for (const needle of ['request_approval', 'merge', 'delete', 'dependencies', '{{task_id}}', '{{agent}}']) {
    assert(onBlock.includes(needle), `gate-on prompt block is missing ${needle}`);
  }
  assert(dshBlock.includes('no MCP client') && dshBlock.includes('Do not perform'),
    'dsh prompt block must state that request_approval is unavailable');

  const decisions = {
    allow_once_zh: parseApprovalDecision('允许一次'),
    session_zh: parseApprovalDecision('这个会话内允许'),
    deny_zh: parseApprovalDecision('拒绝'),
    deny_not_allow_zh: parseApprovalDecision('不允许'),
    json_session: parseApprovalDecision('{"decision":"session"}'),
    allow_once_en: parseApprovalDecision('allow once'),
    deny_en: parseApprovalDecision('reject'),
    unknown: parseApprovalDecision('please look at this later')
  };
  result.static_checks = { off_block_empty: true, on_block_injected: true, dsh_block_safe: true, decisions };
  assert(decisions.allow_once_zh === 'once', '允许一次 should parse as once');
  assert(decisions.session_zh === 'session', '这个会话内允许 should parse as session');
  assert(decisions.deny_zh === 'deny', '拒绝 should parse as deny');
  assert(decisions.deny_not_allow_zh === 'deny', '不允许 must parse as deny, not once');
  assert(decisions.json_session === 'session', 'JSON decision should parse as session');
  assert(decisions.allow_once_en === 'once', 'allow once should parse as once');
  assert(decisions.deny_en === 'deny', 'reject should parse as deny');
  assert(decisions.unknown === null, 'unrecognized text must not produce a decision');
}

async function runOffPhase() {
  startServer({ port: offPort, dataDir: offDir, gate: false });
  await waitForHealth(offPort);
  const client = await connect(offPort, 'off');

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  result.off.tools = tools;
  for (const required of ['request_approval', 'respond_approval', 'list_approvals']) {
    assert(tools.includes(required), `missing tool: ${required}`);
  }

  const info = await call(client, 'agent_info');
  result.off.agent_info = info.approval_gate;
  assert(info.approval_gate.enabled === false, 'approval gate should be off by default');

  const threadId = randomUUID();
  const taskId = `dummy-approval-off-${threadId.slice(0, 8)}`;
  seedTasks(offDir, [{ id: taskId, sessionId: randomUUID(), agent: 'claude', threadId }]);

  const startedAt = Date.now();
  const response = await call(client, 'request_approval', {
    agent: 'claude',
    task_id: taskId,
    category: 'merge',
    action: 'merge feature/login into main',
    files: ['src/login.ts'],
    reason: 'gate-off check',
    command: 'git merge feature/login'
  });
  const elapsedMs = Date.now() - startedAt;
  result.off.request = { ...response, elapsed_ms: elapsedMs };

  assert(response.gate_enabled === false, 'gate-off response must report gate_enabled=false');
  assert(response.asked === false && response.allowed === true, 'gate-off request must not ask or block');
  assert(response.decision === 'disabled', 'gate-off decision must be disabled');
  assert(elapsedMs < 2000, `gate-off request took ${elapsedMs} ms; it must return immediately`);

  const listed = await listMessages(client, threadId);
  result.off.messages = listed.messages;
  assert(listed.messages.length === 0, 'gate-off request must not write a chat message');
  assert(listed.thread.state === 'ACTIVE', 'gate-off request must not change thread state');

  const status = await taskStatus(client, taskId);
  result.off.task_status = {
    state: status.state,
    thread_state: status.thread_state,
    waiting_for_user: status.waiting_for_user,
    approval: status.approval
  };
  assert(status.waiting_for_user === false, 'gate-off request must not wait for the user');
  assert(status.approval?.pending === null, 'gate-off request must not create a pending approval');

  const respondError = await callError(client, 'respond_approval', {
    task_id: taskId, decision: 'once'
  });
  result.off.respond_error = respondError;
  assert(respondError && /disabled/i.test(respondError), 'respond_approval must reject while the gate is off');

  // ----------------------------------------------- gate-off edge probes (M1/N6)
  // Schema-valid calls that omit files/command (and a delete with files: [])
  // must still return disabled immediately: no validation error, no message,
  // no thread row. The task below deliberately has no task_threads link so the
  // probe can prove that request_approval does not call ensureThread when off.
  {
    const edgeThread = randomUUID();
    const edgeTask = `dummy-approval-off-edge-${edgeThread.slice(0, 8)}`;
    seedTasks(offDir, [{ id: edgeTask, sessionId: randomUUID(), agent: 'claude', threadId: null }]);

    const startedAtEdge = Date.now();
    const noFilesCommand = await call(client, 'request_approval', {
      agent: 'claude',
      task_id: edgeTask,
      category: 'merge',
      action: 'merge a into b',
      reason: 'no files, no command'
    });
    const deleteWithoutFiles = await call(client, 'request_approval', {
      agent: 'claude',
      task_id: edgeTask,
      category: 'delete',
      action: 'delete a file',
      files: [],
      reason: 'delete with an empty file list'
    });
    const edgeMessages = await listMessages(client, edgeThread);
    const st = new Store(join(offDir, 'workbench.db'), offDir);
    let threadRows;
    try {
      threadRows = st.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE thread_id = ?').get(edgeThread).n;
    } finally {
      st.close();
    }
    result.off.edge = {
      no_files_command: noFilesCommand,
      delete_without_files: deleteWithoutFiles,
      elapsed_ms: Date.now() - startedAtEdge,
      messages: edgeMessages.messages,
      thread_rows: threadRows
    };

    for (const [name, response] of [
      ['no_files_command', noFilesCommand],
      ['delete_without_files', deleteWithoutFiles]
    ]) {
      assert(response.gate_enabled === false,
        `gate-off ${name} probe must report gate_enabled=false`);
      assert(response.allowed === true && response.asked === false && response.decision === 'disabled',
        `gate-off ${name} probe must return allowed=true/disabled/asked=false, got ${JSON.stringify(response)}`);
    }
    assert(edgeMessages.messages.length === 0, 'gate-off edge probes must not write a chat message');
    assert(threadRows === 0, 'gate-off edge probes must not create a threads row (N6)');
  }

  await stopServer();
}

async function requestAndPending(agentClient, userClient, taskId, args) {
  const pendingCall = call(agentClient, 'request_approval', args);
  // The call is awaited later; swallow early rejections so the verification
  // process does not die before the assertion can report the real error.
  pendingCall.catch(() => {});
  const approval = await pendingApproval(userClient, taskId);
  return { pendingCall, approval };
}

async function runOnPhase() {
  startServer({ port: onPort, dataDir: onDir, gate: true });
  await waitForHealth(onPort);
  const agentClient = await connect(onPort, 'agent');
  const userClient = await connect(onPort, 'user');

  const info = await call(userClient, 'agent_info');
  result.on.agent_info = info.approval_gate;
  assert(info.approval_gate.enabled === true, 'gate-on engine should report enabled=true');
  assert(JSON.stringify(info.approval_gate.categories) === JSON.stringify(['merge', 'delete', 'dependencies']),
    'agent_info must expose the three categories');
  assert(JSON.stringify(info.approval_gate.options) === JSON.stringify(['once', 'session', 'deny']),
    'agent_info must expose the three user options');

  const threadId = randomUUID();
  const claudeTask = `dummy-approval-claude-${threadId.slice(0, 8)}`;
  const dshTask = `dummy-approval-dsh-${threadId.slice(0, 8)}`;
  seedTasks(onDir, [
    { id: claudeTask, sessionId: randomUUID(), agent: 'claude', threadId },
    { id: dshTask, sessionId: randomUUID(), agent: 'dsh', threadId }
  ]);

  // ---------------------------------------------------------------- once
  {
    const { pendingCall, approval } = await requestAndPending(agentClient, userClient, claudeTask, {
      agent: 'claude',
      task_id: claudeTask,
      category: 'merge',
      action: 'merge feature/login into main',
      files: ['src/login.ts', 'src/session.ts'],
      reason: 'tests pass and the branch is ready',
      command: 'git merge feature/login',
      task: '合并登录分支'
    });

    const listed = await listMessages(userClient, threadId);
    const question = listed.messages.find((m) => m.message_id === approval.message_id);
    assert(question, 'approval question is missing from the chat thread');
    result.on.once = {
      approval_id: approval.approval_id,
      question_status: question.status,
      question_from: question.from,
      question_to: question.to,
      summary: question.summary,
      files: question.files,
      question: question.question,
      thread_state: listed.thread.state,
      exchange_count: listed.thread.exchange_count
    };
    assert(question.from === 'claude' && question.to === 'user', 'question must go from claude to user');
    assert(question.status === 'stored', `question to user must be stored (B1), got ${question.status}`);
    assertCardFormat(question, approval.message_id);
    assert(question.files.length === 2, 'files must be persisted in the message');
    assert(listed.thread.state === 'WAITING_USER' && listed.thread.waiting_for_user === true,
      'thread must be WAITING_USER while approval is pending');
    assert(listed.thread.exchange_count === 0, 'approval question must not count toward the 10-message cap');

    const pendingStatus = await taskStatus(userClient, claudeTask);
    result.on.once.task_status = {
      thread_state: pendingStatus.thread_state,
      waiting_for_user: pendingStatus.waiting_for_user,
      approval_gate: pendingStatus.approval_gate,
      approval_pending: pendingStatus.approval.pending
    };
    assert(pendingStatus.waiting_for_user === true, 'task_status must expose waiting_for_user');
    assert(pendingStatus.approval.pending?.approval_id === approval.approval_id,
      'task_status must expose the pending approval');

    const responded = await call(userClient, 'respond_approval', {
      approval_id: approval.approval_id,
      decision: 'once',
      reason: 'verified locally'
    });
    result.on.once.respond = {
      status: responded.status,
      decision: responded.decision,
      allowed: responded.allowed,
      response_message_id: responded.response_message_id
    };
    assert(responded.status === 'allowed' && responded.decision === 'once' && responded.allowed === true,
      'respond_approval once must allow the request');

    const resolved = await pendingCall;
    result.on.once.result = resolved;
    assert(resolved.allowed === true && resolved.decision === 'once' && resolved.stop === false,
      'blocked request_approval must resume with allowed=true after once');

    const after = await listMessages(userClient, threadId);
    const answered = after.messages.find((m) => m.message_id === approval.message_id);
    const reply = after.messages.find((m) => m.reply_to === approval.message_id);
    result.on.once.reply = reply ? { from: reply.from, to: reply.to, status: reply.status, summary: reply.summary } : null;
    assert(answered?.status === 'answered', 'approval question should be marked answered after the user reply');
    assert(reply?.from === 'user' && reply?.to === 'claude', 'user reply must go back to the asking agent');
    assert(after.thread.state === 'ACTIVE' && after.thread.waiting_for_user === false,
      'user reply must resume the thread');
  }

  // ---------------------------------------------------------------- deny
  {
    const { pendingCall, approval } = await requestAndPending(agentClient, userClient, claudeTask, {
      agent: 'claude',
      task_id: claudeTask,
      category: 'merge',
      action: 'merge feature/login into main',
      files: ['src/login.ts'],
      reason: 'second attempt after once was consumed',
      command: 'git merge feature/login',
      task: '合并登录分支'
    });
    assert(approval.category === 'merge', 'deny flow should ask again after a once approval');

    const responded = await call(userClient, 'respond_approval', {
      approval_id: approval.approval_id,
      decision: 'deny',
      reason: 'not while the release is frozen'
    });
    result.on.deny = {
      approval_id: approval.approval_id,
      status: responded.status,
      decision: responded.decision,
      allowed: responded.allowed,
      stop: responded.stop
    };
    assert(responded.status === 'denied' && responded.allowed === false && responded.stop === true,
      'deny must return allowed=false and stop=true');

    const resolved = await pendingCall;
    result.on.deny.result = resolved;
    assert(resolved.allowed === false && resolved.decision === 'deny' && resolved.stop === true,
      'blocked request_approval must return stop=true after deny');
  }

  // -------------------------------------------------------- session grant
  {
    const { pendingCall, approval } = await requestAndPending(agentClient, userClient, claudeTask, {
      agent: 'claude',
      task_id: claudeTask,
      category: 'merge',
      action: 'push the approved branch',
      files: ['src/login.ts'],
      reason: 'deny did not grant anything; this asks again',
      command: 'git push origin main',
      task: '合并登录分支'
    });
    await call(userClient, 'respond_approval', {
      approval_id: approval.approval_id, decision: 'session'
    });
    const resolved = await pendingCall;
    result.on.session = {
      first: { approval_id: approval.approval_id, allowed: resolved.allowed, decision: resolved.decision }
    };
    assert(resolved.allowed === true && resolved.decision === 'session', 'session decision must allow the request');

    const startedAt = Date.now();
    const second = await call(agentClient, 'request_approval', {
      agent: 'claude',
      task_id: claudeTask,
      category: 'merge',
      action: 'push a second approved commit',
      files: ['src/login.ts'],
      reason: 'same category in the same thread',
      command: 'git push origin main',
      task: '合并登录分支'
    });
    result.on.session.second = { ...second, elapsed_ms: Date.now() - startedAt };
    assert(second.allowed === true && second.asked === false && second.decision === 'session',
      'same category must be allowed without a second question');
    assert(second.grant_source === approval.approval_id,
      'session grant should point at the approval that created it');

    const third = await requestAndPending(agentClient, userClient, claudeTask, {
      agent: 'claude',
      task_id: claudeTask,
      category: 'delete',
      action: 'delete the replaced authentication files',
      files: ['src/old-auth/session.ts', 'src/old-auth/token.ts'],
      reason: 'replaced by src/auth',
      command: 'git rm src/old-auth/session.ts src/old-auth/token.ts',
      task: '清理旧认证模块'
    });
    result.on.session.different_category = { approval_id: third.approval.approval_id };
    assert(third.approval.category === 'delete', 'a different category must ask again');
    await call(userClient, 'respond_approval', {
      approval_id: third.approval.approval_id, decision: 'session'
    });
    const thirdResult = await third.pendingCall;
    assert(thirdResult.allowed === true && thirdResult.decision === 'session',
      'delete session approval should allow the request');
    const fourth = await call(agentClient, 'request_approval', {
      agent: 'claude',
      task_id: claudeTask,
      category: 'delete',
      action: 'delete one more replaced file',
      files: ['src/old-auth/index.ts'],
      reason: 'same category after session approval',
      command: 'rm src/old-auth/index.ts',
      task: '清理旧认证模块'
    });
    result.on.session.delete_followup = fourth;
    assert(fourth.allowed === true && fourth.asked === false, 'delete session grant must cover later deletes');
  }

  // ------------------------------------------------- chat free-text reply
  {
    const { pendingCall, approval } = await requestAndPending(agentClient, userClient, claudeTask, {
      agent: 'claude',
      task_id: claudeTask,
      category: 'dependencies',
      action: 'add axios for the HTTP client',
      files: ['package.json', 'package-lock.json'],
      reason: 'the current fetch wrapper is hand-rolled',
      command: 'npm install axios',
      task: '接入 HTTP 客户端'
    });
    const chatReply = await call(userClient, 'send_message', {
      from: 'user',
      to: 'claude',
      task_id: claudeTask,
      reply_to: approval.message_id,
      summary: '这个会话内允许',
      deliver: false
    });
    const resolved = await pendingCall;
    result.on.chat_reply = {
      reply_message_id: chatReply.message_id,
      allowed: resolved.allowed,
      decision: resolved.decision,
      response_message_id: resolved.response_message_id
    };
    assert(resolved.allowed === true && resolved.decision === 'session',
      'free-text "这个会话内允许" must be parsed as a session approval');
    const followup = await call(agentClient, 'request_approval', {
      agent: 'claude',
      task_id: claudeTask,
      category: 'dependencies',
      action: 'add one more package',
      files: ['package.json', 'package-lock.json'],
      reason: 'same category after the chat reply',
      command: 'npm install date-fns',
      task: '接入 HTTP 客户端'
    });
    result.on.chat_reply.followup = followup;
    assert(followup.allowed === true && followup.asked === false,
      'chat session approval must cover later dependency operations');
  }

  // ---------------------------------- ambiguous chat reply + explicit answer
  {
    const thread = randomUUID();
    const task = `dummy-approval-ambiguous-${thread.slice(0, 8)}`;
    seedTasks(onDir, [{ id: task, sessionId: randomUUID(), agent: 'claude', threadId: thread }]);
    const { pendingCall, approval } = await requestAndPending(agentClient, userClient, task, {
      agent: 'claude',
      task_id: task,
      category: 'dependencies',
      action: 'install an ambiguous dependency',
      files: ['package.json'],
      reason: 'ambiguous reply verification',
      command: 'npm install left-pad',
      task: '歧义回复验证'
    });
    const ambiguous = await call(userClient, 'send_message', {
      from: 'user',
      to: 'claude',
      task_id: task,
      reply_to: approval.message_id,
      summary: '晚点再说',
      deliver: false
    });
    await sleep(600);
    const parked = await listMessages(userClient, thread);
    result.on.ambiguous_reply = {
      reply_message_id: ambiguous.message_id,
      thread_state_after_unparsed: parked.thread.state,
      waiting_for_user: parked.thread.waiting_for_user
    };
    assert(parked.thread.state === 'WAITING_USER' && parked.thread.waiting_for_user === true,
      'an unparseable chat reply must leave the approval pending and the thread parked');

    const resolved = await call(userClient, 'respond_approval', {
      approval_id: approval.approval_id,
      decision: 'deny',
      reason: 'explicit answer after an ambiguous chat reply'
    });
    const pendingResult = await pendingCall;
    result.on.ambiguous_reply.explicit = {
      status: resolved.status,
      decision: resolved.decision,
      response_message_id: resolved.response_message_id,
      allowed: pendingResult.allowed,
      stop: pendingResult.stop
    };
    assert(resolved.status === 'denied' && resolved.response_message_id === ambiguous.message_id,
      'respond_approval must resolve an ambiguous chat reply without writing a second reply');
    assert(pendingResult.allowed === false && pendingResult.stop === true,
      'the blocked call must stop after the explicit deny');
  }

  // ------------------------------------------------------- cap interaction
  {
    const sent = await call(userClient, 'send_message', {
      from: 'claude',
      to: 'dsh',
      task_id: claudeTask,
      summary: 'phase-1 cap still works after approval traffic',
      deliver: false
    });
    result.on.cap = { exchange_count: sent.exchange_count, thread_state: sent.thread_state };
    assert(sent.exchange_count === 1, 'agent-to-agent message after approval should count from 1');
    assert(sent.thread_state === 'ACTIVE', 'thread should be active after the user replies');
  }

  // -------------------------------------------------------------- timeout
  {
    const timeoutThread = randomUUID();
    const timeoutTask = `dummy-approval-timeout-${timeoutThread.slice(0, 8)}`;
    seedTasks(onDir, [{ id: timeoutTask, sessionId: randomUUID(), agent: 'claude', threadId: timeoutThread }]);
    const startedAt = Date.now();
    const pendingCall = call(agentClient, 'request_approval', {
      agent: 'claude',
      task_id: timeoutTask,
      category: 'merge',
      action: 'merge without an answer',
      files: ['src/timeout.ts'],
      reason: 'timeout verification',
      command: 'git merge timeout-branch',
      task: '超时验证'
    });
    pendingCall.catch(() => {});
    const approval = await pendingApproval(userClient, timeoutTask);
    const resolved = await pendingCall;
    result.on.timeout = {
      approval_id: approval.approval_id,
      elapsed_ms: Date.now() - startedAt,
      allowed: resolved.allowed,
      decision: resolved.decision,
      stop: resolved.stop
    };
    assert(resolved.allowed === false && resolved.decision === 'timeout' && resolved.stop === true,
      'an unanswered approval must time out into stop=true');
    const after = await listMessages(userClient, timeoutThread);
    assert(after.thread.state === 'ACTIVE', 'timeout must release the thread from WAITING_USER');
    const stored = await listApprovals(userClient, { task_id: timeoutTask });
    assert(stored.approvals[0]?.status === 'timed_out', 'timed-out approval should be persisted');
  }

  // ------------------------------------------- restart: grants + abandoned
  await stopServer();

  startServer({ port: onPort, dataDir: onDir, gate: true });
  await waitForHealth(onPort);
  const restarted = await connect(onPort, 'restart');

  const persisted = await call(restarted, 'request_approval', {
    agent: 'claude',
    task_id: claudeTask,
    category: 'merge',
    action: 'push after restart',
    files: ['src/login.ts'],
    reason: 'session grants must survive an engine restart',
    command: 'git push origin main',
    task: '合并登录分支'
  });
  result.on.persistence = {
    session_grant_after_restart: persisted.allowed === true && persisted.asked === false,
    decision: persisted.decision
  };
  assert(persisted.allowed === true && persisted.asked === false,
    'allow-session grant should persist across an engine restart');

  const pendingThread = randomUUID();
  const pendingTask = `dummy-approval-abandoned-${pendingThread.slice(0, 8)}`;
  seedTasks(onDir, [{ id: pendingTask, sessionId: randomUUID(), agent: 'claude', threadId: pendingThread }]);
  const abandonedCall = call(restarted, 'request_approval', {
    agent: 'claude',
    task_id: pendingTask,
    category: 'delete',
    action: 'delete while the engine stops',
    files: ['src/abandoned.ts'],
    reason: 'abandoned-pending recovery',
    command: 'rm src/abandoned.ts',
    task: '放弃验证'
  });
  abandonedCall.catch(() => { /* the request dies with the server */ });
  await pendingApproval(restarted, pendingTask);

  await stopServer();
  startServer({ port: onPort, dataDir: onDir, gate: true });
  await waitForHealth(onPort);
  const recovered = await connect(onPort, 'recovered');

  const abandoned = await listApprovals(recovered, { task_id: pendingTask });
  const abandonedThread = await listMessages(recovered, pendingThread);
  result.on.recovery = {
    approval_status: abandoned.approvals[0]?.status,
    thread_state: abandonedThread.thread.state,
    waiting_for_user: abandonedThread.thread.waiting_for_user
  };
  assert(abandoned.approvals[0]?.status === 'abandoned',
    'a pending approval must be marked abandoned after an engine restart');
  assert(abandonedThread.thread.state === 'ACTIVE' && abandonedThread.thread.waiting_for_user === false,
    'recovery must release the thread from WAITING_USER');

  await stopServer();
}

async function main() {
  await runStaticChecks();
  await runOffPhase();
  await runOnPhase();
  result.ok = true;
}

try {
  await main();
} catch (error) {
  result.errors.push(error.stack || error.message);
} finally {
  await stopServer();
  result.finished_at = new Date().toISOString();
  const resultPath = join(runDir, 'verify-result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    result_path: resultPath,
    catalog: result.catalog.categories,
    off: result.off,
    on: result.on,
    errors: result.errors
  }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}