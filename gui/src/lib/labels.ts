import type {
  EngineLogEntry,
  EngineState,
  EngineTaskSummary,
  Executor,
  LogEntry,
  LogStream,
  TaskRow,
  TaskStatus,
  UpdatePhase,
} from '../types';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  running: '运行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  queued: '排队中',
};

export const LOG_STREAM_LABELS: Record<LogStream, string> = {
  system: '系统',
  out: '输出',
  warn: '警告',
};

export const ENGINE_STATE_LABELS: Record<EngineState, string> = {
  PENDING: 'PENDING · 排队',
  STARTING: 'STARTING · 启动中',
  WORKING: 'WORKING · 执行中',
  WAITING: 'WAITING · 等待输入',
  BLOCKED: 'BLOCKED · 阻塞',
  STALE: 'STALE · 静默',
  COMPLETED: 'COMPLETED · 完成',
  FAILED: 'FAILED · 失败',
  CANCELLED: 'CANCELLED · 已取消',
};

const SUCCESS_STATES = new Set<EngineState>(['COMPLETED']);
const FAILED_STATES = new Set<EngineState>(['FAILED', 'BLOCKED', 'STALE']);
const QUEUED_STATES = new Set<EngineState>(['PENDING']);

export function isTerminalEngineState(state: EngineState): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}

export function toTaskStatus(state: EngineState): TaskStatus {
  if (SUCCESS_STATES.has(state)) {
    return 'success';
  }
  if (state === 'CANCELLED') {
    return 'cancelled';
  }
  if (FAILED_STATES.has(state)) {
    return 'failed';
  }
  if (QUEUED_STATES.has(state)) {
    return 'queued';
  }
  return 'running';
}

const taskTitles = new Map<string, string>();

export function rememberTaskTitle(taskId: string, text: string): void {
  const title = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (title) {
    taskTitles.set(taskId, title.slice(0, 120));
  }
}

export function taskDisplayTitle(taskId: string, summary: string | null): string {
  const remembered = taskTitles.get(taskId);
  if (remembered) {
    return remembered;
  }
  const firstLine = summary
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    return firstLine.slice(0, 120);
  }
  return `任务 #${taskId.slice(0, 8)}`;
}

export function taskTitle(task: EngineTaskSummary): string {
  return taskDisplayTitle(task.task_id, task.summary);
}

export function toTaskRow(task: EngineTaskSummary): TaskRow {
  const created = Date.parse(task.created_at);
  const updated = Date.parse(task.updated_at);
  return {
    id: task.task_id,
    title: taskTitle(task),
    status: toTaskStatus(task.state),
    engineState: task.state,
    executor: task.agent,
    durationMs:
      Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    sessionId: task.session_id,
  };
}

export function toLogEntry(entry: EngineLogEntry): LogEntry {
  const stream: LogStream =
    entry.stream === 'system' ? 'system' : entry.stream === 'stderr' ? 'warn' : 'out';
  const date = new Date(entry.ts);
  const time = Number.isNaN(date.getTime())
    ? entry.ts
    : date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
      });
  return {
    line: entry.seq,
    time,
    stream,
    message: entry.line,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatRelative(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return iso;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 10) {
    return '刚刚';
  }
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)} 小时前`;
  }
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return iso;
  }
  const today = new Date();
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  const time = at.toLocaleTimeString('zh-CN', { hour12: false });
  return sameDay ? time : `${at.toLocaleDateString('zh-CN')} ${time}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) {
    return '—';
  }
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${total % 60} 秒`;
  }
  return `${total} 秒`;
}

export function executorLabel(executor: Executor): string {
  return executor === 'claude' ? 'Claude Code' : 'DeepSeek Harness';
}

export const UPDATE_PHASE_LABELS: Record<UpdatePhase, string> = {
  idle: '待检查',
  checking: '检查中',
  available: '发现新版本',
  'not-available': '已是最新',
  downloading: '下载中',
  downloaded: '待安装',
  installing: '安装中',
  error: '更新失败',
  unsupported: '不可用',
};

export function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}