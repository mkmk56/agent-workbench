// Verification for the group-chat backend (src/store.js, src/messages.js,
// src/chats.js, src/tools.js).
//
// Runs an isolated engine on VERIFY_PORT (default 18092) with its own data
// directory and its own bearer token, then drives it over the real MCP HTTP
// transport — the same path Muse and the GUI use.
//
// No LLM is called. This verification environment cannot spawn child processes
// with piped stdio, so the engine is started in-process and the claude executor
// is replaced by an in-process double that records the rendered prompt, then
// finishes the task through the real scheduler. Everything else is production
// code: thread creation, chat linking, {{chat_id}} rendering, agent_reply
// parsing, conclusion routing and the message rows are the real ones.
//
// Checks:
//   1. the six chat tools exist next to send_message/list_messages;
//   2. create_chat (named and unnamed), list_chats, rename_chat;
//   3. user -> Muse needs_muse derivation and a Muse reply clearing it;
//   4. Muse -> agent starts a real sub-task in its own thread, whose rendered
//      prompt carries the chat name and the resolved chat_id;
//   5. that sub-task's real conclusion returns to the chat with the same
//      chat_id and is attributed to the sub-task;
//   6. chat_status derives each agent status from its latest real sub-task;
//   7. two chats never leak messages, statuses or sub-tasks into each other;
//   8. the 10-message cap still parks each sub-task thread while the chat
//      stream stays unbounded;
//   9. an agent task cannot send as muse;
//  10. everything survives an engine restart.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { deriveAgentToken } from '../src/auth.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const runDir = join(root, 'data', `chat-backend-verify-${stamp}`);
const logDir = join(runDir, 'logs');
const dbPath = join(runDir, 'workbench.db');
const serverLogPath = join(runDir, 'server.log');
const port = Number(process.env.VERIFY_PORT || 18092);
const token = randomBytes(24).toString('hex');
const claudeToken = deriveAgentToken(token, 'claude');
const dshToken = deriveAgentToken(token, 'dsh');
const baseUrl = `http://127.0.0.1:${port}`;

mkdirSync(logDir, { recursive: true });
const serverLog = createWriteStream(serverLogPath, { flags: 'a' });
const engineStdout = { write: (chunk) => serverLog.write(chunk) };
// server.js logs to console; keep that evidence in the run directory.
console.log = (...args) => engineStdout.write(`${args.join(' ')}\n`);

// Engine configuration must be in place before src/server.js imports config.js.
// WORKBENCH_CLAUDE_ENTRY points at a file the claude executor cannot spawn; the
// executor is replaced in-process anyway, and this guarantees no real CLI can
// ever start from this run.
process.env.MCP_PORT = String(port);
process.env.MCP_BEARER_TOKEN = token;
// This legacy harness authenticates as executor agents with static scoped
// tokens. Production rejects them by default, so opt in explicitly here.
process.env.WORKBENCH_LEGACY_AGENT_TOKENS = '1';
process.env.WORKBENCH_LEGACY_MASTER_ALLOW_MUSE = '1';
process.env.WORKBENCH_CREDENTIAL_DIR = join(runDir, 'credentials');
process.env.WORKBENCH_WORKSPACE_DIR = join(runDir, 'workspace');
process.env.WORKBENCH_ENV_FILE = join(runDir, 'engine.env');
process.env.MCP_DATA_DIR = runDir;
process.env.MCP_DB_PATH = dbPath;
process.env.MCP_LOG_DIR = logDir;
process.env.AGENT_MESSAGE_LIMIT = '10';
process.env.AGENT_AUTO_DELIVER = '1';
process.env.AGENT_APPROVAL_GATE = '0';
process.env.WORKBENCH_CLAUDE_ENTRY = join(runDir, '__no_claude_binary__');

const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: {
    port,
    data_dir: runDir,
    db_path: dbPath,
    in_process: true,
    llm_calls: 0,
    executor: 'in-process claude executor double (records the rendered prompt, finishes through the real scheduler)'
  },
  tools: [],
  chats: {},
  needs_muse: {},
  delivery: {},
  status_derivation: {},
  isolation: {},
  cap: {},
  impersonation: {},
  persistence: {},
  errors: []
};
let client = null;
let store = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// In-process stand-in for the claude CLI. It records the prompt the scheduler
// actually rendered and ends the task with a normal agent_reply block, so the
// engine's own completion routing runs unchanged.
const executorProbe = { prompts: [] };
async function installExecutorDouble() {
  const { claudeExecutor } = await import('../src/executors/claude.js');
  claudeExecutor.start = (task, ctx) => {
    executorProbe.prompts.push({ task_id: task.id, prompt: String(task.prompt) });
    const chatName = (String(task.prompt).match(/^chat_name: (.*)$/m) || [])[1] || '(none)';
    const chatId = (String(task.prompt).match(/^chat_id: (.*)$/m) || [])[1] || '(none)';
    const timer = setTimeout(() => {
      ctx.setResult({
        isError: false,
        text: '<agent_reply>'
          + JSON.stringify({
            summary: `claude conclusion for chat ${chatName} (${chatId})`,
            files: ['src/chats.js'],
            done: true
          })
          + '</agent_reply>',
        tokens: null
      });
      ctx.exit({ code: 0, signal: null });
    }, 10);
    return { pid: null, cancel: () => clearTimeout(timer) };
  };
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('engine did not become healthy');
}

async function connect(bearer = token) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }
  );
  const c = new Client({ name: 'aw-chat-backend-verify', version: '0.0.1' });
  await c.connect(transport);
  return c;
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
    return raw?.isError ? textOf(raw) : null;
  } catch (error) {
    return error.message;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function openStore() {
  return new Store(dbPath, runDir);
}

function insertPlaceholderTask(st, { id, sessionId, agent, state = 'COMPLETED', summary = 'placeholder' }) {
  const now = new Date().toISOString();
  // process_state and turn_state are what deriveState() reads, so they must
  // agree with the orchestration state under test.
  const processState = {
    COMPLETED: 'exited_success',
    FAILED: 'exited_failure',
    WORKING: 'running',
    PENDING: 'created'
  }[state] ?? 'created';
  const turnState = { COMPLETED: 'idle', FAILED: 'failed', WORKING: 'working', PENDING: 'none' }[state] ?? 'none';
  st.insertTask({
    id,
    session_id: sessionId,
    agent,
    cwd: root,
    prompt: 'verification placeholder task created directly in SQLite',
    state,
    process_state: processState,
    turn_state: turnState,
    blocker: null,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    exit_code: 0,
    pid: null,
    tokens_json: null,
    files_modified_json: null,
    summary,
    timeout_ms: 1000,
    stale_after_ms: 600000,
    resume: 0,
    model: null
  });
  return id;
}

async function main() {
  await import('../src/server.js');
  await waitForHealth();
  await installExecutorDouble();
  client = await connect();
  const agentClients = {
    claude: await connect(claudeToken),
    dsh: await connect(dshToken)
  };

  const toolList = await client.listTools();
  result.tools = toolList.tools.map((t) => t.name).sort();
  const required = [
    'create_chat', 'list_chats', 'rename_chat', 'send_chat_message',
    'chat_status', 'list_chat_messages', 'send_message', 'list_messages'
  ];
  for (const name of required) assert(result.tools.includes(name), `missing tool: ${name}`);

  // ------------------------------------------------------------ create / list
  const unnamed = await call(client, 'create_chat', {});
  assert(unnamed.name === '新群聊', `unnamed chat should default to 新群聊, got ${unnamed.name}`);
  assert(typeof unnamed.chat_id === 'string' && unnamed.chat_id.length > 0, 'create_chat returned no chat_id');
  assert(typeof unnamed.created_at === 'string', 'create_chat returned no created_at');

  const chatA = await call(client, 'create_chat', { name: '验证群聊 A' });
  const chatB = await call(client, 'create_chat', { name: '验证群聊 B' });
  result.chats.created = [unnamed, chatA, chatB];

  const renamed = await call(client, 'rename_chat', { chat_id: unnamed.chat_id, name: '验证群聊 未命名改' });
  assert(renamed.name === '验证群聊 未命名改', 'rename_chat did not update the name');

  const initialList = await call(client, 'list_chats', {});
  assert(initialList.chats.length === 3, `expected 3 active chats, got ${initialList.chats.length}`);
  for (const chat of initialList.chats) {
    assert(chat.needs_muse === false, `new chat ${chat.chat_id} should not need muse`);
    assert(chat.agents.claude === 'idle' && chat.agents.dsh === 'idle', 'new chat agents should be idle');
    assert(chat.last_message_at === null, 'new chat should have no last_message_at');
  }
  result.chats.initial_list = initialList.chats.map((c) => ({
    chat_id: c.chat_id, name: c.name, needs_muse: c.needs_muse, agents: c.agents
  }));

  const archivedList = await call(client, 'list_chats', { status: 'archived' });
  assert(archivedList.chats.length === 0, 'archive filter returned rows for a fresh store');

  // --------------------------------------------------- user message / needs_muse
  const userMessage = await call(client, 'send_chat_message', {
    chat_id: chatA.chat_id,
    from: 'user',
    to: 'muse',
    summary: '请把后端群聊接口验证一遍，先看消息隔离。'
  });
  assert(userMessage.chat_id === chatA.chat_id, 'send_chat_message returned the wrong chat_id');
  assert(typeof userMessage.message_id === 'string', 'send_chat_message returned no message_id');

  const afterUser = await call(client, 'chat_status', { chat_id: chatA.chat_id });
  assert(afterUser.needs_muse === true, 'needs_muse did not become true after a user message');
  assert(afterUser.agents.muse.status === 'needs_reply', 'muse status should be needs_reply');
  assert(afterUser.agents.claude.status === 'idle' && afterUser.agents.dsh.status === 'idle',
    'agent statuses must stay idle before any sub-task');
  result.needs_muse.after_user = { needs_muse: afterUser.needs_muse, muse: afterUser.agents.muse.status };

  const museReply = await call(client, 'send_chat_message', {
    chat_id: chatA.chat_id,
    from: 'muse',
    to: 'user',
    summary: '收到，我先核对消息隔离，再派给 claude 验证。'
  });
  assert(museReply.message_id, 'muse reply was not stored');
  const afterMuse = await call(client, 'chat_status', { chat_id: chatA.chat_id });
  assert(afterMuse.needs_muse === false, 'needs_muse stayed true after a Muse reply');
  assert(afterMuse.agents.muse.status === 'idle', 'muse status should return to idle');
  result.needs_muse.after_muse = { needs_muse: afterMuse.needs_muse, muse: afterMuse.agents.muse.status };

  const badUserTarget = await callError(client, 'send_chat_message', {
    chat_id: chatA.chat_id, from: 'user', to: 'claude', summary: 'should be rejected'
  });
  assert(badUserTarget && /muse/.test(badUserTarget), `user -> claude should be rejected, got: ${badUserTarget}`);
  result.needs_muse.user_must_target_muse = badUserTarget.trim();

  // --------------------------------------------- Muse -> agent auto-delivery
  const userRequest2 = await call(client, 'send_chat_message', {
    chat_id: chatA.chat_id,
    from: 'user',
    to: 'muse',
    summary: '让 claude 汇报一次后端群聊实现情况。'
  });
  assert(userRequest2.message_id, 'second user message was not stored');

  const assignment = await call(client, 'send_chat_message', {
    chat_id: chatA.chat_id,
    from: 'muse',
    to: 'claude',
    summary: '请从 src/chats.js 的角度汇报群聊实现，并说明消息隔离怎么保证。',
    question: '两个群聊的消息会不会互相泄漏？'
  });
  assert(assignment.delivery_task_id, 'Muse -> claude did not start a sub-task');
  const subtaskId = assignment.delivery_task_id;
  result.delivery.assignment = {
    message_id: assignment.message_id,
    subtask_id: subtaskId,
    status: assignment.status
  };

  // The sub-task must get its own thread even though the assignment lives in
  // the chat's coordination stream.
  const assignmentRows = await call(client, 'list_messages', { chat_id: chatA.chat_id, from: 'muse', limit: 50 });
  const assignmentRow = assignmentRows.messages.find((m) => m.message_id === assignment.message_id);
  assert(assignmentRow, 'the assignment message is not listed on the chat');
  assert(assignmentRow.thread_id === `chat:${chatA.chat_id}`,
    `the assignment should live in the chat thread, got ${assignmentRow.thread_id}`);

  const promptRecord = await waitFor(
    () => executorProbe.prompts.find((p) => p.task_id === subtaskId),
    20000, 'the sub-task to receive a rendered prompt'
  );
  result.delivery.prompt_checks = {
    has_chat_name: promptRecord.prompt.includes(`chat_name: ${chatA.name}`),
    has_rendered_chat_id: promptRecord.prompt.includes(`chat_id: ${chatA.chat_id}`),
    has_raw_placeholder: promptRecord.prompt.includes('{{chat_id}}'),
    instructs_send_message_with_chat: promptRecord.prompt.includes('send_chat_message')
      || promptRecord.prompt.includes('send_message')
  };
  assert(result.delivery.prompt_checks.has_chat_name, 'the sub-task prompt did not include the chat name');
  assert(result.delivery.prompt_checks.has_rendered_chat_id, '{{chat_id}} was not rendered into the sub-task prompt');
  assert(!result.delivery.prompt_checks.has_raw_placeholder,
    'the sub-task prompt still contains the raw {{chat_id}} placeholder');
  assert(result.delivery.prompt_checks.instructs_send_message_with_chat,
    'the sub-task prompt does not tell the agent to report with a chat message');

  const subtaskStatus = await waitFor(async () => {
    const status = await call(client, 'task_status', { task_id: subtaskId });
    return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.state) ? status : null;
  }, 30000, 'the sub-task to finish');
  result.delivery.subtask = {
    state: subtaskStatus.state,
    chat_id: subtaskStatus.chat_id,
    thread_id: subtaskStatus.thread_id
  };
  assert(subtaskStatus.state === 'COMPLETED', `sub-task ended ${subtaskStatus.state}`);
  assert(subtaskStatus.chat_id === chatA.chat_id, 'task_status did not report the chat the sub-task belongs to');
  assert(subtaskStatus.thread_id === subtaskId, 'the sub-task should hold its own thread, not the chat thread');

  // The conclusion is produced by the task's own final result and routed back
  // by the engine with the assignment's chat_id.
  const conclusion = await waitFor(async () => {
    const listed = await call(client, 'list_chat_messages', { chat_id: chatA.chat_id, limit: 100 });
    const found = listed.messages.find((m) => m.from === 'claude' && m.to === 'muse');
    return found ? found : null;
  }, 30000, 'the sub-task conclusion to return to the chat');
  result.delivery.conclusion = {
    message_id: conclusion.message_id,
    from: conclusion.from,
    to: conclusion.to,
    summary: conclusion.summary,
    status: conclusion.status,
    task_id: conclusion.task_id ?? null
  };
  assert(conclusion.summary.includes(`chat ${chatA.name} (${chatA.chat_id})`),
    'the conclusion did not keep the chat context resolved in the prompt');
  assert(conclusion.task_id === subtaskId, 'the conclusion is not attributed to the sub-task that produced it');

  const statusAfterDelivery = await call(client, 'chat_status', { chat_id: chatA.chat_id });
  result.status_derivation.after_subtask = statusAfterDelivery.agents;
  assert(statusAfterDelivery.agents.claude.status === 'completed',
    `claude chat status should be completed, got ${statusAfterDelivery.agents.claude.status}`);
  assert(statusAfterDelivery.agents.claude.task_id === subtaskId,
    'claude status is not tied to the delivered sub-task');
  assert(statusAfterDelivery.needs_muse === false, 'needs_muse should be false after Muse assigned the work');
  assert(statusAfterDelivery.tasks.length === 1,
    `chat_status should list 1 sub-task, got ${statusAfterDelivery.tasks.length}`);

  // ------------------------------------------------------------ isolation
  const bUser = await call(client, 'send_chat_message', {
    chat_id: chatB.chat_id, from: 'user', to: 'muse', summary: '群聊 B 的独立请求，不应出现在 A。'
  });
  const aMessages = await call(client, 'list_chat_messages', { chat_id: chatA.chat_id, limit: 100 });
  const bMessages = await call(client, 'list_chat_messages', { chat_id: chatB.chat_id, limit: 100 });
  result.isolation = {
    chat_a_count: aMessages.messages.length,
    chat_b_count: bMessages.messages.length,
    b_leaked_into_a: bMessages.messages.some((m) => aMessages.messages.some((a) => a.message_id === m.message_id)),
    a_summaries: aMessages.messages.map((m) => m.summary)
  };
  assert(!result.isolation.b_leaked_into_a, 'chat B messages leaked into chat A');
  assert(bMessages.messages.some((m) => m.message_id === bUser.message_id), 'chat B is missing its own message');
  assert(aMessages.messages.every((m) => !bMessages.messages.some((b) => b.message_id === m.message_id)),
    'the two chats share a message row');
  assert(aMessages.messages.length === 5, `chat A should hold its 5 real rows, got ${aMessages.messages.length}`);
  assert(bMessages.messages.length === 1, `chat B should hold only its own message, got ${bMessages.messages.length}`);

  const bStatus = await call(client, 'chat_status', { chat_id: chatB.chat_id });
  assert(bStatus.needs_muse === true, 'chat B needs_muse should be independent and true');
  assert(bStatus.agents.claude.status === 'idle' && bStatus.agents.dsh.status === 'idle',
    'chat B agent status must not inherit chat A status');
  assert(bStatus.tasks.length === 0, 'chat B must not list chat A sub-tasks');
  result.isolation.chat_b_status = {
    needs_muse: bStatus.needs_muse,
    agents: bStatus.agents,
    task_count: bStatus.tasks.length
  };

  // ------------------------------------------------- status derivation matrix
  store = openStore();
  const workingAgent = insertPlaceholderTask(store, {
    id: `stub-working-${randomUUID().slice(0, 8)}`,
    sessionId: randomUUID(),
    agent: 'claude',
    state: 'WORKING',
    summary: null
  });
  store.linkChatTask(chatB.chat_id, workingAgent);
  const doneAgent = insertPlaceholderTask(store, {
    id: `stub-done-${randomUUID().slice(0, 8)}`,
    sessionId: randomUUID(),
    agent: 'dsh',
    state: 'COMPLETED'
  });
  store.linkChatTask(chatB.chat_id, doneAgent);
  store.close();
  store = null;

  const derived = await call(client, 'chat_status', { chat_id: chatB.chat_id });
  result.status_derivation.derived = {
    claude: derived.agents.claude.status,
    dsh: derived.agents.dsh.status,
    task_count: derived.tasks.length
  };
  assert(derived.agents.claude.status === 'working',
    `a WORKING task should derive 'working', got ${derived.agents.claude.status}`);
  assert(derived.agents.dsh.status === 'completed',
    `a COMPLETED task should derive 'completed', got ${derived.agents.dsh.status}`);
  assert(derived.tasks.length === 2,
    `chat_status should list both manually linked sub-tasks, got ${derived.tasks.length}`);

  const listB = await call(client, 'list_chats', {});
  const chatBRow = listB.chats.find((c) => c.chat_id === chatB.chat_id);
  result.status_derivation.list_chats_agents = chatBRow.agents;
  assert(chatBRow.agents.claude === 'working' && chatBRow.agents.dsh === 'completed',
    'list_chats did not derive the same agent statuses');

  // The list preview must match the newest real row, never a fabricated string.
  const newest = (await call(client, 'list_chat_messages', { chat_id: chatB.chat_id, limit: 100 })).messages.at(-1);
  assert(chatBRow.last_message_at === newest.created_at,
    'list_chats last_message_at does not match the newest message row');
  assert(chatBRow.last_message_preview === newest.summary.slice(0, 120),
    'list_chats last_message_preview does not match the newest message row');
  result.status_derivation.preview_matches_row = true;

  // -------------------------------------------------- exchange cap per thread
  store = openStore();
  const capThread = randomUUID();
  const capClaude = insertPlaceholderTask(store, {
    id: `cap-claude-${randomUUID().slice(0, 8)}`, sessionId: randomUUID(), agent: 'claude', state: 'COMPLETED'
  });
  const capDsh = insertPlaceholderTask(store, {
    id: `cap-dsh-${randomUUID().slice(0, 8)}`, sessionId: randomUUID(), agent: 'dsh', state: 'COMPLETED'
  });
  store.setTaskThread(capClaude, capThread, null);
  store.setTaskThread(capDsh, capThread, null);
  store.close();
  store = null;

  const sent = [];
  let lastReply = null;
  for (let i = 1; i <= 10; i += 1) {
    const fromClaude = i % 2 === 1;
    const agentName = fromClaude ? 'claude' : 'dsh';
    const message = await call(agentClients[agentName], 'send_message', {
      from: agentName,
      to: fromClaude ? 'dsh' : 'claude',
      task_id: fromClaude ? capClaude : capDsh,
      ...(lastReply ? { reply_to: lastReply } : {}),
      summary: `thread cap message ${i}`,
      deliver: false
    });
    sent.push(message);
    lastReply = message.message_id;
  }
  const tenth = sent.at(-1);
  result.cap = {
    thread_id: capThread,
    messages_sent: sent.length,
    tenth_status: tenth.status,
    thread_state: tenth.thread_state,
    waiting_for_user: tenth.waiting_for_user,
    chat_ids_are_null: sent.every((m) => m.chat_id === null)
  };
  assert(tenth.thread_state === 'WAITING_USER' && tenth.waiting_for_user,
    'the 10th agent message did not park the thread in WAITING_USER');
  assert(tenth.status === 'held', `the 10th agent message should be held, got ${tenth.status}`);
  assert(result.cap.chat_ids_are_null, 'an agent-to-agent thread message was stamped with a chat_id');

  const eleventh = await callError(agentClients.claude, 'send_message', {
    from: 'claude', to: 'dsh', task_id: capClaude, summary: 'should be rejected', deliver: false
  });
  assert(eleventh, 'the 11th agent message was accepted');
  result.cap.eleventh_rejected = eleventh.trim();

  const unbounded = await call(client, 'send_chat_message', {
    chat_id: chatA.chat_id, from: 'muse', to: 'user',
    summary: '群聊消息流不受子任务线程上限影响。'
  });
  result.cap.chat_still_accepts = Boolean(unbounded.message_id);
  assert(unbounded.message_id, 'the chat stream was blocked by a sub-task thread limit');

  // ------------------------------------------------------- impersonation guard
  const impersonation = await callError(agentClients.claude, 'send_message', {
    from: 'muse', to: 'user', task_id: capClaude, summary: 'an agent task must not send as muse'
  });
  result.impersonation = impersonation ? impersonation.trim() : null;
  assert(impersonation && /identifies as 'claude'|belongs to/.test(impersonation),
    `an agent task was allowed to send as muse: ${impersonation}`);

  const museNoTask = await call(client, 'send_message', {
    from: 'muse', to: 'user', chat_id: chatA.chat_id, summary: 'muse message without a task'
  });
  assert(!museNoTask.task_id && museNoTask.chat_id === chatA.chat_id,
    'a muse message without a task was not stored against the chat');
  const listed = await call(client, 'list_messages', { chat_id: chatA.chat_id, from: 'claude', limit: 50 });
  result.delivery.list_messages_filter = listed.messages.map((m) => ({ from: m.from, to: m.to, chat_id: m.chat_id }));
  assert(listed.messages.length === 1 && listed.messages[0].from === 'claude',
    'list_messages chat_id/from filter returned the wrong rows');
  assert(listed.messages[0].chat_id === chatA.chat_id, 'list_messages did not expose chat_id');

  // ------------------------------------------------------------- persistence
  const before = {
    a: (await call(client, 'list_chat_messages', { chat_id: chatA.chat_id, limit: 100 })).count,
    b: (await call(client, 'list_chat_messages', { chat_id: chatB.chat_id, limit: 100 })).count,
    needs_muse_b: (await call(client, 'chat_status', { chat_id: chatB.chat_id })).needs_muse,
    chats: (await call(client, 'list_chats', {})).chats.length
  };
  result.persistence.before_restart = before;
  // The engine holds no state that must survive, but the rows must: reopen the
  // database with a fresh Store and re-read the same chats.
  store = openStore();
  const reA = store.listChatMessages({ chatId: chatA.chat_id, limit: 100 });
  const reB = store.listChatMessages({ chatId: chatB.chat_id, limit: 100 });
  result.persistence.after_reopen = { a: reA.length, b: reB.length };
  store.close();
  store = null;
  assert(reA.length === before.a && reB.length === before.b,
    'chat messages did not survive a fresh database handle');

  await client.close().catch(() => {});
  client = null;
  await sleep(100);
  const reopened = await connect();
  const afterRestart = {
    a: (await call(reopened, 'list_chat_messages', { chat_id: chatA.chat_id, limit: 100 })).count,
    b: (await call(reopened, 'list_chat_messages', { chat_id: chatB.chat_id, limit: 100 })).count,
    needs_muse_b: (await call(reopened, 'chat_status', { chat_id: chatB.chat_id })).needs_muse,
    chats: (await call(reopened, 'list_chats', {})).chats.length
  };
  result.persistence.after_reconnect = afterRestart;
  assert(afterRestart.a === before.a && afterRestart.b === before.b,
    'chat messages changed across a reconnect');
  assert(afterRestart.needs_muse_b === before.needs_muse_b, 'needs_muse changed across a reconnect');
  assert(afterRestart.chats === 3, 'chats did not survive a reconnect');
  await reopened.close().catch(() => {});

  result.mcp_tool_calls = Number((readServerLog().match(/MCP tools\/call/g) || []).length);
  result.llm_calls = 0;
  result.ok = true;
}

try {
  await main();
} catch (error) {
  result.errors.push(error.stack || error.message);
} finally {
  try { await client?.close(); } catch { /* ignore */ }
  try { store?.close(); } catch { /* ignore */ }
  result.finished_at = new Date().toISOString();
  const resultPath = join(runDir, 'verify-result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  const payload = JSON.stringify({
    ok: result.ok,
    result_path: resultPath,
    server_log: serverLogPath,
    engine: result.engine,
    tools: result.tools,
    chats: result.chats,
    needs_muse: result.needs_muse,
    delivery: result.delivery,
    status_derivation: result.status_derivation,
    isolation: result.isolation,
    cap: result.cap,
    impersonation: result.impersonation,
    persistence: result.persistence,
    mcp_tool_calls: result.mcp_tool_calls,
    errors: result.errors
  }, null, 2);
  serverLog.end();
  process.stdout.write(`${payload}\n`, () => process.exit(result.ok ? 0 : 1));
}

function readServerLog() {
  try { return readFileSync(serverLogPath, 'utf8'); } catch { return ''; }
}
