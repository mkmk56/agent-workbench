import { resolve, join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  deriveAgentTokens, deriveHumanToken, deriveMuseToken
} from './auth.js';
import { credentialDir, loadEngineEnv } from './credentials.js';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// Credentials live outside the repository. The legacy repo-root workbench.env
// is still read once (with a warning) so an existing installation can start
// and run scripts/install-credentials.mjs; after migration the executor cwd
// and environment no longer expose any token file.
const envLoad = loadEngineEnv({ legacyPaths: [resolve(root, 'workbench.env')] });

function readSettingsEnv(path) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return doc && typeof doc.env === 'object' && doc.env ? doc.env : {};
}

// Claude's gateway settings normally live in ~/.claude/settings.json. In a
// container that file may be mounted (default path or WORKBENCH_CLAUDE_SETTINGS)
// or the same env block may be supplied inline as WORKBENCH_CLAUDE_ENV_JSON.
// The inline form wins when both are present.
function loadClaudeEnv() {
  const env = {};
  const explicitPath = process.env.WORKBENCH_CLAUDE_SETTINGS;
  const settingsPath = explicitPath || join(homedir(), '.claude', 'settings.json');
  try {
    Object.assign(env, readSettingsEnv(settingsPath));
  } catch (error) {
    if (explicitPath) {
      // Do not include the parser message: JSON.parse echoes part of the input,
      // which may contain an API token.
      throw new Error(`cannot load WORKBENCH_CLAUDE_SETTINGS (${settingsPath}): ${error.code || 'unreadable or invalid JSON'}`);
    }
    // The default per-user settings file is optional.
  }

  const inline = process.env.WORKBENCH_CLAUDE_ENV_JSON;
  if (inline !== undefined && inline !== '') {
    let parsed;
    try {
      parsed = JSON.parse(inline);
    } catch {
      // Same reason as above: never echo the parser message or the raw value.
      throw new Error('WORKBENCH_CLAUDE_ENV_JSON is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('WORKBENCH_CLAUDE_ENV_JSON must be a JSON object');
    }
    for (const [key, value] of Object.entries(parsed)) env[key] = String(value);
  }

  // The raw JSON may contain an API token. Remove it before executors inherit
  // process.env; the parsed values still reach claude through config.claudeEnv.
  delete process.env.WORKBENCH_CLAUDE_ENV_JSON;
  return env;
}

// On Windows the npm global prefix itself contains node_modules. On POSIX the
// prefix is the parent of bin/ and packages live under <prefix>/lib/node_modules.
const defaultNpmGlobal = process.platform === 'win32' ? 'D:\\workbuddy-tools\\node\\global' : null;
const npmGlobal = process.env.WORKBENCH_NPM_GLOBAL || defaultNpmGlobal;
// npm prefix implied by the Node.js executable running this server. npm global
// installs land here by default; unlike WORKBENCH_NPM_GLOBAL it follows a Node
// or npm prefix change automatically, so a moved install is still found.
const nodePrefix = dirname(process.execPath);

const CLAUDE_PACKAGE_SEGMENTS = ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
const DSH_PACKAGE_SEGMENTS = ['@deepseek-ai', 'dsh', 'lib', 'bin.js'];

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
const executorWorkspace = resolve(root, process.env.WORKBENCH_WORKSPACE_DIR || 'workspace');
// Executors inherit TEMP/TMP but must not inherit a path that points into the
// user profile (%LOCALAPPDATA%\Temp). Redirect them to a workspace directory.
const executorTempDir = process.env.WORKBENCH_EXECUTOR_TMP_DIR
  ? resolve(process.env.WORKBENCH_EXECUTOR_TMP_DIR)
  : resolve(executorWorkspace, '.tmp');
// Local default stays loopback-only. Containers set MCP_BIND=0.0.0.0 so the
// platform's reverse proxy can reach the engine.
const bind = process.env.MCP_BIND || '127.0.0.1';
// The engine and executors share a process namespace, so the internal MCP URL
// can always use loopback even when the listener is wildcard-bound.
const internalHost = ['0.0.0.0', '::', '[::]'].includes(bind) ? '127.0.0.1' : bind;

export const config = {
  root,
  port,
  bind,
  token: process.env.MCP_BEARER_TOKEN || '',
  // Token principals. Human and Muse are independent random secrets stored in
  // engine.env. Deriving them from the master is a rollback-only mode that
  // must be opted into explicitly; otherwise reading the master token would
  // also yield the Muse dispatch capability.
  humanToken: process.env.MCP_HUMAN_TOKEN || '',
  museToken: process.env.MCP_MUSE_TOKEN || '',
  allowDerivedPrincipalTokens: process.env.WORKBENCH_DERIVE_PRINCIPAL_TOKENS === '1',
  legacyMasterEnabled: process.env.WORKBENCH_LEGACY_MASTER !== '0',
  legacyMasterAllowMuse: process.env.WORKBENCH_LEGACY_MASTER_ALLOW_MUSE === '1',
  // Static per-agent tokens are disabled by default. They are unexpiring and
  // derivable from the master, so an installation must opt in explicitly
  // (WORKBENCH_LEGACY_AGENT_TOKENS=1) for one compatibility version.
  legacyAgentTokensEnabled: process.env.WORKBENCH_LEGACY_AGENT_TOKENS === '1',
  // The human token is read-only/collaboration by default: it may post as
  // user but cannot dispatch, start tasks or approve. Raise this to let the
  // GUI use the human token for task_start during the transition.
  humanCanOperate: boolEnv('WORKBENCH_HUMAN_OPERATE', false),
  // Muse must keep a heartbeat lease. list_chats/chat_status/muse_heartbeat
  // refresh it; a send without a fresh lease is rejected.
  museRequireHeartbeat: boolEnv('MUSE_REQUIRE_HEARTBEAT', true),
  museLeaseTtlMs: intEnv('MUSE_LEASE_TTL_MS', 5 * 60 * 1000),
  // Per-task executor tokens expire with the task (plus a safety margin).
  agentTokenTtlMs: intEnv('AGENT_TOKEN_TTL_MS', 2 * 60 * 60 * 1000),
  // Executors run here, not in the repository root. The workspace contains no
  // secrets; master may still pass an explicit cwd to task_start.
  executorWorkspace,
  executorTempDir,
  credentialDir: credentialDir(),
  taskConfigDir: resolve(credentialDir(), 'task-configs'),
  envFile: envLoad.path,
  legacyEnvFile: envLoad.legacy,
  // Always present, whether or not the legacy file was loaded. Lets startup
  // warn about a leftover repository copy after the one-time migration.
  legacyEnvPath: resolve(root, 'workbench.env'),
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
  mcpUrl: `http://${internalHost}:${port}/mcp`,
  claudeMcpConfigPath: resolve(dataDir, 'claude-mcp.json'),
  dshMcpConfigPath: resolve(dataDir, 'dsh-mcp.json'),
  agentMessageLimit: intEnv('AGENT_MESSAGE_LIMIT', 10),
  agentSummaryMaxTokens: intEnv('AGENT_SUMMARY_MAX_TOKENS', 500),
  agentAutoDeliver: process.env.AGENT_AUTO_DELIVER !== '0',
  // Chat-based approval gate for merge / delete / dependency operations.
  // Off by default: the workbench keeps its fully automatic behaviour.
  agentApprovalGate: boolEnv('AGENT_APPROVAL_GATE', false),
  approvalTimeoutMs: intEnv('APPROVAL_TIMEOUT_MS', 10 * 60 * 1000),
  // ---------------------------------------------------------------------
  // Group-chat upgrade
  // ---------------------------------------------------------------------
  chatFilesDir: resolve(dataDir, 'chat-files'),
  chatContextTokenBudget: intEnv('CHAT_CONTEXT_TOKEN_BUDGET', 6000),
  chatContextMessageLimit: intEnv('CHAT_CONTEXT_MESSAGE_LIMIT', 30),
  // Hard ceiling on executor messages inside one epoch. A real user message
  // starts a new epoch and resets this budget.
  chatEpochAgentBudget: intEnv('CHAT_EPOCH_AGENT_BUDGET', 20),
  // Must stay above AGENT_MESSAGE_LIMIT (10); otherwise the causal-depth gate
// would fire before the per-sub-task exchange cap it is meant to complement.
  chatMaxDepth: intEnv('CHAT_MAX_CAUSAL_DEPTH', 16),
  chatBodyMaxChars: intEnv('CHAT_BODY_MAX_CHARS', 100_000),
  chatMaxFileBytes: intEnv('CHAT_MAX_FILE_BYTES', 20 * 1024 * 1024),
  // The MCP JSON body limit is 8 MB. Keep one base64 chunk at 1 MB by default
  // (about 1.4 MB of JSON) so multi-chunk uploads never hit that ceiling.
  chatUploadChunkBytes: Math.min(intEnv('CHAT_UPLOAD_CHUNK_BYTES', 1024 * 1024), 1024 * 1024),
  chatReadMaxBytes: intEnv('CHAT_READ_MAX_BYTES', 200_000),
  // A terminal agent status is shown for this long and then collapses to idle.
  chatTerminalStatusTtlMs: intEnv('CHAT_TERMINAL_STATUS_TTL_MS', 60_000),
  executorVision: {
    claude: boolEnv('WORKBENCH_CLAUDE_VISION', true),
    dsh: boolEnv('WORKBENCH_DSH_VISION', false)
  }
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
  const norm = (p) => {
    const resolved = resolve(p).replace(/[\\/]+$/, '');
    // Windows paths are case-insensitive; POSIX paths are not.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

// Return directories that directly contain node_modules.
// Windows: <npm prefix>/node_modules. POSIX: <npm prefix>/lib/node_modules.
// WORKBENCH_NPM_GLOBAL is an npm prefix; on POSIX both <prefix>/node_modules and
// <prefix>/lib/node_modules are probed so a custom layout still resolves.
function npmNodeModulesDirs() {
  const dirs = [];
  const add = (dir, source) => {
    if (!dirs.some((entry) => samePath(entry.dir, dir))) dirs.push({ dir, source });
  };
  if (npmGlobal) {
    add(join(npmGlobal, 'node_modules'), `npm-prefix ${npmGlobal}`);
    if (process.platform !== 'win32') {
      add(join(npmGlobal, 'lib', 'node_modules'), `npm-prefix ${npmGlobal}`);
    }
  }
  if (process.platform === 'win32') {
    add(join(nodePrefix, 'node_modules'), `npm-prefix ${nodePrefix}`);
  } else {
    const prefix = resolve(nodePrefix, '..');
    add(join(prefix, 'lib', 'node_modules'), `npm-prefix ${prefix}`);
  }
  return dirs;
}

export function claudeCommandCandidates() {
  const candidates = [];
  if (process.env.WORKBENCH_CLAUDE_ENTRY) {
    candidates.push({ path: process.env.WORKBENCH_CLAUDE_ENTRY, source: 'WORKBENCH_CLAUDE_ENTRY' });
  }
  if (process.env.WORKBENCH_CLAUDE_BIN) {
    candidates.push({ path: process.env.WORKBENCH_CLAUDE_BIN, source: 'WORKBENCH_CLAUDE_BIN', lookup: true });
  }
  for (const entry of npmNodeModulesDirs()) {
    candidates.push({ path: join(entry.dir, ...CLAUDE_PACKAGE_SEGMENTS), source: entry.source });
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
  for (const entry of npmNodeModulesDirs()) {
    candidates.push({ path: join(entry.dir, ...DSH_PACKAGE_SEGMENTS), source: entry.source, viaNode: true });
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
  console.error(
    'MCP_BEARER_TOKEN is required and must be at least 32 characters long. '
    + `Set it in the engine credential file (${envLoad.path || join(credentialDir(), 'engine.env')}) `
    + 'or in the process environment.'
  );
  process.exit(1);
}

// Deterministic per-executor tokens. No plaintext agent token is persisted;
// the static form is a one-version compatibility path. New tasks receive
// signed, short-lived per-task tokens instead (see auth.issueAgentToken).
config.agentTokens = deriveAgentTokens(config.token);
if (config.allowDerivedPrincipalTokens) {
  // Explicit rollback mode. The derived values are still deterministic, so
  // anyone holding the master can reproduce them; never enable this in normal
  // operation.
  config.humanToken = config.humanToken || deriveHumanToken(config.token);
  config.museToken = config.museToken || deriveMuseToken(config.token);
}
if (!config.humanToken || !config.museToken) {
  const missing = [
    !config.humanToken ? 'MCP_HUMAN_TOKEN' : null,
    !config.museToken ? 'MCP_MUSE_TOKEN' : null
  ].filter(Boolean).join(' and ');
  console.warn(
    `principal tokens are not configured: ${missing} missing. `
    + `Run scripts/install-credentials.mjs (stores independent random values in ${envLoad.path || join(credentialDir(), 'engine.env')}) `
    + 'or set WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1 only for a deliberate rollback.'
  );
}
