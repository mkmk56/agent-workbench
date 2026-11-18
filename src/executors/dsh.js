import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeResolution, resolveDshCommand } from '../config.js';
import { writeTaskMcpConfig } from '../mcp-config.js';
import { spawnProcess, killTree } from './process.js';

const MAX_HISTORY_CHARS = 12000;

function truncate(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

function dshHome() {
  return process.env.DSH_HOME ? String(process.env.DSH_HOME) : join(homedir(), '.dsh');
}

// dsh exposes a global usage ledger (not per task). Read it before and after a
// task and attribute only the events that appeared inside that window. This is
// best effort: two concurrent dsh tasks can interleave, so usage_source says
// 'dsh-ledger' rather than claiming per-call precision.
function readLedger() {
  try {
    const path = join(dshHome(), '.dshw-usage.json');
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(doc?.events) ? doc.events : [];
  } catch {
    return null;
  }
}

function ledgerBaseline() {
  const events = readLedger();
  if (!events) return null;
  return events.reduce((max, event) => Math.max(max, Number(event?.ts ?? 0)), 0);
}

function ledgerDelta(baseline) {
  if (baseline === null) return null;
  const events = readLedger();
  if (!events) return null;
  const fresh = events.filter((event) => Number(event?.ts ?? 0) > baseline);
  if (fresh.length === 0) return { events: [], cost: null, tokens: null, model: null };
  const cost = fresh.reduce((sum, event) => sum + (Number(event.cost) || 0), 0);
  const tokens = fresh.reduce((sum, event) => sum + (Number(event.tokens) || 0), 0);
  const model = [...fresh].reverse().find((event) => typeof event.model === 'string')?.model ?? null;
  return { events: fresh, cost, tokens, model };
}

// dsh stores sessions per workspace as
//   <DSH_HOME>/sessions/--C-Claude-agent-workbench-workspace--/session-<uuid>/
// The escaped directory collapses runs of separators to one dash.
export function dshSessionIdFor(cwd, startedAtMs) {
  try {
    const escaped = `--${String(cwd).replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')}--`;
    const dir = join(dshHome(), 'sessions', escaped);
    let best = null;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
      const info = statSync(join(dir, entry.name));
      if (info.mtimeMs < startedAtMs - 5000) continue;
      if (!best || info.mtimeMs > best.mtimeMs) best = { name: entry.name, mtimeMs: info.mtimeMs };
    }
    return best ? best.name.replace(/^session-/, '') : null;
  } catch {
    return null;
  }
}

function stitchPrompt(history, prompt) {
  if (!history || history.length === 0) return prompt;
  const lines = ['The following is the transcript of our earlier conversation in this session. Continue from it.', ''];
  let size = 0;
  const picked = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    const text = String(m.text || '');
    if (size + text.length > MAX_HISTORY_CHARS) break;
    size += text.length;
    picked.push(m);
  }
  picked.reverse();
  for (const m of picked) {
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('New message:');
  lines.push(prompt);
  return lines.join('\n');
}

export const dshExecutor = {
  name: 'dsh',
  resumeSupported: false,
  start(task, ctx) {
    // Same rule as claude: resolve per launch so an upgraded/replaced dsh is
    // picked up without restarting the engine.
    const resolved = resolveDshCommand();
    ctx.log('system', describeResolution(resolved));
    if (!resolved.found) {
      throw new Error('dsh executable not found; set WORKBENCH_DSH_ENTRY or add dsh to PATH');
    }
    const prompt = task.resume ? stitchPrompt(ctx.history, task.prompt) : task.prompt;
    const startedAt = Date.now();
    const ledgerBefore = ledgerBaseline();
    let out = '';
    let errText = '';
    let providerRequestId = null;
    // dsh has no built-in MCP client today, but its scoped credential and
    // config path are injected so a future tool bridge cannot accidentally
    // inherit the master token.
    let env = {};
    try {
      const mcpConfigPath = writeTaskMcpConfig(ctx.config, {
        agent: 'dsh',
        taskId: task.id,
        token: task.auth_token,
        chatId: task.chat_id || null
      });
      env = {
        WORKBENCH_MCP_CONFIG: mcpConfigPath,
        WORKBENCH_MCP_URL: ctx.config.mcpUrl,
        // 2026-11-18 user decision: full permissions for all agents.
        // dsh sandbox is broken on Win10 19045 (restricted-token spawn
        // dies 0xC0000142), so run it unconfined. Overridable via the
        // engine environment (DSH_PERMISSION_MODE).
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'danger-full-access',
        // Engine session predates the registry user-PATH update; append
        // the PowerShell 7 dir so bare `pwsh` resolves for dsh children.
        PATH: [process.env.PATH, 'C:\\Claude\\pwsh7'].filter(Boolean).join(';'),
        WORKBENCH_MCP_TOKEN: task.auth_token
      };
      ctx.log('system', `dsh task-bound mcp config=${mcpConfigPath} (token injected via env)`);
    } catch (error) {
      ctx.log('system', `dsh mcp config unavailable: ${error.message}`);
    }
    const child = spawnProcess({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args: ['--profile', 'headless', prompt],
      env,
      cwd: task.cwd || ctx.config.root,
      onLine: (stream, line) => {
        ctx.log(stream, line);
        if (stream === 'stdout') out += `${line}\n`;
        if (stream === 'stderr') {
          errText += `${line}\n`;
          const match = /request[_\s-]?id\s*[:=]\s*([A-Za-z0-9._:-]+)/i.exec(line);
          if (match) providerRequestId = match[1];
        }
      },
      onExit: (info) => {
        const summary = out.trim();
        const ledger = ledgerDelta(ledgerBefore);
        const hasLedger = Boolean(ledger && ledger.events.length > 0);
        // The ledger reports a total, not an input/output split. Record the
        // total and leave the split null instead of inventing numbers.
        const tokenUsage = hasLedger
          ? { input: null, output: null, total_tokens: ledger.tokens, source: 'dsh-ledger' }
          : null;
        ctx.setResult({
          isError: info.code !== 0,
          text: summary,
          tokens: null,
          metrics: {
            provider: ctx.config?.dshProvider ?? null,
            model: hasLedger ? ledger.model : null,
            provider_request_id: providerRequestId,
            token_usage: tokenUsage,
            token_usage_json: tokenUsage ? JSON.stringify(tokenUsage) : null,
            cost_usd: hasLedger ? ledger.cost : null,
            latency_ms: Date.now() - startedAt,
            duration_api_ms: null,
            ttft_ms: null,
            usage_source: hasLedger ? 'dsh-ledger' : 'unknown',
            session_id: dshSessionIdFor(task.cwd || ctx.config?.root, startedAt),
            request_summary: truncate(errText),
            response_summary: truncate(summary)
          }
        });
        ctx.exit(info);
      }
    });
    return {
      pid: child.pid,
      cancel: () => killTree(child.pid)
    };
  }
};