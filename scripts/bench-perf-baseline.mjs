#!/usr/bin/env node
// Performance baseline for REFACTOR_PLAN §4.
//
// Read-only against the production database: the engine keeps serving while
// this runs. Nothing is written to data/ or to the live database. Fixture files
// for the attachment dimension are parsed inside a throwaway temp directory.
//
// Usage:
//   node scripts/bench-perf-baseline.mjs [--db data/workbench.db] [--server-log logs/server.log] [--json out.json]

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { FileService } from '../src/files.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dbPath = resolve(root, argOf('--db', 'data/workbench.db'));
const serverLogPath = resolve(root, argOf('--server-log', 'logs/server.log'));
const jsonOut = argOf('--json', null);

function stats(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return { n: 0 };
  const sum = clean.reduce((acc, value) => acc + value, 0);
  const at = (p) => clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(p * clean.length) - 1))];
  return {
    n: clean.length,
    mean: round(sum / clean.length),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(clean[0]),
    max: round(clean[clean.length - 1])
  };
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        total += statSync(path).size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

// --------------------------------------------------------------- DB snapshot
const db = new DatabaseSync(dbPath, { readOnly: true });
const dbBytes = statSync(dbPath).size;
const dataDir = dirname(dbPath);
const dataSize = dirSize(dataDir);
const logsRows = Number(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n);
const logsBytes = Number(db.prepare(
  'SELECT COALESCE(SUM(LENGTH(line) + LENGTH(ts) + LENGTH(stream) + 24), 0) AS n FROM logs'
).get().n);
const messagesRows = Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
const tasksRows = Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n);

// --------------------------------------------------------- tool latency (log)
const toolDurations = new Map();
try {
  for (const line of readFileSync(serverLogPath, 'utf8').split(/\r?\n/)) {
    const match = /^tool=(\S+) .*duration_ms=(\d+)/.exec(line);
    if (!match) continue;
    if (!toolDurations.has(match[1])) toolDurations.set(match[1], []);
    toolDurations.get(match[1]).push(Number(match[2]));
  }
} catch { /* log not present */ }

// ------------------------------------------------------ model latency (logs)
const modelCalls = [];
for (const row of db.prepare(
  "SELECT task_id, line FROM logs WHERE stream = 'stdout' AND line LIKE '%\"type\":\"result\"%'"
).all()) {
  let event;
  try { event = JSON.parse(row.line.slice(row.line.indexOf('{'))); } catch { continue; }
  if (event?.type !== 'result') continue;
  const models = Object.keys(event.modelUsage ?? {});
  modelCalls.push({
    task_id: row.task_id,
    model: models[0] ?? null,
    ttft_ms: Number(event.ttft_ms ?? event.ttft_stream_ms ?? NaN),
    duration_ms: Number(event.duration_ms ?? NaN),
    duration_api_ms: Number(event.duration_api_ms ?? NaN),
    cost_usd: Number(event.total_cost_usd ?? NaN),
    is_error: Boolean(event.is_error)
  });
}

// ------------------------------------------- dispatch / queue wait (real rows)
const dispatchLatency = [];
for (const row of db.prepare(`
  SELECT m.created_at AS message_created, t.created_at AS task_created
    FROM task_threads tt
    JOIN tasks t ON t.id = tt.task_id
    JOIN messages m ON m.id = tt.origin_message_id
   WHERE t.created_at >= m.created_at
`).all()) {
  dispatchLatency.push((Date.parse(row.task_created) - Date.parse(row.message_created)));
}

const queueWait = [];
const attemptRows = db.prepare(
  'SELECT message_id, agent, attempt, status, created_at FROM delivery_attempts ORDER BY message_id, agent, attempt'
).all();
let queueStart = null;
let queueKey = null;
for (const row of attemptRows) {
  const key = `${row.message_id}:${row.agent}`;
  if (key !== queueKey) { queueKey = key; queueStart = null; }
  if (row.status === 'queued') queueStart = Date.parse(row.created_at);
  else if ((row.status === 'delivered' || row.status === 'failed') && Number.isFinite(queueStart)) {
    queueWait.push(Date.parse(row.created_at) - queueStart);
    queueStart = null;
  }
}

// --------------------------------------------------------- query timing (RO)
function timeQuery(sql, params, iterations = 200) {
  const samples = [];
  const stmt = db.prepare(sql);
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    stmt.all(...params);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return stats(samples);
}

const busiest = db.prepare(
  'SELECT chat_id, COUNT(*) AS n FROM messages WHERE chat_id IS NOT NULL GROUP BY chat_id ORDER BY n DESC LIMIT 1'
).get();
const listChatMessages = busiest
  ? timeQuery(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC, created_at DESC, id DESC LIMIT 200',
    [busiest.chat_id]
  )
  : { n: 0 };
const taskList = timeQuery(
  'SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50', [], 200
);
const chatNeedsMuse = busiest
  ? timeQuery(
    "SELECT MAX(seq) AS s FROM messages WHERE chat_id = ? AND from_agent = 'user' AND seq IS NOT NULL",
    [busiest.chat_id]
  )
  : { n: 0 };

// --------------------------------------------- end-to-end handler timing (copy)
// The raw SQL above excludes the per-message file lookup and participant
// aggregation the real handlers perform. Measure those on a throwaway copy so
// the live database is never opened read-write.
const handlerTimings = {};
const copyRoot = mkdtempSync(join(tmpdir(), 'aw-bench-db-'));
try {
  const copyPath = join(copyRoot, 'workbench-copy.db');
  db.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
  const { ChatService } = await import('../src/chats.js');
  const { MessageService } = await import('../src/messages.js');
  const copyStore = new Store(copyPath, copyRoot);
  const copyConfig = {
    dataDir: copyRoot, chatFilesDir: join(copyRoot, 'chat-files'), agentMessageLimit: 10,
    agentSummaryMaxTokens: 500, chatTerminalStatusTtlMs: 60000, museLeaseTtlMs: 300000,
    chatContextTokenBudget: 6000, chatContextMessageLimit: 30
  };
  const copyMessages = new MessageService({ store: copyStore, scheduler: null, config: copyConfig });
  const copyChats = new ChatService({ store: copyStore, messages: copyMessages, config: copyConfig });
  const busiestId = busiest?.chat_id;
  if (busiestId) {
    const samples = [];
    for (let i = 0; i < 100; i += 1) {
      const started = process.hrtime.bigint();
      copyChats.listMessages({ chat_id: busiestId, limit: 200 });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    handlerTimings.list_chat_messages_200 = stats(samples);
    const statusSamples = [];
    for (let i = 0; i < 100; i += 1) {
      const started = process.hrtime.bigint();
      copyChats.status(busiestId);
      statusSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    handlerTimings.chat_status = stats(statusSamples);
  }
  const listSamples = [];
  for (let i = 0; i < 100; i += 1) {
    const started = process.hrtime.bigint();
    const tasks = copyStore.listTasks({ limit: 50 });
    for (const task of tasks) {
      copyStore.getThreadForTask(task.id);
      copyStore.getChatForTask(task.id);
      // P1-5 adds one indexed execution lookup per task to statusPayload().
      copyStore.getExecutionForTask?.(task.id);
    }
    listSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  handlerTimings.task_list_50 = stats(listSamples);
  copyStore.close();
} catch (error) {
  handlerTimings.error = error.message;
} finally {
  try { rmSync(copyRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ------------------------------------------------------------ file parse cost
function makeStoredZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function fixturePdf(paragraphs = 200) {
  const lines = [];
  for (let i = 0; i < paragraphs; i += 1) {
    lines.push(`(Paragraph ${i}: the quick brown fox jumps over the lazy dog.) Tj T*`);
  }
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td\n${lines.join('\n')}\nET`, 'latin1');
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj',
    `4 0 obj<</Length ${content.length}>>stream\n${content.toString('latin1')}\nendstream endobj`
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('\n')}\ntrailer<</Root 1 0 R>>\n%%EOF`, 'latin1');
}

function fixtureDocx(paragraphs = 2000) {
  const body = Array.from({ length: paragraphs }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i} of the fixture document.</w:t></w:r></w:p>`).join('');
  return makeStoredZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`]
  ]);
}

function fixtureXlsx(rows = 5000) {
  const shared = Array.from({ length: 200 }, (_, i) => `<si><t>column value ${i}</t></si>`).join('');
  const sheetRows = Array.from({ length: rows }, (_, r) => {
    const cells = Array.from({ length: 8 }, (_, c) => `<c t="s"><v>${(r * 8 + c) % 200}</v></c>`).join('');
    return `<row>${cells}</row>`;
  }).join('');
  return makeStoredZip([
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst>${shared}</sst>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`]
  ]);
}

function fixtureZip(files = 100) {
  return makeStoredZip(Array.from({ length: files }, (_, i) => [`dir/file-${i}.txt`, `file ${i}\n`.repeat(200)]));
}

function fixturePng() {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(256 * 1024, 0x42);
  return Buffer.concat([header, body]);
}

const fileResults = {};
const tempRoot = mkdtempSync(join(tmpdir(), 'aw-bench-files-'));
try {
  const config = {
    dataDir: tempRoot, chatFilesDir: join(tempRoot, 'chat-files'), chatMaxFileBytes: 20 * 1024 * 1024,
    chatUploadChunkBytes: 1024 * 1024, chatZipMaxFiles: 200, chatZipMaxDepth: 5,
    chatZipMaxTotalBytes: 50 * 1024 * 1024, chatZipMaxEntryBytes: 10 * 1024 * 1024
  };
  const store = new Store(join(tempRoot, 'bench.db'), tempRoot);
  const chatId = 'bench-chat';
  const now = new Date().toISOString();
  store.insertChat({ chat_id: chatId, name: 'bench', created_at: now, updated_at: now, status: 'active' });
  const files = new FileService({ store, config });
  const fixtures = {
    pdf: { name: 'fixture.pdf', buffer: fixturePdf() },
    docx: { name: 'fixture.docx', buffer: fixtureDocx() },
    xlsx: { name: 'fixture.xlsx', buffer: fixtureXlsx() },
    zip: { name: 'fixture.zip', buffer: fixtureZip() },
    png: { name: 'fixture.png', buffer: fixturePng() },
    text: { name: 'fixture.txt', buffer: Buffer.from('quick brown fox\n'.repeat(30000)) }
  };
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const samples = [];
    let status = null;
    for (let i = 0; i < 5; i += 1) {
      const init = files.initUpload({ chat_id: chatId, name: fixture.name, size: fixture.buffer.length, uploader: 'user' });
      files.appendChunk({ upload_id: init.upload_id, index: 0, data: fixture.buffer.toString('base64'), uploader: 'user' });
      const started = process.hrtime.bigint();
      const result = files.completeUpload({ upload_id: init.upload_id, uploader: 'user' });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      status = result.parse?.status ?? null;
    }
    fileResults[kind] = { bytes: fixture.buffer.length, parse_status: status, ...stats(samples) };
  }
  store.close();
} finally {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --------------------------------------------------------------------- output
const report = {
  generated_at: new Date().toISOString(),
  source: { db: dbPath, server_log: serverLogPath },
  db: {
    file_bytes: dbBytes,
    data_dir_bytes: dataSize.bytes,
    data_dir_files: dataSize.files,
    logs_rows: logsRows,
    logs_approx_bytes: logsBytes,
    messages_rows: messagesRows,
    tasks_rows: tasksRows,
    page_count: Number(db.prepare('PRAGMA page_count').get().page_count),
    page_size: Number(db.prepare('PRAGMA page_size').get().page_size)
  },
  api_latency_ms: Object.fromEntries(
    [...toolDurations.entries()]
      .map(([tool, values]) => [tool, stats(values)])
      .sort((a, b) => b[1].n - a[1].n)
  ),
  model: {
    total_result_events: modelCalls.length,
    ttft_ms: stats(modelCalls.map((call) => call.ttft_ms)),
    duration_ms: stats(modelCalls.map((call) => call.duration_ms)),
    duration_api_ms: stats(modelCalls.map((call) => call.duration_api_ms)),
    cost_usd: stats(modelCalls.map((call) => call.cost_usd)),
    by_model: Object.fromEntries(
      [...new Set(modelCalls.map((call) => call.model ?? 'unknown'))].map((model) => {
        const subset = modelCalls.filter((call) => (call.model ?? 'unknown') === model);
        return [model, {
          n: subset.length,
          ttft_ms: stats(subset.map((call) => call.ttft_ms)),
          duration_ms: stats(subset.map((call) => call.duration_ms))
        }];
      })
    )
  },
  dispatch: {
    samples: stats(dispatchLatency),
    queue_wait_ms: stats(queueWait)
  },
  queries_ms: { list_chat_messages_200: listChatMessages, task_list_50: taskList, chat_needs_muse: chatNeedsMuse },
  handlers_ms: handlerTimings,
  attachments: fileResults
};

db.close();
const text = JSON.stringify(report, null, 2);
if (jsonOut) writeFileSync(resolve(root, jsonOut), text, 'utf8');
console.log(text);