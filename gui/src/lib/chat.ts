import type {
  AgentProfileCard,
  ChatFile,
  ChatFileKind,
  ChatFileQuery,
  ChatFileReadResult,
  ChatInboxEntry,
  ChatInboxIdentity,
  ChatInboxPayload,
  ChatMember,
  ChatMessage,
  ChatMessageKind,
  ChatMessageQuery,
  ChatMention,
  ChatParticipant,
  ChatParticipantId,
  ChatSettings,
  ChatSummary,
  ChatUploadDraft,
  ChatUploadProgress,
  ChatVisibility,
  EngineResult,
  PairingCodeResult,
  SendChatMessageInput,
} from '../types';

/**
 * Chat client + normalization for the group-chat upgrade.
 *
 * Contract (see docs/upgrade-frontend-phase4.md):
 *  - IPC names and camelCase arguments are frozen here; snake_case stays on the
 *    engine side and is normalized by the functions below.
 *  - Messages carry `seq` (incremental cursor), structured `files` (file_id
 *    handles, never host paths), `mentions`, `reply_to` and `client_msg_id`.
 *  - Nothing here invents messages, agents or statuses: when the bridge or the
 *    engine is unavailable the caller gets a real error.
 */

export type {
  AgentProfileCard,
  ChatFile,
  ChatFileKind,
  ChatFileQuery,
  ChatFileReadResult,
  ChatInboxEntry,
  ChatInboxIdentity,
  ChatInboxPayload,
  ChatMember,
  ChatMessage,
  ChatMessageKind,
  ChatMessageQuery,
  ChatMention,
  ChatParticipant,
  ChatParticipantId,
  ChatSettings,
  ChatStatusPayload,
  ChatSummary,
  ChatUploadDraft,
  ChatUploadProgress,
  ChatUploadResult,
  SendChatMessageInput,
} from '../types';

const NO_MAIN = '主进程未连接（浏览器预览）。';
const NO_CHAT_BRIDGE = '聊天接口尚未接通（IPC 桥未就绪）。';
/** Profile Card limit, mirrored from docs/rea/DATABASE_DESIGN.md (D1). */
export const PROFILE_MAX_LENGTH = 300;

export type ChatSender = ChatParticipantId | 'unknown';

export interface ChatAgentStatuses {
  claude?: string;
  dsh?: string;
  muse?: string;
}

export interface ChatAgentState {
  state: AgentState;
  label: string;
  task_id: string | null;
  updated_at: string | null;
}

export interface ChatStatus {
  chat_id: string;
  needs_muse: boolean;
  muse: ChatAgentState;
  claude: ChatAgentState;
  dsh: ChatAgentState;
  participants: ChatParticipant[];
}

export type AgentState =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'stale'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface SendChatResult {
  message_id: string;
  chat_id: string;
  created_at: string;
  seq: number | null;
}

interface ChatBridge {
  listChats?: (options?: {
    includeArchived?: boolean;
  }) => Promise<EngineResult<unknown>>;
  createChat?: (
    name?: string,
    options?: { visibility?: ChatVisibility; category?: string | null },
  ) => Promise<EngineResult<unknown>>;
  renameChat?: (chatId: string, name: string) => Promise<EngineResult<unknown>>;
  archiveChat?: (chatId: string) => Promise<EngineResult<unknown>>;
  unarchiveChat?: (chatId: string) => Promise<EngineResult<unknown>>;
  sendChatMessage?: (input: SendChatMessageInput) => Promise<EngineResult<unknown>>;
  chatStatus?: (chatId: string) => Promise<EngineResult<unknown>>;
  chatParticipants?: (
    chatId: string,
  ) => Promise<EngineResult<{ participants?: unknown[] } | unknown>>;
  chatMarkRead?: (input: {
    chatId: string;
    participantId?: string;
    upToSeq?: number;
    messageId?: string;
  }) => Promise<EngineResult<unknown>>;
  chatInbox?: (input?: {
    agentId?: string;
    chatId?: string;
  }) => Promise<EngineResult<unknown>>;
  agentProfile?: (input?: {
    agentId?: string;
    profile?: string;
  }) => Promise<EngineResult<unknown>>;
  listChatMessages?: (input: ChatMessageQuery) => Promise<EngineResult<unknown>>;
  readChatFile?: (input: ChatFileQuery) => Promise<EngineResult<unknown>>;
  chatMembers?: (chatId: string) => Promise<EngineResult<unknown>>;
  chatAddMember?: (input: {
    chatId: string;
    agentId: string;
  }) => Promise<EngineResult<unknown>>;
  chatRemoveMember?: (input: {
    chatId: string;
    agentId: string;
  }) => Promise<EngineResult<unknown>>;
}

function bridge(): ChatBridge | null {
  if (!window.workbench) {
    return null;
  }
  return window.workbench as unknown as ChatBridge;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function normalizeSender(value: unknown): ChatSender {
  if (value === 'user' || value === 'muse' || value === 'claude' || value === 'dsh') {
    return value;
  }
  return 'unknown';
}

function toParticipantId(value: unknown): ChatParticipantId | null {
  if (value === 'user' || value === 'muse' || value === 'claude' || value === 'dsh') {
    return value;
  }
  return null;
}

function unwrapList(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return [];
}

export function normalizeChat(raw: unknown): ChatSummary | null {
  const record = asRecord(raw);
  const chatId = readString(record, 'chat_id', 'chatId', 'id');
  if (chatId == null) {
    return null;
  }
  const agents = asRecord(record.agents);
  const agentsStatuses: ChatAgentStatuses = {};
  for (const id of ['muse', 'claude', 'dsh'] as const) {
    const value = agents[id];
    if (typeof value === 'string') {
      agentsStatuses[id] = value;
    } else if (value != null && typeof value === 'object') {
      const status = readString(asRecord(value), 'status', 'state');
      if (status != null) {
        agentsStatuses[id] = status;
      }
    }
  }
  const participants = Array.isArray(record.participants)
    ? record.participants
        .map(normalizeParticipant)
        .filter((item): item is ChatParticipant => item != null)
    : [];
  const status = readString(record, 'status');
  const visibility = readString(record, 'visibility');
  return {
    chat_id: chatId,
    name: readString(record, 'name') ?? '未命名群聊',
    status: status === 'archived' ? 'archived' : 'active',
    // REA Phase 5: pre-v8 engines omit visibility; `link` is the historical
    // value the API always forced, so an older engine still renders honestly.
    visibility:
      visibility === 'private' || visibility === 'public' || visibility === 'link'
        ? (visibility as ChatVisibility)
        : 'link',
    category: readString(record, 'category'),
    created_at: readString(record, 'created_at', 'createdAt'),
    last_message_at: readString(record, 'last_message_at', 'lastMessageAt'),
    last_message_preview: readString(record, 'last_message_preview', 'lastMessagePreview'),
    needs_muse: record.needs_muse === true || record.needsMuse === true,
    unread: readNumber(record, 'unread', 'unread_count') ?? 0,
    participants,
    agents: agentsStatuses as unknown as ChatSummary['agents'],
    settings: normalizeChatSettings(record.settings),
  };
}

export function normalizeParticipant(raw: unknown): ChatParticipant | null {
  const record = asRecord(raw);
  const id = readString(record, 'id', 'participant_id', 'agent', 'role_id');
  if (id !== 'user' && id !== 'muse' && id !== 'claude' && id !== 'dsh') {
    return null;
  }
  const state = readString(record, 'state', 'engine_state');
  const status = readString(record, 'status', 'presence') ?? state ?? 'idle';
  return {
    id,
    name: readString(record, 'name', 'label') ?? defaultParticipantName(id),
    role: id === 'user' ? 'user' : 'agent',
    status,
    state,
    task_id: readString(record, 'task_id', 'taskId'),
    updated_at: readString(record, 'updated_at', 'updatedAt'),
    unread: readNumber(record, 'unread', 'unread_count') ?? undefined,
  };
}

const KIND_VALUES = new Set<ChatFileKind>([
  'image',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'zip',
  'code',
  'text',
  'other',
]);

/** Legacy messages stored plain path strings; upgrade them to file objects. */
export function normalizeChatFile(raw: unknown): ChatFile | null {
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      return null;
    }
    const name = raw.split(/[\\/]/).pop() ?? raw;
    return {
      file_id: raw,
      name,
      size: 0,
      mime: 'application/octet-stream',
      kind: guessKindFromName(name),
      sha256: null,
      status: 'legacy-path',
      preview_text: null,
      preview_truncated: false,
      uploader: null,
      created_at: '',
    };
  }
  const record = asRecord(raw);
  const nested = asRecord(record.file);
  const source = Object.keys(nested).length > 0 ? nested : record;
  const fileId = readString(source, 'file_id', 'fileId', 'id');
  if (fileId == null) {
    return null;
  }
  const name = readString(source, 'name', 'filename', 'file_name') ?? '未命名文件';
  const mime = readString(source, 'mime', 'mime_type', 'content_type') ?? 'application/octet-stream';
  const declaredKind = readString(source, 'kind');
  const kind =
    declaredKind != null && KIND_VALUES.has(declaredKind as ChatFileKind)
      ? (declaredKind as ChatFileKind)
      : guessKindFromName(name, mime);
  return {
    file_id: fileId,
    chat_id: readString(source, 'chat_id', 'chatId'),
    name,
    size: readNumber(source, 'size', 'bytes', 'length') ?? 0,
    mime,
    kind,
    sha256: readString(source, 'sha256', 'hash'),
    status: readString(source, 'status', 'parse_status') ?? 'pending',
    preview_text: readString(source, 'preview_text', 'preview', 'text'),
    preview_truncated: readBoolean(source, 'preview_truncated', 'truncated') ?? false,
    uploader: toParticipantId(source.uploader ?? source.uploader_id ?? source.from),
    created_at: readString(source, 'created_at', 'createdAt') ?? '',
  };
}

export function normalizeMessage(raw: unknown): ChatMessage | null {
  const record = asRecord(raw);
  const messageId = readString(record, 'message_id', 'messageId', 'id');
  if (messageId == null) {
    return null;
  }
  const files = Array.isArray(record.files)
    ? record.files
        .map(normalizeChatFile)
        .filter((file): file is ChatFile => file != null)
    : readStringArray(record.files).map((item) => normalizeChatFile(item)).filter(isFile);
  const mentions = Array.isArray(record.mentions)
    ? record.mentions
        .map((item) => normalizeSender(item))
        .filter((item): item is ChatParticipantId => item !== 'unknown')
    : [];
  return {
    message_id: messageId,
    chat_id: readString(record, 'chat_id', 'chatId'),
    seq: readNumber(record, 'seq', 'sequence', 'message_seq') ?? 0,
    from: normalizeSender(record.from),
    to: normalizeSender(record.to),
    summary: typeof record.summary === 'string' ? record.summary : '',
    files,
    mentions,
    question: readString(record, 'question'),
    reply_to: readString(record, 'reply_to', 'replyTo'),
    client_msg_id: readString(record, 'client_msg_id', 'clientMsgId'),
    status: readString(record, 'status') ?? '',
    created_at: readString(record, 'created_at', 'createdAt') ?? '',
    task_id: readString(record, 'task_id', 'taskId'),
    kind: normalizeMessageKind(record.kind),
    recalled: record.recalled === true,
  };
}

/**
 * REA Phase 4: `kind` is `user` | `system`. Pre-Phase-4 engines omit it (and
 * some databases still hold the column default), so anything unknown is an
 * ordinary user message — a missing field must never hide a real message.
 */
export function normalizeMessageKind(raw: unknown): ChatMessageKind {
  return raw === 'system' ? 'system' : 'user';
}

/** `chats.settings` accepts an object, a JSON string, or nothing. */
export function normalizeChatSettings(raw: unknown): ChatSettings {
  const empty: ChatSettings = { description: '', announcement: '' };
  if (raw == null) {
    return empty;
  }
  let record: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed == null || typeof parsed !== 'object') {
        return empty;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      // A malformed value is treated as "no settings" rather than an error.
      return empty;
    }
  } else if (typeof raw === 'object') {
    record = raw as Record<string, unknown>;
  } else {
    return empty;
  }
  return {
    description: readString(record, 'description') ?? '',
    announcement: readString(record, 'announcement') ?? '',
  };
}

const MEMBER_ROLES = new Set(['owner', 'admin', 'member']);

/** One `chat_members` row. Unknown agents keep their raw id as display name. */
export function normalizeMember(raw: unknown): ChatMember | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId', 'id');
  if (agentId == null) {
    return null;
  }
  const role = readString(record, 'role') ?? 'member';
  const joinedAt = record.joined_at ?? record.joinedAt ?? null;
  return {
    agent_id: agentId,
    participant_id: readString(record, 'participant_id', 'participantId'),
    role: MEMBER_ROLES.has(role) ? role : 'member',
    owner: readString(record, 'owner'),
    platform: readString(record, 'platform'),
    display_name:
      readString(record, 'display_name', 'displayName', 'name') ??
      (agentId === 'agent_user' ? '用户' : agentId),
    color: readString(record, 'color'),
    status: readString(record, 'status') ?? 'active',
    joined_at:
      typeof joinedAt === 'number' || typeof joinedAt === 'string' ? joinedAt : null,
  };
}

function isFile(file: ChatFile | null): file is ChatFile {
  return file != null;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']);
const TEXT_EXT = new Set(['txt', 'log', 'csv', 'tsv', 'md', 'markdown', 'rst']);
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'jsonc', 'css', 'scss', 'less', 'html', 'htm',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sql', 'sh', 'bash', 'zsh', 'ps1',
  'bat', 'cmd', 'lua', 'pl', 'r', 'dart', 'vue', 'svelte', 'diff', 'patch',
]);

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

export function guessKindFromName(name: string, mime?: string | null): ChatFileKind {
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext) || (mime != null && mime.startsWith('image/'))) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'docx' || ext === 'doc' || ext === 'rtf' || ext === 'odt') {
    return 'docx';
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
    return 'xlsx';
  }
  if (ext === 'pptx' || ext === 'ppt' || ext === 'odp') {
    return 'pptx';
  }
  if (['zip', 'gz', 'tgz', '7z', 'rar', 'tar'].includes(ext)) {
    return 'zip';
  }
  if (CODE_EXT.has(ext)) {
    return 'code';
  }
  if (TEXT_EXT.has(ext) || (mime != null && mime.startsWith('text/'))) {
    return 'text';
  }
  return 'other';
}

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  idle: '待命',
  queued: '排队',
  starting: '启动中',
  working: '正在执行',
  waiting: '等待中',
  blocked: '遇到阻塞',
  stale: '静默',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

export function normalizeAgentState(raw: string | null | undefined): AgentState {
  if (raw == null || raw.trim().length === 0) {
    return 'idle';
  }
  switch (raw.trim().toLowerCase()) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'starting':
      return 'starting';
    case 'working':
    case 'running':
      return 'working';
    case 'waiting':
    case 'waiting_user':
      return 'waiting';
    case 'blocked':
      return 'blocked';
    case 'stale':
      return 'stale';
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'idle':
    case 'ready':
    case 'needs_reply':
      return 'idle';
    default:
      return 'unknown';
  }
}

function readAgentState(raw: unknown): ChatAgentState {
  if (typeof raw === 'string') {
    const state = normalizeAgentState(raw);
    return { state, label: AGENT_STATE_LABELS[state], task_id: null, updated_at: null };
  }
  const record = asRecord(raw);
  const rawStatus = readString(record, 'status', 'state');
  const state = normalizeAgentState(rawStatus);
  return {
    state,
    label:
      rawStatus === 'needs_reply' ? '等 Muse 回复' : AGENT_STATE_LABELS[state],
    task_id: readString(record, 'task_id', 'taskId'),
    updated_at: readString(record, 'updated_at', 'updatedAt'),
  };
}

export function normalizeChatStatus(raw: unknown): ChatStatus | null {
  const record = asRecord(raw);
  const chatId = readString(record, 'chat_id', 'chatId', 'id');
  if (chatId == null) {
    return null;
  }
  const agents = asRecord(record.agents);
  const needsMuse = record.needs_muse === true || record.needsMuse === true;
  const muse = readAgentState(agents.muse);
  return {
    chat_id: chatId,
    needs_muse: needsMuse,
    muse:
      needsMuse && muse.label === AGENT_STATE_LABELS.idle
        ? { ...muse, state: 'waiting', label: '等 Muse 回复' }
        : muse,
    claude: readAgentState(agents.claude),
    dsh: readAgentState(agents.dsh),
    participants: Array.isArray(record.participants)
      ? record.participants
          .map(normalizeParticipant)
          .filter((item): item is ChatParticipant => item != null)
      : [],
  };
}

export function defaultParticipantName(id: ChatParticipantId): string {
  switch (id) {
    case 'user':
      return '你';
    case 'muse':
      return 'Muse';
    case 'claude':
      return 'Claude';
    case 'dsh':
      return 'dsh';
  }
}

function failureMessage(error: string | null | undefined, fallback: string): string {
  return error != null && error.trim().length > 0 ? error : fallback;
}

/* ------------------------------------------------------------------ *
 * @mentions
 * ------------------------------------------------------------------ */

const MENTION_ALIASES: Record<string, ChatParticipantId> = {
  muse: 'muse',
  claude: 'claude',
  dsh: 'dsh',
  user: 'user',
  你: 'user',
};

/** Candidate list for Muse's @picker; `id` is what the wire contract carries. */
export const MENTION_CANDIDATES: Array<{ id: ChatParticipantId; label: string }> = [
  { id: 'muse', label: 'Muse' },
  { id: 'claude', label: 'Claude' },
  { id: 'dsh', label: 'dsh' },
  { id: 'user', label: '你' },
];

const MENTION_PATTERN = /@(muse|claude|dsh|user|你)(?![A-Za-z0-9_])/gi;

/**
 * Parse `@muse` / `@claude` / `@dsh` / `@你` out of the draft.
 * Returns positions so a future renderer can highlight them without re-parsing.
 */
export function parseMentions(text: string): ChatMention[] {
  const mentions: ChatMention[] = [];
  if (text.length === 0) {
    return mentions;
  }
  MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(text)) !== null) {
    const raw = match[1].toLowerCase();
    const id = MENTION_ALIASES[raw] ?? MENTION_ALIASES[match[1]];
    if (id == null) {
      continue;
    }
    mentions.push({
      id,
      label: match[0],
      offset: match.index,
      length: match[0].length,
    });
  }
  return mentions;
}

/** Deduped participant ids in first-appearance order; this is the send payload. */
export function mentionTargets(text: string, extra: ChatParticipantId[] = []): ChatParticipantId[] {
  const seen = new Set<ChatParticipantId>();
  const result: ChatParticipantId[] = [];
  for (const mention of [...parseMentions(text), ...extra.map((id) => ({ id }))]) {
    if (!seen.has(mention.id)) {
      seen.add(mention.id);
      result.push(mention.id);
    }
  }
  return result;
}

/**
 * Picker support: when the caret sits inside an unfinished `@token`, return the
 * token start and query so the @selector can filter `MENTION_CANDIDATES`.
 */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const upToCaret = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = upToCaret.lastIndexOf('@');
  if (at < 0) {
    return null;
  }
  const between = upToCaret.slice(at + 1);
  if (!/^[A-Za-z\u4e00-\u9fa5]{0,12}$/.test(between)) {
    return null;
  }
  // A mention must start the text or follow whitespace/punctuation.
  const before = at === 0 ? '' : upToCaret[at - 1];
  if (before.length > 0 && !/[\s，。,.!?！？:：、；;（(【[]/.test(before)) {
    return null;
  }
  return { query: between, start: at };
}

/**
 * Replace the in-progress `@token` with the chosen candidate. The composer keeps
 * ownership of the textarea; this only returns the new text and caret.
 */
export function applyMention(
  text: string,
  caret: number,
  candidate: { id: ChatParticipantId; label: string },
): { text: string; caret: number; mentions: ChatMention[] } {
  const token = mentionQueryAt(text, caret);
  const start = token?.start ?? caret;
  const inserted = `@${candidate.label} `;
  const next = `${text.slice(0, start)}${inserted}${text.slice(caret)}`;
  const nextCaret = start + inserted.length;
  return { text: next, caret: nextCaret, mentions: parseMentions(next) };
}

/* ------------------------------------------------------------------ *
 * Client calls
 * ------------------------------------------------------------------ */

export async function listChatsOnce(
  includeArchived = false,
): Promise<EngineResult<ChatSummary[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.listChats) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.listChats(includeArchived ? { includeArchived: true } : undefined);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取群聊列表失败。') };
    }
    const chats = unwrapList(result.data, ['chats'])
      .map(normalizeChat)
      .filter((chat): chat is ChatSummary => chat != null);
    return { ok: true, data: chats };
  } catch {
    return { ok: false, error: '读取群聊列表失败（主进程调用异常）。' };
  }
}

export async function createChat(
  name?: string,
  options?: { visibility?: ChatVisibility; category?: string | null },
): Promise<EngineResult<ChatSummary>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.createChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const trimmed = name?.trim();
    const result = await api.createChat(
      trimmed != null && trimmed.length > 0 ? trimmed : undefined,
      // REA Phase 5 §4.4: the create form may pick visibility/category; the
      // engine applies its own defaults (private / uncategorized) when absent.
      options?.visibility == null && options?.category === undefined ? undefined : options,
    );
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '创建群聊失败。') };
    }
    const chat = normalizeChat(result.data);
    if (chat == null) {
      return { ok: false, error: '引擎未返回群聊 ID，创建结果无法确认。' };
    }
    return { ok: true, data: chat };
  } catch {
    return { ok: false, error: '创建群聊失败（主进程调用异常）。' };
  }
}

export async function renameChat(chatId: string, name: string): Promise<EngineResult<ChatSummary>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.renameChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.renameChat(chatId, name);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '重命名群聊失败。') };
    }
    const chat = normalizeChat(result.data);
    return chat != null
      ? { ok: true, data: chat }
      : { ok: true, data: { ...emptyChat(chatId), name } };
  } catch {
    return { ok: false, error: '重命名群聊失败（主进程调用异常）。' };
  }
}

export async function archiveChat(chatId: string): Promise<EngineResult<ChatSummary>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.archiveChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.archiveChat(chatId);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '归档群聊失败。') };
    }
    const chat = normalizeChat(result.data);
    return chat != null ? { ok: true, data: chat } : { ok: false, error: '引擎未返回群聊，归档结果无法确认。' };
  } catch {
    return { ok: false, error: '归档群聊失败（主进程调用异常）。' };
  }
}

export async function unarchiveChat(chatId: string): Promise<EngineResult<ChatSummary>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.unarchiveChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.unarchiveChat(chatId);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '恢复群聊失败。') };
    }
    const chat = normalizeChat(result.data);
    return chat != null ? { ok: true, data: chat } : { ok: false, error: '引擎未返回群聊，恢复结果无法确认。' };
  } catch {
    return { ok: false, error: '恢复群聊失败（主进程调用异常）。' };
  }
}

/**
 * Fetch messages for one chat. `afterSeq` is the incremental cursor; `before`
 * pages backwards. The bridge returns whatever the engine supports and this
 * wrapper normalizes it.
 */
export async function listChatMessages(
  query: ChatMessageQuery,
): Promise<EngineResult<{ messages: ChatMessage[]; hasMore: boolean; nextSeq: number | null }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.listChatMessages) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.listChatMessages(query);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取群聊消息失败。') };
    }
    const record = asRecord(result.data);
    const messages = unwrapList(result.data, ['messages'])
      .map(normalizeMessage)
      .filter((message): message is ChatMessage => message != null)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return {
      ok: true,
      data: {
        messages,
        hasMore: record.has_more === true,
        nextSeq: readNumber(record, 'next_seq', 'nextSeq'),
      },
    };
  } catch {
    return { ok: false, error: '读取群聊消息失败（主进程调用异常）。' };
  }
}

export async function chatStatusOnce(chatId: string): Promise<EngineResult<ChatStatus>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.chatStatus) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.chatStatus(chatId);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取 Agent 状态失败。') };
    }
    const status = normalizeChatStatus(result.data);
    return status != null
      ? { ok: true, data: status }
      : { ok: false, error: '引擎未返回有效的群聊状态。' };
  } catch {
    return { ok: false, error: '读取 Agent 状态失败（主进程调用异常）。' };
  }
}

export async function chatParticipantsOnce(
  chatId: string,
): Promise<EngineResult<ChatParticipant[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.chatParticipants) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.chatParticipants(chatId);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取参与者失败。') };
    }
    const participants = unwrapList(result.data, ['participants'])
      .map(normalizeParticipant)
      .filter((item): item is ChatParticipant => item != null);
    return { ok: true, data: participants };
  } catch {
    return { ok: false, error: '读取参与者失败（主进程调用异常）。' };
  }
}

export async function markChatRead(input: {
  chatId: string;
  participantId?: string;
  upToSeq?: number;
  messageId?: string;
}): Promise<EngineResult<{ lastReadSeq: number; unread: number }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.chatMarkRead) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.chatMarkRead(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '标记已读失败。') };
    }
    const record = asRecord(result.data);
    return {
      ok: true,
      data: {
        lastReadSeq: readNumber(record, 'last_read_seq', 'lastReadSeq') ?? 0,
        unread: readNumber(record, 'unread') ?? 0,
      },
    };
  } catch {
    return { ok: false, error: '标记已读失败（主进程调用异常）。' };
  }
}

/* ------------------------------------------------------------------ *
 * REA Phase 2: Inbox and Profile Card
 * ------------------------------------------------------------------ */

export function normalizeInboxEntry(raw: unknown): ChatInboxEntry | null {
  const record = asRecord(raw);
  const chatId = readString(record, 'chat_id', 'chatId');
  if (chatId == null) {
    return null;
  }
  return {
    chat_id: chatId,
    name: readString(record, 'name') ?? '未命名群聊',
    status: readString(record, 'status') ?? 'active',
    last_read_seq: readNumber(record, 'last_read_seq', 'lastReadSeq') ?? 0,
    unread: readNumber(record, 'unread') ?? 0,
    mentions_you: readNumber(record, 'mentions_you', 'mentionsYou') ?? 0,
    replies_to_you: readNumber(record, 'replies_to_you', 'repliesToYou') ?? 0,
    from_owner: readNumber(record, 'from_owner', 'fromOwner') ?? 0,
    recalled: readNumber(record, 'recalled') ?? 0,
    last_message_at: readString(record, 'last_message_at', 'lastMessageAt'),
  };
}

export function normalizeInbox(raw: unknown): ChatInboxPayload | null {
  const record = asRecord(raw);
  const you = asRecord(record.you);
  const agentId = readString(you, 'agent_id', 'agentId');
  if (agentId == null) {
    return null;
  }
  const identity: ChatInboxIdentity = {
    agent_id: agentId,
    participant_id: readString(you, 'participant_id', 'participantId'),
    owner: readString(you, 'owner'),
    platform: readString(you, 'platform'),
    display_name: readString(you, 'display_name', 'displayName') ?? agentId,
    human: you.human === true,
    status: readString(you, 'status') ?? 'active',
  };
  const chats = unwrapList(record, ['chats'])
    .map(normalizeInboxEntry)
    .filter((entry): entry is ChatInboxEntry => entry != null);
  return {
    you: identity,
    total_unread: readNumber(record, 'total_unread', 'totalUnread')
      ?? chats.reduce((sum, entry) => sum + entry.unread, 0),
    chats,
  };
}

export function normalizeAgentProfile(raw: unknown): AgentProfileCard | null {
  const record = asRecord(raw);
  const agentId = readString(record, 'agent_id', 'agentId', 'id');
  if (agentId == null) {
    return null;
  }
  return {
    agent_id: agentId,
    participant_id: toParticipantId(record.participant_id ?? record.participantId),
    owner: readString(record, 'owner'),
    platform: readString(record, 'platform'),
    display_name: readString(record, 'display_name', 'displayName') ?? agentId,
    profile: readString(record, 'profile'),
    color: readString(record, 'color'),
    status: readString(record, 'status') ?? 'active',
    created_at: readNumber(record, 'created_at', 'createdAt') ?? 0,
  };
}

/** Per-chat unread counters of one agent. Reading the inbox marks nothing read. */
export async function chatInboxOnce(
  agentId?: string,
): Promise<EngineResult<ChatInboxPayload>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.chatInbox) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.chatInbox(agentId == null ? {} : { agentId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取 Inbox 失败。') };
    }
    const inbox = normalizeInbox(result.data);
    return inbox != null
      ? { ok: true, data: inbox }
      : { ok: false, error: '引擎未返回有效的 Inbox 数据。' };
  } catch {
    return { ok: false, error: '读取 Inbox 失败（主进程调用异常）。' };
  }
}

/** Read one Profile Card. */
export async function agentProfileOnce(
  agentId: string,
): Promise<EngineResult<AgentProfileCard>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.agentProfile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await api.agentProfile({ agentId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取简介失败。') };
    }
    const card = normalizeAgentProfile(result.data);
    return card != null
      ? { ok: true, data: card }
      : { ok: false, error: '引擎未返回有效的简介数据。' };
  } catch {
    return { ok: false, error: '读取简介失败（主进程调用异常）。' };
  }
}

/** Update one Profile Card (engine enforces ≤300 chars and own-profile-only). */
export async function updateAgentProfile(
  agentId: string,
  profile: string,
): Promise<EngineResult<AgentProfileCard>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.agentProfile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  if (profile.length > PROFILE_MAX_LENGTH) {
    return { ok: false, error: `简介不能超过 ${PROFILE_MAX_LENGTH} 个字符。` };
  }
  try {
    const result = await api.agentProfile({ agentId, profile });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '保存简介失败。') };
    }
    const card = normalizeAgentProfile(result.data);
    return card != null
      ? { ok: true, data: card }
      : { ok: false, error: '引擎未返回有效的简介数据。' };
  } catch {
    return { ok: false, error: '保存简介失败（主进程调用异常）。' };
  }
}

/**
 * Send a message. `mentions` is parsed from the draft unless the caller passes
 * an explicit list (the @picker can do that later); files are file_id handles.
 */
export async function sendChatMessage(input: SendChatMessageInput): Promise<EngineResult<SendChatResult>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = bridge();
  if (!api?.sendChatMessage) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const mentions = input.mentions ?? mentionTargets(input.summary);
    const payload: SendChatMessageInput = {
      chatId: input.chatId,
      from: input.from ?? 'user',
      to: input.to ?? 'muse',
      summary: input.summary,
      files: input.files,
      mentions,
      replyTo: input.replyTo,
      clientMsgId: input.clientMsgId ?? newClientMessageId(),
      question: input.question,
      taskId: input.taskId,
    };
    const result = await api.sendChatMessage(payload);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '发送消息失败。') };
    }
    const record = asRecord(result.data);
    const messageId = readString(record, 'message_id', 'messageId');
    if (messageId == null) {
      return { ok: false, error: '引擎未返回消息 ID，发送结果无法确认。' };
    }
    return {
      ok: true,
      data: {
        message_id: messageId,
        chat_id: readString(record, 'chat_id', 'chatId') ?? input.chatId,
        created_at: readString(record, 'created_at', 'createdAt') ?? '',
        seq: readNumber(record, 'seq'),
      },
    };
  } catch {
    return { ok: false, error: '发送消息失败（主进程调用异常）。' };
  }
}

export function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Attachment helpers — the frozen API Muse's components call.
 * ------------------------------------------------------------------ */

/** Current chat id from the shell route (`#/chats/<id>`), if any. */
export function activeChatIdFromRoute(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const match = /^#\/chats\/([^/?#]+)/.exec(window.location.hash);
  return match != null ? decodeURIComponent(match[1]) : null;
}

/**
 * Upload dropped/pasted files to the open chat in <=1 MB chunks.
 *
 * `files` are the browser File objects (drop or paste). Each one is registered
 * as an opaque draft in the main process (the renderer never sees a host path)
 * and streamed through `upload_chat_file_init` / `_chunk` / `_complete`.
 *
 * `onProgress(index, progress)` reports 0..1 for the file at `index` in the
 * input array. `chatId` defaults to the chat in the current route; pass it
 * explicitly when uploading outside that route.
 */
export async function uploadChatFiles(
  files: File[],
  onProgress?: (index: number, progress: number) => void,
  chatId?: string,
): Promise<EngineResult<{ file_ids: string[] }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const api = window.workbench;
  if (!api.registerChatFiles || !api.uploadChatFiles) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: '没有选择任何文件。' };
  }
  const targetChatId = chatId ?? activeChatIdFromRoute();
  if (targetChatId == null || targetChatId.length === 0) {
    return { ok: false, error: '请先打开一个群聊，再上传附件。' };
  }

  let drafts: ChatUploadDraft[];
  try {
    const intake = await api.registerChatFiles(files, 'drop');
    if (!intake.ok) {
      return { ok: false, error: intake.error ?? '登记待上传文件失败。' };
    }
    drafts = intake.data.drafts;
  } catch {
    return { ok: false, error: '登记待上传文件失败（主进程调用异常）。' };
  }
  if (drafts.length === 0) {
    return { ok: false, error: '没有可上传的文件。' };
  }

  const uploadId = newClientMessageId();
  const indexByDraft = new Map<string, number>();
  drafts.forEach((draft, index) => indexByDraft.set(draft.draftId, index));
  const lastPercent = new Map<number, number>();
  const unsubscribe = api.onChatUploadProgress?.((progress: ChatUploadProgress) => {
    if (progress.uploadId !== uploadId || onProgress == null) {
      return;
    }
    const index = indexByDraft.get(progress.draftId);
    if (index == null) {
      return;
    }
    const value = progress.phase === 'done' ? 1 : Math.max(0, Math.min(1, progress.percent / 100));
    if (value >= (lastPercent.get(index) ?? 0)) {
      lastPercent.set(index, value);
      onProgress(index, value);
    }
  });

  try {
    const result = await api.uploadChatFiles({
      chatId: targetChatId,
      uploadId,
      draftIds: drafts.map((draft) => draft.draftId),
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? '上传附件失败。' };
    }
    const uploaded = result.data;
    if (uploaded.errors.length > 0) {
      return {
        ok: false,
        error: uploaded.errors.map((item) => `${item.name}: ${item.error}`).join('；'),
      };
    }
    const fileIds = uploaded.files.map((file) => file.file_id).filter((id) => id.length > 0);
    drafts.forEach((_draft, index) => onProgress?.(index, 1));
    return { ok: true, data: { file_ids: fileIds } };
  } catch {
    return { ok: false, error: '上传附件失败（主进程调用异常）。' };
  } finally {
    unsubscribe?.();
  }
}

/** Files uploaded to one chat, newest last, normalized for the renderer. */
export async function listChatFiles(
  chatId: string,
): Promise<EngineResult<{ files: ChatFile[] }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.listChatFiles) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.listChatFiles({ chatId });
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取附件列表失败。') };
    }
    const files = (Array.isArray(result.data.files) ? result.data.files : [])
      .map(normalizeChatFile)
      .filter((file): file is ChatFile => file != null);
    return { ok: true, data: { files } };
  } catch {
    return { ok: false, error: '读取附件列表失败（主进程调用异常）。' };
  }
}

/**
 * Read the parsed text of one attachment. `truncated` is true when the backend
 * capped the returned bytes (default cap 200 KB, raise it via `options`).
 */
export async function readChatFile(
  chatId: string,
  fileId: string,
  options?: { limit?: number; entry?: string },
): Promise<EngineResult<{ text: string; truncated: boolean }>>;
export async function readChatFile(
  query: ChatFileQuery,
): Promise<EngineResult<ChatFileReadResult>>;
export async function readChatFile(
  chatIdOrQuery: string | ChatFileQuery,
  fileId?: string,
  options: { limit?: number; entry?: string } = {},
): Promise<EngineResult<{ text: string; truncated: boolean }> | EngineResult<ChatFileReadResult>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.readChatFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  const query: ChatFileQuery =
    typeof chatIdOrQuery === 'string'
      ? {
          chatId: chatIdOrQuery,
          fileId: fileId ?? '',
          limit: options.limit,
          entry: options.entry,
        }
      : chatIdOrQuery;
  try {
    const result = await window.workbench.readChatFile(query);
    if (!result.ok) {
      return { ok: false, error: result.error ?? '读取附件失败。' };
    }
    if (typeof chatIdOrQuery === 'string') {
      return {
        ok: true,
        data: {
          text: result.data.text ?? result.data.content ?? '',
          truncated: result.data.truncated === true,
        },
      };
    }
    return result;
  } catch {
    return { ok: false, error: '读取附件失败（主进程调用异常）。' };
  }
}

/** Save-as through the main-process dialog; returns the chosen path. */
export async function downloadChatFile(
  chatId: string,
  fileId: string,
): Promise<EngineResult<{ savedPath: string }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.downloadChatFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.downloadChatFile(chatId, fileId);
    if (!result.ok) {
      return { ok: false, error: result.error ?? '下载附件失败。' };
    }
    return { ok: true, data: { savedPath: result.data.savedPath } };
  } catch {
    return { ok: false, error: '下载附件失败（主进程调用异常）。' };
  }
}

/**
 * Narrow custom-protocol URL for image / document previews.
 *
 * The URL carries chat_id + file_id only; `chat-attachment:` is allow-listed
 * for `img-src` in both dev and prod CSP and resolves through the main process.
 */
export async function previewChatFile(
  chatId: string,
  fileId: string,
): Promise<EngineResult<{ url: string }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.previewChatFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.previewChatFile(chatId, fileId);
    if (!result.ok) {
      return { ok: false, error: result.error ?? '生成预览地址失败。' };
    }
    return { ok: true, data: { url: result.data.url } };
  } catch {
    return { ok: false, error: '生成预览地址失败（主进程调用异常）。' };
  }
}

/** Open with the OS default app, or reveal it in the file manager. */
export async function openChatFile(input: {
  chatId: string;
  fileId: string;
  action?: 'open' | 'reveal';
}): Promise<EngineResult<{ path: string }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.openChatFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.openChatFile(input);
    return result.ok ? { ok: true, data: { path: '' } } : { ok: false, error: result.error ?? '打开失败。' };
  } catch {
    return { ok: false, error: '打开附件失败（主进程调用异常）。' };
  }
}

/** Save-as through the main-process dialog (download entry on the file card). */
export async function saveChatFile(input: {
  chatId: string;
  fileId: string;
}): Promise<EngineResult<{ savedPath: string }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.saveChatFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    return await window.workbench.saveChatFile(input);
  } catch {
    return { ok: false, error: '保存附件失败（主进程调用异常）。' };
  }
}

function emptyChat(chatId: string): ChatSummary {
  return {
    chat_id: chatId,
    name: '未命名群聊',
    status: 'active',
    created_at: null,
    last_message_at: null,
    last_message_preview: null,
    needs_muse: false,
    unread: 0,
    participants: [],
    agents: { muse: 'idle', claude: 'idle', dsh: 'idle' },
    settings: { description: '', announcement: '' },
  };
}

/* ------------------------------------------------------------------ *
 * REA Phase 4 §6: membership, chat settings, recall, file deletion
 * ------------------------------------------------------------------ */

function readMemberList(raw: unknown): ChatMember[] {
  return unwrapList(asRecord(raw), ['members'])
    .map(normalizeMember)
    .filter((member): member is ChatMember => member != null);
}

/** Canonical membership rows of one chat (`chat_members`). */
export async function chatMembersOnce(
  chatId: string,
): Promise<EngineResult<ChatMember[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.chatMembers) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.chatMembers(chatId);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '读取成员失败。') };
    }
    return { ok: true, data: readMemberList(result.data) };
  } catch {
    return { ok: false, error: '读取成员失败（主进程调用异常）。' };
  }
}

async function mutateMember(
  call: (() => Promise<EngineResult<unknown>>) | null,
  label: string,
): Promise<EngineResult<ChatMember[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (call == null) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await call();
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, `${label}失败。`) };
    }
    return { ok: true, data: readMemberList(result.data) };
  } catch {
    return { ok: false, error: `${label}失败（主进程调用异常）。` };
  }
}

export function addChatMember(input: {
  chatId: string;
  agentId: string;
}): Promise<EngineResult<ChatMember[]>> {
  const call = bridge()?.chatAddMember;
  return mutateMember(
    call == null ? null : () => call.call(window.workbench, input),
    '添加成员',
  );
}

export function removeChatMember(input: {
  chatId: string;
  agentId: string;
}): Promise<EngineResult<ChatMember[]>> {
  const call = bridge()?.chatRemoveMember;
  return mutateMember(
    call == null ? null : () => call.call(window.workbench, input),
    '移除成员',
  );
}

/** Persist description / announcement and return the engine's stored value. */
export async function updateChatSettings(input: {
  chatId: string;
  description?: string;
  announcement?: string;
}): Promise<EngineResult<ChatSettings>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.chatUpdateSettings) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.chatUpdateSettings(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '保存群设置失败。') };
    }
    return { ok: true, data: normalizeChatSettings(asRecord(result.data).settings) };
  } catch {
    return { ok: false, error: '保存群设置失败（主进程调用异常）。' };
  }
}

/** Recall inside the engine's window; the body is replaced with a placeholder. */
export async function recallChatMessage(input: {
  chatId: string;
  messageId: string;
}): Promise<EngineResult<Record<string, unknown>>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.chatRecall) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.chatRecall(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '撤回失败。') };
    }
    return { ok: true, data: asRecord(result.data) };
  } catch {
    return { ok: false, error: '撤回失败（主进程调用异常）。' };
  }
}

/** Delete one uploaded file (owner or uploader, enforced by the engine). */
export async function deleteChatFile(input: {
  chatId: string;
  fileId: string;
}): Promise<EngineResult<{ deleted: boolean }>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.chatDeleteFile) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.chatDeleteFile(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '删除文件失败。') };
    }
    return { ok: true, data: { deleted: result.data?.deleted !== false } };
  } catch {
    return { ok: false, error: '删除文件失败（主进程调用异常）。' };
  }
}

/* ------------------------------------------------------------------ *
 * REA Phase 4 §6.3: agent pairing / revocation
 * ------------------------------------------------------------------ */

export async function createPairingCode(
  input: { ttlHours?: number; maxAgents?: number } = {},
): Promise<EngineResult<PairingCodeResult>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.agentPairingCode) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.agentPairingCode(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '生成配对码失败。') };
    }
    const record = asRecord(result.data);
    const code = readString(record, 'code');
    if (code == null) {
      return { ok: false, error: '引擎没有返回配对码。' };
    }
    return {
      ok: true,
      data: {
        pairing_id: readString(record, 'pairing_id') ?? '',
        code,
        expires_at: readNumber(record, 'expires_at') ?? 0,
        expires_in_ms: readNumber(record, 'expires_in_ms') ?? 0,
        max_agents: readNumber(record, 'max_agents') ?? 0,
        uses: readNumber(record, 'uses') ?? 0,
      },
    };
  } catch {
    return { ok: false, error: '生成配对码失败（主进程调用异常）。' };
  }
}

export async function pairAgent(input: {
  code: string;
  name: string;
  platform?: string;
  profile?: string;
  reclaim?: boolean;
  chatIds?: string[];
}): Promise<EngineResult<Record<string, unknown>>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.agentPair) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.agentPair(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '配对失败。') };
    }
    return { ok: true, data: asRecord(result.data) };
  } catch {
    return { ok: false, error: '配对失败（主进程调用异常）。' };
  }
}

export async function revokeAgentToken(
  input: { agentId?: string } = {},
): Promise<EngineResult<Record<string, unknown>>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  if (!window.workbench.agentRevokeToken) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await window.workbench.agentRevokeToken(input);
    if (!result.ok) {
      return { ok: false, error: failureMessage(result.error, '注销失败。') };
    }
    return { ok: true, data: asRecord(result.data) };
  } catch {
    return { ok: false, error: '注销失败（主进程调用异常）。' };
  }
}

export { NO_CHAT_BRIDGE, NO_MAIN };
export type { ChatBridge };
