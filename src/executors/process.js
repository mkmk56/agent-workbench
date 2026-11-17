import { execFile } from 'node:child_process';
import crossSpawn from 'cross-spawn';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
}

// Executors only receive what they need to run. The engine environment holds
// the master/human/Muse tokens, database paths and credential locations; none
// of it may leak into an agent process.
const BASE_ENV_KEYS_WIN = [
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'PATH',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
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

export function buildExecutorEnv(extra = {}) {
  const keys = process.platform === 'win32' ? BASE_ENV_KEYS_WIN : BASE_ENV_KEYS_POSIX;
  const env = {};
  for (const key of keys) {
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