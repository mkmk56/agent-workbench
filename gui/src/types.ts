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
  tokenSource: 'stored' | 'environment' | 'none';
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
  | { name: 'tasks' }
  | { name: 'task'; id: string }
  | { name: 'dispatch' }
  | { name: 'settings' }
  | { name: 'about' };