/**
 * Preload shim for the no-esbuild renderer build (scripts/build-renderer.mjs).
 *
 * This sandbox forbids spawning children with piped stdio (`spawn EPERM`), so
 * esbuild's service can never start. In the fallback build we disable Vite's
 * esbuild plugin, but two internals still reach for esbuild:
 *
 *  1. `child_process.exec('net use')` in Vite's Windows realpath optimisation —
 *     throws synchronously here; patched to report an error through its callback.
 *  2. `import { transform } from 'esbuild'` in `vite:define` (replacing
 *     `process.env.NODE_ENV` / `import.meta.env.*`). The resolve hook below
 *     redirects that import to scripts/esbuild-define-shim.mjs, a pure-JS
 *     textual define substitution.
 *
 * Anything else keeps using the real esbuild, so this file is inert outside the
 * fallback build and never changes the primary (esbuild) build.
 */
'use strict';

if (process.env.WORKBENCH_NO_ESBUILD === '1') {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { registerHooks } = require('node:module');

  const childProcess = require('node:child_process');
  const originalExec = childProcess.exec;

  childProcess.exec = function exec(command, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    try {
      return originalExec.call(childProcess, command, options, callback);
    } catch (error) {
      if (typeof cb === 'function') {
        process.nextTick(() => cb(error, '', ''));
        return { on() {}, kill() {}, stdin: null, stdout: null, stderr: null };
      }
      throw error;
    }
  };

  const shimUrl = pathToFileURL(path.join(__dirname, 'esbuild-define-shim.mjs')).href;
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'esbuild' && context.parentURL !== shimUrl) {
          return { url: shimUrl, shortCircuit: true, format: 'module' };
        }
        return nextResolve(specifier, context);
      },
    });
  }
}
