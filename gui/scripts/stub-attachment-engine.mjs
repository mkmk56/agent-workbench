import crypto from 'node:crypto';
import http from 'node:http';
import zlib from 'node:zlib';

/**
 * Stub MCP engine for attachment verification.
 *
 * Speaks the same JSON-RPC `tools/call` transport the GUI uses and implements
 * the frozen contract (upload_chat_file_init/chunk/complete, chat_read_file,
 * chat_participants, chat_mark_read, list_chat_messages with after_seq, and
 * send_chat_message with files/mentions/reply_to/client_msg_id).
 *
 * It exists because the real backend tools are implemented in parallel by
 * another agent; this stub lets the GUI contract be verified end to end today
 * and is replaced by the real engine during integration. It does no LLM work.
 */

const CHUNK_LIMIT = 4 * 1024 * 1024;
const TEXT_KINDS = new Set(['text', 'code']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'toml', 'ini', 'env',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'xml', 'py', 'rb', 'go', 'rs',
  'java', 'c', 'h', 'cpp', 'sh', 'bash', 'ps1', 'sql',
]);

function extensionOf(name) {
  const base = String(name).split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function detectKind(name) {
  const ext = extensionOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'].includes(ext)) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (['docx', 'doc', 'odt', 'rtf'].includes(ext)) {
    return 'docx';
  }
  if (['xlsx', 'xls', 'ods'].includes(ext)) {
    return 'xlsx';
  }
  if (['pptx', 'ppt', 'odp'].includes(ext)) {
    return 'pptx';
  }
  if (['zip', 'gz', 'tgz', '7z', 'rar', 'tar'].includes(ext)) {
    return 'zip';
  }
  if (TEXT_EXTS.has(ext)) {
    return ['txt', 'md', 'markdown', 'csv', 'tsv', 'log'].includes(ext) ? 'text' : 'code';
  }
  return 'other';
}

/** Read every entry of a ZIP/Office container (stored or deflated). */
export function unzip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66_000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip container');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      break;
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function stripXml(xml) {
  return xml
    .replace(/<w:t[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function docxPreview(buffer) {
  const entries = unzip(buffer);
  const xml = entries.get('word/document.xml')?.toString('utf8') ?? '';
  return stripXml(xml).slice(0, 2000);
}

function xlsxPreview(buffer) {
  const entries = unzip(buffer);
  const strings = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const values = [...strings.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) =>
    stripXml(match[1]),
  );
  const sheet = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
  const numbers = [...sheet.matchAll(/<v>(\d+)<\/v>/g)].map((match) => match[1]);
  return `${values.join(' | ')}${numbers.length > 0 ? ` | 数值: ${numbers.join(', ')}` : ''}`.slice(
    0,
    2000,
  );
}

function zipPreview(buffer) {
  const entries = unzip(buffer);
  return `压缩包包含 ${entries.size} 个条目：${[...entries.keys()].join(', ')}`;
}

function pdfPreview(buffer) {
  const text = buffer.toString('latin1');
  const lines = [...text.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((match) =>
    match[1].replace(/\\([()\\])/g, '$1'),
  );
  return lines.join('\n').slice(0, 2000);
}

export function previewFor(kind, buffer) {
  try {
    if (kind === 'docx') {
      return docxPreview(buffer);
    }
    if (kind === 'xlsx') {
      return xlsxPreview(buffer);
    }
    if (kind === 'zip') {
      return zipPreview(buffer);
    }
    if (kind === 'pdf') {
      return pdfPreview(buffer);
    }
  } catch (error) {
    return `解析失败：${error instanceof Error ? error.message : String(error)}`;
  }
  if (kind === 'text' || kind === 'code') {
    return buffer.toString('utf8').slice(0, 2000);
  }
  return null;
}

function mimeFor(name) {
  const ext = extensionOf(name);
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
    ts: 'text/typescript',
    md: 'text/markdown',
    txt: 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

function filePayload(file) {
  return {
    file_id: file.file_id,
    chat_id: file.chat_id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    kind: file.kind,
    sha256: file.sha256,
    status: file.status,
    preview_text: file.preview_text,
    preview_truncated: false,
    uploader: file.uploader ?? 'user',
    created_at: file.created_at,
  };
}

class StubEngine {
  constructor(token) {
    this.token = token;
    this.chats = new Map();
    this.files = new Map();
    this.uploads = new Map();
    this.actorCalls = [];
    this.requestCount = 0;
  }

  chat(chatId) {
    let chat = this.chats.get(chatId);
    if (chat == null) {
      chat = { chat_id: chatId, name: `联调群聊 ${chatId.slice(0, 6)}`, seq: 0, messages: [], last_read_seq: 0 };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  file(fileId, chatId) {
    const file = this.files.get(fileId);
    if (file == null || file.chat_id !== chatId) {
      throw new Error(`file ${fileId} is not available in chat ${chatId}`);
    }
    return file;
  }

  tools = {
    list_chats: () => ({
      chats: [...this.chats.values()].map((chat) => ({
        chat_id: chat.chat_id,
        name: chat.name,
        status: 'active',
        created_at: chat.created_at ?? new Date().toISOString(),
        last_message_at: chat.messages.at(-1)?.created_at ?? null,
        last_message_preview: chat.messages.at(-1)?.summary ?? null,
        needs_muse: false,
        unread: 0,
        agents: { muse: 'idle', claude: 'idle', dsh: 'idle' },
      })),
    }),

    create_chat: (args) => {
      const chatId = crypto.randomUUID();
      this.chats.set(chatId, {
        chat_id: chatId,
        name: args.name ?? '新群聊',
        seq: 0,
        messages: [],
        created_at: new Date().toISOString(),
        last_read_seq: 0,
      });
      return { chat_id: chatId, name: args.name ?? '新群聊', created_at: new Date().toISOString() };
    },

    rename_chat: (args) => {
      const chat = this.chat(args.chat_id);
      chat.name = String(args.name);
      return { chat_id: chat.chat_id, name: chat.name };
    },

    chat_status: (args) => {
      const chat = this.chat(args.chat_id);
      return {
        chat_id: chat.chat_id,
        name: chat.name,
        status: 'active',
        needs_muse: false,
        last_message_at: chat.messages.at(-1)?.created_at ?? null,
        agents: {
          muse: { status: 'idle', state: null, task_id: null, updated_at: null },
          claude: { status: 'idle', state: null, task_id: null, updated_at: null },
          dsh: { status: 'idle', state: null, task_id: null, updated_at: null },
        },
      };
    },

    chat_participants: (args) => {
      const chat = this.chat(args.chat_id);
      return {
        chat_id: chat.chat_id,
        participants: [
          { id: 'user', name: '你', role: 'user', status: 'online', state: null, task_id: null, updated_at: null },
          { id: 'muse', name: 'Muse', role: 'agent', status: 'idle', state: null, task_id: null, updated_at: null },
          { id: 'claude', name: 'Claude', role: 'agent', status: 'idle', state: null, task_id: null, updated_at: null },
          { id: 'dsh', name: 'dsh', role: 'agent', status: 'idle', state: null, task_id: null, updated_at: null },
        ],
      };
    },

    chat_mark_read: (args) => {
      const chat = this.chat(args.chat_id);
      const upTo = Number.isInteger(args.up_to_seq)
        ? args.up_to_seq
        : Number.isInteger(args.seq)
          ? args.seq
          : chat.seq;
      chat.last_read_seq = Math.max(chat.last_read_seq, upTo);
      return { chat_id: chat.chat_id, last_read_seq: chat.last_read_seq, unread: 0 };
    },

    send_chat_message: (args) => {
      const chat = this.chat(args.chat_id);
      const files = Array.isArray(args.files)
        ? args.files.map((fileId) => filePayload(this.file(fileId, chat.chat_id)))
        : [];
      chat.seq += 1;
      const message = {
        message_id: crypto.randomUUID(),
        chat_id: chat.chat_id,
        seq: chat.seq,
        from: args.from ?? 'user',
        to: args.to ?? 'muse',
        summary: String(args.summary ?? ''),
        files,
        file_ids: files.map((file) => file.file_id),
        mentions: Array.isArray(args.mentions) ? args.mentions : [],
        question: args.question ?? null,
        reply_to: args.reply_to ?? null,
        client_msg_id: args.client_msg_id ?? null,
        status: 'stored',
        created_at: new Date().toISOString(),
        task_id: null,
      };
      chat.messages.push(message);
      return {
        message_id: message.message_id,
        chat_id: message.chat_id,
        created_at: message.created_at,
        seq: message.seq,
        to: message.to,
        status: message.status,
        client_msg_id: message.client_msg_id,
        mentions: message.mentions,
        reply_to: message.reply_to,
        files: message.file_ids,
      };
    },

    list_chat_messages: (args) => {
      const chat = this.chat(args.chat_id);
      let messages = [...chat.messages];
      if (typeof args.after_seq === 'number') {
        messages = messages.filter((message) => message.seq > args.after_seq);
      }
      if (typeof args.before === 'string' && args.before.length > 0) {
        const index = messages.findIndex(
          (message) => message.message_id === args.before || message.created_at === args.before,
        );
        if (index > 0) {
          messages = messages.slice(0, index);
        }
      }
      const limit = Number.isInteger(args.limit) ? args.limit : 50;
      const sliced = messages.slice(-limit);
      return {
        chat_id: chat.chat_id,
        messages: sliced.map((message) => ({
          message_id: message.message_id,
          chat_id: message.chat_id,
          seq: message.seq,
          from: message.from,
          to: message.to,
          summary: message.summary,
          files: message.files,
          mentions: message.mentions,
          question: message.question,
          reply_to: message.reply_to,
          client_msg_id: message.client_msg_id,
          status: message.status,
          created_at: message.created_at,
          task_id: null,
        })),
        count: sliced.length,
        has_more: messages.length > limit,
        next_seq: chat.seq,
      };
    },

    upload_chat_file_init: (args) => {
      this.chat(args.chat_id);
      const name = String(args.name ?? '');
      const size = Number(args.size ?? 0);
      if (name.length === 0 || !Number.isFinite(size) || size <= 0) {
        throw new Error('upload init requires a non-empty name and a positive size');
      }
      const sha256 = typeof args.sha256 === 'string' ? args.sha256 : null;
      // Resume: same chat + name + sha256 with a partial buffer.
      for (const upload of this.uploads.values()) {
        if (
          upload.chat_id === args.chat_id &&
          upload.name === name &&
          upload.sha256 === sha256 &&
          upload.received < upload.size
        ) {
          return {
            file_id: upload.file_id,
            upload_id: upload.file_id,
            chunk_size: 1024 * 1024,
            offset: upload.received,
            size,
            resumed: true,
          };
        }
      }
      const fileId = crypto.randomUUID();
      const record = {
        file_id: fileId,
        chat_id: args.chat_id,
        name,
        size,
        mime: typeof args.mime === 'string' && args.mime.length > 0 ? args.mime : mimeFor(name),
        kind: detectKind(name),
        sha256,
        buffer: Buffer.alloc(0),
        received: 0,
        status: 'uploading',
        chunks: 0,
      };
      this.uploads.set(fileId, record);
      return { file_id: fileId, upload_id: fileId, chunk_size: 1024 * 1024, offset: 0, size };
    },

    upload_chat_file_chunk: (args) => {
      const upload = this.uploads.get(args.file_id);
      if (upload == null) {
        throw new Error(`unknown upload ${args.file_id}`);
      }
      if (upload.chat_id !== args.chat_id) {
        throw new Error('upload belongs to another chat');
      }
      const data = Buffer.from(String(args.data ?? ''), 'base64');
      if (data.length === 0) {
        throw new Error('empty chunk');
      }
      if (data.length > CHUNK_LIMIT) {
        throw new Error('chunk too large');
      }
      const offset = Number(args.offset ?? upload.received);
      if (offset !== upload.received) {
        throw new Error(`chunk offset mismatch: expected ${upload.received}, got ${offset}`);
      }
      if (typeof args.sha256 === 'string') {
        const digest = crypto.createHash('sha256').update(data).digest('hex');
        if (digest !== args.sha256) {
          throw new Error('chunk checksum mismatch');
        }
      }
      if (upload.received + data.length > upload.size) {
        throw new Error('chunk exceeds declared file size');
      }
      upload.buffer = Buffer.concat([upload.buffer, data]);
      upload.received += data.length;
      upload.chunks += 1;
      return { file_id: upload.file_id, received: upload.received, chunks: upload.chunks };
    },

    upload_chat_file_complete: (args) => {
      const upload = this.uploads.get(args.file_id);
      if (upload == null) {
        throw new Error(`unknown upload ${args.file_id}`);
      }
      if (upload.received !== upload.size) {
        throw new Error(`incomplete upload: ${upload.received}/${upload.size} bytes`);
      }
      const digest = crypto.createHash('sha256').update(upload.buffer).digest('hex');
      if (upload.sha256 != null && digest !== upload.sha256) {
        throw new Error('file checksum mismatch');
      }
      const preview = previewFor(upload.kind, upload.buffer);
      const file = {
        ...upload,
        sha256: digest,
        status: 'ready',
        preview_text: preview,
        created_at: new Date().toISOString(),
        uploader: 'user',
      };
      this.files.set(file.file_id, file);
      this.uploads.delete(file.file_id);
      return { file: filePayload(file) };
    },

    chat_read_file: (args) => {
      const file = this.file(args.file_id, args.chat_id);
      const mode = args.mode === 'base64' ? 'base64' : 'text';
      const offset = Number.isInteger(args.offset) ? args.offset : 0;
      const limit = Number.isInteger(args.limit) ? args.limit : 256 * 1024;
      if (mode === 'base64') {
        const slice = file.buffer.subarray(offset, offset + limit);
        const next = offset + slice.length < file.buffer.length ? offset + slice.length : null;
        return {
          file: filePayload(file),
          mode,
          encoding: 'base64',
          content: slice.toString('base64'),
          offset,
          next_offset: next,
          truncated: next != null,
        };
      }
      if (TEXT_KINDS.has(file.kind)) {
        const text = file.buffer.toString('utf8');
        const slice = text.slice(offset, offset + limit);
        const next = offset + slice.length < text.length ? offset + slice.length : null;
        return {
          file: filePayload(file),
          mode: 'text',
          encoding: 'utf8',
          content: slice,
          offset,
          next_offset: next,
          truncated: next != null,
          preview_text: file.preview_text,
        };
      }
      return {
        file: filePayload(file),
        mode: 'text',
        encoding: 'utf8',
        content: file.preview_text ?? '',
        offset: 0,
        next_offset: null,
        truncated: false,
        preview_text: file.preview_text,
      };
    },
  };

  async call(name, args, actor) {
    this.requestCount += 1;
    if (typeof args.file_id === 'string') {
      this.actorCalls.push({ actor: actor ?? 'unknown', tool: name, file_id: args.file_id });
    }
    const tool = this.tools[name];
    if (tool == null) {
      throw new Error(`unknown tool ${name}`);
    }
    return tool(args ?? {});
  }
}

export function startStubEngine({ port, token }) {
  const engine = new StubEngine(token);
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'stub-attachment-engine', version: '0.0.1' }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const authorization = request.headers.authorization ?? '';
    if (token != null && authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      const actor = request.headers['x-actor'] ?? 'user';
      const { id, params } = payload;
      const name = params?.name;
      const args = params?.arguments ?? {};
      Promise.resolve()
        .then(() => engine.call(name, args, String(actor)))
        .then((result) => {
          const reply = {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
          };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(reply));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const reply = {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Error: ${message}` }],
            },
          };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(reply));
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        engine,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
