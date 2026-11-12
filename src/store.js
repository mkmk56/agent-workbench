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

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}