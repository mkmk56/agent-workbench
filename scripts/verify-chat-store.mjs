// Verification for the single ChatStore (gui/src/lib/chat-store.ts).
//
// The store is transpiled to CommonJS next to the GUI's node_modules so its
// `react` import resolves, then driven directly: setActiveChat -> first page,
// fetchMessages -> incremental page via the seq cursor. This proves the
// "one store + after_seq incremental poll" requirement without a browser.
//
// Run: node scripts/verify-chat-store.mjs

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const tempDir = join(root, 'gui', 'node_modules', '.verify-chat-store');
mkdirSync(tempDir, { recursive: true });

function transpile(relativePath, outName) {
  const source = readFileSync(join(root, 'gui', 'src', 'lib', relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: relativePath
  }).outputText;
  const target = join(tempDir, outName);
  writeFileSync(target, output);
  return target;
}

transpile('chat.ts', 'chat.js');
transpile('chat-store.ts', 'chat-store.js');

const pages = [];
const calls = { messages: [], status: 0, chats: 0 };
globalThis.document = { hidden: false };
globalThis.window = {
  location: { hash: '#/chats/c1' },
  workbench: {
    listChats: async () => {
      calls.chats += 1;
      return { ok: true, data: { chats: [] } };
    },
    chatStatus: async () => {
      calls.status += 1;
      return {
        ok: true,
        data: {
          chat_id: 'c1',
          needs_muse: false,
          agents: {},
          participants: [
            { participant_id: 'user', display_name: 'User', role: 'user', status: 'idle' },
            { participant_id: 'muse', display_name: 'Muse', role: 'muse', status: 'idle' }
          ]
        }
      };
    },
    chatParticipants: async () => ({ ok: true, data: [] }),
    chatMarkRead: async () => ({ ok: true, data: { last_read_seq: 0, unread: 0 } }),
    listChatMessages: async (input) => {
      calls.messages.push(input);
      const page = pages.shift() ?? [];
      return { ok: true, data: { messages: page, next_seq: page.at(-1)?.seq ?? null } };
    },
    sendChatMessage: async () => ({ ok: true, data: { message_id: 'm1', chat_id: 'c1' } })
  }
};

const { chatStore } = require(join(tempDir, 'chat-store.js'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const message = (seq) => ({
  message_id: `msg-${seq}`,
  chat_id: 'c1',
  seq,
  from: 'user',
  to: 'muse',
  summary: `message ${seq}`,
  files: [],
  mentions: [],
  status: 'sent',
  created_at: `2026-11-16T00:00:0${seq}.000Z`
});

try {
  // First page: no cursor.
  pages.push([message(1), message(2)]);
  chatStore.setActiveChat('c1');
  await sleep(80);

  const first = chatStore.getSnapshot();
  check('first page loads', first.messages.c1?.messages.length === 2, JSON.stringify(first.messages.c1));
  check('cursor is the max seq', first.messages.c1?.seq === 2, String(first.messages.c1?.seq));
  check('first request has no afterSeq', calls.messages[0]?.afterSeq == null, JSON.stringify(calls.messages[0]));
  check(
    'participants come from chat_status',
    first.participants.c1?.length === 2,
    JSON.stringify(first.participants.c1)
  );
  check('status fetched once', calls.status === 1, String(calls.status));

  // Incremental page: after_seq = 2.
  pages.push([message(3)]);
  await chatStore.fetchMessages('c1');
  const second = chatStore.getSnapshot();
  check('incremental request uses afterSeq', calls.messages[1]?.afterSeq === 2, JSON.stringify(calls.messages[1]));
  check(
    'messages merge without duplicates',
    second.messages.c1?.messages.length === 3 && second.messages.c1?.seq === 3,
    JSON.stringify(second.messages.c1?.messages.map((item) => item.seq))
  );

  // Re-entrant calls while one is in flight are dropped, not queued.
  const before = calls.messages.length;
  await Promise.all([chatStore.fetchMessages('c1'), chatStore.fetchMessages('c1')]);
  check('inflight guard dedupes polls', calls.messages.length === before + 1, `${calls.messages.length - before}`);

  result.ok = result.errors.length === 0;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({ ok: result.ok, checks: result.checks, errors: result.errors }, null, 2)}\n`,
  () => process.exit(result.ok ? 0 : 1)
);
