import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function loadClaudeEnv() {
  try {
    const path = join(homedir(), '.claude', 'settings.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc && typeof doc.env === 'object' && doc.env ? doc.env : {};
  } catch {
    return {};
  }
}

const npmGlobal = process.env.WORKBENCH_NPM_GLOBAL || 'D:\\workbuddy-tools\\node\\global';
// npm prefix implied by the Node.js executable running this server. npm global
// installs land here by default; unlike WORKBENCH_NPM_GLOBAL it follows a Node
// or npm prefix change automatically, so a moved install is still found.
const nodePrefix = dirname(process.execPath);

const CLAUDE_ENTRY_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
const DSH_ENTRY_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(String(raw).trim().toLowerCase());
}

const port = intEnv('MCP_PORT', 8080);
const dataDir = resolve(root, process.env.MCP_DATA_DIR || 'data');

export const config = {
  root,
  port,
  bind: '127.0.0.1',
  token: process.env.MCP_BEARER_TOKEN || '',
  dataDir,
  dbPath: resolve(root, process.env.MCP_DB_PATH || join(process.env.MCP_DATA_DIR || 'data', 'workbench.db')),
  logDir: resolve(root, process.env.MCP_LOG_DIR || 'logs'),
  maxParallel: intEnv('MAX_PARALLEL_TASKS', 4),
  dshParallel: intEnv('WORKBENCH_DSH_MAX_PARALLEL_TASKS', 2),
  taskTimeoutMs: intEnv('TASK_TIMEOUT_MS', 30 * 60 * 1000),
  staleAfterMs: intEnv('STALE_AFTER_MS', 10 * 60 * 1000),
  heartbeatMs: intEnv('HEARTBEAT_MS', 15 * 1000),
  claudeBin: process.env.WORKBENCH_CLAUDE_BIN || 'claude',
  dshBin: process.env.WORKBENCH_DSH_BIN || 'dsh',
  nodeBin: process.execPath,
  claudeEnv: loadClaudeEnv(),
  mcpUrl: `http://127.0.0.1:${port}/mcp`,
  claudeMcpConfigPath: resolve(dataDir, 'claude-mcp.json'),
  agentMessageLimit: intEnv('AGENT_MESSAGE_LIMIT', 10),
  agentSummaryMaxTokens: intEnv('AGENT_SUMMARY_MAX_TOKENS', 500),
  agentAutoDeliver: process.env.AGENT_AUTO_DELIVER !== '0',
  // Chat-based approval gate for merge / delete / dependency operations.
  // Off by default: the workbench keeps its fully automatic behaviour.
  agentApprovalGate: boolEnv('AGENT_APPROVAL_GATE', false),
  approvalTimeoutMs: intEnv('APPROVAL_TIMEOUT_MS', 10 * 60 * 1000)
};

// ---------------------------------------------------------------------------
// Executor command resolution
//
// Never snapshot the filesystem at module load: npm upgrades rename or remove
// the executables, and a cached absolute path turns every later task into
// ENOENT until the engine is restarted. Resolve on every task launch instead,
// in priority order, and return the skipped candidates so callers can log why
// a path was not used.
// ---------------------------------------------------------------------------

function lookupInPath(name) {
  const candidatesFromPath = [];
  const dirs = String(process.env.PATH || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  if (/[\\/]/.test(name)) {
    const candidate = resolve(name);
    return existsSync(candidate) ? candidate : null;
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const suffixes = ext === ext.toLowerCase() ? [ext] : [ext.toLowerCase(), ext.toUpperCase()];
      for (const suffix of suffixes) candidatesFromPath.push(join(dir, `${name}${suffix}`));
    }
  }
  for (const candidate of candidatesFromPath) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function samePath(a, b) {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function claudeCommandCandidates() {
  const candidates = [];
  if (process.env.WORKBENCH_CLAUDE_ENTRY) {
    candidates.push({ path: process.env.WORKBENCH_CLAUDE_ENTRY, source: 'WORKBENCH_CLAUDE_ENTRY' });
  }
  if (process.env.WORKBENCH_CLAUDE_BIN) {
    candidates.push({ path: process.env.WORKBENCH_CLAUDE_BIN, source: 'WORKBENCH_CLAUDE_BIN', lookup: true });
  }
  candidates.push({ path: join(npmGlobal, ...CLAUDE_ENTRY_SEGMENTS), source: `npm-prefix ${npmGlobal}` });
  if (!samePath(npmGlobal, nodePrefix)) {
    candidates.push({ path: join(nodePrefix, ...CLAUDE_ENTRY_SEGMENTS), source: `npm-prefix ${nodePrefix}` });
  }
  candidates.push({ path: 'claude', source: 'PATH', lookup: true });
  return candidates;
}

export function dshCommandCandidates() {
  const candidates = [];
  if (process.env.WORKBENCH_DSH_ENTRY) {
    candidates.push({ path: process.env.WORKBENCH_DSH_ENTRY, source: 'WORKBENCH_DSH_ENTRY', viaNode: true });
  }
  if (process.env.WORKBENCH_DSH_BIN) {
    candidates.push({ path: process.env.WORKBENCH_DSH_BIN, source: 'WORKBENCH_DSH_BIN', lookup: true });
  }
  candidates.push({ path: join(npmGlobal, ...DSH_ENTRY_SEGMENTS), source: `npm-prefix ${npmGlobal}`, viaNode: true });
  if (!samePath(npmGlobal, nodePrefix)) {
    candidates.push({ path: join(nodePrefix, ...DSH_ENTRY_SEGMENTS), source: `npm-prefix ${nodePrefix}`, viaNode: true });
  }
  candidates.push({ path: 'dsh', source: 'PATH', lookup: true });
  return candidates;
}

function resolveExecutable(label, candidates) {
  const skipped = [];
  for (const candidate of candidates) {
    const hit = candidate.lookup
      ? lookupInPath(candidate.path)
      : (existsSync(candidate.path) ? resolve(candidate.path) : null);
    if (hit) {
      return {
        label,
        found: true,
        command: candidate.viaNode ? process.execPath : hit,
        prefixArgs: candidate.viaNode ? [hit] : [],
        entry: hit,
        source: candidate.source,
        skipped
      };
    }
    skipped.push(candidate.path);
  }
  return { label, found: false, command: null, prefixArgs: [], entry: null, source: null, skipped };
}

export function resolveClaudeCommand() {
  return resolveExecutable('claude', claudeCommandCandidates());
}

export function resolveDshCommand() {
  return resolveExecutable('dsh', dshCommandCandidates());
}

// One-line, token-free summary safe to append to a task log.
export function describeResolution(resolved) {
  if (!resolved.found) {
    return `${resolved.label} not found; tried: ${resolved.skipped.join(' | ')}`;
  }
  const command = resolved.prefixArgs.length
    ? `${resolved.command} ${resolved.prefixArgs.join(' ')}`
    : resolved.command;
  const skipped = resolved.skipped.length
    ? `; skipped missing: ${resolved.skipped.join(' | ')}`
    : '';
  return `${resolved.label} command=${command} source=${resolved.source}${skipped}`;
}

if (!config.token || config.token.length < 32) {
  console.error('MCP_BEARER_TOKEN is required and must be at least 32 characters long.');
  process.exit(1);
}
