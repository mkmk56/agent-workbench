import { describeResolution, resolveDshCommand } from '../config.js';
import { spawnProcess, killTree } from './process.js';

const MAX_HISTORY_CHARS = 12000;

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
    let out = '';
    const child = spawnProcess({
      command: resolved.command,
      prefixArgs: resolved.prefixArgs,
      args: ['--profile', 'headless', prompt],
      cwd: task.cwd || ctx.config.root,
      onLine: (stream, line) => {
        ctx.log(stream, line);
        if (stream === 'stdout') out += `${line}\n`;
      },
      onExit: (info) => {
        const summary = out.trim();
        if (summary) ctx.setResult({ isError: info.code !== 0, text: summary, tokens: null });
        ctx.exit(info);
      }
    });
    return {
      pid: child.pid,
      cancel: () => killTree(child.pid)
    };
  }
};