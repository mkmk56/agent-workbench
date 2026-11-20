/**
 * Files page data rules (REA Phase 4 §7.2): search, sort, uploader/date labels.
 *
 * Pure functions only — no React, no DOM, no `window` — so the rules can be
 * exercised with `node --test` (see gui/test/file-list.test.ts). The only
 * import is a type, so the test never needs to resolve the runtime module.
 */
import type { ChatFile } from '../types';

export type FileSortKey = 'time' | 'size' | 'name';

/** Default order: newest upload first. */
export const FILE_SORT_DEFAULT: FileSortKey = 'time';

/** Labels of the sort control; kept here so page and tests share one source. */
export const FILE_SORT_OPTIONS: ReadonlyArray<{ value: FileSortKey; label: string }> = [
  { value: 'time', label: '时间' },
  { value: 'size', label: '大小' },
  { value: 'name', label: '名称' },
];

/** ISO-ish string → epoch ms, or null when absent/unparseable (sorted last). */
export function fileTimeMs(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `YYYY-MM-DD HH:mm` in the reader's local timezone. An empty or unparseable
 * value reports "日期未知" instead of inventing a date.
 */
export function formatUploadDate(value: string | null | undefined): string {
  const ms = fileTimeMs(value);
  if (ms == null) {
    return '日期未知';
  }
  const date = new Date(ms);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const UPLOADER_LABELS: Record<string, string> = {
  user: '你',
  muse: 'Muse',
  claude: 'Claude',
  dsh: 'dsh',
};

/**
 * Participant id → display label. Unknown ids (e.g. `agent_7` from a paired
 * agent) are echoed verbatim: the page must not invent a person's name.
 */
export function uploaderLabel(uploader: string | null | undefined): string {
  const id = (uploader ?? '').trim();
  if (id.length === 0) {
    return '上传者未知';
  }
  return UPLOADER_LABELS[id] ?? id;
}

/** One card line: who uploaded it and when. */
export function fileOriginLabel(
  file: Pick<ChatFile, 'uploader' | 'created_at'>,
): string {
  return `${uploaderLabel(file.uploader)} · ${formatUploadDate(file.created_at)}`;
}

/** Case-insensitive file-name substring filter; a blank query keeps every file. */
export function filterFilesByName(
  files: readonly ChatFile[],
  query: string,
): ChatFile[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...files];
  }
  return files.filter((file) => file.name.toLowerCase().includes(needle));
}

function compareName(a: ChatFile, b: ChatFile): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Newest first; files with no usable `created_at` sort last. */
function compareTime(a: ChatFile, b: ChatFile): number {
  const left = fileTimeMs(a.created_at);
  const right = fileTimeMs(b.created_at);
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }
  return right - left;
}

/** Largest first; a missing size (0) therefore drops to the end. */
function compareSize(a: ChatFile, b: ChatFile): number {
  const left = Number.isFinite(a.size) ? Math.max(0, a.size) : 0;
  const right = Number.isFinite(b.size) ? Math.max(0, b.size) : 0;
  return right - left;
}

/**
 * Non-mutating sort. Ties always fall back to the name comparison, so the list
 * order is stable enough that cards do not jump around between refreshes.
 */
export function sortFiles(files: readonly ChatFile[], key: FileSortKey): ChatFile[] {
  const order = [...files];
  order.sort((a, b) => {
    if (key === 'name') {
      return compareName(a, b) || compareTime(a, b);
    }
    if (key === 'size') {
      return compareSize(a, b) || compareName(a, b);
    }
    return compareTime(a, b) || compareName(a, b);
  });
  return order;
}

/** Filter + sort in one step, the order the page actually renders. */
export function visibleFiles(
  files: readonly ChatFile[],
  options: { query?: string; sort?: FileSortKey } = {},
): ChatFile[] {
  const query = options.query ?? '';
  const sort = options.sort ?? FILE_SORT_DEFAULT;
  return sortFiles(filterFilesByName(files, query), sort);
}