// End-to-end verification of the GUI upload engine against a REAL engine.
//
// Runs the compiled main-process modules (`gui/dist-electron/*.js`) exactly as
// `main.ts` does, with only the Electron `app` object stubbed (the engine client
// touches it for userData paths only). No window, no production data:
//   node scripts/verify-gui-attachments.cjs
//
// It starts an isolated engine child process (own port/data dir/token — the
// production engine on :8080 is never touched), then drives:
//   EngineManager      -> upload_chat_file_init/chunk/complete, read_chat_file,
//                         list_chat_files, send_chat_message, list_chat_messages,
//                         chat_status (participants), mark_chat_read
//   AttachmentService  -> draft intake, <=1 MB chunking, sha256, progress
//
// Evidence: data/gui-attach-verify-<stamp>/verify-result.json + server.log

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const runDir = path.join(root, 'data', `gui-attach-verify-${stamp}`);
const logDir = path.join(runDir, 'logs');
const tempDir = path.join(runDir, 'pending');
const cacheDir = path.join(runDir, 'cache');
const filesDir = path.join(runDir, 'fixtures');
const port = Number(process.env.VERIFY_PORT || 18094);
const token = randomBytes(32).toString('hex');
const baseUrl = `http://127.0.0.1:${port}`;
const serverLogPath = path.join(runDir, 'server.log');

for (const dir of [logDir, tempDir, cacheDir, filesDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// The compiled engine module imports `electron` only for app.getPath/isPackaged.
const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => path.join(runDir, 'userdata')
  }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return electronStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const result = {
  ok: false,
  started_at: new Date().toISOString(),
  run_dir: runDir,
  engine: { port, base_url: baseUrl, production_engine_touched: false, electron_stub: true },
  checks: [],
  uploads: [],
  files: [],
  message: null,
  participants: [],
  mark_read: null,
  errors: []
};

function check(name, ok, detail = '') {
  result.checks.push({ name, ok, detail });
  if (!ok) {
    result.errors.push(`${name}: ${detail}`);
  }
  return ok;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let child = null;

async function startEngine() {
  const out = fs.openSync(serverLogPath, 'a');
  child = spawn('node', ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MCP_PORT: String(port),
      MCP_BEARER_TOKEN: token,
      MCP_DATA_DIR: runDir,
      MCP_DB_PATH: path.join(runDir, 'workbench.db'),
      MCP_LOG_DIR: logDir,
      AGENT_AUTO_DELIVER: '0',
      AGENT_APPROVAL_GATE: '0'
    },
    stdio: ['ignore', out, out]
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
  throw new Error('isolated engine did not become healthy');
}

async function stopEngine() {
  if (child == null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await sleep(500);
}

const { pathToFileURL } = require('node:url');
async function main() {
  const fixtures = await import(pathToFileURL(path.join(__dirname, 'lib', 'chat-file-fixtures.mjs')).href);
  await startEngine();

  process.env.MCP_BEARER_TOKEN = token;
  const { EngineManager } = require('../gui/dist-electron/engine.js');
  const { AttachmentService, formatBytes } = require('../gui/dist-electron/attachments.js');
  const engine = new EngineManager(() => null, { port });
  const attachments = new AttachmentService({ tempDir, cacheDir });

  const status = await engine.status();
  check('isolated engine healthy', status.healthy === true, JSON.stringify(status.state));

  const chat = await engine.createChat('gui-attach-verify');
  const chatId = typeof chat.chat_id === 'string' ? chat.chat_id : chat.chat?.chat_id;
  check('create_chat', typeof chatId === 'string' && chatId.length > 0, String(chatId));

  // Materialize the fixtures on disk, as dialog/drop intake would.
  const samples = fixtures.sampleFixtures();
  const paths = [];
  for (const sample of samples) {
    const target = path.join(filesDir, sample.name);
    fs.writeFileSync(target, sample.data);
    paths.push(target);
  }

  const drafts = await attachments.registerPaths(paths, 'dialog');
  check('register drafts', drafts.length === samples.length, `${drafts.length}/${samples.length}`);

  const progress = [];
  const uploadId = `verify-${Date.now()}`;
  const uploaded = await attachments.upload({
    chatId,
    draftIds: drafts.map((draft) => draft.draftId),
    uploadId,
    engine,
    onProgress: (item) => progress.push(item)
  });
  check(
    'chunked upload completes',
    uploaded.errors.length === 0 && uploaded.files.length === samples.length,
    `${uploaded.files.length}/${samples.length}, errors=${JSON.stringify(uploaded.errors)}`
  );

  const byName = new Map(uploaded.files.map((file) => [file.name, file]));
  for (const sample of samples) {
    const file = byName.get(sample.name);
    const expectedSha = createHash('sha256').update(sample.data).digest('hex');
    const okSha = file != null && file.sha256 === expectedSha;
    check(
      `upload ${sample.name}`,
      file != null && okSha,
      file == null ? 'missing' : `sha=${okSha}, status=${file.status}, id=${file.file_id}`
    );
    if (file != null) {
      result.uploads.push({
        name: file.name,
        file_id: file.file_id,
        size: file.size,
        sha256: file.sha256,
        status: file.status,
        kind: file.kind
      });
    }
  }

  // Progress must be monotonic per file and cover the >1 MB file in chunks.
  for (const draft of drafts) {
    const events = progress.filter((item) => item.draftId === draft.draftId);
    let last = -1;
    let monotonic = true;
    for (const event of events) {
      if (event.percent < last) monotonic = false;
      last = event.percent;
    }
    const chunks = events.filter((item) => item.phase === 'chunk').length;
    if (draft.size > 1_048_576) {
      check(
        `multi-chunk ${draft.name}`,
        chunks >= 2 && monotonic,
        `${chunks} chunk events, monotonic=${monotonic}`
      );
      const sizes = events
        .filter((item) => item.phase === 'chunk')
        .map((item) => item.uploaded);
      check(
        'chunk size <= 1 MB',
        sizes.every((value, index) => index === 0 || value - sizes[index - 1] <= 1_048_576),
        `progress marks=${sizes.join(',')}`
      );
    }
  }

  // list_chat_files + read_chat_file.
  const listed = await engine.listChatFiles({ chatId });
  check(
    'list_chat_files',
    Array.isArray(listed.files) && listed.files.length === samples.length,
    `${listed.files?.length}`
  );

  const docx = byName.get('sample.docx');
  const docxRead = await engine.readChatFile({ chatId, fileId: docx.file_id });
  check(
    'read docx text',
    typeof docxRead.text === 'string' && docxRead.text.includes('DOCX-FIXTURE-MARKER'),
    String(docxRead.text ?? '').slice(0, 80)
  );

  const zip = byName.get('sample.zip');
  const zipTree = await engine.readChatFile({ chatId, fileId: zip.file_id });
  const zipMember = await engine.readChatFile({ chatId, fileId: zip.file_id, entry: 'notes/readme.txt' });
  check(
    'zip tree + member',
    zipTree.tree != null && String(zipMember.text ?? '').includes('ZIP-FIXTURE-MARKER'),
    `tree=${zipTree.tree != null}, member=${String(zipMember.text ?? '').slice(0, 40)}`
  );

  const png = byName.get('sample.png');
  const fetchedImage = await attachments.fetchBytes({ chatId, fileId: png.file_id, engine });
  const sourcePng = samples.find((sample) => sample.name === 'sample.png').data;
  check(
    'image preview bytes',
    fetchedImage.bytes.equals(sourcePng),
    `${formatBytes(fetchedImage.bytes.length)} vs ${formatBytes(sourcePng.length)}`
  );
  const fetchedText = await attachments.fetchBytes({ chatId, fileId: docx.file_id, engine });
  check(
    'document preview is extracted text',
    fetchedText.extracted === true,
    `extracted=${fetchedText.extracted}, mime=${fetchedText.mime}`
  );

  // Participants: user + muse before any agent is mentioned.
  const before = await engine.chatParticipants(chatId);
  const participantIds = (list) =>
    (list ?? []).map((item) => String(item.participant_id ?? item.id ?? ''));
  check(
    'participants initially user+muse',
    Array.isArray(before.participants) && before.participants.length === 2,
    participantIds(before.participants).join(',')
  );

  // Message contract: files + mentions + clientMsgId. The send response is the
  // slim {message_id, seq, ...} shape; mentions/files are verified through the
  // message stream the composer reads.
  const clientMsgId = `verify-${Date.now()}`;
  const sent = await engine.sendChatMessage({
    chatId,
    from: 'user',
    to: 'muse',
    summary: '请 @claude @dsh 查看这些附件',
    files: uploaded.files.map((file) => file.file_id),
    mentions: ['claude', 'dsh'],
    clientMsgId
  });
  const messageId = typeof sent.message_id === 'string' ? sent.message_id : null;
  check(
    'send accepts files+mentions+clientMsgId',
    messageId != null && typeof sent.seq === 'number' && sent.to === 'muse',
    `id=${messageId}, seq=${String(sent.seq)}, to=${String(sent.to)}`
  );

  const stream = await engine.listChatMessages({ chatId, limit: 200 });
  const streamMessages = Array.isArray(stream.messages) ? stream.messages : [];
  const sentRow = streamMessages.find((item) => item.message_id === messageId);
  check(
    'message carries files and mentions',
    sentRow != null &&
      Array.isArray(sentRow.mentions) &&
      sentRow.mentions.includes('claude') &&
      sentRow.mentions.includes('dsh') &&
      Array.isArray(sentRow.files) &&
      sentRow.files.length === uploaded.files.length,
    sentRow == null ? 'message not in stream' : `mentions=${JSON.stringify(sentRow.mentions)}, files=${sentRow.files?.length}`
  );

  // Idempotency: the same client_msg_id must not create a second message.
  const replay = await engine.sendChatMessage({
    chatId,
    from: 'user',
    to: 'muse',
    summary: '请 @claude @dsh 查看这些附件',
    files: uploaded.files.map((file) => file.file_id),
    mentions: ['claude', 'dsh'],
    clientMsgId
  });
  const streamAfterReplay = await engine.listChatMessages({ chatId, limit: 200 });
  const replayRows = (streamAfterReplay.messages ?? []).filter((item) => item.message_id === messageId);
  check(
    'clientMsgId is idempotent',
    replay.deduplicated === true && replay.message_id === messageId && replayRows.length === 1,
    `deduplicated=${String(replay.deduplicated)}, rows=${replayRows.length}`
  );
  result.message = {
    message_id: messageId,
    seq: sent.seq ?? null,
    mentions: sentRow?.mentions ?? null,
    files: sentRow?.files ?? null,
    deduplicated: replay.deduplicated === true
  };

  // reply_to: only a message addressed to the sender can be answered, so Muse
  // answers first and the user replies to that Muse message.
  const museReply = await engine.sendChatMessage({
    chatId,
    from: 'muse',
    to: 'user',
    summary: '收到，正在查看附件。',
    replyTo: messageId,
    clientMsgId: `${clientMsgId}-muse`
  });
  const replied = await engine.sendChatMessage({
    chatId,
    from: 'user',
    to: 'muse',
    summary: '补充：先看表格。',
    replyTo: museReply.message_id,
    clientMsgId: `${clientMsgId}-reply`
  });
  check(
    'reply_to accepted',
    typeof replied.message_id === 'string' && replied.message_id !== museReply.message_id,
    `muse=${museReply.message_id}, reply=${replied.message_id}`
  );

  // seq cursor: after_seq only returns newer messages.
  const all = await engine.listChatMessages({ chatId, limit: 200 });
  const messages = Array.isArray(all.messages) ? all.messages : [];
  const lastSeq = messages.reduce((max, item) => Math.max(max, Number(item.seq) || 0), 0);
  const incremental = await engine.listChatMessages({ chatId, limit: 200, afterSeq: Math.max(0, lastSeq - 1) });
  const newer = Array.isArray(incremental.messages) ? incremental.messages : [];
  check(
    'seq cursor',
    lastSeq > 0 && newer.every((item) => Number(item.seq) > lastSeq - 1),
    `last_seq=${lastSeq}, newer=${newer.length}`
  );

  // Participants after mentions: all four.
  const after = await engine.chatParticipants(chatId);
  result.participants = (after.participants ?? []).map((item) =>
    String(item.participant_id ?? item.id ?? '')
  );
  check('participants after mentions = 4', result.participants.length === 4, result.participants.join(','));

  // mark_chat_read is a backend gap today; record it honestly, not as a pass.
  try {
    const marked = await engine.chatMarkRead({ chatId, upToSeq: lastSeq });
    result.mark_read = { ok: true, data: marked };
    check('mark_chat_read', true, JSON.stringify(marked));
  } catch (error) {
    result.mark_read = {
      ok: false,
      pending: 'backend tool mark_chat_read is not registered yet',
      error: error.message
    };
  }

  result.files = listed.files;
  result.ok = true;
}

main()
  .catch((error) => {
    result.errors.push(error.stack || error.message);
  })
  .finally(async () => {
    await stopEngine();
    result.finished_at = new Date().toISOString();
    if (result.ok && result.errors.length > 0) {
      result.ok = false;
    }
    const resultPath = path.join(runDir, 'verify-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    const summary = {
      ok: result.ok,
      result_path: resultPath,
      checks: result.checks,
      uploads: result.uploads,
      participants: result.participants,
      mark_read: result.mark_read,
      errors: result.errors
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () => process.exit(result.ok ? 0 : 1));
  });
