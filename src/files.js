import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts',
  '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.toml',
  '.ini', '.conf', '.cfg', '.properties', '.gradle', '.groovy', '.swift', '.scala', '.lua',
  '.r', '.dart', '.vue', '.svelte', '.dockerfile', '.gitignore', '.editorconfig'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const MAX_TEXT_RETURN = 2 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function extensionOf(name) {
  const lower = String(name ?? '').toLowerCase();
  const ext = extname(lower);
  if (ext) return ext;
  if (lower === 'dockerfile' || lower.endsWith('/dockerfile')) return '.dockerfile';
  return '';
}

function normalizeMime(value, name) {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) {
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    return `image/${ext.slice(1)}`;
  }
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function sanitizeFileName(name) {
  const raw = String(name ?? '').replace(/\\/g, '/');
  const base = basename(raw)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!base || base === '.' || base === '..') {
    throw new Error('file name is empty or invalid after sanitization');
  }
  return base;
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripXmlTags(xml) {
  return decodeXmlEntities(String(xml).replace(/<[^>]+>/g, ''));
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader/writer support
//
// Only the central-directory + store/deflate subset is implemented; that is
// everything DOCX/XLSX/PPTX and ordinary user ZIPs use. ZIP64 and encrypted
// archives are rejected with an explicit error instead of being misread.
// ---------------------------------------------------------------------------

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD) return offset;
  }
  return -1;
}

export function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('not a valid ZIP archive: end-of-central-directory record not found');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported; re-create the archive without ZIP64');
  }
  if (cdOffset + cdSize > buffer.length) throw new Error('corrupt ZIP archive: central directory out of range');

  const entries = [];
  let pointer = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== ZIP_CENTRAL) {
      throw new Error('corrupt ZIP archive: bad central-directory entry');
    }
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const externalAttrs = buffer.readUInt32LE(pointer + 38);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported');
    }
    if (flags & 0x1) throw new Error('encrypted ZIP entries are not supported');
    const rawName = buffer.subarray(pointer + 46, pointer + 46 + nameLength);
    const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, method, compressedSize, uncompressedSize, externalAttrs, localOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, buffer };
}

function zipEntryData(buffer, entry) {
  const local = entry.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== ZIP_LOCAL) {
    throw new Error(`corrupt ZIP archive: bad local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`corrupt ZIP archive: data for ${entry.name} out of range`);
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

function safeZipEntryName(name) {
  const normalized = String(name ?? '').replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`unsafe absolute path in ZIP: ${name}`);
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`unsafe parent traversal in ZIP: ${name}`);
  if (parts.length === 0) return null;
  return parts.join('/');
}

function zipEntryIsSymlink(entry) {
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

// ---------------------------------------------------------------------------
// PDF text extraction
//
// A deliberately small content-stream reader: decompress FlateDecode streams,
// walk BT/ET text blocks and decode literal/hex strings. It is not a full PDF
// implementation; when no printable text is recovered the caller gets an
// explicit "cannot extract text" error rather than a silent empty document.
// ---------------------------------------------------------------------------

function decodePdfLiteral(token) {
  const body = token.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) break;
    if (next === 'n') { out += '\n'; i += 1; }
    else if (next === 'r') { out += '\r'; i += 1; }
    else if (next === 't') { out += '\t'; i += 1; }
    else if (next === 'b') { out += '\b'; i += 1; }
    else if (next === 'f') { out += '\f'; i += 1; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i += 1; }
    else if (/[0-7]/.test(next)) {
      let octal = '';
      let j = i + 1;
      while (j < body.length && octal.length < 3 && /[0-7]/.test(body[j])) {
        octal += body[j];
        j += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
      i = j - 1;
    } else if (next === '\n') { i += 1; }
    else { out += next; i += 1; }
  }
  return out;
}

function decodePdfHex(token) {
  const hex = token.slice(1, -1).replace(/\s+/g, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  try {
    const bytes = Buffer.from(padded, 'hex');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const swapped = Buffer.from(bytes.subarray(2));
      if (swapped.length % 2) swapped.write('\0', swapped.length - 1);
      return swapped.swap16().toString('utf16le');
    }
    return bytes.toString('utf8');
  } catch {
    return '';
  }
}

function extractPdfContentText(content) {
  const tokenPattern = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTj\b|\bTJ\b|\bTd\b|\bTD\b|\bT\*\b|\bTm\b|'|"/g;
  let text = '';
  let pending = '';
  let match;
  while ((match = tokenPattern.exec(content))) {
    const token = match[0];
    if (token.startsWith('(')) pending += decodePdfLiteral(token);
    else if (token.startsWith('<')) pending += decodePdfHex(token);
    else if (token === 'Tj' || token === 'TJ') {
      text += pending;
      pending = '';
    } else if (token === "'" || token === '"') {
      text += `\n${pending}`;
      pending = '';
    } else if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'Tm') {
      if (pending) { text += pending; pending = ''; }
      if (text && !text.endsWith('\n')) text += '\n';
    }
  }
  text += pending;
  return text;
}

function printableRatio(text) {
  const compact = String(text).replace(/\s/g, '');
  if (!compact) return 0;
  let printable = 0;
  for (const ch of compact) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0xfffd) printable += 1;
  }
  return printable / compact.length;
}

export function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [];
  const streamPattern = /stream\r?\n/g;
  let match;
  while ((match = streamPattern.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = raw.lastIndexOf('<<', match.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, match.index) : '';
    let data = Buffer.from(raw.slice(start, end), 'latin1');
    let decoded = null;
    if (/FlateDecode/.test(dict)) {
      try { decoded = inflateSync(data); } catch {
        try { decoded = inflateRawSync(data); } catch { decoded = null; }
      }
    } else if (!/\/Filter\b/.test(dict)) {
      decoded = data;
    }
    if (decoded) {
      const part = extractPdfContentText(decoded.toString('latin1'));
      if (part.trim()) chunks.push(part);
    }
    streamPattern.lastIndex = end + 'endstream'.length;
  }
  const text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text && printableRatio(text) >= 0.5 ? text : '';
}

// ---------------------------------------------------------------------------
// DOCX / XLSX / PPTX text extraction (OOXML = ZIP + XML)
// ---------------------------------------------------------------------------

function zipText(buffer, entryName) {
  const { entries } = readZipEntries(buffer);
  const entry = entries.find((item) => item.name === entryName);
  if (!entry) return '';
  return zipEntryData(buffer, entry).toString('utf8');
}

function extractDocxText(buffer) {
  const xml = zipText(buffer, 'word/document.xml');
  if (!xml) throw new Error('DOCX has no word/document.xml; the archive may be corrupt');
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractXlsxText(buffer) {
  const { entries } = readZipEntries(buffer);
  const find = (name) => entries.find((entry) => entry.name === name);
  const sharedEntry = find('xl/sharedStrings.xml');
  const shared = [];
  if (sharedEntry) {
    const xml = zipEntryData(buffer, sharedEntry).toString('utf8');
    for (const item of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
      const texts = [...item[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
      shared.push(texts.join(''));
    }
  }
  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const output = [];
  for (const sheet of sheets) {
    const xml = zipEntryData(buffer, sheet).toString('utf8');
    const rows = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const type = /t="([^"]*)"/.exec(attrs)?.[1] ?? null;
        const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1]
          ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell[2])?.[1]
          ?? '';
        if (type === 's') {
          const index = Number.parseInt(value, 10);
          cells.push(shared[index] ?? '');
        } else if (type === 'inlineStr') {
          cells.push(decodeXmlEntities(value));
        } else {
          cells.push(decodeXmlEntities(value));
        }
      }
      rows.push(cells.join('\t'));
    }
    output.push(`--- ${sheet.name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '')} ---`);
    output.push(...rows);
    output.push('');
  }
  return output.join('\n').trim();
}

function extractPptxText(buffer) {
  const { entries } = readZipEntries(buffer);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const output = [];
  slides.forEach((slide, index) => {
    const xml = zipEntryData(buffer, slide).toString('utf8');
    const text = decodeXmlEntities(
      xml
        .replace(/<a:br\s*\/>/g, '\n')
        .replace(/<\/a:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
    ).trim();
    output.push(`--- slide ${index + 1} ---`, text, '');
  });
  return output.join('\n').trim();
}

// ---------------------------------------------------------------------------
// File tree helper
// ---------------------------------------------------------------------------

function listTree(rootDir, prefix = '') {
  const entries = readdirSync(join(rootDir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((entry) => {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return { path: entryPath, type: 'dir', children: listTree(rootDir, entryPath) };
    }
    const info = statSync(join(rootDir, entryPath));
    return { path: entryPath, type: 'file', size: info.size };
  });
}

export class FileService {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.dataDir = config.dataDir;
    this.rootDir = config.chatFilesDir || join(config.dataDir, 'chat-files');
    this.maxFileBytes = Number(config.chatMaxFileBytes ?? 20 * 1024 * 1024);
    this.maxChunkBytes = Number(config.chatUploadChunkBytes ?? 1024 * 1024);
    this.maxZipFiles = Number(config.chatZipMaxFiles ?? 200);
    this.maxZipDepth = Number(config.chatZipMaxDepth ?? 5);
    this.maxZipTotalBytes = Number(config.chatZipMaxTotalBytes ?? 50 * 1024 * 1024);
    this.maxZipEntryBytes = Number(config.chatZipMaxEntryBytes ?? 10 * 1024 * 1024);
    this.uploads = new Map();
    mkdirSync(join(this.rootDir, '.uploads'), { recursive: true });
  }

  _chatDir(chatId) {
    return join(this.rootDir, chatId);
  }

  _assertInside(baseDir, targetPath) {
    const rel = relative(resolve(baseDir), resolve(targetPath));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path escapes the allowed chat file directory: ${targetPath}`);
    }
    return resolve(targetPath);
  }

  _resolveStored(row) {
    const path = resolve(this.dataDir, row.stored_path);
    this._assertInside(this._chatDir(row.chat_id), path);
    return path;
  }

  describe(row) {
    if (!row) return null;
    return {
      file_id: row.file_id,
      chat_id: row.chat_id,
      uploader: row.uploader_id,
      name: row.original_name,
      mime: row.mime,
      size: Number(row.size ?? 0),
      sha256: row.sha256,
      parse_status: row.parse_status,
      parse_error: row.parse_error ?? null,
      created_at: row.created_at
    };
  }

  init({ chatId, name, size, mime, uploaderId }) {
    if (!chatId) throw new Error('chat_id is required');
    if (!this.store.getChat(chatId)) throw new Error(`chat not found: ${chatId}`);
    const safeName = sanitizeFileName(name);
    const total = Number(size);
    if (!Number.isInteger(total) || total <= 0) throw new Error('size must be a positive integer');
    if (total > this.maxFileBytes) {
      throw new Error(`file is ${total} bytes, which exceeds the ${this.maxFileBytes}-byte (20 MB) limit`);
    }
    const uploadId = randomUUID();
    const tmpPath = join(this.rootDir, '.uploads', `${uploadId}.part`);
    mkdirSync(join(this.rootDir, '.uploads'), { recursive: true });
    writeFileSync(tmpPath, Buffer.alloc(0));
    const normalizedMime = normalizeMime(mime, safeName);
    this.uploads.set(uploadId, {
      uploadId,
      chatId,
      uploaderId: uploaderId ?? 'user',
      name: safeName,
      mime: normalizedMime,
      size: total,
      tmpPath,
      received: 0,
      nextIndex: 0,
      createdAt: nowIso()
    });
    return {
      upload_id: uploadId,
      chat_id: chatId,
      name: safeName,
      mime: normalizedMime,
      size: total,
      chunk_size: this.maxChunkBytes,
      max_size: this.maxFileBytes,
      received: 0
    };
  }

  chunk({ uploadId, index, data, chatId, uploaderId }) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`upload not found: ${uploadId} (call upload_chat_file_init first)`);
    if (chatId && chatId !== upload.chatId) throw new Error('upload belongs to a different chat');
    if (uploaderId && uploaderId !== upload.uploaderId) throw new Error('upload belongs to a different uploader');
    const chunkIndex = Number(index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('index must be a non-negative integer');
    if (chunkIndex !== upload.nextIndex) {
      throw new Error(`chunk out of order: expected index ${upload.nextIndex}, got ${chunkIndex}`);
    }
    if (typeof data !== 'string' || data === '') throw new Error('data must be a non-empty base64 string');
    const compact = data.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      throw new Error('data is not valid base64');
    }
    const buffer = Buffer.from(compact, 'base64');
    if (buffer.length === 0) throw new Error('decoded chunk is empty');
    if (buffer.length > this.maxChunkBytes) {
      throw new Error(`chunk is ${buffer.length} bytes; the limit is ${this.maxChunkBytes} (1 MB)`);
    }
    if (upload.received + buffer.length > upload.size) {
      throw new Error(`chunk would exceed the declared file size ${upload.size}`);
    }
    const fd = openSync(upload.tmpPath, 'a');
    try { writeFileSync(fd, buffer); } finally { closeSync(fd); }
    upload.received += buffer.length;
    upload.nextIndex += 1;
    return {
      upload_id: uploadId,
      received: upload.received,
      total: upload.size,
      next_index: upload.nextIndex
    };
  }

  complete({ uploadId, sha256, chatId, uploaderId }) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error(`upload not found: ${uploadId}`);
    if (chatId && chatId !== upload.chatId) throw new Error('upload belongs to a different chat');
    if (uploaderId && uploaderId !== upload.uploaderId) throw new Error('upload belongs to a different uploader');
    if (upload.received !== upload.size) {
      throw new Error(`upload incomplete: received ${upload.received} of ${upload.size} bytes`);
    }
    const buffer = readFileSync(upload.tmpPath);
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (sha256 && String(sha256).toLowerCase() !== digest) {
      throw new Error(`sha256 mismatch: expected ${sha256}, got ${digest}`);
    }

    const fileId = randomUUID();
    const chatDir = this._chatDir(upload.chatId);
    mkdirSync(chatDir, { recursive: true });
    const storedName = `${fileId}-${upload.name}`;
    const finalPath = join(chatDir, storedName);
    renameSync(upload.tmpPath, finalPath);
    this.uploads.delete(uploadId);

    const row = this.store.insertChatFile({
      file_id: fileId,
      chat_id: upload.chatId,
      uploader_id: upload.uploaderId,
      original_name: upload.name,
      stored_path: relative(this.dataDir, finalPath).split(sep).join('/'),
      mime: upload.mime,
      size: buffer.length,
      sha256: digest,
      parse_status: 'pending',
      parse_error: null,
      extracted_path: null,
      created_at: nowIso()
    });

    const parsed = this._parse(row, buffer);
    const updated = this.store.updateChatFile(fileId, parsed);
    return {
      ...this.describe(updated),
      parse: {
        status: parsed.parse_status,
        error: parsed.parse_error ?? null,
        has_text: Boolean(parsed.extracted_path)
      }
    };
  }

  _parse(row, buffer) {
    const kind = this.kindOf(row.original_name, row.mime);
    try {
      if (kind === 'text') return { parse_status: 'parsed', parse_error: null, extracted_path: null };
      if (kind === 'image') return { parse_status: 'parsed', parse_error: null, extracted_path: null };
      if (kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
        let text = '';
        if (kind === 'pdf') text = extractPdfText(buffer);
        else if (kind === 'docx') text = extractDocxText(buffer);
        else if (kind === 'xlsx') text = extractXlsxText(buffer);
        else text = extractPptxText(buffer);
        if (!text) {
          return {
            parse_status: 'failed',
            parse_error: `no extractable text found in ${kind.toUpperCase()} file ${row.original_name}`
          };
        }
        const extractedName = `${row.file_id}.extracted.txt`;
        const extractedPath = join(this._chatDir(row.chat_id), extractedName);
        writeFileSync(extractedPath, text, 'utf8');
        return {
          parse_status: 'parsed',
          parse_error: null,
          extracted_path: relative(this.dataDir, extractedPath).split(sep).join('/')
        };
      }
      if (kind === 'zip') {
        const extractedDir = join(this._chatDir(row.chat_id), `${row.file_id}.unzipped`);
        const tree = this._extractZip(buffer, extractedDir);
        return {
          parse_status: 'parsed',
          parse_error: null,
          extracted_path: relative(this.dataDir, extractedDir).split(sep).join('/'),
          zip_tree: tree
        };
      }
      return {
        parse_status: 'unsupported',
        parse_error: `cannot extract text from ${row.original_name} (${row.mime ?? 'unknown type'}); `
          + 'supported: PDF, DOCX, XLSX, PPTX, ZIP, text/code and images'
      };
    } catch (error) {
      return { parse_status: 'failed', parse_error: error.message };
    }
  }

  _extractZip(buffer, destination) {
    const { entries } = readZipEntries(buffer);
    const files = [];
    let total = 0;
    let depthMax = 0;
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      if (zipEntryIsSymlink(entry)) throw new Error(`ZIP contains a symbolic link, which is not allowed: ${entry.name}`);
      const safeName = safeZipEntryName(entry.name);
      if (!safeName) continue;
      const depth = safeName.split('/').length - 1;
      depthMax = Math.max(depthMax, depth);
      if (depth > this.maxZipDepth) {
        throw new Error(`ZIP entry ${entry.name} exceeds the maximum nesting depth ${this.maxZipDepth}`);
      }
      if (files.length >= this.maxZipFiles) {
        throw new Error(`ZIP contains more than ${this.maxZipFiles} files`);
      }
      if (entry.uncompressedSize > this.maxZipEntryBytes) {
        throw new Error(`ZIP entry ${entry.name} exceeds the ${this.maxZipEntryBytes}-byte per-file limit`);
      }
      total += entry.uncompressedSize;
      if (total > this.maxZipTotalBytes) {
        throw new Error(`ZIP expands beyond the ${this.maxZipTotalBytes}-byte total limit`);
      }
      const data = zipEntryData(buffer, entry);
      if (data.length > this.maxZipEntryBytes) {
        throw new Error(`ZIP entry ${entry.name} exceeds the per-file limit after decompression`);
      }
      const target = resolve(destination, safeName);
      this._assertInside(destination, target);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, data);
      files.push({ path: safeName, size: data.length });
    }
    if (files.length === 0) throw new Error('ZIP archive contains no files');
    return { file_count: files.length, total_bytes: total, max_depth: depthMax, files };
  }

  kindOf(name, mime) {
    const ext = extensionOf(name);
    const type = String(mime ?? '').toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext) || IMAGE_MIMES.has(type)) return 'image';
    if (ext === '.pdf' || type === 'application/pdf') return 'pdf';
    if (ext === '.docx') return 'docx';
    if (ext === '.xlsx') return 'xlsx';
    if (ext === '.pptx') return 'pptx';
    if (ext === '.zip' || type === 'application/zip' || type === 'application/x-zip-compressed') return 'zip';
    if (TEXT_EXTENSIONS.has(ext) || type.startsWith('text/')
      || type === 'application/json' || type === 'application/xml'
      || type === 'application/javascript' || type === 'application/x-yaml') return 'text';
    return 'binary';
  }

  list(chatId, limit = 100) {
    return this.store.listChatFiles(chatId, limit).map((row) => this.describe(row));
  }

  // ------------------------------------------------------------------
  // Tool-facing aliases. The MCP layer uses snake_case arguments and keeps
  // the vision decision here so every caller (including future embedders)
  // gets the same rule: an executor without vision never receives image bytes.
  // ------------------------------------------------------------------
  initUpload({ chat_id: chatId, name, size, mime, uploader }) {
    return this.init({ chatId, name, size, mime, uploaderId: uploader });
  }

  appendChunk({ upload_id: uploadId, index, data, uploader }) {
    return this.chunk({ uploadId, index, data, uploaderId: uploader });
  }

  completeUpload({ upload_id: uploadId, uploader }) {
    return this.complete({ uploadId, uploaderId: uploader });
  }

  listFiles({ chat_id: chatId, limit }) {
    return { chat_id: chatId, files: this.list(chatId, limit ?? 100) };
  }

  readFile({ chat_id: chatId, file_id: fileId, entry = null, max_bytes: maxBytes, actor = null }) {
    const result = this.read({ chatId, fileId, entry, maxBytes, actor });
    if (result.kind !== 'image') return result;
    const participant = actor?.master ? 'user' : actor?.participant;
    const vision = Boolean(actor?.master || this.config.executorVision?.[participant]);
    if (!vision) {
      throw new Error(
        `executor '${participant}' cannot receive image content (no vision input). `
        + `File ${result.file_id} (${result.name}) is stored in chat ${result.chat_id}; `
        + 'read a text extract or ask a vision-capable participant to describe it.'
      );
    }
    if (result.buffer.length > 5 * 1024 * 1024) {
      throw new Error(
        `image ${result.name} is ${result.buffer.length} bytes, above the 5 MB inline image limit`
      );
    }
    const { buffer, ...meta } = result;
    return {
      ...meta,
      image: {
        data: buffer.toString('base64'),
        mimeType: result.mime || 'application/octet-stream'
      }
    };
  }

  _readTextFile(path, maxBytes) {
    const info = statSync(path);
    const cap = Math.max(1024, Math.min(MAX_TEXT_RETURN, Number(maxBytes) || 200 * 1024));
    const bytes = readFileSync(path);
    const truncated = bytes.length > cap;
    return {
      text: bytes.subarray(0, cap).toString('utf8'),
      truncated,
      bytes: info.size
    };
  }

  _resolveZipEntry(row, entry) {
    if (!row.extracted_path) {
      throw new Error(`ZIP file ${row.original_name} has no extracted directory (parse_status=${row.parse_status})`);
    }
    const base = resolve(this.dataDir, row.extracted_path);
    this._assertInside(this._chatDir(row.chat_id), base);
    const normalized = String(entry).replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '')) {
      throw new Error(`invalid ZIP entry path: ${entry}`);
    }
    const target = resolve(base, normalized);
    this._assertInside(base, target);
    if (!existsSync(target)) throw new Error(`ZIP entry not found: ${entry}`);
    const real = realpathSync(target);
    this._assertInside(realpathSync(base), real);
    const info = statSync(real);
    if (!info.isFile()) throw new Error(`ZIP entry is not a file: ${entry}`);
    return { path: real, size: info.size, base };
  }

  // Returns a structured result. Image results carry `buffer`/`mime`; the tool
  // layer decides whether the calling executor can receive image content.
  read({ chatId, fileId, entry = null, maxBytes = 200 * 1024, actor = null }) {
    const row = this.store.getChatFile(fileId);
    if (!row) throw new Error(`file not found: ${fileId}`);
    if (row.chat_id !== chatId) {
      throw new Error(`file ${fileId} belongs to chat ${row.chat_id}, not ${chatId}`);
    }
    if (row.parse_status === 'failed' || row.parse_status === 'unsupported') {
      throw new Error(`cannot read ${row.original_name}: ${row.parse_error || row.parse_status}`);
    }
    const kind = this.kindOf(row.original_name, row.mime);
    const storedPath = this._resolveStored(row);
    if (!existsSync(storedPath)) throw new Error(`stored file is missing for ${fileId}`);

    if (kind === 'zip') {
      if (!entry) {
        const base = resolve(this.dataDir, row.extracted_path);
        this._assertInside(this._chatDir(chatId), base);
        return {
          ...this.describe(row),
          kind: 'zip',
          tree: listTree(base),
          hint: 'Pass entry with a path from this tree to read one file inside the archive.'
        };
      }
      const resolved = this._resolveZipEntry(row, entry);
      const innerName = basename(resolved.path);
      const innerKind = this.kindOf(innerName, null);
      const buffer = readFileSync(resolved.path);
      if (innerKind === 'image') {
        return {
          ...this.describe(row),
          kind: 'image',
          entry: String(entry),
          name: innerName,
          mime: normalizeMime(null, innerName),
          size: buffer.length,
          buffer
        };
      }
      if (innerKind !== 'text') {
        throw new Error(`ZIP entry ${entry} is ${innerKind}; only text/code files inside ZIPs can be read as text`);
      }
      const cap = Math.max(1024, Math.min(MAX_TEXT_RETURN, Number(maxBytes) || 200 * 1024));
      const truncated = buffer.length > cap;
      return {
        ...this.describe(row),
        kind: 'text',
        entry: String(entry),
        name: innerName,
        text: buffer.subarray(0, cap).toString('utf8'),
        truncated,
        total_bytes: buffer.length
      };
    }

    if (kind === 'image') {
      const buffer = readFileSync(storedPath);
      return {
        ...this.describe(row),
        kind: 'image',
        mime: row.mime || normalizeMime(null, row.original_name),
        size: buffer.length,
        buffer
      };
    }

    if (kind !== 'text' && kind !== 'pdf' && kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') {
      throw new Error(
        `cannot read ${row.original_name} (${row.mime ?? 'unknown type'}): unsupported binary format. `
        + 'Upload PDF/DOCX/XLSX/PPTX/ZIP/text or an image instead.'
      );
    }

    const sourcePath = row.extracted_path
      ? resolve(this.dataDir, row.extracted_path)
      : storedPath;
    this._assertInside(this._chatDir(chatId), sourcePath);
    const result = this._readTextFile(sourcePath, maxBytes);
    return {
      ...this.describe(row),
      kind: 'text',
      source: row.extracted_path ? `extracted from ${row.original_name}` : 'original',
      text: result.text,
      truncated: result.truncated,
      total_bytes: result.bytes
    };
  }

  // Clean up an upload session that was abandoned (best effort).
  abort(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return false;
    this.uploads.delete(uploadId);
    try { rmSync(upload.tmpPath, { force: true }); } catch { /* ignore */ }
    return true;
  }
}