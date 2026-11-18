import { describeResolution, resolveClaudeCommand } from '../config.js';
import { writeTaskMcpConfig } from '../mcp-config.js';
import { spawnProcess, killTree, appendPathOnce } from './process.js';

function buildArgs(task, config) {
  const args = [
    '-p', task.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ];
  if (task.model) args.push('--model', task.model);
  if (task.resume) args.push('--resume', task.session_id);
  else args.push('--session-id', task.session_id);
  // A short-lived token bound to this task, written outside the repository and
  // deleted when the task ends. The master token is never used here.
  const mcpConfig = writeTaskMcpConfig(config, {
    agent: 'claude',
    taskId: task.id,
    token: task.auth_token,
    chatId: task.chat_id || null
  });
  args.push('--mcp-config', mcpConfig);
  return args;
}

function truncate(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

// P1-5: turn Claude Code's stream-json `result` event into one model_calls
// row. modelUsage is preferred over the top-level usage block because it
// carries the per-model totals even when usage fields report zero. No value is
// invented: a missing field stays null and usage_source says where it came
// from.
export function buildMetrics(event, text) {
  const entries = Object.entries(event.modelUsage ?? {});
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let model = typeof event.model === 'string' ? event.model : null;
  let provider = null;
  const byModel = {};
  if (entries.length > 0) {
    model = entries[0][0];
    provider = entries[0][1]?.provider ?? null;
    for (const [name, usage] of entries) {
      const values = {
        input: Number(usage?.inputTokens ?? 0),
        output: Number(usage?.outputTokens ?? 0),
        cache_read: Number(usage?.cacheReadInputTokens ?? 0),
        cache_creation: Number(usage?.cacheCreationInputTokens ?? 0)
      };
      byModel[name] = values;
      input += values.input;
      output += values.output;
      cacheRead += values.cache_read;
      cacheCreation += values.cache_creation;
    }
  } else if (event.usage) {
    input = Number(event.usage.input_tokens ?? 0);
    output = Number(event.usage.output_tokens ?? 0);
    cacheRead = Number(event.usage.cache_read_input_tokens ?? 0);
    cacheCreation = Number(event.usage.cache_creation_input_tokens ?? 0);
  }
  const usageAvailable = entries.length > 0 || Boolean(event.usage);
  const tokenUsage = usageAvailable
    ? {
      input, output, cache_read: cacheRead, cache_creation: cacheCreation,
      ...(entries.length > 1 ? { by_model: byModel } : {})
    }
    : null;
  const apiMs = Number(event.duration_api_ms);
  return {
    provider,
    model,
    // The CLI has no provider request id in stream-json; its result uuid is
    // the only stable identifier for this request, so record that.
    provider_request_id: typeof event.request_id === 'string' && event.request_id
      ? event.request_id
      : (typeof event.uuid === 'string' ? event.uuid : null),
    token_usage: tokenUsage,
    token_usage_json: tokenUsage ? JSON.stringify(tokenUsage) : null,
    cost_usd: Number.isFinite(Number(event.total_cost_usd)) ? Number(event.total_cost_usd) : null,
    latency_ms: Number.isFinite(apiMs) ? apiMs : (Number.isFinite(Number(event.duration_ms)) ? Number(event.duration_ms) : null),
    duration_api_ms: Number.isFinite(apiMs) ? apiMs : null,
    ttft_ms: Number.isFinite(Number(event.ttft_ms ?? event.ttft_stream_ms))
      ? Number(event.ttft_ms ?? event.ttft_stream_ms)
      : null,
    usage_source: usageAvailable ? 'stream' : 'unknown',
    session_id: typeof event.session_id === 'string' ? event.session_id : null,
    response_summary: truncate(text)
  };
}

export const claudeExecutor = {
  name: 'claude',
  resumeSupported: true,
  start(task, ctx) {
    // Resolve at launch time, never from a module-load snapshot: an npm upgrade
    // can rename the executable out from under a long-running engine.
    const resolved = resolveClaudeCommand();
    ctx.log('system', describeResolution(resolved));
    if (!resolved.found) {
      throw new Error('claude executable not found; set WORKBENCH_CLAUDE_ENTRY or add claude to PATH');
    }
    const args = buildArgs(task, ctx.config);
    const env = { ...ctx.config.claudeEnv };
    // 2026-11-18 user decision: full permissions for all agents (Claude
    // already runs --dangerously-skip-permissions). Same PATH note as dsh.
    env.PATH = appendPathOnce(env.PATH || process.env.PATH, 'C:\\Claude\\pwsh7');
    if (ctx.config.agentApprovalGate) {
      // request_approval blocks until the user answers. Raise the MCP tool
      // timeout above the approval timeout so the client does not abort first.
      // This env name is Claude Code's; if a version ignores it the tool call
      // simply follows the client default.
      env.MCP_TOOL_TIMEOUT = String(Math.max(120000, ctx.config.approvalTimeoutMs + 60000));
    }
    const child = spawnProcess({
      command: resolved.command,
      args,
      env,
      cwd: task.cwd || ctx.config.root,
      onLine: (stream, line) => {
        ctx.log(stream, line);
        if (stream !== 'stdout') return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
          ctx.setSessionId(event.session_id);
        }
        if (event?.type === 'result') {
          const text = typeof event.result === 'string' ? event.result : '';
          ctx.setResult({
            isError: Boolean(event.is_error),
            text,
            tokens: {
              input: Number(event.usage?.input_tokens ?? 0),
              output: Number(event.usage?.output_tokens ?? 0)
            },
            metrics: buildMetrics(event, text)
          });
        }
      },
      onExit: (info) => ctx.exit(info)
    });
    return {
      pid: child.pid,
      cancel: () => killTree(child.pid)
    };
  }
};