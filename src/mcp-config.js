import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { credentialDir } from './credentials.js';
import { currentWindowsPrincipal, hardenPath } from './security.js';

// Each running task gets its own MCP config containing a signed token bound to
// that task. The file is written under the per-user credential directory, not
// data/ and not the repository, and is deleted when the task finishes. Other
// executors never see this path; the static data/<agent>-mcp.json files are
// removed at startup.
export function taskConfigDir(config, taskId) {
  const base = config.taskConfigDir || join(config.credentialDir || credentialDir(), 'task-configs');
  return join(base, String(taskId));
}

function writeRestrictedFile(path, doc) {
  const windowsPrincipal = process.platform === 'win32' ? currentWindowsPrincipal() : null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  hardenPath(dirname(path), { directory: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    hardenPath(tmp);
    renameSync(tmp, path);
    hardenPath(path);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  void windowsPrincipal;
  return path;
}

export function writeTaskMcpConfig(config, { agent, taskId, token, chatId = null } = {}) {
  if (agent !== 'claude' && agent !== 'dsh') throw new Error(`unknown agent: ${agent}`);
  if (!taskId) throw new Error('taskId is required for a task MCP config');
  if (!token) throw new Error(`no per-task token available for agent ${agent}`);
  const path = join(taskConfigDir(config, taskId), `${agent}.json`);
  return writeRestrictedFile(path, {
    mcpServers: {
      'agent-workbench': {
        type: 'http',
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${token}` },
        // The client may read this marker to know which task the credential
        // belongs to; it is not a secret.
        _workbench: { agent, task_id: taskId, chat_id: chatId || null, token_kind: 'agent-task' }
      }
    }
  });
}

export function cleanupTaskMcpConfig(config, taskId) {
  if (!taskId) return;
  try {
    rmSync(taskConfigDir(config, taskId), { recursive: true, force: true });
  } catch {
    // The token still expires; cleanup is best effort.
  }
}

// One-time cleanup for the previous static config files. They held static
// HMAC tokens derived from the master and were readable by every executor.
export function removeLegacyAgentMcpConfigs(config) {
  const removed = [];
  for (const path of [config.claudeMcpConfigPath, config.dshMcpConfigPath]) {
    if (!path) continue;
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch {
      // Ignore: the path may not exist or may be locked.
    }
  }
  return removed;
}

// Backwards-compatible helper for older callers. New code must use
// writeTaskMcpConfig so the token is task-bound and expiring.
export function ensureAgentMcpConfig(config, agent = 'claude') {
  if (agent !== 'claude' && agent !== 'dsh') throw new Error(`unknown agent: ${agent}`);
  const token = config.agentTokens?.[agent];
  if (!token) throw new Error(`no scoped token configured for agent ${agent}`);
  const path = join(config.credentialDir || credentialDir(), 'legacy', `${agent}.json`);
  return writeRestrictedFile(path, {
    mcpServers: {
      'agent-workbench': {
        type: 'http',
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  });
}

export function ensureClaudeMcpConfig(config) {
  return ensureAgentMcpConfig(config, 'claude');
}