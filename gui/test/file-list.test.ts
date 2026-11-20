/**
 * Spec checks for the Files page data rules (REA Phase 4 §7.2 [G]).
 *
 * Run with: npm run test:files
 *   node --test --experimental-strip-types --experimental-test-isolation=none test/file-list.test.ts
 *
 * These pin what the page may claim: search is a case-insensitive name
 * substring, sorting never mutates the input and always has a defined order,
 * and a missing uploader/date renders as "未知" instead of an invented value.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILE_SORT_DEFAULT,
  FILE_SORT_OPTIONS,
  fileOriginLabel,
  fileTimeMs,
  filterFilesByName,
  formatUploadDate,
  sortFiles,
  uploaderLabel,
  visibleFiles,
} from '../src/lib/file-list.ts';
import type { ChatFile } from '../src/types.ts';

const file = (overrides: Partial<ChatFile> = {}): ChatFile => ({
  file_id: 'file-1',
  name: 'report.md',
  size: 1024,
  mime: 'text/markdown',
  kind: 'text',
  status: 'parsed',
  uploader: 'claude',
  created_at: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

/** Local-time ISO string: the formatter renders local time, so the round trip is TZ-proof. */
const localIso = (year: number, month: number, day: number, hour: number, minute: number): string =>
  new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();

test('filterFilesByName matches a name substring, case-insensitively', () => {
  const files = [
    file({ file_id: 'a', name: 'Quarterly-Report.PDF' }),
    file({ file_id: 'b', name: 'notes.md' }),
    file({ file_id: 'c', name: '季度报告.xlsx' }),
  ];

  assert.deepEqual(
    filterFilesByName(files, 'report').map((item) => item.file_id),
    ['a'],
  );
  assert.deepEqual(
    filterFilesByName(files, 'REPORT').map((item) => item.file_id),
    ['a'],
  );
  assert.deepEqual(
    filterFilesByName(files, '报告').map((item) => item.file_id),
    ['c'],
  );
  assert.deepEqual(filterFilesByName(files, 'missing'), []);
});

test('filterFilesByName trims the query and keeps everything for a blank one', () => {
  const files = [file({ file_id: 'a', name: 'a.txt' }), file({ file_id: 'b', name: 'b.txt' })];

  assert.deepEqual(
    filterFilesByName(files, '  a.txt  ').map((item) => item.file_id),
    ['a'],
  );
  assert.equal(filterFilesByName(files, '').length, 2);
  assert.equal(filterFilesByName(files, '   ').length, 2);
  // A copy, not the caller's array: the page keeps its unfiltered list.
  assert.notEqual(filterFilesByName(files, ''), files);
});

test('sortFiles by time puts the newest first and files without a date last', () => {
  const files = [
    file({ file_id: 'old', name: 'old.txt', created_at: '2026-11-01T10:00:00.000Z' }),
    file({ file_id: 'new', name: 'new.txt', created_at: '2026-11-20T10:00:00.000Z' }),
    file({ file_id: 'none', name: 'none.txt', created_at: '' }),
    file({ file_id: 'bad', name: 'bad.txt', created_at: 'not-a-date' }),
  ];

  const sorted = sortFiles(files, 'time');
  assert.deepEqual(
    sorted.map((item) => item.file_id),
    ['new', 'old', 'bad', 'none'],
  );
  // The caller's array keeps its order.
  assert.deepEqual(
    files.map((item) => item.file_id),
    ['old', 'new', 'none', 'bad'],
  );
});

test('sortFiles by size puts the largest first', () => {
  const files = [
    file({ file_id: 'small', name: 'small.txt', size: 10 }),
    file({ file_id: 'big', name: 'big.txt', size: 5_000_000 }),
    file({ file_id: 'unknown', name: 'unknown.txt', size: 0 }),
  ];

  assert.deepEqual(
    sortFiles(files, 'size').map((item) => item.file_id),
    ['big', 'small', 'unknown'],
  );
});

test('sortFiles by name compares numbers inside names and ignores case', () => {
  const files = [
    file({ file_id: '10', name: 'file10.txt' }),
    file({ file_id: '2', name: 'file2.txt' }),
    file({ file_id: 'alpha', name: 'Alpha.txt' }),
  ];

  assert.deepEqual(
    sortFiles(files, 'name').map((item) => item.file_id),
    ['alpha', '2', '10'],
  );
});

test('sortFiles breaks ties with the name so the order is stable', () => {
  const stamp = '2026-11-20T10:00:00.000Z';
  const files = [
    file({ file_id: 'b', name: 'b.txt', size: 7, created_at: stamp }),
    file({ file_id: 'a', name: 'a.txt', size: 7, created_at: stamp }),
  ];

  assert.deepEqual(
    sortFiles(files, 'time').map((item) => item.file_id),
    ['a', 'b'],
  );
  assert.deepEqual(
    sortFiles(files, 'size').map((item) => item.file_id),
    ['a', 'b'],
  );
});

test('fileTimeMs reports null for absent or unparseable values', () => {
  assert.equal(fileTimeMs(''), null);
  assert.equal(fileTimeMs('   '), null);
  assert.equal(fileTimeMs(null), null);
  assert.equal(fileTimeMs(undefined), null);
  assert.equal(fileTimeMs('not-a-date'), null);
  assert.equal(fileTimeMs('2026-11-17T10:00:00.000Z'), Date.parse('2026-11-17T10:00:00.000Z'));
});

test('formatUploadDate renders local "YYYY-MM-DD HH:mm"', () => {
  assert.equal(formatUploadDate(localIso(2026, 3, 5, 9, 7)), '2026-03-05 09:07');
  assert.equal(formatUploadDate(localIso(2026, 12, 31, 23, 59)), '2026-12-31 23:59');
});

test('formatUploadDate never invents a date', () => {
  assert.equal(formatUploadDate(''), '日期未知');
  assert.equal(formatUploadDate('   '), '日期未知');
  assert.equal(formatUploadDate(null), '日期未知');
  assert.equal(formatUploadDate(undefined), '日期未知');
  assert.equal(formatUploadDate('not-a-date'), '日期未知');
});

test('uploaderLabel maps known participants and echoes unknown ids', () => {
  assert.equal(uploaderLabel('user'), '你');
  assert.equal(uploaderLabel('claude'), 'Claude');
  assert.equal(uploaderLabel('muse'), 'Muse');
  assert.equal(uploaderLabel('dsh'), 'dsh');
  assert.equal(uploaderLabel('agent_7'), 'agent_7');
  assert.equal(uploaderLabel(null), '上传者未知');
  assert.equal(uploaderLabel(undefined), '上传者未知');
  assert.equal(uploaderLabel('   '), '上传者未知');
});

test('fileOriginLabel shows uploader and date together', () => {
  assert.equal(
    fileOriginLabel(
      file({ uploader: 'dsh', created_at: localIso(2026, 11, 20, 14, 5) }),
    ),
    'dsh · 2026-11-20 14:05',
  );
  assert.equal(fileOriginLabel(file({ uploader: null, created_at: '' })), '上传者未知 · 日期未知');
});

test('visibleFiles applies search and sort together', () => {
  const files = [
    file({ file_id: 'a', name: 'report-2026.pdf', created_at: '2026-11-01T10:00:00.000Z' }),
    file({ file_id: 'b', name: 'Report-old.pdf', created_at: '2026-11-20T10:00:00.000Z' }),
    file({ file_id: 'c', name: 'notes.md', created_at: '2026-11-25T10:00:00.000Z' }),
  ];

  assert.deepEqual(
    visibleFiles(files, { query: 'report', sort: 'time' }).map((item) => item.file_id),
    ['b', 'a'],
  );
  assert.deepEqual(
    visibleFiles(files).map((item) => item.file_id),
    ['c', 'b', 'a'],
  );
  assert.equal(FILE_SORT_DEFAULT, 'time');
});

test('FILE_SORT_OPTIONS offers time, size and name in one place', () => {
  assert.deepEqual(
    FILE_SORT_OPTIONS.map((option) => option.value),
    ['time', 'size', 'name'],
  );
  assert.deepEqual(
    FILE_SORT_OPTIONS.map((option) => option.label),
    ['时间', '大小', '名称'],
  );
});