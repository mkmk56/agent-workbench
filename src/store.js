import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
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
  'auth_kind', 'principal_id', 'request_id',
  // Execution metrics copied from the producing task (P1-5). Nullable for
  // human/Muse rows and for historical rows whose execution was never recorded.
  'provider', 'model', 'token_usage_json', 'latency_ms',
  // REA Phase 2: recall state and the protocol-level idempotency key. op_key
  // and client_msg_id intentionally hold the same value; the protocol name is
  // an alias, not a second idempotency mechanism.
  'recalled_at', 'recalled_by', 'op_key',
  // REA Phase 4: user/system message kind. System notices stay out of the
  // normal chat stream; historical rows default to 'user'.
  'kind'
];

const MESSAGE_DEFAULTS = Object.freeze({
  kind: 'user',
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
        request_id TEXT,
        provider TEXT,
        model TEXT,
        token_usage_json TEXT,
        latency_ms INTEGER,
        recalled_at INTEGER,
        recalled_by TEXT,
        op_key TEXT,
        kind TEXT NOT NULL DEFAULT 'user'
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
      -- The migration script and a running engine may overlap briefly. Waiting
      -- for a lock is safer than failing a write with SQLITE_BUSY.
      PRAGMA busy_timeout = 5000;
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
        epoch INTEGER NOT NULL DEFAULT 0,
        -- REA Phase 4: JSON {description, announcement}. Nullable for chats
        -- created before the column existed; readers treat null/invalid as {}.
        settings TEXT
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
      -- REA Phase 2 identity and membership. agents.id is the canonical agent
      -- id (agent_muse / agent_claude / agent_dsh, or agent_<random> for a
      -- paired third-party agent). chat_participants stays as the legacy
      -- participant projection; the two are kept in sync by AgentService.
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        platform TEXT NOT NULL,
        display_name TEXT NOT NULL,
        profile TEXT,
        color TEXT,
        token_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash
        ON agents(token_hash) WHERE token_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_owner_name
        ON agents(owner, display_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner, status);
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_members_agent
        ON chat_members(agent_id, chat_id);
      CREATE TABLE IF NOT EXISTS inbox_cursors (
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        mentions_you INTEGER NOT NULL DEFAULT 0,
        replies_to_you INTEGER NOT NULL DEFAULT 0,
        from_owner INTEGER NOT NULL DEFAULT 0,
        recalled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_cursors_agent
        ON inbox_cursors(agent_id, chat_id);
      -- Pairing codes are only stored as a hash, like access tokens. A code is
      -- valid for at most 24 hours and at most 10 distinct agents.
      CREATE TABLE IF NOT EXISTS pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        max_agents INTEGER NOT NULL DEFAULT 10,
        uses INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_owner ON pairing_codes(owner, expires_at);
      CREATE TABLE IF NOT EXISTS pairing_code_uses (
        pairing_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY (pairing_id, agent_id)
      );
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
        -- P1-2 retry state. error_kind is transient|permanent|task_failed;
        -- next_attempt_at is when a transient failure may be retried again.
        error_kind TEXT,
        next_attempt_at TEXT,
        dead_lettered_at TEXT,
        PRIMARY KEY (message_id, agent)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_deliveries_status ON chat_deliveries(status, updated_at);
      -- The retry index is created in migrateVersioned v3, after the columns
      -- are added to an existing table. Creating it here would fail on a
      -- pre-P1 database where chat_deliveries exists without those columns.
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
      -- P1-5 execution records. One execution per task run; model_calls keeps
      -- one row per model request so token/cost/latency is attributable.
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        task_id TEXT,
        agent TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        provider_request_id TEXT,
        token_usage_json TEXT,
        cost_usd REAL,
        latency_ms INTEGER,
        session_id TEXT,
        usage_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_executions_created ON executions(created_at);
      CREATE TABLE IF NOT EXISTS model_calls (
        call_id TEXT PRIMARY KEY,
        execution_id TEXT,
        task_id TEXT,
        agent TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        provider_request_id TEXT,
        token_usage_json TEXT,
        cost_usd REAL,
        latency_ms INTEGER,
        duration_api_ms INTEGER,
        ttft_ms INTEGER,
        usage_source TEXT NOT NULL DEFAULT 'unknown',
        request_summary TEXT,
        response_summary TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_execution ON model_calls(execution_id);
      CREATE INDEX IF NOT EXISTS idx_model_calls_task ON model_calls(task_id, created_at);
      -- Formal migration ledger. Every migration stores the inverse operation
      -- so a version can be rolled back deliberately (see docs/PERF_BASELINE.md
      -- for the measurement that justified the execution tables).
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        inverse TEXT
      );
      -- Muse presence/lease. The coordinator is an external process; this row
      -- is refreshed by its polling calls and expires when it goes away.
      CREATE TABLE IF NOT EXISTS muse_presence (
        principal_id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        source TEXT,
        updated_at TEXT NOT NULL
      );
      -- REA Phase 3: listener / check-in / wake. seq is a global event order
      -- (monotonic across chats) and is what SSE clients resume from; the
      -- per-chat message order stays in messages.seq.
      CREATE TABLE IF NOT EXISTS wake_events (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        chat_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        message_id TEXT,
        message_seq INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        delivery_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_events_seq
        ON wake_events(seq) WHERE seq IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_wake_events_chat_agent
        ON wake_events(chat_id, agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_wake_events_status
        ON wake_events(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_wake_events_created
        ON wake_events(created_at);
      -- P1: unread-@ reminders sent to the owner. Kept out of wake_events so
      -- the delivery status keeps its meaning, and persisted so an engine
      -- restart does not repeat a reminder for the same event.
      CREATE TABLE IF NOT EXISTS wake_unread_notices (
        event_id TEXT PRIMARY KEY,
        notified_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wake_unread_notices_at
        ON wake_unread_notices(notified_at);
      CREATE TABLE IF NOT EXISTS listener_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        chat_id TEXT,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected',
        connected_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listener_sessions_agent
        ON listener_sessions(agent_id, chat_id);
      CREATE TABLE IF NOT EXISTS checkins (
        agent_id TEXT PRIMARY KEY,
        every_minutes INTEGER NOT NULL DEFAULT 10,
        last_checkin_at INTEGER,
        consecutive_empty INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_wake (
        agent_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        wake_kinds TEXT NOT NULL DEFAULT '["mention","reply","owner_post"]',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      );
      -- Small persistent key/value store for counters that must survive the
      -- tables they count. wake_event_seq lives here so pruning every event
      -- row (the 7-day retention) never rewinds the SSE cursor.
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.migrateMessagesForChats();
    this.migrateGroupChat();
    this.migrateVersioned();
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
          request_id TEXT,
          provider TEXT,
          model TEXT,
          token_usage_json TEXT,
          latency_ms INTEGER,
          recalled_at INTEGER,
          recalled_by TEXT,
          op_key TEXT,
          kind TEXT NOT NULL DEFAULT 'user'
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

  // ---------------------------------------------------------------------------
  // Versioned migrations (P1-2 / P1-5)
  //
  // The pre-versioning migrations above stay where they are so an old database
  // still starts. Everything new is registered in schema_version with an
  // explicit inverse statement. Each step is idempotent and only the ledger row
  // is skipped on restart; the DDL guards are left in place so a partially
  // applied database can finish the step.
  // ---------------------------------------------------------------------------
  migrateVersioned() {
    // v1 describes the schema that existed before this ledger (chat upgrade,
    // provenance, delivery attempts). There is nothing to apply; the row only
    // makes later versions unambiguous.
    this._migrate(1, 'legacy-baseline',
      'no-op: schema existed before schema_version was introduced', () => {});

    this._migrate(2, 'executions-and-model-calls',
      'DROP TABLE IF EXISTS model_calls; DROP TABLE IF EXISTS executions;', () => {
        // Tables are created by the constructor DDL (CREATE IF NOT EXISTS).
      });

    this._migrate(3, 'delivery-retry-state',
      'ALTER TABLE chat_deliveries DROP COLUMN dead_lettered_at; '
      + 'ALTER TABLE chat_deliveries DROP COLUMN next_attempt_at; '
      + 'ALTER TABLE chat_deliveries DROP COLUMN error_kind;', () => {
        this._addColumnIfMissing('chat_deliveries', 'error_kind', 'TEXT');
        this._addColumnIfMissing('chat_deliveries', 'next_attempt_at', 'TEXT');
        this._addColumnIfMissing('chat_deliveries', 'dead_lettered_at', 'TEXT');
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS idx_chat_deliveries_retry ON chat_deliveries(status, next_attempt_at)'
        );
      });

    this._migrate(4, 'message-execution-metrics',
      'ALTER TABLE messages DROP COLUMN latency_ms; '
      + 'ALTER TABLE messages DROP COLUMN token_usage_json; '
      + 'ALTER TABLE messages DROP COLUMN model; '
      + 'ALTER TABLE messages DROP COLUMN provider;', () => {
        this._addColumnIfMissing('messages', 'provider', 'TEXT');
        this._addColumnIfMissing('messages', 'model', 'TEXT');
        this._addColumnIfMissing('messages', 'token_usage_json', 'TEXT');
        this._addColumnIfMissing('messages', 'latency_ms', 'INTEGER');
      });

    // REA Phase 2: agent identity, membership, inbox cursors, pairing, recall
    // state and the op_key alias. Tables are created by the constructor DDL;
    // this step adds the columns to an existing database and registers the
    // indexes. The pairing_codes/pairing_code_uses tables are implementation
    // storage for the 24h / <=10-agent pairing protocol.
    this._migrate(5, 'rea-phase2-agents-inbox-recall',
      'DROP TABLE IF EXISTS pairing_code_uses; '
      + 'DROP TABLE IF EXISTS pairing_codes; '
      + 'DROP TABLE IF EXISTS inbox_cursors; '
      + 'DROP TABLE IF EXISTS chat_members; '
      + 'DROP TABLE IF EXISTS agents; '
      + 'ALTER TABLE messages DROP COLUMN op_key; '
      + 'ALTER TABLE messages DROP COLUMN recalled_by; '
      + 'ALTER TABLE messages DROP COLUMN recalled_at; '
      + 'ALTER TABLE chats DROP COLUMN visibility; '
      + 'ALTER TABLE chats DROP COLUMN category;', () => {
        this._addColumnIfMissing('messages', 'recalled_at', 'INTEGER');
        this._addColumnIfMissing('messages', 'recalled_by', 'TEXT');
        this._addColumnIfMissing('messages', 'op_key', 'TEXT');
        this._addColumnIfMissing('chats', 'category', 'TEXT');
        this._addColumnIfMissing('chats', 'visibility', "TEXT DEFAULT 'link'");
        this.db.exec(`
          UPDATE chats SET visibility = 'link' WHERE visibility IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_op_key
            ON messages(chat_id, op_key) WHERE chat_id IS NOT NULL AND op_key IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_messages_recalled
            ON messages(chat_id, recalled_at) WHERE recalled_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_chats_category ON chats(category, updated_at);
        `);
      });

    // REA Phase 3: wake events, listener sessions and check-in state. The
    // tables themselves are created by the constructor DDL (CREATE IF NOT
    // EXISTS), so this step only registers the version with an explicit
    // inverse. Re-running the phase 3 migration script is therefore safe.
    this._migrate(6, 'rea-phase3-wake-listener-checkin',
      'DROP TABLE IF EXISTS agent_wake; '
      + 'DROP TABLE IF EXISTS checkins; '
      + 'DROP TABLE IF EXISTS listener_sessions; '
      + 'DROP TABLE IF EXISTS wake_events;', () => {});

    // REA Phase 4: message kind (user|system) and per-chat settings JSON.
    // Both columns are additive; rolling back means restoring the backup or
    // dropping the two columns (no existing column is rewritten).
    this._migrate(7, 'rea-phase4-message-kind-chat-settings',
      'ALTER TABLE messages DROP COLUMN kind; '
      + 'ALTER TABLE chats DROP COLUMN settings;', () => {
        this._addColumnIfMissing('messages', 'kind', "TEXT NOT NULL DEFAULT 'user'");
        this._addColumnIfMissing('chats', 'settings', 'TEXT');
      });
  }

  _migrate(version, name, inverse, fn) {
    const exists = this.db.prepare('SELECT version FROM schema_version WHERE version = ?').get(version);
    if (exists) return false;
    fn();
    this.db.prepare(
      'INSERT INTO schema_version (version, name, applied_at, inverse) VALUES (?, ?, ?, ?)'
    ).run(version, name, this._now(), inverse);
    return true;
  }

  schemaVersion() {
    try {
      return Number(this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0);
    } catch {
      return 0;
    }
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
      'status', 'delivery_task_id', 'error', 'is_final', 'body', 'summary', 'mentions_json',
      'root_message_id', 'depth', 'epoch', 'client_msg_id', 'context_version',
      'provider', 'model', 'token_usage_json', 'latency_ms',
      'recalled_at', 'recalled_by', 'op_key'
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

  // op_key is the protocol name for the same per-chat idempotency key.
  getMessageByOpKey(chatId, opKey) {
    return this.getMessageByClientId(chatId, opKey);
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
      `INSERT INTO chats
         (chat_id, name, created_at, updated_at, status, last_message_at, last_message_preview,
          epoch, category, visibility, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chat.chat_id,
      chat.name,
      chat.created_at ?? this._now(),
      chat.updated_at ?? this._now(),
      chat.status ?? 'active',
      chat.last_message_at ?? null,
      chat.last_message_preview ?? null,
      chat.epoch ?? 0,
      chat.category ?? null,
      chat.visibility ?? 'link',
      chat.settings ?? null
    );
    return this.getChat(chat.chat_id);
  }

  getChat(chatId) {
    return this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) ?? null;
  }

  updateChat(chatId, patch) {
    const allowed = [
      'name', 'status', 'last_message_at', 'last_message_preview', 'epoch', 'category', 'visibility',
      'settings'
    ];
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

  // Uncapped chat list for reconciliation/migration. listChats caps at 200 so a
// large installation could otherwise leave late chats unbackfilled.
  allChats() {
    return this.db.prepare('SELECT * FROM chats ORDER BY created_at ASC').all();
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

  deleteChatParticipant(chatId, participantId) {
    const info = this.db.prepare(
      'DELETE FROM chat_participants WHERE chat_id = ? AND participant_id = ?'
    ).run(chatId, participantId);
    return Number(info.changes ?? 0);
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
      `INSERT INTO chat_deliveries
         (message_id, agent, status, task_id, error, epoch, updated_at,
          error_kind, next_attempt_at, dead_lettered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id, agent) DO UPDATE SET
         status = excluded.status,
         task_id = excluded.task_id,
         error = excluded.error,
         epoch = excluded.epoch,
         updated_at = excluded.updated_at,
         error_kind = excluded.error_kind,
         next_attempt_at = excluded.next_attempt_at,
         dead_lettered_at = excluded.dead_lettered_at`
    ).run(
      delivery.message_id,
      delivery.agent,
      status,
      delivery.task_id ?? null,
      delivery.error ?? null,
      delivery.epoch ?? 0,
      delivery.updated_at ?? this._now(),
      delivery.error_kind ?? null,
      delivery.next_attempt_at ?? null,
      delivery.dead_lettered_at ?? null
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
    const allowed = [
      'status', 'task_id', 'error', 'epoch', 'error_kind', 'next_attempt_at', 'dead_lettered_at'
    ];
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
      || (patch.error_kind !== undefined && (before.error_kind ?? null) !== (after.error_kind ?? null))
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

  countDeliveryAttempts(messageId, agent) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM delivery_attempts WHERE message_id = ? AND agent = ?'
    ).get(messageId, agent);
    return Number(row?.n ?? 0);
  }

  // Deliveries the periodic sweep may replay: pending rows always, retry rows
  // once their backoff has elapsed, queued rows only when they have been idle
  // long enough that the normal task-finished hook must have been missed.
  listDeliveriesDue({ now = this._now(), staleQueuedBefore = null, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT d.*, m.chat_id, m.epoch AS message_epoch
         FROM chat_deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.status <> 'visible'
          AND (
            d.status = 'pending'
            OR (d.status = 'retry' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?))
            OR (d.status = 'queued' AND ? IS NOT NULL AND d.updated_at <= ?)
          )
        ORDER BY COALESCE(d.next_attempt_at, d.updated_at) ASC
        LIMIT ?`
    ).all(now, staleQueuedBefore, staleQueuedBefore ?? now, n);
  }

  deliveriesForTask(taskId) {
    return this.db.prepare(
      'SELECT * FROM chat_deliveries WHERE task_id = ? ORDER BY updated_at ASC'
    ).all(taskId);
  }

  // Non-chat messages left in a non-terminal delivery status by a restart.
  listMessagesByStatus(statuses, limit = 200) {
    if (!Array.isArray(statuses) || statuses.length === 0) return [];
    const n = Math.max(1, Math.min(500, Number(limit) || 200));
    return this.db.prepare(
      `SELECT * FROM messages
        WHERE status IN (${statuses.map(() => '?').join(', ')})
        ORDER BY created_at ASC LIMIT ?`
    ).all(...statuses, n);
  }

  // ------------------------------------------------------------ executions
  insertExecution(execution) {
    this.db.prepare(
      `INSERT INTO executions
         (execution_id, task_id, agent, provider, model, provider_request_id,
          token_usage_json, cost_usd, latency_ms, session_id, usage_source,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET
         task_id = excluded.task_id,
         agent = excluded.agent,
         provider = COALESCE(excluded.provider, executions.provider),
         model = COALESCE(excluded.model, executions.model),
         provider_request_id = COALESCE(excluded.provider_request_id, executions.provider_request_id),
         token_usage_json = COALESCE(excluded.token_usage_json, executions.token_usage_json),
         cost_usd = COALESCE(excluded.cost_usd, executions.cost_usd),
         latency_ms = COALESCE(excluded.latency_ms, executions.latency_ms),
         session_id = COALESCE(excluded.session_id, executions.session_id),
         usage_source = COALESCE(excluded.usage_source, executions.usage_source),
         updated_at = excluded.updated_at`
    ).run(
      execution.execution_id,
      execution.task_id ?? null,
      execution.agent,
      execution.provider ?? null,
      execution.model ?? null,
      execution.provider_request_id ?? null,
      execution.token_usage_json ?? null,
      execution.cost_usd ?? null,
      execution.latency_ms ?? null,
      execution.session_id ?? null,
      execution.usage_source ?? null,
      execution.created_at ?? this._now(),
      execution.updated_at ?? this._now()
    );
    return this.getExecution(execution.execution_id);
  }

  updateExecution(executionId, patch) {
    const allowed = [
      'provider', 'model', 'provider_request_id', 'token_usage_json', 'cost_usd',
      'latency_ms', 'session_id', 'usage_source'
    ];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getExecution(executionId);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(
      `UPDATE executions SET ${sets}, updated_at = ? WHERE execution_id = ?`
    ).run(...keys.map((key) => patch[key] ?? null), this._now(), executionId);
    return this.getExecution(executionId);
  }

  getExecution(executionId) {
    return this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId) ?? null;
  }

  getExecutionForTask(taskId) {
    return this.db.prepare(
      'SELECT * FROM executions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(taskId) ?? null;
  }

  insertModelCall(call) {
    const id = call.call_id ?? randomUUID();
    this.db.prepare(
      `INSERT INTO model_calls
         (call_id, execution_id, task_id, agent, provider, model, provider_request_id,
          token_usage_json, cost_usd, latency_ms, duration_api_ms, ttft_ms,
          usage_source, request_summary, response_summary, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      call.execution_id ?? null,
      call.task_id ?? null,
      call.agent,
      call.provider ?? null,
      call.model ?? null,
      call.provider_request_id ?? null,
      call.token_usage_json ?? null,
      call.cost_usd ?? null,
      call.latency_ms ?? null,
      call.duration_api_ms ?? null,
      call.ttft_ms ?? null,
      call.usage_source ?? 'unknown',
      call.request_summary ?? null,
      call.response_summary ?? null,
      call.session_id ?? null,
      call.created_at ?? this._now()
    );
    return this.db.prepare('SELECT * FROM model_calls WHERE call_id = ?').get(id) ?? null;
  }

  listModelCalls({ executionId = null, taskId = null, limit = 100 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    if (executionId) {
      return this.db.prepare(
        'SELECT * FROM model_calls WHERE execution_id = ? ORDER BY created_at ASC LIMIT ?'
      ).all(executionId, n);
    }
    if (taskId) {
      return this.db.prepare(
        'SELECT * FROM model_calls WHERE task_id = ? ORDER BY created_at ASC LIMIT ?'
      ).all(taskId, n);
    }
    return this.db.prepare('SELECT * FROM model_calls ORDER BY created_at DESC LIMIT ?').all(n);
  }

  // Copy execution metrics onto the messages a task produced. COALESCE keeps a
  // value that was already known at send time; a later, richer execution row
  // fills only the gaps. Historical rows are never guessed.
  backfillMessageMetrics(taskId, { provider = null, model = null, tokenUsageJson = null, latencyMs = null } = {}) {
    const info = this.db.prepare(
      `UPDATE messages
          SET provider = COALESCE(provider, ?),
              model = COALESCE(model, ?),
              token_usage_json = COALESCE(token_usage_json, ?),
              latency_ms = COALESCE(latency_ms, ?)
        WHERE task_id = ?
          AND (provider IS NULL OR model IS NULL OR token_usage_json IS NULL OR latency_ms IS NULL)`
    ).run(provider, model, tokenUsageJson, latencyMs, taskId);
    return Number(info.changes ?? 0);
  }

  // ------------------------------------------------------- REA Phase 2: agents
  insertAgent(agent) {
    this.db.prepare(
      `INSERT INTO agents
         (id, owner, platform, display_name, profile, color, token_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agent.id,
      agent.owner,
      agent.platform,
      agent.display_name,
      agent.profile ?? null,
      agent.color ?? null,
      agent.token_hash ?? null,
      agent.status ?? 'active',
      Number(agent.created_at) || Date.now()
    );
    return this.getAgent(agent.id);
  }

  getAgent(id) {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) ?? null;
  }

  getAgentByTokenHash(tokenHash) {
    if (!tokenHash) return null;
    return this.db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(tokenHash) ?? null;
  }

  findAgentByName(owner, displayName) {
    return this.db.prepare(
      'SELECT * FROM agents WHERE owner = ? AND display_name = ? COLLATE NOCASE'
    ).get(owner, displayName) ?? null;
  }

  listAgents({ owner = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (owner) { clauses.push('owner = ?'); params.push(owner); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM agents ${where} ORDER BY created_at ASC LIMIT ?`
    ).all(...params, n);
  }

  countActiveOwnedAgents(owner) {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM agents WHERE owner = ? AND status = 'active'"
    ).get(owner);
    return Number(row?.n ?? 0);
  }

  updateAgent(id, patch) {
    const allowed = ['platform', 'display_name', 'profile', 'color', 'token_hash', 'status'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getAgent(id);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE agents SET ${sets} WHERE id = ?`).run(
      ...keys.map((key) => patch[key] ?? null),
      id
    );
    return this.getAgent(id);
  }

  // -------------------------------------------------- REA Phase 2: membership
  insertChatMember({ chat_id: chatId, agent_id: agentId, role = 'member', joined_at: joinedAt = null }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO chat_members (chat_id, agent_id, role, joined_at)
       VALUES (?, ?, ?, ?)`
    ).run(chatId, agentId, role, Number(joinedAt) || Date.now());
    return this.getChatMember(chatId, agentId);
  }

  getChatMember(chatId, agentId) {
    return this.db.prepare(
      'SELECT * FROM chat_members WHERE chat_id = ? AND agent_id = ?'
    ).get(chatId, agentId) ?? null;
  }

  listChatMembers(chatId) {
    return this.db.prepare(
      `SELECT m.*, a.owner, a.platform, a.display_name, a.profile, a.color, a.status
         FROM chat_members m LEFT JOIN agents a ON a.id = m.agent_id
        WHERE m.chat_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at ASC`
    ).all(chatId);
  }

  countChatMembers(chatId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?'
    ).get(chatId);
    return Number(row?.n ?? 0);
  }

  deleteChatMember(chatId, agentId) {
    const info = this.db.prepare(
      'DELETE FROM chat_members WHERE chat_id = ? AND agent_id = ?'
    ).run(chatId, agentId);
    return Number(info.changes ?? 0);
  }

  listChatsForAgent(agentId) {
    return this.db.prepare(
      `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.chat_id
        WHERE m.agent_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`
    ).all(agentId);
  }

  // ------------------------------------------------- REA Phase 2: inbox cursor
  ensureInboxCursor({ chatId, agentId, lastReadSeq = 0, now = Date.now() }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO inbox_cursors
         (chat_id, agent_id, last_read_seq, mentions_you, replies_to_you, from_owner, recalled, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?)`
    ).run(chatId, agentId, Number(lastReadSeq) || 0, Number(now) || Date.now());
    return this.getInboxCursor(chatId, agentId);
  }

  getInboxCursor(chatId, agentId) {
    return this.db.prepare(
      'SELECT * FROM inbox_cursors WHERE chat_id = ? AND agent_id = ?'
    ).get(chatId, agentId) ?? null;
  }

  // Recompute every unread counter from the message stream. Stored counters
  // are a cache; deriving them here keeps a partial read, a recall and a
  // replay from drifting apart.
  recomputeInboxCounts(chatId, agentId, participantId) {
    const cursor = this.ensureInboxCursor({ chatId, agentId });
    const lastRead = Number(cursor.last_read_seq) || 0;
    const rows = this.db.prepare(
      `SELECT id, from_agent, mentions_json, reply_to, recalled_at
         FROM messages WHERE chat_id = ? AND seq > ? AND from_agent <> ?`
    ).all(chatId, lastRead, participantId);
    const ownIds = new Set(this.db.prepare(
      'SELECT id FROM messages WHERE chat_id = ? AND from_agent = ?'
    ).all(chatId, participantId).map((row) => row.id));

    let mentionsYou = 0;
    let repliesToYou = 0;
    let fromOwner = 0;
    let recalled = 0;
    for (const row of rows) {
      let mentions = [];
      try {
        mentions = JSON.parse(row.mentions_json || '[]');
      } catch { /* malformed legacy JSON counts as no mention */ }
      if (Array.isArray(mentions) && mentions.includes(participantId)) mentionsYou += 1;
      if (row.reply_to && ownIds.has(row.reply_to)) repliesToYou += 1;
      if (row.from_agent === 'user' && participantId !== 'user') fromOwner += 1;
      if (row.recalled_at !== null && row.recalled_at !== undefined) recalled += 1;
    }

    this.db.prepare(
      `UPDATE inbox_cursors
          SET mentions_you = ?, replies_to_you = ?, from_owner = ?, recalled = ?, updated_at = ?
        WHERE chat_id = ? AND agent_id = ?`
    ).run(mentionsYou, repliesToYou, fromOwner, recalled, Date.now(), chatId, agentId);
    return {
      chat_id: chatId,
      agent_id: agentId,
      last_read_seq: lastRead,
      unread: rows.length,
      mentions_you: mentionsYou,
      replies_to_you: repliesToYou,
      from_owner: fromOwner,
      recalled
    };
  }

  // P2: exact unread count for the legacy chat_mark_read response. Counting in
  // SQL avoids the old "read at most 500 rows and take their length" truncation.
  countChatMessagesAfter(chatId, afterSeq) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND seq > ?'
    ).get(chatId, Number(afterSeq) || 0);
    return Number(row?.n ?? 0);
  }

  countChatMessagesSince(chatId, sinceIso) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND created_at >= ?'
    ).get(chatId, sinceIso);
    return Number(row?.n ?? 0);
  }

  countUnreadMessages(chatId, participantId, lastReadSeq) {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE chat_id = ? AND seq IS NOT NULL AND seq > ? AND from_agent <> ?`
    ).get(chatId, Number(lastReadSeq) || 0, participantId);
    return Number(row?.n ?? 0);
  }

  maxChatSeq(chatId) {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE chat_id = ?'
    ).get(chatId);
    return Number(row?.m ?? 0);
  }

  markInboxRead(chatId, agentId, upToSeq, participantId) {
    this.ensureInboxCursor({ chatId, agentId });
    this.db.prepare(
      `UPDATE inbox_cursors SET last_read_seq = MAX(last_read_seq, ?), updated_at = ?
        WHERE chat_id = ? AND agent_id = ?`
    ).run(Number(upToSeq) || 0, Date.now(), chatId, agentId);
    return this.recomputeInboxCounts(chatId, agentId, participantId);
  }

  // A delivered task prompt already contains the chat context, so the engine
  // advances that agent's cursor to the chat's current maximum. Everything that
  // arrives after the dispatch remains unread.
  advanceInboxToMax(chatId, agentId, participantId) {
    return this.markInboxRead(chatId, agentId, this.maxChatSeq(chatId), participantId);
  }

  // Only an existing cursor is bumped. Creating one here would make an agent
  // that has never participated look like it has unread mail (and would arm the
  // 409 gate), which is not true until it is actually delivered to or joins.
  bumpInboxCounter(chatId, agentId, field, amount = 1) {
    const allowed = new Set(['mentions_you', 'replies_to_you', 'from_owner', 'recalled']);
    if (!allowed.has(field)) throw new Error(`unknown inbox counter: ${field}`);
    this.db.prepare(
      `UPDATE inbox_cursors SET ${field} = ${field} + ?, updated_at = ?
        WHERE chat_id = ? AND agent_id = ?`
    ).run(Number(amount) || 0, Date.now(), chatId, agentId);
    return this.getInboxCursor(chatId, agentId);
  }

  // ------------------------------------------------- REA Phase 2: pairing codes
  insertPairingCode(code) {
    this.db.prepare(
      `INSERT INTO pairing_codes
         (id, code_hash, owner, max_agents, uses, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      code.id,
      code.code_hash,
      code.owner,
      Number(code.max_agents) || 10,
      Number(code.uses) || 0,
      Number(code.created_at) || Date.now(),
      Number(code.expires_at),
      code.revoked_at ?? null
    );
    return this.getPairingCode(code.id);
  }

  getPairingCode(id) {
    return this.db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id) ?? null;
  }

  getPairingCodeByHash(codeHash) {
    return this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(codeHash) ?? null;
  }

  // Returns 1 only when this agent had not used the code before, so reclaiming
  // the same member does not consume a second slot.
  insertPairingUse(pairingId, agentId) {
    const info = this.db.prepare(
      `INSERT OR IGNORE INTO pairing_code_uses (pairing_id, agent_id, used_at)
       VALUES (?, ?, ?)`
    ).run(pairingId, agentId, Date.now());
    if (Number(info.changes ?? 0) > 0) {
      this.db.prepare('UPDATE pairing_codes SET uses = uses + 1 WHERE id = ?').run(pairingId);
    }
    return Number(info.changes ?? 0);
  }

  countPairingUses(pairingId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM pairing_code_uses WHERE pairing_id = ?'
    ).get(pairingId);
    return Number(row?.n ?? 0);
  }

  hasPairingUse(pairingId, agentId) {
    return Boolean(this.db.prepare(
      'SELECT 1 AS used FROM pairing_code_uses WHERE pairing_id = ? AND agent_id = ?'
    ).get(pairingId, agentId));
  }

  deleteInboxCursor(chatId, agentId) {
    const info = this.db.prepare(
      'DELETE FROM inbox_cursors WHERE chat_id = ? AND agent_id = ?'
    ).run(chatId, agentId);
    return Number(info.changes ?? 0);
  }

  revokePairingCode(id) {
    const info = this.db.prepare(
      'UPDATE pairing_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
    ).run(Date.now(), id);
    return Number(info.changes ?? 0);
  }

  // --------------------------------------------------- REA Phase 2: recall
  recallMessage(id, { recalledBy, placeholder, now = Date.now() }) {
    const existing = this.getMessage(id);
    if (!existing) return null;
    if (existing.recalled_at !== null && existing.recalled_at !== undefined) return existing;
    this.db.prepare(
      `UPDATE messages
          SET recalled_at = ?, recalled_by = ?, body = ?, summary = ?, mentions_json = '[]',
              updated_at = ?
        WHERE id = ? AND recalled_at IS NULL`
    ).run(now, recalledBy ?? null, placeholder, placeholder, this._now(), id);
    return this.getMessage(id);
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

  // Phase 4 file delete: the registry row and every message reference go in one
  // transaction. The caller removes the stored body (and any extracted copy)
  // and returns the row so the audit line can name it.
  deleteChatFile(fileId) {
    return this._transaction(() => {
      const row = this.getChatFile(fileId);
      if (!row) return null;
      this.db.prepare('DELETE FROM message_files WHERE file_id = ?').run(fileId);
      this.db.prepare('DELETE FROM chat_files WHERE file_id = ?').run(fileId);
      return row;
    });
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

  // ------------------------------------------------- REA Phase 3: wake events
  insertWakeEvent(event) {
    return this._transaction(() => {
      let seq = event.seq;
      if (seq === undefined || seq === null) {
        const maxRow = Number(this.db.prepare(
          'SELECT COALESCE(MAX(seq), 0) AS m FROM wake_events'
        ).get()?.m ?? 0);
        // The counter lives outside wake_events so retention pruning cannot
        // rewind it; MAX(seq) is only the seed for a database that predates
        // the counter (or a caller that inserted an explicit seq).
        const stored = this.db.prepare(
          "SELECT value FROM app_meta WHERE key = 'wake_event_seq'"
        ).get();
        const counter = stored ? Number(stored.value) : null;
        const base = Number.isFinite(counter) ? counter : 0;
        seq = Math.max(base, maxRow) + 1;
        this.db.prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES ('wake_event_seq', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run(String(seq), Date.now());
      }
      const now = Number(event.created_at) || Date.now();
      this.db.prepare(
        `INSERT INTO wake_events
           (id, seq, chat_id, agent_id, kind, message_id, message_seq,
            status, attempts, delivery_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.id,
        seq,
        event.chat_id,
        event.agent_id,
        event.kind,
        event.message_id ?? null,
        event.message_seq ?? null,
        event.status ?? 'pending',
        Number(event.attempts) || 0,
        event.delivery_task_id ?? null,
        now,
        Number(event.updated_at) || now
      );
      return this.getWakeEvent(event.id);
    });
  }

  updateWakeEvent(id, patch) {
    const allowed = ['status', 'attempts', 'delivery_task_id', 'updated_at'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getWakeEvent(id);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE wake_events SET ${sets} WHERE id = ?`).run(
      ...keys.map((key) => patch[key] ?? null),
      id
    );
    return this.getWakeEvent(id);
  }

  getWakeEvent(id) {
    return this.db.prepare('SELECT * FROM wake_events WHERE id = ?').get(id) ?? null;
  }

  listWakeEvents({
    chatIds = null, agentId = null, afterSeq = null, beforeSeq = null,
    kinds = null, status = null, since = null, until = null,
    limit = 100, order = 'asc'
  } = {}) {
    const clauses = [];
    const params = [];
    if (Array.isArray(chatIds)) {
      if (chatIds.length === 0) return [];
      clauses.push(`chat_id IN (${chatIds.map(() => '?').join(', ')})`);
      params.push(...chatIds);
    }
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (afterSeq !== null && afterSeq !== undefined) { clauses.push('seq > ?'); params.push(Number(afterSeq) || 0); }
    if (beforeSeq !== null && beforeSeq !== undefined) { clauses.push('seq <= ?'); params.push(Number(beforeSeq) || 0); }
    if (Array.isArray(kinds) && kinds.length > 0) {
      clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
      params.push(...kinds);
    }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (since !== null && since !== undefined) { clauses.push('created_at >= ?'); params.push(Number(since) || 0); }
    if (until !== null && until !== undefined) { clauses.push('created_at < ?'); params.push(Number(until) || 0); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(5001, Number(limit) || 100));
    const direction = order === 'desc' ? 'DESC' : 'ASC';
    return this.db.prepare(
      `SELECT * FROM wake_events ${where} ORDER BY seq ${direction} LIMIT ?`
    ).all(...params, n);
  }

  lastWakeEvent({ chatId = null, agentId = null } = {}) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM wake_events ${where} ORDER BY seq DESC LIMIT 1`
    ).get(...params) ?? null;
  }

  lastWakeRunAt({ chatId, agentId }) {
    const row = this.db.prepare(
      `SELECT MAX(created_at) AS at FROM wake_events
        WHERE chat_id = ? AND agent_id = ? AND delivery_task_id IS NOT NULL`
    ).get(chatId, agentId);
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  }

  // One wake run per attempt. A retry updates the same event row's attempts
  // counter, so summing attempts counts runs rather than events.
  countWakeAttemptsSince({ chatId = null, agentId = null, since = 0, until = null } = {}) {
    const clauses = ['delivery_task_id IS NOT NULL', 'created_at >= ?'];
    const params = [Number(since) || 0];
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (until !== null && until !== undefined) { clauses.push('created_at < ?'); params.push(Number(until) || 0); }
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN attempts > 0 THEN attempts ELSE 1 END), 0) AS n
         FROM wake_events WHERE ${clauses.join(' AND ')}`
    ).get(...params);
    return Number(row?.n ?? 0);
  }

  countWakeEvents({ chatId = null, agentId = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM wake_events ${where}`).get(...params)?.n ?? 0);
  }

  // Highest seq ever assigned, not merely the highest one still retained. An
  // empty table after pruning must not look like "start over at 0".
  maxWakeEventSeq() {
    const max = Number(this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM wake_events'
    ).get()?.m ?? 0);
    const stored = this.db.prepare(
      "SELECT value FROM app_meta WHERE key = 'wake_event_seq'"
    ).get();
    const counter = stored ? Number(stored.value) : 0;
    return Math.max(max, Number.isFinite(counter) ? counter : 0);
  }

  // Rows a wake task is currently responsible for. Used by restart
  // reconciliation to settle runs whose onTaskFinished hook was lost.
  listInFlightWakeEvents() {
    return this.db.prepare(
      "SELECT * FROM wake_events WHERE delivery_task_id IS NOT NULL AND status = 'delivered'"
    ).all();
  }

  minWakeEventSeq() {
    const row = this.db.prepare('SELECT MIN(seq) AS m FROM wake_events').get();
    return row?.m === null || row?.m === undefined ? null : Number(row.m);
  }

  pruneWakeEvents(before) {
    const info = this.db.prepare('DELETE FROM wake_events WHERE created_at < ?').run(Number(before) || 0);
    return Number(info.changes ?? 0);
  }

  // ------------------------------------ REA Phase 3 leftover: unread-@ notices
  // P2: every mention past the unread window that has not been notified yet.
  // Keyset-paged by (created_at, id) so an old event can never be hidden
  // behind a fixed row limit. Read cursors are applied by the caller because
  // they live per (chat, agent).
  listUnnotifiedMentionWakeEvents({
    cutoff, statuses = [], limit = 500, afterCreatedAt = null, afterId = null
  } = {}) {
    if (!Array.isArray(statuses) || statuses.length === 0) return [];
    const clauses = [
      "w.kind = 'mention'",
      'w.created_at <= ?',
      `w.status IN (${statuses.map(() => '?').join(', ')})`,
      'NOT EXISTS (SELECT 1 FROM wake_unread_notices n WHERE n.event_id = w.id)'
    ];
    const params = [Number(cutoff) || 0, ...statuses];
    if (afterCreatedAt !== null && afterCreatedAt !== undefined) {
      clauses.push('(w.created_at > ? OR (w.created_at = ? AND w.id > ?))');
      params.push(Number(afterCreatedAt) || 0, Number(afterCreatedAt) || 0, String(afterId ?? ''));
    }
    const n = Math.max(1, Math.min(1000, Number(limit) || 500));
    return this.db.prepare(
      `SELECT w.* FROM wake_events w
        WHERE ${clauses.join(' AND ')}
        ORDER BY w.created_at ASC, w.id ASC LIMIT ?`
    ).all(...params, n);
  }

  recordWakeNotice(eventId, at = Date.now()) {
    this.db.prepare(
      `INSERT INTO wake_unread_notices (event_id, notified_at) VALUES (?, ?)
       ON CONFLICT(event_id) DO UPDATE SET notified_at = excluded.notified_at`
    ).run(eventId, Number(at) || Date.now());
  }

  hasWakeNotice(eventId) {
    return Boolean(this.db.prepare(
      'SELECT 1 AS found FROM wake_unread_notices WHERE event_id = ?'
    ).get(eventId));
  }

  // Phase 4: owner notices no longer enter the chat stream. wake_status reads
  // them from this join, newest first, so Inbox can show "待处理提醒".
  listWakeNotices({ chatId = null, agentId = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('w.chat_id = ?'); params.push(chatId); }
    if (agentId) { clauses.push('w.agent_id = ?'); params.push(agentId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(
      `SELECT n.event_id, n.notified_at, w.chat_id, w.agent_id, w.kind, w.message_id,
              w.message_seq, w.status
         FROM wake_unread_notices n JOIN wake_events w ON w.id = n.event_id
         ${where}
        ORDER BY n.notified_at DESC, n.event_id DESC LIMIT ?`
    ).all(...params, n);
  }

  countWakeNotices({ chatId = null, agentId = null } = {}) {
    const clauses = [];
    const params = [];
    if (chatId) { clauses.push('w.chat_id = ?'); params.push(chatId); }
    if (agentId) { clauses.push('w.agent_id = ?'); params.push(agentId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return Number(this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM wake_unread_notices n JOIN wake_events w ON w.id = n.event_id ${where}`
    ).get(...params)?.n ?? 0);
  }

  pruneWakeNotices(before) {
    const info = this.db.prepare(
      'DELETE FROM wake_unread_notices WHERE notified_at < ?'
    ).run(Number(before) || 0);
    return Number(info.changes ?? 0);
  }

  // -------------------------------------------- REA Phase 3: listener sessions
  insertListenerSession(session) {
    const now = Number(session.connected_at) || Date.now();
    this.db.prepare(
      `INSERT INTO listener_sessions
         (id, agent_id, chat_id, last_event_seq, status, connected_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.agent_id,
      session.chat_id ?? null,
      Number(session.last_event_seq) || 0,
      session.status ?? 'connected',
      now,
      Number(session.last_seen_at) || now
    );
    return this.getListenerSession(session.id);
  }

  getListenerSession(id) {
    return this.db.prepare('SELECT * FROM listener_sessions WHERE id = ?').get(id) ?? null;
  }

  updateListenerSession(id, patch) {
    const allowed = ['last_event_seq', 'status', 'last_seen_at', 'chat_id'];
    const keys = Object.keys(patch).filter((key) => allowed.includes(key));
    if (keys.length === 0) return this.getListenerSession(id);
    const sets = keys.map((key) => `${key} = ?`).join(', ');
    this.db.prepare(`UPDATE listener_sessions SET ${sets} WHERE id = ?`).run(
      ...keys.map((key) => patch[key] ?? null),
      id
    );
    return this.getListenerSession(id);
  }

  listListenerSessions({ agentId = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM listener_sessions ${where} ORDER BY last_seen_at DESC LIMIT 200`
    ).all(...params);
  }

  disconnectAllListenerSessions() {
    const info = this.db.prepare(
      'UPDATE listener_sessions SET status = \'disconnected\' WHERE status <> \'disconnected\''
    ).run();
    return Number(info.changes ?? 0);
  }

  // ---------------------------------------------------- REA Phase 3: check-ins
  upsertCheckin({ agent_id: agentId, every_minutes: everyMinutes = 10, last_checkin_at: lastCheckinAt = null,
    consecutive_empty: consecutiveEmpty = 0, updated_at: updatedAt = null } = {}) {
    const now = Number(updatedAt) || Date.now();
    this.db.prepare(
      `INSERT INTO checkins (agent_id, every_minutes, last_checkin_at, consecutive_empty, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         every_minutes = excluded.every_minutes,
         last_checkin_at = excluded.last_checkin_at,
         consecutive_empty = excluded.consecutive_empty,
         updated_at = excluded.updated_at`
    ).run(agentId, Number(everyMinutes) || 10, lastCheckinAt ?? null, Number(consecutiveEmpty) || 0, now);
    return this.getCheckin(agentId);
  }

  getCheckin(agentId) {
    return this.db.prepare('SELECT * FROM checkins WHERE agent_id = ?').get(agentId) ?? null;
  }

  listCheckins() {
    return this.db.prepare('SELECT * FROM checkins ORDER BY updated_at DESC').all();
  }

  // -------------------------------------------------- REA Phase 3: wake config
  getAgentWake(agentId, chatId) {
    return this.db.prepare(
      'SELECT * FROM agent_wake WHERE agent_id = ? AND chat_id = ?'
    ).get(agentId, chatId) ?? null;
  }

  listAgentWake({ agentId = null, chatId = null } = {}) {
    const clauses = [];
    const params = [];
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM agent_wake ${where} ORDER BY agent_id ASC, chat_id ASC`
    ).all(...params);
  }

  upsertAgentWake({
    agent_id: agentId, chat_id: chatId, enabled = true, wake_kinds: wakeKinds = null,
    consecutive_failures: consecutiveFailures = 0, disabled_at: disabledAt = null,
    updated_at: updatedAt = null
  } = {}) {
    const now = Number(updatedAt) || Date.now();
    const kinds = Array.isArray(wakeKinds) ? JSON.stringify(wakeKinds) : (wakeKinds ?? null);
    this.db.prepare(
      `INSERT INTO agent_wake
         (agent_id, chat_id, enabled, wake_kinds, consecutive_failures, disabled_at, updated_at)
       VALUES (?, ?, ?, COALESCE(?, '["mention","reply","owner_post"]'), ?, ?, ?)
       ON CONFLICT(agent_id, chat_id) DO UPDATE SET
         enabled = excluded.enabled,
         wake_kinds = COALESCE(?, agent_wake.wake_kinds),
         consecutive_failures = excluded.consecutive_failures,
         disabled_at = excluded.disabled_at,
         updated_at = excluded.updated_at`
    ).run(
      agentId, chatId, enabled ? 1 : 0, kinds,
      Number(consecutiveFailures) || 0, disabledAt ?? null, now,
      kinds
    );
    return this.getAgentWake(agentId, chatId);
  }

  recordWakeFailure(agentId, chatId, now = Date.now()) {
    this.db.prepare(
      `INSERT INTO agent_wake (agent_id, chat_id, enabled, wake_kinds, consecutive_failures, updated_at)
       VALUES (?, ?, 1, '["mention","reply","owner_post"]', 1, ?)
       ON CONFLICT(agent_id, chat_id) DO UPDATE SET
         consecutive_failures = agent_wake.consecutive_failures + 1,
         updated_at = excluded.updated_at`
    ).run(agentId, chatId, Number(now) || Date.now());
    return this.getAgentWake(agentId, chatId);
  }

  resetWakeFailures(agentId, chatId, now = Date.now()) {
    this.db.prepare(
      `INSERT INTO agent_wake (agent_id, chat_id, enabled, wake_kinds, consecutive_failures, updated_at)
       VALUES (?, ?, 1, '["mention","reply","owner_post"]', 0, ?)
       ON CONFLICT(agent_id, chat_id) DO UPDATE SET
         consecutive_failures = 0,
         disabled_at = NULL,
         updated_at = excluded.updated_at`
    ).run(agentId, chatId, Number(now) || Date.now());
    return this.getAgentWake(agentId, chatId);
  }

  disableAgentWake(agentId, chatId, now = Date.now()) {
    this.db.prepare(
      `INSERT INTO agent_wake
         (agent_id, chat_id, enabled, wake_kinds, consecutive_failures, disabled_at, updated_at)
       VALUES (?, ?, 0, '["mention","reply","owner_post"]',
               COALESCE((SELECT consecutive_failures FROM agent_wake WHERE agent_id = ? AND chat_id = ?), 0), ?, ?)
       ON CONFLICT(agent_id, chat_id) DO UPDATE SET
         enabled = 0,
         disabled_at = excluded.disabled_at,
         updated_at = excluded.updated_at`
    ).run(agentId, chatId, agentId, chatId, Number(now) || Date.now(), Number(now) || Date.now());
    return this.getAgentWake(agentId, chatId);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}