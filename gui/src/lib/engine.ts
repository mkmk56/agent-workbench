import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentInfo,
  EngineLogEntry,
  EngineMessage,
  EngineResult,
  EngineStatus,
  EngineTaskStatus,
  EngineTaskSummary,
  TaskStartInput,
} from '../types';
import { engineUnavailable } from './workbench';
import { isTerminalEngineState, toLogEntry } from './labels';
import type { LogEntry, TaskRow } from '../types';
import { toTaskRow } from './labels';

const NO_MAIN = '主进程未连接（浏览器预览）。';

export function useEngineStatus(pollMs = 5_000): {
  status: EngineStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await window.workbench.getEngineStatus();
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(result.data);
      setError(result.data.state === 'error' ? result.data.lastError : null);
    } catch {
      if (alive.current) {
        setError('读取引擎状态失败。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { status, error, loading, refresh };
}

export function useAgentInfo(pollMs = 30_000): {
  agents: AgentInfo['agents'];
  info: AgentInfo | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [agents, setAgents] = useState<AgentInfo['agents']>([]);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    try {
      const result = await window.workbench.getAgentInfo();
      if (!alive.current) {
        return;
      }
      if (result.ok) {
        setInfo(result.data);
        setAgents(result.data.agents);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      if (alive.current) {
        setError('读取执行器状态失败（主进程调用异常）。');
      }
    } finally {
      if (alive.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { agents, info, error, loading, refresh };
}

export function useTaskList(limit = 200, pollMs = 5_000): {
  tasks: TaskRow[];
  rawTasks: EngineTaskSummary[];
  error: string | null;
  loading: boolean;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
} {
  const [rawTasks, setRawTasks] = useState<EngineTaskSummary[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await window.workbench.listTasks(limit);
      if (!alive.current) {
        return;
      }
      if (result.ok) {
        setRawTasks(result.data.tasks);
        setTasks(result.data.tasks.map(toTaskRow));
        setError(null);
        setLastUpdated(new Date());
      } else {
        setError(result.error);
      }
    } catch {
      if (alive.current) {
        setError('读取任务列表失败。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [limit]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { tasks, rawTasks, error, loading, lastUpdated, refresh };
}

export function useTaskMessages(
  taskId: string,
  pollMs = 4_000,
): {
  messages: EngineMessage[];
  error: string | null;
  loading: boolean;
  saturated: boolean;
  refresh: () => Promise<void>;
} {
  const [messages, setMessages] = useState<EngineMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saturated, setSaturated] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await window.workbench.listMessages({ limit: 500, taskId });
      if (!alive.current) {
        return;
      }
      if (result.ok) {
        setMessages(result.data.messages);
        setSaturated(result.data.messages.length >= 500);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch {
      if (alive.current) {
        setError('读取会话消息失败。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    alive.current = true;
    setMessages([]);
    setError(null);
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, pollMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [pollMs, refresh]);

  return { messages, error, loading, saturated, refresh };
}

export function useTaskDetail(taskId: string): {
  status: EngineTaskStatus | null;
  logs: LogEntry[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<EngineTaskStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cursor = useRef(0);
  const terminal = useRef(false);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const tick = useCallback(async () => {
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const statusResult = await window.workbench.getTaskStatus(taskId);
      if (!alive.current) {
        return;
      }
      if (statusResult.ok) {
        setStatus(statusResult.data);
        terminal.current = isTerminalEngineState(statusResult.data.state);
        setError(null);
      } else {
        setError(statusResult.error);
      }

      let nextCursor = cursor.current;
      for (let page = 0; page < 20; page += 1) {
        const logResult = await window.workbench.getTaskLogs({
          taskId,
          cursor: nextCursor,
          limit: 500,
        });
        if (!alive.current) {
          return;
        }
        if (!logResult.ok) {
          setError(logResult.error);
          break;
        }
        const entries: EngineLogEntry[] = logResult.data.entries;
        if (entries.length > 0) {
          nextCursor = logResult.data.next_cursor;
          cursor.current = nextCursor;
          setLogs((previous) => [...previous, ...entries.map(toLogEntry)]);
        }
        if (!logResult.data.truncated) {
          break;
        }
      }
    } catch {
      if (alive.current) {
        setError('读取任务状态或日志失败。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [taskId]);

  useEffect(() => {
    alive.current = true;
    cursor.current = 0;
    terminal.current = false;
    setStatus(null);
    setLogs([]);
    setError(null);
    setLoading(true);
    void tick();
    const timer = setInterval(() => {
      if (!terminal.current) {
        void tick();
      }
    }, 1_200);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [taskId, tick]);

  const refresh = useCallback(async () => {
    terminal.current = false;
    await tick();
  }, [tick]);

  return { status, logs, error, loading, refresh };
}

export async function getEngineStatusOnce(): Promise<EngineResult<EngineStatus>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  try {
    return await window.workbench.getEngineStatus();
  } catch {
    return { ok: false, error: '读取引擎状态失败。' };
  }
}

export async function startEngine(): Promise<EngineResult<EngineStatus>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.startEngine();
  } catch {
    return { ok: false, error: '启动引擎失败。' };
  }
}

export async function stopEngine(): Promise<EngineResult<EngineStatus>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.stopEngine();
  } catch {
    return { ok: false, error: '停止引擎失败。' };
  }
}

export async function startTask(
  input: TaskStartInput,
): Promise<EngineResult<{ task_id: string; session_id: string; status: string }>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.startTask(input);
  } catch {
    return { ok: false, error: '创建任务失败。' };
  }
}

export async function sendTask(
  taskId: string,
  prompt: string,
): Promise<EngineResult<{ task_id: string; session_id: string; status: string }>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.sendTask(taskId, prompt);
  } catch {
    return { ok: false, error: '发送跟进消息失败。' };
  }
}

export async function cancelTask(
  taskId: string,
): Promise<EngineResult<{ task_id: string; status: string }>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.cancelTask(taskId);
  } catch {
    return { ok: false, error: '取消任务失败。' };
  }
}

export async function respondApproval(input: {
  taskId?: string;
  approvalId?: string;
  decision: 'once' | 'session' | 'deny';
  reason?: string;
}): Promise<EngineResult<Record<string, unknown>>> {
  if (!window.workbench) {
    return engineUnavailable();
  }
  try {
    return await window.workbench.respondApproval(input);
  } catch {
    return { ok: false, error: '提交审批决定失败。' };
  }
}