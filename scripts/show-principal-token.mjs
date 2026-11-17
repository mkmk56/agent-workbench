#!/usr/bin/env node
/**
 * Print the human or Muse bearer token for a client (GUI/Muse) to configure.
 *
 * Both tokens are independent random secrets stored in the engine credential
 * file (or the process environment). They are never derived from the master
 * token: reading the master must not yield Muse dispatch or human
 * impersonation. If a token is missing, run scripts/install-credentials.mjs.
 *
 * This script is for the operator's terminal only; it never writes the value
 * to disk or logs.
 *
 * Usage: node scripts/show-principal-token.mjs human|muse --yes
 */
import { engineEnvPath, readEnvValue } from '../src/credentials.js';

const kind = process.argv[2];
const confirmed = process.argv.includes('--yes');
if (kind !== 'human' && kind !== 'muse') {
  console.error('usage: node scripts/show-principal-token.mjs human|muse --yes');
  process.exit(1);
}
if (!confirmed) {
  console.error('Refusing to print a bearer token without --yes.');
  process.exit(1);
}

const key = kind === 'human' ? 'MCP_HUMAN_TOKEN' : 'MCP_MUSE_TOKEN';
const path = engineEnvPath();
const token = process.env[key] || readEnvValue(path, key);

if (!token) {
  console.error(
    `${key} is not configured in the environment or ${path}.\n`
    + 'Run scripts/install-credentials.mjs to generate an independent token.'
  );
  process.exit(1);
}

process.stdout.write(`${token}\n`);
