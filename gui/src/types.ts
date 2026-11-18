export type Executor = 'claude' | 'dsh';

export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'queued';

export type EngineState =
  | 'PENDING'
  | 'STARTING'
  | 'WORKING'
  | 'WAITING'
  | 'BLOCKED'
  | 'STALE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type LogStream = 'system' | 'out' | 'warn';

export interface LogEntry {
  line: number;
  time: string;
  stream: LogStream;
  message: string;
}

export interface TaskRow extends Record<string, unknown> {
  id: string;
  title: string;
  status: TaskStatus;
  engineState: EngineState;
  executor: Executor;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
}

export type EngineLifecycleState = 'running' | 'starting' | 'stopped' | 'error';

export interface EngineStatus {
  state: EngineLifecycleState;
  healthy: boolean;
  managed: boolean;
  baseUrl: string;
  pid: number | null;
  version: string | null;
  uptimeSeconds: number | null;
  tokenConfigured: boolean;
  tokenSource: 'stored' | 'environment' | 'file' | 'none';
  lastError: string | null;
  checkedAt: string;
  engineRoot: string;
  logFile: string;
}

export interface EngineAgent {
  name: string;
  version: string | null;
  available: boolean;
  capabilities: string[];
  resume_supported: boolean;
  logged_in?: boolean | null;
  gateway?: {
    base_url: string;
    model: string | null;
  } | null;
  notes?: string | null;
}

export interface AgentInfo {
  agents: EngineAgent[];
  message_protocol?: {
    enabled: boolean;
    exchange_limit: number;
    summary_max_tokens: number;
    auto_deliver: boolean;
  } | null;
  approval_gate?: {
    enabled: boolean;
    categories?: string[];
    options?: string[];
    timeout_ms?: number;
  } | null;
}

export type MessageParticipant = Executor | 'user';

export interface EngineMessage {
  message_id: string;
  thread_id: string;
  from: MessageParticipant;
  to: MessageParticipant;
  task_id: string;
  reply_to: string | null;
  summary: string;
  files: string[];
  question: string | null;
  summary_tokens: number;
  summary_truncated: boolean;
  status: string;
  delivery_task_id: string | null;
  is_final: boolean;
  error: string | null;
  created_at: string;
  thread_state: string;
  exchange_count: number;
  exchange_limit: number;
  waiting_for_user: boolean;
}

export interface EngineMessageList {
  thread: {
    thread_id: string;
    root_task_id: string;
    state: string;
    exchange_count: number;
    exchange_limit: number;
    message_count: number;
    last_message_id: string | null;
    waiting_for_user: boolean;
  } | null;
  messages: EngineMessage[];
}

export interface HudConfig {
  paperPlanes: boolean;
  contextWindowTokens: number;
}

export interface EngineTaskSummary {
  task_id: string;
  session_id: string;
  agent: Executor;
  state: EngineState;
  created_at: string;
  updated_at: string;
  summary: string | null;
}

export interface EngineApproval {
  approval_id: string;
  thread_id: string;
  task_id: string;
  agent: Executor;
  category: string;
  action: string;
  command: string | null;
  files: string[];
  reason: string;
  message_id: string;
  response_message_id: string | null;
  status: string;
  decision: string | null;
  error: string | null;
  created_at: string;
  responded_at: string | null;
  thread_state: string;
  waiting_for_user: boolean;
}

export interface EngineTaskStatus {
  task_id: string;
  session_id: string;
  agent: Executor;
  state: EngineState;
  process_state: string;
  turn_state: string;
  blocker: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  exit_code: number | null;
  elapsed_ms: number;
  tokens: {
    input: number;
    output: number;
  };
  files_modified: string[];
  summary: string | null;
  thread_id?: string;
  thread_state?: string;
  waiting_for_user?: boolean;
  exchange_count?: number;
  exchange_limit?: number;
  message_count?: number;
  approval_gate?: {
    enabled: boolean;
  };
  approval?: {
    gate_enabled: boolean;
    pending: EngineApproval | null;
    last: EngineApproval | null;
  } | null;
}

export interface EngineLogEntry {
  seq: number;
  ts: string;
  stream: 'system' | 'stdout' | 'stderr';
  line: string;
}

export interface EngineTaskLogs {
  task_id: string;
  entries: EngineLogEntry[];
  next_cursor: number;
  truncated: boolean;
}

export interface EngineTaskStartResult {
  task_id: string;
  session_id: string;
  status: EngineState;
}

export interface EngineTaskCancelResult {
  task_id: string;
  status: EngineState;
}

export interface TaskListPayload {
  tasks: EngineTaskSummary[];
}

export type EngineResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type UpdateChannel = 'stable' | 'prerelease';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported';

export interface UpdateState {
  supported: boolean;
  channel: UpdateChannel;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  message: string | null;
  checkedAt: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  dataDir: string;
  cwd: string;
  engineWorkdir: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  tokenStored: boolean;
  encryptionAvailable: boolean;
  update: {
    supported: boolean;
    channel: UpdateChannel;
    reason: string;
  };
  versions: {
    electron: string;
    node: string;
    chrome: string;
  };
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

export interface TaskStartInput {
  agent: Executor;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface TaskLogsInput {
  taskId: string;
  cursor?: number;
  limit?: number;
}

export type ChatAgentId = 'muse' | 'claude' | 'dsh';

/** Four real participants of a group chat: the user plus the three agents. */
export type ChatParticipantId = 'user' | 'muse' | 'claude' | 'dsh';

export interface ChatAgentState {
  status: string;
  task_id?: string | null;
  updated_at?: string | null;
}

export interface ChatParticipant {
  id: ChatParticipantId;
  name: string;
  role: 'user' | 'agent';
  /** Engine-derived status: idle | pending | working | waiting | blocked | completed | failed | cancelled | needs_reply. */
  status: string;
  /** Raw engine state when the engine exposes one (COMPLETED, WORKING, …). */
  state: string | null;
  task_id: string | null;
  updated_at: string | null;
  unread?: number;
}

export interface ChatSummary {
  chat_id: string;
  name: string;
  status: 'active' | 'archived';
  created_at?: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  needs_muse: boolean;
  unread?: number;
  participants?: ChatParticipant[];
  /** Engine returns plain status strings per agent (CHAT_BACKEND §3.2). */
  agents: Record<ChatAgentId, string>;
}

/**
 * Attachment metadata. `file_id` is the only handle the renderer ever sees;
 * bytes live in the engine's per-chat file area and are reached through the
 * main process (IPC read / `chat-attachment:` protocol).
 */
export type ChatFileKind =
  | 'image'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'zip'
  | 'code'
  | 'text'
  | 'other';

export interface ChatFile {
  file_id: string;
  chat_id?: string | null;
  name: string;
  size: number;
  mime: string;
  kind: ChatFileKind;
  sha256?: string | null;
  /** parsed | pending | failed | unsupported — server-side parse state. */
  status: string;
  preview_text?: string | null;
  preview_truncated?: boolean;
  uploader?: ChatParticipantId | null;
  created_at: string;
  /** Set only on upload results: which pending draft produced this file. */
  draft_id?: string | null;
}

export interface ChatMention {
  id: ChatParticipantId;
  label: string;
  offset: number;
  length: number;
}

export interface ChatMessage {
  message_id: string;
  chat_id?: string | null;
  /** Monotonic cursor assigned by the engine; used for incremental polling. */
  seq: number;
  from: ChatParticipantId | 'unknown';
  to: ChatParticipantId | 'unknown';
  summary: string;
  files: ChatFile[];
  mentions: ChatParticipantId[];
  question?: string | null;
  reply_to?: string | null;
  client_msg_id?: string | null;
  status: string;
  created_at: string;
  task_id?: string | null;
}

export interface ChatStatusPayload {
  chat_id: string;
  needs_muse: boolean;
  agents: Record<ChatAgentId, string>;
  participants?: ChatParticipant[];
}

/* ------------------------------------------------------------------ *
 * REA Phase 2 (docs/rea/TARGET_ARCHITECTURE.md D1/D3/D4)
 * ------------------------------------------------------------------ */

/**
 * Per-chat unread counters of one agent, straight from the engine `inbox`
 * tool. `unread` counts every message after the cursor; the category counters
 * exclude the agent's own messages.
 */
export interface ChatInboxEntry {
  chat_id: string;
  name: string;
  status: string;
  last_read_seq: number;
  unread: number;
  mentions_you: number;
  replies_to_you: number;
  from_owner: number;
  recalled: number;
  last_message_at: string | null;
}

/** Self-check block the engine returns with every inbox read. */
export interface ChatInboxIdentity {
  agent_id: string;
  participant_id: string | null;
  owner: string | null;
  platform: string | null;
  display_name: string;
  human: boolean;
  status: string;
}

export interface ChatInboxPayload {
  you: ChatInboxIdentity;
  total_unread: number;
  chats: ChatInboxEntry[];
}

/** Profile Card of one agent (engine `agent_profile`). */
export interface AgentProfileCard {
  agent_id: string;
  participant_id: ChatParticipantId | null;
  owner: string | null;
  platform: string | null;
  display_name: string;
  profile: string | null;
  color: string | null;
  status: string;
  created_at: number;
}

/** Draft returned by the main process after a dialog / drop / paste intake. */
export interface ChatUploadDraft {
  draftId: string;
  name: string;
  size: number;
  mime: string;
  ext: string;
  kind: ChatFileKind;
  source: 'dialog' | 'drop' | 'paste';
}

export type ChatUploadPhase = 'init' | 'chunk' | 'complete' | 'done' | 'error';

export interface ChatUploadProgress {
  uploadId: string;
  draftId: string;
  fileId: string | null;
  name: string;
  size: number;
  uploaded: number;
  percent: number;
  phase: ChatUploadPhase;
  error?: string;
}

export interface ChatUploadResult {
  files: ChatFile[];
  errors: Array<{ draftId: string; name: string; error: string }>;
}

export interface ChatFileReadResult {
  file_id: string;
  name: string;
  mime: string;
  kind: ChatFileKind;
  size: number;
  mode: 'text' | 'base64';
  content: string;
  encoding: 'utf8' | 'base64';
  offset: number;
  next_offset: number | null;
  truncated: boolean;
  /** Document text, mirrored from `content` for the frozen helper contract. */
  text?: string;
  /** Image bytes, only present when the file is an image. */
  image?: { data: string; mimeType: string } | null;
  preview_text?: string | null;
}

export interface SendChatMessageInput {
  chatId: string;
  from?: 'user' | 'muse';
  to?: ChatParticipantId;
  summary: string;
  /** file_id values returned by engine:chat-upload. */
  files?: string[];
  mentions?: ChatParticipantId[];
  replyTo?: string;
  clientMsgId?: string;
  question?: string;
  taskId?: string;
}

export interface ChatMessageQuery {
  chatId: string;
  limit?: number;
  /** Forward-paging cursor: message_id or ISO timestamp (exclusive). */
  before?: string;
  /** Incremental cursor: only messages with seq > afterSeq. */
  afterSeq?: number;
}

export interface ChatFileQuery {
  chatId: string;
  fileId: string;
  /** ZIP member path when reading inside an archive. */
  entry?: string;
  /** Maximum text bytes the backend may return (default 200 KB, cap 2 MB). */
  limit?: number;
  /** Legacy fields kept for the first preview caller during the migration. */
  offset?: number;
  mode?: 'text' | 'base64';
}

export interface WorkbenchApi {
  getAppInfo: () => Promise<AppInfo>;
  setToken: (token: string) => Promise<OperationResult>;
  clearToken: () => Promise<OperationResult>;
  openDataDir: () => Promise<OperationResult>;
  openExternal: (url: string) => Promise<OperationResult>;
  copyText: (text: string) => Promise<OperationResult>;
  getEngineStatus: () => Promise<EngineResult<EngineStatus>>;
  startEngine: () => Promise<EngineResult<EngineStatus>>;
  stopEngine: () => Promise<EngineResult<EngineStatus>>;
  getAgentInfo: () => Promise<EngineResult<AgentInfo>>;
  listTasks: (limit?: number) => Promise<EngineResult<TaskListPayload>>;
  listMessages: (input?: {
    limit?: number;
    taskId?: string;
  }) => Promise<EngineResult<EngineMessageList>>;
  listChats: (options?: { includeArchived?: boolean }) => Promise<EngineResult<{ chats: ChatSummary[] }>>;
  createChat: (name?: string) => Promise<EngineResult<ChatSummary>>;
  renameChat: (chatId: string, name: string) => Promise<EngineResult<ChatSummary>>;
  archiveChat: (chatId: string) => Promise<EngineResult<ChatSummary>>;
  unarchiveChat: (chatId: string) => Promise<EngineResult<ChatSummary>>;
  listChatMessages: (
    input: ChatMessageQuery,
  ) => Promise<
    EngineResult<{ messages: ChatMessage[]; has_more?: boolean; next_seq?: number }>
  >;
  sendChatMessage: (
    input: SendChatMessageInput,
  ) => Promise<
    EngineResult<{ message_id: string; chat_id: string; created_at?: string; seq?: number }>
  >;
  chatStatus: (chatId: string) => Promise<EngineResult<ChatStatusPayload>>;
  chatParticipants: (
    chatId: string,
  ) => Promise<EngineResult<{ chat_id: string; participants: ChatParticipant[] }>>;
  chatMarkRead: (input: {
    chatId: string;
    /** Master token only: advance a built-in agent's cursor (Inbox view). */
    participantId?: string;
    upToSeq?: number;
    messageId?: string;
  }) => Promise<EngineResult<{ chat_id: string; last_read_seq: number; unread: number }>>;
  /** REA Phase 2: per-agent per-chat unread counters (`inbox` tool). */
  chatInbox: (input?: { agentId?: string; chatId?: string }) => Promise<EngineResult<ChatInboxPayload>>;
  /** REA Phase 2: read a Profile Card or update one (≤300 characters). */
  agentProfile: (input?: { agentId?: string; profile?: string }) => Promise<
    EngineResult<AgentProfileCard>
  >;
  pickChatFiles: () => Promise<EngineResult<{ drafts: ChatUploadDraft[] }>>;
  registerChatFiles: (
    files: File[],
    source?: 'drop' | 'paste',
  ) => Promise<EngineResult<{ drafts: ChatUploadDraft[] }>>;
  uploadChatFiles: (input: {
    chatId: string;
    uploadId: string;
    draftIds: string[];
  }) => Promise<EngineResult<ChatUploadResult>>;
  discardChatDrafts: (draftIds: string[]) => Promise<OperationResult>;
  readChatFile: (input: ChatFileQuery) => Promise<EngineResult<ChatFileReadResult>>;
  /** Files uploaded to one chat (metadata only). */
  listChatFiles: (input: {
    chatId: string;
    limit?: number;
  }) => Promise<EngineResult<{ chat_id: string; files: ChatFile[] }>>;
  /** Narrow `chat-attachment://` URL for image / document previews. */
  previewChatFile: (
    chatId: string,
    fileId: string,
  ) => Promise<EngineResult<{ url: string }>>;
  /** Save-as through the main-process dialog; returns the chosen path. */
  downloadChatFile: (
    chatId: string,
    fileId: string,
  ) => Promise<EngineResult<{ savedPath: string }>>;
  openChatFile: (input: {
    chatId: string;
    fileId: string;
    action?: 'open' | 'reveal';
  }) => Promise<OperationResult>;
  saveChatFile: (input: {
    chatId: string;
    fileId: string;
  }) => Promise<EngineResult<{ savedPath: string }>>;
  onChatUploadProgress: (callback: (progress: ChatUploadProgress) => void) => () => void;
  getHudConfig: () => Promise<HudConfig>;
  setHudConfig: (patch: Partial<HudConfig>) => Promise<HudConfig>;
  respondApproval: (input: {
    taskId?: string;
    approvalId?: string;
    decision: 'once' | 'session' | 'deny';
    reason?: string;
  }) => Promise<EngineResult<Record<string, unknown>>>;
  getTaskStatus: (taskId: string) => Promise<EngineResult<EngineTaskStatus>>;
  getTaskLogs: (input: TaskLogsInput) => Promise<EngineResult<EngineTaskLogs>>;
  startTask: (input: TaskStartInput) => Promise<EngineResult<EngineTaskStartResult>>;
  sendTask: (taskId: string, prompt: string) => Promise<EngineResult<EngineTaskStartResult>>;
  cancelTask: (taskId: string) => Promise<EngineResult<EngineTaskCancelResult>>;
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  downloadUpdate: () => Promise<UpdateState>;
  installUpdate: () => Promise<OperationResult>;
  setUpdateChannel: (channel: UpdateChannel) => Promise<UpdateState>;
  onUpdateState: (callback: (state: UpdateState) => void) => () => void;
}

export type Route =
  | { name: 'chats' }
  | { name: 'inbox' }
  | { name: 'chat'; id: string }
  | { name: 'tasks'; scope?: 'history' }
  | { name: 'task'; id: string }
  | { name: 'dispatch' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'files' };