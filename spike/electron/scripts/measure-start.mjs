import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) args.set(arg.slice(2), process.argv[i + 1] ?? true);
}

const exe = args.get('exe');
if (!exe || !existsSync(exe)) {
  console.error('usage: node measure-start.mjs --exe <path> [--out <result.json>] [--smoke-out <smoke.json>] [--runs 3]');
  process.exit(1);
}
const runs = Number(args.get('runs') || 3);
const outPath = resolve(args.get('out') || 'artifacts/startup-measure.json');
const smokeOut = resolve(args.get('smoke-out') || 'artifacts/startup-smoke.json');
mkdirSync(dirname(outPath), { recursive: true });
mkdirSync(dirname(smokeOut), { recursive: true });

const samples = [];
for (let run = 1; run <= runs; run += 1) {
  const startedAt = process.hrtime.bigint();
  const child = spawn(exe, ['--smoke-test', '--attach', `--smoke-out=${smokeOut}`, `--out-dir=${dirname(smokeOut)}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise(code));
    child.on('error', () => resolvePromise(-1));
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  let smoke = null;
  try {
    smoke = JSON.parse(readFileSync(smokeOut, 'utf8'));
  } catch {
    smoke = null;
  }
  samples.push({
    run,
    exitCode,
    wallMs: Math.round(elapsedMs),
    appReadyMs: smoke?.appReadyMs ?? null,
    runAsNodeOk: smoke?.runAsNode?.ok ?? null,
    packaged: smoke?.packaged ?? null,
    stdoutTail: stdout.trim().split(/\r?\n/).slice(-2),
    stderrTail: stderr.trim() ? stderr.trim().split(/\r?\n/).slice(-3) : []
  });
}

const ok = samples.filter((sample) => sample.exitCode === 0);
const result = {
  exe,
  runs,
  samples,
  medianWallMs: ok.length ? ok.map((s) => s.wallMs).sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null,
  minWallMs: ok.length ? Math.min(...ok.map((s) => s.wallMs)) : null
};
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));