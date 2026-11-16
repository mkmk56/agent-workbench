import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, makeServices, makeZip, seedTask, uploadBuffer } from './helpers.js';

function tinyPdf() {
  return Buffer.from(
    '%PDF-1.4\n'
    + '1 0 obj\n<< /Length 44 >>\nstream\n'
    + 'BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\n'
    + 'endstream\nendobj\ntrailer\n<<>>\n%%EOF\n',
    'latin1'
  );
}

test('chunked upload stores, parses and reads text', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Files' });
    const buffer = Buffer.from('hello world\nsecond line', 'utf8');
    const meta = uploadBuffer(files, chat.chat_id, 'notes.txt', buffer);
    assert.equal(meta.parse_status, 'parsed');
    assert.equal(meta.size, buffer.length);
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);

    const result = files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: true }
    });
    assert.equal(result.kind, 'text');
    assert.match(result.text, /hello world/);
    assert.equal(result.truncated, false);
    assert.equal(files.listFiles({ chat_id: chat.chat_id }).files.length, 1);
  } finally {
    store.close();
  }
});

test('upload limits are explicit', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Limits' });
    assert.throws(
      () => files.initUpload({ chat_id: chat.chat_id, name: 'huge.bin', size: 21 * 1024 * 1024 }),
      /exceeds the .*20 MB|20 MB|20971520/i
    );
    const init = files.initUpload({ chat_id: chat.chat_id, name: 'a.bin', size: 2 * 1024 * 1024 });
    const tooBig = Buffer.alloc(1024 * 1024 + 1).toString('base64');
    assert.throws(
      () => files.appendChunk({ upload_id: init.upload_id, index: 0, data: tooBig }),
      /1 MB|1048576/
    );
    assert.throws(
      () => files.completeUpload({ upload_id: init.upload_id }),
      /incomplete: received 0 of/
    );
  } finally {
    store.close();
  }
});

test('messages only accept file_id references, scoped to the chat', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const a = chats.create({ name: 'A' });
    const b = chats.create({ name: 'B' });
    const meta = uploadBuffer(files, a.chat_id, 'a.txt', Buffer.from('attachment'));
    assert.throws(() => chats.send({
      chat_id: b.chat_id, from: 'user', to: 'muse', body: 'wrong chat', files: [meta.file_id]
    }), /does not belong to chat/i);
    assert.throws(() => chats.send({
      chat_id: a.chat_id, from: 'user', to: 'muse', body: 'path', files: ['C:\\Windows\\win.ini']
    }), /bare file paths|bare paths|host path/i);
    const sent = chats.send({
      chat_id: a.chat_id, from: 'user', to: 'muse', body: 'look at this', files: [meta.file_id]
    });
    assert.equal(store.listMessageFiles(sent.message_id).length, 1);
    assert.deepEqual(JSON.parse(store.getMessage(sent.message_id).files_json), [meta.file_id]);
  } finally {
    store.close();
  }
});

test('ZIP is safely extracted and read by entry', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Zip' });
    const zip = makeZip([
      ['readme.txt', 'zip hello'],
      ['sub/notes.md', '# nested']
    ]);
    const meta = uploadBuffer(files, chat.chat_id, 'bundle.zip', zip);
    assert.equal(meta.parse_status, 'parsed');
    const tree = files.readFile({ chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: true } });
    assert.equal(tree.kind, 'zip');
    const names = JSON.stringify(tree.tree);
    assert.match(names, /readme\.txt/);
    assert.match(names, /notes\.md/);
    const entry = files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, entry: 'sub/notes.md', actor: { master: true }
    });
    assert.equal(entry.kind, 'text');
    assert.match(entry.text, /nested/);
    assert.throws(() => files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, entry: '../readme.txt', actor: { master: true }
    }), /invalid ZIP entry path|escapes/);
  } finally {
    store.close();
  }
});

test('ZIP path traversal is rejected at parse time', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'ZipEvil' });
    const zip = makeZip([['../evil.txt', 'pwn']]);
    const meta = uploadBuffer(files, chat.chat_id, 'evil.zip', zip);
    assert.equal(meta.parse_status, 'failed');
    assert.match(meta.parse.error, /unsafe parent traversal/i);
    assert.throws(() => files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: true }
    }), /cannot read .*unsafe parent traversal/i);
  } finally {
    store.close();
  }
});

test('ZIP per-entry decompression limit is enforced', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir, {
    config: { chatZipMaxEntryBytes: 16 }
  });
  try {
    const chat = chats.create({ name: 'ZipLimit' });
    const meta = uploadBuffer(files, chat.chat_id, 'limit.zip', makeZip([
      ['big.txt', 'x'.repeat(100)]
    ]));
    assert.equal(meta.parse_status, 'failed');
    assert.match(meta.parse.error, /per-file limit|decompressed size limit/i);
    assert.throws(() => files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: true }
    }), /cannot read .*limit/i);
  } finally {
    store.close();
  }
});

test('DOCX and PDF text extraction', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Docs' });
    const docx = makeZip([[
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>'
    ]]);
    const docxMeta = uploadBuffer(files, chat.chat_id, 'sample.docx', docx);
    assert.equal(docxMeta.parse_status, 'parsed');
    const docxRead = files.readFile({
      chat_id: chat.chat_id, file_id: docxMeta.file_id, actor: { master: true }
    });
    assert.match(docxRead.text, /Hello DOCX/);

    const pdfMeta = uploadBuffer(files, chat.chat_id, 'sample.pdf', tinyPdf());
    assert.equal(pdfMeta.parse_status, 'parsed');
    const pdfRead = files.readFile({
      chat_id: chat.chat_id, file_id: pdfMeta.file_id, actor: { master: true }
    });
    assert.match(pdfRead.text, /Hello PDF/);
  } finally {
    store.close();
  }
});

test('XLSX and PPTX text extraction', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Office' });
    const xlsx = makeZip([
      ['xl/sharedStrings.xml', '<sst><si><t>Hello</t></si><si><t>World</t></si></sst>'],
      ['xl/worksheets/sheet1.xml',
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>']
    ]);
    const xlsxMeta = uploadBuffer(files, chat.chat_id, 'table.xlsx', xlsx);
    assert.equal(xlsxMeta.parse_status, 'parsed');
    const xlsxRead = files.readFile({
      chat_id: chat.chat_id, file_id: xlsxMeta.file_id, actor: { master: true }
    });
    assert.match(xlsxRead.text, /Hello\tWorld/);

    const pptx = makeZip([[
      'ppt/slides/slide1.xml',
      '<p:sld><a:p><a:r><a:t>Hello PPTX</a:t></a:r></a:p></p:sld>'
    ]]);
    const pptxMeta = uploadBuffer(files, chat.chat_id, 'deck.pptx', pptx);
    assert.equal(pptxMeta.parse_status, 'parsed');
    const pptxRead = files.readFile({
      chat_id: chat.chat_id, file_id: pptxMeta.file_id, actor: { master: true }
    });
    assert.match(pptxRead.text, /Hello PPTX/);
  } finally {
    store.close();
  }
});

test('non-chat messages also reject bare paths', () => {
  const dir = tempDir();
  const { store, messages } = makeServices(dir);
  try {
    const task = seedTask(store, { agent: 'claude', cwd: dir });
    assert.throws(() => messages.send({
      from: 'claude', to: 'muse', task_id: task.id,
      summary: 'with a host path', files: ['D:\\secret\\keys.txt']
    }), /bare host path|file_id references/i);
    const ok = messages.send({
      from: 'claude', to: 'muse', task_id: task.id, summary: 'no files', deliver: false
    });
    assert.deepEqual(ok.files, []);
  } finally {
    store.close();
  }
});

test('images honor executor vision capability', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Images' });
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fake png bytes')
    ]);
    const meta = uploadBuffer(files, chat.chat_id, 'pixel.png', png);
    assert.equal(meta.parse_status, 'parsed');
    assert.throws(() => files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: false, participant: 'dsh' }
    }), /cannot receive image content/i);
    const forClaude = files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: false, participant: 'claude' }
    });
    assert.equal(forClaude.kind, 'image');
    assert.match(forClaude.image.data, /^[A-Za-z0-9+/=]+$/);
    assert.equal(forClaude.image.mimeType, 'image/png');
  } finally {
    store.close();
  }
});

test('unsupported binaries return an explicit error', () => {
  const dir = tempDir();
  const { store, files, chats } = makeServices(dir);
  try {
    const chat = chats.create({ name: 'Bin' });
    const meta = uploadBuffer(files, chat.chat_id, 'data.bin', Buffer.from([0, 1, 2, 3, 4]));
    assert.equal(meta.parse_status, 'unsupported');
    assert.throws(() => files.readFile({
      chat_id: chat.chat_id, file_id: meta.file_id, actor: { master: true }
    }), /cannot read .*unsupported|supported: PDF/i);
  } finally {
    store.close();
  }
});