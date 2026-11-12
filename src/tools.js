import * as z from 'zod/v4';

const asText = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
});

const asError = (message) => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true
});

export function registerTools(server, { scheduler, store }) {
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