import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

// Windows built-in principals used by the token file ACL. Their SAM account
// names are not localized, so these values resolve on every Windows locale.
const WINDOWS_SYSTEM = 'SYSTEM';
const WINDOWS_ADMINS = 'Administrators';

function currentWindowsPrincipal() {
  if (process.env.USERDOMAIN && process.env.USERNAME) {
    return `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  }
  try {
    return execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    throw new Error('cannot determine the current Windows user; refusing to write the MCP token file');
  }
}

// Node's `mode` option is not honoured on Windows: the file keeps the ACL
// inherited from its directory, which usually lets BUILTIN\Users read it. This
// file holds the workbench bearer token, so lock it down explicitly: remove
// inherited permissions and grant only the current user, SYSTEM and the local
// Administrators group.
function lockDownWindowsFile(path, principal) {
  execFileSync('icacls', [
    path,
    '/inheritance:r',
    '/grant:r', `${principal}:F`,
    `${WINDOWS_SYSTEM}:F`,
    `${WINDOWS_ADMINS}:F`
  ], { stdio: 'ignore', windowsHide: true });
}

function restrictTokenFile(path, windowsPrincipal) {
  if (process.platform === 'win32') {
    lockDownWindowsFile(path, windowsPrincipal);
  } else {
    chmodSync(path, 0o600);
  }
}

// Executors are started with --mcp-config pointing at a per-agent file so each
// one calls the local workbench with its own scoped token. The master token is
// never written into an executor config.
export function ensureAgentMcpConfig(config, agent = 'claude') {
  if (agent !== 'claude' && agent !== 'dsh') throw new Error(`unknown agent: ${agent}`);
  const path = agent === 'dsh' ? config.dshMcpConfigPath : config.claudeMcpConfigPath;
  const token = config.agentTokens?.[agent];
  if (!token) throw new Error(`no scoped token configured for agent ${agent}`);
  const doc = {
    mcpServers: {
      'agent-workbench': {
        type: 'http',
        url: config.mcpUrl,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  };
  // Resolve the principal before writing anything: if it cannot be resolved,
  // fail before the token reaches disk.
  const windowsPrincipal = process.platform === 'win32' ? currentWindowsPrincipal() : null;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Restrict the temporary file first so the token is never on disk with
    // inherited permissions, then rename atomically into place. Moved files
    // keep their ACL, and the second pass guarantees the final path is locked
    // even if the platform replaced the security descriptor on rename.
    restrictTokenFile(tmp, windowsPrincipal);
    renameSync(tmp, path);
    restrictTokenFile(path, windowsPrincipal);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return path;
}

// Backwards-compatible name: Claude is still the only executor that reads an
// MCP config file today, but the token is now Claude's scoped token.
export function ensureClaudeMcpConfig(config) {
  return ensureAgentMcpConfig(config, 'claude');
}
