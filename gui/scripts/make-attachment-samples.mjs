import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Generates the attachment samples used by scripts/verify-attachments.mjs:
 * a PDF, a DOCX, an XLSX, a ZIP, a PNG, a TypeScript source (over 1 MB, to
 * exercise multi-chunk upload) and a Markdown note.
 *
 * The files are real format containers (ZIP structured, PDF with a content
 * stream), just small enough to assert against.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate or store, UTF-8 names, no data descriptors). */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([local, nameBuf, payload]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function makePdf() {
  const lines = [
    'Agent Workbench PDF sample',
    'Quarterly attachment report',
    'PDF text extraction is a backend concern; this file only proves upload,',
    'kind detection and the preview contract.',
  ];
  const content = lines
    .map((line, index) => `BT /F1 14 Tf 72 ${760 - index * 22} Td (${line}) Tj ET`)
    .join('\n');
  const streamLength = Buffer.byteLength(content, 'utf8');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamLength} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const header = '%PDF-1.4\n';
  let offset = Buffer.byteLength(header, 'utf8');
  const parts = [header];
  const xref = [];
  for (const object of objects) {
    xref.push(offset);
    parts.push(object);
    offset += Buffer.byteLength(object, 'utf8');
  }
  const startxref = offset;
  const xrefLines = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...xref.map((value) => `${String(value).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(startxref),
    '%%EOF',
  ];
  parts.push(`${xrefLines.join('\n')}\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

function makeDocx() {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>Agent Workbench DOCX 样例</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>附件上传后应能被解析并生成摘要。</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>第四季度协作纪要。</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    },
  ]);
}

function makeXlsx() {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="附件统计" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">' +
        '<si><t>文件</t></si><si><t>大小</t></si><si><t>解析状态</t></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1048576</v></c><c r="C2" t="s"><v>3</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
}

function makeZipSample() {
  return makeZip([
    { name: 'readme.txt', data: 'Agent Workbench 压缩包样例\n包含两个文件。\n' },
    { name: 'data/metrics.csv', data: 'metric,value\nmessages,42\nfiles,3\n' },
  ]);
}

/** 8×8 PNG with an orange block, built by hand so no image library is needed. */
export function makePng() {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
      raw[pixel] = inside ? 0xe8 : 0xf5;
      raw[pixel + 1] = inside ? 0x5d : 0xf3;
      raw[pixel + 2] = inside ? 0x26 : 0xee;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ~1.4 MB of TypeScript so the upload path must use more than one 1 MB chunk. */
function makeBigCode() {
  const header = [
    '// 大文件分片上传样例（> 1 MB）',
    '// 该文件用于验证前端按 1 MB 分片上传，而不是一次性 arrayBuffer。',
    'export interface ChunkReport {',
    '  index: number;',
    '  offset: number;',
    '  size: number;',
    '}',
    '',
    'export function summarizeChunks(reports: ChunkReport[]): string {',
    '  const total = reports.reduce((sum, report) => sum + report.size, 0);',
    '  return `${reports.length} chunks / ${total} bytes`;',
    '}',
    '',
  ].join('\n');
  const line =
    "export const sampleLine = '分片上传测试：这一行会被重复以生成超过 1MB 的源码文件';\n";
  const target = 1_400_000;
  let body = header;
  while (body.length < target) {
    body += line;
  }
  return Buffer.from(body, 'utf8');
}

export function makeSamples(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    'sample-report.pdf': makePdf(),
    'sample-memo.docx': makeDocx(),
    'sample-metrics.xlsx': makeXlsx(),
    'sample-bundle.zip': makeZipSample(),
    'sample-screenshot.png': makePng(),
    'big-code.ts': makeBigCode(),
    'notes.md': Buffer.from(
      '# 附件联调笔记\n\n- 拖拽文件到聊天窗口\n- 多选上传\n- 粘贴图片\n- 预览 / 删除 / 进度\n',
      'utf8',
    ),
  };
  const paths = [];
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, data);
    paths.push(target);
  }
  return paths;
}

if (process.argv[1] != null && process.argv[1].endsWith('make-attachment-samples.mjs')) {
  const outDir = process.argv[2] ?? path.resolve('.verify-attachments');
  const paths = makeSamples(outDir);
  console.log(JSON.stringify({ outDir, files: paths }, null, 2));
}
