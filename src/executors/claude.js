import { ensureClaudeMcpConfig } from '../mcp-config.js';
import { spawnProcess, killTree } from './process.js';

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
  args.push('--mcp-config', ensureClaudeMcpConfig(config));
  return args;
}

export const claudeExecutor = {
  name: 'claude',
  resumeSupported: true,
  start(task, ctx) {
    const args = buildArgs(task, ctx.config);
    const command = ctx.config.claudeEntry || ctx.config.claudeBin;
    const child = spawnProcess({
      command,
      args,
      env: ctx.config.claudeEnv,
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
          ctx.setResult({
            isError: Boolean(event.is_error),
            text: typeof event.result === 'string' ? event.result : '',
            tokens: {
              input: Number(event.usage?.input_tokens ?? 0),
              output: Number(event.usage?.output_tokens ?? 0)
            }
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