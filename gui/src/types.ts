export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'queued';

export type Executor = 'claude' | 'dsh';

export interface Task extends Record<string, unknown> {
  id: string;
  title: string;
  status: TaskStatus;
  executor: Executor;
  duration: string;
  updated: string;
  updatedAt: string;
  sha: string;
  workdir: string;
  prompt: string;
  startedAt: string;
}

export type LogStream = 'system' | 'out' | 'warn';

export interface LogEntry {
  line: number;
  time: string;
  stream: LogStream;
  message: string;
}

export interface AppInfo {
  name: string;
  version: string;
  dataDir: string;
  cwd: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  tokenStored: boolean;
  encryptionAvailable: boolean;
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

export interface WorkbenchApi {
  getAppInfo: () => Promise<AppInfo>;
  setToken: (token: string) => Promise<OperationResult>;
  clearToken: () => Promise<OperationResult>;
  openDataDir: () => Promise<OperationResult>;
  openExternal: (url: string) => Promise<OperationResult>;
  copyText: (text: string) => Promise<OperationResult>;
}

export type Route =
  | { name: 'tasks' }
  | { name: 'task'; id: string }
  | { name: 'dispatch' }
  | { name: 'settings' }
  | { name: 'about' };