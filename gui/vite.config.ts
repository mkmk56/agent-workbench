import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * This build environment forbids spawning children with piped stdio (the
 * sandbox raises `spawn EPERM`), which esbuild's service needs. When
 * `WORKBENCH_NO_ESBUILD=1` is set (see scripts/build-renderer.mjs) the renderer
 * is transformed by the TypeScript compiler instead:
 *   - `esbuild: false` disables Vite's built-in TS/JSX transform
 *   - the plugin below strips TypeScript + compiles JSX with tsc
 *   - minification is disabled (esbuild does minify by default)
 * The default path (esbuild) is unchanged for normal CI/dev machines.
 */
const NO_ESBUILD = process.env.WORKBENCH_NO_ESBUILD === '1';

const TS_FILE = /\.[cm]?tsx?$/;

function typescriptFallback(): Plugin {
  return {
    name: 'aw:typescript-fallback',
    enforce: 'pre',
    async transform(code, id) {
      const [filepath] = id.split('?');
      if (!TS_FILE.test(filepath) || filepath.endsWith('.d.ts')) {
        return null;
      }
      const ts = await import('typescript');
      const result = ts.transpileModule(code, {
        fileName: filepath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          isolatedModules: true,
          esModuleInterop: true,
          sourceMap: true,
          inlineSources: true,
        },
      });
      return {
        code: result.outputText,
        map: result.sourceMapText != null ? JSON.parse(result.sourceMapText) : null,
      };
    },
  };
}

/**
 * `@vitejs/plugin-react` merges its own `esbuild: { jsx: 'automatic', … }`
 * options after the user config, which re-enables Vite's esbuild plugin. This
 * plugin is appended last so its config hook wins in the no-esbuild fallback.
 */
function disableEsbuild(): Plugin {
  return {
    name: 'aw:disable-esbuild',
    config: () => ({ esbuild: false }),
  };
}

export default defineConfig({
  base: './',
  plugins: NO_ESBUILD
    ? [typescriptFallback(), react(), disableEsbuild()]
    : [react()],
  esbuild: NO_ESBUILD ? false : undefined,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@brand': fileURLToPath(new URL('../assets/branding', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    ...(NO_ESBUILD ? { minify: false, cssMinify: false } : {}),
  },
});
