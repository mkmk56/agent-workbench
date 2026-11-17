#!/usr/bin/env node
/**
 * Syncs the effective engine bearer token into a per-user file the packaged
 * GUI can read. The packaged app cannot see the repository's workbench.env and
 * does not inherit the engine process environment, so the startup chain runs
 * this script before launching the engine.
 *
 * Token sources, in order:
 *   1. process.env.MCP_BEARER_TOKEN (e.g. a Task Scheduler environment variable)
 *   2. <credentials>/engine.env (the post-P0 location, outside the repo)
 *   3. <repo>/workbench.env MCP_BEARER_TOKEN (legacy, migration fallback)
 *
 * The token itself is never printed, logged, or written inside the repository.
 * The GUI keeps using the legacy master token for one compatibility version
 * so task_start/respond_approval keep working; new clients should use the
 * stored MCP_HUMAN_TOKEN (independent random value, never derived from the
 * master) instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = process.env.WORKBENCH_CREDENTIAL_DIR?.trim()
  ? path.resolve(process.env.WORKBENCH_CREDENTIAL_DIR)
  : path.join(
    process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'),
    'agent-workbench',
    'credentials',
  );
const targetFile = path.join(targetDir, 'engine-token');
const engineEnvFile = process.env.WORKBENCH_ENV_FILE?.trim()
  ? path.resolve(process.env.WORKBENCH_ENV_FILE)
  : path.join(targetDir, 'engine.env');

function readEnvFileValue(filePath, key) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match || match[1] !== key) {
      continue;
    }
    return match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

function resolveToken() {
  const fromEnv = process.env.MCP_BEARER_TOKEN?.trim() ?? '';
  if (fromEnv.length > 0) {
    return { token: fromEnv, source: 'environment' };
  }
  const fromCredential = readEnvFileValue(engineEnvFile, 'MCP_BEARER_TOKEN');
  if (fromCredential.length > 0) {
    return { token: fromCredential, source: 'engine.env' };
  }
  const fromFile = readEnvFileValue(path.join(repoRoot, 'workbench.env'), 'MCP_BEARER_TOKEN');
  if (fromFile.length > 0) {
    return { token: fromFile, source: 'workbench.env (legacy)' };
  }
  return { token: null, source: 'none' };
}

/**
 * Best-effort ACL hardening: remove inherited entries and grant only the
 * current user. Failure is non-fatal because the file already lives in the
 * per-user AppData directory.
 */
function hardenPermissions(filePath) {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const output = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sid = /"(S-\d+(?:-\d+)+)"/.exec(output)?.[1];
    if (!sid) {
      return;
    }
    execFileSync(path.join(system32, 'icacls.exe'), [
      filePath,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:F`,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // Permission hardening is best effort.
  }
}

const { token, source } = resolveToken();
if (token == null) {
  console.log('[token-sync] no MCP_BEARER_TOKEN found; leaving GUI token file unchanged');
  process.exit(0);
}

try {
  fs.mkdirSync(targetDir, { recursive: true });
  let current = '';
  try {
    current = fs.readFileSync(targetFile, 'utf8').trim();
  } catch {
    // The target does not exist yet.
  }
  if (current === token) {
    hardenPermissions(targetFile);
    console.log('[token-sync] GUI token file already up to date');
    process.exit(0);
  }
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, targetFile);
  try {
    fs.chmodSync(targetFile, 0o600);
  } catch {
    // Windows does not implement POSIX modes.
  }
  hardenPermissions(targetFile);
  console.log(`[token-sync] wrote GUI token file (source=${source})`);
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
  console.error(`[token-sync] failed to write GUI token file (code=${code})`);
  process.exitCode = 0;
}