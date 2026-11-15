import { randomUUID } from 'node:crypto';
import { deriveState } from './state.js';

export const DEFAULT_CHAT_NAME = '新群聊';
const NAME_MAX = 200;
const CHAT_STATUSES = new Set(['active', 'archived']);
const CHAT_SENDERS = new Set(['user', 'muse']);
const CHAT_RECIPIENTS = new Set(['muse', 'user', 'claude', 'dsh']);

// Real task states mapped to the status words a chat participant shows. The
// raw engine state is kept next to it so a client never has to guess.
const AGENT_STATUS = {
  PENDING: 'pending',
  STARTING: 'pending',
  WORKING: 'working',
  WAITING: 'waiting',
  BLOCKED: 'blocked',
  STALE: 'blocked',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

function parseFiles(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export class ChatService {
  constructor({ store, messages, config }) {
    this.store = store;
    this.messages = messages;
    this.config = config;
  }

  describe(chat) {
    if (!chat) return null;
    return {
      chat_id: chat.chat_id,
      name: chat.name,
      status: chat.status ?? 'active',
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      last_message_at: chat.last_message_at ?? null,
      last_message_preview: chat.last_message_preview ?? null
    };
  }

  requireChat(chatId) {
    if (typeof chatId !== 'string' || chatId === '') throw new Error('chat_id is required');
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error(`chat not found: ${chatId}`);
    return chat;
  }

  create({ name } = {}) {
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw new Error('name must be a string');
    }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length > NAME_MAX) throw new Error(`name must be at most ${NAME_MAX} characters`);
    const now = new Date().toISOString();
    const chat = this.store.insertChat({
      chat_id: randomUUID(),
      name: trimmed || DEFAULT_CHAT_NAME,
      created_at: now,
      updated_at: now,
      status: 'active'
    });
    return this.describe(chat);
  }

  rename({ chat_id: chatId, name } = {}) {
    const chat = this.requireChat(chatId);
    if (typeof name !== 'string' || name.trim() === '') throw new Error('name must be a non-empty string');
    const trimmed = name.trim();
    if (trimmed.length > NAME_MAX) throw new Error(`name must be at most ${NAME_MAX} characters`);
    // Renaming does not invent activity: updated_at changes, last_message_at
    // stays tied to the real last message.
    return this.describe(this.store.updateChat(chat.chat_id, { name: trimmed }));
  }

  // The latest real sub-task of this agent in this chat decides its status.
  // No sub-task means idle; nothing is stored as a snapshot.
  agentStatus(chatId, agent) {
    const task = this.store.latestChatTaskForAgent(chatId, agent);
    if (!task) return { status: 'idle', state: null, task_id: null, updated_at: null };
    const state = deriveState(task);
    return {
      status: AGENT_STATUS[state] ?? 'idle',
      state,
      task_id: task.id,
      updated_at: task.updated_at
    };
  }

  museStatus(chatId) {
    const needsMuse = this.store.chatNeedsMuse(chatId);
    // "needs a reply" is a real flag derived from message rows, never a fake
    // typing indicator.
    return {
      status: needsMuse ? 'needs_reply' : 'idle',
      state: null,
      task_id: null,
      updated_at: this.store.lastChatMessage(chatId)?.created_at ?? null
    };
  }

  status(chatId) {
    const chat = this.requireChat(chatId);
    const tasks = this.store.listChatTasks(chat.chat_id).map((task) => {
      const state = deriveState(task);
      return {
        task_id: task.id,
        agent: task.agent,
        state,
        status: AGENT_STATUS[state] ?? 'idle',
        thread_id: this.store.getThreadId(task.id),
        created_at: task.created_at,
        updated_at: task.updated_at,
        summary: task.summary ?? null
      };
    });
    return {
      chat_id: chat.chat_id,
      name: chat.name,
      status: chat.status ?? 'active',
      needs_muse: this.store.chatNeedsMuse(chat.chat_id),
      agents: {
        muse: this.museStatus(chat.chat_id),
        claude: this.agentStatus(chat.chat_id, 'claude'),
        dsh: this.agentStatus(chat.chat_id, 'dsh')
      },
      tasks,
      last_message_at: chat.last_message_at ?? null
    };
  }

  list({ status, limit } = {}) {
    // Omitted status means the active list the shell shows; 'all' is an
    // explicit escape hatch for debugging archived chats too.
    let filter = 'active';
    if (status === 'all') filter = null;
    else if (status !== undefined && status !== null) {
      if (!CHAT_STATUSES.has(status)) throw new Error("status must be 'active', 'archived' or 'all'");
      filter = status;
    }
    const chats = this.store.listChats({ status: filter, limit });
    return {
      chats: chats.map((chat) => ({
        ...this.describe(chat),
        needs_muse: this.store.chatNeedsMuse(chat.chat_id),
        agents: {
          claude: this.agentStatus(chat.chat_id, 'claude').status,
          dsh: this.agentStatus(chat.chat_id, 'dsh').status
        }
      }))
    };
  }

  // Natural-language message stream of one chat, oldest first. No thread state,
  // no logs, no delivery internals.
  listMessages({ chat_id: chatId, limit, before } = {}) {
    const chat = this.requireChat(chatId);
    const rows = this.store.listChatMessages({ chatId: chat.chat_id, limit, before });
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return {
      chat_id: chat.chat_id,
      messages: rows.map((row) => ({
        message_id: row.id,
        from: row.from_agent,
        to: row.to_agent,
        summary: row.summary,
        files: parseFiles(row.files_json),
        question: row.question ?? null,
        status: row.status,
        created_at: row.created_at,
        ...(row.task_id ? { task_id: row.task_id } : {})
      })),
      count: rows.length,
      has_more: rows.length >= n
    };
  }

  send({ chat_id: chatId, from, to, summary, files, question, task_id: taskId, reply_to: replyTo } = {}) {
    const chat = this.requireChat(chatId);
    if (!CHAT_SENDERS.has(from)) throw new Error("from must be 'user' or 'muse'");
    if (!CHAT_RECIPIENTS.has(to)) throw new Error(`invalid to: ${to}`);
    if (from === 'user' && to !== 'muse') {
      throw new Error("a user message in a chat must be addressed to 'muse'");
    }
    if (from === to) throw new Error('from and to must be different');

    const message = this.messages.send({
      from,
      to,
      task_id: taskId,
      reply_to: replyTo,
      summary,
      files,
      question,
      chat_id: chat.chat_id
    });
    // Muse -> agent is delivered by starting a sub-task; the message row and
    // the chat link are the real record of that assignment.
    return {
      message_id: message.message_id,
      chat_id: chat.chat_id,
      created_at: message.created_at,
      to: message.to,
      status: message.status,
      delivery_task_id: message.delivery_task_id ?? null
    };
  }
}
