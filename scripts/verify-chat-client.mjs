// Frontend client-layer verification for the frozen chat.ts attachment API.
//
// Runs in plain Node: chat.ts imports types only, so TypeScript's transpiler
// turns it into a self-contained CommonJS module. A stubbed `window.workbench`
// stands in for the preload bridge, which lets this test cover the exact calls
// Muse's components make:
//
//   uploadChatFiles(files, onProgress)   -> draft intake -> chunked upload IPC,
//                                           per-index 0..1 progress, file_ids
//   listChatFiles(chatId)                -> normalized ChatFile[]
//   readChatFile(chatId, fileId)         -> { text, truncated }
//   downloadChatFile(chatId, fileId)     -> { savedPath }
//   previewChatFile(chatId, fileId)      -> { url } on chat-attachment://
//   sendChatMessage(... mentions ...)    -> mentions in the send payload
//
// Run: node scripts/verify-chat-client.mjs

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const ts = require(join(root, 'gui', 'node_modules', 'typescript', 'lib', 'typescript.js'));

const result = { ok: false, checks: [], errors: [] };
function check(name, ok, detail = '') {
  result.checks.push({ name, ok, detail });
  if (!ok) result.errors.push(`${name}: ${detail}`);
}

// ---- load chat.ts as CommonJS ------------------------------------------------
const source = readFileSync(join(root, 'gui', 'src', 'lib', 'chat.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true
  },
  fileName: 'chat.ts'
}).outputText;
const dir = mkdtempSync(join(tmpdir(), 'chat-client-'));
const modulePath = join(dir, 'chat.cjs');
writeFileSync(modulePath, compiled);

// ---- bridge stub ------------------------------------------------------------
function makeWorkbench(overrides = {}) {
  const calls = { uploads: [], progressListeners: [], unsubscribed: 0 };
  const workbench = {
    listChats: async () => ({ ok: true, data: { chats: [] } }),
    createChat: async () => ({ ok: false, error: 'unused' }),
    renameChat: async () => ({ ok: false, error: 'unused' }),
    sendChatMessage: async (input) => {
      calls.send = input;
      return {
        ok: true,
        data: { message_id: 'm-' + calls.uploads.length, chat_id: input.chatId, seq: 1 }
      };
    },
    chatStatus: async () => ({ ok: false, error: 'unused' }),
    chatParticipants: async () => ({ ok: true, data: { participants: [] } }),
    chatMarkRead: async () => ({ ok: true, data: { last_read_seq: 0, unread: 0 } }),
    listChatMessages: async () => ({ ok: true, data: { messages: [], next_seq: 0 } }),
    registerChatFiles: async (files, sourceKind) => {
      calls.intake = { count: files.length, sourceKind };
      return {
        ok: true,
        data: {
          drafts: files.map((file, index) => ({
            draftId: `d-${index}`,
            name: file.name,
            size: file.size,
            mime: file.type,
            ext: 'txt',
            kind: 'text',
            source: sourceKind
          }))
        }
      };
    },
    uploadChatFiles: async (input) => {
      calls.uploads.push(input);
      // Emit progress for the first file, then let the call resolve.
      for (const listener of calls.progressListeners) {
        listener({
          uploadId: input.uploadId,
          draftId: input.draftIds[0],
          fileId: null,
          name: 'a.txt',
          size: 100,
          uploaded: 50,
          percent: 50,
          phase: 'chunk'
        });
        listener({
          uploadId: input.uploadId,
          draftId: input.draftIds[0],
          fileId: 'f-1',
          name: 'a.txt',
          size: 100,
          uploaded: 100,
          percent: 100,
          phase: 'done'
        });
      }
      return {
        ok: true,
        data: {
          files: input.draftIds.map((_, index) => ({
            file_id: `f-${index + 1}`,
            name: 'a.txt',
            size: 100,
            mime: 'text/plain',
            kind: 'text',
            status: 'parsed',
            created_at: '2026-11-16T00:00:00.000Z'
          })),
          errors: []
        }
      };
    },
    onChatUploadProgress: (callback) => {
      calls.progressListeners.push(callback);
      return () => {
        calls.unsubscribed += 1;
        calls.progressListeners = calls.progressListeners.filter((item) => item !== callback);
      };
    },
    listChatFiles: async (input) => ({
      ok: true,
      data: {
        chat_id: input.chatId,
        files: [
          {
            file_id: 'f-9',
            name: 'report.pdf',
            mime: 'application/pdf',
            size: 2048,
            parse_status: 'parsed',
            created_at: '2026-11-16T01:00:00.000Z'
          }
        ]
      }
    }),
    readChatFile: async (input) => ({
      ok: true,
      data: {
        file_id: input.fileId,
        name: 'a.txt',
        mime: 'text/plain',
        kind: 'text',
        size: 10,
        mode: 'text',
        content: 'hello text',
        text: 'hello text',
        encoding: 'utf8',
        offset: 0,
        next_offset: null,
        truncated: true
      }
    }),
    downloadChatFile: async (chatId, fileId) => ({
      ok: true,
      data: { savedPath: `C:\\saved\\${chatId}-${fileId}` }
    }),
    previewChatFile: async (chatId, fileId) => ({
      ok: true,
      data: { url: `chat-attachment://file/${chatId}/${fileId}` }
    }),
    openChatFile: async () => ({ ok: true }),
    saveChatFile: async () => ({ ok: true, data: { savedPath: '' } }),
    ...overrides
  };
  return { workbench, calls };
}

function installWindow(workbench, hash = '#/chats/chat-1') {
  globalThis.window = {
    workbench,
    location: { hash }
  };
}

function makeFile(name, size = 10) {
  return { name, size, type: 'text/plain' };
}

// ---- tests ------------------------------------------------------------------
const { workbench, calls } = makeWorkbench();
installWindow(workbench);
const chat = require(modulePath);

// Mentions.
const mentions = chat.parseMentions('hi @claude and @dsh, cc @muse and @你');
check(
  'parseMentions finds every participant',
  mentions.map((item) => item.id).join(',') === 'claude,dsh,muse,user',
  mentions.map((item) => item.id).join(',')
);
check(
  'mentionTargets dedupes',
  chat.mentionTargets('@claude @claude hi').join(',') === 'claude',
  chat.mentionTargets('@claude @claude hi').join(',')
);
check(
  'mentionQueryAt + applyMention',
  chat.mentionQueryAt('hello @cl', 10)?.query === 'cl' &&
    chat.applyMention('hello @cl', 10, { id: 'claude', label: 'Claude' }).text === 'hello @Claude ',
  JSON.stringify(chat.applyMention('hello @cl', 10, { id: 'claude', label: 'Claude' }))
);

// uploadChatFiles: two files, progress per index, ids in order.
const progress = [];
const upload = await chat.uploadChatFiles(
  [makeFile('a.txt'), makeFile('b.txt')],
  (index, value) => progress.push({ index, value })
);
check('uploadChatFiles ok', upload.ok === true, JSON.stringify(upload));
check(
  'uploadChatFiles returns ordered file_ids',
  upload.ok && upload.data.file_ids.join(',') === 'f-1,f-2',
  upload.ok ? upload.data.file_ids.join(',') : 'failed'
);
check(
  'uploadChatFiles resolves chatId from route',
  calls.uploads.length === 1 && calls.uploads[0].chatId === 'chat-1',
  JSON.stringify(calls.uploads[0]?.chatId)
);
check(
  'uploadChatFiles sends the registered drafts',
  calls.uploads[0].draftIds.join(',') === 'd-0,d-1' && calls.intake.count === 2,
  JSON.stringify(calls.intake)
);
check(
  'progress callback is per-index 0..1',
  progress.length >= 3 &&
    progress[0].index === 0 &&
    Math.abs(progress[0].value - 0.5) < 1e-9 &&
    progress.every((item) => item.value >= 0 && item.value <= 1),
  JSON.stringify(progress)
);
check('progress listener unsubscribed', calls.unsubscribed === 1, String(calls.unsubscribed));

// uploadChatFiles without a chat route must fail loudly.
installWindow(makeWorkbench().workbench, '#/chats');
const noChat = await chat.uploadChatFiles([makeFile('x.txt')]);
check(
  'uploadChatFiles requires a chat',
  noChat.ok === false && /群聊/.test(noChat.error ?? ''),
  noChat.ok ? 'unexpected ok' : noChat.error
);

// listChatFiles normalizes to the frozen ChatFile shape.
installWindow(workbench);
const listed = await chat.listChatFiles('chat-1');
check(
  'listChatFiles normalizes ChatFile',
  listed.ok &&
    listed.data.files.length === 1 &&
    listed.data.files[0].file_id === 'f-9' &&
    listed.data.files[0].status === 'parsed' &&
    typeof listed.data.files[0].created_at === 'string',
  JSON.stringify(listed)
);

// readChatFile: frozen (chatId, fileId) form and legacy query form.
const read = await chat.readChatFile('chat-1', 'f-1');
check(
  'readChatFile(chatId, fileId) -> {text, truncated}',
  read.ok && read.data.text === 'hello text' && read.data.truncated === true,
  JSON.stringify(read)
);
const readQuery = await chat.readChatFile({ chatId: 'chat-1', fileId: 'f-1', limit: 1024 });
check(
  'readChatFile(query) keeps the preview shape',
  readQuery.ok && readQuery.data.content === 'hello text',
  JSON.stringify(readQuery)
);

// download / preview.
const downloaded = await chat.downloadChatFile('chat-1', 'f-1');
check(
  'downloadChatFile -> savedPath',
  downloaded.ok && downloaded.data.savedPath.includes('chat-1-f-1'),
  JSON.stringify(downloaded)
);
const preview = await chat.previewChatFile('chat-1', 'f-1');
check(
  'previewChatFile -> chat-attachment URL',
  preview.ok && preview.data.url === 'chat-attachment://file/chat-1/f-1',
  preview.ok ? preview.data.url : preview.error
);

// sendChatMessage carries parsed mentions + a client message id.
const sent = await chat.sendChatMessage({
  chatId: 'chat-1',
  summary: 'please look @claude'
});
check(
  'sendChatMessage carries mentions and clientMsgId',
  sent.ok &&
    Array.isArray(calls.send?.mentions) &&
    calls.send.mentions.includes('claude') &&
    typeof calls.send.clientMsgId === 'string' &&
    calls.send.clientMsgId.length > 0,
  JSON.stringify(calls.send)
);

// Bridge failures surface as errors, never as silent successes.
installWindow(
  makeWorkbench({
    uploadChatFiles: async () => ({ ok: false, error: '引擎拒绝上传' })
  }).workbench
);
const failed = await chat.uploadChatFiles([makeFile('z.txt')]);
check(
  'upload failure is surfaced',
  failed.ok === false && failed.error.includes('引擎拒绝上传'),
  failed.ok ? 'unexpected ok' : failed.error
);

result.ok = result.errors.length === 0;
const summary = { ok: result.ok, checks: result.checks, errors: result.errors };
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, () =>
  process.exit(result.ok ? 0 : 1)
);
