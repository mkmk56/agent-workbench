// Verification for the chat file service (src/files.js + the file MCP tools).
//
// Runs a REAL engine in an isolated child process: its own port, data dir, DB
// and bearer token, and never touches the production engine on :8080.
//
// It proves the contract the GUI upload engine codes against:
//   1. upload_chat_file_init / _chunk / _complete exist and enforce the
//      1 MB chunk cap and the ordered-chunk rule;
//   2. a PDF / DOCX / XLSX / ZIP sample each parses to text after upload;
//   3. read_chat_file returns that text; a ZIP returns a tree and one member;
//   4. an image returns MCP image content (the preview path);
//   5. read_chat_file is callable by all three participants — the master
//      (Muse/user coordinator), claude and dsh — for the same file;
//   6. a file cannot be read through a different chat_id (chat isolation).
//
// Run: node scripts/verify-chat-files.mjs
// Evidence: data/chat-files-verify-<stamp>/verify-result.json + server.log

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deriveAgentToken } from '../src/auth.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const runDir = join(root, 'data', `chat-files-verify-${stamp}`);
const logDir = join(runDir, 'logs');
const port = Number(process.env.VERIFY_PORT || 18093);
const token = randomBytes(32).toString('hex');
const claudeToken = deriveAgentToken(token, 'claude');
const dshToken = deriveAgentToken(token, 'dsh');
const baseUrl = `http://127.0.0.1:${port}`;
const serverLogPath = join(runDir, 'server.log');
const CHUNK_LIMIT = 1024 * 1024;

mkdirSync(logDir, { recursive: true });

const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: { port, base_url: baseUrl, in_process: false, production_engine_touched: false },
  tools: [],
  fixtures: [],
  parse: [],
  reads: [],
  three_party_access: [],
  zip: null,
  isolation: null,
  chunk_limits: [],
  errors: []
};

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  result.checks = checks;
  if (!ok) result.errors.push(`${name}: ${detail}`);
  return ok;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// Fixtures. Minimal but spec-valid files so the real parsers do the work.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Store-only ZIP writer (readZipEntries supports method 0 and 8). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); // external attrs: no symlink
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += locals.at(-1).length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${object}\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function makeDocx(text) {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" '
        + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        + 'Target="word/document.xml"/></Relationships>'
    },
    {
      name: 'word/document.xml',
      data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    }
  ]);
}

function makeXlsx(cell) {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/></Types>'
    },
    {
      name: 'xl/sharedStrings.xml',
      data: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<si><t>${cell}</t></si></sst>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
    }
  ]);
}

function makeZipSample() {
  return makeZip([
    { name: 'notes/readme.txt', data: 'ZIP-FIXTURE-MARKER inside the archive\n' },
    { name: 'data/values.csv', data: 'a,b\n1,2\n' }
  ]);
}

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

const fixtures = [
  { name: 'sample.pdf', mime: 'application/pdf', data: makePdf('PDF-FIXTURE-MARKER hello pdf') },
  { name: 'sample.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: makeDocx('DOCX-FIXTURE-MARKER hello docx') },
  { name: 'sample.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: makeXlsx('XLSX-FIXTURE-MARKER') },
  { name: 'sample.zip', mime: 'application/zip', data: makeZipSample() },
  { name: 'sample.png', mime: 'image/png', data: PNG_1X1 },
  {
    name: 'large.txt',
    mime: 'text/plain',
    data: Buffer.from(`LARGE-FIXTURE-MARKER\n${'chunk-data-0123456789\n'.repeat(120000)}`, 'utf8')
  }
];

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

let child = null;

async function startEngine() {
  const fd = openSync(serverLogPath, 'a');
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_BEARER_TOKEN: token,
      WORKBENCH_LEGACY_MASTER_ALLOW_MUSE: '1',
      WORKBENCH_CREDENTIAL_DIR: join(runDir, 'credentials'),
      WORKBENCH_WORKSPACE_DIR: join(runDir, 'workspace'),
      WORKBENCH_ENV_FILE: join(runDir, 'engine.env'),
      MCP_DATA_DIR: runDir,
      MCP_DB_PATH: join(runDir, 'workbench.db'),
      MCP_LOG_DIR: logDir,
      AGENT_AUTO_DELIVER: '0',
      AGENT_APPROVAL_GATE: '0'
    },
    stdio: ['ignore', fd, fd]
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('engine did not become healthy');
}

async function stopEngine() {
  if (child == null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGKILL');
  }
}

function textOf(raw) {
  return (raw?.content ?? []).map((item) => item.text ?? '').join('\n');
}

async function connect(label, bearer) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } }
  });
  const client = new Client({ name: `aw-chat-files-verify-${label}`, version: '0.0.1' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  const text = textOf(raw);
  if (raw?.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callError(client, name, args = {}) {
  try {
    const raw = await client.callTool({ name, arguments: args });
    return raw?.isError ? textOf(raw) : null;
  } catch (error) {
    return error.message;
  }
}

// ---------------------------------------------------------------------------
// Upload / read helpers (mirrors what the GUI upload engine will do)
// ---------------------------------------------------------------------------

async function upload(client, chatId, fixture, chunkSize = CHUNK_LIMIT) {
  const init = await call(client, 'upload_chat_file_init', {
    chat_id: chatId,
    name: fixture.name,
    size: fixture.data.length,
    mime: fixture.mime
  });
  if (typeof init.upload_id !== 'string' || init.upload_id.length === 0) {
    throw new Error(`init did not return upload_id: ${JSON.stringify(init)}`);
  }
  const serverChunk = Number(init.chunk_size);
  if (!Number.isFinite(serverChunk) || serverChunk <= 0 || serverChunk > CHUNK_LIMIT) {
    throw new Error(`chunk_size ${init.chunk_size} is not <= 1 MB`);
  }
  const step = Math.min(chunkSize, serverChunk);
  let index = 0;
  for (let offset = 0; offset < fixture.data.length; offset += step) {
    const slice = fixture.data.subarray(offset, Math.min(offset + step, fixture.data.length));
    const progress = await call(client, 'upload_chat_file_chunk', {
      upload_id: init.upload_id,
      index,
      data: slice.toString('base64')
    });
    if (Number(progress.received) !== Math.min(offset + slice.length, fixture.data.length)) {
      throw new Error(`chunk ${index}: received ${progress.received}, expected ${offset + slice.length}`);
    }
    index += 1;
  }
  const completed = await call(client, 'upload_chat_file_complete', { upload_id: init.upload_id });
  completed.__chunks = index;
  completed.__sha256 = createHash('sha256').update(fixture.data).digest('hex');
  return completed;
}

function assertSha(file, fixture) {
  const expected = createHash('sha256').update(fixture.data).digest('hex');
  if (file.sha256 !== expected) throw new Error(`sha256 mismatch: ${file.sha256} != ${expected}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await startEngine();
  check('engine healthy on isolated port', true, baseUrl);

  const master = await connect('master', token);
  const claude = await connect('claude', claudeToken);
  const dsh = await connect('dsh', dshToken);

  // Tool inventory is proven by the calls below; create the chat that owns the
  // files first.
  const created = await call(master, 'create_chat', { name: 'file-verify' });
  const chatId = created.chat_id ?? created.chat?.chat_id;
  check('create_chat returns chat_id', typeof chatId === 'string' && chatId.length > 0, String(chatId));

  const listed = await call(master, 'list_chat_files', { chat_id: chatId });
  check('list_chat_files starts empty', Array.isArray(listed.files) && listed.files.length === 0,
    JSON.stringify(listed).slice(0, 200));

  // 1) Chunk limits: a 1.5 MB chunk must be rejected with an explicit error.
  const bigInit = await call(master, 'upload_chat_file_init', {
    chat_id: chatId,
    name: 'too-big-chunk.bin',
    size: 4 * 1024 * 1024,
    mime: 'application/octet-stream'
  });
  const oversize = await callError(master, 'upload_chat_file_chunk', {
    upload_id: bigInit.upload_id,
    index: 0,
    data: Buffer.alloc(1536 * 1024, 1).toString('base64')
  });
  check('oversized chunk rejected', typeof oversize === 'string' && /1 MB|chunk/i.test(oversize),
    String(oversize).slice(0, 200));
  const outOfOrder = await callError(master, 'upload_chat_file_chunk', {
    upload_id: bigInit.upload_id,
    index: 2,
    data: Buffer.from('x').toString('base64')
  });
  check('out-of-order chunk rejected', typeof outOfOrder === 'string' && /order|index/i.test(outOfOrder),
    String(outOfOrder).slice(0, 200));
  await callError(master, 'upload_chat_file_complete', { upload_id: bigInit.upload_id });
  result.chunk_limits = {
    chunk_size: bigInit.chunk_size,
    oversize_error: oversize,
    out_of_order_error: outOfOrder
  };

  // 2) Upload + parse every fixture.
  const uploaded = new Map();
  for (const fixture of fixtures) {
    const file = await upload(master, chatId, fixture);
    uploaded.set(fixture.name, file);
    const parsed = file.parse_status === 'parsed';
    check(`parse ${fixture.name}`, parsed, `${file.parse_status}: ${file.parse_error ?? ''}`);
    if (fixture.name === 'large.txt') {
      check('large.txt uploaded in >1 chunk', file.__chunks >= 3, `chunks=${file.__chunks}`);
    }
    try {
      assertSha(file, fixture);
      check(`sha256 ${fixture.name}`, true, file.sha256);
    } catch (error) {
      check(`sha256 ${fixture.name}`, false, error.message);
    }
    result.parse.push({
      name: file.name,
      file_id: file.file_id,
      mime: file.mime,
      size: file.size,
      parse_status: file.parse_status,
      chunks: file.__chunks,
      sha256: file.sha256
    });
  }

  const after = await call(master, 'list_chat_files', { chat_id: chatId });
  check('list_chat_files returns every upload', Array.isArray(after.files) && after.files.length === fixtures.length,
    `${after.files?.length} != ${fixtures.length}`);
  result.tools = ['upload_chat_file_init', 'upload_chat_file_chunk', 'upload_chat_file_complete',
    'read_chat_file', 'list_chat_files'];

  // 3) read_chat_file text paths.
  const expectations = {
    'sample.pdf': 'PDF-FIXTURE-MARKER',
    'sample.docx': 'DOCX-FIXTURE-MARKER',
    'sample.xlsx': 'XLSX-FIXTURE-MARKER',
    'large.txt': 'LARGE-FIXTURE-MARKER'
  };
  for (const [name, marker] of Object.entries(expectations)) {
    const file = uploaded.get(name);
    const read = await call(master, 'read_chat_file', { chat_id: chatId, file_id: file.file_id });
    const ok = typeof read.text === 'string' && read.text.includes(marker);
    check(`read text ${name}`, ok, String(read.text ?? '').slice(0, 120));
    result.reads.push({ name, file_id: file.file_id, bytes: read.total_bytes ?? null, ok });
  }

  // ZIP: tree first, then one member.
  const zipFile = uploaded.get('sample.zip');
  const tree = await call(master, 'read_chat_file', { chat_id: chatId, file_id: zipFile.file_id });
  check('zip read returns tree', Array.isArray(tree.tree) || typeof tree.tree === 'object',
    JSON.stringify(tree.tree)?.slice(0, 200));
  const member = await call(master, 'read_chat_file', {
    chat_id: chatId,
    file_id: zipFile.file_id,
    entry: 'notes/readme.txt'
  });
  check('zip member text readable', String(member.text ?? '').includes('ZIP-FIXTURE-MARKER'),
    String(member.text ?? '').slice(0, 120));
  result.zip = { tree: tree.tree, member: member.text };

  // 4) Image content block (the GUI preview path).
  const pngFile = uploaded.get('sample.png');
  const rawImage = await master.callTool({
    name: 'read_chat_file',
    arguments: { chat_id: chatId, file_id: pngFile.file_id }
  });
  const imageBlock = (rawImage.content ?? []).find((item) => item.type === 'image');
  check('image read returns MCP image content', imageBlock != null && imageBlock.mimeType === 'image/png',
    JSON.stringify((rawImage.content ?? []).map((item) => item.type)));

  // 5) Three-party access: master (muse/user), claude and dsh read the same
  //    file. Executors join a chat on their first mention, so mention both
  //    before reading — the same path a real group chat takes.
  await call(master, 'send_chat_message', {
    chat_id: chatId,
    from: 'user',
    to: 'muse',
    summary: 'file verification: @claude @dsh please read sample.docx',
    mentions: ['claude', 'dsh']
  });
  for (const [label, client] of [['master', master], ['claude', claude], ['dsh', dsh]]) {
    try {
      const read = await call(client, 'read_chat_file', {
        chat_id: chatId,
        file_id: uploaded.get('sample.docx').file_id
      });
      const ok = String(read.text ?? '').includes('DOCX-FIXTURE-MARKER');
      result.three_party_access.push({ participant: label, ok, name: read.name });
      check(`three-party read as ${label}`, ok, String(read.text ?? '').slice(0, 80));
    } catch (error) {
      result.three_party_access.push({ participant: label, ok: false, error: error.message });
      check(`three-party read as ${label}`, false, error.message);
    }
  }

  // 6) Chat isolation: the same file_id through another chat must fail.
  const other = await call(master, 'create_chat', { name: 'file-verify-other' });
  const otherId = other.chat_id ?? other.chat?.chat_id;
  const crossChat = await callError(master, 'read_chat_file', {
    chat_id: otherId,
    file_id: uploaded.get('sample.pdf').file_id
  });
  check('cross-chat read rejected', typeof crossChat === 'string' && /belongs to chat|not found/i.test(crossChat),
    String(crossChat).slice(0, 200));
  result.isolation = { other_chat: otherId, cross_chat_error: crossChat };

  result.tool_inventory = { chat_files: [...uploaded.keys()] };
  result.ok = result.errors.length === 0;

  await Promise.all([master.close(), claude.close(), dsh.close()]);
}

try {
  await main();
} catch (error) {
  result.errors.push(error.stack || error.message);
} finally {
  await stopEngine();
  result.finished_at = new Date().toISOString();
  const resultPath = join(runDir, 'verify-result.json');
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  const summary = {
    ok: result.ok,
    result_path: resultPath,
    server_log: serverLogPath,
    checks: result.checks,
    parse: result.parse,
    three_party_access: result.three_party_access,
    isolation: result.isolation,
    errors: result.errors
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () => process.exit(result.ok ? 0 : 1));
}
