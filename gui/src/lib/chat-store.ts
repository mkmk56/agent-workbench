import { useEffect, useSyncExternalStore } from 'react';
import type {
  ChatMessage,
  ChatParticipant,
  ChatStatusPayload,
  ChatSummary,
  SendChatMessageInput,
} from '../types';
import {
  chatParticipantsOnce,
  chatStatusOnce,
  listChatMessages,
  listChatsOnce,
  markChatRead,
  normalizeChatStatus,
  sendChatMessage,
  type ChatStatus,
  type SendChatResult,
} from './chat';

/**
 * Single chat data store.
 *
 * Replaces the three independent 3 s / 5 s pollers (`ChatSidebar`, `useChatList`
 * and `useChatMessages`) and the double chat-list fetch with one scheduler and
 * one cache:
 *
 *  - messages: incremental via the `seq` cursor (`after_seq`); 3 s cadence
 *  - status + participants: 5 s cadence
 *  - chat list: 5 s cadence
 *
 * Polling only runs while at least one component subscribes, and pauses when
 * the window is hidden. Engine calls stay in the main process (no renderer
 * fetch to 127.0.0.1).
 */

export const MESSAGE_POLL_MS = 3_000;
export const STATUS_POLL_MS = 5_000;
export const LIST_POLL_MS = 5_000;
const MESSAGE_LIMIT = 200;

interface MessagesSlice {
  messages: ChatMessage[];
  seq: number;
  loading: boolean;
  error: string | null;
}

export interface ChatStoreState {
  chats: ChatSummary[];
  chatsLoading: boolean;
  chatsError: string | null;
  activeChatId: string | null;
  messages: Record<string, MessagesSlice>;
  statuses: Record<string, ChatStatus | null>;
  statusLoading: Record<string, boolean>;
  statusErrors: Record<string, string | null>;
  participants: Record<string, ChatParticipant[]>;
}

const initialState: ChatStoreState = {
  chats: [],
  chatsLoading: true,
  chatsError: null,
  activeChatId: null,
  messages: {},
  statuses: {},
  statusLoading: {},
  statusErrors: {},
  participants: {},
};

const emptySlice: MessagesSlice = { messages: [], seq: 0, loading: true, error: null };

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) {
    return current;
  }
  const map = new Map<string, ChatMessage>();
  for (const message of current) {
    map.set(message.message_id, message);
  }
  for (const message of incoming) {
    map.set(message.message_id, message);
  }
  return [...map.values()].sort((a, b) => {
    if (a.seq !== b.seq) {
      return a.seq - b.seq;
    }
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });
}

class ChatStoreImpl {
  private state: ChatStoreState = initialState;
  private listeners = new Set<() => void>();
  private subscribers = 0;
  private messagesTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private inflight = new Set<string>();
  private activeRef: string | null = null;

  getSnapshot = (): ChatStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.subscribers += 1;
    this.ensureTimers();
    return () => {
      this.listeners.delete(listener);
      this.subscribers = Math.max(0, this.subscribers - 1);
      if (this.subscribers === 0) {
        this.stopTimers();
      }
    };
  };

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private set(patch: Partial<ChatStoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private patchSlice(chatId: string, patch: Partial<MessagesSlice>): MessagesSlice {
    const slice = this.state.messages[chatId] ?? emptySlice;
    const next = { ...slice, ...patch };
    this.set({ messages: { ...this.state.messages, [chatId]: next } });
    return next;
  }

  private ensureTimers(): void {
    if (this.messagesTimer != null) {
      return;
    }
    this.messagesTimer = setInterval(() => {
      const chatId = this.activeRef;
      if (chatId != null && !document.hidden) {
        void this.fetchMessages(chatId);
      }
    }, MESSAGE_POLL_MS);
    this.statusTimer = setInterval(() => {
      if (document.hidden) {
        return;
      }
      const chatId = this.activeRef;
      if (chatId != null) {
        void this.fetchStatus(chatId);
      }
      void this.fetchChats();
    }, STATUS_POLL_MS);
  }

  private stopTimers(): void {
    if (this.messagesTimer != null) {
      clearInterval(this.messagesTimer);
      this.messagesTimer = null;
    }
    if (this.statusTimer != null) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  setActiveChat(chatId: string | null): void {
    this.activeRef = chatId;
    if (this.state.activeChatId === chatId) {
      if (chatId != null && this.state.messages[chatId] == null) {
        void this.fetchMessages(chatId, { reset: true });
      }
      return;
    }
    this.set({ activeChatId: chatId });
    if (chatId == null) {
      return;
    }
    const known = this.state.messages[chatId];
    if (known == null || known.messages.length === 0) {
      void this.fetchMessages(chatId, { reset: true });
    }
    void this.fetchStatus(chatId);
    if (this.state.chats.length === 0) {
      void this.fetchChats();
    }
  }

  async fetchChats(): Promise<void> {
    const key = 'chats';
    if (this.inflight.has(key)) {
      return;
    }
    this.inflight.add(key);
    try {
      const result = await listChatsOnce();
      if (result.ok) {
        this.set({ chats: result.data, chatsError: null, chatsLoading: false });
      } else {
        this.set({ chatsError: result.error, chatsLoading: false });
      }
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Incremental fetch. `reset` drops the cursor and loads the first page. */
  async fetchMessages(chatId: string, options: { reset?: boolean } = {}): Promise<void> {
    const key = `messages:${chatId}`;
    if (this.inflight.has(key)) {
      return;
    }
    if (this.state.messages[chatId] == null) {
      this.patchSlice(chatId, { loading: true });
    }
    this.inflight.add(key);
    try {
      const slice = this.state.messages[chatId] ?? emptySlice;
      const afterSeq = options.reset === true ? undefined : slice.seq > 0 ? slice.seq : undefined;
      const result = await listChatMessages({
        chatId,
        limit: MESSAGE_LIMIT,
        afterSeq,
      });
      if (!result.ok) {
        this.patchSlice(chatId, { error: result.error, loading: false });
        return;
      }
      const incoming = result.data.messages;
      const current = options.reset === true ? [] : slice.messages;
      const merged = mergeMessages(current, incoming);
      const nextSeq = merged.reduce((max, message) => Math.max(max, message.seq), 0);
      this.patchSlice(chatId, { messages: merged, seq: nextSeq, loading: false, error: null });
    } catch {
      this.patchSlice(chatId, { error: '读取群聊消息失败（主进程调用异常）。', loading: false });
    } finally {
      this.inflight.delete(key);
    }
  }

  async fetchStatus(chatId: string): Promise<void> {
    const key = `status:${chatId}`;
    if (this.inflight.has(key)) {
      return;
    }
    this.inflight.add(key);
    try {
      // chat_status already carries the participant list, so the common path is
      // a single call; chat_participants is only a fallback for older engines.
      const statusResult = await chatStatusOnce(chatId);
      const patch: Partial<ChatStoreState> = {
        statusLoading: { ...this.state.statusLoading, [chatId]: false },
      };
      if (statusResult.ok) {
        patch.statuses = { ...this.state.statuses, [chatId]: statusResult.data };
        patch.statusErrors = { ...this.state.statusErrors, [chatId]: null };
        const fromStatus = statusResult.data.participants;
        if (Array.isArray(fromStatus) && fromStatus.length > 0) {
          patch.participants = { ...this.state.participants, [chatId]: fromStatus };
        } else {
          const participantsResult = await chatParticipantsOnce(chatId);
          if (participantsResult.ok) {
            patch.participants = { ...this.state.participants, [chatId]: participantsResult.data };
          }
        }
      } else {
        patch.statusErrors = { ...this.state.statusErrors, [chatId]: statusResult.error };
        const fallback = this.statusFromChats(chatId);
        if (fallback != null) {
          patch.statuses = { ...this.state.statuses, [chatId]: fallback };
          if (fallback.participants.length > 0) {
            patch.participants = { ...this.state.participants, [chatId]: fallback.participants };
          }
        }
      }
      this.set(patch);
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Use the chat list's agent columns when chat_status is unavailable. */
  private statusFromChats(chatId: string): ChatStatus | null {
    const chat = this.state.chats.find((item) => item.chat_id === chatId);
    if (chat == null) {
      return null;
    }
    const payload: ChatStatusPayload = {
      chat_id: chatId,
      needs_muse: chat.needs_muse,
      agents: chat.agents,
      participants: chat.participants,
    };
    return normalizeChatStatus(payload);
  }

  /** Send with files/mentions/replyTo/clientMsgId, then pull the real rows. */
  async send(chatId: string, input: SendChatMessageInput): Promise<
    { ok: true; data: SendChatResult } | { ok: false; error: string }
  > {
    const result = await sendChatMessage({ ...input, chatId });
    if (!result.ok) {
      return result;
    }
    await Promise.all([this.fetchMessages(chatId), this.fetchStatus(chatId), this.fetchChats()]);
    return result;
  }

  async markRead(chatId: string, upToSeq?: number): Promise<void> {
    const result = await markChatRead({ chatId, upToSeq });
    if (!result.ok) {
      return;
    }
    this.set({
      chats: this.state.chats.map((chat) =>
        chat.chat_id === chatId ? { ...chat, unread: result.data.unread } : chat,
      ),
    });
  }

  /** Force an immediate refresh of everything relevant to the active chat. */
  async refreshActive(): Promise<void> {
    const chatId = this.activeRef;
    const jobs: Array<Promise<void>> = [this.fetchChats()];
    if (chatId != null) {
      jobs.push(this.fetchMessages(chatId), this.fetchStatus(chatId));
    }
    await Promise.all(jobs);
  }
}

export const chatStore = new ChatStoreImpl();

export interface ChatStoreApi {
  state: ChatStoreState;
  setActiveChat: (chatId: string | null) => void;
  fetchChats: () => Promise<void>;
  fetchMessages: (chatId: string, options?: { reset?: boolean }) => Promise<void>;
  fetchStatus: (chatId: string) => Promise<void>;
  send: ChatStoreImpl['send'];
  markRead: (chatId: string, upToSeq?: number) => Promise<void>;
  refreshActive: () => Promise<void>;
}

const api: ChatStoreApi = {
  get state() {
    return chatStore.getSnapshot();
  },
  setActiveChat: (chatId) => chatStore.setActiveChat(chatId),
  fetchChats: () => chatStore.fetchChats(),
  fetchMessages: (chatId, options) => chatStore.fetchMessages(chatId, options),
  fetchStatus: (chatId) => chatStore.fetchStatus(chatId),
  send: (chatId, input) => chatStore.send(chatId, input),
  markRead: (chatId, upToSeq) => chatStore.markRead(chatId, upToSeq),
  refreshActive: () => chatStore.refreshActive(),
};

/** Subscribe to the whole store (used by the chat list). */
export function useChatStore(): ChatStoreApi {
  useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot);
  return api;
}

export function useChatListView(): {
  chats: ChatSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { state, fetchChats } = useChatStore();
  return {
    chats: state.chats,
    loading: state.chatsLoading,
    error: state.chatsError,
    refresh: fetchChats,
  };
}

export function useChatMessagesView(chatId: string | null): {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { state, fetchMessages } = useChatStore();
  if (chatId == null) {
    return { messages: [], loading: false, error: null, refresh: async () => undefined };
  }
  const slice = state.messages[chatId];
  return {
    messages: slice?.messages ?? [],
    loading: slice?.loading ?? true,
    error: slice?.error ?? null,
    refresh: () => fetchMessages(chatId),
  };
}

export function useChatStatusView(chatId: string | null): {
  status: ChatStatus | null;
  participants: ChatParticipant[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { state, fetchStatus } = useChatStore();
  if (chatId == null) {
    return {
      status: null,
      participants: [],
      loading: false,
      error: null,
      refresh: async () => undefined,
    };
  }
  return {
    status: state.statuses[chatId] ?? null,
    participants: state.participants[chatId] ?? [],
    loading: state.statusLoading[chatId] ?? true,
    error: state.statusErrors[chatId] ?? null,
    refresh: () => fetchStatus(chatId),
  };
}

/**
 * Mark the newest message read once it is rendered. Chat-level "read" is a
 * server-side concept, so this only fires when the seq actually advances.
 */
export function useMarkChatRead(chatId: string | null, newestSeq: number): void {
  const { markRead } = useChatStore();
  useEffect(() => {
    if (chatId == null || newestSeq <= 0) {
      return;
    }
    void markRead(chatId, newestSeq);
  }, [chatId, newestSeq, markRead]);
}
