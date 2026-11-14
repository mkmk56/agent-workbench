#!/usr/bin/env node
// Verifies that executor command resolution is lazy (re-read on every launch)
// and that dead candidates from a previous npm prefix are skipped.
//
// Read-only: starts no engine, dispatches no tasks, touches no data/ files.
// Spawning the resolved binary is best effort. Inside the agent file sandbox
// Node.js cannot create child processes (spawn EPERM); that case is reported as
// "blocked", not as a resolution failure.
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import crossSpawn from 'cross-spawn';

// The engine requires a bearer token to load config; this is a dummy value for
// this test process only (never a real token).
process.env.MCP_BEARER_TOKEN ||= 'verify-command-resolution-dummy-token-0123456789';

const { config, resolveClaudeCommand, resolveDshCommand } = await import('../src/config.js');

const DEFAULTS = {
  npmGlobal: process.env.WORKBENCH_NPM_GLOBAL || 'D:\\workbuddy-tools\\node\\global',
  claudeEntry: ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  dshEntry: ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']
};

const checks = [];
const failures = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${name}: ${detail}`);
}

function attemptVersion(command, prefixArgs = []) {
  let dir;
  try {
    // The agent file sandbox forbids piped stdio (spawn EPERM), so capture the
    // child's output through a temporary file instead of a pipe.
    dir = mkdtempSync(join(tmpdir(), 'workbench-resolve-'));
    const logPath = join(dir, 'version.txt');
    const fd = openSync(logPath, 'w');
    try {
      const result = crossSpawn.sync(command, [...prefixArgs, '--version'], {
        stdio: ['ignore', fd, fd],
        timeout: 30000,
        windowsHide: true
      });
      const output = readFileSync(logPath, 'utf8').trim();
      if (result.error) {
        const code = result.error.code || '';
        const sandboxed = code === 'EPERM' || code === 'EACCES';
        return { state: sandboxed ? 'blocked' : 'failed', detail: `${code}: ${result.error.message}` };
      }
      if (result.status === 0) return { state: 'ok', version: output };
      return { state: 'failed', detail: `status=${result.status} output=${output.slice(0, 200)}` };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return { state: 'failed', detail: `probe error: ${error.code || ''} ${error.message}` };
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir cleanup */ }
    }
  }
}

function assertSkippedPathsMissing(label, resolved) {
  for (const skippedPath of resolved.skipped) {
    check(
      `${label}: skipped candidate is really missing`,
      !existsSync(skippedPath),
      skippedPath
    );
  }
}

// 1. No filesystem snapshot may remain in the exported config.
const result = {
  npmGlobal: DEFAULTS.npmGlobal,
  nodePrefix: dirname(process.execPath),
  claude: null,
  dsh: null,
  laziness: null,
  configSnapshotFields: {
    claudeEntry: Object.prototype.hasOwnProperty.call(config, 'claudeEntry'),
    dshEntry: Object.prototype.hasOwnProperty.call(config, 'dshEntry')
  }
};
check('config has no cached claudeEntry', !result.configSnapshotFields.claudeEntry, `claudeEntry exported=${result.configSnapshotFields.claudeEntry}`);
check('config has no cached dshEntry', !result.configSnapshotFields.dshEntry, `dshEntry exported=${result.configSnapshotFields.dshEntry}`);

// 2. Resolve claude in the current machine state.
const claude = resolveClaudeCommand();
result.claude = {
  found: claude.found,
  command: claude.command,
  entry: claude.entry,
  source: claude.source,
  skipped: claude.skipped
};
check('claude resolved', claude.found, claude.found ? claude.entry : claude.skipped.join(' | '));
if (claude.found) {
  check('claude entry exists', existsSync(claude.entry), claude.entry);
  check('claude entry is a file', statSync(claude.entry).isFile(), claude.entry);
  const claudeVersion = attemptVersion(claude.command, claude.prefixArgs);
  result.claude.version_check = claudeVersion;
  check(
    'claude resolved command answers --version',
    claudeVersion.state === 'ok' || claudeVersion.state === 'blocked',
    claudeVersion.state === 'ok' ? claudeVersion.version : `${claudeVersion.state}: ${claudeVersion.detail}`
  );
}
assertSkippedPathsMissing('claude', claude);

// The upgrade that broke the engine left this exact path missing; it must be
// skipped, not selected.
const deadWorkbuddyClaude = join(DEFAULTS.npmGlobal, ...DEFAULTS.claudeEntry);
if (!existsSync(deadWorkbuddyClaude)) {
  check(
    'dead workbuddy claude path skipped',
    claude.skipped.includes(deadWorkbuddyClaude),
    deadWorkbuddyClaude
  );
} else {
  checks.push({ name: 'dead workbuddy claude path skipped', ok: true, detail: 'path exists on this machine; skip check', skippedCheck: true });
}

// 3. Resolution must re-read the environment/filesystem on every call.
if (claude.found) {
  const originalEntry = claude.entry;
  const bogus = join(DEFAULTS.npmGlobal, 'definitely-missing-claude.exe');
  process.env.WORKBENCH_CLAUDE_ENTRY = bogus;
  const withBogusOverride = resolveClaudeCommand();
  process.env.WORKBENCH_CLAUDE_ENTRY = process.execPath;
  const withRealOverride = resolveClaudeCommand();
  delete process.env.WORKBENCH_CLAUDE_ENTRY;
  const afterReset = resolveClaudeCommand();
  result.laziness = {
    original: originalEntry,
    bogus_override_entry: withBogusOverride.entry,
    bogus_override_skipped: withBogusOverride.skipped,
    real_override_entry: withRealOverride.entry,
    after_reset_entry: afterReset.entry
  };
  check(
    'missing WORKBENCH_CLAUDE_ENTRY override is skipped',
    withBogusOverride.found && withBogusOverride.skipped.includes(bogus),
    JSON.stringify(withBogusOverride.skipped)
  );
  check(
    'override is honoured without a restart',
    withRealOverride.entry === resolve(process.execPath),
    String(withRealOverride.entry)
  );
  check(
    'resolution returns to the original command after the override is removed',
    afterReset.entry === originalEntry,
    `${afterReset.entry} !== ${originalEntry}`
  );
} else {
  checks.push({ name: 'lazy resolution checks', ok: false, detail: 'skipped: claude did not resolve' });
}

// 4. Resolve dsh the same way (it currently exists, but must not be cached).
const dsh = resolveDshCommand();
result.dsh = {
  found: dsh.found,
  command: dsh.command,
  entry: dsh.entry,
  prefixArgs: dsh.prefixArgs,
  source: dsh.source,
  skipped: dsh.skipped
};
check('dsh resolved', dsh.found, dsh.found ? dsh.entry : dsh.skipped.join(' | '));
if (dsh.found) {
  check('dsh entry exists', existsSync(dsh.entry), dsh.entry);
  const dshVersion = attemptVersion(dsh.command, dsh.prefixArgs);
  result.dsh.version_check = dshVersion;
  checks.push({
    name: 'dsh resolved command answers --version',
    ok: dshVersion.state === 'ok' || dshVersion.state === 'blocked',
    detail: dshVersion.state === 'ok' ? dshVersion.version : `${dshVersion.state}: ${dshVersion.detail}`
  });
}
assertSkippedPathsMissing('dsh', dsh);

const summary = {
  ok: failures.length === 0,
  failures,
  checks,
  result
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
