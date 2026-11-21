#!/usr/bin/env node
// REA Phase 5 database migration (schema v7 -> v8).
//
// Creates the four community tables through the Store constructor, which
// registers schema_version 8:
//   group_invites        invite code hashes, TTL, uses, revocation
//   join_requests        pending/approved/declined membership applications
//   join_request_notices owner/admin/applicant notifications
//   invite_attempts      invalid-code attempt accounting (rate limiting)
//
// All time columns are TEXT ISO strings (same clock as Store._now()). No
// existing table or row is rewritten; rollback is either restoring the
// snapshot or dropping the four new tables (the ledger inverse).
//
// The production database is NOT touched by the implementation pass: Muse runs
// this script once against data/workbench.db during Phase 5 acceptance.
//
// Usage:
//   node scripts/migrate-rea-phase5.mjs
//   node scripts/migrate-rea-phase5.mjs --db data/workbench.db --backup-dir data/backups
//   node scripts/migrate-rea-phase5.mjs --no-backup

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TABLES = {
  group_invites: [
    'id', 'chat_id', 'code_hash', 'created_by', 'max_uses', 'uses', 'last_used_at',
    'expires_at', 'revoked_at', 'created_at'
  ],
  join_requests: [
    'id', 'chat_id', 'applicant_id', 'invite_id', 'message', 'status', 'decision_reason',
    'created_at', 'updated_at', 'decided_by', 'decided_at'
  ],
  join_request_notices: [
    'id', 'chat_id', 'request_id', 'notice_type', 'recipient_id', 'created_at', 'read_at'
  ],
  invite_attempts: [
    'id', 'chat_id', 'principal_id', 'code_hash_prefix', 'created_at', 'success'
  ]
};
const TIME_COLUMNS = [
  ['group_invites', ['last_used_at', 'expires_at', 'revoked_at', 'created_at']],
  ['join_requests', ['created_at', 'updated_at', 'decided_at']],
  ['join_request_notices', ['created_at', 'read_at']],
  ['invite_attempts', ['created_at']]
];

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
  const target = join(backupDir, `${basename(dbPath)}.pre-rea-phase5-${stamp}.bak`);
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
 * database; the CLI entry point below is a thin wrapper. Idempotent: the Store
 * constructor only registers v8 once.
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
    for (const [table, expected] of Object.entries(TABLES)) {
      const present = store.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      const missing = expected.filter((column) => !present.includes(column));
      if (missing.length > 0) {
        throw new Error(`phase 5 columns missing after migration: ${table}.${missing.join(', ')}`);
      }
      columns[table] = expected;
    }
    // A partial/older database must not silently get INTEGER timestamps: every
    // time column is declared TEXT by the constructor DDL.
    const timeTypes = {};
    for (const [table, names] of TIME_COLUMNS) {
      const info = store.db.prepare(`PRAGMA table_info(${table})`).all();
      for (const name of names) {
        const type = String(info.find((column) => column.name === name)?.type ?? '').toUpperCase();
        if (type !== 'TEXT') {
          throw new Error(`phase 5 time column is not TEXT: ${table}.${name} (${type})`);
        }
      }
      timeTypes[table] = names;
    }
    const result = {
      db_path: resolvedDb,
      backup_path: backupPath,
      schema_version: store.schemaVersion(),
      tables: Object.keys(TABLES),
      columns,
      time_types: timeTypes,
      counts: {
        messages: Number(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n),
        chats: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chats').get().n),
        group_invites: Number(store.db.prepare('SELECT COUNT(*) AS n FROM group_invites').get().n),
        join_requests: Number(store.db.prepare('SELECT COUNT(*) AS n FROM join_requests').get().n)
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
    console.log('node scripts/migrate-rea-phase5.mjs [--db PATH] [--backup-dir DIR] [--no-backup]');
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