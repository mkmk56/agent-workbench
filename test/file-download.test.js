import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { issueAgentToken } from '../src/auth.js';
import { tempDir } from './helpers.js';

// The route lives in src/server.js, so this test boots the real engine on a
// free loopback port with a temporary database/data directory, then drives it
// over HTTP with the master bearer token (never port 8080 or production data).

const TOKEN = randomBytes(24).toString('hex');
const CHAT_A = 'chat-download-a';
const CHAT_B = 'chat-download-b';

const PDF_BYTES = Buffer.concat([
  Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]),
  randomBytes(4096),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46])
]);
const PDF_NAME = '季度报告.pdf';
const FILE_A = 'file-download-a';
const FILE_B = 'file-download-b';
const FILE_MISSING = 'file-download-missing';
const FILE_ESCAPING = 'file-download-escaping';
const ESCAPE_BYTES = Buffer.from('must never be served', 'utf8');

const dir = tempDir('agent-workbench-download-');
let engine = null;
let port = 0;

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

function seed() {
  const store = new Store(join(dir, 'workbench.db'), dir);
  const now = new Date().toISOString();
  for (const chatId of [CHAT_A, CHAT_B]) {
    store.insertChat({
      chat_id: chatId, name: chatId, created_at: now, updated_at: now, status: 'active', epoch: 0
    });
  }

  const insert = ({ fileId, chatId, name, mime, bytes, storedPath }) => {
    const chatDir = join(dir, 'chat-files', chatId);
    mkdirSync(chatDir, { recursive: true });
    const storedName = `${fileId}-${name}`;
    writeFileSync(join(chatDir, storedName), bytes);
    store.insertChatFile({
      file_id: fileId,
      chat_id: chatId,
      uploader_id: 'user',
      original_name: name,
      stored_path: storedPath ?? `chat-files/${chatId}/${storedName}`,
      mime,
      size: bytes.length,
      sha256: '0'.repeat(64),
      parse_status: 'parsed',
      parse_error: null,
      extracted_path: null,
      created_at: now
    });
  };

  insert({ fileId: FILE_A, chatId: CHAT_A, name: PDF_NAME, mime: 'application/pdf', bytes: PDF_BYTES });
  insert({ fileId: FILE_B, chatId: CHAT_B, name: 'b.txt', mime: 'text/plain', bytes: Buffer.from('b') });
  // Registered row whose stored path escapes the chat directory. The file does
  // exist on disk (one level up) but must not be reachable through the route.
  writeFileSync(join(dir, 'chat-files', 'escape.txt'), ESCAPE_BYTES);
  store.insertChatFile({
    file_id: FILE_ESCAPING,
    chat_id: CHAT_A,
    uploader_id: 'user',
    original_name: 'escape.txt',
    stored_path: `chat-files/${CHAT_A}/../escape.txt`,
    mime: 'text/plain',
    size: ESCAPE_BYTES.length,
    sha256: '0'.repeat(64),
    parse_status: 'parsed',
    parse_error: null,
    extracted_path: null,
    created_at: now
  });
  // A row whose stored file was deleted from disk.
  store.insertChatFile({
    file_id: FILE_MISSING,
    chat_id: CHAT_A,
    uploader_id: 'user',
    original_name: 'gone.txt',
    stored_path: `chat-files/${CHAT_A}/${FILE_MISSING}-gone.txt`,
    mime: 'text/plain',
    size: 4,
    sha256: '0'.repeat(64),
    parse_status: 'parsed',
    parse_error: null,
    extracted_path: null,
    created_at: now
  });
  store.close();
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('engine did not become healthy');
}

function request(path, { token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

before(async () => {
  seed();
  port = await freePort();
  // Config reads the environment once, at import time.
  process.env.MCP_PORT = String(port);
  process.env.MCP_BIND = '127.0.0.1';
  process.env.MCP_DATA_DIR = dir;
  process.env.MCP_DB_PATH = join(dir, 'workbench.db');
  process.env.MCP_LOG_DIR = join(dir, 'logs');
  process.env.MCP_BEARER_TOKEN = TOKEN;
  process.env.AGENT_AUTO_DELIVER = '0';
  process.env.AGENT_APPROVAL_GATE = '0';
  process.env.WORKBENCH_CLAUDE_ENTRY = join(dir, '__no_claude_binary__');
  process.env.WORKBENCH_DSH_ENTRY = join(dir, '__no_dsh_binary__');
  // Keep the real per-user credential directory and workspace untouched.
  process.env.WORKBENCH_CREDENTIAL_DIR = join(dir, 'credentials');
  process.env.WORKBENCH_WORKSPACE_DIR = join(dir, 'workspace');
  process.env.WORKBENCH_ENV_FILE = join(dir, 'credentials', 'engine.env');
  engine = await import('../src/server.js');
  await waitForHealth();
});

after(async () => {
  if (engine) {
    await new Promise((resolve) => {
      engine.server.close(resolve);
      engine.server.closeAllConnections?.();
    });
    engine.scheduler.shutdown();
    engine.store.close();
  }
});

test('serves exact raw bytes with the stored mime and an attachment filename', async () => {
  const res = await request(`/chats/${CHAT_A}/files/${FILE_A}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-length'), String(PDF_BYTES.length));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment;/);
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  assert.ok(encoded, `missing RFC 5987 filename: ${disposition}`);
  assert.equal(decodeURIComponent(encoded), PDF_NAME);
  assert.match(disposition, /filename="[^"]+"/);

  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, PDF_BYTES);
});

test('unknown file_id returns 404', async () => {
  const res = await request(`/chats/${CHAT_A}/files/no-such-file`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'file not found' });
});

test('a file registered to another chat returns 404', async () => {
  const res = await request(`/chats/${CHAT_B}/files/${FILE_A}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'file not found' });
});

test('a registered file missing from disk returns 404', async () => {
  const res = await request(`/chats/${CHAT_A}/files/${FILE_MISSING}`);
  assert.equal(res.status, 404);
});

test('download without a token returns 401', async () => {
  const res = await request(`/chats/${CHAT_A}/files/${FILE_A}`, { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('a valid agent token is not the master token and returns 403', async () => {
  // Static agent tokens are disabled; a real per-task token authenticates as
  // an agent principal but still may not use the human download route.
  const agentToken = issueAgentToken(TOKEN, {
    agent: 'claude', taskId: 'download-test-task', ttlMs: 60_000
  });
  const res = await request(`/chats/${CHAT_A}/files/${FILE_A}`, { token: agentToken });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'forbidden' });
});

test('path traversal attempts are rejected with 404', async () => {
  const attempts = [
    `/chats/${CHAT_A}/files/..%2F..%2Fworkbench.db`,
    `/chats/${CHAT_A}/files/..%5C..%5Cworkbench.db`,
    `/chats/..%2F${CHAT_B}/files/${FILE_B}`,
    `/chats/${CHAT_A}/files/${FILE_ESCAPING}`
  ];
  for (const path of attempts) {
    const res = await request(path);
    assert.equal(res.status, 404, `expected 404 for ${path}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.notDeepEqual(body, ESCAPE_BYTES);
  }
});