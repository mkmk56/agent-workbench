/**
 * Attachment rendering model for the chat stream (task §3 / P0-5 scheme B).
 *
 * Pure helpers only (no React, no DOM globals) so the rules can be exercised
 * with `node --test`. The components (`EditedFilesCard`, `MessageBubble`,
 * `FileCard`) consume them.
 *
 * Scheme B (docs/REFACTOR_PLAN.md §3.1 P0-5) in one line: the message carries
 * the attachment objects the engine returned; `list_chat_files` is merged on
 * top as the authoritative record for the whole chat. Anything the engine does
 * not send is shown as unknown — no invented size, status or line counts.
 */
import type { ChatFile, ChatFileKind, ChatMessage } from '../types';

/**
 * Render-layer sentinel: the message referenced a `file_id` that neither the
 * message payload nor `list_chat_files` could describe. It is never a value the
 * engine sends, and the UI shows it as "状态未知" — never as "解析中".
 */
export const UNRESOLVED_FILE_STATUS = 'unresolved';

/** Render-layer sentinel for a historical attachment (legacy path string). */
export const LEGACY_FILE_STATUS = 'legacy-path';

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '大小未知';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `kindOf` prefers the engine's `kind` (P0-5); the name is only a fallback. */
export function fileKindOf(file: ChatFile): ChatFileKind {
  if (file.kind != null && file.kind.length > 0) {
    return file.kind;
  }
  const name = file.name.toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(name) || file.mime.startsWith('image/')) {
    return 'image';
  }
  if (name.endsWith('.pdf')) {
    return 'pdf';
  }
  if (/\.(docx?|rtf|odt)$/.test(name)) {
    return 'docx';
  }
  if (/\.(xlsx?|csv|ods)$/.test(name)) {
    return 'xlsx';
  }
  if (/\.(pptx?|odp)$/.test(name)) {
    return 'pptx';
  }
  if (/\.(zip|gz|tgz|7z|rar|tar)$/.test(name)) {
    return 'zip';
  }
  if (/\.(py|js|ts|tsx|jsx|java|c|h|cpp|html|css|json|xml|sql|sh|ps1)$/.test(name)) {
    return 'code';
  }
  if (/\.(txt|md|log|csv|tsv)$/.test(name)) {
    return 'text';
  }
  return 'other';
}

export const FILE_KIND_LABELS: Record<ChatFileKind, string> = {
  image: '图片',
  pdf: 'PDF',
  docx: '文档',
  xlsx: '表格',
  pptx: '演示文稿',
  zip: '压缩包',
  code: '代码',
  text: '文本',
  other: '文件',
};

export type FileStatusTone = 'neutral' | 'success' | 'warning' | 'error';

export type FileStatusView = { label: string; tone: FileStatusTone };

/**
 * Engine `status` → Chinese label. Unknown values are echoed verbatim instead
 * of being coerced into a status the engine never reported.
 */
export function fileStatusOf(file: ChatFile): FileStatusView {
  const status = (file.status ?? '').trim().toLowerCase();
  switch (status) {
    case '':
    case 'unknown':
      return { label: '状态未知', tone: 'neutral' };
    case 'parsed':
    case 'ready':
      return { label: '已解析', tone: 'success' };
    case 'pending':
      return { label: '解析中', tone: 'warning' };
    case 'failed':
      return { label: '解析失败', tone: 'error' };
    case 'unsupported':
      return { label: '不支持预览', tone: 'neutral' };
    case LEGACY_FILE_STATUS:
      return { label: '历史附件（路径）', tone: 'neutral' };
    case UNRESOLVED_FILE_STATUS:
      return { label: '状态未知', tone: 'neutral' };
    default:
      return { label: file.status, tone: 'neutral' };
  }
}

/** Historical attachments (pre-object messages) cannot be previewed/downloaded. */
export function isHistoricalFile(file: ChatFile): boolean {
  return file.status === LEGACY_FILE_STATUS;
}

/** Metadata the engine never returned for this handle. */
export function isUnresolvedFile(file: ChatFile): boolean {
  return file.status === UNRESOLVED_FILE_STATUS;
}

/**
 * The full path/name as the engine returned it. Never shortened here: the card
 * wraps it (task §5: 路径完整显示，禁止截断).
 */
export function fileDisplayName(file: ChatFile): string {
  if (isUnresolvedFile(file)) {
    return `附件（${file.file_id.slice(0, 8)}）`;
  }
  const name = file.name ?? '';
  return name.length > 0 ? name : `附件（${file.file_id.slice(0, 8)}）`;
}

/**
 * "变更摘要" column. The chat file contract carries size + kind + parse state
 * only — there are no added/deleted line counts anywhere in the engine, so this
 * reports exactly what the engine sends instead of inventing a diff.
 */
export function fileSummaryOf(file: ChatFile): string {
  if (isHistoricalFile(file)) {
    return '历史附件 · 无文件对象';
  }
  if (isUnresolvedFile(file)) {
    return '引擎未返回该附件的元数据';
  }
  const kind = FILE_KIND_LABELS[fileKindOf(file)];
  const size = file.size > 0 ? formatFileSize(file.size) : '大小未知';
  return `${size} · ${kind}`;
}

/**
 * Split a path into wrap-friendly segments at the separators, so a long path
 * breaks after `/` or `\` (keeping each segment's meaning intact) instead of
 * breaking in the middle of a directory name. A single very long segment is
 * still allowed to break by the CSS fallback (`overflow-wrap: anywhere`).
 */
export function pathSegments(path: string): string[] {
  if (path.length === 0) {
    return [];
  }
  const segments: string[] = [];
  let current = '';
  for (const char of path) {
    current += char;
    if (char === '/' || char === '\\') {
      segments.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

/** `file_id` → authoritative ChatFile for one chat. */
export function indexChatFiles(files: readonly ChatFile[]): Map<string, ChatFile> {
  const index = new Map<string, ChatFile>();
  for (const file of files) {
    if (file.file_id.length > 0) {
      index.set(file.file_id, file);
    }
  }
  return index;
}

function mergeOne(file: ChatFile, index: Map<string, ChatFile>): ChatFile {
  const known = index.get(file.file_id);
  if (known != null) {
    // list_chat_files is authoritative for name/size/kind/status (scheme B).
    // Keep the message's uploader/created_at when the index row has none, so
    // the card can still show who attached it.
    return {
      ...known,
      chat_id: known.chat_id ?? file.chat_id,
      uploader: known.uploader ?? file.uploader,
      created_at: known.created_at.length > 0 ? known.created_at : file.created_at,
    };
  }
  if (isHistoricalFile(file)) {
    // Legacy path rows are expected to be unknown to list_chat_files: they were
    // never uploaded. Keep the label and disable preview/download.
    return file;
  }
  // Nothing describes this handle. Say so rather than rendering "0 B / 解析中".
  const hasMetadata = file.size > 0 || (file.status.length > 0 && file.status !== 'pending');
  if (hasMetadata) {
    return file;
  }
  return { ...file, status: UNRESOLVED_FILE_STATUS };
}

/**
 * Merge the chat-file index into every message's attachments. Messages with no
 * attachments are returned as-is (identity preserved) so React keys and the
 * message list keep working unchanged.
 */
export function mergeMessageFiles(
  messages: readonly ChatMessage[],
  index: Map<string, ChatFile> | null,
): ChatMessage[] {
  if (index == null || index.size === 0) {
    return messages.map((message) =>
      message.files.length === 0
        ? message
        : { ...message, files: message.files.map((file) => mergeOne(file, index ?? new Map())) },
    );
  }
  return messages.map((message) =>
    message.files.length === 0
      ? message
      : { ...message, files: message.files.map((file) => mergeOne(file, index)) },
  );
}

/** All attachment handles referenced by the given messages (stable order). */
export function collectFileIds(messages: readonly ChatMessage[]): string[] {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const file of message.files) {
      if (file.file_id.length > 0) {
        seen.add(file.file_id);
      }
    }
  }
  return [...seen];
}

/** Caveats next to the card's count ("1 个历史附件 · 1 个待确认"), or ''. */
export function editedCardExtras(files: readonly ChatFile[]): string {
  const historical = files.filter(isHistoricalFile).length;
  const unresolved = files.filter(isUnresolvedFile).length;
  const parts: string[] = [];
  if (historical > 0) {
    parts.push(`${historical} 个历史附件`);
  }
  if (unresolved > 0) {
    parts.push(`${unresolved} 个待确认`);
  }
  return parts.join(' · ');
}

/** Summary line of the "Edited" card header (counts only — no fake diffs). */
export function editedCardSummary(files: readonly ChatFile[]): string {
  const extras = editedCardExtras(files);
  if (extras.length === 0) {
    return `${files.length} 个附件`;
  }
  return `${files.length} 个附件 · ${extras}`;
}