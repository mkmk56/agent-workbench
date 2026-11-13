import { execFile } from 'node:child_process';
import crossSpawn from 'cross-spawn';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI, '');
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

  // Executor processes inherit the server environment on purpose: the claude
  // executor needs it to reach the local MCP endpoint, and agents may rely on
  // WORKBENCH_* configuration. Do not strip MCP_* / WORKBENCH_* here.
  const childEnv = { ...process.env };
  Object.assign(childEnv, env || {});

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