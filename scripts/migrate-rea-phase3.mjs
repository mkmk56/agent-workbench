#!/usr/bin/env node
// REA Phase 3 database migration.
//
// Adds the four tables from PHASE3_DESIGN.md §11 through the Store constructor
// (which registers schema_version 6):
//   wake_events, listener_sessions, checkins, agent_wake
// The constructor also creates the internal app_meta persistent counter table
// and, since the P1/P2/P3 leftovers fix, wake_unread_notices (persisted
// unread-@ reminder dedupe). Neither is part of the phase 3 surface and neither
// is listed in `tables`.
//
// The database is snapshotted first with VACUUM INTO, which is consistent even
// while the engine is running in WAL mode. Creating the tables is guarded by
// CREATE TABLE IF NOT EXISTS and the version ledger, so re-running is safe and
// never resets switches, failure counters, cursors or check-in state.
//
// The production database is NOT touched by the implementation pass: Muse runs
// this script once against data/workbench.db during Phase 3 acceptance.
//
// Usage:
//   node scripts/migrate-rea-phase3.mjs
//   node scripts/migrate-rea-phase3.mjs --db data/workbench.db --backup-dir data/backups
//   node scripts/migrate-rea-phase3.mjs --no-backup

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TABLES = ['wake_events', 'listener_sessions', 'checkins', 'agent_wake'];

function parseArgs(argv) {
  const args = { backup: true, dbPath: null, backupDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-backup') args.backup = false;
    else if (arg === '--db') args.dbPath = argv[++i];
    else if (arg === '--backup-dir') args.backupDir = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function defaultDbPath() {
  return resolve(root, process.env.MCP_DB_PATH
    || join(process.env.MCP_DATA_DIR || 'data', 'workbench.db'));
}

function snapshot(dbPath, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `${basename(dbPath)}.pre-rea-phase3-${stamp}.bak`);
  const escaped = target.replace(/'/g, "''");
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    raw.close();
  }
  return target;
}

/**
 * Run the migration. Exported so tests can drive it against a temporary
 * database; the CLI entry point below is a thin wrapper.
 */
export function runMigration({
  dbPath = defaultDbPath(),
  dataDir = null,
  backupDir = null,
  backup = true,
  log = () => {}
} = {}) {
  const resolvedDb = resolve(dbPath);
  const resolvedDataDir = dataDir ? resolve(dataDir) : dirname(resolvedDb);
  const resolvedBackupDir = backupDir ? resolve(backupDir) : join(resolvedDataDir, 'backups');

  let backupPath = null;
  if (backup) {
    backupPath = snapshot(resolvedDb, resolvedBackupDir);
    log(`backup: ${backupPath}`);
  }

  const store = new Store(resolvedDb, resolvedDataDir);
  try {
    const present = store.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`
    ).all(...TABLES).map((row) => row.name).sort();
    const missing = TABLES.filter((table) => !present.includes(table));
    if (missing.length > 0) {
      throw new Error(`phase 3 tables missing after migration: ${missing.join(', ')}`);
    }
    const result = {
      db_path: resolvedDb,
      backup_path: backupPath,
      schema_version: store.schemaVersion(),
      tables: present,
      counts: {
        wake_events: Number(store.db.prepare('SELECT COUNT(*) AS n FROM wake_events').get().n),
        listener_sessions: Number(store.db.prepare('SELECT COUNT(*) AS n FROM listener_sessions').get().n),
        checkins: Number(store.db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n),
        agent_wake: Number(store.db.prepare('SELECT COUNT(*) AS n FROM agent_wake').get().n)
      }
    };
    log(`schema_version: ${result.schema_version}`);
    log(`tables: ${result.tables.join(', ')}`);
    log(`counts: ${JSON.stringify(result.counts)}`);
    return result;
  } finally {
    store.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/migrate-rea-phase3.mjs [--db PATH] [--backup-dir DIR] [--no-backup]');
    return;
  }
  const result = runMigration({
    dbPath: args.dbPath || defaultDbPath(),
    backupDir: args.backupDir,
    backup: args.backup,
    log: (line) => console.log(line)
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}