import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Main-process attachment service.
 *
 * Security model:
 *  - The renderer never receives a host path. Paths come from
 *    `dialog.showOpenDialog` (main) or `webUtils.getPathForFile` (preload) and
 *    are turned into opaque `draftId` handles kept in this registry.
 *  - Files uploaded to the engine are addressed by `file_id` only. Every engine
 *    call here uses `chat_id` + `file_id`, never a raw path.
 *  - Large files are streamed as 1 MB chunks (init → chunk×N → complete), so no
 *    `arrayBuffer` round-trip and no multi-hundred-megabyte IPC payloads.
 *
 * This module only imports Node builtins so its upload/read logic can be
 * exercised headlessly by `scripts/verify-attachments.mjs`.
 */

export type ChatFileKind =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'zip'
  | 'code'
  | 'text'
  | 'other';

export type UploadSource = 'dialog' | 'drop' | 'paste';

export interface AttachmentDraft {
  draftId: string;
  name: string;
  size: number;
  mime: string;
  ext: string;
  kind: ChatFileKind;
  source: UploadSource;
}

export interface ChatFilePayload {
  file_id: string;
  chat_id: string | null;
  name: string;
  size: number;
  mime: string;
  kind: ChatFileKind;
  sha256: string | null;
  status: string | null;
  preview_text: string | null;
  preview_truncated: boolean;
  uploader: string | null;
  created_at: string | null;
  /** Only present on upload results so the tray can map drafts to files. */
  draft_id?: string | null;
}

export interface UploadProgress {
  uploadId: string;
  draftId: string;
  fileId: string | null;
  name: string;
  size: number;
  uploaded: number;
  percent: number;
  phase: 'init' | 'chunk' | 'complete' | 'done' | 'error';
  error?: string;
}

export interface FileReadResult {
  file_id: string;
  name: string;
  mime: string;
  kind: ChatFileKind;
  size: number;
  mode: 'text' | 'base64';
  content: string;
  encoding: 'utf8' | 'base64';
  offset: number;
  next_offset: number | null;
  truncated: boolean;
  preview_text: string | null;
}

/** The subset of the engine client the attachment service needs. */
export interface AttachmentEngine {
  uploadChatFileInit(input: {
    chatId: string;
    name: string;
    size: number;
    mime: string;
  }): Promise<Record<string, unknown>>;
  uploadChatFileChunk(input: {
    uploadId: string;
    index: number;
    dataBase64: string;
  }): Promise<Record<string, unknown>>;
  uploadChatFileComplete(input: {
    uploadId: string;
    sha256?: string;
  }): Promise<Record<string, unknown>>;
  readChatFile(input: {
    chatId: string;
    fileId: string;
    entry?: string;
    maxBytes?: number;
  }): Promise<Record<string, unknown>>;
  listChatFiles?(input: {
    chatId: string;
    limit?: number;
  }): Promise<{ files: Array<Record<string, unknown>> }>;
}

/** Result of materializing a file for preview/download. */
export interface FetchedFile {
  bytes: Buffer;
  name: string;
  /** Content type for the response; text previews are normalized to text/plain. */
  mime: string;
  kind: ChatFileKind;
  /** True when `bytes` are extracted text, not the original file content. */
  extracted: boolean;
}

export const CHUNK_SIZE = 1_024 * 1_024;
const MIN_CHUNK_SIZE = 16 * 1_024;
const MAX_CHUNK_SIZE = 8 * 1_024 * 1_024;
// Keep in sync with the backend limit: src/files.js defaults chatMaxFileBytes
// to 20 MB. Declaring a larger GUI limit produced uploads the engine rejected.
export const MAX_FILE_BYTES = 20 * 1_024 * 1_024;
export const MAX_FILES_PER_UPLOAD = 20;
export const MAX_PENDING_DRAFTS = 50;
const MAX_BUFFER_INTAKE_BYTES = 16 * 1_024 * 1_024;
const DRAFT_TTL_MS = 60 * 60 * 1_000;
const CHUNK_RETRIES = 2;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'md', 'markdown', 'rst']);
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sql', 'sh', 'bash', 'zsh', 'ps1',
  'bat', 'cmd', 'lua', 'pl', 'r', 'dart', 'vue', 'svelte', 'diff', 'patch', 'dockerfile',
  'makefile', 'gradle', 'mjs',
]);

/** Types that may be served inline by the custom protocol. Never HTML/SVG. */
const INLINE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  pdf_: 'application/pdf',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
};

interface DraftRecord extends AttachmentDraft {
  path: string;
  temp: boolean;
  createdAt: number;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

export function baseNameOf(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

export function detectKind(name: string, mime?: string | null): ChatFileKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext) || (mime != null && mime.startsWith('image/'))) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'docx' || ext === 'doc' || ext === 'rtf' || ext === 'odt') {
    return 'docx';
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv' || ext === 'tsv') {
    return ext === 'csv' || ext === 'tsv' ? 'text' : 'xlsx';
  }
  if (ext === 'pptx' || ext === 'ppt' || ext === 'odp') {
    return 'pptx';
  }
  if (ext === 'zip' || ext === 'gz' || ext === 'tgz' || ext === '7z' || ext === 'rar' || ext === 'tar') {
    return 'zip';
  }
  if (CODE_EXT.has(ext)) {
    return 'code';
  }
  if (TEXT_EXT.has(ext) || (mime != null && mime.startsWith('text/'))) {
    return 'text';
  }
  return 'other';
}

export function mimeFor(name: string, fallback = 'application/octet-stream'): string {
  const ext = extensionOf(name);
  return MIME_BY_EXT[ext] ?? fallback;
}

export function inlineContentType(name: string, mime?: string | null): string | null {
  const ext = extensionOf(name);
  if (INLINE_MIME[ext] != null) {
    return INLINE_MIME[ext];
  }
  if (mime != null && /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(mime)) {
    return mime;
  }
  return null;
}

/** Strip anything that could escape a directory or break a header. */
export function safeFileName(name: string): string {
  const base = baseNameOf(name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  const cleaned = base.length > 0 ? base : 'file';
  return cleaned.length > 180 ? cleaned.slice(-180) : cleaned;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

/** Normalize the engine's file object into the wire shape the renderer uses. */
export function normalizeChatFile(raw: unknown, fallbackChatId?: string): ChatFilePayload | null {
  const record = asRecord(raw);
  const nested = asRecord(record.file);
  const source = Object.keys(nested).length > 0 ? nested : record;
  const fileId = readString(source, 'file_id', 'fileId', 'id');
  if (fileId == null) {
    return null;
  }
  const name = readString(source, 'name', 'filename', 'file_name') ?? '未命名文件';
  const size = readNumber(source, 'size', 'bytes', 'length') ?? 0;
  const mime = readString(source, 'mime', 'mime_type', 'content_type') ?? mimeFor(name);
  const declaredKind = readString(source, 'kind');
  const kind =
    declaredKind != null && isKind(declaredKind) ? declaredKind : detectKind(name, mime);
  return {
    file_id: fileId,
    chat_id: readString(source, 'chat_id', 'chatId') ?? fallbackChatId ?? null,
    name,
    size,
    mime,
    kind,
    sha256: readString(source, 'sha256', 'hash'),
    status: readString(source, 'status', 'parse_status'),
    preview_text: readString(source, 'preview_text', 'preview', 'text'),
    preview_truncated: readBoolean(source, 'preview_truncated', 'truncated') ?? false,
    uploader: readString(source, 'uploader', 'uploader_id', 'from'),
    created_at: readString(source, 'created_at', 'createdAt'),
  };
}

function isKind(value: string): value is ChatFileKind {
  return (
    value === 'image' ||
    value === 'pdf' ||
    value === 'docx' ||
    value === 'xlsx' ||
    value === 'pptx' ||
    value === 'zip' ||
    value === 'code' ||
    value === 'text' ||
    value === 'other'
  );
}

export function normalizeFileRead(
  raw: unknown,
  request: { chatId: string; fileId: string; mode: 'text' | 'base64' },
): FileReadResult {
  const record = asRecord(raw);
  const file = normalizeChatFile(record.file ?? record, request.chatId);
  const mode = readString(record, 'mode') === 'base64' ? 'base64' : request.mode;
  const content = readString(record, 'content', 'text', 'data') ?? '';
  const encoding = readString(record, 'encoding') === 'base64' || mode === 'base64' ? 'base64' : 'utf8';
  return {
    file_id: file?.file_id ?? request.fileId,
    name: file?.name ?? request.fileId,
    mime: file?.mime ?? 'application/octet-stream',
    kind: file?.kind ?? 'other',
    size: file?.size ?? 0,
    mode,
    content,
    encoding,
    offset: readNumber(record, 'offset') ?? 0,
    next_offset: readNumber(record, 'next_offset', 'nextOffset'),
    truncated: readBoolean(record, 'truncated') ?? false,
    preview_text: file?.preview_text ?? readString(record, 'preview_text'),
  };
}

function sha256OfBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AttachmentServiceOptions {
  /** Where buffers pasted/clipboard-only land before upload. */
  tempDir: string;
  /** Where fetched bytes are materialized for "open"/"reveal". */
  cacheDir: string;
  maxFileBytes?: number;
  maxFilesPerUpload?: number;
  maxPendingDrafts?: number;
}

/**
 * Owns draft handles and the chunked upload pipeline. Stateless with respect to
 * the engine, so it can be unit-tested against a stub MCP server.
 */
export class AttachmentService {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly maxFileBytes: number;
  private readonly maxFilesPerUpload: number;
  private readonly maxPendingDrafts: number;

  constructor(private readonly options: AttachmentServiceOptions) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.maxFilesPerUpload = options.maxFilesPerUpload ?? MAX_FILES_PER_UPLOAD;
    this.maxPendingDrafts = options.maxPendingDrafts ?? MAX_PENDING_DRAFTS;
  }

  /** Remove temp files left behind by a previous run. Best effort. */
  async sweepTemp(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.options.tempDir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
      for (const entry of entries) {
        const target = path.join(this.options.tempDir, entry);
        try {
          const stat = await fsp.stat(target);
          if (stat.mtimeMs < cutoff) {
            await fsp.rm(target, { force: true });
          }
        } catch {
          // Someone else removed it; nothing to do.
        }
      }
    } catch {
      // The directory does not exist yet.
    }
  }

  /** Register paths chosen by the main-process dialog or dropped onto the window. */
  async registerPaths(paths: unknown, source: UploadSource): Promise<AttachmentDraft[]> {
    if (!Array.isArray(paths)) {
      throw new Error('文件列表格式无效。');
    }
    const candidates = paths.filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (candidates.length === 0) {
      throw new Error('没有选择任何文件。');
    }
    if (candidates.length > this.maxFilesPerUpload) {
      throw new Error(`一次最多选择 ${this.maxFilesPerUpload} 个文件。`);
    }
    this.pruneExpired();
    if (this.drafts.size + candidates.length > this.maxPendingDrafts) {
      throw new Error(`待发送附件过多（上限 ${this.maxPendingDrafts} 个），请先发送或移除。`);
    }

    const drafts: AttachmentDraft[] = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        throw new Error(`文件不存在或无法读取：${baseNameOf(resolved)}`);
      }
      if (!stat.isFile()) {
        throw new Error(`只能上传文件，不能上传文件夹：${baseNameOf(resolved)}`);
      }
      if (stat.size <= 0) {
        throw new Error(`文件为空，未加入待发送列表：${baseNameOf(resolved)}`);
      }
      if (stat.size > this.maxFileBytes) {
        throw new Error(
          `文件过大（${formatBytes(stat.size)}），单个文件上限 ${formatBytes(this.maxFileBytes)}：${baseNameOf(resolved)}`,
        );
      }
      drafts.push(this.addRecord({
        path: resolved,
        temp: false,
        name: safeFileName(baseNameOf(resolved)),
        size: stat.size,
        source,
      }));
    }
    return drafts;
  }

  /** Clipboard images have no on-disk path, so they arrive as bytes. */
  async registerBuffer(input: {
    name: unknown;
    mime: unknown;
    data: Buffer;
    source: UploadSource;
  }): Promise<AttachmentDraft> {
    this.pruneExpired();
    if (input.data.length === 0) {
      throw new Error('剪贴板中没有可上传的内容。');
    }
    if (input.data.length > Math.min(this.maxFileBytes, MAX_BUFFER_INTAKE_BYTES)) {
      throw new Error(`粘贴内容过大（${formatBytes(input.data.length)}）。`);
    }
    if (this.drafts.size + 1 > this.maxPendingDrafts) {
      throw new Error(`待发送附件过多（上限 ${this.maxPendingDrafts} 个），请先发送或移除。`);
    }
    await fsp.mkdir(this.options.tempDir, { recursive: true });
    const rawName = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name : 'pasted-file';
    const name = safeFileName(rawName);
    const tempPath = path.join(this.options.tempDir, `${crypto.randomUUID()}-${name}`);
    await fsp.writeFile(tempPath, input.data);
    return this.addRecord({
      path: tempPath,
      temp: true,
      name,
      size: input.data.length,
      mime: typeof input.mime === 'string' && input.mime.length > 0 ? input.mime : undefined,
      source: input.source,
    });
  }

  removeDrafts(draftIds: unknown): void {
    if (!Array.isArray(draftIds)) {
      return;
    }
    for (const id of draftIds) {
      if (typeof id !== 'string') {
        continue;
      }
      const record = this.drafts.get(id);
      if (record == null) {
        continue;
      }
      this.drafts.delete(id);
      if (record.temp) {
        void fsp.rm(record.path, { force: true }).catch(() => {
          // The temp file may already be gone.
        });
      }
    }
  }

  hasDraft(draftId: string): boolean {
    return this.drafts.has(draftId);
  }

  listDrafts(): AttachmentDraft[] {
    this.pruneExpired();
    return [...this.drafts.values()].map(toPublicDraft);
  }

  /**
   * Upload drafts with 1 MB chunks. Returns per-file results plus per-file
   * errors: one failed file never aborts the rest of the batch.
   */
  async upload(input: {
    chatId: string;
    draftIds: unknown;
    uploadId: string;
    engine: AttachmentEngine;
    onProgress?: (progress: UploadProgress) => void;
  }): Promise<{ files: ChatFilePayload[]; errors: Array<{ draftId: string; name: string; error: string }> }> {
    if (!Array.isArray(input.draftIds)) {
      throw new Error('待上传文件列表格式无效。');
    }
    const ids = input.draftIds.filter((item): item is string => typeof item === 'string');
    if (ids.length === 0) {
      throw new Error('没有待上传的文件。');
    }
    if (ids.length > this.maxFilesPerUpload) {
      throw new Error(`一次最多上传 ${this.maxFilesPerUpload} 个文件。`);
    }
    const records: DraftRecord[] = [];
    for (const id of ids) {
      const record = this.drafts.get(id);
      if (record == null) {
        throw new Error('待上传文件已过期，请重新选择。');
      }
      records.push(record);
    }

    const files: ChatFilePayload[] = [];
    const errors: Array<{ draftId: string; name: string; error: string }> = [];
    for (const record of records) {
      const emit = (progress: Partial<UploadProgress>) => {
        input.onProgress?.({
          uploadId: input.uploadId,
          draftId: record.draftId,
          fileId: progress.fileId ?? null,
          name: record.name,
          size: record.size,
          uploaded: progress.uploaded ?? 0,
          percent: progress.percent ?? 0,
          phase: progress.phase ?? 'chunk',
          ...(progress.error != null ? { error: progress.error } : {}),
        });
      };
      try {
        const file = await this.uploadOne({
          chatId: input.chatId,
          record,
          engine: input.engine,
          emit,
        });
        files.push({ ...file, draft_id: record.draftId });
        emit({ fileId: file.file_id, uploaded: record.size, percent: 100, phase: 'done' });
        this.drafts.delete(record.draftId);
        if (record.temp) {
          await fsp.rm(record.path, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ draftId: record.draftId, name: record.name, error: message });
        emit({ phase: 'error', error: message });
      }
    }
    return { files, errors };
  }

  /**
   * Materialize one file for preview/download, by file_id only.
   *
   * `read_chat_file` returns extracted text for documents and an MCP image
   * block for images. Documents therefore yield their *extracted text*, marked
   * `extracted: true`; saving the original binary needs the backend raw-bytes
   * endpoint tracked in the integration report.
   */
  async fetchBytes(input: {
    chatId: string;
    fileId: string;
    engine: AttachmentEngine;
    maxBytes?: number;
  }): Promise<FetchedFile> {
    const maxBytes = input.maxBytes ?? this.maxFileBytes;
    const raw = asRecord(
      await input.engine.readChatFile({
        chatId: input.chatId,
        fileId: input.fileId,
        maxBytes: Math.min(maxBytes, 2_000_000),
      }),
    );
    const meta = asRecord(raw.file);
    const name = readString(meta, 'name') ?? readString(raw, 'name') ?? input.fileId;
    const declaredMime = readString(meta, 'mime') ?? readString(raw, 'mime') ?? mimeFor(name);
    const kind = detectKind(name, declaredMime);

    const image = asRecord(raw.image);
    const imageData = readString(image, 'data');
    if (imageData != null) {
      const bytes = Buffer.from(imageData, 'base64');
      if (bytes.length > maxBytes) {
        throw new Error(`图片超过可预览上限（${formatBytes(maxBytes)}）。`);
      }
      return {
        bytes,
        name,
        mime: readString(image, 'mimeType') ?? declaredMime,
        kind: 'image',
        extracted: false,
      };
    }

    const text = readString(raw, 'text');
    if (text == null) {
      throw new Error(
        '该文件没有可预览的文本：后端尚未提供原始字节读取（待联调：GET /chats/:id/files/:fileId）。',
      );
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`文本超过可预览上限（${formatBytes(maxBytes)}）。`);
    }
    return {
      bytes: Buffer.from(text, 'utf8'),
      name,
      // Never inline HTML/SVG/PDF from extracted text: the protocol serves it
      // as plain text so untrusted content cannot execute in the app origin.
      mime: 'text/plain; charset=utf-8',
      kind,
      extracted: kind !== 'text' && kind !== 'code',
    };
  }

  /** Write fetched bytes to a unique cache file so the OS can open/ reveal them. */
  async cacheToDisk(input: {
    chatId: string;
    fileId: string;
    name: string;
    bytes: Buffer;
  }): Promise<string> {
    await fsp.mkdir(this.options.cacheDir, { recursive: true });
    const dir = path.join(
      this.options.cacheDir,
      safeFileName(input.chatId).slice(0, 64),
      safeFileName(input.fileId).slice(0, 64),
    );
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, safeFileName(input.name));
    await fsp.writeFile(target, input.bytes);
    return target;
  }

  async writeTo(targetPath: string, bytes: Buffer): Promise<void> {
    await fsp.writeFile(targetPath, bytes);
  }

  private addRecord(input: {
    path: string;
    temp: boolean;
    name: string;
    size: number;
    mime?: string;
    source: UploadSource;
  }): AttachmentDraft {
    const draftId = crypto.randomUUID();
    const ext = extensionOf(input.name);
    const mime = input.mime ?? mimeFor(input.name);
    const record: DraftRecord = {
      draftId,
      path: input.path,
      temp: input.temp,
      name: input.name,
      size: input.size,
      mime,
      ext,
      kind: detectKind(input.name, mime),
      source: input.source,
      createdAt: Date.now(),
    };
    this.drafts.set(draftId, record);
    return toPublicDraft(record);
  }

  private async uploadOne(input: {
    chatId: string;
    record: DraftRecord;
    engine: AttachmentEngine;
    emit: (progress: Partial<UploadProgress>) => void;
  }): Promise<ChatFilePayload> {
    const { record, engine } = input;
    const digest = await sha256OfFile(record.path);
    input.emit({ phase: 'init', uploaded: 0, percent: 0 });

    // Backend contract: init returns upload_id + chunk_size; the file_id only
    // exists after complete. Chunks must arrive in strict index order.
    const init = asRecord(
      await engine.uploadChatFileInit({
        chatId: input.chatId,
        name: record.name,
        size: record.size,
        mime: record.mime,
      }),
    );
    const uploadId = readString(init, 'upload_id', 'uploadId');
    if (uploadId == null) {
      throw new Error('引擎未返回 upload_id，上传无法继续。');
    }
    const remoteSize = readNumber(init, 'size');
    if (remoteSize != null && remoteSize !== record.size) {
      throw new Error('引擎记录的尺寸与本地文件不一致，已中止上传。');
    }
    const chunkSize = clampChunkSize(readNumber(init, 'chunk_size', 'chunkSize'));
    const handle = await fsp.open(record.path, 'r');
    let offset = 0;
    let index = 0;
    try {
      while (offset < record.size) {
        const length = Math.min(chunkSize, record.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead <= 0) {
          break;
        }
        const payload = buffer.subarray(0, bytesRead);
        await this.sendChunk({
          engine,
          uploadId,
          index,
          payload,
        });
        index += 1;
        offset += bytesRead;
        input.emit({
          phase: 'chunk',
          fileId: null,
          uploaded: offset,
          percent: Math.min(99, Math.round((offset / record.size) * 100)),
        });
      }
    } finally {
      await handle.close();
    }
    if (offset !== record.size) {
      throw new Error('本地文件在读取过程中变短，已中止上传。');
    }

    input.emit({ phase: 'complete', fileId: null, uploaded: record.size, percent: 99 });
    const complete = asRecord(
      await engine.uploadChatFileComplete({
        uploadId,
        sha256: digest,
      }),
    );
    const file = normalizeChatFile(complete.file ?? complete, input.chatId);
    const fileId = file?.file_id ?? readString(complete, 'file_id', 'fileId', 'id');
    if (fileId == null) {
      throw new Error('引擎未返回 file_id，上传结果无法确认。');
    }
    const fallback: ChatFilePayload = {
      file_id: fileId,
      chat_id: input.chatId,
      name: record.name,
      size: record.size,
      mime: record.mime,
      kind: record.kind,
      sha256: digest,
      status: 'parsed',
      preview_text: null,
      preview_truncated: false,
      uploader: 'user',
      created_at: null,
    };
    return file ?? fallback;
  }

  private async sendChunk(input: {
    engine: AttachmentEngine;
    uploadId: string;
    index: number;
    payload: Buffer;
  }): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
      try {
        await input.engine.uploadChatFileChunk({
          uploadId: input.uploadId,
          index: input.index,
          dataBase64: input.payload.toString('base64'),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A retry after a lost response is already stored server-side; the
        // ordered-chunk check reports it as "expected index N, got index <N".
        const outOfOrder = /expected index (\d+),\s*got (\d+)/i.exec(message);
        if (outOfOrder != null && Number(outOfOrder[2]) < Number(outOfOrder[1])) {
          return;
        }
        lastError = error;
        if (attempt < CHUNK_RETRIES) {
          await sleep(250 * (attempt + 1));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('分片上传失败。');
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - DRAFT_TTL_MS;
    for (const [id, record] of this.drafts) {
      if (record.createdAt < cutoff) {
        this.drafts.delete(id);
        if (record.temp) {
          void fsp.rm(record.path, { force: true }).catch(() => undefined);
        }
      }
    }
  }
}

function toPublicDraft(record: DraftRecord): AttachmentDraft {
  return {
    draftId: record.draftId,
    name: record.name,
    size: record.size,
    mime: record.mime,
    ext: record.ext,
    kind: record.kind,
    source: record.source,
  };
}

function clampChunkSize(value: number | null): number {
  if (value == null) {
    return CHUNK_SIZE;
  }
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(value)));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
