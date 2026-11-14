import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInfo,
  EngineMessage,
  EngineStatus,
  EngineTaskSummary,
  HudConfig,
} from '../types';
import { useAgentInfo, useTaskList } from './engine';
import { formatDuration, formatRelative, taskDisplayTitle } from './labels';

export type HudAgentId = 'muse' | 'claude' | 'dsh';
export type HudExecutorId = 'claude' | 'dsh';
export type HudState = 'idle' | 'working' | 'waiting' | 'error';

export interface HudSlot {
  id: HudAgentId;
  name: string;
  state: HudState;
  statusText: string;
  detail: string;
  model: string;
  activeCount: number;
  elapsedMs: number | null;
  unread: number;
  queued: number;
  taskId: string | null;
  available: boolean;
}

export interface HudFlight {
  seq: number;
  messageId: string;
  from: HudExecutorId;
  to: HudExecutorId;
}

const ACTIVE_STATES = new Set([
  'PENDING',
  'STARTING',
  'WORKING',
  'WAITING',
  'BLOCKED',
  'STALE',
]);
const ERROR_ACTIVE_STATES = new Set(['BLOCKED', 'STALE']);
const RECENT_FAILURE_MS = 15 * 60 * 1000;
const MESSAGE_LIMIT = 500;
const MESSAGE_TAIL = 300;

const STATE_TEXT: Record<HudState, string> = {
  idle: '空闲',
  working: '干活中',
  waiting: '等你输入',
  error: '出错',
};

function isExecutor(value: string): value is HudExecutorId {
  return value === 'claude' || value === 'dsh';
}

function byCreatedAt(a: EngineTaskSummary, b: EngineTaskSummary): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

function byMessageTime(a: EngineMessage, b: EngineMessage): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

function latestTask(tasks: EngineTaskSummary[], agent: HudExecutorId): EngineTaskSummary | null {
  return tasks.filter((task) => task.agent === agent).sort(byCreatedAt)[0] ?? null;
}

function activeTasks(tasks: EngineTaskSummary[], agent: HudExecutorId): EngineTaskSummary[] {
  return tasks.filter((task) => task.agent === agent && ACTIVE_STATES.has(task.state));
}

function elapsedOf(tasks: EngineTaskSummary[]): number | null {
  if (tasks.length === 0) {
    return null;
  }
  const oldest = tasks.reduce((carry, task) =>
    Date.parse(task.created_at) < Date.parse(carry.created_at) ? task : carry,
  );
  const started = Date.parse(oldest.created_at);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
}

function agentSlot(
  id: HudExecutorId,
  name: string,
  engine: EngineStatus | null,
  agents: AgentInfo['agents'],
  agentsLoaded: boolean,
  agentsError: string | null,
  tasks: EngineTaskSummary[],
  unread: number,
  queued: number,
): HudSlot {
  const meta = agents.find((agent) => agent.name === id) ?? null;
  const active = activeTasks(tasks, id).sort(byCreatedAt);
  const latest = latestTask(tasks, id);
  const engineStarting = engine?.state === 'starting';

  let state: HudState = 'idle';
  let statusText = STATE_TEXT.idle;
  let detail = latest
    ? `最近任务：${taskDisplayTitle(latest.task_id, latest.summary)}（${latest.state}）`
    : '最近 200 条任务中无该执行器的记录。';

  if (engine == null || engineStarting) {
    // Not ready yet is not the same as broken: keep the slot neutral until the
    // engine reports a real error or an executor is actually unavailable.
    statusText = '连接中';
    detail = engineStarting ? '引擎正在启动，状态尚未确定。' : '正在读取引擎状态…';
  } else if (!engine.healthy) {
    state = 'error';
    statusText = STATE_TEXT.error;
    detail = '引擎离线，无法读取执行器状态。';
  } else if (agentsLoaded && agentsError != null) {
    statusText = '状态未知';
    detail = `执行器状态读取失败：${agentsError}`;
  } else if (agentsLoaded && (meta == null || !meta.available)) {
    state = 'error';
    statusText = STATE_TEXT.error;
    detail = meta == null ? '引擎未返回该执行器的信息。' : '执行器不可用（版本探测失败）。';
  } else if (active.some((task) => task.state === 'WAITING')) {
    state = 'waiting';
    statusText = STATE_TEXT.waiting;
    detail = '有任务在等待你的输入。';
  } else if (active.some((task) => ERROR_ACTIVE_STATES.has(task.state))) {
    state = 'error';
    statusText = STATE_TEXT.error;
    detail = '有任务被阻塞或已静默（BLOCKED / STALE）。';
  } else if (active.length > 0) {
    const head = active[0];
    state = 'working';
    statusText = STATE_TEXT.working;
    detail =
      active.length > 1
        ? `${taskDisplayTitle(head.task_id, head.summary)}（另有 ${active.length - 1} 个任务）`
        : taskDisplayTitle(head.task_id, head.summary);
  } else if (latest?.state === 'FAILED') {
    const updated = Date.parse(latest.updated_at);
    if (Number.isFinite(updated) && Date.now() - updated < RECENT_FAILURE_MS) {
      state = 'error';
      statusText = STATE_TEXT.error;
      detail = `最近任务失败（${formatRelative(latest.updated_at)}）。`;
    }
  }

  const jumpTask = active[0] ?? latest;
  return {
    id,
    name,
    state,
    statusText,
    detail,
    model: meta?.gateway?.model ?? meta?.version ?? '—',
    activeCount: active.length,
    elapsedMs: elapsedOf(active),
    unread,
    queued,
    taskId: jumpTask?.task_id ?? null,
    available: meta?.available ?? false,
  };
}

function museSlot(
  engine: EngineStatus | null,
  tasks: EngineTaskSummary[],
  messages: EngineMessage[],
  unread: number,
  queued: number,
): HudSlot {
  const active = tasks.filter((task) => ACTIVE_STATES.has(task.state)).sort(byCreatedAt);
  const waiting = messages.some((message) => message.waiting_for_user);
  let state: HudState = 'idle';
  let statusText = STATE_TEXT.idle;
  let detail = '暂无进行中的任务。';

  if (engine == null || engine.state === 'starting') {
    statusText = '连接中';
    detail = engine?.state === 'starting'
      ? '引擎正在启动，编排器状态尚未确定。'
      : '正在读取引擎状态…';
  } else if (!engine.healthy) {
    state = 'error';
    statusText = STATE_TEXT.error;
    detail = '引擎离线，云端编排器无法派单。';
  } else if (waiting) {
    state = 'waiting';
    statusText = STATE_TEXT.waiting;
    detail = '有会话在等你回复（线程处于 WAITING_USER）。';
  } else if (active.length > 0) {
    state = 'working';
    statusText = STATE_TEXT.working;
    detail = `${active.length} 个任务正在执行（通过引擎任务活动间接感知）。`;
  }

  return {
    id: 'muse',
    name: 'Muse',
    state,
    statusText,
    detail,
    model: '云端编排器',
    activeCount: active.length,
    elapsedMs: elapsedOf(active),
    unread,
    queued,
    // Muse is the orchestrator, not an executor conversation: open the task list.
    taskId: null,
    available: engine?.healthy === true,
  };
}

// Shared HUD settings store. The settings page (phase 5) and the HUD can both
// call setPaperPlanes and see the change immediately; the value is persisted by
// the main process in userData/hud.json.
let sharedConfig: HudConfig = { paperPlanes: true, contextWindowTokens: 128_000 };
let configLoaded = false;
let configLoading: Promise<void> | null = null;
const configListeners = new Set<(next: HudConfig) => void>();

function publishConfig(next: HudConfig): void {
  sharedConfig = next;
  for (const listener of configListeners) {
    listener(next);
  }
}

function loadConfigOnce(): void {
  if (configLoaded || configLoading != null || !window.workbench) {
    return;
  }
  configLoading = window.workbench
    .getHudConfig()
    .then((next) => {
      configLoaded = true;
      publishConfig(next);
    })
    .catch(() => {
      // Keep the documented default (on) when the main process is unavailable.
      configLoaded = true;
    })
    .finally(() => {
      configLoading = null;
    });
}

export function useHudConfig(): {
  config: HudConfig;
  setPaperPlanes: (enabled: boolean) => Promise<void>;
  setContextWindowTokens: (tokens: number) => Promise<void>;
} {
  const [config, setConfig] = useState<HudConfig>(sharedConfig);

  useEffect(() => {
    const listener = (next: HudConfig) => setConfig(next);
    configListeners.add(listener);
    loadConfigOnce();
    setConfig(sharedConfig);
    return () => {
      configListeners.delete(listener);
    };
  }, []);

  const setPaperPlanes = useCallback(async (enabled: boolean) => {
    if (!window.workbench) {
      publishConfig({ ...sharedConfig, paperPlanes: enabled });
      return;
    }
    try {
      const next = await window.workbench.setHudConfig({ paperPlanes: enabled });
      configLoaded = true;
      publishConfig(next);
    } catch {
      // Keep the previous value; phase 5's settings page can surface the
      // failure if it wants to. Avoid an unhandled rejection here.
    }
  }, []);

  const setContextWindowTokens = useCallback(async (tokens: number) => {
    if (!window.workbench) {
      publishConfig({ ...sharedConfig, contextWindowTokens: tokens });
      return;
    }
    try {
      const next = await window.workbench.setHudConfig({ contextWindowTokens: tokens });
      configLoaded = true;
      publishConfig(next);
    } catch {
      // Keep the previous value; the settings page reports validation errors.
    }
  }, []);

  return { config, setPaperPlanes, setContextWindowTokens };
}

/**
 * Builds the HUD from real engine data only:
 * - agent_info for availability/model,
 * - task_list for activity, waiting and recent failures,
 * - list_messages for user-directed reports, WAITING_USER and agent-to-agent flights.
 *
 * Muse has no direct API; its activity is the aggregate of engine tasks and the
 * detail text says so explicitly.
 */
export function useHudData(
  engine: EngineStatus | null,
  paperPlanes: boolean,
): {
  slots: HudSlot[];
  flights: HudFlight[];
  markRead: (id: HudAgentId) => void;
  messagesError: string | null;
  messagesSaturated: boolean;
} {
  const agentState = useAgentInfo(30_000);
  const taskState = useTaskList(200, 4_000);
  const [messages, setMessages] = useState<EngineMessage[]>([]);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesSaturated, setMessagesSaturated] = useState(false);
  const [unread, setUnread] = useState<Record<HudAgentId, number>>({
    muse: 0,
    claude: 0,
    dsh: 0,
  });
  const [flights, setFlights] = useState<HudFlight[]>([]);
  const seenMessages = useRef<Set<string> | null>(null);
  const nextFlight = useRef(1);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (!window.workbench || inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        const result = await window.workbench.listMessages({ limit: MESSAGE_LIMIT });
        if (!alive) {
          return;
        }
        if (!result.ok) {
          setMessagesError(result.error);
          return;
        }
        setMessagesError(null);
        // list_messages returns the OLDEST `limit` rows (created_at ASC). Once
        // the total exceeds 500, newer rows never enter the window; surface
        // this deterministic degradation instead of silently freezing.
        setMessagesSaturated(result.data.messages.length >= MESSAGE_LIMIT);
        const rows = result.data.messages.slice().sort(byMessageTime).slice(-MESSAGE_TAIL);
        setMessages(rows);

        if (seenMessages.current == null) {
          // First successful poll is the baseline: history is unread=0 and
          // never replays as a paper-plane animation.
          seenMessages.current = new Set(rows.map((row) => row.message_id));
          return;
        }

        const seen = seenMessages.current;
        const fresh = rows.filter((row) => !seen.has(row.message_id));
        if (fresh.length === 0) {
          return;
        }
        for (const row of fresh) {
          seen.add(row.message_id);
        }

        const increments: Record<HudAgentId, number> = { muse: 0, claude: 0, dsh: 0 };
        for (const row of fresh) {
          if (row.from === 'user') {
            continue;
          }
          if (row.to === 'claude' || row.to === 'dsh') {
            increments[row.to] += 1;
          } else if (row.to === 'user') {
            increments.muse += 1;
          }
        }
        setUnread((current) => ({
          muse: current.muse + increments.muse,
          claude: current.claude + increments.claude,
          dsh: current.dsh + increments.dsh,
        }));

        if (paperPlanes) {
          const agentFlights: HudFlight[] = [];
          for (const row of fresh) {
            if (isExecutor(row.from) && isExecutor(row.to)) {
              agentFlights.push({
                seq: nextFlight.current++,
                messageId: row.message_id,
                from: row.from,
                to: row.to,
              });
            }
          }
          if (agentFlights.length > 0) {
            setFlights((current) => [...current.slice(-20), ...agentFlights]);
          }
        }
      } catch {
        if (alive) {
          setMessagesError('读取消息失败。');
        }
      } finally {
        inFlight.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void poll();
      }
    }, 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [paperPlanes]);

  const markRead = useCallback((id: HudAgentId) => {
    setUnread((current) => ({ ...current, [id]: 0 }));
  }, []);

  const slots = useMemo(
    () => [
      museSlot(engine, taskState.rawTasks, messages, unread.muse, 0),
      agentSlot(
        'claude',
        'Claude',
        engine,
        agentState.agents,
        !agentState.loading,
        agentState.error,
        taskState.rawTasks,
        unread.claude,
        0,
      ),
      agentSlot(
        'dsh',
        'dsh',
        engine,
        agentState.agents,
        !agentState.loading,
        agentState.error,
        taskState.rawTasks,
        unread.dsh,
        0,
      ),
    ],
    [
      engine,
      taskState.rawTasks,
      messages,
      unread,
      agentState.agents,
      agentState.loading,
      agentState.error,
    ],
  );

  return { slots, flights, markRead, messagesError, messagesSaturated };
}

export function hudElapsedLabel(ms: number | null): string {
  return ms == null ? '—' : formatDuration(ms);
}