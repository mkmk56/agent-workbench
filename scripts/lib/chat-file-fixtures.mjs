// Minimal, spec-valid sample files for the chat file tests.
//
// The PDF / DOCX / XLSX / ZIP samples are small but structurally real, so the
// backend parsers (extractPdfText / extractDocxText / extractXlsxText /
// readZipEntries) do the actual work — no mocked parser is involved.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Store-only ZIP writer (the backend reader accepts method 0 and 8). */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name, data]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); // external attrs: no symlink
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += locals.at(-1).length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

export function makePdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${object}\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function makeDocx(text) {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" '
        + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        + 'Target="word/document.xml"/></Relationships>'
    },
    {
      name: 'word/document.xml',
      data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
    }
  ]);
}

export function makeXlsx(cell) {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/></Types>'
    },
    {
      name: 'xl/sharedStrings.xml',
      data: '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<si><t>${cell}</t></si></sst>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
    }
  ]);
}

export function makeZipSample() {
  return makeZip([
    { name: 'notes/readme.txt', data: 'ZIP-FIXTURE-MARKER inside the archive\n' },
    { name: 'data/values.csv', data: 'a,b\n1,2\n' }
  ]);
}

export const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

/** Standard set used by both the backend and the GUI upload verifications. */
export function sampleFixtures() {
  return [
    { name: 'sample.pdf', mime: 'application/pdf', data: makePdf('PDF-FIXTURE-MARKER hello pdf') },
    { name: 'sample.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: makeDocx('DOCX-FIXTURE-MARKER hello docx') },
    { name: 'sample.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: makeXlsx('XLSX-FIXTURE-MARKER') },
    { name: 'sample.zip', mime: 'application/zip', data: makeZipSample() },
    { name: 'sample.png', mime: 'image/png', data: PNG_1X1 },
    {
      name: 'large.txt',
      mime: 'text/plain',
      data: Buffer.from(`LARGE-FIXTURE-MARKER\n${'chunk-data-0123456789\n'.repeat(120000)}`, 'utf8')
    }
  ];
}
