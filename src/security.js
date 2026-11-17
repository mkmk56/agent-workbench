import { chmodSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sep } from 'node:path';

// Windows built-in principals used by the token file ACL. Their SAM account
// names are not localized, so these values resolve on every Windows locale.
const WINDOWS_SYSTEM = 'SYSTEM';
const WINDOWS_ADMINS = 'Administrators';

export function currentWindowsPrincipal() {
  if (process.env.USERDOMAIN && process.env.USERNAME) {
    return `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  }
  try {
    return execFileSync('whoami', { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    throw new Error('cannot determine the current Windows user; refusing to restrict a secret path');
  }
}

// Node's `mode` option is not honoured on Windows: a file keeps the ACL
// inherited from its directory, which usually lets BUILTIN\Users read it.
// Credentials (engine env, per-task MCP configs) and chat attachments are
// locked down explicitly: remove inherited permissions and grant only the
// current user, SYSTEM and the local Administrators group.
//
// ACLs only isolate other OS users. Executors run as the same Windows user as
// the engine, so this is defence in depth, not process isolation.
export function hardenPath(path, { recursive = false, directory = false } = {}) {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, directory ? 0o700 : 0o600);
    } catch {
      // Best effort: a missing path or unsupported filesystem is not fatal.
    }
    return { ok: true, platform: 'posix' };
  }

  let principal;
  try {
    principal = currentWindowsPrincipal();
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const grant = (target, isDirectory) => {
    // Explicit access for this object, then (for directories) an inheritable
    // ACE for new children. `icacls /T` with inheritance flags can leave
    // children without an explicit ACE, so recursive callers walk the tree
    // themselves.
    execFileSync('icacls', [
      target,
      '/inheritance:r',
      '/grant:r',
      `${principal}:F`,
      `${WINDOWS_SYSTEM}:F`,
      `${WINDOWS_ADMINS}:F`
    ], { stdio: 'ignore', windowsHide: true });
    if (isDirectory) {
      execFileSync('icacls', [
        target,
        '/grant:r',
        `${principal}:(OI)(CI)F`,
        `${WINDOWS_SYSTEM}:(OI)(CI)F`,
        `${WINDOWS_ADMINS}:(OI)(CI)F`
      ], { stdio: 'ignore', windowsHide: true });
    }
  };

  const walk = (target, isDirectory) => {
    grant(target, isDirectory);
    if (!isDirectory) return;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      walk(`${target}${target.endsWith('\\') || target.endsWith('/') ? '' : sep}${entry.name}`,
        entry.isDirectory());
    }
  };

  try {
    walk(path, directory);
    return { ok: true, platform: 'win32', principal };
  } catch (error) {
    return { ok: false, error: error.code || error.message };
  }
}