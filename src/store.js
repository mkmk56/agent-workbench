import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MESSAGE_COLUMNS = [
  'id', 'thread_id', 'from_agent', 'to_agent', 'task_id', 'reply_to', 'summary', 'files_json',
  'question', 'summary_tokens', 'summary_truncated', 'status', 'delivery_task_id', 'error',
  'is_final', 'created_at', 'updated_at', 'chat_id',
  // Group-chat upgrade columns. summary stays as a truncated preview; body is
  // the full message text.
  'seq', 'body', 'mentions_json', 'root_message_id', 'depth', 'epoch', 'client_msg_id',
  'context_version',
  // Provenance: who sent this, which authenticated principal, which request.
  'auth_kind', 'principal_id', 'request_id'
];

const MESSAGE_DEFAULTS = Object.freeze({
  summary_tokens: 0,
  summary_truncated: 0,
  is_final: 0,
  depth: 0,
  epoch: 0,
  context_version: 0,
  status: 'stored'
});

// Shared DDL for the messages table. task_id is intentionally nullable so a
// Muse coordination message belongs to a chat without pretending to be a task.
const MESSAGES_DDL = `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        task_id TEXT,
        reply_to TEXT,
        summary TEXT NOT NULL,
        files_json TEXT,
        question TEXT,
        summary_tokens INTEGER NOT NULL DEFAULT 0,
        summary_truncated INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        delivery_task_id TEXT,
        error TEXT,
        is_final INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        chat_id TEXT,
        seq INTEGER,
        body TEXT,
        mentions_json TEXT,
        root_message_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL DEFAULT 0,
        client_msg_id TEXT,
        context_version INTEGER NOT NULL DEFAULT 0,
        auth_kind TEXT,
        principal_id TEXT,
        request_id TEXT
      )`;

const TASK_COLUMNS = [
  'id', 'session_id', 'agent', 'cwd', 'prompt', 'state', 'process_state', 'turn_state',
  'blocker', 'created_at', 'updated_at', 'last_activity_at', 'exit_code', 'pid',
  'tokens_json', 'files_modified_json', 'summary', 'timeout_ms', 'stale_after_ms',
  'resume', 'model'
];

const UPDATABLE = new Set(TASK_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at'));

const CHAT_FILE_COLUMNS = [
  'file_id', 'chat_id', 'uploader_id', 'original_name', 'stored_path', 'mime', 'size',
  'sha256', 'parse_status', 'parse_error', 'extracted_path', 'created_at'
];

export class Store {
  constructor(dbPath, dataDir) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        cwd TEXT,
        prompt TEXT,
        state TEXT NOT NULL,
        process_state TEXT NOT NULL,
        turn_state TEXT NOT NULL,
        blocker TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT,
        exit_code INTEGER,
        pid INTEGER,
        tokens_json TEXT,
        files_modified_json TEXT,
        summary TEXT,
        timeout_ms INTEGER,
        stale_after_ms INTEGER,
        resume INTEGER DEFAULT 0,
        model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
      CREATE TABLE IF NOT EXISTS logs (
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        stream TEXT NOT NULL,
        line TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        ts TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        root_task_id TEXT,
        state TEXT NOT NULL DEFAULT 'ACTIVE',
        exchange_count INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_threads (
        task_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        origin_message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_threads_thread ON task_threads(thread_id);
      ${MESSAGES_DDL};
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        command TEXT,
        files_json TEXT,
        reason TEXT NOT NULL,
        message_id TEXT NOT NULL,
        response_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        responded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      -- Scoped grants: scope is a chat_id, or 'thread:<id>' for legacy
      -- non-chat tasks; agent is '' for legacy thread-scoped grants.
      CREATE TABLE IF NOT EXISTS approval_grants (
        scope TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL,
        source_approval_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, agent, category)
      );
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        status TEXT DEFAULT 'active',
        last_message_at TEXT,
        last_message_preview TEXT,
        epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_tasks (
        chat_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (chat_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_tasks_task ON chat_tasks(task_id);
      CREATE TABLE IF NOT EXISTS chat_participants (
        chat_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'agent',
        role TEXT NOT NULL DEFAULT 'agent',
        display_name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        auto_participate INTEGER NOT NULL DEFAULT 1,
        joined_at TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, participant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_participants_participant
        ON chat_participants(participant_id, chat_id);
      CREATE TABLE IF NOT EXISTS chat_files (
        file_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        uploader_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        parse_error TEXT,
        extracted_path TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_files_chat ON chat_files(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS message_files (
        message_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id);
      CREATE TABLE IF NOT EXISTS chat_deliveries (
        message_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'visible',
        task_id TEXT,
        error TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, agent)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_deliveries_status ON chat_deliveries(status, updated_at);
      -- Append-only delivery attempt history. chat_deliveries keeps the current
      -- state; this table answers "how many times, when, and why did it fail".
      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_attempts_message
        ON delivery_attempts(message_id, agent, id);
      -- Muse presence/lease. The coordinator is an external process; this row
      -- is refreshed by its polling calls and expires when it goes away.
      CREATE TABLE IF NOT EXISTS muse_presence (
        principal_id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        source TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateMessagesForChats();
    this.migrateGroupChat();
    this.taskSeq = new Map();
    this.sessionSeq = new Map();
  }

  _transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  _columns(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  }

  _addColumnIfMissing(table, column, ddl) {
    if (!this._columns(table).includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Chat migration
  //
  // Old databases were created with messages.task_id NOT NULL, which cannot be
  // relaxed with ALTER TABLE. Rebuild the table once, preserving every row, and
  // add chat_id. Both steps are guarded so a fresh or already-migrated database
  // is untouched. Indexes are recreated because dropping a table drops them.
  // ---------------------------------------------------------------------------
  migrateMessagesForChats() {
    const info = this.db.prepare('PRAGMA table_info(messages)').all();
    if (info.length === 0) return;
    const taskColumn = info.find((column) => column.name === 'task_id');
    const needsRebuild = taskColumn && Number(taskColumn.notnull) === 1;

    if (needsRebuild) {
      const existing = info.map((column) => column.name);
      const copied = MESSAGE_COLUMNS.filter((column) => existing.includes(column));
      this.db.exec(`
        BEGIN;
        CREATE TABLE messages_chat_migration (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          task_id TEXT,
          reply_to TEXT,
          summary TEXT NOT NULL,
          files_json TEXT,
          question TEXT,
          summary_tokens INTEGER NOT NULL DEFAULT 0,
          summary_truncated INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          delivery_task_id TEXT,
          error TEXT,
          is_final INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          chat_id TEXT,
          seq INTEGER,
          body TEXT,
          mentions_json TEXT,
          root_message_id TEXT,
          depth INTEGER NOT NULL DEFAULT 0,
          epoch INTEGER NOT NULL DEFAULT 0,
          client_msg_id TEXT,
          context_version INTEGER NOT NULL DEFAULT 0,
          auth_kind TEXT,
          principal_id TEXT,
          request_id TEXT
        );
        INSERT INTO messages_chat_migration (${copied.join(', ')})
          SELECT ${copied.join(', ')} FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_chat_migration RENAME TO messages;
        COMMIT;
      `);
    }

    const columnsAfter = this._columns('messages');
    if (!columnsAfter.includes('chat_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN chat_id TEXT');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
    `);

    // Historical rows that were produced by a task already linked to a chat
    // (chat_tasks is the only task -> chat mapping) get their chat_id backfilled.
    this.db.exec(`
      UPDATE messages
         SET chat_id = (SELECT ct.chat_id FROM chat_tasks ct WHERE ct.task_id = messages.task_id LIMIT 1)
       WHERE chat_id IS NULL
         AND task_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM chat_tasks ct WHERE ct.task_id = messages.task_id)
    `);
  }

  // Group-chat upgrade migration: new message columns, chat epoch, participant
  // backfill and the scoped approval-grant table. Safe to run on every start.
  migrateGroupChat() {
    this._addColumnIfMissing('messages', 'seq', 'INTEGER');
    this._addColumnIfMissing('messages', 'body', 'TEXT');
    this._addColumnIfMissing('messages', 'mentions_json', 'TEXT');
    this._addColumnIfMissing('messages', 'root_message_id', 'TEXT');
    this._addColumnIfMissing('messages', 'depth', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('messages', 'epoch', 'INTEGER NOT NULL DEFAULT 0');
    this._addColumnIfMissing('messages', 'client_msg_id', 'TEXT');
    this._addColumnIfMissing('messages', 'context_version', 'INTEGER NOT NULL DEFAULT 0');
    // Provenance (P0-3). Nullable: historical rows cannot be attributed.
    this._addColumnIfMissing('messages', 'auth_kind', 'TEXT');
    this._addColumnIfMissing('messages', 'principal_id', 'TEXT');
    this._addColumnIfMissing('messages', 'request_id', 'TEXT');
    this._addColumnIfMissing('chats', 'epoch', 'INTEGER NOT NULL DEFAULT 0');
    // A pre-chat database may have a chats table from an even older schema (or
    // none at all). Add the missing columns before creating the index that
    // depends on them.
    this._addColumnIfMissing('chats', 'created_at', 'TEXT');
    this._addColumnIfMissing('chats', 'updated_at', 'TEXT');
    this._addColumnIfMissing('chats', 'status', "TEXT DEFAULT 'active'");
    this._addColumnIfMissing('chats', 'last_message_at', 'TEXT');
    this._addColumnIfMissing('chats', 'last_message_preview', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status, updated_at)');

    // A message may have many replies now (one broadcast can be answered by
    // several agents); the old one-reply-per-message index must go.
    this.db.exec('DROP INDEX IF EXISTS idx_messages_reply_unique');

    this.db.exec(`
      UPDATE messages SET body = summary WHERE body IS NULL;
      UPDATE messages SET depth = 0 WHERE depth IS NULL;
      UPDATE messages SET epoch = 0 WHERE epoch IS NULL;
      UPDATE messages SET context_version = 0 WHERE context_version IS NULL;
    `);

    // Backfill seq per chat in deterministic (created_at, id) order. Existing
    // seq values are preserved and new rows start after the current maximum.
    const chatsToBackfill = this.db.prepare(
      'SELECT DISTINCT chat_id FROM messages WHERE chat_id IS NOT NULL AND seq IS NULL'
    ).all();
    const updateSeq = this.db.prepare('UPDATE messages SET seq = ? WHERE id = ?');
    for (const { chat_id: chatId } of chatsToBackfill) {
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE chat_id = ?').get(chatId);
      let next = Number(maxRow?.m ?? 0);
      const rows = this.db.prepare(
        'SELECT id FROM messages WHERE chat_id = ? AND seq IS NULL ORDER BY created_at ASC, id ASC'
      ).all(chatId);
      for (const row of rows) {
        next += 1;
        updateSeq.run(next, row.id);
      }
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq
        ON messages(chat_id, seq) WHERE chat_id IS NOT NULL AND seq IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg
        ON messages(chat_id, client_msg_id) WHERE chat_id IS NOT NULL AND client_msg_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_epoch ON messages(chat_id, epoch, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_root ON messages(root_message_id);
    `);

    this.migrateApprovalGrants();

    const now = this._now();
    // Every chat has its human and coordinator. Executors become participants
    // when they are first mentioned/dispatched, so an agent token cannot list
    // or read a chat it was never involved in.
    this.db.prepare(
      `INSERT OR IGNORE INTO chat_participants
        (chat_id, participant_id, kind, role, display_name, enabled, auto_participate, joined_at, last_read_seq)
       SELECT chat_id, 'user', 'human', 'user', 'User', 1, 1, COALESCE(created_at, ?), 0 FROM chats`
    ).run(now);
    this.db.prepare(
      `INSERT OR IGNORE INTO chat_participants
        (chat_id, participant_id, kind, role, display_name, enabled, auto_participate, joined_at, last_read_seq)
       SELECT chat_id, 'muse', 'orchestrator', 'muse', 'Muse', 1, 1, COALESCE(created_at, ?), 0 FROM chats`
    ).run(now);
    this.db.prepare(
      `INSERT OR IGNORE INTO chat_participants
        (chat_id, participant_id, kind, role, display_name, enabled, auto_participate, joined_at, last_read_seq)
       SELECT DISTINCT ct.chat_id, t.agent, 'agent', t.agent, t.agent, 1, 1,
              COALESCE(MIN(t.created_at), ?), 0
         FROM chat_tasks ct JOIN tasks t ON t.id = ct.task_id
        GROUP BY ct.chat_id, t.agent`
    ).run(now);
  }

  migrateApprovalGrants() {
    const columns = this._columns('approval_grants');
    if (columns.includes('thread_id')) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE approval_grants RENAME TO approval_grants_legacy;
        CREATE TABLE approval_grants (
          scope TEXT NOT NULL,
          agent TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL,
          source_approval_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (scope, agent, category)
        );
        INSERT INTO approval_grants (scope, agent, category, source_approval_id, created_at)
          SELECT 'thread:' || thread_id, '', category, source_approval_id, created_at
            FROM approval_grants_legacy;
        DROP TABLE approval_grants_legacy;
        COMMIT;
      `);
    }
  }

  _now() {
    return new Date().toISOString();
  }

  _metaPath(taskId) {
    return join(this.dataDir, `${taskId}.json`);
  }

  insertTask(task) {
    const row = {};
    for (const c of TASK_COLUMNS) row[c] = task[c] ?? null;
    const cols = TASK_COLUMNS.join(', ');
    const marks = TASK_COLUMNS.map(() => '?').join(', ');
    this.db.prepare(`INSERT INTO tasks (${cols}) VALUES (${marks})`).run(...TASK_COLUMNS.map((c) => row[c]));
    writeFileSync(this._metaPath(task.id), JSON.stringify(row, null, 2));
    writeFileSync(join(this.dataDir, `${task.id}.prompt`), String(task.prompt ?? ''), 'utf8');
    appendFileSync(join(this.dataDir, `${task.id}.log`), '', 'utf8');
  }

  updateTask(id, patch) {
    const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...keys.map((k) => patch[k] ?? null),
      this._now(),
      id
    );
    const row = this.getTask(id);
    if (row) writeFileSync(this._metaPath(id), JSON.stringify(row, null, 2));
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
  }

  listTasks({ status = null, agent = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const clauses = [];
    const params = [];
    if (status) { clauses.push('state = ?'); params.push(status); }
    if (agent) { clauses.push('agent = ?'); params.push(agent); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`
    ).all(...params, n);
  }

  nonTerminalTasks() {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE state IN ('PENDING','STARTING','WORKING','WAITING','BLOCKED','STALE')"
    ).all();
  }

  appendLog(taskId, stream, line, ts = this._now()) {
    let seq = this.taskSeq.get(taskId);
    if (seq === undefined) {
      const row = this.db.prepare('SELECT MAX(seq) AS m FROM logs WHERE task_id = ?').get(taskId);
      seq = Number(row?.m ?? 0);
    }
    seq += 1;
    this.taskSeq.set(taskId, seq);
    this.db.prepare('INSERT INTO logs (task_id, seq, ts, stream, line) VALUES (?, ?, ?, ?, ?)').run(
      taskId, seq, ts, stream, String(line)
    );
    appendFileSync(join(this.dataDir, `${taskId}.log`), `[${ts}] [${stream}] ${line}\n`, 'utf8');
    this.updateTask(taskId, { last_activity_at: ts });
    return seq;
  }

  getLogs(taskId, cursor = 0, limit = 200) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = this.db.prepare(
      'SELECT seq, ts, stream, line FROM logs WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(taskId, Number(cursor) || 0, n);
    return rows;
  }

  ensureSession(sessionId, agent) {
    const now = this._now();
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, agent, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, agent, now, now);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  }

  getSession(sessionId) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null;
  }

  appendSessionMessage(sessionId, role, text) {
    let seq = this.sessionSeq.get(sessionId);
    if (seq === undefined) {
      const row = this.db.prepare('SELECT MAX(seq) AS m FROM session_messages WHERE session_id = ?').get(sessionId);
      seq = Number(row?.m ?? 0);
    }
    seq += 1;
    this.sessionSeq.set(sessionId, seq);
    this.db.prepare(
      'INSERT INTO session_messages (session_id, seq, role, text, ts) VALUES (?, ?, ?, ?, ?)'
    ).run(sessionId, seq, role, String(text), this._now());
  }

  getSessionMessages(sessionId, limit = 20) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.db.prepare(
      'SELECT role, text FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, n);
    return rows.reverse();
  }

  ensureThread(threadId, rootTaskId = threadId) {
    const now = this._now();
    this.db.prepare(
      `INSERT OR IGNORE INTO threads
        (thread_id, root_task_id, state, exchange_count, message_count, last_message_id, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 0, 0, NULL, ?, ?)`
    ).run(threadId, rootTaskId, now, now);
    return this.getThread(threadId);
  }

  getThread(threadId) {
    return this.db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId) ?? null;
  }

  updateThread(threadId, patch) {
    const allowed = ['state', 'exchange_count', 'message_count', 'last_message_id', 'root_task_id'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE threads SET ${sets}, updated_at = ? WHERE thread_id = ?`).run(
      ...keys.map((k) => patch[k] ?? null),
      this._now(),
      threadId
    );
  }

  setTaskThread(taskId, threadId, originMessageId = null) {
    this.ensureThread(threadId, threadId);
    this.db.prepare(
      `INSERT OR REPLACE INTO task_threads (task_id, thread_id, origin_message_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(taskId, threadId, originMessageId, this._now());
  }

  getTaskThread(taskId) {
    return this.db.prepare('SELECT * FROM task_threads WHERE task_id = ?').get(taskId) ?? null;
  }

  getThreadId(taskId) {
    return this.getTaskThread(taskId)?.thread_id || taskId;
  }

  getThreadForTask(taskId) {
    const link = this.getTaskThread(taskId);
    if (!link) return { thread_id: taskId, state: 'ACTIVE', exchange_count: 0, message_count: 0 };
    return this.getThread(link.thread_id)
      || { thread_id: link.thread_id, state: 'ACTIVE', exchange_count: 0, message_count: 0 };
  }

  listTaskIdsForThread(threadId) {
    return this.db.prepare(
      'SELECT task_id FROM task_threads WHERE thread_id = ?'
    ).all(threadId).map((row) => row.task_id);
  }

  insertMessage(message) {
    const values = MESSAGE_COLUMNS.map((column) => {
      const value = message[column];
      if (value !== undefined && value !== null) return value;
      return MESSAGE_DEFAULTS[column] ?? null;
    });
    this.db.prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`
    ).run(...values);
  }

  _nextChatSeqLocked(chatId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE chat_id = ?').get(chatId);
    return Number(row?.m ?? 0) + 1;
  }

  // The message row, its per-participant delivery rows and any message_files
  // references are one transaction: a reader never sees a message without its
  // visibility/action rows.
  insertChatMessageBundle(message, { deliveries = [], fileIds = [], bumpEpoch = false } = {}) {
    return this._transaction(() => {
      // A user message advances the chat epoch in the same transaction as the
      // message row, so a failed insert never leaves a phantom epoch bump.
      if (bumpEpoch) {
        if (!message.chat_id) throw new Error('bumpEpoch requires a chat_id');
        this.bumpChatEpoch(message.chat_id);
      }
      let seq = message.seq;
      if (message.chat_id && (seq === undefined || seq === null)) {
        seq = this._nextChatSeqLocked(message.chat_id);
      }
      this.insertMessage({ ...message, seq });
      const now = this._now();
      for (const delivery of deliveries) {
        this.insertDelivery({
          message_id: message.id,
          agent: delivery.agent,
          status: delivery.status ?? 'visible',
          task_id: delivery.task_id ?? null,
          error: delivery.error ?? null,
          epoch: delivery.epoch ?? message.epoch ?? 0,
          updated_at: now
        });
      }
      fileIds.forEach((fileId, index) => {
        this.db.prepare(
          'INSERT OR IGNORE INTO message_files (message_id, file_id, sort_order) VALUES (?, ?, ?)'
        ).run(message.id, fileId, index);
      });
      return this.getMessage(message.id);
    });
  }

  updateMessage(id, patch) {
    const allowed = [
      'status', 'delivery_task_id', 'error', 'is_final', 'body', 'mentions_json',
      'root_message_id', 'depth', 'epoch', 'client_msg_id', 'context_version'
    ];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE messages SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...keys.map((k) => patch[k] ?? null),
      this._now(),
      id
    );
  }

  getMessage(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null;
  }

  getMessageByClientId(chatId, clientMsgId) {
    if (!chatId || !clientMsgId) return null;
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? AND client_msg_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(chatId, clientMsgId) ?? null;
  }

  getReply(messageId) {
    return this.db.prepare('SELECT * FROM messages WHERE reply_to = ?').get(messageId) ?? null;
  }

  listMessages({
    threadId = null, taskId = null, from = null, to = null, replyTo = null, status = null,
    chatId = null, chatIds = null, limit = 100
  } = {}) {
    const clauses = [];
    const params = [];
    if (threadId) { clauses.push('thread_id = ?'); params.push(threadId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (from) { clauses.push('from_agent = ?'); params.push(from); }
    if (to) { clauses.push('to_agent = ?'); params.push(to); }
    if (replyTo) { clauses.push('reply_to = ?'); params.push(replyTo); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    if (Array.isArray(chatIds)) {
      if (chatIds.length === 0) return [];
      clauses.push(`chat_id IN (${chatIds.map(() => '?').join(', ')})`);
      params.push(...chatIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...params, n);
  }

  // Chat messages are returned chronologically by seq. `before` pages backwards
  // from a message id (seq cursor) or an ISO timestamp; `afterSeq` is for
  // incremental polling. The slice is taken newest-first and then reversed so
  // callers always receive ascending order.
  listChatMessages({ chatId, limit = 50, before = null, afterSeq = null } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const clauses = ['chat_id = ?'];
    const params = [chatId];
    if (afterSeq !== null && afterSeq !== undefined) {
      clauses.push('seq > ?');
      params.push(Number(afterSeq) || 0);
    }
    if (before) {
      const anchor = this.db.prepare('SELECT seq, created_at FROM messages WHERE id = ?').get(before);
      if (anchor?.seq !== null && anchor?.seq !== undefined) {
        clauses.push('seq < ?');
        params.push(Number(anchor.seq));
      } else {
        const cursor = anchor?.created_at || String(before);
        clauses.push('created_at < ?');
        params.push(cursor);
      }
    }
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE ${clauses.join(' AND ')}
        ORDER BY seq DESC, created_at DESC, id DESC LIMIT ?`
    ).all(...params, n);
    return rows.reverse();
  }

  listRecentChatMessages(chatId, limit = 30) {
    const n = Math.max(1, Math.min(500, Number(limit) || 30));
    return this.db.prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ?
          ORDER BY seq DESC, created_at DESC, id DESC LIMIT ?
       ) ORDER BY seq ASC, created_at ASC, id ASC`
    ).all(chatId, n);
  }

  countChatAgentMessages(chatId, epoch, agents = ['claude', 'dsh']) {
    const marks = agents.map(() => '?').join(', ');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE chat_id = ? AND epoch = ? AND from_agent IN (${marks})`
    ).get(chatId, Number(epoch) || 0, ...agents);
    return Number(row?.n ?? 0);
  }

  // ------------------------------------------------------------------- chats
  insertChat(chat) {
    this.db.prepare(
      `INSERT INTO chats (chat_id, name, created_at, updated_at, status, last_message_at, last_message_preview, epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chat.chat_id,
      chat.name,
      chat.created_at ?? this._now(),
      chat.updated_at ?? this._now(),
      chat.status ?? 'active',
      chat.last_message_at ?? null,
      chat.last_message_preview ?? null,
      chat.epoch ?? 0
    );
    return this.getChat(chat.chat_id);
  }

  getChat(chatId) {
    return this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) ?? null;
  }

  updateChat(chatId, patch) {
    const allowed = ['name', 'status', 'last_message_at', 'last_message_preview', 'epoch'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getChat(chatId);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE chats SET ${sets}, updated_at = ? WHERE chat_id = ?`).run(
      ...keys.map((key) => patch[key] ?? null),
      this._now(),
      chatId
    );
    return this.getChat(chatId);
  }

  bumpChatEpoch(chatId) {
    const row = this.db.prepare(
      'UPDATE chats SET epoch = COALESCE(epoch, 0) + 1, updated_at = ? WHERE chat_id = ? RETURNING epoch'
    ).get(this._now(), chatId);
    return Number(row?.epoch ?? 0);
  }

  chatEpoch(chatId) {
    return Number(this.getChat(chatId)?.epoch ?? 0);
  }

  listChats({ status = null, limit = 50, chatIds = null } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (Array.isArray(chatIds)) {
      if (chatIds.length === 0) return [];
      clauses.push(`chat_id IN (${chatIds.map(() => '?').join(', ')})`);
      params.push(...chatIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM chats ${where}
        ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`
    ).all(...params, n);
  }

  // task_id -> chat_id backfill for a task that already wrote messages before
  // it was linked, so the chat view never loses an early row.
  linkChatTask(chatId, taskId) {
    this.db.prepare(
      'INSERT OR IGNORE INTO chat_tasks (chat_id, task_id, created_at) VALUES (?, ?, ?)'
    ).run(chatId, taskId, this._now());
    this.db.prepare(
      'UPDATE messages SET chat_id = ? WHERE task_id = ? AND chat_id IS NULL'
    ).run(chatId, taskId);
  }

  getChatForTask(taskId) {
    return this.db.prepare(
      `SELECT c.* FROM chats c JOIN chat_tasks ct ON ct.chat_id = c.chat_id WHERE ct.task_id = ? LIMIT 1`
    ).get(taskId) ?? null;
  }

  listChatTasks(chatId) {
    return this.db.prepare(
      `SELECT t.* FROM tasks t JOIN chat_tasks ct ON ct.task_id = t.id
       WHERE ct.chat_id = ? ORDER BY t.created_at ASC`
    ).all(chatId);
  }

  latestChatTaskForAgent(chatId, agent) {
    return this.db.prepare(
      `SELECT t.* FROM tasks t JOIN chat_tasks ct ON ct.task_id = t.id
       WHERE ct.chat_id = ? AND t.agent = ?
       ORDER BY t.created_at DESC LIMIT 1`
    ).get(chatId, agent) ?? null;
  }

  findActiveTaskForChatAgent(chatId, agent) {
    return this.db.prepare(
      `SELECT t.id, t.session_id, t.state FROM tasks t JOIN chat_tasks ct ON ct.task_id = t.id
       WHERE ct.chat_id = ? AND t.agent = ?
         AND t.state IN ('PENDING','STARTING','WORKING','WAITING','BLOCKED')
       ORDER BY t.created_at DESC LIMIT 1`
    ).get(chatId, agent) ?? null;
  }

  // needs_muse is derived, never stored: there is a user message and no Muse
  // message at or after it. seq is the authoritative order inside a chat.
  chatNeedsMuse(chatId) {
    const lastUser = this.db.prepare(
      "SELECT MAX(seq) AS s FROM messages WHERE chat_id = ? AND from_agent = 'user' AND seq IS NOT NULL"
    ).get(chatId)?.s;
    if (lastUser === null || lastUser === undefined) return false;
    const lastMuse = this.db.prepare(
      "SELECT MAX(seq) AS s FROM messages WHERE chat_id = ? AND from_agent = 'muse' AND seq IS NOT NULL"
    ).get(chatId)?.s;
    if (lastMuse === null || lastMuse === undefined) return true;
    return Number(lastUser) > Number(lastMuse);
  }

  findActiveTaskForThreadAgent(threadId, agent) {
    return this.db.prepare(
      `SELECT t.id, t.session_id, t.state FROM tasks t
       JOIN task_threads tt ON tt.task_id = t.id
       WHERE tt.thread_id = ? AND t.agent = ?
         AND t.state IN ('PENDING','STARTING','WORKING','WAITING','BLOCKED')
       ORDER BY t.created_at DESC LIMIT 1`
    ).get(threadId, agent) ?? null;
  }

  findThreadSession(threadId, agent) {
    return this.db.prepare(
      `SELECT t.session_id, t.id, t.created_at FROM tasks t
       JOIN task_threads tt ON tt.task_id = t.id
       WHERE tt.thread_id = ? AND t.agent = ?
       ORDER BY t.created_at DESC LIMIT 1`
    ).get(threadId, agent) ?? null;
  }

  taskReplyFrom(taskId, replyTo) {
    return this.db.prepare(
      'SELECT id, status FROM messages WHERE task_id = ? AND reply_to = ? ORDER BY created_at DESC LIMIT 1'
    ).get(taskId, replyTo) ?? null;
  }

  lastChatMessage(chatId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC, created_at DESC, id DESC LIMIT 1'
    ).get(chatId) ?? null;
  }

  // ------------------------------------------------------------- participants
  upsertChatParticipant(participant) {
    this.db.prepare(
      `INSERT INTO chat_participants
        (chat_id, participant_id, kind, role, display_name, enabled, auto_participate, joined_at, last_read_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, participant_id) DO UPDATE SET
         kind = excluded.kind,
         role = excluded.role,
         display_name = excluded.display_name,
         enabled = excluded.enabled,
         auto_participate = excluded.auto_participate`
    ).run(
      participant.chat_id,
      participant.participant_id,
      participant.kind ?? 'agent',
      participant.role ?? participant.participant_id,
      participant.display_name ?? participant.participant_id,
      participant.enabled === false ? 0 : 1,
      participant.auto_participate === false ? 0 : 1,
      participant.joined_at ?? this._now(),
      participant.last_read_seq ?? 0
    );
    return this.getChatParticipant(participant.chat_id, participant.participant_id);
  }

  getChatParticipant(chatId, participantId) {
    return this.db.prepare(
      'SELECT * FROM chat_participants WHERE chat_id = ? AND participant_id = ?'
    ).get(chatId, participantId) ?? null;
  }

  isChatParticipant(chatId, participantId) {
    return Boolean(this.getChatParticipant(chatId, participantId));
  }

  listChatParticipants(chatId) {
    return this.db.prepare(
      `SELECT * FROM chat_participants WHERE chat_id = ?
        ORDER BY CASE participant_id
          WHEN 'user' THEN 0 WHEN 'muse' THEN 1 WHEN 'claude' THEN 2 WHEN 'dsh' THEN 3 ELSE 4 END,
          joined_at ASC`
    ).all(chatId);
  }

  listParticipantChatIds(participantId) {
    return this.db.prepare(
      'SELECT chat_id FROM chat_participants WHERE participant_id = ? AND enabled = 1'
    ).all(participantId).map((row) => row.chat_id);
  }

  updateParticipantRead(chatId, participantId, upToSeq) {
    this.db.prepare(
      `UPDATE chat_participants SET last_read_seq = MAX(last_read_seq, ?)
        WHERE chat_id = ? AND participant_id = ?`
    ).run(Number(upToSeq) || 0, chatId, participantId);
    return this.getChatParticipant(chatId, participantId);
  }

  // --------------------------------------------------------------- deliveries
  insertDelivery(delivery) {
    const status = delivery.status ?? 'visible';
    this.db.prepare(
      `INSERT INTO chat_deliveries (message_id, agent, status, task_id, error, epoch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, agent) DO UPDATE SET
         status = excluded.status,
         task_id = excluded.task_id,
         error = excluded.error,
         epoch = excluded.epoch,
         updated_at = excluded.updated_at`
    ).run(
      delivery.message_id,
      delivery.agent,
      status,
      delivery.task_id ?? null,
      delivery.error ?? null,
      delivery.epoch ?? 0,
      delivery.updated_at ?? this._now()
    );
    if (status !== 'visible') {
      this.recordDeliveryAttempt({
        message_id: delivery.message_id,
        agent: delivery.agent,
        status,
        task_id: delivery.task_id ?? null,
        error: delivery.error ?? null,
        created_at: delivery.updated_at
      });
    }
  }

  updateDelivery(messageId, agent, patch) {
    const allowed = ['status', 'task_id', 'error', 'epoch'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getDelivery(messageId, agent);
    const before = this.getDelivery(messageId, agent);
    const now = this._now();
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(
      `UPDATE chat_deliveries SET ${sets}, updated_at = ? WHERE message_id = ? AND agent = ?`
    ).run(...keys.map((key) => patch[key] ?? null), now, messageId, agent);
    const after = this.getDelivery(messageId, agent);
    const changed = !before
      || before.status !== after.status
      || (patch.error !== undefined && (before.error ?? null) !== (after.error ?? null))
      || (patch.task_id !== undefined && (before.task_id ?? null) !== (after.task_id ?? null));
    if (changed) {
      this.recordDeliveryAttempt({
        message_id: messageId,
        agent,
        status: after.status,
        task_id: after.task_id ?? null,
        error: after.error ?? null,
        created_at: now
      });
    }
    return after;
  }

  recordDeliveryAttempt({ message_id: messageId, agent, status, task_id: taskId = null, error = null, created_at: createdAt = null }) {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(attempt), 0) AS n FROM delivery_attempts WHERE message_id = ? AND agent = ?'
    ).get(messageId, agent);
    const attempt = Number(row?.n ?? 0) + 1;
    this.db.prepare(
      `INSERT INTO delivery_attempts (message_id, agent, attempt, status, task_id, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(messageId, agent, attempt, status, taskId, error, createdAt || this._now());
    return attempt;
  }

  listDeliveryAttempts(messageId, agent = null) {
    if (agent) {
      return this.db.prepare(
        'SELECT * FROM delivery_attempts WHERE message_id = ? AND agent = ? ORDER BY attempt ASC'
      ).all(messageId, agent);
    }
    return this.db.prepare(
      'SELECT * FROM delivery_attempts WHERE message_id = ? ORDER BY agent ASC, attempt ASC'
    ).all(messageId);
  }

  deliveryAttemptSummary(messageId, agent) {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS attempt_count,
              MIN(created_at) AS first_attempt_at,
              MAX(created_at) AS last_attempt_at,
              SUM(CASE WHEN status IN ('delivered','failed','skipped','held') THEN 1 ELSE 0 END) AS finished_count
         FROM delivery_attempts WHERE message_id = ? AND agent = ?`
    ).get(messageId, agent);
    return {
      attempt_count: Number(row?.attempt_count ?? 0),
      first_attempt_at: row?.first_attempt_at ?? null,
      last_attempt_at: row?.last_attempt_at ?? null,
      finished_count: Number(row?.finished_count ?? 0)
    };
  }

  // ------------------------------------------------------------------ presence
  touchMusePresence({ ttlMs = 5 * 60 * 1000, source = 'request', force = false } = {}) {
    const now = Date.now();
    const existing = this.getMusePresence();
    if (!force && existing) {
      const last = Date.parse(existing.last_seen_at);
      const throttle = Math.min(5000, Math.max(200, Number(ttlMs) / 2));
      if (Number.isFinite(last) && now - last < throttle) return existing;
    }
    const seenAt = new Date(now).toISOString();
    const expiresAt = new Date(now + Math.max(1000, Number(ttlMs) || 300_000)).toISOString();
    this.db.prepare(
      `INSERT INTO muse_presence (principal_id, last_seen_at, lease_expires_at, source, updated_at)
       VALUES ('muse', ?, ?, ?, ?)
       ON CONFLICT(principal_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         lease_expires_at = excluded.lease_expires_at,
         source = excluded.source,
         updated_at = excluded.updated_at`
    ).run(seenAt, expiresAt, source ?? null, seenAt);
    return this.getMusePresence();
  }

  getMusePresence() {
    return this.db.prepare("SELECT * FROM muse_presence WHERE principal_id = 'muse'").get() ?? null;
  }

  museLeaseFresh(ttlMs = 5 * 60 * 1000, now = Date.now()) {
    const presence = this.getMusePresence();
    if (!presence) return false;
    const last = Date.parse(presence.last_seen_at);
    if (!Number.isFinite(last)) return false;
    return now - last <= Math.max(1000, Number(ttlMs) || 300_000);
  }

  getDelivery(messageId, agent) {
    return this.db.prepare(
      'SELECT * FROM chat_deliveries WHERE message_id = ? AND agent = ?'
    ).get(messageId, agent) ?? null;
  }

  listMessageDeliveries(messageId) {
    return this.db.prepare(
      'SELECT * FROM chat_deliveries WHERE message_id = ? ORDER BY agent ASC'
    ).all(messageId);
  }

  listActionDeliveries({ chatId = null, status = null, limit = 100 } = {}) {
    const clauses = ["d.status <> 'visible'"];
    const params = [];
    if (chatId) { clauses.push('m.chat_id = ?'); params.push(chatId); }
    if (status) { clauses.push('d.status = ?'); params.push(status); }
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT d.*, m.chat_id, m.epoch AS message_epoch, m.to_agent, m.from_agent
         FROM chat_deliveries d JOIN messages m ON m.id = d.message_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY d.updated_at ASC LIMIT ?`
    ).all(...params, n);
  }

  deliverySummary(chatId) {
    const rows = this.db.prepare(
      `SELECT d.agent, d.status, COUNT(*) AS n
         FROM chat_deliveries d JOIN messages m ON m.id = d.message_id
        WHERE m.chat_id = ?
        GROUP BY d.agent, d.status`
    ).all(chatId);
    const summary = {};
    for (const row of rows) {
      if (!summary[row.agent]) summary[row.agent] = {};
      summary[row.agent][row.status] = Number(row.n);
    }
    return summary;
  }

  // ------------------------------------------------------------------- files
  insertChatFile(file) {
    const values = CHAT_FILE_COLUMNS.map((column) => file[column] ?? null);
    this.db.prepare(
      `INSERT INTO chat_files (${CHAT_FILE_COLUMNS.join(', ')})
       VALUES (${CHAT_FILE_COLUMNS.map(() => '?').join(', ')})`
    ).run(...values);
    return this.getChatFile(file.file_id);
  }

  getChatFile(fileId) {
    return this.db.prepare('SELECT * FROM chat_files WHERE file_id = ?').get(fileId) ?? null;
  }

  updateChatFile(fileId, patch) {
    const allowed = ['parse_status', 'parse_error', 'extracted_path', 'mime'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getChatFile(fileId);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE chat_files SET ${sets} WHERE file_id = ?`).run(
      ...keys.map((key) => patch[key] ?? null),
      fileId
    );
    return this.getChatFile(fileId);
  }

  listChatFiles(chatId, limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      'SELECT * FROM chat_files WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(chatId, n);
  }

  listMessageFiles(messageId) {
    return this.db.prepare(
      `SELECT f.* FROM chat_files f JOIN message_files mf ON mf.file_id = f.file_id
        WHERE mf.message_id = ? ORDER BY mf.sort_order ASC`
    ).all(messageId);
  }

  // ------------------------------------------------------------------ approvals
  insertApproval(approval) {
    const columns = [
      'id', 'thread_id', 'task_id', 'agent', 'category', 'action', 'command', 'files_json',
      'reason', 'message_id', 'response_message_id', 'status', 'decision', 'error',
      'created_at', 'updated_at', 'responded_at'
    ];
    this.db.prepare(
      `INSERT INTO approvals (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((c) => approval[c] ?? null));
  }

  getApproval(id) {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) ?? null;
  }

  // Conditional update: only the first resolver moves a pending approval, so a
  // reply arriving through both respond_approval and the chat poller cannot
  // apply two different decisions.
  finalizeApproval(id, patch) {
    const allowed = ['status', 'decision', 'response_message_id', 'error', 'responded_at'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (keys.length === 0) return 0;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const info = this.db.prepare(
      `UPDATE approvals SET ${sets}, updated_at = ? WHERE id = ? AND status = 'pending'`
    ).run(...keys.map((k) => patch[k] ?? null), this._now(), id);
    return Number(info.changes ?? 0);
  }

  findPendingApprovalForTask(taskId) {
    return this.db.prepare(
      'SELECT * FROM approvals WHERE task_id = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1'
    ).get(taskId) ?? null;
  }

  findPendingApprovalForThread(threadId) {
    return this.db.prepare(
      'SELECT * FROM approvals WHERE thread_id = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1'
    ).get(threadId) ?? null;
  }

  countPendingApprovalsForThread(threadId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM approvals WHERE thread_id = ? AND status = \'pending\''
    ).get(threadId);
    return Number(row?.n ?? 0);
  }

  getLastApprovalForTask(taskId) {
    return this.db.prepare(
      'SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(taskId) ?? null;
  }

  listApprovals({ threadId = null, taskId = null, status = null, agent = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (threadId) { clauses.push('thread_id = ?'); params.push(threadId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (agent) { clauses.push('agent = ?'); params.push(agent); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM approvals ${where} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...params, n);
  }

  addApprovalGrant(scope, agent, category, sourceApprovalId) {
    this.db.prepare(
      `INSERT INTO approval_grants (scope, agent, category, source_approval_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, agent, category) DO UPDATE SET
         source_approval_id = excluded.source_approval_id,
         created_at = excluded.created_at`
    ).run(scope, agent ?? '', category, sourceApprovalId ?? null, this._now());
  }

  getApprovalGrant(scope, agent, category) {
    return this.db.prepare(
      'SELECT * FROM approval_grants WHERE scope = ? AND agent = ? AND category = ?'
    ).get(scope, agent ?? '', category) ?? null;
  }

  listApprovalGrants(scope) {
    return this.db.prepare(
      'SELECT * FROM approval_grants WHERE scope = ? ORDER BY created_at ASC'
    ).all(scope);
  }

  expirePendingApprovalsForTask(taskId, status = 'abandoned') {
    const rows = this.db.prepare(
      'SELECT * FROM approvals WHERE task_id = ? AND status = \'pending\''
    ).all(taskId);
    if (rows.length === 0) return [];
    const now = this._now();
    this.db.prepare(
      'UPDATE approvals SET status = ?, updated_at = ?, responded_at = ? WHERE task_id = ? AND status = \'pending\''
    ).run(status, now, now, taskId);
    return rows;
  }

  expireAllPendingApprovals(status = 'abandoned') {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE status = \'pending\'').all();
    if (rows.length === 0) return [];
    const now = this._now();
    this.db.prepare(
      'UPDATE approvals SET status = ?, updated_at = ?, responded_at = ? WHERE status = \'pending\''
    ).run(status, now, now);
    return rows;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}