import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { registerTools } from './tools.js';

const store = new Store(config.dbPath, config.dataDir);
const scheduler = new Scheduler(store, config);
const startedAt = Date.now();
mkdirSync(config.logDir, { recursive: true });
const pidFile = join(config.logDir, 'server.pid');

const rateBuckets = new Map();
const rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MIN || 600);

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const raw = cf || (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.socket.remoteAddress || 'unknown';
  return String(raw).split(',')[0].trim();
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

function createMcpServer() {
  const server = new McpServer(
    { name: 'agent-workbench', version: '0.1.0' },
    { capabilities: { logging: {} } }
  );
  registerTools(server, { scheduler, store });
  return server;
}

function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  // Auth scheme is case-insensitive (RFC 7235); some MCP clients send "bearer" or no scheme at all.
  const credential = header.trim().replace(/^bearer\s+/i, '').trim();
  const provided = Buffer.from(credential);
  const expected = Buffer.from(config.token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
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

  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (isRateLimited(req)) {
    sendJson(res, 429, { error: 'rate limited' });
    return;
  }

  if (!authorized(req)) {
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

    const mcp = createMcpServer();
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