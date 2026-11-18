import { execFile } from 'node:child_process';
import crossSpawn from 'cross-spawn';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

// Executors only receive what they need to run. The engine environment holds
// the master/human/Muse tokens, database paths and credential locations; none
// of it may leak into an agent process.
//
// The user-profile variables are deliberately absent: with APPDATA /
// LOCALAPPDATA / USERPROFILE / HOMEDRIVE / HOMEPATH / USERNAME inherited, an
// executor can deterministically rebuild
// %APPDATA%\agent-workbench\credentials\engine.env and read the master token.
// APPDATA and LOCALAPPDATA are actually removed. USERPROFILE/HOMEDRIVE/
// HOMEPATH/USERNAME are re-synthesized by Node for its own child processes
// even when omitted (verified on Windows), so this is defence in depth, not a
// hard boundary. The primary control is that human/Muse are independent
// secrets, so a leaked master no longer yields the Muse dispatch capability.
const BASE_ENV_KEYS_WIN = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'CLAUDE_CONFIG_DIR'
];
const BASE_ENV_KEYS_POSIX = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TERM', 'TZ', 'CLAUDE_CONFIG_DIR'
];

// Never inherited from the engine, and removed even if a caller passes one by
// mistake. Per-task MCP credentials are injected deliberately by executors.
const BLOCKED_ENV_KEYS = new Set([
  'MCP_BEARER_TOKEN', 'MCP_HUMAN_TOKEN', 'MCP_MUSE_TOKEN',
  'MCP_DATA_DIR', 'MCP_DB_PATH', 'MCP_LOG_DIR',
  'WORKBENCH_ENV_FILE', 'WORKBENCH_CLAUDE_ENV_JSON'
]);

// Set by the engine to a dedicated temp directory outside the executor
// workspace. Inherited TEMP/TMP normally point inside %LOCALAPPDATA%\Temp,
// which reveals the profile path even when LOCALAPPDATA itself is removed from
// the allow-list. Keeping the redirect outside the workspace also satisfies
// the Windows ACL sandbox precondition (temp root must be outside the
// workspace root); a nested path makes every dsh command fail closed.
let executorTempDir = null;

export function setExecutorTempDir(dir) {
  executorTempDir = dir ? String(dir) : null;
}

// Append a directory to a PATH-style value once (case-insensitive
// dedup, so repeated restarts never stack the same entry).
export function appendPathOnce(pathValue, dir) {
  const parts = String(pathValue || '').split(';').filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === String(dir).toLowerCase())) parts.push(dir);
  return parts.join(';');
}

export function buildExecutorEnv(extra = {}) {
  const keys = process.platform === 'win32' ? BASE_ENV_KEYS_WIN : BASE_ENV_KEYS_POSIX;
  const env = {};
  for (const key of keys) {
    if (process.platform === 'win32' && executorTempDir && (key === 'TEMP' || key === 'TMP')) {
      env[key] = executorTempDir;
      continue;
    }
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;
    if (BLOCKED_ENV_KEYS.has(key)) continue;
    env[key] = String(value);
  }
  return env;
}

export function spawnProcess({ command, prefixArgs = [], args, cwd, env, onLine, onExit }) {
  let exited = false;
  let outBuf = '';
  let errBuf = '';

  const emitLines = (stream, chunk) => {
    const clean = stripAnsi(chunk);
    const prev = stream === 'stderr' ? errBuf : outBuf;
    const parts = (prev + clean).split(/\r?\n/);
    const rest = parts.pop() ?? '';
    if (stream === 'stderr') errBuf = rest; else outBuf = rest;
    for (const line of parts) onLine(stream, line);
  };

  // Explicit allow-list, never a copy of process.env. The old behaviour let
  // executors read the master bearer token and impersonate user/Muse.
  const childEnv = buildExecutorEnv(env);

  const child = crossSpawn(command, [...prefixArgs, ...args], {
    cwd,
    windowsHide: true,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (d) => emitLines('stdout', d));
  child.stderr.on('data', (d) => emitLines('stderr', d));

  const finish = (info) => {
    if (exited) return;
    exited = true;
    if (outBuf) onLine('stdout', outBuf);
    if (errBuf) onLine('stderr', errBuf);
    outBuf = '';
    errBuf = '';
    onExit(info);
  };

  child.on('exit', (code, signal) => finish({ code, signal, pid: child.pid }));
  child.on('error', (error) => finish({ code: null, signal: null, pid: child.pid, error }));

  return child;
}

export function killTree(pid, done) {
  if (!pid) {
    done?.();
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done?.());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  done?.();
}