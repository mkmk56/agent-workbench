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