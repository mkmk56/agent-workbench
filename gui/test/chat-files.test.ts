/**
 * Spec checks for the "Edited files" card data model (task §3 / P0-5 scheme B).
 *
 * Run with: npm run test:chat   (node --test, no new dependencies)
 *
 * These pin the merge rules from docs/REFACTOR_PLAN.md §3.1: `list_chat_files`
 * is authoritative when the file_id is present, historical path rows stay
 * labelled and non-actionable, an unknown handle renders as unknown instead of
 * a fake "0 B / 解析中", and the path splits only at separators.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_FILE_STATUS,
  UNRESOLVED_FILE_STATUS,
  collectFileIds,
  editedCardExtras,
  editedCardSummary,
  fileDisplayName,
  fileKindOf,
  fileStatusOf,
  fileSummaryOf,
  formatFileSize,
  indexChatFiles,
  isHistoricalFile,
  isUnresolvedFile,
  mergeMessageFiles,
  pathSegments,
} from '../src/lib/chat-files.ts';
import type { ChatFile, ChatMessage } from '../src/types.ts';

const file = (overrides: Partial<ChatFile> = {}): ChatFile => ({
  file_id: 'file-1',
  name: 'src/executors/process.js',
  size: 12_800,
  mime: 'text/javascript',
  kind: 'code',
  sha256: null,
  status: 'parsed',
  preview_text: null,
  preview_truncated: false,
  uploader: 'claude',
  created_at: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  message_id: 'msg-1',
  chat_id: 'chat-1',
  seq: 1,
  from: 'claude',
  to: 'user',
  summary: '改完了',
  files: [],
  mentions: [],
  status: 'answered',
  created_at: '2026-11-17T10:00:00.000Z',
  task_id: null,
  ...overrides,
});

test('file size formatting keeps B/KB/MB readable', () => {
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2_048), '2.0 KB');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatFileSize(Number.NaN), '大小未知');
  assert.equal(formatFileSize(-1), '大小未知');
});

test('kind prefers the engine value over the file name', () => {
  assert.equal(fileKindOf(file({ kind: 'text', name: 'run.py' })), 'text');
  assert.equal(fileKindOf(file({ kind: 'code', name: 'notes.md' })), 'code');
});

test('status labels are Chinese and never invented', () => {
  assert.deepEqual(fileStatusOf(file({ status: 'parsed' })), { label: '已解析', tone: 'success' });
  assert.deepEqual(fileStatusOf(file({ status: 'pending' })), { label: '解析中', tone: 'warning' });
  assert.deepEqual(fileStatusOf(file({ status: 'failed' })), { label: '解析失败', tone: 'error' });
  assert.deepEqual(fileStatusOf(file({ status: 'unsupported' })), {
    label: '不支持预览',
    tone: 'neutral',
  });
  assert.deepEqual(fileStatusOf(file({ status: LEGACY_FILE_STATUS })), {
    label: '历史附件（路径）',
    tone: 'neutral',
  });
  assert.deepEqual(fileStatusOf(file({ status: UNRESOLVED_FILE_STATUS })), {
    label: '状态未知',
    tone: 'neutral',
  });
  // An unknown engine value is echoed, not coerced into a known status.
  assert.deepEqual(fileStatusOf(file({ status: 'quarantined' })), {
    label: 'quarantined',
    tone: 'neutral',
  });
});

test('an unresolved handle renders its file_id prefix, never a fake name', () => {
  const unknown = file({
    file_id: '9f1c2d3e4b5a6978',
    name: '',
    size: 0,
    status: UNRESOLVED_FILE_STATUS,
  });
  assert.equal(isUnresolvedFile(unknown), true);
  assert.equal(fileDisplayName(unknown), '附件（9f1c2d3e）');
  assert.equal(fileSummaryOf(unknown), '引擎未返回该附件的元数据');
});

test('historical rows are labelled and carry no size claim', () => {
  const legacy = file({
    file_id: 'D:\\old\\report.pdf',
    name: 'report.pdf',
    size: 0,
    status: LEGACY_FILE_STATUS,
  });
  assert.equal(isHistoricalFile(legacy), true);
  assert.equal(isUnresolvedFile(legacy), false);
  assert.equal(fileSummaryOf(legacy), '历史附件 · 无文件对象');
});

test('the summary column reports size + kind only (no invented diff)', () => {
  assert.equal(fileSummaryOf(file()), '12.5 KB · 代码');
  assert.equal(fileSummaryOf(file({ size: 0 })), '大小未知 · 代码');
});

test('paths split after separators so lines can break between segments', () => {
  assert.deepEqual(pathSegments('src/executors/process.js'), [
    'src/',
    'executors/',
    'process.js',
  ]);
  assert.deepEqual(pathSegments('C:\\work\\repo\\src\\a.ts'), [
    'C:\\',
    'work\\',
    'repo\\',
    'src\\',
    'a.ts',
  ]);
  assert.deepEqual(pathSegments('notes.md'), ['notes.md']);
  assert.deepEqual(pathSegments(''), []);
});

test('indexChatFiles maps by file_id and merge prefers the index row', () => {
  const fromMessage = file({ name: '旧名字.js', size: 1, status: 'pending' });
  const authoritative = file({ name: 'src/executors/process.js', size: 12_800, status: 'parsed' });
  const index = indexChatFiles([authoritative]);

  const merged = mergeMessageFiles([message({ files: [fromMessage] })], index);
  assert.equal(merged[0].files.length, 1);
  assert.equal(merged[0].files[0].name, 'src/executors/process.js');
  assert.equal(merged[0].files[0].size, 12_800);
  assert.equal(merged[0].files[0].status, 'parsed');
  // The message's uploader is kept when the index row has none.
  assert.equal(merged[0].files[0].uploader, 'claude');
});

test('merge keeps historical rows, marks unknown handles, leaves others intact', () => {
  const legacy = file({ file_id: 'D:/old/a.pdf', status: LEGACY_FILE_STATUS, size: 0, name: 'a.pdf' });
  const unknown = file({ file_id: 'deadbeefcafe', name: '', size: 0, status: '', });
  const known = file({ file_id: 'file-2', name: 'b.ts', size: 10, status: 'parsed' });

  const merged = mergeMessageFiles(
    [message({ files: [legacy, unknown, known] })],
    indexChatFiles([]),
  );
  assert.equal(merged[0].files[0].status, LEGACY_FILE_STATUS);
  assert.equal(merged[0].files[1].status, UNRESOLVED_FILE_STATUS);
  assert.equal(merged[0].files[2].status, 'parsed');
  assert.equal(fileDisplayName(merged[0].files[1]), '附件（deadbeef）');
});

test('messages without attachments keep their identity', () => {
  const plain = message();
  const merged = mergeMessageFiles([plain], null);
  assert.equal(merged[0], plain);
});

test('collectFileIds dedupes handles in first-seen order', () => {
  const ids = collectFileIds([
    message({ message_id: 'a', files: [file({ file_id: 'x' }), file({ file_id: 'y' })] }),
    message({ message_id: 'b', files: [file({ file_id: 'y' }), file({ file_id: 'z' })] }),
  ]);
  assert.deepEqual(ids, ['x', 'y', 'z']);
});

test('card header counts historical and unresolved rows', () => {
  assert.equal(editedCardSummary([file(), file({ file_id: 'f2' })]), '2 个附件');
  assert.equal(
    editedCardSummary([
      file({ file_id: 'a', status: LEGACY_FILE_STATUS }),
      file({ file_id: 'b', status: UNRESOLVED_FILE_STATUS }),
      file({ file_id: 'c' }),
    ]),
    '3 个附件 · 1 个历史附件 · 1 个待确认',
  );
  // The card prints the count next to its title and the extras in the meta
  // slot, so the two never repeat "N 个附件".
  assert.equal(editedCardExtras([file()]), '');
  assert.equal(
    editedCardExtras([file({ file_id: 'a', status: LEGACY_FILE_STATUS })]),
    '1 个历史附件',
  );
});