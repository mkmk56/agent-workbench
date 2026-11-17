#!/usr/bin/env node
/**
 * Print the human or Muse bearer token for a client (GUI/Muse) to configure.
 *
 * These tokens are derived from MCP_BEARER_TOKEN unless MCP_HUMAN_TOKEN /
 * MCP_MUSE_TOKEN are set explicitly. This script is for the operator's
 * terminal only; it never writes the value to disk or logs.
 *
 * Usage: node scripts/show-principal-token.mjs human|muse --yes
 */
import { deriveHumanToken, deriveMuseToken } from '../src/auth.js';
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

const path = engineEnvPath();
const master = process.env.MCP_BEARER_TOKEN
  || readEnvValue(path, 'MCP_BEARER_TOKEN');

if (!master) {
  console.error('MCP_BEARER_TOKEN is not set and was not found in the engine credential file.');
  process.exit(1);
}

const explicit = kind === 'human' ? process.env.MCP_HUMAN_TOKEN : process.env.MCP_MUSE_TOKEN;
const token = explicit || (kind === 'human' ? deriveHumanToken(master) : deriveMuseToken(master));
process.stdout.write(`${token}\n`);