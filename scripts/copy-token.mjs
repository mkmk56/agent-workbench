import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const env = readFileSync('D:/Claude/agent-workbench/workbench.env', 'utf8');
const token = env.match(/^MCP_BEARER_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) {
  console.error('MCP_BEARER_TOKEN not found in workbench.env');
  process.exit(1);
}

const tmp = join(tmpdir(), `muse-token-${Date.now()}.txt`);
writeFileSync(tmp, token, 'utf8');
const set = spawnSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${tmp.replace(/'/g, "''")}')`], { encoding: 'utf8' });
unlinkSync(tmp);
if (set.status !== 0) {
  console.error('Set-Clipboard failed:', set.stderr);
  process.exit(1);
}

const check = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Clipboard -Raw).Trim().Length'], { encoding: 'utf8' });
console.log(`token copied; len=${token.length}; clipboard_len=${String(check.stdout).trim()}`);