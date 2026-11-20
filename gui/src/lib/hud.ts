import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInfo,
  EngineStatus,
  EngineTaskSummary,
  HudConfig,
} from '../types';
import { chatInboxOnce, listChatsOnce } from './chat';
import {
  FLIGHT_WINDOW_MS,
  HUD_AGENT_IDS,
  HUD_COUNTER_IDS,
  flightFromEvent,
  inboxUnreadTotal,
  reconciledFloor,
  unreadBadge,
  type HudCounterExecutorId,
  type HudCounterId,
} from './hud-counters';
import { engineEvents, useAgentInfo, useTaskList } from './engine';
import { formatDuration, formatRelative, taskDisplayTitle } from './labels';

export type HudAgentId = HudCounterId;
export type HudExecutorId = HudCounterExecutorId;
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
/** Chat list poll: waiting-for-user flags and agent statuses (read-only). */
const CHAT_POLL_MS = 3_000;
/**
 * Unread counters poll. `inbox` recomputes per-chat categories server-side, so
 * it runs at the Inbox page cadence (15 s) instead of the HUD's 3 s glance tick;
 * a pushed wake event refreshes it earlier, throttled by UNREAD_PUSH_THROTTLE_MS.
 */
const UNREAD_POLL_MS = 15_000;
const UNREAD_PUSH_THROTTLE_MS = 5_000;
/** Cap on remembered message ids so an SSE replay cannot grow without bound. */
const MAX_SEEN_FLIGHTS = 500;

const STATE_TEXT: Record<HudState, string> = {
  idle: '空闲',
  working: '干活中',
  waiting: '等你输入',
  error: '出错',
};

function byCreatedAt(a: EngineTaskSummary, b: EngineTaskSummary): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
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
  waitingForUser: boolean,
  unread: number,
  queued: number,
): HudSlot {
  const active = tasks.filter((task) => ACTIVE_STATES.has(task.state)).sort(byCreatedAt);
  const waiting = waitingForUser;
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
  setPaperPlanes: (enabled: boolean) => Promise<boolean>;
  setContextWindowTokens: (tokens: number) => Promise<boolean>;
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
      return true;
    }
    try {
      const next = await window.workbench.setHudConfig({ paperPlanes: enabled });
      configLoaded = true;
      publishConfig(next);
      return true;
    } catch {
      // Keep the previous value and report the failure to the settings page.
      return false;
    }
  }, []);

  const setContextWindowTokens = useCallback(async (tokens: number) => {
    if (!window.workbench) {
      publishConfig({ ...sharedConfig, contextWindowTokens: tokens });
      return true;
    }
    try {
      const next = await window.workbench.setHudConfig({ contextWindowTokens: tokens });
      configLoaded = true;
      publishConfig(next);
      return true;
    } catch {
      // Keep the previous value and report the failure to the settings page.
      return false;
    }
  }, []);

  return { config, setPaperPlanes, setContextWindowTokens };
}

/**
 * Builds the HUD from real engine data only:
 * - agent_info for availability/model,
 * - task_list for activity, waiting and recent failures,
 * - `inbox` per-agent unread counters (read-only),
 * - the chat list for "waiting for the user",
 * - pushed `GET /events` envelopes for the agent-to-agent paper planes.
 *
 * Muse has no direct API; its activity is the aggregate of engine tasks and the
 * detail text says so explicitly.
 *
 * Phase 4 §7.3 — the 500-row saturation bug and its regression:
 *  - The old HUD derived unread / paper planes from `list_messages({limit:500})`,
 *    which returns the OLDEST 500 rows, so past 500 messages the counters froze
 *    for good.
 *  - The first fix switched to incrementally reading `list_chat_messages`, but
 *    that tool is pull-to-read: it advances the master token's read cursor, so
 *    the background poll marked every chat read and the sidebar unread badges
 *    went permanently empty (cross-review M1).
 *  - This version never advances a read cursor: unread comes from `inbox`
 *    counters (absolute, no window, history length irrelevant) and the paper
 *    planes come from pushed wake events. Only the chat the user has open is
 *    allowed to pull-to-read (that is the chat store's job, not the HUD's).
 */
export function useHudData(
  engine: EngineStatus | null,
  paperPlanes: boolean,
): {
  slots: HudSlot[];
  flights: HudFlight[];
  markRead: (id: HudAgentId) => void;
  countsError: string | null;
} {
  const agentState = useAgentInfo(30_000);
  const taskState = useTaskList(200, 4_000);
  const [waitingForUser, setWaitingForUser] = useState(false);
  /** Absolute unread per slot, straight from `inbox` (`total_unread`). */
  const [unreadAbsolute, setUnreadAbsolute] = useState<Record<HudAgentId, number>>({
    muse: 0,
    claude: 0,
    dsh: 0,
  });
  /** Engine count at the moment the user last dismissed a slot's badge. */
  const [unreadFloor, setUnreadFloor] = useState<Record<HudAgentId, number>>({
    muse: 0,
    claude: 0,
    dsh: 0,
  });
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [unreadError, setUnreadError] = useState<string | null>(null);
  const [flights, setFlights] = useState<HudFlight[]>([]);
  const alive = useRef(true);
  const nextFlight = useRef(1);
  /** Message ids already animated, so an SSE replay never duplicates a flight. */
  const seenFlights = useRef<Set<string>>(new Set());
  const lastUnreadAt = useRef(0);
  const pendingUnreadRefresh = useRef<number | null>(null);
  const unreadRef = useRef(unreadAbsolute);
  unreadRef.current = unreadAbsolute;
  const paperPlanesRef = useRef(paperPlanes);
  paperPlanesRef.current = paperPlanes;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Chat list poll: only "waiting for the user" and the agent statuses are read
   * from here. `list_chats` is a plain read — it never advances a read cursor.
   */
  const refreshChats = useCallback(async () => {
    if (!window.workbench) {
      return;
    }
    try {
      const result = await listChatsOnce();
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setChatsError(result.error);
        return;
      }
      setChatsError(null);
      setWaitingForUser(
        result.data.some((chat) => chat.needs_muse === true) ||
          result.data.some((chat) =>
            HUD_COUNTER_IDS.some((id) => chat.agents?.[id] === 'waiting'),
          ),
      );
    } catch {
      if (alive.current) {
        setChatsError('读取群聊列表失败（主进程调用异常）。');
      }
    }
  }, []);

  /**
   * Unread counters. `inbox` is the only engine read that returns message counts
   * without advancing the viewer's cursor ("Reading the inbox does not mark
   * messages read", src/tools.js). A failed agent keeps its previous number
   * instead of silently dropping to 0, and the verbatim error is surfaced.
   */
  const refreshUnread = useCallback(async () => {
    if (!window.workbench) {
      return;
    }
    try {
      const results = await Promise.all(
        HUD_COUNTER_IDS.map((id) => chatInboxOnce(HUD_AGENT_IDS[id])),
      );
      if (!alive.current) {
        return;
      }
      const next: Record<HudAgentId, number> = { ...unreadRef.current };
      let failure: string | null = null;
      HUD_COUNTER_IDS.forEach((id, index) => {
        const result = results[index];
        if (result.ok) {
          next[id] = inboxUnreadTotal(result.data);
        } else {
          failure = failure ?? result.error;
        }
      });
      lastUnreadAt.current = Date.now();
      setUnreadAbsolute(next);
      // Keep the dismissed floor honest when the engine count drops (the agent
      // read its inbox) so a later message is not swallowed by a stale floor.
      setUnreadFloor((floor) => {
        const reconciled: Record<HudAgentId, number> = { ...floor };
        for (const id of HUD_COUNTER_IDS) {
          reconciled[id] = reconciledFloor(floor[id], next[id]);
        }
        return reconciled;
      });
      setUnreadError(failure);
    } catch {
      if (alive.current) {
        setUnreadError('读取未读计数失败（主进程调用异常）。');
      }
    }
  }, []);

  useEffect(() => {
    if (!window.workbench) {
      return;
    }
    void refreshChats();
    void refreshUnread();
    const chatTimer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshChats();
      }
    }, CHAT_POLL_MS);
    const unreadTimer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshUnread();
      }
    }, UNREAD_POLL_MS);
    return () => {
      window.clearInterval(chatTimer);
      window.clearInterval(unreadTimer);
    };
  }, [refreshChats, refreshUnread]);

  // A pushed wake event means something just happened: refresh at once instead
  // of waiting for the next tick (the intervals stay as the polling fallback).
  // Paper planes are derived from the same envelopes, so they need no message
  // read at all and therefore no read cursor either.
  useEffect(() => {
    const detach = engineEvents.subscribeEvents((event) => {
      void refreshChats();
      // `inbox` recomputes server-side counters, so push-triggered refreshes are
      // throttled; a burst of events cannot turn it into a hot loop.
      const now = Date.now();
      const sinceLast = now - lastUnreadAt.current;
      if (sinceLast >= UNREAD_PUSH_THROTTLE_MS) {
        void refreshUnread();
      } else if (pendingUnreadRefresh.current == null) {
        pendingUnreadRefresh.current = window.setTimeout(() => {
          pendingUnreadRefresh.current = null;
          void refreshUnread();
        }, UNREAD_PUSH_THROTTLE_MS - sinceLast);
      }
      if (!paperPlanesRef.current) {
        return;
      }
      const hint = flightFromEvent(event, now, FLIGHT_WINDOW_MS);
      if (hint == null) {
        return;
      }
      const key = hint.messageId ?? `event:${event.id ?? event.seq}`;
      if (seenFlights.current.has(key)) {
        return;
      }
      if (seenFlights.current.size >= MAX_SEEN_FLIGHTS) {
        seenFlights.current.clear();
      }
      seenFlights.current.add(key);
      setFlights((current) => [
        ...current.slice(-20),
        { seq: nextFlight.current++, messageId: key, from: hint.from, to: hint.to },
      ]);
    });
    return () => {
      detach();
      if (pendingUnreadRefresh.current != null) {
        window.clearTimeout(pendingUnreadRefresh.current);
        pendingUnreadRefresh.current = null;
      }
    };
  }, [refreshChats, refreshUnread]);

  const markRead = useCallback((id: HudAgentId) => {
    // Glance-only dismissal. The engine read cursor is deliberately NOT advanced
    // here: a background panel marking chats read is exactly the M1 regression.
    setUnreadFloor((floor) => ({ ...floor, [id]: unreadRef.current[id] ?? 0 }));
  }, []);

  // Badge = absolute engine unread minus the local dismissed floor. Both are
  // counters, so no row window exists that a long history could saturate.
  const unread = useMemo(() => {
    const badges: Record<HudAgentId, number> = { muse: 0, claude: 0, dsh: 0 };
    for (const id of HUD_COUNTER_IDS) {
      badges[id] = unreadBadge(unreadAbsolute[id], unreadFloor[id]);
    }
    return badges;
  }, [unreadAbsolute, unreadFloor]);

  const slots = useMemo(
    () => [
      museSlot(engine, taskState.rawTasks, waitingForUser, unread.muse, 0),
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
      waitingForUser,
      unread,
      agentState.agents,
      agentState.loading,
      agentState.error,
    ],
  );

  return { slots, flights, markRead, countsError: chatsError ?? unreadError };
}

export function hudElapsedLabel(ms: number | null): string {
  return ms == null ? '—' : formatDuration(ms);
}