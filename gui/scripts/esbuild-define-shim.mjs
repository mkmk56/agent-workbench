/**
 * esbuild stand-in used only by the no-esbuild renderer build.
 *
 * Vite's `vite:define` plugin calls `esbuild.transform(code, { define })` to
 * substitute `process.env.NODE_ENV` / `import.meta.env.*`. Starting the real
 * esbuild service needs a child process with piped stdio, which this sandbox
 * forbids (`spawn EPERM`), so the fallback build swaps in a textual define
 * substitution. Everything else is re-exported from the real package.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const realPath = fileURLToPath(new URL('../node_modules/esbuild/lib/main.js', import.meta.url));
const real = require(realPath);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function replaceDefines(code, define) {
  let out = code;
  for (const [key, value] of Object.entries(define)) {
    const pattern = new RegExp(escapeRegex(key), 'g');
    out = out.replace(pattern, () => String(value));
  }
  return out;
}

export function transform(code, options) {
  if (options == null || typeof options.define !== 'object' || options.define == null) {
    return Promise.reject(
      new Error('esbuild shim only supports the define-replacement path'),
    );
  }
  return Promise.resolve({
    code: replaceDefines(code, options.define),
    map: '',
    warnings: [],
    mimeType: 'application/javascript',
  });
}

export function transformSync(code, options) {
  if (options == null || options.define == null) {
    throw new Error('esbuild shim only supports define replacement');
  }
  return { code: replaceDefines(code, options.define), map: '', warnings: [] };
}

export const build = real.build;
export const buildSync = real.buildSync;
export const formatMessages = real.formatMessages;
export const analyzeMetafile = real.analyzeMetafile;
export const version = real.version;
export default real;
