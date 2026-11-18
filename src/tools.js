import * as z from 'zod/v4';
import { buildChatContext } from './context.js';
import {
  accessibleChatIds, agentScope, assertChatAccess, assertTaskAccess, isMaster, isReadAll,
  requireMaster, requireOperator
} from './auth.js';
import {
  AgentService, agentIdForParticipant, participantForAgentId
} from './agents.js';
import { auditEvent } from './audit.js';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

const asError = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true
});

// Protocol errors carry an HTTP-style status and a machine code (409
// new_messages, 403 recall_window_expired, ...). MCP has no per-tool status
// field, so the structured body is returned as the error content.
const asProtocolError = (error) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: error.code,
      status: error.status,
      message: error.message,
      ...(error.details ?? {})
    })
  }],
  isError: true
});

const serviceError = (error) => (
  error && error.code && error.status ? asProtocolError(error) : asError(error.message)
);

function truncate(value, max = 300) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

// Tool-call audit line: tool name, argument summary, outcome and duration.
// Secrets and base64 payloads are never written verbatim.
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '-';
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (/token|secret|password|authorization/i.test(key)) {
      out[key] = '<redacted>';
    } else if (key === 'data') {
      out[key] = `<base64 ${String(value ?? '').length} chars>`;
    } else if (typeof value === 'string') {
      out[key] = truncate(value, 120);
    } else {
      out[key] = value;
    }
  }
  return truncate(JSON.stringify(out), 400);
}

function summarizeResult(result) {
  if (!result) return 'none';
  if (result.isError) return 'error';
  const text = Array.isArray(result.content)
    ? result.content.map((entry) => entry?.text ?? '').filter(Boolean).join(' ')
    : '';
  return text ? truncate(text.replace(/\s+/g, ' '), 160) : 'ok';
}

export function registerTools(server, { scheduler, store, messages, approvals, chats, files, config, agents = null }, auth = { master: true, participant: 'user', token_kind: 'master' }) {
  const master = isMaster(auth);
  const readAll = isReadAll(auth);
  const requestId = auth?.request_id || '-';
  // Phase 2 tools need the agent service; constructing a lightweight one from
  // the store keeps older test harnesses working without new wiring.
  const agentService = agents ?? new AgentService({ store, config });

  const auditDenied = (fields) => {
    auditEvent(config?.dataDir ?? store?.dataDir, 'access_denied', {
      auth: `${auth?.token_kind ?? 'none'}:${auth?.participant ?? 'none'}`,
      request_id: requestId,
      ...fields
    });
  };

  // Chat CRUD is a human/Muse collaboration action, not an executor action.
  const requireChatAdmin = (action) => {
    if (!master && auth?.role !== 'human') {
      auditDenied({
        surface: `tool:${action}`,
        code: 'not_admin',
        status: 403,
        detail: `${action} requires a human or master token`
      });
      throw new Error(`${action} requires a human or master token`);
    }
  };

  const register = (name, meta, handler) => {
    server.registerTool(name, meta, async (args, extra) => {
      const started = Date.now();
      // Muse polling is its heartbeat. Writes are deliberately excluded so a
      // send cannot renew its own lease.
      if (auth?.token_kind === 'muse' && name !== 'send_chat_message' && name !== 'send_message') {
        try {
          store.touchMusePresence({ ttlMs: config.museLeaseTtlMs, source: `tool:${name}` });
        } catch {
          // Presence is best effort; never fail a read because of it.
        }
      }
      let result;
      try {
        result = await handler(args, extra);
      } catch (error) {
        // 403-class denials are part of the connection audit trail. Services
        // mark errors they already recorded so each rejection is written once.
        if (error?.status === 403 && !error.audited) {
          auditDenied({
            surface: `tool:${name}`,
            code: error.code ?? 'error',
            status: 403,
            detail: error.message
          });
          if (typeof error === 'object') error.audited = true;
        }
        console.log(`tool=${name} request_id=${requestId} auth=${auth?.token_kind ?? 'none'}:${auth?.participant ?? 'none'}`
          + ` duration_ms=${Date.now() - started} result=error params=${summarizeArgs(args)} error=${truncate(error.message, 160)}`);
        throw error;
      }
      // Pairing responses contain a one-time secret (the code or the token).
      // Never echo them into the audit log, even truncated.
      const resultSummary = (name === 'agent_pair' || name === 'agent_pairing_code')
        ? 'credential issued (redacted)'
        : summarizeResult(result);
      console.log(`tool=${name} request_id=${requestId} auth=${auth?.token_kind ?? 'none'}:${auth?.participant ?? 'none'}`
        + ` duration_ms=${Date.now() - started} result=${resultSummary}`
        + ` params=${summarizeArgs(
          name === 'agent_pair' && args && typeof args === 'object'
            ? { ...args, code: '<redacted>' }
            : args
        )}`);
      return result;
    });
  };

  register('agent_info', {
    description: 'List available executors (claude, dsh) with version, capabilities and resume support.'
  }, async () => asText(scheduler.agentInfo()));

  register('task_start', {
    description: 'Start a task on a local executor. Returns immediately with task_id and session_id. '
      + 'Operator token only (legacy master, or a human token with WORKBENCH_HUMAN_OPERATE=1).',
    inputSchema: {
      agent: z.enum(['claude', 'dsh']).describe('Executor to use'),
      prompt: z.string().min(1).describe('Task text'),
      cwd: z.string().optional().describe('Working directory; defaults to the workbench directory'),
      session_id: z.string().optional().describe('Existing session to continue; omit to start a new one'),
      model: z.string().optional().describe('Optional model passed to the executor'),
      max_turns: z.number().int().min(1).optional().describe('Accepted for compatibility; not enforced'),
      timeout_ms: z.number().int().min(1000).optional().describe('Optional per-task timeout')
    }
  }, async ({ agent, prompt, cwd, session_id, model, max_turns, timeout_ms }) => {
    void max_turns;
    try {
      requireOperator(auth, 'task_start');
      const result = scheduler.createTask({
        agent, prompt, cwd, sessionId: session_id, model, timeoutMs: timeout_ms
      });
      return asText(result);
    } catch (error) {
      return asError(error.message);
    }
  });

  register('task_send', {
    description: 'Send a follow-up message to an existing task or session. Operator token only.',
    inputSchema: {
      task_id: z.string().optional().describe('Task whose session should receive the message'),
      session_id: z.string().optional().describe('Session to continue, when task_id is omitted'),
      prompt: z.string().min(1).describe('Follow-up text')
    }
  }, async ({ task_id, session_id, prompt }) => {
    try {
      requireOperator(auth, 'task_send');
      let sessionId = session_id;
      let agent;
      if (task_id) {
        const task = store.getTask(task_id);
        if (!task) return asError('task not found');
        sessionId = task.session_id;
        agent = task.agent;
      } else if (sessionId) {
        const session = store.getSession(sessionId);
        if (!session) return asError('session not found');
        agent = session.agent;
      } else {
        return asError('task_id or session_id is required');
      }
      const result = scheduler.createTask({ agent, prompt, sessionId });
      return asText(result);
    } catch (error) {
      return asError(error.message);
    }
  });

  register('task_status', {
    description: 'Get the current status of a task. Agent tokens may only read their own tasks.',
    inputSchema: {
      task_id: z.string().describe('Task id')
    }
  }, async ({ task_id }) => {
    try {
      const task = assertTaskAccess(store, auth, task_id);
      return asText(scheduler.statusPayload(task));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('task_logs', {
    description: 'Read incremental log entries for a task. Agent tokens are scoped to their own tasks.',
    inputSchema: {
      task_id: z.string().describe('Task id'),
      cursor: z.number().int().min(0).optional().describe('Previous next_cursor; omit to read from the start'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum entries to return')
    }
  }, async ({ task_id, cursor, limit }) => {
    try {
      assertTaskAccess(store, auth, task_id);
      const entries = store.getLogs(task_id, cursor ?? 0, limit ?? 200);
      const nextCursor = entries.length > 0 ? entries[entries.length - 1].seq : (cursor ?? 0);
      return asText({
        task_id,
        entries,
        next_cursor: nextCursor,
        truncated: entries.length >= (limit ?? 200)
      });
    } catch (error) {
      return asError(error.message);
    }
  });

  register('task_cancel', {
    description: 'Cancel a running or queued task and clean up its process tree. Agent tokens may only cancel their own tasks.',
    inputSchema: {
      task_id: z.string().describe('Task id')
    }
  }, async ({ task_id }) => {
    try {
      assertTaskAccess(store, auth, task_id);
      return asText(scheduler.cancel(task_id));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('task_list', {
    description: 'List recent tasks, newest first. Agent tokens only see their own tasks.',
    inputSchema: {
      status: z.string().optional().describe('Optional state filter (COMPLETED, FAILED, CANCELLED, ...)'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async ({ status, limit }) => {
    const tasks = store.listTasks({ status, limit, agent: agentScope(auth) }).map((task) => ({
      task_id: task.id,
      session_id: task.session_id,
      agent: task.agent,
      state: scheduler.statusPayload(task).state,
      created_at: task.created_at,
      updated_at: task.updated_at,
      summary: task.summary
    }));
    return asText({ tasks });
  });

  register('send_message', {
    description: 'Send a conclusion-only message from one local agent to the other. The server derives the sender '
      + 'from the bearer token: human/master may post only as user; the muse token only as muse (client_msg_id '
      + 'required); an executor token can only speak as itself and must pass its own task_id. The summary '
      + 'is a preview (token-capped); body carries the full text. In a chat, files must be file_id references. '
      + 'When the target agent is idle the message is delivered by starting a task; otherwise it is queued. Each '
      + 'sub-task thread still stops after 10 agent-to-agent messages.',
    inputSchema: {
      from: z.string().min(1).describe('Sender; must match the token identity (user/muse/claude/dsh/agent_*)'),
      to: z.string().min(1).describe('Recipient participant, user for a final report, or muse'),
      task_id: z.string().min(1).optional()
        .describe('Task sending the message; required for claude/dsh. {{task_id}} is rendered into agent prompts'),
      chat_id: z.string().optional().describe('Group chat this message belongs to'),
      reply_to: z.string().optional().describe('message_id this message answers'),
      summary: z.string().min(1).optional().describe('Short preview for the chat list; body carries the full text'),
      body: z.string().optional().describe('Full message text; defaults to summary'),
      files: z.array(z.string()).max(100).optional()
        .describe('In a chat: file_id values only (bare paths are rejected). Outside a chat: legacy path notes'),
      question: z.string().optional().describe('Question the recipient must answer'),
      deliver: z.boolean().optional().describe('Auto-start a task for the recipient; default true'),
      is_final: z.boolean().optional().describe('Marks that no further agent turn is expected'),
      client_msg_id: z.string().max(200).optional().describe('Idempotency key (legacy name)'),
      op_key: z.string().max(200).optional().describe('Idempotency key; same as client_msg_id'),
      ignore_new: z.boolean().optional().describe('Owner only: send despite unread messages'),
      author: z.object({
        id: z.string().optional(), human: z.boolean().optional(), kind: z.string().optional()
      }).passthrough().optional().describe('Echo of the server-derived author; a mismatch is rejected')
    }
  }, async ({
    from, to, task_id, chat_id, reply_to, summary, body, files, question, deliver, is_final,
    client_msg_id, op_key, ignore_new, author
  }) => {
    try {
      return asText(messages.send({
        from, to, task_id, chat_id, reply_to, summary, body, files, question, deliver, is_final,
        client_msg_id, op_key, ignore_new, author,
        request_id: auth?.request_id,
        auth
      }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('list_messages', {
    description: 'List persisted agent-to-agent messages and thread state. Filter by thread_id, task_id, chat_id, '
      + 'from, to, reply_to or status. Agent tokens are limited to chats they participate in and their own tasks.',
    inputSchema: {
      thread_id: z.string().optional().describe('Conversation thread id'),
      task_id: z.string().optional().describe('Task id; alone, lists that task\'s whole thread'),
      chat_id: z.string().optional().describe('Group chat id'),
      from: z.string().optional(),
      to: z.string().optional(),
      reply_to: z.string().optional().describe('Only messages replying to this message_id'),
      status: z.string().optional().describe('queued|delivered|answered|held|stored|failed'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async (filters) => {
    try {
      if (!readAll) {
        if (filters.chat_id) assertChatAccess(store, auth, filters.chat_id);
        if (filters.task_id) assertTaskAccess(store, auth, filters.task_id);
        if (filters.thread_id && !filters.chat_id && !filters.task_id) {
          // A raw thread_id must not become a cross-agent read primitive.
          const chatId = filters.thread_id.startsWith('chat:') ? filters.thread_id.slice(5) : null;
          const viaChat = chatId && store.isChatParticipant(chatId, auth.participant);
          const viaTask = store.listTaskIdsForThread(filters.thread_id)
            .some((id) => store.getTask(id)?.agent === auth.participant);
          if (!viaChat && !viaTask) {
            throw new Error(`agent '${auth.participant}' cannot access thread ${filters.thread_id}`);
          }
        }
        if (!filters.chat_id && !filters.task_id && !filters.thread_id) {
          filters = { ...filters, chat_ids: accessibleChatIds(store, auth) };
        }
      }
      return asText(messages.list(filters));
    } catch (error) {
      return asError(error.message);
    }
  });

  // ------------------------------------------------------------------ chats
  register('create_chat', {
    description: 'Create a group chat. Human or master token only. Returns the new chat with epoch 0.',
    inputSchema: {
      name: z.string().max(200).optional().describe('Chat name; defaults to 新群聊'),
      category: z.string().max(40).optional()
        .describe('Optional category label. visibility is always link; public is local-only and not exposed here.')
    }
  }, async ({ name, category }) => {
    try {
      requireChatAdmin('create_chat');
      const chat = chats.create({ name, category });
      return asText({
        chat_id: chat.chat_id,
        name: chat.name,
        category: chat.category ?? null,
        visibility: chat.visibility ?? 'link',
        epoch: chat.epoch,
        created_at: chat.created_at
      });
    } catch (error) {
      return asError(error.message);
    }
  });

  register('list_chats', {
    description: 'List group chats. The master token sees every chat; an executor token sees only chats it has '
      + 'joined (mentioned or dispatched). needs_muse and agent statuses are derived from real rows.',
    inputSchema: {
      status: z.enum(['active', 'archived', 'all']).optional().describe('Explicit status filter (legacy)'),
      include_archived: z.boolean().optional()
        .describe('true: active + archived (active first); default false: active only'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, async ({ status, include_archived, limit }) => {
    try {
      const chatIds = accessibleChatIds(store, auth);
      return asText(chats.list({
        status, include_archived, limit, chat_ids: chatIds,
        viewer: auth?.participant ?? null,
        agentId: agentIdForParticipant(auth?.participant ?? null)
      }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('rename_chat', {
    description: 'Rename a group chat and return the updated chat. Human or master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      name: z.string().min(1).max(200).describe('New chat name')
    }
  }, async ({ chat_id, name }) => {
    try {
      requireChatAdmin('rename_chat');
      return asText(chats.rename({ chat_id, name }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('chat_archive', {
    description: 'Archive a group chat. Messages and files are kept; the chat is only hidden from the default '
      + 'list_chats result. Restore it with chat_unarchive. Human or master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      requireChatAdmin('chat_archive');
      return asText(chats.archive({ chat_id, archived: true }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('chat_unarchive', {
    description: 'Restore an archived group chat to active status. Human or master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      requireChatAdmin('chat_unarchive');
      return asText(chats.archive({ chat_id, archived: false }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('send_chat_message', {
    description: 'Post a message into a group chat. Every message is visible to all participants; only '
      + 'act_recipients start sub-tasks. The sender is derived from the bearer token: human/master may post only '
      + 'as user; the muse token only as muse (and must send client_msg_id); an executor may only post as itself '
      + 'with its own task_id. Only the muse token may set act_recipients. A user message increments the chat '
      + 'epoch; a dispatch carrying a stale epoch is rejected. files must be file_id values. '
      + 'A 409 new_messages error means the recipient has unread messages: pull them with list_chat_messages '
      + 'or chat_get_context first, then retry the send (only the chat owner may pass ignore_new).',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      from: z.string().min(1).describe('Sender; must match the token identity (user/muse/claude/dsh/agent_*)'),
      to: z.string().min(1).describe('Primary visible recipient (a chat member)'),
      summary: z.string().min(1).optional().describe('Short preview for the chat list; body carries the full text'),
      body: z.string().optional().describe('Full message text; defaults to summary'),
      files: z.array(z.string()).max(50).optional().describe('file_id values belonging to this chat'),
      mentions: z.array(z.string()).max(50).optional()
        .describe('Participants mentioned (@); increments their mentions_you count'),
      act_recipients: z.array(z.enum(['claude', 'dsh'])).max(2).optional()
        .describe('Executors to start sub-tasks for; omitted means no action (legacy Muse->agent still dispatches)'),
      question: z.string().optional().describe('Question the recipient must answer'),
      task_id: z.string().optional().describe('Owned task id; required when from is claude or dsh'),
      reply_to: z.string().optional().describe('message_id this message answers'),
      client_msg_id: z.string().max(200).optional().describe('Idempotency key per chat (legacy name)'),
      op_key: z.string().max(200).optional().describe('Idempotency key; same value as client_msg_id'),
      ignore_new: z.boolean().optional().describe('Owner only: send despite unread messages'),
      epoch: z.number().int().min(0).optional().describe('Epoch the dispatch was prepared against'),
      is_final: z.boolean().optional().describe('Marks that no further agent turn is expected'),
      author: z.object({
        id: z.string().optional(), human: z.boolean().optional(), kind: z.string().optional()
      }).passthrough().optional().describe('Echo of the server-derived author; a mismatch is rejected')
    }
  }, async (args) => {
    try {
      return asText(chats.send({ ...args, request_id: auth?.request_id, auth }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_status', {
    description: 'Live status of a group chat: epoch, needs_muse, participants with read/delivery state, '
      + 'per-participant status and the chat\'s sub-tasks. Terminal agent status collapses to idle after the '
      + 'configured TTL.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      return asText(chats.status(chat_id));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('list_chat_messages', {
    description: 'List one group chat\'s message stream, oldest first. Returns full body plus the summary preview, '
      + 'seq, epoch, mentions and file_id attachments. `before` pages backwards by message id; `after_seq` polls '
      + 'incrementally. Agent tokens may only read chats they participate in.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size; default 50'),
      before: z.string().optional().describe('message_id or ISO timestamp to page backwards from'),
      after_seq: z.number().int().min(0).optional().describe('Return messages with seq greater than this')
    }
  }, async ({ chat_id, limit, before, after_seq }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      const page = chats.listMessages({ chat_id, limit, before, after_seq });
      // Pull-to-read: the authenticated viewer's cursor advances to the newest
      // seq in the page. markRead only moves forward, so paging older history
      // never rewinds it. Best effort: a read must still return its page.
      if (auth?.participant && store.getChatParticipant(chat_id, auth.participant)) {
        const newest = page.messages.reduce(
          (max, message) => Math.max(max, Number(message.seq) || 0), 0);
        if (newest > 0) {
          try {
            agentService.markRead({
              chatId: chat_id,
              agentId: agentIdForParticipant(auth.participant),
              upToSeq: newest
            });
          } catch { /* read-state maintenance never fails the page */ }
        }
      }
      return asText(page);
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_mark_read', {
    description: 'Advance one participant\'s read cursor in a group chat. Marks up to up_to_seq, the seq of '
      + 'message_id, or the chat\'s latest seq when neither is given. Master tokens may target any participant; '
      + 'agent tokens may only mark themselves. Returns the stored last_read_seq and the remaining unread count.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      participant_id: z.string().min(1).optional()
        .describe('Participant whose cursor advances; defaults to the token identity'),
      up_to_seq: z.number().int().min(0).optional().describe('Mark messages with seq <= this value as read'),
      message_id: z.string().min(1).optional().describe('Mark up to this message\'s seq instead of up_to_seq')
    }
  }, async ({ chat_id, participant_id, up_to_seq, message_id }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      // Accept both the canonical agent id (agent_claude) and the participant
      // handle (claude) for built-ins.
      const requested = participant_id ?? auth.participant;
      const participant = participantForAgentId(agentIdForParticipant(requested));
      if (!participant) {
        throw new Error('unauthenticated');
      }
      if (!master && participant !== auth.participant) {
        throw new Error(`agent '${auth.participant}' can only mark its own read state`);
      }
      if (!store.getChatParticipant(chat_id, participant)) {
        throw new Error(`participant '${participant}' is not in chat ${chat_id}`);
      }

      let targetSeq = up_to_seq;
      if (message_id != null) {
        const message = store.getMessage(message_id);
        if (!message || message.chat_id !== chat_id) {
          throw new Error(`message not found in chat ${chat_id}: ${message_id}`);
        }
        targetSeq = Number(message.seq) || 0;
      } else if (targetSeq == null) {
        targetSeq = Number(store.lastChatMessage(chat_id)?.seq) || 0;
      }

      // Phase 2: the legacy participant cursor and the inbox_cursors row move
      // together, and the per-category counters are recomputed from the
      // message stream (P0-6 backend half).
      const counts = agentService.markRead({
        chatId: chat_id,
        agentId: agentIdForParticipant(participant),
        upToSeq: targetSeq
      });
      // `unread` keeps its pre-Phase-2 meaning for this tool: every message
      // after the cursor, including the caller's own. The per-category inbox
      // counters below are the protocol view and exclude the caller's own
      // messages.
      const unread = store.listChatMessages({
        chatId: chat_id, afterSeq: counts.last_read_seq, limit: 500
      }).length;
      return asText({
        ok: true,
        chat_id,
        participant_id: participant,
        last_read_seq: counts.last_read_seq,
        unread,
        mentions_you: counts.mentions_you,
        replies_to_you: counts.replies_to_you,
        from_owner: counts.from_owner,
        recalled: counts.recalled
      });
    } catch (error) {
      return serviceError(error);
    }
  });

  // -------------------------------------------------------------- muse presence
  register('muse_heartbeat', {
    description: 'Refresh the Muse presence lease. Muse token only. Any authenticated Muse request '
      + '(list_chats, chat_status, …) also refreshes the lease; a stale lease makes chat_status report Muse offline.'
  }, async ({ source, ttl_ms }) => {
    try {
      if (auth?.token_kind !== 'muse') throw new Error('muse_heartbeat requires the muse token');
      const ttl = ttl_ms ?? config.museLeaseTtlMs ?? 300000;
      const presence = store.touchMusePresence({
        ttlMs: ttl,
        source: source || 'muse_heartbeat',
        force: true
      });
      return asText({
        ok: true,
        principal_id: 'muse',
        last_seen_at: presence.last_seen_at,
        lease_expires_at: presence.lease_expires_at,
        ttl_ms: ttl,
        online: true
      });
    } catch (error) {
      return asError(error.message);
    }
  });

  // -------------------------------------------------------------- chat context
  register('chat_get_context', {
    description: 'Read the deterministic shared context of a chat: the most recent messages within a token '
      + 'budget (seq ascending) and the chat attachment list. Used by buildChatTaskPrompt and available to agents.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum messages to consider; default 30'),
      max_tokens: z.number().int().min(64).max(100000).optional().describe('Token budget; default 6000'),
      include_files: z.boolean().optional().describe('Include the attachment list; default true')
    }
  }, async ({ chat_id, limit, max_tokens, include_files }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      const context = buildChatContext({ store, config }, chat_id, {
        limit,
        tokenBudget: max_tokens,
        includeFiles: include_files !== false
      });
      // The context IS the pull. Advance the viewer's cursor so an agent that
      // refreshed context can speak without tripping the 409 gate.
      if (auth?.participant && store.getChatParticipant(chat_id, auth.participant)) {
        const newest = context.messages.reduce(
          (max, message) => Math.max(max, Number(message.seq) || 0), 0);
        if (newest > 0) {
          try {
            agentService.markRead({
              chatId: chat_id,
              agentId: agentIdForParticipant(auth.participant),
              upToSeq: newest
            });
          } catch { /* context retrieval never fails on read-state maintenance */ }
        }
      }
      return asText(context);
    } catch (error) {
      return asError(error.message);
    }
  });

  // ------------------------------------------------------- REA Phase 2 tools
  register('inbox', {
    description: 'Per-chat unread counts for one agent: mentions_you, replies_to_you, from_owner and recalled. '
      + 'The response carries a `you` self-check block. Agent tokens may only read their own inbox; '
      + 'human/master may pass agent_id. Reading the inbox does not mark messages read.',
    inputSchema: {
      agent_id: z.string().min(1).optional()
        .describe('Agent id (agent_claude, agent_<random>); defaults to the token identity'),
      chat_id: z.string().min(1).optional().describe('Return only this chat')
    }
  }, async ({ agent_id, chat_id }) => {
    try {
      const own = auth?.agent_id ?? agentIdForParticipant(auth?.participant);
      const target = agent_id ?? own;
      if (!readAll && target !== own) {
        throw new Error(`agent '${auth?.participant}' can only read its own inbox`);
      }
      const result = agentService.inbox({ agentId: target });
      if (chat_id) {
        result.chats = result.chats.filter((entry) => entry.chat_id === chat_id);
        result.total_unread = result.chats.reduce((sum, entry) => sum + entry.unread, 0);
      }
      return asText(result);
    } catch (error) {
      return serviceError(error);
    }
  });

  register('agent_pairing_code', {
    description: 'Create a one-time pairing code (default 24h, at most 10 agents). Human or master token only. '
      + 'The code is returned once and only its hash is stored.',
    inputSchema: {
      ttl_hours: z.number().min(1).max(24).optional().describe('Validity in hours; default 24, max 24'),
      max_agents: z.number().int().min(1).max(10).optional().describe('How many distinct agents may use it; default 10')
    }
  }, async ({ ttl_hours, max_agents }) => {
    try {
      requireChatAdmin('agent_pairing_code');
      return asText(agentService.createPairingCode({
        createdBy: auth?.participant || 'user',
        ttlMs: ttl_hours === undefined ? null : ttl_hours * 60 * 60 * 1000,
        maxAgents: max_agents
      }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('agent_pair', {
    description: 'Exchange a pairing code for an access token (pachat_...). The token is shown once; only its '
      + 'SHA-256 hash is stored. Re-pairing an existing name requires reclaim=true, which takes over the identity '
      + 'and invalidates the old token. Human/master only in Phase 2 (the code is the second factor).',
    inputSchema: {
      code: z.string().min(1).describe('Pairing code from agent_pairing_code'),
      name: z.string().min(1).max(80).describe('Agent display name; a same-name reclaim takes over that identity'),
      platform: z.string().max(40).optional().describe('Platform label, e.g. claude-code/custom'),
      profile: z.string().max(300).optional().describe('Profile text, at most 300 characters'),
      reclaim: z.boolean().optional().describe('Take over an existing same-name agent and invalidate its token'),
      chat_ids: z.array(z.string()).max(50).optional().describe('Chats to join immediately')
    }
  }, async ({ code, name, platform, profile, reclaim, chat_ids }) => {
    try {
      requireChatAdmin('agent_pair');
      return asText(agentService.redeemPairingCode({
        code, name, platform, profile, reclaim, chatIds: chat_ids
      }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('agent_revoke_token', {
    description: 'Revoke an agent access token. An agent token may revoke itself; human/master may revoke any agent. '
      + 'The agents row is kept with status=revoked and no token hash.',
    inputSchema: {
      agent_id: z.string().min(1).optional().describe('Agent to revoke; defaults to the caller')
    }
  }, async ({ agent_id }) => {
    try {
      const own = auth?.agent_id ?? agentIdForParticipant(auth?.participant);
      const target = agent_id ?? own;
      if (!master && auth?.role !== 'human' && target !== own) {
        throw new Error(`agent '${auth?.participant}' can only revoke its own token`);
      }
      return asText(agentService.revokeToken(target));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('agent_profile', {
    description: 'Read a Profile Card, or update your own profile (<=300 characters). Human/master may read '
      + 'any agent; an agent token may only read/update itself.',
    inputSchema: {
      agent_id: z.string().min(1).optional().describe('Agent to read; defaults to the caller'),
      profile: z.string().max(300).optional().describe('New profile text; omitted means read only')
    }
  }, async ({ agent_id, profile }) => {
    try {
      const own = auth?.agent_id ?? agentIdForParticipant(auth?.participant);
      const target = agent_id ?? own;
      if (!readAll && target !== own) {
        auditDenied({
          surface: 'tool:agent_profile',
          code: 'forbidden_profile',
          status: 403,
          target: String(target ?? ''),
          detail: `agent '${auth?.participant}' can only read or update its own profile`
        });
        throw new Error(`agent '${auth?.participant}' can only read or update its own profile`);
      }
      if (profile !== undefined) {
        if (!readAll && target !== own) throw new Error('not allowed');
        return asText(agentService.updateProfile(target, profile));
      }
      const found = agentService.profile(target);
      if (!found) throw new Error(`agent not found: ${target}`);
      return asText(found);
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_recall', {
    description: 'Recall a chat message within the engine-enforced 2-minute window. The author or the human '
      + 'owner may recall. The body is replaced with a placeholder and recalled counters advance for the other '
      + 'members. Returns 403 recall_window_expired after the window.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      message_id: z.string().min(1).describe('Message to recall')
    }
  }, async ({ chat_id, message_id }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      return asText(messages.recall({ chatId: chat_id, messageId: message_id, auth }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_members', {
    description: 'List the canonical members of a group chat (agent_id, role, display name, platform, colour).',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      assertChatAccess(store, auth, chat_id);
      return asText({ chat_id, members: agentService.members(chat_id) });
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_add_member', {
    description: 'Add an agent to a group chat. Human or master token only. Enforces the 50-member chat cap; '
      + 'the human owner is the only owner row.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      agent_id: z.string().min(1).describe('Agent id or participant handle (agent_claude, claude, agent_<random>)')
    }
  }, async ({ chat_id, agent_id }) => {
    try {
      requireChatAdmin('chat_add_member');
      return asText(agentService.addMember({ chatId: chat_id, agentId: agent_id }));
    } catch (error) {
      return serviceError(error);
    }
  });

  register('chat_remove_member', {
    description: 'Remove an agent from a group chat. Human or master token only. The human owner cannot be removed.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      agent_id: z.string().min(1).describe('Agent id or participant handle')
    }
  }, async ({ chat_id, agent_id }) => {
    try {
      requireChatAdmin('chat_remove_member');
      return asText(agentService.removeMember({ chatId: chat_id, agentId: agent_id }));
    } catch (error) {
      return serviceError(error);
    }
  });

  // ---------------------------------------------------------------- chat files
  register('upload_chat_file_init', {
    description: 'Start a chunked file upload for one chat. Returns upload_id and the per-chunk byte cap '
      + '(<= 1 MB). Single-file limit is 20 MB; larger files are rejected explicitly.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      name: z.string().min(1).max(255).describe('Original file name'),
      size: z.number().int().min(1).describe('Total file size in bytes (max 20 MB)'),
      mime: z.string().max(200).optional().describe('Declared MIME type')
    }
  }, async ({ chat_id, name, size, mime }) => {
    try {
      requireFiles(files);
      assertChatAccess(store, auth, chat_id);
      return asText(files.initUpload({ chat_id, name, size, mime, uploader: auth.participant || 'user' }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('upload_chat_file_chunk', {
    description: 'Append one base64 chunk to an upload. Chunks must arrive in order starting at index 0; each '
      + 'decoded chunk must be <= 1 MB so the 8 MB JSON body limit is never hit.',
    inputSchema: {
      upload_id: z.string().min(1).describe('upload_id from upload_chat_file_init'),
      index: z.number().int().min(0).describe('Zero-based chunk index'),
      data: z.string().min(1).describe('Base64-encoded chunk (max 1 MB decoded)')
    }
  }, async ({ upload_id, index, data }) => {
    try {
      requireFiles(files);
      return asText(files.appendChunk({ upload_id, index, data, uploader: auth.participant || 'user' }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('upload_chat_file_complete', {
    description: 'Finish an upload: verifies the declared size, stores the file under the chat directory, '
      + 'computes sha256, parses text/PDF/DOCX/XLSX/PPTX/ZIP or records image metadata, and returns the file_id.',
    inputSchema: {
      upload_id: z.string().min(1).describe('upload_id from upload_chat_file_init')
    }
  }, async ({ upload_id }) => {
    try {
      requireFiles(files);
      return asText(files.completeUpload({ upload_id, uploader: auth.participant || 'user' }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('read_chat_file', {
    description: 'Read a chat file by file_id (never by host path). Text/code/PDF/DOCX/XLSX/PPTX return '
      + 'extracted text; ZIP returns a file tree and entry=<path> reads one member; images are returned as image '
      + 'content only to vision-capable executors. Unsupported binaries and non-vision executors get an explicit error.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      file_id: z.string().min(1).describe('file_id from upload_chat_file_complete or list_chat_files'),
      entry: z.string().optional().describe('ZIP member path (relative), when reading inside a ZIP'),
      max_bytes: z.number().int().min(1000).max(2000000).optional().describe('Maximum text bytes to return')
    }
  }, async ({ chat_id, file_id, entry, max_bytes }) => {
    try {
      requireFiles(files);
      assertChatAccess(store, auth, chat_id);
      const result = files.readFile({ chat_id, file_id, entry, max_bytes, actor: auth });
      if (result.image) {
        return {
          content: [
            { type: 'image', data: result.image.data, mimeType: result.image.mimeType },
            {
              type: 'text',
              text: JSON.stringify({
                file_id: result.file_id,
                name: result.name,
                mime: result.mime,
                size: result.size,
                sha256: result.sha256,
                kind: 'image'
              }, null, 2)
            }
          ]
        };
      }
      return asText(result);
    } catch (error) {
      return asError(error.message);
    }
  });

  register('list_chat_files', {
    description: 'List files uploaded to one chat, with file_id, name, mime, size, sha256 and parse status.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async ({ chat_id, limit }) => {
    try {
      requireFiles(files);
      assertChatAccess(store, auth, chat_id);
      return asText(files.listFiles({ chat_id, limit }));
    } catch (error) {
      return asError(error.message);
    }
  });

  // --------------------------------------------------------------- approvals
  register('request_approval', {
    description: 'Ask the user, in chat, before a critical operation. Only active when AGENT_APPROVAL_GATE=1. '
      + 'An executor token may only ask for its own task; session grants are scoped to (chat, agent, category).',
    inputSchema: {
      agent: z.enum(['claude', 'dsh']).describe('Agent asking; must match the task owner'),
      task_id: z.string().min(1).describe('Task asking for approval; {{task_id}} is rendered into agent prompts'),
      category: z.enum(['merge', 'delete', 'dependencies']).describe('Critical-operation category'),
      action: z.string().min(1).describe('Who wants to do what, in one or two sentences'),
      files: z.array(z.string()).max(100).optional().describe('Every file or directory affected'),
      reason: z.string().min(1).describe('Why the operation is needed'),
      command: z.string().max(4000).optional().describe('Exact command(s) when known'),
      task: z.string().max(200).optional().describe('Short task label for the card prefix')
    }
  }, async (args) => {
    try {
      if (!readAll) assertTaskAccess(store, auth, args.task_id);
      return asText(await approvals.request(args));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('respond_approval', {
    description: 'Answer a pending approval as the user. MASTER TOKEN ONLY: an executor token is rejected, so '
      + 'an agent can never approve its own request. decision=once allows this request; session also allows later '
      + 'operations of the same category for this (chat, agent); deny stops the operation.',
    inputSchema: {
      approval_id: z.string().optional().describe('Approval id; from list_approvals or the card'),
      task_id: z.string().optional().describe('Task with a pending approval, when approval_id is omitted'),
      decision: z.enum(['once', 'session', 'deny']).describe('once | session | deny'),
      reason: z.string().max(4000).optional().describe('Optional reason stored in the user reply')
    }
  }, async (args) => {
    try {
      requireMaster(auth, 'respond_approval');
      return asText(approvals.respond({ ...args, auth }));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('list_approvals', {
    description: 'List persisted approval requests and decisions. Agent tokens are scoped to their own approvals.',
    inputSchema: {
      thread_id: z.string().optional().describe('Conversation thread id'),
      task_id: z.string().optional().describe('Task id'),
      status: z.string().optional().describe('pending|allowed|denied|timed_out|abandoned'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async (filters) => {
    try {
      if (!readAll) {
        if (filters.task_id) assertTaskAccess(store, auth, filters.task_id);
        filters = { ...filters, agent: auth.participant };
      }
      return asText(approvals.list(filters));
    } catch (error) {
      return asError(error.message);
    }
  });

  register('wait_for_task', {
    description: 'Long-poll until a task reaches a terminal state or the timeout expires (max 40s). Agent tokens '
      + 'may only wait on their own tasks.',
    inputSchema: {
      task_id: z.string().describe('Task id'),
      timeout_s: z.number().int().min(1).max(40).optional().describe('Seconds to wait; default 30')
    }
  }, async ({ task_id, timeout_s }) => {
    try {
      assertTaskAccess(store, auth, task_id);
      return asText(await scheduler.waitForTask(task_id, timeout_s ?? 30));
    } catch (error) {
      return asError(error.message);
    }
  });
}

function requireFiles(files) {
  if (!files) throw new Error('file service is not available');
}