import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MESSAGE_COLUMNS = [
  'id', 'thread_id', 'from_agent', 'to_agent', 'task_id', 'reply_to', 'summary', 'files_json',
  'question', 'summary_tokens', 'summary_truncated', 'status', 'delivery_task_id', 'error',
  'is_final', 'created_at', 'updated_at', 'chat_id'
];

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
        chat_id TEXT
      )`;

const TASK_COLUMNS = [
  'id', 'session_id', 'agent', 'cwd', 'prompt', 'state', 'process_state', 'turn_state',
  'blocker', 'created_at', 'updated_at', 'last_activity_at', 'exit_code', 'pid',
  'tokens_json', 'files_modified_json', 'summary', 'timeout_ms', 'stale_after_ms',
  'resume', 'model'
];

const UPDATABLE = new Set(TASK_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at'));

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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_reply_unique ON messages(reply_to) WHERE reply_to IS NOT NULL;
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
      CREATE TABLE IF NOT EXISTS approval_grants (
        thread_id TEXT NOT NULL,
        category TEXT NOT NULL,
        source_approval_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, category)
      );
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        status TEXT DEFAULT 'active',
        last_message_at TEXT,
        last_message_preview TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status, updated_at);
      CREATE TABLE IF NOT EXISTS chat_tasks (
        chat_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (chat_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_tasks_task ON chat_tasks(task_id);
    `);
    this.migrateMessagesForChats();
    this.taskSeq = new Map();
    this.sessionSeq = new Map();
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
          chat_id TEXT
        );
        INSERT INTO messages_chat_migration (${copied.join(', ')})
          SELECT ${copied.join(', ')} FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_chat_migration RENAME TO messages;
        COMMIT;
      `);
    }

    const columnsAfter = this.db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name);
    if (!columnsAfter.includes('chat_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN chat_id TEXT');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_reply_unique ON messages(reply_to) WHERE reply_to IS NOT NULL;
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

  listTasks({ status = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    if (status) {
      return this.db.prepare('SELECT * FROM tasks WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(status, n);
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(n);
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

  insertMessage(message) {
    this.db.prepare(
      `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`
    ).run(...MESSAGE_COLUMNS.map((c) => message[c] ?? null));
  }

  updateMessage(id, patch) {
    const allowed = ['status', 'delivery_task_id', 'error', 'is_final'];
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

  getReply(messageId) {
    return this.db.prepare('SELECT * FROM messages WHERE reply_to = ?').get(messageId) ?? null;
  }

  listMessages({ threadId = null, taskId = null, from = null, to = null, replyTo = null, status = null, chatId = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (threadId) { clauses.push('thread_id = ?'); params.push(threadId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (from) { clauses.push('from_agent = ?'); params.push(from); }
    if (to) { clauses.push('to_agent = ?'); params.push(to); }
    if (replyTo) { clauses.push('reply_to = ?'); params.push(replyTo); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (chatId) { clauses.push('chat_id = ?'); params.push(chatId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...params, n);
  }

  // Chat messages are returned chronologically; `before` pages backwards from a
  // message id or an ISO timestamp. The slice is taken newest-first and then
  // reversed so callers always receive ascending order.
  listChatMessages({ chatId, limit = 50, before = null } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const clauses = ['chat_id = ?'];
    const params = [chatId];
    if (before) {
      const anchor = this.db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before);
      const cursor = anchor?.created_at || String(before);
      clauses.push('created_at < ?');
      params.push(cursor);
    }
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...params, n);
    return rows.reverse();
  }

  // ------------------------------------------------------------------- chats
  insertChat(chat) {
    this.db.prepare(
      `INSERT INTO chats (chat_id, name, created_at, updated_at, status, last_message_at, last_message_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chat.chat_id,
      chat.name,
      chat.created_at ?? this._now(),
      chat.updated_at ?? this._now(),
      chat.status ?? 'active',
      chat.last_message_at ?? null,
      chat.last_message_preview ?? null
    );
    return this.getChat(chat.chat_id);
  }

  getChat(chatId) {
    return this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) ?? null;
  }

  updateChat(chatId, patch) {
    const allowed = ['name', 'status', 'last_message_at', 'last_message_preview'];
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

  listChats({ status = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = status
      ? this.db.prepare(
        'SELECT * FROM chats WHERE status = ? ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?'
      ).all(status, n)
      : this.db.prepare(
        'SELECT * FROM chats ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?'
      ).all(n);
    return rows;
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
  // message at or after it.
  chatNeedsMuse(chatId) {
    const lastUser = this.db.prepare(
      "SELECT MAX(created_at) AS ts FROM messages WHERE chat_id = ? AND from_agent = 'user'"
    ).get(chatId)?.ts ?? null;
    if (!lastUser) return false;
    const lastMuse = this.db.prepare(
      "SELECT MAX(created_at) AS ts FROM messages WHERE chat_id = ? AND from_agent = 'muse'"
    ).get(chatId)?.ts ?? null;
    if (!lastMuse) return true;
    return String(lastUser) > String(lastMuse);
  }

  lastChatMessage(chatId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(chatId) ?? null;
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

  listApprovals({ threadId = null, taskId = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (threadId) { clauses.push('thread_id = ?'); params.push(threadId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM approvals ${where} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...params, n);
  }

  addApprovalGrant(threadId, category, sourceApprovalId) {
    this.db.prepare(
      `INSERT INTO approval_grants (thread_id, category, source_approval_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id, category) DO UPDATE SET
         source_approval_id = excluded.source_approval_id,
         created_at = excluded.created_at`
    ).run(threadId, category, sourceApprovalId ?? null, this._now());
  }

  getApprovalGrant(threadId, category) {
    return this.db.prepare(
      'SELECT * FROM approval_grants WHERE thread_id = ? AND category = ?'
    ).get(threadId, category) ?? null;
  }

  listApprovalGrants(threadId) {
    return this.db.prepare(
      'SELECT * FROM approval_grants WHERE thread_id = ? ORDER BY created_at ASC'
    ).all(threadId);
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