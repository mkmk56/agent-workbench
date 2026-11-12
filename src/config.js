import { resolve, join } from 'node:path';
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
const dshEntryCandidate = process.env.WORKBENCH_DSH_ENTRY
  || join(npmGlobal, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const claudeEntryCandidate = process.env.WORKBENCH_CLAUDE_ENTRY
  || join(npmGlobal, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(n);
}

export const config = {
  root,
  port: intEnv('MCP_PORT', 8080),
  bind: '127.0.0.1',
  token: process.env.MCP_BEARER_TOKEN || '',
  dataDir: resolve(root, 'data'),
  dbPath: resolve(root, process.env.MCP_DB_PATH || 'data/workbench.db'),
  logDir: resolve(root, process.env.MCP_LOG_DIR || 'logs'),
  maxParallel: intEnv('MAX_PARALLEL_TASKS', 4),
  dshParallel: intEnv('WORKBENCH_DSH_MAX_PARALLEL_TASKS', 2),
  taskTimeoutMs: intEnv('TASK_TIMEOUT_MS', 30 * 60 * 1000),
  staleAfterMs: intEnv('STALE_AFTER_MS', 10 * 60 * 1000),
  heartbeatMs: intEnv('HEARTBEAT_MS', 15 * 1000),
  claudeBin: process.env.WORKBENCH_CLAUDE_BIN || 'claude',
  dshBin: process.env.WORKBENCH_DSH_BIN || 'dsh',
  claudeEntry: existsSync(claudeEntryCandidate) ? claudeEntryCandidate : null,
  dshEntry: existsSync(dshEntryCandidate) ? dshEntryCandidate : null,
  nodeBin: process.execPath,
  claudeEnv: loadClaudeEnv()
};

if (!config.token || config.token.length < 32) {
  console.error('MCP_BEARER_TOKEN is required and must be at least 32 characters long.');
  process.exit(1);
}