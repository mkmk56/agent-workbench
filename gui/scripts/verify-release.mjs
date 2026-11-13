#!/usr/bin/env node
/**
 * Fails the release when electron-builder produced an incomplete update set.
 *
 * Checks the installer, its blockmap and latest.yml, then cross-checks the
 * version, path, size and sha512 metadata against the bytes on disk. Run this
 * on the build output and again on files downloaded from the GitHub Release.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');

function fail(message) {
  console.error(`[verify-release] FAIL: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = { dir: path.join(PROJECT_DIR, 'release'), version: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      result.dir = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--dir=')) {
      result.dir = path.resolve(arg.slice('--dir='.length));
    } else if (arg === '--version') {
      result.version = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--version=')) {
      result.version = arg.slice('--version='.length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (result.version == null) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
    result.version = pkg.version;
  }
  return result;
}

function parseLatestYml(text) {
  const top = {};
  const files = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim().length === 0) {
      continue;
    }
    const urlMatch = /^\s*-\s+url:\s*(.+)$/.exec(line);
    if (urlMatch) {
      current = { url: urlMatch[1].trim().replace(/^['"]|['"]$/g, '') };
      files.push(current);
      continue;
    }
    const fileField = /^\s{2,}(sha512|size):\s*(.+)$/.exec(line);
    if (fileField && current != null) {
      current[fileField[1]] = fileField[2].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const topField = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (topField) {
      top[topField[1]] = topField[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  top.files = files;
  return top;
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

function main() {
  const { dir, version } = parseArgs(process.argv.slice(2));
  assert(fs.existsSync(dir), `release directory not found: ${dir}`);

  const installerName = `AgentWorkbench-Setup-${version}.exe`;
  const installerPath = path.join(dir, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const latestPath = path.join(dir, 'latest.yml');

  assert(fs.existsSync(installerPath), `installer missing: ${installerPath}`);
  assert(fs.existsSync(blockmapPath), `blockmap missing: ${blockmapPath}`);
  assert(fs.existsSync(latestPath), `latest.yml missing: ${latestPath}`);

  const installerSize = fs.statSync(installerPath).size;
  const blockmapSize = fs.statSync(blockmapPath).size;
  const latestSize = fs.statSync(latestPath).size;
  assert(installerSize > 10 * 1024 * 1024, `installer is unexpectedly small: ${installerSize} bytes`);
  assert(blockmapSize > 0, 'blockmap is empty');
  assert(latestSize > 0, 'latest.yml is empty');

  const latestText = fs.readFileSync(latestPath, 'utf8');
  const latest = parseLatestYml(latestText);
  assert(latest.version === version, `latest.yml version ${latest.version} != expected ${version}`);
  assert(latest.path === installerName, `latest.yml path ${latest.path} != ${installerName}`);
  assert(latest.sha512 != null, 'latest.yml is missing sha512');
  assert(latest.files.length >= 1, 'latest.yml files list is empty');
  if (latest.size != null) {
    assert(
      Number(latest.size) === installerSize,
      `latest.yml size ${latest.size} != installer size ${installerSize}`,
    );
  }

  const primary = latest.files[0];
  assert(
    decodeURIComponent(primary.url) === installerName,
    `latest.yml files[0].url ${primary.url} != ${installerName}`,
  );
  assert(
    Number(primary.size) === installerSize,
    `latest.yml files[0].size ${primary.size} != installer size ${installerSize}`,
  );

  const hash = sha512Base64(installerPath);
  assert(latest.sha512 === hash, 'latest.yml top-level sha512 does not match installer bytes');
  assert(primary.sha512 === hash, 'latest.yml files[0].sha512 does not match installer bytes');

  let blockmap;
  try {
    blockmap = JSON.parse(zlib.gunzipSync(fs.readFileSync(blockmapPath)).toString('utf8'));
  } catch (error) {
    fail(`blockmap is not valid gzip JSON: ${error.message}`);
  }
  assert(blockmap.version === '2', `unexpected blockmap format version: ${blockmap.version}`);
  assert(Array.isArray(blockmap.files) && blockmap.files.length > 0, 'blockmap files list is empty');
  for (const entry of blockmap.files) {
    assert(
      typeof entry.name === 'string' &&
        Array.isArray(entry.checksums) &&
        entry.checksums.length > 0,
      'blockmap entry is missing name/checksums',
    );
  }

  const summary = {
    version,
    installer: installerName,
    installerBytes: installerSize,
    installerMiB: Number((installerSize / 1024 / 1024).toFixed(2)),
    blockmap: path.basename(blockmapPath),
    blockmapBytes: blockmapSize,
    latestYmlBytes: latestSize,
    sha512: hash,
    releaseDate: latest.releaseDate ?? null,
    blockmapEntries: blockmap.files.length,
  };
  console.log(`[verify-release] OK ${JSON.stringify(summary)}`);
}

main();