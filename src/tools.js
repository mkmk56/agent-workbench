import * as z from 'zod/v4';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

const asError = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true
});

export function registerTools(server, { scheduler, store, messages, approvals, chats }) {
  server.registerTool('agent_info', {
    description: 'List available executors (claude, dsh) with version, capabilities and resume support.'
  }, async () => asText(scheduler.agentInfo()));

  server.registerTool('task_start', {
    description: 'Start a task on a local executor. Returns immediately with task_id and session_id.',
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
      const result = scheduler.createTask({
        agent, prompt, cwd, sessionId: session_id, model, timeoutMs: timeout_ms
      });
      return asText(result);
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('task_send', {
    description: 'Send a follow-up message to an existing task or session.',
    inputSchema: {
      task_id: z.string().optional().describe('Task whose session should receive the message'),
      session_id: z.string().optional().describe('Session to continue, when task_id is omitted'),
      prompt: z.string().min(1).describe('Follow-up text')
    }
  }, async ({ task_id, session_id, prompt }) => {
    try {
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
    description: 'Get the current status of a task.',
    inputSchema: {
      task_id: z.string().describe('Task id')
    }
  }, async ({ task_id }) => {
    const task = store.getTask(task_id);
    if (!task) return asError('task not found');
    return asText(scheduler.statusPayload(task));
  });

  server.registerTool('task_logs', {
    description: 'Read incremental log entries for a task.',
    inputSchema: {
      task_id: z.string().describe('Task id'),
      cursor: z.number().int().min(0).optional().describe('Previous next_cursor; omit to read from the start'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum entries to return')
    }
  }, async ({ task_id, cursor, limit }) => {
    const task = store.getTask(task_id);
    if (!task) return asError('task not found');
    const entries = store.getLogs(task_id, cursor ?? 0, limit ?? 200);
    const nextCursor = entries.length > 0 ? entries[entries.length - 1].seq : (cursor ?? 0);
    return asText({
      task_id,
      entries,
      next_cursor: nextCursor,
      truncated: entries.length >= (limit ?? 200)
    });
  });

  server.registerTool('task_cancel', {
    description: 'Cancel a running or queued task and clean up its process tree.',
    inputSchema: {
      task_id: z.string().describe('Task id')
    }
  }, async ({ task_id }) => {
    try {
      return asText(scheduler.cancel(task_id));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('task_list', {
    description: 'List recent tasks, newest first.',
    inputSchema: {
      status: z.string().optional().describe('Optional state filter (COMPLETED, FAILED, CANCELLED, ...)'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async ({ status, limit }) => {
    const tasks = store.listTasks({ status, limit }).map((task) => ({
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
    description: 'Send a conclusion-only message from one local agent to the other. The server generates the '
      + 'message_id, persists the message and links replies with reply_to. The summary is hard-capped at 500 tokens '
      + '(configurable) and over-long summaries are truncated. When the target agent is idle the message is delivered '
      + 'by starting a task; otherwise it is queued. Each thread stops after 10 agent-to-agent messages and waits for a '
      + 'user message unless AGENT_MESSAGE_LIMIT is changed. Muse may send without task_id; a message that carries '
      + 'chat_id is shown in that group chat and a Muse message to an agent starts a sub-task for it.',
    inputSchema: {
      from: z.enum(['claude', 'dsh', 'user', 'muse']).describe('Sender; must match the task agent unless user or muse'),
      to: z.enum(['claude', 'dsh', 'user', 'muse']).describe('Recipient agent, user for a final report, or muse'),
      task_id: z.string().min(1).optional()
        .describe('Task sending the message; required unless from=muse. {{task_id}} is rendered into agent prompts'),
      chat_id: z.string().optional().describe('Group chat this message belongs to; Muse->agent must set it'),
      reply_to: z.string().optional().describe('message_id this message answers'),
      summary: z.string().min(1).describe('Conclusion summary; truncated to the token cap'),
      files: z.array(z.string()).max(100).optional().describe('Files involved in the conclusion'),
      question: z.string().optional().describe('Question the recipient must answer'),
      deliver: z.boolean().optional().describe('Auto-start a task for the recipient; default true'),
      is_final: z.boolean().optional().describe('Marks that no further agent turn is expected')
    }
  }, async ({ from, to, task_id, chat_id, reply_to, summary, files, question, deliver, is_final }) => {
    try {
      // Pass only schema fields: the internal message_id used by the approval
      // service must not be settable from an agent-facing call.
      return asText(messages.send({
        from, to, task_id, chat_id, reply_to, summary, files, question, deliver, is_final
      }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_messages', {
    description: 'List persisted agent-to-agent messages and thread state. Filter by thread_id, task_id, chat_id, '
      + 'from, to, reply_to or status. Includes reply_to chains, summary token counts and waiting_for_user.',
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
  }, async (filters) => asText(messages.list(filters)));

  // ------------------------------------------------------------------ chats
  server.registerTool('create_chat', {
    description: 'Create a group chat (one chat = one independent task context). An empty name starts as "新群聊" '
      + 'and is renamed later by Muse. Returns the new chat.',
    inputSchema: {
      name: z.string().max(200).optional().describe('Chat name; defaults to 新群聊')
    }
  }, async ({ name }) => {
    try {
      const chat = chats.create({ name });
      return asText({
        chat_id: chat.chat_id,
        name: chat.name,
        created_at: chat.created_at
      });
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_chats', {
    description: 'List group chats with their derived state: needs_muse is true when a user message has no Muse '
      + 'reply after it, and each agent status comes from its latest real sub-task in that chat. Omitted status '
      + 'means active chats; pass "all" to include archived ones.',
    inputSchema: {
      status: z.enum(['active', 'archived', 'all']).optional().describe('Chat status filter; default active'),
      limit: z.number().int().min(1).max(200).optional()
    }
  }, async ({ status, limit }) => {
    try {
      return asText(chats.list({ status, limit }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('rename_chat', {
    description: 'Rename a group chat and return the updated chat.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      name: z.string().min(1).max(200).describe('New chat name')
    }
  }, async ({ chat_id, name }) => {
    try {
      return asText(chats.rename({ chat_id, name }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('send_chat_message', {
    description: 'Post a natural-language message into a group chat. from=user must address muse (a new request). '
      + 'from=muse may address the user or an agent; addressing an agent starts a sub-task for it with the chat '
      + 'context in the prompt, and that agent\'s conclusion returns to this chat as its own message.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      from: z.enum(['user', 'muse']).describe('user posts a request to Muse; muse coordinates'),
      to: z.enum(['muse', 'user', 'claude', 'dsh']).describe('Recipient'),
      summary: z.string().min(1).describe('Natural-language message body; truncated to the token cap'),
      files: z.array(z.string()).max(100).optional().describe('Files involved'),
      question: z.string().optional().describe('Question the recipient must answer'),
      task_id: z.string().optional().describe('Only for internal callers; Muse messages need no task'),
      reply_to: z.string().optional().describe('message_id this message answers')
    }
  }, async (args) => {
    try {
      return asText(chats.send(args));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('chat_status', {
    description: 'Derive the live status of a group chat: needs_muse, each participant status from its latest real '
      + 'sub-task (idle|pending|working|waiting|blocked|completed|failed|cancelled), and the chat\'s sub-tasks.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id')
    }
  }, async ({ chat_id }) => {
    try {
      return asText(chats.status(chat_id));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_chat_messages', {
    description: 'List the natural-language message stream of one group chat, oldest first. Only summaries, files, '
      + 'questions and statuses are returned; task logs and tool output are never included. Use `before` with a '
      + 'message_id or ISO timestamp to page backwards.',
    inputSchema: {
      chat_id: z.string().min(1).describe('Chat id'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size; default 50'),
      before: z.string().optional().describe('message_id or ISO timestamp to page backwards from')
    }
  }, async ({ chat_id, limit, before }) => {
    try {
      return asText(chats.listMessages({ chat_id, limit, before }));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('request_approval', {
    description: 'Ask the user, in chat, before a critical operation. Only active when AGENT_APPROVAL_GATE=1; '
      + 'when the gate is off it returns allowed immediately and sends nothing, so the workbench stays fully '
      + 'automatic. Categories: merge (merge/rebase/cherry-pick/push), delete (delete files/discard work), '
      + 'dependencies (install/remove/upgrade packages or change manifests/lockfiles). The question is written '
      + 'through the phase-1 message protocol as "[Agent HUD · 来自 <agent> · <task> <message-id>] <body>" and '
      + 'the thread enters WAITING_USER. This call blocks until the user answers (once / session / deny) or '
      + 'APPROVAL_TIMEOUT_MS expires; a timeout is treated as deny.',
    inputSchema: {
      agent: z.enum(['claude', 'dsh']).describe('Agent asking; must match the task owner'),
      task_id: z.string().min(1).describe('Task asking for approval; {{task_id}} is rendered into agent prompts'),
      category: z.enum(['merge', 'delete', 'dependencies']).describe('Critical-operation category'),
      action: z.string().min(1).describe('Who wants to do what, in one or two sentences'),
      files: z.array(z.string()).max(100).optional().describe('Every file or directory affected'),
      reason: z.string().min(1).describe('Why the operation is needed'),
      command: z.string().max(4000).optional().describe('Exact command(s) when known'),
      task: z.string().max(200).optional().describe('Short task label for the card prefix; defaults to the prompt first line')
    }
  }, async (args) => {
    try {
      return asText(await approvals.request(args));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('respond_approval', {
    description: 'Answer a pending critical-operation approval as the user. decision=once allows exactly this '
      + 'request; session also allows later operations of the same category in this thread; deny stops the '
      + 'operation. This writes a user reply into the same chat thread (reply_to the approval question) and '
      + 'resumes or stops the blocked agent call. Requires AGENT_APPROVAL_GATE=1.',
    inputSchema: {
      approval_id: z.string().optional().describe('Approval id; from list_approvals or the card'),
      task_id: z.string().optional().describe('Task with a pending approval, when approval_id is omitted'),
      decision: z.enum(['once', 'session', 'deny']).describe('once | session | deny'),
      reason: z.string().max(4000).optional().describe('Optional reason stored in the user reply')
    }
  }, async (args) => {
    try {
      return asText(approvals.respond(args));
    } catch (error) {
      return asError(error.message);
    }
  });

  server.registerTool('list_approvals', {
    description: 'List persisted approval requests and their decisions. Filter by thread_id, task_id or status '
      + '(pending|allowed|denied|timed_out|abandoned). Includes the message_id of the chat question and the '
      + 'full file list.',
    inputSchema: {
      thread_id: z.string().optional().describe('Conversation thread id'),
      task_id: z.string().optional().describe('Task id'),
      status: z.string().optional().describe('pending|allowed|denied|timed_out|abandoned'),
      limit: z.number().int().min(1).max(500).optional()
    }
  }, async (filters) => asText(approvals.list(filters)));

  server.registerTool('wait_for_task', {
    description: 'Long-poll until a task reaches a terminal state or the timeout expires (max 40s).',
    inputSchema: {
      task_id: z.string().describe('Task id'),
      timeout_s: z.number().int().min(1).max(40).optional().describe('Seconds to wait; default 30')
    }
  }, async ({ task_id, timeout_s }) => {
    try {
      return asText(await scheduler.waitForTask(task_id, timeout_s ?? 30));
    } catch (error) {
      return asError(error.message);
    }
  });
}