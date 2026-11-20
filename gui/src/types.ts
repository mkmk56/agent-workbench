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
  /** Result text written when the run finishes — never the input prompt. */
  summary: string | null;
  /**
   * Original prompt and working directory stored with the task (REA Phase 4).
   * Optional: an older engine does not send them, and the inspector then
   * disables "重试" instead of guessing from `summary`.
   */
  prompt?: string | null;
  cwd?: string | null;
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

/**
 * Built-in participant handles. A chat can also contain paired agents whose
 * participant id is `agent_<id>`; membership is authoritative in `chat_members`
 * (REA Phase 4 §6.1), so this union only covers the shipped identities.
 */
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
  /** REA Phase 4: user-editable description/announcement (empty object when unset). */
  settings?: ChatSettings | null;
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

/** REA Phase 4: `user` is ordinary chat, `system` is engine-internal notices. */
export type ChatMessageKind = 'user' | 'system';

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
  /** Omitted by pre-Phase-4 engines / databases; treat missing as `user`. */
  kind?: ChatMessageKind | null;
  /** True once `chat_recall` replaced the body with the engine placeholder. */
  recalled?: boolean;
}

/** One canonical membership row (`chat_members`), owner-only mutations. */
export interface ChatMember {
  agent_id: string;
  participant_id: string | null;
  /** owner | member */
  role: string;
  owner: string | null;
  /** claude | dsh | muse | null for the human owner. */
  platform: string | null;
  display_name: string;
  color: string | null;
  /** active | revoked … */
  status: string;
  /** Epoch ms from the engine membership row. */
  joined_at: number | string | null;
}

/** Per-chat JSON settings column (`chats.settings`). */
export interface ChatSettings {
  description: string;
  announcement: string;
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

/* ------------------------------------------------------------------ *
 * REA Phase 3 (docs/rea/PHASE3_DESIGN.md §13): wake / listener status
 * ------------------------------------------------------------------ */

/** The last wake event the engine recorded for one (agent, chat). */
export interface WakeLastEvent {
  id: string;
  seq: number;
  /** mention | reply | owner_post */
  kind: string;
  /** pending | delivered | throttled | merged | failed | disabled */
  status: string;
  /** Engine stores epoch ms; normalized to an ISO string for formatting. */
  created_at: string | null;
}

/** Per-chat wake configuration, straight from the `wake_status` tool. */
export interface WakeChatStatus {
  chat_id: string;
  name: string | null;
  enabled: boolean;
  /** mention | reply | owner_post — the kinds allowed to wake this agent. */
  wake_kinds: string[];
  consecutive_failures: number;
  /** ISO timestamp of the last disable, or null when wake is on. */
  disabled_at: string | null;
  today_runs: number;
  last_event: WakeLastEvent | null;
}

export interface WakeStatusPayload {
  agent_id: string;
  participant_id: string | null;
  /** True when at least one chat has wake enabled. */
  enabled: boolean;
  chats: WakeChatStatus[];
  /**
   * REA Phase 4 [B]: `[wake]` unread reminders that have not been delivered as
   * a chat message (they no longer enter the stream). Absent on engines that do
   * not expose them yet — the banner then simply shows nothing.
   */
  notices?: WakeUnreadNotice[];
}

/** One pending `[wake]` unread reminder (engine `wake_unread_notices`). */
export interface WakeUnreadNotice {
  id: string;
  seq: number;
  chat_id: string | null;
  agent_id: string;
  /** mention | reply | owner_post | manual */
  kind: string;
  message_id: string | null;
  /** ISO string (engine stores epoch ms). */
  created_at: string | null;
}

export interface ListenerCheckin {
  every_minutes: number;
  /** Engine stores epoch ms; normalized to an ISO string for formatting. */
  last_checkin_at: string | null;
  consecutive_empty: number;
}

export interface ListenerSession {
  id: string;
  chat_id: string | null;
  status: string;
  last_event_seq: number;
  connected_at: string | null;
  last_seen_at: string | null;
}

export interface ListenerStatusPayload {
  agent_id: string;
  participant_id: string | null;
  online: boolean;
  last_event_seq: number;
  checkin: ListenerCheckin | null;
  sessions: ListenerSession[];
}

/** Result of `wake_enable` / `wake_disable` (owner-only engine tools). */
export interface WakeToggleResult {
  agent_id: string;
  chat_id: string;
  enabled: boolean;
  wake_kinds: string[];
  consecutive_failures: number;
  disabled_at: string | null;
}

/* ------------------------------------------------------------------ *
 * REA Phase 4 §7.1: GET /events (SSE) pushed from the main process
 * ------------------------------------------------------------------ */

/**
 * One wake event envelope from `GET /events`. It is the only push channel the
 * engine has: every panel refreshes from it instead of guessing via polling.
 */
export interface EngineEvent {
  id?: string | null;
  seq: number;
  chat_id: string | null;
  /** mention | reply | owner_post | … */
  kind: string;
  from: string | null;
  agent_id: string | null;
  message_id: string | null;
  message_seq: number | null;
  mentions: string[];
  /** Epoch ms. */
  created_at: number;
}

/** Live state of the single SSE connection owned by the main process. */
export interface EngineEventsStatus {
  /** connected = stream open; connecting = opening/retrying; off = not running. */
  state: 'off' | 'connecting' | 'connected';
  /** True when the connection dropped and the GUI is back to polling. */
  degraded: boolean;
  lastSeq: number;
  lastEventAt: string | null;
  error: string | null;
}

/** Paired agent row for the Settings → Agent 管理 section. */
export interface PairedAgent {
  agent_id: string;
  display_name: string;
  /** claude | dsh | muse | custom platform label from the engine. */
  platform: string | null;
  /** active | revoked … */
  status: string;
  role: string;
  color: string | null;
  /** Muse has no local executor: the UI must not offer to start one. */
  external: boolean;
  joined_at: string | null;
}

export interface PairingCodeResult {
  pairing_id: string;
  code: string;
  expires_at: number;
  expires_in_ms: number;
  max_agents: number;
  uses: number;
}

export interface PairResult {
  agent_id?: string;
  display_name?: string;
  token?: string;
  [key: string]: unknown;
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
  /** REA Phase 3: per-chat wake state for one agent (`wake_status` tool). */
  wakeStatus: (input?: { agentId?: string; chatId?: string }) => Promise<
    EngineResult<WakeStatusPayload>
  >;
  /** REA Phase 3: listener sessions + check-in interval (`listener_status` tool). */
  listenerStatus: (input?: { agentId?: string }) => Promise<EngineResult<ListenerStatusPayload>>;
  /** REA Phase 3: owner-only wake switch (`wake_enable` tool). */
  wakeEnable: (input: { agentId: string; chatId: string }) => Promise<
    EngineResult<WakeToggleResult>
  >;
  /** REA Phase 3: owner-only wake switch (`wake_disable` tool). */
  wakeDisable: (input: { agentId: string; chatId: string }) => Promise<
    EngineResult<WakeToggleResult>
  >;
  /** REA Phase 4: canonical membership list (`chat_members`, owner-only writes). */
  chatMembers: (chatId: string) => Promise<
    EngineResult<{ chat_id: string; members: ChatMember[] }>
  >;
  /** REA Phase 4: owner-only membership mutation (`chat_add_member`). */
  chatAddMember: (input: {
    chatId: string;
    agentId: string;
  }) => Promise<EngineResult<{ chat_id: string; members: ChatMember[] }>>;
  /** REA Phase 4: owner-only membership mutation (`chat_remove_member`). */
  chatRemoveMember: (input: {
    chatId: string;
    agentId: string;
  }) => Promise<EngineResult<{ chat_id: string; members: ChatMember[] }>>;
  /** REA Phase 4: per-chat description / announcement (`chat_settings` write). */
  chatUpdateSettings: (input: {
    chatId: string;
    description?: string;
    announcement?: string;
  }) => Promise<EngineResult<{ chat_id: string; settings: ChatSettings }>>;
  /** REA Phase 4: recall a message inside the engine window (`chat_recall`). */
  chatRecall: (input: {
    chatId: string;
    messageId: string;
  }) => Promise<EngineResult<Record<string, unknown>>>;
  /** REA Phase 4: delete an uploaded file (`chat_delete_file`). */
  chatDeleteFile: (input: {
    chatId: string;
    fileId: string;
  }) => Promise<EngineResult<{ chat_id: string; file_id: string; deleted: boolean }>>;
  /** REA Phase 4: one-time pairing code (`agent_pairing_code`). */
  agentPairingCode: (input?: {
    ttlHours?: number;
    maxAgents?: number;
  }) => Promise<EngineResult<PairingCodeResult>>;
  /** REA Phase 4: exchange a pairing code for a token (`agent_pair`). */
  agentPair: (input: {
    code: string;
    name: string;
    platform?: string;
    profile?: string;
    reclaim?: boolean;
    chatIds?: string[];
  }) => Promise<EngineResult<PairResult>>;
  /** REA Phase 4: revoke an agent token (`agent_revoke_token`). */
  agentRevokeToken: (input?: {
    agentId?: string;
  }) => Promise<EngineResult<{ agent_id: string; status: string }>>;
  /** REA Phase 4: live SSE status of the main-process event stream. */
  getEventsStatus: () => Promise<EngineEventsStatus>;
  onEngineEvent: (callback: (event: EngineEvent) => void) => () => void;
  onEventsStatus: (callback: (status: EngineEventsStatus) => void) => () => void;
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
  /** REA Phase 4 [D]: per-chat settings page (#/chats/:id/settings). */
  | { name: 'chat-settings'; id: string }
  | { name: 'tasks'; scope?: 'history' }
  | { name: 'task'; id: string }
  | { name: 'dispatch' }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'files' }
  /** Hidden Phase 4 follow-up: Lucide ⇄ Reicon comparison (#/preview/reicon). */
  | { name: 'preview-reicon' };