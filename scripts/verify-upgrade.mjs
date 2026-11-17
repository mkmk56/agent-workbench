// Isolated verification for the group-chat upgrade.
//
// Runs a real engine on a free loopback port with a temporary database and data
// directory (never port 8080 and never the production data directory). The
// engine is imported in-process because this environment blocks piped-stdio
// child processes; it is still the production HTTP/MCP server, and no executor
// is started (AGENT_AUTO_DELIVER=0).
//
// Covers: tools presence, chat create/list/archive/unarchive, epoch bump and
// idempotency, shared context, stale-epoch rejection, visibility/action split,
// impersonation rejection, self-approval rejection, agent chat/task scope,
// chunked upload limits, text/ZIP parsing, ZIP traversal rejection, file scoping
// and archive-without-deletion.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { deriveAgentToken } from '../src/auth.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runDir = join(root, 'data', `upgrade-verify-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`);
const dbPath = join(runDir, 'workbench.db');
mkdirSync(join(runDir, 'logs'), { recursive: true });

const token = randomBytes(24).toString('hex');
const claudeToken = deriveAgentToken(token, 'claude');
const dshToken = deriveAgentToken(token, 'dsh');

const port = await new Promise((resolvePort, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port;
    probe.close(() => resolvePort(assigned));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

process.env.MCP_PORT = String(port);
process.env.MCP_BIND = '127.0.0.1';
process.env.MCP_DATA_DIR = runDir;
process.env.MCP_DB_PATH = dbPath;
process.env.MCP_LOG_DIR = join(runDir, 'logs');
process.env.MCP_BEARER_TOKEN = token;
process.env.WORKBENCH_LEGACY_MASTER_ALLOW_MUSE = '1';
process.env.WORKBENCH_CREDENTIAL_DIR = join(runDir, 'credentials');
process.env.WORKBENCH_WORKSPACE_DIR = join(runDir, 'workspace');
process.env.WORKBENCH_ENV_FILE = join(runDir, 'engine.env');
process.env.AGENT_AUTO_DELIVER = '0';
process.env.AGENT_APPROVAL_GATE = '0';
process.env.WORKBENCH_CLAUDE_ENTRY = join(runDir, '__no_claude_binary__');
process.env.WORKBENCH_DSH_ENTRY = join(runDir, '__no_dsh_binary__');

const CHAT_A = 'chat-seeded-a';
const TASK_CLAUDE = 'task-seeded-claude';
const TASK_DSH = 'task-seeded-dsh';

function seed() {
  const store = new Store(dbPath, runDir);
  const now = new Date().toISOString();
  store.insertChat({ chat_id: CHAT_A, name: 'Seeded A', created_at: now, updated_at: now });
  for (const [id, kind, role, name] of [
    ['user', 'human', 'user', 'User'],
    ['muse', 'orchestrator', 'muse', 'Muse'],
    ['claude', 'agent', 'claude', 'claude'],
    ['dsh', 'agent', 'dsh', 'dsh']
  ]) {
    store.upsertChatParticipant({ chat_id: CHAT_A, participant_id: id, kind, role, display_name: name });
  }
  for (const [id, agent] of [[TASK_CLAUDE, 'claude'], [TASK_DSH, 'dsh']]) {
    store.insertTask({
      id, session_id: `session-${id}`, agent, cwd: root, prompt: `fixture ${id}`,
      state: 'COMPLETED', process_state: 'exited_success', turn_state: 'idle',
      created_at: now, updated_at: now, last_activity_at: now,
      timeout_ms: 600000, stale_after_ms: 600000, resume: 0
    });
    store.setTaskThread(id, id);
    store.linkChatTask(CHAT_A, id);
  }
  store.close();
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const textOf = (result) => result?.content?.map((part) => part.text).filter(Boolean).join('\n') ?? '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: { port, db_path: dbPath, auto_deliver: false, llm_calls: 0 },
  checks: {},
  errors: []
};
const clients = [];
let engine = null;

async function connect(label, bearer) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
  });
  const client = new Client({ name: `upgrade-verify-${label}`, version: '0.0.1' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client, name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  const text = textOf(raw);
  if (raw?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function callError(client, name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  return raw?.isError ? textOf(raw) : null;
}

async function upload(client, chatId, name, buffer) {
  const init = await call(client, 'upload_chat_file_init', {
    chat_id: chatId, name, size: buffer.length
  });
  let index = 0;
  const step = 700 * 1024;
  for (let offset = 0; offset < buffer.length; offset += step) {
    await call(client, 'upload_chat_file_chunk', {
      upload_id: init.upload_id,
      index,
      data: buffer.subarray(offset, offset + step).toString('base64')
    });
    index += 1;
  }
  return call(client, 'upload_chat_file_complete', { upload_id: init.upload_id });
}

async function waitHealthy() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('engine did not become healthy');
}

async function main() {
  seed();
  engine = await import('../src/server.js');
  await waitHealthy();

  const master = await connect('master', token);
  const claude = await connect('claude', claudeToken);
  const dsh = await connect('dsh', dshToken);

  const toolNames = (await master.listTools()).tools.map((tool) => tool.name);
  const required = [
    'create_chat', 'list_chats', 'rename_chat', 'chat_archive', 'chat_unarchive',
    'send_chat_message', 'chat_status', 'list_chat_messages', 'chat_get_context',
    'upload_chat_file_init', 'upload_chat_file_chunk', 'upload_chat_file_complete',
    'read_chat_file', 'list_chat_files', 'send_message', 'list_messages',
    'request_approval', 'respond_approval', 'list_approvals', 'task_logs'
  ];
  for (const name of required) assert(toolNames.includes(name), `missing tool ${name}`);
  result.checks.tools = { count: toolNames.length, required_present: true };

  // ---------------------------------------------------------------- archive
  const created = await call(master, 'create_chat', { name: 'Verify B' });
  const CHAT_B = created.chat_id;
  let listed = await call(master, 'list_chats', {});
  assert(listed.chats.some((chat) => chat.chat_id === CHAT_A), 'seeded chat missing');
  assert(listed.chats.some((chat) => chat.chat_id === CHAT_B), 'created chat missing');
  await call(master, 'chat_archive', { chat_id: CHAT_B });
  listed = await call(master, 'list_chats', {});
  assert(!listed.chats.some((chat) => chat.chat_id === CHAT_B), 'archived chat must be hidden by default');
  const all = await call(master, 'list_chats', { include_archived: true });
  const ids = all.chats.map((chat) => chat.chat_id);
  assert(ids.includes(CHAT_B), 'include_archived must return the archived chat');
  assert(ids.indexOf(CHAT_A) < ids.indexOf(CHAT_B), 'active chats must come before archived ones');
  const archived = all.chats.find((chat) => chat.chat_id === CHAT_B);
  assert(archived.status === 'archived', 'archive must persist status=archived');
  await call(master, 'chat_unarchive', { chat_id: CHAT_B });
  result.checks.archive = { default_hidden: true, include_archived_order: 'active-first', restore: true };

  // ------------------------------------------------------- epoch/idempotency
  const userMessage = await call(master, 'send_chat_message', {
    chat_id: CHAT_A, from: 'user', to: 'muse', body: 'hello group', client_msg_id: 'verify-1'
  });
  assert(userMessage.epoch === 1, `first user message must bump epoch to 1, got ${userMessage.epoch}`);
  const duplicate = await call(master, 'send_chat_message', {
    chat_id: CHAT_A, from: 'user', to: 'muse', body: 'retry', client_msg_id: 'verify-1'
  });
  assert(duplicate.message_id === userMessage.message_id, 'client_msg_id retry must return the same message');
  let status = await call(master, 'chat_status', { chat_id: CHAT_A });
  assert(status.epoch === 1, `duplicate retry must not bump epoch, got ${status.epoch}`);
  result.checks.epoch_idempotency = { epoch: status.epoch, same_message: true };

  const context = await call(master, 'chat_get_context', { chat_id: CHAT_A });
  assert(context.text.includes('hello group'), 'shared context must include the user message');
  assert(context.epoch === 1, 'context must expose the chat epoch');
  result.checks.context = { messages: context.messages.length, files: context.files.length, epoch: context.epoch };

  const before = await call(master, 'list_chat_messages', { chat_id: CHAT_A });
  const staleError = await callError(master, 'send_chat_message', {
    chat_id: CHAT_A, from: 'muse', to: 'dsh', body: 'stale dispatch',
    act_recipients: ['dsh'], epoch: 0
  });
  assert(staleError && /epoch mismatch/i.test(staleError), 'stale epoch dispatch must be rejected');
  const after = await call(master, 'list_chat_messages', { chat_id: CHAT_A });
  assert(after.count === before.count, 'rejected dispatch must not insert a message');
  result.checks.epoch_rejection = { rejected: true, message_count_unchanged: true };

  const acted = await call(master, 'send_chat_message', {
    chat_id: CHAT_A, from: 'muse', to: 'dsh', body: 'please act',
    act_recipients: ['dsh'], epoch: 1
  });
  assert(acted.epoch === 1, 'current-epoch dispatch must be accepted');
  assert(acted.deliveries.some((delivery) => delivery.agent === 'dsh' && delivery.status === 'pending'),
    'action recipient must get a pending delivery row');
  assert(acted.deliveries.some((delivery) => delivery.agent === 'claude' && delivery.status === 'visible'),
    'non-acting participants must only get visibility rows');
  result.checks.visibility_action = { dsh: 'pending', claude: 'visible' };

  // --------------------------------------------------------------- identity
  const impersonation = await callError(claude, 'send_message', {
    from: 'muse', to: 'claude', task_id: TASK_CLAUDE, chat_id: CHAT_A, summary: 'impersonate'
  });
  assert(impersonation && /identifies as 'claude'/i.test(impersonation), 'agent token must not post as muse');
  const noTask = await callError(claude, 'send_message', {
    from: 'claude', to: 'muse', chat_id: CHAT_A, summary: 'no task'
  });
  assert(noTask && /require an owned task_id/i.test(noTask), 'agent message without task must be rejected');
  const own = await call(claude, 'send_message', {
    from: 'claude', to: 'muse', task_id: TASK_CLAUDE, chat_id: CHAT_A, summary: 'claude conclusion'
  });
  assert(own.from === 'claude' && own.task_id === TASK_CLAUDE, 'agent may speak through its own task');
  const selfApproval = await callError(claude, 'respond_approval', {
    decision: 'once', approval_id: 'anything'
  });
  assert(selfApproval && /requires the master token/i.test(selfApproval), 'agent must not approve itself');
  result.checks.identity = { impersonation: 'rejected', missing_task: 'rejected', self_approval: 'rejected' };

  const claudeChats = await call(claude, 'list_chats', { include_archived: true });
  assert(claudeChats.chats.length === 1 && claudeChats.chats[0].chat_id === CHAT_A,
    'agent token must only list chats it participates in');
  const crossLogs = await callError(claude, 'task_logs', { task_id: TASK_DSH });
  assert(crossLogs && /cannot access task/i.test(crossLogs), 'agent must not read another agent task logs');
  await call(claude, 'task_logs', { task_id: TASK_CLAUDE });
  result.checks.scope = { chats: 1, cross_task_logs: 'rejected', own_task_logs: 'ok' };

  // ------------------------------------------------------------------ files
  const text = Buffer.from('hello from a chunked upload');
  const textMeta = await upload(master, CHAT_B, 'note.txt', text);
  assert(textMeta.parse_status === 'parsed', `text parse_status=${textMeta.parse_status}`);
  const textRead = await call(master, 'read_chat_file', { chat_id: CHAT_B, file_id: textMeta.file_id });
  assert(textRead.text.includes('hello from a chunked upload'), 'read_chat_file must return the text');
  const fileList = await call(master, 'list_chat_files', { chat_id: CHAT_B });
  assert(fileList.files.length === 1, 'list_chat_files must return the uploaded file');

  const initBig = await call(master, 'upload_chat_file_init', {
    chat_id: CHAT_B, name: 'big.bin', size: 2 * 1024 * 1024
  });
  const bigChunk = await callError(master, 'upload_chat_file_chunk', {
    upload_id: initBig.upload_id, index: 0,
    data: Buffer.alloc(1024 * 1024 + 1).toString('base64')
  });
  assert(bigChunk && /1 MB|1048576/.test(bigChunk), 'chunk over 1 MB must be rejected');
  const bigFile = await callError(master, 'upload_chat_file_init', {
    chat_id: CHAT_B, name: 'huge.bin', size: 21 * 1024 * 1024
  });
  assert(bigFile && /20 MB|20971520/.test(bigFile), 'file over 20 MB must be rejected');
  result.checks.upload_limits = { chunk: 'rejected', file: 'rejected' };

  const barePath = await callError(master, 'send_chat_message', {
    chat_id: CHAT_B, from: 'user', to: 'muse', body: 'path', files: ['C:\\Windows\\win.ini']
  });
  assert(barePath && /bare file paths/i.test(barePath), 'bare paths must be rejected');
  const crossFile = await callError(master, 'send_chat_message', {
    chat_id: CHAT_A, from: 'user', to: 'muse', body: 'wrong chat', files: [textMeta.file_id]
  });
  assert(crossFile && /does not belong to chat/i.test(crossFile), 'file from another chat must be rejected');
  await call(master, 'send_chat_message', {
    chat_id: CHAT_B, from: 'user', to: 'muse', body: 'with attachment', files: [textMeta.file_id]
  });
  result.checks.file_references = { bare_path: 'rejected', cross_chat: 'rejected', attach: 'ok' };

  const zipMeta = await upload(master, CHAT_B, 'bundle.zip', makeZip([
    ['a.txt', 'zip content'],
    ['dir/b.md', '# nested']
  ]));
  assert(zipMeta.parse_status === 'parsed', `zip parse_status=${zipMeta.parse_status}`);
  const tree = await call(master, 'read_chat_file', { chat_id: CHAT_B, file_id: zipMeta.file_id });
  assert(tree.kind === 'zip' && JSON.stringify(tree.tree).includes('a.txt'), 'ZIP must return a file tree');
  const entry = await call(master, 'read_chat_file', {
    chat_id: CHAT_B, file_id: zipMeta.file_id, entry: 'dir/b.md'
  });
  assert(entry.text.includes('nested'), 'ZIP entry must be readable by relative path');

  const evilZip = await upload(master, CHAT_B, 'evil.zip', makeZip([['../evil.txt', 'pwn']]));
  assert(evilZip.parse_status === 'failed', 'traversal ZIP must fail parsing');
  const evilRead = await callError(master, 'read_chat_file', { chat_id: CHAT_B, file_id: evilZip.file_id });
  assert(evilRead && /unsafe parent traversal/i.test(evilRead), 'traversal ZIP must return an explicit error');
  result.checks.zip = { tree: true, entry: true, traversal_rejected: true };

  const agentRead = await callError(claude, 'read_chat_file', { chat_id: CHAT_B, file_id: textMeta.file_id });
  assert(agentRead && /not a participant/i.test(agentRead), 'agent must not read files from a chat it has not joined');

  // --------------------------------------------------- archive keeps content
  await call(master, 'chat_archive', { chat_id: CHAT_B });
  const stillRead = await call(master, 'read_chat_file', { chat_id: CHAT_B, file_id: textMeta.file_id });
  assert(stillRead.text.includes('hello from a chunked upload'), 'archiving must not delete files');
  const stillListedMessages = await call(master, 'list_chat_messages', { chat_id: CHAT_B });
  assert(
    stillListedMessages.count >= 1
    && stillListedMessages.messages.some((message) => message.body === 'with attachment'),
    'archiving must not delete messages'
  );
  result.checks.archive_preserves_data = { files: true, messages: stillListedMessages.count };

  // -------------------------------------------------------------- DB checks
  const checkStore = new Store(dbPath, runDir);
  try {
    const indexes = checkStore.db.prepare('PRAGMA index_list(messages)').all().map((row) => row.name);
    assert(!indexes.includes('idx_messages_reply_unique'), 'reply unique index must be gone');
    assert(checkStore.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND client_msg_id = 'verify-1'"
    ).get(CHAT_A).n === 1, 'client_msg_id must be unique in the database');
    assert(checkStore.listMessageDeliveries(acted.message_id).length >= 2, 'delivery rows must exist');
    const attached = checkStore.listMessageFiles(
      checkStore.listChatMessages({ chatId: CHAT_B }).find((message) => JSON.parse(message.files_json).length > 0).id
    );
    assert(attached.length === 1, 'message_files link must exist');
    result.checks.database = { reply_index_removed: true, idempotent_rows: 1, deliveries: true, message_files: true };
  } finally {
    checkStore.close();
  }

  result.ok = true;
}

try {
  await main();
} catch (error) {
  result.ok = false;
  result.errors.push(error.message);
  if (engine) {
    try { result.server_log_tail = 'see console output above'; } catch { /* ignore */ }
  }
} finally {
  for (const client of clients) {
    try { await client.close(); } catch { /* ignore */ }
  }
  if (engine?.server) {
    await new Promise((resolveClose) => engine.server.close(resolveClose));
    try { engine.store.close(); } catch { /* ignore */ }
  }
  result.finished_at = new Date().toISOString();
  const resultPath = join(runDir, 'verify-result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
  console.log(`result written to ${resultPath}`);
  process.exit(result.ok ? 0 : 1);
}