import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveHumanToken, deriveMuseToken, issueAgentToken } from '../src/auth.js';
import { buildExecutorEnv } from '../src/executors/process.js';
import { seedChat, seedTask } from './helpers.js';

// End-to-end P0 security test. It boots the real engine (HTTP MCP transport)
// on a temporary port/data directory and proves:
//   * executors receive no master/human/Muse token and cannot read the old
//     repository credential path or another agent's static MCP config;
//   * legacy master, human, Muse and per-task agent tokens each have only
//     their documented powers;
//   * provenance columns and delivery attempts are written;
//   * Muse presence expires to offline.
//
// No LLM is called: AGENT_AUTO_DELIVER=0 and no executor is started.

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'agent-workbench-p0-'));
const TOKEN = randomBytes(24).toString('hex');
const HUMAN_TOKEN = deriveHumanToken(TOKEN);
const MUSE_TOKEN = deriveMuseToken(TOKEN);
const MUSE_TTL_MS = 1500;

let engine = null;
let port = 0;
let chatId = '';
let claudeTaskId = '';
let otherClaudeTaskId = '';
let dshTaskId = '';

const clients = {};
const REQUEST_IDS = {
  human: 'req-human-1',
  muse: 'req-muse-1',
  agent: 'req-agent-1'
};

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(() => resolvePort(assigned));
    });
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 100));
  }
  throw new Error('engine did not become healthy');
}

async function connect(bearer, requestId = null) {
  const headers = { Authorization: `Bearer ${bearer}` };
  if (requestId) headers['x-request-id'] = requestId;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers } }
  );
  const client = new Client({ name: 'p0-security-test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

function textOf(result) {
  return result?.content?.map((entry) => entry.text).join('\n') ?? '';
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

before(async () => {
  port = await freePort();
  Object.assign(process.env, {
    MCP_PORT: String(port),
    MCP_BIND: '127.0.0.1',
    MCP_DATA_DIR: dir,
    MCP_DB_PATH: join(dir, 'workbench.db'),
    MCP_LOG_DIR: join(dir, 'logs'),
    MCP_BEARER_TOKEN: TOKEN,
    AGENT_AUTO_DELIVER: '0',
    AGENT_APPROVAL_GATE: '0',
    MUSE_REQUIRE_HEARTBEAT: '1',
    MUSE_LEASE_TTL_MS: String(MUSE_TTL_MS),
    WORKBENCH_CREDENTIAL_DIR: join(dir, 'credentials'),
    WORKBENCH_WORKSPACE_DIR: join(dir, 'workspace'),
    WORKBENCH_ENV_FILE: join(dir, 'engine.env'),
    WORKBENCH_CLAUDE_ENTRY: join(dir, '__no_claude_binary__'),
    WORKBENCH_DSH_ENTRY: join(dir, '__no_dsh_binary__')
  });
  // Force the credential loader to use the temporary environment only.
  writeFileSync(join(dir, 'engine.env'), `MCP_BEARER_TOKEN=${TOKEN}\n`);

  engine = await import('../src/server.js');
  await waitForHealth();

  chatId = seedChat(engine.store, { name: 'P0 security' });
  claudeTaskId = seedTask(engine.store, { agent: 'claude', chatId, cwd: dir }).id;
  otherClaudeTaskId = seedTask(engine.store, { agent: 'claude', chatId, cwd: dir }).id;
  dshTaskId = seedTask(engine.store, { agent: 'dsh', chatId, cwd: dir }).id;

  clients.master = await connect(TOKEN);
  clients.human = await connect(HUMAN_TOKEN, REQUEST_IDS.human);
  clients.muse = await connect(MUSE_TOKEN);
  clients.agent = await connect(issueAgentToken(TOKEN, {
    agent: 'claude', taskId: claudeTaskId, chatId, scope: `chat:${chatId}`, ttlMs: 60_000
  }), REQUEST_IDS.agent);
});

after(async () => {
  for (const client of Object.values(clients)) {
    try { await client.close(); } catch { /* ignore */ }
  }
  if (engine) {
    await new Promise((resolveClose) => {
      engine.server.close(resolveClose);
      engine.server.closeAllConnections?.();
    });
    engine.scheduler.shutdown();
    engine.store.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test('P0-1 executor processes receive no engine secrets and no repository credential path', async () => {
  const script = `
    const fs = require('fs');
    const out = {
      token: process.env.MCP_BEARER_TOKEN || null,
      human: process.env.MCP_HUMAN_TOKEN || null,
      muse: process.env.MCP_MUSE_TOKEN || null,
      dataDir: process.env.MCP_DATA_DIR || null,
      dbPath: process.env.MCP_DB_PATH || null,
      cwd: process.cwd(),
      paths: {}
    };
    for (const spec of JSON.parse(process.argv[1])) {
      try { fs.readFileSync(spec.path); out.paths[spec.label] = 'readable'; }
      catch (error) { out.paths[spec.label] = error.code || 'error'; }
    }
    console.log(JSON.stringify(out));
  `;
  const paths = [
    { label: 'repoEnv', path: join(repoRoot, 'workbench.env') },
    { label: 'claudeStaticConfig', path: join(dir, 'claude-mcp.json') },
    { label: 'dshStaticConfig', path: join(dir, 'dsh-mcp.json') }
  ];
  const { stdout } = await execFileAsync(process.execPath, ['-e', script, JSON.stringify(paths)], {
    cwd: engine.config.executorWorkspace,
    env: buildExecutorEnv(),
    windowsHide: true,
    timeout: 15000
  });
  const out = JSON.parse(stdout.trim().split(/\r?\n/).pop());

  assert.equal(out.token, null, 'MCP_BEARER_TOKEN leaked into the executor');
  assert.equal(out.human, null, 'MCP_HUMAN_TOKEN leaked into the executor');
  assert.equal(out.muse, null, 'MCP_MUSE_TOKEN leaked into the executor');
  assert.equal(out.dataDir, null, 'MCP_DATA_DIR leaked into the executor');
  assert.equal(out.dbPath, null, 'MCP_DB_PATH leaked into the executor');
  assert.equal(resolve(out.cwd), resolve(engine.config.executorWorkspace), 'executor cwd is not the workspace');
  assert.equal(out.paths.repoEnv, 'ENOENT', 'the repository workbench.env is still readable');
  assert.equal(out.paths.claudeStaticConfig, 'ENOENT', 'a static agent MCP config still exists');
  assert.equal(out.paths.dshStaticConfig, 'ENOENT', 'a static agent MCP config still exists');
  assert.equal(existsSync(join(repoRoot, 'workbench.env')), false);
  assert.equal(readdirSync(engine.config.taskConfigDir).length, 0, 'no task config should exist without a task');
});

test('P0-2 the legacy master token is a human principal only', async () => {
  const ok = await call(clients.master, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'muse', body: 'legacy master user message'
  });
  assert.ok(ok.message_id);
  assert.match(await callError(clients.master, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'forged muse'
  }), /legacy master token may post/);
  assert.match(await callError(clients.master, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'claude', body: 'dispatch', act_recipients: ['claude']
  }), /orchestrator \(Muse\) token/);
});

test('P0-2 the human token cannot impersonate Muse, dispatch, start tasks or approve', async () => {
  const ok = await call(clients.human, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'muse', body: 'human message'
  });
  const row = engine.store.getMessage(ok.message_id);
  assert.equal(row.auth_kind, 'human');
  assert.equal(row.principal_id, 'user');
  assert.equal(row.request_id, REQUEST_IDS.human);

  assert.match(await callError(clients.human, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'forged muse'
  }), /human token may only post/);
  assert.match(await callError(clients.human, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'claude', body: 'dispatch', act_recipients: ['claude']
  }), /orchestrator \(Muse\) token/);
  assert.match(await callError(clients.human, 'task_start', {
    agent: 'claude', prompt: 'should not start'
  }), /operator token/);
  assert.match(await callError(clients.human, 'respond_approval', {
    decision: 'once', approval_id: 'none'
  }), /master token/);
});

test('P0-4 Muse needs a heartbeat lease and client_msg_id, and may dispatch', async () => {
  // Writes do not renew the lease; no read/heartbeat has happened yet.
  assert.match(await callError(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'no key'
  }), /client_msg_id/);
  assert.match(await callError(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'no lease', client_msg_id: 'muse-no-lease'
  }), /heartbeat lease expired/);

  const heartbeat = await call(clients.muse, 'muse_heartbeat', { source: 'test' });
  assert.equal(heartbeat.ok, true);
  assert.ok(Date.parse(heartbeat.lease_expires_at) > Date.now());

  assert.match(await callError(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'still no key'
  }), /client_msg_id/);

  const museMessage = await call(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'muse reply', client_msg_id: 'muse-reply-1'
  });
  assert.equal(engine.store.getMessage(museMessage.message_id).auth_kind, 'muse');
  assert.equal(engine.store.getMessage(museMessage.message_id).principal_id, 'muse');

  assert.match(await callError(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'muse', body: 'forged user', client_msg_id: 'muse-forged-user'
  }), /muse token may only post/);

  const dispatched = await call(clients.muse, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'claude', body: 'please act',
    act_recipients: ['claude'], client_msg_id: 'muse-dispatch-1'
  });
  assert.ok(dispatched.message_id);
  // Auto-delivery is disabled in this test (no LLM), so drive the delivery
  // state machine directly to record the skipped attempt.
  engine.messages.deliverChatActions(engine.store.getMessage(dispatched.message_id));
  const attempts = engine.store.listDeliveryAttempts(dispatched.message_id, 'claude');
  assert.ok(attempts.length >= 2, 'delivery attempt history is empty');
  assert.deepEqual(attempts.map((entry) => entry.status), ['pending', 'skipped']);

  const status = await call(clients.master, 'chat_status', { chat_id: chatId });
  assert.equal(status.agents.muse.online, true);
  assert.ok(['online', 'needs_reply'].includes(status.agents.muse.status));

  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, MUSE_TTL_MS + 500));
  const offline = await call(clients.master, 'chat_status', { chat_id: chatId });
  assert.equal(offline.agents.muse.online, false);
  assert.equal(offline.agents.muse.status, 'offline');
});

test('P0-2 per-task agent tokens are task/chat bound and expire', async () => {
  assert.match(await callError(clients.agent, 'send_chat_message', {
    chat_id: chatId, from: 'user', to: 'muse', body: 'agent as user'
  }), /token identifies as 'claude'/);
  assert.match(await callError(clients.agent, 'send_chat_message', {
    chat_id: chatId, from: 'muse', to: 'user', body: 'agent as muse'
  }), /token identifies as 'claude'/);

  assert.match(await callError(clients.agent, 'send_chat_message', {
    chat_id: chatId, from: 'claude', to: 'muse', task_id: otherClaudeTaskId, body: 'wrong task'
  }), /bound to task|belongs to/);
  assert.match(await callError(clients.agent, 'send_chat_message', {
    chat_id: chatId, from: 'claude', to: 'muse', task_id: dshTaskId, body: 'other agent task'
  }), /belongs to dsh|bound to task/);

  const own = await call(clients.agent, 'send_chat_message', {
    chat_id: chatId, from: 'claude', to: 'muse', task_id: claudeTaskId, body: 'my conclusion'
  });
  const row = engine.store.getMessage(own.message_id);
  assert.equal(row.auth_kind, 'agent:claude');
  assert.equal(row.principal_id, 'claude');
  assert.equal(row.request_id, REQUEST_IDS.agent);

  // An expired token is rejected during initialize (401), not by a tool.
  const expired = issueAgentToken(TOKEN, {
    agent: 'claude', taskId: claudeTaskId, chatId,
    ttlMs: 60_000, now: Date.now() - 120_000
  });
  await assert.rejects(() => connect(expired), /401|unauthorized|Unauthorized/i);
});

test('P0-3 messages carry auth_kind/principal_id/request_id and deliveries keep attempts', () => {
  const rows = engine.store.listChatMessages({ chatId, limit: 100 });
  const humans = rows.filter((row) => row.auth_kind === 'human');
  const muses = rows.filter((row) => row.auth_kind === 'muse');
  const agents = rows.filter((row) => row.auth_kind === 'agent:claude');
  assert.ok(humans.length >= 2, 'human messages are not attributed');
  assert.ok(muses.length >= 1, 'muse messages are not attributed');
  assert.ok(agents.length >= 1, 'agent messages are not attributed');
  for (const row of rows.filter((entry) => entry.chat_id === chatId)) {
    assert.ok(row.principal_id, `message ${row.id} has no principal_id`);
  }
  const dispatch = rows.find((row) => row.from_agent === 'muse' && row.to_agent === 'claude');
  assert.ok(dispatch, 'dispatch row not found');
  const attempts = engine.store.listDeliveryAttempts(dispatch.id, 'claude');
  assert.ok(attempts.length >= 2, 'expected pending -> skipped attempt history');
  assert.deepEqual(attempts.map((entry) => entry.status), ['pending', 'skipped']);
});