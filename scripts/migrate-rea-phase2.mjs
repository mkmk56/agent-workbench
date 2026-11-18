#!/usr/bin/env node
// REA Phase 2 database migration.
//
// Adds the Phase 2 tables/columns through the Store constructor (idempotent,
// registered as schema_version 5) and then backfills:
//   - the three built-in identities (muse/claude/dsh)
//   - chat_members for every existing chat participant
//   - inbox_cursors for every member, last_read_seq = the chat's current max seq
//
// The database is snapshotted first with VACUUM INTO, which is consistent even
// while the engine is running in WAL mode. Re-running is safe: INSERT OR IGNORE
// keeps an existing cursor's progress.
//
// Usage:
//   node scripts/migrate-rea-phase2.mjs
//   node scripts/migrate-rea-phase2.mjs --db data/workbench.db --backup-dir data/backups
//   node scripts/migrate-rea-phase2.mjs --no-backup
//   node scripts/migrate-rea-phase2.mjs --read-to participant   (start at the legacy cursor)

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { AgentService } from '../src/agents.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const args = { backup: true, readToMax: true, dbPath: null, backupDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-backup') args.backup = false;
    else if (arg === '--db') args.dbPath = argv[++i];
    else if (arg === '--backup-dir') args.backupDir = argv[++i];
    else if (arg === '--read-to') args.readToMax = argv[++i] !== 'participant';
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
  const target = join(backupDir, `${basename(dbPath)}.pre-rea-phase2-${stamp}.bak`);
  const escaped = target.replace(/'/g, "''");
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    // Consistent snapshot including committed WAL pages.
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
  readToMax = true,
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
    const agents = new AgentService({ store, config: {} });
    const summary = agents.reconcile({ readToMax });
    const tables = ['agents', 'chat_members', 'inbox_cursors', 'pairing_codes', 'pairing_code_uses'];
    const present = store.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => '?').join(', ')})`
    ).all(...tables).map((row) => row.name).sort();
    const result = {
      db_path: resolvedDb,
      backup_path: backupPath,
      schema_version: store.schemaVersion(),
      tables: present,
      agents: summary,
      counts: {
        agents: Number(store.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n),
        chat_members: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chat_members').get().n),
        inbox_cursors: Number(store.db.prepare('SELECT COUNT(*) AS n FROM inbox_cursors').get().n)
      }
    };
    log(`schema_version: ${result.schema_version}`);
    log(`agents: ${result.counts.agents}, chat_members: ${result.counts.chat_members}, `
      + `inbox_cursors: ${result.counts.inbox_cursors}`);
    log(`reconcile: ${JSON.stringify(summary)}`);
    return result;
  } finally {
    store.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/migrate-rea-phase2.mjs [--db PATH] [--backup-dir DIR] '
      + '[--no-backup] [--read-to max|participant]');
    return;
  }
  const result = runMigration({
    dbPath: args.dbPath || defaultDbPath(),
    backupDir: args.backupDir,
    backup: args.backup,
    readToMax: args.readToMax,
    log: (line) => console.log(line)
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}