#!/usr/bin/env node
// REA Phase 4 database migration (schema v6 -> v7).
//
// Adds two purely additive columns through the Store constructor, which
// registers schema_version 7:
//   messages.kind      TEXT NOT NULL DEFAULT 'user'  (user | system)
//   chats.settings     TEXT                          (JSON {description, announcement})
//
// No existing column is rewritten, so rollback is either restoring the
// snapshot or dropping the two columns. The database is snapshotted first with
// VACUUM INTO, which is consistent even while the engine is running in WAL
// mode. ALTER TABLE is guarded by a column check and the version ledger, so
// re-running never touches data (messages, chats, wake state all survive).
//
// The production database is NOT touched by the implementation pass: Muse runs
// this script once against data/workbench.db during Phase 4 acceptance.
//
// Usage:
//   node scripts/migrate-rea-phase4.mjs
//   node scripts/migrate-rea-phase4.mjs --db data/workbench.db --backup-dir data/backups
//   node scripts/migrate-rea-phase4.mjs --no-backup

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const COLUMNS = {
  messages: ['kind'],
  chats: ['settings']
};

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
  const target = join(backupDir, `${basename(dbPath)}.pre-rea-phase4-${stamp}.bak`);
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
    const columns = {};
    for (const [table, expected] of Object.entries(COLUMNS)) {
      const present = store.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const missing = expected.filter((column) => !present.includes(column));
      if (missing.length > 0) {
        throw new Error(`phase 4 columns missing after migration: ${table}.${missing.join(', ')}`);
      }
      columns[table] = expected;
    }
    const result = {
      db_path: resolvedDb,
      backup_path: backupPath,
      schema_version: store.schemaVersion(),
      columns,
      counts: {
        messages: Number(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n),
        chats: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chats').get().n)
      }
    };
    log(`schema_version: ${result.schema_version}`);
    log(`columns: ${JSON.stringify(result.columns)}`);
    log(`counts: ${JSON.stringify(result.counts)}`);
    return result;
  } finally {
    store.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/migrate-rea-phase4.mjs [--db PATH] [--backup-dir DIR] [--no-backup]');
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