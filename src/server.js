import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { identifyToken, extractBearer } from './auth.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { MessageService } from './messages.js';
import { ChatService } from './chats.js';
import { ApprovalService } from './approvals.js';
import { FileService } from './files.js';
import { removeLegacyAgentMcpConfigs } from './mcp-config.js';
import { setExecutorTempDir } from './executors/process.js';
import { hardenPath } from './security.js';
import { registerTools } from './tools.js';

const store = new Store(config.dbPath, config.dataDir);
const scheduler = new Scheduler(store, config);
const files = new FileService({ store, config });
const messages = new MessageService({ store, scheduler, config, files });
const chats = new ChatService({ store, messages, config });
const approvals = new ApprovalService({ store, config, messages, scheduler });
scheduler.messages = messages;
scheduler.approvals = approvals;
// A running tool call cannot survive a restart; release any thread that was
// parked in WAITING_USER by a pending approval.
approvals.recover();
const startedAt = Date.now();
mkdirSync(config.logDir, { recursive: true });
const pidFile = join(config.logDir, 'server.pid');

// ---------------------------------------------------------------------------
// P0-1 filesystem hygiene
//
// Executors run in a workspace that contains no credentials. The credential
// env file and chat attachments are restricted to SYSTEM/Administrators/the
// current user (the same ACL as the old token file). Static data/*-mcp.json
// files are removed: each task now gets its own short-lived config outside the
// repository. ACLs cannot isolate processes running as the same Windows user,
// so the env allow-list and cwd change are the primary controls.
// ---------------------------------------------------------------------------
mkdirSync(config.executorWorkspace, { recursive: true });
// Executor TEMP/TMP is redirected here so the inherited temp path cannot
// reveal %LOCALAPPDATA%. It must stay outside executorWorkspace: the Windows
// ACL sandbox rejects a temp root nested in the workspace before spawning.
// No secrets are written to this directory.
mkdirSync(config.executorTempDir, { recursive: true });
setExecutorTempDir(config.executorTempDir);
mkdirSync(config.chatFilesDir, { recursive: true });
mkdirSync(config.credentialDir, { recursive: true });
mkdirSync(config.taskConfigDir, { recursive: true });
const aclResults = {
  workspace: hardenPath(config.executorWorkspace, { directory: true }),
  credentialDir: hardenPath(config.credentialDir, { directory: true }),
  chatFiles: hardenPath(config.chatFilesDir, { directory: true, recursive: true })
};
if (config.envFile) aclResults.envFile = hardenPath(config.envFile);
const removedLegacyConfigs = removeLegacyAgentMcpConfigs(config);
if (removedLegacyConfigs.length > 0) {
  console.log(`removed legacy static MCP configs: ${removedLegacyConfigs.join(', ')}`);
}
// Warn whenever the repository still holds workbench.env. Loading credentials
// from it is the more severe legacy case, but after the one-time migration the
// file is merely residual: it is no longer read, yet it still exposes the old
// token to anything that can read the repository. existsSync is explicit so
// this warning also fires when engine.env (not the legacy file) was loaded.
const repoEnvFile = config.legacyEnvFile || config.legacyEnvPath;
if (repoEnvFile && existsSync(repoEnvFile)) {
  console.warn(config.legacyEnvFile
    ? 'deprecated-workbench-env: engine credentials are being read from the repository; '
      + 'run scripts/install-credentials.mjs and remove the repo-root workbench.env'
    : 'deprecated-workbench-env: the repository still contains workbench.env; '
      + 'remove it (credentials are loaded from engine.env)');
}
for (const [label, result] of Object.entries(aclResults)) {
  if (result && result.ok === false) console.warn(`acl: could not restrict ${label}: ${result.error}`);
}

// P1-1: reconcile only after the message layer is assembled AND the executor
// directories/ACLs/temp root are in place. Replay can start sub-tasks, so
// running it here keeps every spawned process on the hardened paths.
scheduler.reconcile({ reason: 'service restart' });

const rateBuckets = new Map();
const rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MIN || 600);

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const raw = cf || (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.socket.remoteAddress || 'unknown';
  return String(raw).split(',')[0].trim();
}

// Attach request-scoped fields used for provenance and audit logs. Never
// copies token material.
function enrichAuth(auth, req) {
  if (!auth) return auth;
  const headerId = typeof req.headers['x-request-id'] === 'string'
    ? req.headers['x-request-id'].trim()
    : '';
  auth.request_id = headerId && headerId.length <= 200 ? headerId : randomUUID();
  auth.source_ip = clientIp(req);
  if (auth.deprecated) {
    const label = auth.token_kind === 'master' ? 'deprecated-master-token' : 'deprecated-agent-token';
    console.warn(`${label} principal=${auth.principal_id ?? auth.participant} request_id=${auth.request_id} path=${req.url}`);
  }
  return auth;
}

function isRateLimited(req) {
  const now = Date.now();
  const key = clientIp(req);
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.reset) {
    bucket = { count: 0, reset: now + 60000 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) if (now >= v.reset) rateBuckets.delete(k);
  }
  return bucket.count > rateLimitPerMinute;
}

function createMcpServer(auth) {
  const server = new McpServer(
    { name: 'agent-workbench', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );
  registerTools(server, { scheduler, store, messages, approvals, chats, files, config }, auth);
  return server;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function rpcError(res, code, message) {
  sendJson(res, 200, { jsonrpc: '2.0', error: { code, message }, id: null });
}

// ---------------------------------------------------------------------------
// Raw file download: GET /chats/:id/files/:fileId
//
// The GUI can preview extracted text for every supported format, but saving the
// original bytes (PDF/DOCX/XLSX/ZIP) needs this route. Lookup goes through
// chat_files — client-supplied paths are never used — and the stored path is
// resolved strictly inside data/chat-files/<chat_id>/.
// ---------------------------------------------------------------------------

function decodeIdSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  // Chat/file ids are opaque tokens. Anything that looks like a path (separator,
  // dot segments, NUL) is rejected before it can reach the filesystem.
  if (!decoded || decoded === '.' || decoded === '..' || /[/\\\u0000]/.test(decoded)) return null;
  return decoded;
}

function safeContentType(value) {
  const clean = String(value ?? '').trim().toLowerCase().replace(/[\u0000-\u001f\u007f]/g, '');
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=[^;]*)*$/.test(clean)
    ? clean
    : 'application/octet-stream';
}

function contentDisposition(name) {
  const clean = String(name ?? 'download')
    .replace(/[\u0000-\u001f\u007f"\\]/g, '_') || 'download';
  if (/^[\x20-\x7e]+$/.test(clean)) return `attachment; filename="${clean}"`;
  // RFC 5987: an ASCII fallback for old clients plus the UTF-8 name. The extra
  // replace covers ' ( ) * which encodeURIComponent leaves literal but
  // RFC 5987 attr-char does not allow.
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(clean)
    .replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'agent-workbench',
      version: '0.1.0',
      uptime_s: Math.floor((Date.now() - startedAt) / 1000)
    });
    return;
  }

  const downloadMatch = /^\/chats\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname);
  if (downloadMatch && req.method === 'GET') {
    // Same bearer-token identity check as /mcp, then the master check: this
    // route is the GUI's raw download path and has no per-chat agent scope.
    const auth = enrichAuth(identifyToken(extractBearer(req), config), req);
    if (!auth) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    // Raw downloads are a human/GUI action. Executor tokens stay scoped to
    // their MCP tools and cannot exfiltrate attachment bytes.
    if (!auth.master && auth.role !== 'human') {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    const chatId = decodeIdSegment(downloadMatch[1]);
    const fileId = decodeIdSegment(downloadMatch[2]);
    let download = null;
    if (chatId && fileId) {
      try {
        download = files.resolveDownload({ chatId, fileId });
      } catch {
        // A stored path outside data/chat-files/<chat_id>/ is never served.
        download = null;
      }
    }
    if (!download) {
      sendJson(res, 404, { error: 'file not found' });
      return;
    }
    let body;
    try {
      body = readFileSync(download.path);
    } catch {
      sendJson(res, 404, { error: 'file not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': safeContentType(download.row.mime),
      'content-length': body.length,
      'content-disposition': contentDisposition(download.row.original_name),
      'x-content-type-options': 'nosniff'
    });
    res.end(body);
    return;
  }

  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (isRateLimited(req)) {
    sendJson(res, 429, { error: 'rate limited' });
    return;
  }

  // Identity comes from the credential, never from the request body.
  const auth = enrichAuth(identifyToken(extractBearer(req), config), req);
  if (!auth) {
    const header = req.headers.authorization;
    console.error(header
      ? `401: authorization rejected (len=${header.length}, bearer_prefix=${/^\s*bearer\s/i.test(header)})`
      : '401: authorization header missing');
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: error.message },
        id: null
      });
      return;
    }

    const rpcMethods = (Array.isArray(body) ? body : [body])
      .map((entry) => entry?.method)
      .filter(Boolean);
    if (rpcMethods.length > 0) {
      console.log(`MCP ${rpcMethods.join(',')} auth=${auth.token_kind}:${auth.participant}`
        + ` request_id=${auth.request_id}`);
    }

    const mcp = createMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null
        });
      }
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    rpcError(res, -32000, 'Method not allowed in stateless mode.');
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
});

// Static per-agent MCP configs are intentionally not written anymore. Each
// task receives a signed short-lived token through a private config file or
// child environment (see scheduler.launch / mcp-config.writeTaskMcpConfig).

server.listen(config.port, config.bind, () => {
  writeFileSync(pidFile, String(process.pid), 'utf8');
  console.log(`agent-workbench MCP listening on http://${config.bind}:${config.port}/mcp`);
  console.log(`health: http://${config.bind}:${config.port}/health`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`received ${signal}; shutting down`);
  scheduler.shutdown();
  server.close(() => {
    store.close();
    rmSync(pidFile, { force: true });
    process.exit(0);
  });
  setTimeout(() => {
    store.close();
    rmSync(pidFile, { force: true });
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Exported for the isolated verification harness (scripts/verify-upgrade.mjs).
// Importing this module still starts the listener; callers close `server` and
// `store` when finished.
export { server, store, scheduler, messages, chats, approvals, files, config };
