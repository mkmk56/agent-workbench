#!/usr/bin/env node
/**
 * Move engine credentials out of the repository.
 *
 * The P0 identity fix requires that executors cannot read the master token
 * from <repo>/workbench.env. This script copies that file (or the current
 * process environment) to the per-user credential directory with a restricted
 * ACL, then optionally removes the repository copy.
 *
 * Usage:
 *   node scripts/install-credentials.mjs                 # write/refresh engine.env
 *   node scripts/install-credentials.mjs --if-missing    # only when engine.env is absent
 *   node scripts/install-credentials.mjs --remove-legacy # also delete <repo>/workbench.env
 *
 * Token values are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialDir, engineEnvPath, parseEnvText } from '../src/credentials.js';
import { hardenPath } from '../src/security.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyPath = path.join(repoRoot, 'workbench.env');
const targetDir = credentialDir();
const targetPath = engineEnvPath();
const args = new Set(process.argv.slice(2));
const ifMissing = args.has('--if-missing');
const removeLegacy = args.has('--remove-legacy');

function readFileValues(file) {
  try {
    return parseEnvText(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeRestricted(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  hardenPath(path.dirname(file), { directory: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  hardenPath(tmp);
  fs.renameSync(tmp, file);
  hardenPath(file);
}

const current = readFileValues(targetPath);
const legacy = readFileValues(legacyPath);
const fromEnv = {
  MCP_BEARER_TOKEN: process.env.MCP_BEARER_TOKEN,
  MCP_HUMAN_TOKEN: process.env.MCP_HUMAN_TOKEN,
  MCP_MUSE_TOKEN: process.env.MCP_MUSE_TOKEN,
  MCP_PORT: process.env.MCP_PORT,
  MAX_PARALLEL_TASKS: process.env.MAX_PARALLEL_TASKS,
  WORKBENCH_DSH_MAX_PARALLEL_TASKS: process.env.WORKBENCH_DSH_MAX_PARALLEL_TASKS
};
for (const [key, value] of Object.entries(fromEnv)) {
  if (value !== undefined && value !== '') legacy[key] = value;
}

if (ifMissing && Object.keys(current).length > 0) {
  hardenPath(targetPath);
  console.log(`[credentials] engine.env already present: ${targetPath}`);
  process.exit(0);
}

const merged = { ...current, ...legacy };
if (!merged.MCP_BEARER_TOKEN) {
  console.error('[credentials] no MCP_BEARER_TOKEN found in the environment or the legacy workbench.env');
  process.exit(1);
}

const lines = Object.entries(merged)
  .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
  .map(([key, value]) => `${key}=${value}`);
writeRestricted(targetPath, `${lines.join('\n')}\n`);
console.log(`[credentials] wrote ${targetPath} (keys=${Object.keys(merged).length})`);

if (removeLegacy && fs.existsSync(legacyPath)) {
  fs.rmSync(legacyPath, { force: true });
  console.log(`[credentials] removed legacy repository file ${legacyPath}`);
}