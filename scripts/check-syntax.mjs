// Lightweight "typecheck" for this JavaScript-only repository: node --check
// parses every server module. There is no TypeScript project in the backend,
// so this is the equivalent build-gate the workbench can run without adding a
// compiler dependency.

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = [join(root, 'src'), join(root, 'src', 'executors'), join(root, 'scripts')];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = targets
  .flatMap((dir) => walk(dir))
  .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
  .sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`syntax error: ${file}`);
    if (error.stderr) process.stderr.write(error.stderr);
  }
}
console.log(`checked ${files.length} JavaScript files; ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);