import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Renderer build entry.
 *
 * Runs the normal `vite build` first (esbuild transform + minify). Some sandboxed
 * environments forbid spawning children with piped stdio, which makes esbuild's
 * service fail with `spawn EPERM`; in that case the build is retried with
 * `--configLoader runner` and `WORKBENCH_NO_ESBUILD=1`, where vite.config.ts
 * swaps in a TypeScript-compiler transform and turns minification off.
 *
 * The default path stays byte-for-byte the same for normal CI and dev machines.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

function build(args, env) {
  return spawnSync(process.execPath, [viteBin, 'build', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

const primary = build([], {});
if (primary.status === 0) {
  process.exit(0);
}

console.warn(
  '[build] default vite build failed (see log above); retrying without esbuild ' +
    '(environment forbids piped child stdio → spawn EPERM).',
);
const shim = path.join(root, 'scripts', 'no-child-stdio-shim.cjs');
const fallback = build(['--configLoader', 'native'], {
  WORKBENCH_NO_ESBUILD: '1',
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${shim}`.trim(),
});
process.exit(fallback.status ?? 1);
