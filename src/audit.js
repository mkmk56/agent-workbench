import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Connection-layer audit trail (SECURITY_DESIGN.md §5)
//
// Pairing, reclaim, revocation and access denials are written to an
// append-only file next to the per-chat recall log
// (data/chat-<chat>.log). The file survives a restart and is never read back
// by the engine, so a failed audit write can never fail the request.
//
// Secrets never reach the file: sensitive field names are dropped, and any
// value that still looks like a pairing code or an access token is replaced
// with <redacted> before the line is written.
// ---------------------------------------------------------------------------

export const AUDIT_FILE = 'security-audit.log';

const MAX_VALUE = 300;
const REDACTED = '<redacted>';
const SENSITIVE_KEY = /(pairing_code|token|secret|password|authorization|cookie)/i;
// Engine pairing codes are XXXX-XXXX over an unambiguous alphabet; access
// tokens are pachat_<base64url>. Both patterns are scrubbed wherever they
// appear, including inside an error message.
const PAIRING_CODE_VALUE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
const ACCESS_TOKEN_VALUE = /\bpachat_[A-Za-z0-9_-]+/g;

function sanitizeValue(value) {
  if (value === undefined || value === null) return null;
  let text = typeof value === 'string' ? value : String(value);
  if (text === '') return null;
  text = text.replace(ACCESS_TOKEN_VALUE, REDACTED).replace(PAIRING_CODE_VALUE, REDACTED);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}…(${text.length})`;
  return text;
}

export function formatAuditLine(event, fields = {}, now = new Date()) {
  const parts = [`[${now.toISOString()}]`, '[audit]', `event=${sanitizeValue(event) ?? 'unknown'}`];
  for (const key of Object.keys(fields).sort()) {
    if (!/^[a-z0-9_]+$/i.test(key)) continue;
    if (SENSITIVE_KEY.test(key)) {
      parts.push(`${key}=${REDACTED}`);
      continue;
    }
    const value = sanitizeValue(fields[key]);
    if (value !== null) parts.push(`${key}=${value}`);
  }
  return `${parts.join(' ')}\n`;
}

// Append one audit line. Returns the path written, or null when the write was
// skipped/failed; callers treat auditing as best effort.
export function auditEvent(dataDir, event, fields = {}) {
  if (!dataDir || !event) return null;
  const path = join(dataDir, AUDIT_FILE);
  try {
    appendFileSync(path, formatAuditLine(event, fields), 'utf8');
    return path;
  } catch {
    return null;
  }
}