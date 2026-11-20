import { randomUUID } from 'node:crypto';
import { deriveState } from './state.js';
import { resolveSender } from './auth.js';
import { fileRef } from './context.js';
import {
  ProtocolError, agentIdForParticipant, describeAuthor, isAgentParticipant, isKnownParticipant
} from './agents.js';

export const DEFAULT_CHAT_NAME = '新群聊';
const NAME_MAX = 200;
const CATEGORY_MAX = 40;
const SETTINGS_DESCRIPTION_MAX = 2000;
const SETTINGS_ANNOUNCEMENT_MAX = 4000;
const CHAT_STATUSES = new Set(['active', 'archived']);
const CHAT_SENDERS = new Set(['user', 'muse']);
const AGENTS = new Set(['claude', 'dsh']);

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

const TERMINAL_ORCH = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function parseJsonArray(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Phase 4 chat settings live in one JSON column. A missing or malformed value
// is an empty object so a corrupt row can never break the chat list.
export function parseChatSettings(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
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
      category: chat.category ?? null,
      visibility: chat.visibility ?? 'link',
      epoch: Number(chat.epoch ?? 0),
      settings: parseChatSettings(chat.settings),
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

  create({ name, category = null } = {}) {
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw new Error('name must be a string');
    }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length > NAME_MAX) throw new Error(`name must be at most ${NAME_MAX} characters`);
    let categoryValue = null;
    if (category !== undefined && category !== null) {
      if (typeof category !== 'string') throw new Error('category must be a string');
      categoryValue = category.trim();
      if (categoryValue.length > CATEGORY_MAX) {
        throw new Error(`category must be at most ${CATEGORY_MAX} characters`);
      }
      if (categoryValue === '') categoryValue = null;
    }
    const now = new Date().toISOString();
    const chat = this.store.insertChat({
      chat_id: randomUUID(),
      name: trimmed || DEFAULT_CHAT_NAME,
      created_at: now,
      updated_at: now,
      status: 'active',
      epoch: 0,
      category: categoryValue,
      // Public visibility is a local-only setting in Phase 2; the API always
      // creates link-visible chats.
      visibility: 'link'
    });
    // The human and the Muse coordinator belong to every chat. Executors join
    // on their first mention/dispatch (see MessageService._ensureParticipants),
    // which is also the unit of an agent token's access scope.
    this.store.upsertChatParticipant({
      chat_id: chat.chat_id, participant_id: 'user', kind: 'human', role: 'user', display_name: 'User'
    });
    this.store.upsertChatParticipant({
      chat_id: chat.chat_id, participant_id: 'muse', kind: 'orchestrator', role: 'muse', display_name: 'Muse'
    });
    // Keep the Phase 2 canonical tables consistent from the first message, not
    // only after the next restart reconciliation.
    const joinedAt = Date.parse(now);
    for (const [participantId, role] of [['user', 'owner'], ['muse', 'member']]) {
      const agentId = agentIdForParticipant(participantId);
      this.store.insertChatMember({
        chat_id: chat.chat_id, agent_id: agentId, role, joined_at: joinedAt
      });
      this.store.ensureInboxCursor({
        chatId: chat.chat_id, agentId, lastReadSeq: 0, now: joinedAt
      });
    }
    return this.describe(chat);
  }

  rename({ chat_id: chatId, name } = {}) {
    const chat = this.requireChat(chatId);
    if (typeof name !== 'string' || name.trim() === '') throw new Error('name must be a non-empty string');
    const trimmed = name.trim();
    if (trimmed.length > NAME_MAX) throw new Error(`name must be at most ${NAME_MAX} characters`);
    return this.describe(this.store.updateChat(chat.chat_id, { name: trimmed }));
  }

  // Phase 4: chat description and announcement. Either field may be omitted;
  // null clears it. Stored as one JSON object in chats.settings.
  updateSettings({ chat_id: chatId, description, announcement } = {}) {
    const chat = this.requireChat(chatId);
    if (description === undefined && announcement === undefined) {
      throw new Error('description or announcement is required');
    }
    const current = parseChatSettings(chat.settings);
    const next = { ...current };
    if (description !== undefined) {
      if (description !== null && typeof description !== 'string') {
        throw new Error('description must be a string or null');
      }
      if (typeof description === 'string' && description.length > SETTINGS_DESCRIPTION_MAX) {
        throw new Error(`description must be at most ${SETTINGS_DESCRIPTION_MAX} characters`);
      }
      next.description = description;
    }
    if (announcement !== undefined) {
      if (announcement !== null && typeof announcement !== 'string') {
        throw new Error('announcement must be a string or null');
      }
      if (typeof announcement === 'string' && announcement.length > SETTINGS_ANNOUNCEMENT_MAX) {
        throw new Error(`announcement must be at most ${SETTINGS_ANNOUNCEMENT_MAX} characters`);
      }
      next.announcement = announcement;
    }
    return this.describe(this.store.updateChat(chat.chat_id, { settings: JSON.stringify(next) }));
  }

  // Archiving only flips the list-visibility flag. Messages, files, epoch and
  // tasks stay untouched, so restoring a chat resumes exactly where it was.
  archive({ chat_id: chatId, archived = true } = {}) {
    const chat = this.requireChat(chatId);
    return this.describe(this.store.updateChat(chat.chat_id, {
      status: archived ? 'archived' : 'active'
    }));
  }

  // The latest real sub-task of this agent in this chat decides its status.
  // No sub-task means idle. A terminal status is shown for a short TTL and
  // then collapses back to idle, so a finished run does not look forever busy.
  agentStatus(chatId, agent) {
    const task = this.store.latestChatTaskForAgent(chatId, agent);
    if (!task) return { status: 'idle', state: null, task_id: null, updated_at: null };
    const state = deriveState(task);
    if (TERMINAL_ORCH.has(state)) {
      const ttl = Math.max(0, Number(this.config.chatTerminalStatusTtlMs ?? 60_000));
      const updated = Date.parse(task.updated_at || task.created_at || '');
      if (Number.isFinite(updated) && Date.now() - updated >= ttl) {
        return {
          status: 'idle',
          state: null,
          task_id: null,
          updated_at: task.updated_at,
          last_terminal_state: state
        };
      }
    }
    return {
      status: AGENT_STATUS[state] ?? 'idle',
      state,
      task_id: task.id,
      updated_at: task.updated_at
    };
  }

  // Muse is an external process, so "idle" is not evidence that it is alive.
  // Presence comes from its polling/heartbeat lease: a stale lease is offline.
  museStatus(chatId) {
    const presence = this.store.getMusePresence?.() ?? null;
    const ttl = Math.max(1000, Number(this.config.museLeaseTtlMs) || 5 * 60 * 1000);
    const lastSeen = presence ? Date.parse(presence.last_seen_at) : NaN;
    const online = Number.isFinite(lastSeen) && Date.now() - lastSeen <= ttl;
    const needsMuse = this.store.chatNeedsMuse(chatId);
    return {
      status: !online ? 'offline' : (needsMuse ? 'needs_reply' : 'online'),
      online,
      needs_reply: needsMuse,
      state: null,
      task_id: null,
      last_seen_at: presence?.last_seen_at ?? null,
      lease_expires_at: presence?.lease_expires_at ?? null,
      updated_at: this.store.lastChatMessage(chatId)?.created_at ?? null
    };
  }

  participants(chatId) {
    const deliveries = this.store.deliverySummary(chatId);
    return this.store.listChatParticipants(chatId).map((participant) => {
      const agent = participant.participant_id;
      const status = AGENTS.has(agent)
        ? this.agentStatus(chatId, agent)
        : agent === 'muse' ? this.museStatus(chatId) : { status: 'idle' };
      const agentDeliveries = deliveries[agent] ?? {};
      return {
        participant_id: agent,
        kind: participant.kind,
        role: participant.role,
        display_name: participant.display_name,
        enabled: Boolean(participant.enabled),
        auto_participate: Boolean(participant.auto_participate),
        last_read_seq: Number(participant.last_read_seq ?? 0),
        joined_at: participant.joined_at,
        status: status.status,
        state: status.state ?? null,
        current_task_id: status.task_id ?? null,
        pending_deliveries: Number(agentDeliveries.pending ?? 0) + Number(agentDeliveries.queued ?? 0)
          + Number(agentDeliveries.retry ?? 0),
        delivery_status: agentDeliveries
      };
    });
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
    const last = this.store.lastChatMessage(chat.chat_id);
    return {
      chat_id: chat.chat_id,
      name: chat.name,
      status: chat.status ?? 'active',
      epoch: Number(chat.epoch ?? 0),
      settings: parseChatSettings(chat.settings),
      context_version: Number(last?.seq ?? 0),
      paused: false,
      needs_muse: this.store.chatNeedsMuse(chat.chat_id),
      agents: {
        muse: this.museStatus(chat.chat_id),
        claude: this.agentStatus(chat.chat_id, 'claude'),
        dsh: this.agentStatus(chat.chat_id, 'dsh')
      },
      participants: this.participants(chat.chat_id),
      deliveries: this.store.deliverySummary(chat.chat_id),
      tasks,
      last_message_at: chat.last_message_at ?? null
    };
  }

  list({
    status, limit, chat_ids: chatIds, include_archived: includeArchived,
    viewer = null, agentId = null
  } = {}) {
    let filter = 'active';
    if (status === 'all') filter = null;
    else if (status !== undefined && status !== null) {
      if (!CHAT_STATUSES.has(status)) throw new Error("status must be 'active', 'archived' or 'all'");
      filter = status;
    } else if (includeArchived === true) {
      filter = null;
    }
    let chats = this.store.listChats({ status: filter, limit, chatIds });
    // When archived chats are included, active chats stay first and the
    // archived ones follow, each group preserving last-activity order.
    if (filter === null && includeArchived === true) {
      chats = [...chats].sort((a, b) => {
        const rank = (chat) => (chat.status === 'archived' ? 1 : 0);
        return rank(a) - rank(b);
      });
    }
    const viewerAgentId = agentId ?? agentIdForParticipant(viewer);
    return {
      chats: chats.map((chat) => {
        const described = this.describe(chat);
        if (!viewer) return {
          ...described,
          needs_muse: this.store.chatNeedsMuse(chat.chat_id),
          agents: {
            muse: this.museStatus(chat.chat_id).status,
            claude: this.agentStatus(chat.chat_id, 'claude').status,
            dsh: this.agentStatus(chat.chat_id, 'dsh').status
          }
        };
        // P0-6 backend: the list itself carries the unread state, so a client
        // no longer has to guess from an always-zero last_read_seq.
        const cursor = this.store.getInboxCursor(chat.chat_id, viewerAgentId);
        const legacy = this.store.getChatParticipant(chat.chat_id, viewer);
        const lastRead = cursor
          ? Number(cursor.last_read_seq) || 0
          : Number(legacy?.last_read_seq) || 0;
        const unread = legacy
          ? this.store.countUnreadMessages(chat.chat_id, viewer, lastRead)
          : 0;
        const counts = cursor
          ? this.store.recomputeInboxCounts(chat.chat_id, viewerAgentId, viewer)
          : { mentions_you: 0, replies_to_you: 0, from_owner: 0, recalled: 0 };
        return {
          ...described,
          needs_muse: this.store.chatNeedsMuse(chat.chat_id),
          agents: {
            muse: this.museStatus(chat.chat_id).status,
            claude: this.agentStatus(chat.chat_id, 'claude').status,
            dsh: this.agentStatus(chat.chat_id, 'dsh').status
          },
          unread,
          inbox: {
            last_read_seq: lastRead,
            unread,
            mentions_you: counts.mentions_you,
            replies_to_you: counts.replies_to_you,
            from_owner: counts.from_owner,
            recalled: counts.recalled
          }
        };
      })
    };
  }

  // Natural-language message stream of one chat, oldest first. body is the
  // full text; summary is the truncated preview used by the chat list.
  listMessages({ chat_id: chatId, limit, before, after_seq: afterSeq } = {}) {
    const chat = this.requireChat(chatId);
    const rows = this.store.listChatMessages({ chatId: chat.chat_id, limit, before, afterSeq });
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return {
      chat_id: chat.chat_id,
      epoch: Number(chat.epoch ?? 0),
      messages: rows.map((row) => {
        // P0-5 (contract A): attachments are objects, not bare file_id strings.
        // The frontend no longer has to guess a name/size from a UUID.
        const attached = this.store.listMessageFiles(row.id);
        const rawFiles = parseJsonArray(row.files_json);
        // Historical rows may carry file_id values in files_json without a
        // message_files row. Resolve those when the chat_files row still
        // exists; anything that is not an opaque file_id is a legacy path and
        // is returned separately, never as an attachment.
        let files = attached;
        if (files.length === 0) {
          files = rawFiles
            .filter((entry) => typeof entry === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(entry))
            .map((fileId) => this.store.getChatFile(fileId))
            .filter(Boolean);
        }
        const attachedIds = new Set(files.map((file) => file.file_id));
        const legacyPaths = rawFiles.filter(
          (entry) => typeof entry === 'string' && !attachedIds.has(entry) && !/^[A-Za-z0-9-]{8,80}$/.test(entry)
        );
        return {
          message_id: row.id,
          seq: row.seq ?? null,
          from: row.from_agent,
          to: row.to_agent,
          summary: row.summary,
          body: row.body ?? row.summary,
          kind: row.kind ?? 'user',
          mentions: parseJsonArray(row.mentions_json),
          files: files.map(fileRef),
          legacy_paths: legacyPaths,
          question: row.question ?? null,
          epoch: Number(row.epoch ?? 0),
          depth: Number(row.depth ?? 0),
          root_message_id: row.root_message_id ?? null,
          status: row.status,
          op_key: row.op_key ?? row.client_msg_id ?? null,
          recalled: row.recalled_at !== null && row.recalled_at !== undefined,
          recalled_at: row.recalled_at ?? null,
          recalled_by: row.recalled_by ?? null,
          author: describeAuthor(this.store, row.from_agent),
          auth_kind: row.auth_kind ?? null,
          principal_id: row.principal_id ?? null,
          request_id: row.request_id ?? null,
          // P1-5 execution metrics (null for human/Muse rows and old history).
          provider: row.provider ?? null,
          model: row.model ?? null,
          token_usage: (() => {
            try { return row.token_usage_json ? JSON.parse(row.token_usage_json) : null; } catch { return null; }
          })(),
          latency_ms: row.latency_ms ?? null,
          created_at: row.created_at,
          ...(row.task_id ? { task_id: row.task_id } : {})
        };
      }),
      count: rows.length,
      has_more: rows.length >= n
    };
  }

  send({
    chat_id: chatId, from, to, summary, body, files, question, task_id: taskId, reply_to: replyTo,
    mentions, act, act_recipients: actRecipients, client_msg_id: clientMsgId, op_key: opKey,
    ignore_new: ignoreNew, author, epoch, is_final: isFinal,
    request_id: requestId, auth
  } = {}) {
    const chat = this.requireChat(chatId);
    // The tool surface resolves the sender here first, so a forged `from` must
    // be audited on this path too (M1), through MessageService's single-write
    // denial helper.
    let effectiveFrom;
    try {
      effectiveFrom = resolveSender(auth, from);
    } catch (error) {
      if (/^invalid from\b/.test(error?.message ?? '')) throw error;
      throw this.messages.deny(new ProtocolError('forged_identity', 403, error.message), {
        surface: 'send_chat_message',
        from: from ?? null,
        to: to ?? null,
        chat_id: chat.chat_id ?? null,
        auth: `${auth?.token_kind ?? 'none'}:${auth?.participant ?? 'none'}`
      });
    }
    if (!CHAT_SENDERS.has(effectiveFrom) && !isAgentParticipant(effectiveFrom)) {
      throw new Error("from must be 'user', 'muse', 'claude', 'dsh' or a paired agent id");
    }
    if (!isKnownParticipant(to) && !this.store.isChatParticipant(chat.chat_id, to)) {
      throw new Error(`invalid to: ${to}`);
    }
    // Compatibility rule: a plain user request still goes to Muse. A user may
    // address an executor when they explicitly mention/act it.
    const explicitAction = Array.isArray(actRecipients) || Array.isArray(act)
      || (Array.isArray(mentions) && mentions.length > 0);
    if (effectiveFrom === 'user' && to !== 'muse' && !explicitAction) {
      throw new Error("a user message in a chat must be addressed to 'muse' unless it mentions an agent");
    }
    if (effectiveFrom === to) throw new Error('from and to must be different');

    const message = this.messages.send({
      from: effectiveFrom,
      to,
      task_id: taskId,
      reply_to: replyTo,
      summary,
      body,
      files,
      question,
      mentions,
      act_recipients: actRecipients ?? act,
      client_msg_id: clientMsgId,
      op_key: opKey,
      ignore_new: ignoreNew,
      author,
      epoch,
      is_final: isFinal,
      chat_id: chat.chat_id,
      request_id: requestId || auth?.request_id,
      auth
    });
    return {
      message_id: message.message_id,
      chat_id: chat.chat_id,
      seq: message.seq,
      epoch: message.epoch,
      created_at: message.created_at,
      to: message.to,
      kind: message.kind,
      status: message.status,
      delivery_task_id: message.delivery_task_id ?? null,
      deliveries: message.deliveries ?? [],
      deduplicated: Boolean(message.deduplicated)
    };
  }
}

