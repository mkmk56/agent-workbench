import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineResult, WorkbenchApi } from '../types';

/**
 * Chat hooks for the group-chat redesign.
 *
 * Every hook calls the engine chat tools through the IPC bridge Muse owns:
 * `listChats`, `listChatMessages`, `sendChatMessage`, `chatStatus`, `createChat`
 * and `renameChat`. Nothing here invents messages, agents or statuses; when the
 * bridge or the engine is unavailable the hooks surface a real error instead.
 *
 * IPC argument shape follows the existing bridge convention: objects for
 * multi-field calls, a bare id for single-id calls (`chatStatus(chatId)`),
 * camelCase at the JS boundary. Engine payload fields stay snake_case.
 */

const NO_MAIN = '主进程未连接（浏览器预览）。';
const NO_CHAT_BRIDGE = '聊天接口尚未接通（IPC 桥未就绪）。';

export type ChatSender = 'user' | 'muse' | 'claude' | 'dsh' | 'unknown';
export type ChatAgentId = 'muse' | 'claude' | 'dsh';
export type ChatStatusFilter = 'active' | 'archived';

export interface ChatAgentStatuses {
  claude?: string;
  dsh?: string;
  muse?: string;
}

export interface ChatSummary {
  chat_id: string;
  name: string;
  status: string | null;
  created_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  needs_muse: boolean;
  agents: ChatAgentStatuses;
}

export interface ChatMessage {
  message_id: string;
  from: ChatSender;
  to: ChatSender;
  summary: string;
  files: string[];
  question: string | null;
  status: string | null;
  created_at: string;
  task_id: string | null;
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

export interface SendChatInput {
  chatId: string;
  from: 'user' | 'muse';
  to: ChatSender;
  summary: string;
  files?: string[];
  question?: string;
  taskId?: string;
  replyTo?: string;
}

export interface SendChatResult {
  message_id: string;
  chat_id: string;
  created_at: string;
}

interface ChatBridge {
  listChats?: (input?: {
    status?: ChatStatusFilter;
    limit?: number;
  }) => Promise<EngineResult<unknown>>;
  createChat?: (input?: { name?: string }) => Promise<EngineResult<unknown>>;
  renameChat?: (input: { chatId: string; name: string }) => Promise<EngineResult<unknown>>;
  sendChatMessage?: (input: SendChatInput) => Promise<EngineResult<unknown>>;
  chatStatus?: (chatId: string) => Promise<EngineResult<unknown>>;
  listChatMessages?: (input: {
    chatId: string;
    limit?: number;
    before?: string;
  }) => Promise<EngineResult<unknown>>;
}

function chatBridge(): ChatBridge | null {
  if (!window.workbench) {
    return null;
  }
  return window.workbench as unknown as WorkbenchApi & ChatBridge;
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
  return {
    chat_id: chatId,
    name: readString(record, 'name') ?? '未命名群聊',
    status: readString(record, 'status'),
    created_at: readString(record, 'created_at', 'createdAt'),
    last_message_at: readString(record, 'last_message_at', 'lastMessageAt'),
    last_message_preview: readString(record, 'last_message_preview', 'lastMessagePreview'),
    needs_muse: record.needs_muse === true || record.needsMuse === true,
    agents: agentsStatuses,
  };
}

export function normalizeMessage(raw: unknown): ChatMessage | null {
  const record = asRecord(raw);
  const messageId = readString(record, 'message_id', 'messageId', 'id');
  if (messageId == null) {
    return null;
  }
  return {
    message_id: messageId,
    from: normalizeSender(record.from),
    to: normalizeSender(record.to),
    summary: typeof record.summary === 'string' ? record.summary : '',
    files: readStringArray(record.files),
    question: readString(record, 'question'),
    status: readString(record, 'status'),
    created_at: readString(record, 'created_at', 'createdAt') ?? '',
    task_id: readString(record, 'task_id', 'taskId'),
  };
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
  const state = normalizeAgentState(readString(record, 'status', 'state'));
  return {
    state,
    label: AGENT_STATE_LABELS[state],
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
  return {
    chat_id: chatId,
    needs_muse: needsMuse,
    muse: {
      state: needsMuse ? 'waiting' : 'idle',
      label: needsMuse ? '等 Muse 回复' : AGENT_STATE_LABELS.idle,
      task_id: null,
      updated_at: readString(asRecord(agents.muse), 'updated_at', 'updatedAt'),
    },
    claude: readAgentState(agents.claude),
    dsh: readAgentState(agents.dsh),
  };
}

function failureMessage(error: string | null | undefined, fallback: string): string {
  return error != null && error.trim().length > 0 ? error : fallback;
}

export async function listChatsOnce(
  status: ChatStatusFilter = 'active',
  limit = 100,
): Promise<EngineResult<ChatSummary[]>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const bridge = chatBridge();
  if (!bridge?.listChats) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await bridge.listChats({ status, limit });
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

export async function createChat(name?: string): Promise<EngineResult<ChatSummary>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const bridge = chatBridge();
  if (!bridge?.createChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await bridge.createChat(name != null && name.length > 0 ? { name } : {});
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
  const bridge = chatBridge();
  if (!bridge?.renameChat) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await bridge.renameChat({ chatId, name });
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

export async function sendChatMessage(input: SendChatInput): Promise<EngineResult<SendChatResult>> {
  if (!window.workbench) {
    return { ok: false, error: NO_MAIN };
  }
  const bridge = chatBridge();
  if (!bridge?.sendChatMessage) {
    return { ok: false, error: NO_CHAT_BRIDGE };
  }
  try {
    const result = await bridge.sendChatMessage(input);
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
      },
    };
  } catch {
    return { ok: false, error: '发送消息失败（主进程调用异常）。' };
  }
}

function emptyChat(chatId: string): ChatSummary {
  return {
    chat_id: chatId,
    name: '未命名群聊',
    status: null,
    created_at: null,
    last_message_at: null,
    last_message_preview: null,
    needs_muse: false,
    agents: {},
  };
}

/**
 * Poll the active chat list. Used by the chat page to resolve the current
 * chat's name and to refresh after a rename; the sidebar owns its own view.
 */
export function useChatList(
  pollMs = 5_000,
  status: ChatStatusFilter = 'active',
  limit = 100,
): {
  chats: ChatSummary[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await listChatsOnce(status, limit);
      if (!alive.current) {
        return;
      }
      if (result.ok) {
        setChats(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [limit, status]);

  useEffect(() => {
    alive.current = true;
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

  return { chats, error, loading, refresh };
}

/** Poll every message in one chat. Messages arrive sorted by created_at. */
export function useChatMessages(
  chatId: string | null,
  pollMs = 3_000,
  limit = 300,
): {
  messages: ChatMessage[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(chatId != null);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (chatId == null) {
      return;
    }
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    const bridge = chatBridge();
    if (!bridge?.listChatMessages) {
      if (alive.current) {
        setError(NO_CHAT_BRIDGE);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await bridge.listChatMessages({ chatId, limit });
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setError(failureMessage(result.error, '读取群聊消息失败。'));
        return;
      }
      const next = unwrapList(result.data, ['messages'])
        .map(normalizeMessage)
        .filter((message): message is ChatMessage => message != null)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      setMessages(next);
      setError(null);
    } catch {
      if (alive.current) {
        setError('读取群聊消息失败（主进程调用异常）。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [chatId, limit]);

  useEffect(() => {
    alive.current = true;
    setMessages([]);
    setError(null);
    setLoading(chatId != null);
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
  }, [chatId, pollMs, refresh]);

  return { messages, error, loading, refresh };
}

/** Poll the real agent status for one chat (no fabricated presence). */
export function useChatStatus(
  chatId: string | null,
  pollMs = 5_000,
): {
  status: ChatStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(chatId != null);
  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (chatId == null) {
      return;
    }
    if (!window.workbench) {
      if (alive.current) {
        setError(NO_MAIN);
        setLoading(false);
      }
      return;
    }
    const bridge = chatBridge();
    if (!bridge?.chatStatus) {
      if (alive.current) {
        setError(NO_CHAT_BRIDGE);
        setLoading(false);
      }
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    try {
      const result = await bridge.chatStatus(chatId);
      if (!alive.current) {
        return;
      }
      if (!result.ok) {
        setError(failureMessage(result.error, '读取 Agent 状态失败。'));
        return;
      }
      const next = normalizeChatStatus(result.data);
      if (next == null) {
        setError('引擎未返回有效的群聊状态。');
        return;
      }
      setStatus(next);
      setError(null);
    } catch {
      if (alive.current) {
        setError('读取 Agent 状态失败（主进程调用异常）。');
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setLoading(false);
      }
    }
  }, [chatId]);

  useEffect(() => {
    alive.current = true;
    setStatus(null);
    setError(null);
    setLoading(chatId != null);
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
  }, [chatId, pollMs, refresh]);

  return { status, error, loading, refresh };
}