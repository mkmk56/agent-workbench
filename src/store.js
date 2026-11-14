import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        task_id TEXT NOT NULL,
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
        updated_at TEXT NOT NULL
      );
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
    `);
    this.taskSeq = new Map();
    this.sessionSeq = new Map();
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
    const columns = [
      'id', 'thread_id', 'from_agent', 'to_agent', 'task_id', 'reply_to', 'summary', 'files_json',
      'question', 'summary_tokens', 'summary_truncated', 'status', 'delivery_task_id', 'error',
      'is_final', 'created_at', 'updated_at'
    ];
    this.db.prepare(
      `INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...columns.map((c) => message[c] ?? null));
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

  listMessages({ threadId = null, taskId = null, from = null, to = null, replyTo = null, status = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (threadId) { clauses.push('thread_id = ?'); params.push(threadId); }
    if (taskId) { clauses.push('task_id = ?'); params.push(taskId); }
    if (from) { clauses.push('from_agent = ?'); params.push(from); }
    if (to) { clauses.push('to_agent = ?'); params.push(to); }
    if (replyTo) { clauses.push('reply_to = ?'); params.push(replyTo); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare(
      `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(...params, n);
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