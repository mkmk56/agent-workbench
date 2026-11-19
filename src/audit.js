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
// Secrets never reach the file: sensitive field names keep their key with a
// <redacted> value, and any value that still looks like a pairing code, an
// access token or a legacy hex credential is replaced with <redacted> before
// the line is written.
// ---------------------------------------------------------------------------

export const AUDIT_FILE = 'security-audit.log';

const MAX_VALUE = 300;
const REDACTED = '<redacted>';
const SENSITIVE_KEY = /(pairing_code|code_hash|token|secret|password|authorization|cookie)/i;
// Engine pairing codes are XXXX-XXXX over an unambiguous alphabet; access
// tokens are pachat_<base64url>; legacy credentials were 64-character hex
// strings. All three patterns are scrubbed wherever they appear, including
// inside an error message. The pairing pattern is case-insensitive so a
// lower-cased code pasted into an error field is still erased.
// The alphabet is A-Z minus I/O plus 2-9 (no 0/1). Excluding those keeps ISO
// dates like 2026-11-19 from being mistaken for a code while still matching a
// lower-cased code.
// Lookarounds keep the match from landing inside a UUID (c370-438f is a
// 4-4 pair of hex-looking segments) while still accepting a standalone code.
const PAIRING_CODE_VALUE = /(?<![A-Za-z0-9-])[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}(?![A-Za-z0-9-])/gi;
const ACCESS_TOKEN_VALUE = /\bpachat_[A-Za-z0-9_-]+/g;
const LEGACY_HEX_TOKEN_VALUE = /\b[0-9a-fA-F]{64}\b/g;

function sanitizeValue(value) {
  if (value === undefined || value === null) return null;
  let text = typeof value === 'string' ? value : String(value);
  if (text === '') return null;
  text = text
    .replace(ACCESS_TOKEN_VALUE, REDACTED)
    .replace(LEGACY_HEX_TOKEN_VALUE, REDACTED)
    .replace(PAIRING_CODE_VALUE, REDACTED);
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

// Append one line to an append-only file in the data directory. Used by the
// security audit trail and by data/wake.log, which follows the same
// append-only, never-read-back, redact-before-write rules.
export function appendAuditFile(dataDir, fileName, event, fields = {}, now = new Date()) {
  if (!dataDir || !event || !fileName) return null;
  const path = join(dataDir, fileName);
  try {
    appendFileSync(path, formatAuditLine(event, fields, now), 'utf8');
    return path;
  } catch {
    return null;
  }
}

// Append one audit line. Returns the path written, or null when the write was
// skipped/failed; callers treat auditing as best effort.
export function auditEvent(dataDir, event, fields = {}) {
  return appendAuditFile(dataDir, AUDIT_FILE, event, fields);
}