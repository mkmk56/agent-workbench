import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The engine bearer token used to live in <repo>/workbench.env. Executors were
// spawned with the repo as their working directory and inherited the engine
// environment, so a local agent could read the master token and impersonate
// the user/Muse (see docs/ARCHITECTURE_AUDIT.md §1.3).
//
// The credential file now lives outside the repository in a per-user directory.
// It is loaded before config.js reads process.env, so `npm start` and the
// legacy start-workbench.cmd keep working without an --env-file flag.
const DEFAULT_DIR_NAME = 'agent-workbench';
const DEFAULT_ENV_NAME = 'engine.env';

export function credentialDir() {
  if (process.env.WORKBENCH_CREDENTIAL_DIR) {
    return resolve(process.env.WORKBENCH_CREDENTIAL_DIR);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming');
    return join(appData, DEFAULT_DIR_NAME, 'credentials');
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, DEFAULT_DIR_NAME, 'credentials');
}

export function engineEnvPath() {
  return resolve(process.env.WORKBENCH_ENV_FILE || join(credentialDir(), DEFAULT_ENV_NAME));
}

export function parseEnvText(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return values;
}

export function readEnvFile(path) {
  try {
    return parseEnvText(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function readEnvValue(path, key) {
  return readEnvFile(path)[key] ?? '';
}

// Load the credential env without overriding variables the caller already set.
// `legacyPaths` is only used before the one-time migration: a repo-root
// workbench.env is still accepted (with a warning) so an existing installation
// can start once and run scripts/install-credentials.mjs.
export function loadEngineEnv({ legacyPaths = [] } = {}) {
  const explicit = process.env.WORKBENCH_ENV_FILE;
  const path = engineEnvPath();
  if (existsSync(path)) {
    applyEnv(readEnvFile(path));
    return { path, loaded: true, legacy: false };
  }
  if (!explicit) {
    for (const legacy of legacyPaths) {
      if (!legacy || !existsSync(legacy)) continue;
      applyEnv(readEnvFile(legacy));
      return { path: legacy, loaded: true, legacy: true };
    }
  }
  return { path: null, loaded: false, legacy: false };
}

function applyEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}