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
