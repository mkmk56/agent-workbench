import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

// Claude Code is started with --mcp-config pointing at this file so each task
// can call the local workbench MCP server directly. The file lives under the
// gitignored data directory and contains the bearer token.
export function ensureClaudeMcpConfig(config) {
  const path = config.claudeMcpConfigPath;
  const doc = {
    mcpServers: {
      'agent-workbench': {
        type: 'http',
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${config.token}` }
      }
    }
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  return path;
}