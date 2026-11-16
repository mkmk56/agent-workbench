#!/usr/bin/env node
// Upgrade a COPY of a real database and verify that no rows are lost.
// The production engine and its database are never opened for writing.
//
// Usage: node scripts/verify-db-copy.mjs [path/to/workbench.db]

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

const source = resolve(process.argv[2] || 'data/workbench.db');
if (!existsSync(source)) {
  console.error(`database not found: ${source}`);
  process.exit(2);
}

const temp = mkdtempSync(join(tmpdir(), 'aw-migration-copy-'));
const copy = join(temp, 'workbench.db');
const counts = (db, tables) => {
  const out = {};
  for (const table of tables) {
    try {
      out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    } catch {
      out[table] = null;
    }
  }
  return out;
};

function openCopy() {
  copyFileSync(source, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${copy}${suffix}`);
  }
}

const result = { ok: false, source, copy, before: null, after: null, checks: {}, errors: [] };
try {
  openCopy();
  const tables = ['messages', 'chats', 'chat_tasks', 'tasks', 'approvals', 'approval_grants'];
  let raw = new DatabaseSync(copy);
  result.before = counts(raw, tables);
  const columnsBefore = raw.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  raw.close();

  const store = new Store(copy, temp);
  try {
    result.after = counts(store.db, tables);
    const columnsAfter = store.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    const indexes = store.db.prepare('PRAGMA index_list(messages)').all().map((i) => i.name);
    const chatColumns = store.db.prepare('PRAGMA table_info(chats)').all().map((c) => c.name);

    result.checks = {
      row_counts_preserved: Object.fromEntries(
        tables.map((table) => [table, result.before[table] === result.after[table]])
      ),
      new_message_columns: [
        'seq', 'body', 'mentions_json', 'root_message_id', 'depth', 'epoch', 'client_msg_id', 'context_version'
      ].every((column) => columnsAfter.includes(column)),
      had_chat_id_before: columnsBefore.includes('chat_id'),
      reply_unique_index_dropped: !indexes.includes('idx_messages_reply_unique'),
      chat_epoch_column: chatColumns.includes('epoch'),
      participants_table: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chat_participants').get().n) >= 0,
      files_table: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chat_files').get().n) >= 0,
      deliveries_table: Number(store.db.prepare('SELECT COUNT(*) AS n FROM chat_deliveries').get().n) >= 0
    };
    result.ok = Object.values(result.checks).every((value) => value === true
      || (typeof value === 'object' && Object.values(value).every(Boolean)));
  } finally {
    store.close();
  }
} catch (error) {
  result.errors.push(error.stack || error.message);
} finally {
  console.log(JSON.stringify(result, null, 2));
  rmSync(temp, { recursive: true, force: true });
  if (!result.ok) process.exitCode = 1;
}