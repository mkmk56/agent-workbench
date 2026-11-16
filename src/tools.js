import * as z from 'zod/v4';
import { buildChatContext } from './context.js';
import {
  assertChatAccess, assertTaskAccess, isMaster, requireMaster
} from './auth.js';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

const asError = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true
});

function agentScope(auth) {
  return auth && !isMaster(auth) ? auth.participant : null;
}

export function registerTools(server, { scheduler, store, messages, approvals, chats, files, config }, auth = { master: true, participant: 'muse' }) {
  const master = isMaster(auth);

  server.registerTool('agent_info', {
    description: 'List available executors (claude, dsh) with version, capabilities and resume support.'
  }, async () => asText(scheduler.agentInfo()));

  server.registerTool('task_start', {
    description: 'Start a task on a local executor. Returns immediately with task_id and session_id. '
      + 'Master token only.',
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
      requireMaster(auth, 'task_start');
      const result = scheduler.createTask({
        agent, prompt, cwd, sessionId: session_id, model, timeoutMs: timeout_ms
      });
      return asText(result);
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('task_send', {
    description: 'Send a follow-up message to an existing task or session. Master token only.',
    inputSchema: {
      task_id: z.string().optional().describe('Task whose session should receive the message'),
      session_id: z.string().optional().describe('Session to continue, when task_id is omitted'),
      prompt: z.string().min(1).describe('Follow-up text')
    }
  }, async ({ task_id, session_id, prompt }) => {
    try {
      requireMaster(auth, 'task_send');
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

  server.registerTool('task_status', {
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

  server.registerTool('task_logs', {
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

  server.registerTool('task_cancel', {
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

  server.registerTool('task_list', {
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

  server.registerTool('send_message', {
    description: 'Send a conclusion-only message from one local agent to the other. The server derives the sender '
      + 'from the bearer token: an executor token can only speak as itself and must pass its own task_id. The summary '
      + 'is a preview (token-capped); body carries the full text. In a chat, files must be file_id references. '
      + 'When the target agent is idle the message is delivered by starting a task; otherwise it is queued. Each '
      + 'sub-task thread still stops after 10 agent-to-agent messages.',
    inputSchema: {
      from: z.enum(['claude', 'dsh', 'user', 'muse']).describe('Sender; must match the token identity'),
      to: z.enum(['claude', 'dsh', 'user', 'muse']).describe('Recipient agent, user for a final report, or muse'),
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
      is_final: z.boolean().optional().describe('Marks that no further agent turn is expected')
    }
  }, async ({ from, to, task_id, chat_id, reply_to, summary, body, files, question, deliver, is_final }) => {
    try {
      return asText(messages.send({
        from, to, task_id, chat_id, reply_to, summary, body, files, question, deliver, is_final, auth
      }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_messages', {
    description: 'List persisted agent-to-agent messages and thread state. Filter by thread_id, task_id, chat_id, '
      + 'from, to, reply_to or status. Agent tokens are limited to chats they participate in and their own tasks.',
    inputSchema: {
      thread_id: z.string().optional().describe('Conversation thread id'),
      task_id: z.string().optional().describe('Task id; alone, lists that task\'s whole thread'),
      chat_id: z.string().optional().describe('Group chat id'),
      from: z.enum(['claude', 'dsh', 'user', 'muse']).optional(),
      to: z.enum(['claude', 'dsh', 'user', 'muse']).optional(),
      reply_to: z.string().optional().describe('Only messages replying to this message_id'),
      status: z.string().optional().describe('queued|delivered|answered|held|stored|failed'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async (filters) => {
    try {
      if (!master) {
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
          filters = { ...filters, chat_ids: store.listParticipantChatIds(auth.participant) };
        }
      }
      return asText(messages.list(filters));
    } catch (error) {
      return asError(error.message);
    }
  });

  // ------------------------------------------------------------------ chats
  server.registerTool('create_chat', {
    description: 'Create a group chat. Master token only. Returns the new chat with epoch 0.',
    inputSchema: {
      name: z.string().max(200).optional().describe('Chat name; defaults to 新群聊')
    }
  }, async ({ name }) => {
    try {
      requireMaster(auth, 'create_chat');
      const chat = chats.create({ name });
      return asText({
        chat_id: chat.chat_id,
        name: chat.name,
        epoch: chat.epoch,
        created_at: chat.created_at
      });
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_chats', {
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
      const chatIds = master ? null : store.listParticipantChatIds(auth.participant);
      return asText(chats.list({ status, include_archived, limit, chat_ids: chatIds }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('rename_chat', {
    description: 'Rename a group chat and return the updated chat. Master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      name: z.string().min(1).max(200).describe('New chat name')
    }
  }, async ({ chat_id, name }) => {
    try {
      requireMaster(auth, 'rename_chat');
      return asText(chats.rename({ chat_id, name }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('chat_archive', {
    description: 'Archive a group chat. Messages and files are kept; the chat is only hidden from the default '
      + 'list_chats result. Restore it with chat_unarchive. Master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      requireMaster(auth, 'chat_archive');
      return asText(chats.archive({ chat_id, archived: true }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('chat_unarchive', {
    description: 'Restore an archived group chat to active status. Master token only.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      requireMaster(auth, 'chat_unarchive');
      return asText(chats.archive({ chat_id, archived: false }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('send_chat_message', {
    description: 'Post a message into a group chat. Every message is visible to all participants; only '
      + 'act_recipients start sub-tasks. The sender is derived from the bearer token (master may post as user or '
      + 'muse; an executor may only post as itself and must pass its own task_id). A user message increments the '
      + 'chat epoch; a dispatch carrying a stale epoch is rejected. files must be file_id values. client_msg_id '
      + 'makes retries idempotent.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      from: z.enum(['user', 'muse', 'claude', 'dsh']).describe('Sender; must match the token identity'),
      to: z.enum(['muse', 'user', 'claude', 'dsh']).describe('Primary visible recipient'),
      summary: z.string().min(1).optional().describe('Short preview for the chat list; body carries the full text'),
      body: z.string().optional().describe('Full message text; defaults to summary'),
      files: z.array(z.string()).max(50).optional().describe('file_id values belonging to this chat'),
      mentions: z.array(z.enum(['user', 'muse', 'claude', 'dsh'])).max(4).optional()
        .describe('Participants mentioned (@); visibility only'),
      act_recipients: z.array(z.enum(['claude', 'dsh'])).max(2).optional()
        .describe('Executors to start sub-tasks for; omitted means no action (legacy Muse->agent still dispatches)'),
      question: z.string().optional().describe('Question the recipient must answer'),
      task_id: z.string().optional().describe('Owned task id; required when from is claude or dsh'),
      reply_to: z.string().optional().describe('message_id this message answers'),
      client_msg_id: z.string().max(200).optional().describe('Idempotency key per chat'),
      epoch: z.number().int().min(0).optional().describe('Epoch the dispatch was prepared against'),
      is_final: z.boolean().optional().describe('Marks that no further agent turn is expected')
    }
  }, async (args) => {
    try {
      return asText(chats.send({ ...args, auth }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('chat_status', {
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

  server.registerTool('list_chat_messages', {
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
      return asText(chats.listMessages({ chat_id, limit, before, after_seq }));
    } catch (error) {
      return asError(error.message);
    }
  });

  // -------------------------------------------------------------- chat context
  server.registerTool('chat_get_context', {
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
      return asText(context);
    } catch (error) {
      return asError(error.message);
    }
  });

  // ---------------------------------------------------------------- chat files
  server.registerTool('upload_chat_file_init', {
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
      return asText(files.initUpload({ chat_id, name, size, mime, uploader: master ? 'user' : auth.participant }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('upload_chat_file_chunk', {
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
      return asText(files.appendChunk({ upload_id, index, data, uploader: master ? 'user' : auth.participant }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('upload_chat_file_complete', {
    description: 'Finish an upload: verifies the declared size, stores the file under the chat directory, '
      + 'computes sha256, parses text/PDF/DOCX/XLSX/PPTX/ZIP or records image metadata, and returns the file_id.',
    inputSchema: {
      upload_id: z.string().min(1).describe('upload_id from upload_chat_file_init')
    }
  }, async ({ upload_id }) => {
    try {
      requireFiles(files);
      return asText(files.completeUpload({ upload_id, uploader: master ? 'user' : auth.participant }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('read_chat_file', {
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

  server.registerTool('list_chat_files', {
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
  server.registerTool('request_approval', {
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
      if (!master) assertTaskAccess(store, auth, args.task_id);
      return asText(await approvals.request(args));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('respond_approval', {
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

  server.registerTool('list_approvals', {
    description: 'List persisted approval requests and decisions. Agent tokens are scoped to their own approvals.',
    inputSchema: {
      thread_id: z.string().optional().describe('Conversation thread id'),
      task_id: z.string().optional().describe('Task id'),
      status: z.string().optional().describe('pending|allowed|denied|timed_out|abandoned'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async (filters) => {
    try {
      if (!master) {
        if (filters.task_id) assertTaskAccess(store, auth, filters.task_id);
        filters = { ...filters, agent: auth.participant };
      }
      return asText(approvals.list(filters));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('wait_for_task', {
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