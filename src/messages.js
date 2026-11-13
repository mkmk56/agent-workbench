import { randomUUID } from 'node:crypto';

const AGENTS = new Set(['claude', 'dsh']);
const SENDERS = new Set(['claude', 'dsh', 'user']);
const ACTIVE_TASK_STATES = new Set(['PENDING', 'STARTING', 'WORKING', 'WAITING', 'BLOCKED']);

function isCjk(code) {
  return code >= 0x2e80;
}

// Conservative, tokenizer-free upper bound: one token per CJK character and
// one token per four remaining characters. It over-counts rather than under-
// counts, so a summary accepted here stays within the configured budget.
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text ?? '')) {
    if (isCjk(ch.codePointAt(0))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function truncateSummary(text, maxTokens) {
  const raw = String(text ?? '');
  const tokens = estimateTokens(raw);
  if (tokens <= maxTokens) return { text: raw, tokens, truncated: false };
  let used = 0;
  let out = '';
  for (const ch of raw) {
    const add = isCjk(ch.codePointAt(0)) ? 1 : 0.25;
    if (used + add > maxTokens) break;
    used += add;
    out += ch;
  }
  out = out.trimEnd();
  return { text: out, tokens: estimateTokens(out), truncated: true };
}

function normalizeFiles(files) {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new Error('files must be an array of file paths');
  if (files.length > 100) throw new Error('files may contain at most 100 entries');
  return files.map((file) => {
    if (typeof file !== 'string' || file.trim() === '') throw new Error('files entries must be non-empty strings');
    if (file.length > 500) throw new Error('each file path must be at most 500 characters');
    return file.trim();
  });
}

function parseFiles(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function buildMessagePrompt(message) {
  const files = parseFiles(message.files_json);
  const lines = [
    '[agent-workbench message]',
    `message_id: ${message.id}`,
    `thread_id: ${message.thread_id}`,
    `from: ${message.from_agent}`,
    `to: ${message.to_agent}`,
    `reply_to: ${message.reply_to ?? 'none'}`,
    'your_task_id: {{task_id}}',
    '',
    'This is a conclusion-only hand-off between local agents, not a transcript.',
    'Use only the card below. Do not ask for the full conversation.',
    '',
    'Summary:',
    message.summary,
    ''
  ];
  if (files.length > 0) {
    lines.push('Files:', ...files.map((file) => `- ${file}`), '');
  }
  if (message.question) {
    lines.push('Question to answer:', message.question, '');
  }
  lines.push(
    'Reply with a conclusion only. End your final answer with exactly one JSON block:',
    '<agent_reply>{"summary":"...","files":["..."],"question":"...","done":false}</agent_reply>',
    'If a question is present, answer it and set "done": false.',
    'Set "done": true only when the exchange is resolved and no further turn is needed.',
    'Keep the summary under the configured token limit.'
  );
  return lines.join('\n');
}

export function parseAgentReply(text) {
  const raw = String(text ?? '').trim();
  let payload = null;

  const tagged = raw.match(/<agent_reply>\s*([\s\S]*?)\s*<\/agent_reply>/i);
  if (tagged) {
    try { payload = JSON.parse(tagged[1]); } catch { /* fall through */ }
  }
  if (!payload) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        const candidate = JSON.parse(fenced[1]);
        if (candidate && typeof candidate === 'object'
          && (typeof candidate.summary === 'string' || candidate.done !== undefined)) {
          payload = candidate;
        }
      } catch { /* fall through */ }
    }
  }

  if (payload && typeof payload === 'object') {
    return {
      summary: typeof payload.summary === 'string' && payload.summary.trim()
        ? payload.summary
        : (raw || '[no summary provided]'),
      files: Array.isArray(payload.files) ? payload.files.filter((f) => typeof f === 'string') : [],
      question: typeof payload.question === 'string' && payload.question.trim() ? payload.question : null,
      done: payload.done === true
    };
  }

  return { summary: raw || '[no summary provided]', files: [], question: null, done: false };
}

export class MessageService {
  constructor({ store, scheduler, config }) {
    this.store = store;
    this.scheduler = scheduler;
    this.config = config;
  }

  describeMessage(row) {
    if (!row) return null;
    const thread = this.store.getThread(row.thread_id);
    return {
      message_id: row.id,
      thread_id: row.thread_id,
      from: row.from_agent,
      to: row.to_agent,
      task_id: row.task_id,
      reply_to: row.reply_to,
      summary: row.summary,
      files: parseFiles(row.files_json),
      question: row.question,
      summary_tokens: row.summary_tokens,
      summary_truncated: Boolean(row.summary_truncated),
      status: row.status,
      delivery_task_id: row.delivery_task_id,
      is_final: Boolean(row.is_final),
      error: row.error,
      created_at: row.created_at,
      thread_state: thread?.state ?? 'ACTIVE',
      exchange_count: thread?.exchange_count ?? 0,
      exchange_limit: this.config.agentMessageLimit,
      waiting_for_user: thread?.state === 'WAITING_USER'
    };
  }

  send(input = {}) {
    const from = input.from;
    const to = input.to;
    if (!SENDERS.has(from)) throw new Error(`invalid from: ${from}`);
    if (!SENDERS.has(to)) throw new Error(`invalid to: ${to}`);
    if (from === to) throw new Error('from and to must be different');

    const taskId = input.task_id;
    if (typeof taskId !== 'string' || taskId === '') throw new Error('task_id is required');
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (from !== 'user' && task.agent !== from) {
      throw new Error(`task ${taskId} belongs to ${task.agent}, not ${from}`);
    }

    const threadId = this.store.getThreadId(taskId);
    let thread = this.store.getThread(threadId) || this.store.ensureThread(threadId, threadId);

    let reply = null;
    if (input.reply_to) {
      reply = this.store.getMessage(input.reply_to);
      if (!reply) throw new Error(`reply_to message not found: ${input.reply_to}`);
      if (reply.thread_id !== threadId) throw new Error('reply_to message belongs to a different thread');
      if (reply.from_agent !== to) {
        throw new Error(`reply_to message is from ${reply.from_agent}, not ${to}`);
      }
      if (this.store.getReply(reply.id)) throw new Error(`message ${reply.id} already has a reply`);
    }

    const toUser = to === 'user';
    // Only agent-to-agent messages count toward the back-and-forth cap. A
    // final report to the user is always accepted, including while the thread
    // is waiting for the user.
    const agentMessage = from !== 'user' && !toUser;

    if (from === 'user') {
      // A user message is the explicit "the human is talking again" signal:
      // it resets the agent-to-agent exchange counter for the thread.
      this.store.updateThread(threadId, { state: 'ACTIVE', exchange_count: 0 });
      thread = this.store.getThread(threadId);
    } else if (agentMessage && thread.state === 'WAITING_USER') {
      throw new Error(`thread ${threadId} is waiting for user input; send a message from "user" to resume`);
    }

    const limit = this.config.agentMessageLimit;
    // thread.exchange_count is the counter since the last user message; it is
    // reset when the human speaks, so historical messages do not re-trigger
    // the cap after a reset.
    const agentCountBefore = Number(thread.exchange_count ?? 0);
    if (agentMessage && agentCountBefore >= limit) {
      this.store.updateThread(threadId, { state: 'WAITING_USER' });
      this.store.appendLog(taskId, 'system', `thread ${threadId} reached exchange limit ${limit}; waiting for user input`);
      throw new Error(`thread ${threadId} reached the exchange limit (${limit}); waiting for user input`);
    }

    const summary = truncateSummary(input.summary, this.config.agentSummaryMaxTokens);
    if (!summary.text) throw new Error('summary must not be empty');
    const files = normalizeFiles(input.files);
    const question = input.question === undefined || input.question === null
      ? null
      : String(input.question).slice(0, 4000);
    const isFinal = Boolean(input.is_final ?? input.final);

    const atLimit = agentMessage && agentCountBefore + 1 >= limit;
    const id = randomUUID();
    const now = new Date().toISOString();

    this.store.insertMessage({
      id,
      thread_id: threadId,
      from_agent: from,
      to_agent: to,
      task_id: taskId,
      reply_to: reply?.id ?? null,
      summary: summary.text,
      files_json: JSON.stringify(files),
      question,
      summary_tokens: summary.tokens,
      summary_truncated: summary.truncated ? 1 : 0,
      status: atLimit ? 'held' : 'stored',
      delivery_task_id: null,
      error: null,
      is_final: isFinal ? 1 : 0,
      created_at: now,
      updated_at: now
    });
    this.store.updateThread(threadId, {
      message_count: (this.store.getThread(threadId)?.message_count ?? 0) + 1,
      last_message_id: id,
      exchange_count: agentMessage ? agentCountBefore + 1 : (from === 'user' ? 0 : agentCountBefore),
      ...(atLimit ? { state: 'WAITING_USER' } : {})
    });
    this.store.appendLog(taskId, 'system',
      `message ${id} ${from}->${to} thread=${threadId} reply_to=${reply?.id ?? 'none'} tokens=${summary.tokens}`
      + `${summary.truncated ? ' truncated' : ''}${atLimit ? ' held=limit' : ''}`
    );
    if (atLimit) {
      this.store.appendLog(taskId, 'system', `thread ${threadId} reached exchange limit ${limit}; waiting for user input`);
    } else if (input.deliver !== false && this.config.agentAutoDeliver) {
      this.attemptDelivery(id);
    }
    // Only mark the replied-to message answered when the reply itself was not
    // held at the exchange limit. A held reply is never delivered, so recording
    // the origin as answered would report a delivery that never happened.
    if (reply && !atLimit) this.store.updateMessage(reply.id, { status: 'answered' });

    return this.describeMessage(this.store.getMessage(id));
  }

  attemptDelivery(messageId) {
    const message = this.store.getMessage(messageId);
    if (!message) return null;

    const thread = this.store.getThread(message.thread_id);
    if (!thread || thread.state !== 'ACTIVE') {
      // Nothing retries a held row, so a non-active thread must fail visibly
      // rather than park the message in an unreachable state.
      this.store.updateMessage(messageId, {
        status: 'failed',
        error: `thread state is ${thread?.state ?? 'missing'}`
      });
      this.store.appendLog(message.task_id, 'system',
        `message ${messageId} delivery skipped: thread state ${thread?.state ?? 'missing'}`);
      return null;
    }
    if (!AGENTS.has(message.to_agent)) {
      this.store.updateMessage(messageId, { status: 'stored' });
      return null;
    }
    if (!this.config.agentAutoDeliver) {
      this.store.updateMessage(messageId, { status: 'stored' });
      return null;
    }

    const active = this.store.findActiveTaskForThreadAgent(message.thread_id, message.to_agent);
    if (active && ACTIVE_TASK_STATES.has(active.state)) {
      this.store.updateMessage(messageId, { status: 'queued' });
      this.store.appendLog(message.task_id, 'system',
        `message ${messageId} queued: ${message.to_agent} still has active task ${active.id}`);
      return null;
    }

    try {
      const sourceTask = this.store.getTask(message.task_id);
      const session = this.store.findThreadSession(message.thread_id, message.to_agent);
      const created = this.scheduler.createTask({
        agent: message.to_agent,
        prompt: buildMessagePrompt(message),
        cwd: sourceTask?.cwd || this.config.root,
        sessionId: session?.session_id || undefined,
        threadId: message.thread_id,
        originMessageId: messageId
      });
      this.store.updateMessage(messageId, { status: 'delivered', delivery_task_id: created.task_id });
      this.store.appendLog(message.task_id, 'system',
        `message ${messageId} delivered to ${message.to_agent} task=${created.task_id}`);
      return created;
    } catch (error) {
      this.store.updateMessage(messageId, { status: 'failed', error: error.message });
      this.store.appendLog(message.task_id, 'system', `message ${messageId} delivery failed: ${error.message}`);
      return null;
    }
  }

  processQueuedDeliveries(threadId) {
    if (!threadId) return;
    const thread = this.store.getThread(threadId);
    if (!thread || thread.state !== 'ACTIVE') return;
    const queued = this.store.listMessages({ threadId, status: 'queued', limit: 50 });
    for (const message of queued) {
      const current = this.store.getThread(threadId);
      if (!current || current.state !== 'ACTIVE') return;
      this.attemptDelivery(message.id);
    }
  }

  // Called by the scheduler after a task reaches a terminal state. Delivered
  // tasks answer their originating message either by calling send_message
  // themselves (reply_to matches) or, if they did not, with a reply parsed
  // from their final result.
  onTaskFinished(taskId) {
    const link = this.store.getTaskThread(taskId);
    const threadId = link?.thread_id || this.store.getThreadId(taskId);

    if (!link?.origin_message_id) {
      this.processQueuedDeliveries(threadId);
      return;
    }

    const task = this.store.getTask(taskId);
    const origin = this.store.getMessage(link.origin_message_id);
    if (!task || !origin) {
      this.processQueuedDeliveries(threadId);
      return;
    }

    const existingReply = this.store.taskReplyFrom(taskId, origin.id);
    if (existingReply) {
      // A held/failed reply never reaches the recipient, so it must not make
      // the origin message look answered.
      if (existingReply.status === 'held' || existingReply.status === 'failed') {
        this.store.appendLog(taskId, 'system',
          `message ${existingReply.id} reply to ${origin.id} is ${existingReply.status}; origin left unanswered`);
      } else {
        this.store.updateMessage(origin.id, { status: 'answered' });
      }
      this.processQueuedDeliveries(threadId);
      return;
    }

    if (task.state !== 'COMPLETED') {
      this.store.updateMessage(origin.id, { status: 'failed', error: `task ${task.state}` });
      this.store.appendLog(taskId, 'system', `message ${origin.id} not answered: task ${task.state}`);
      this.processQueuedDeliveries(threadId);
      return;
    }

    if (origin.is_final) {
      // The message that started this task was marked final. Deliver it was
      // already done; do not spawn another turn after this task finishes.
      this.store.updateMessage(origin.id, { status: 'answered' });
      this.store.appendLog(taskId, 'system', `message ${origin.id} is final; no auto-reply`);
      this.processQueuedDeliveries(threadId);
      return;
    }

    const parsed = parseAgentReply(task.summary);
    try {
      const reply = this.send({
        from: task.agent,
        to: origin.from_agent,
        task_id: taskId,
        reply_to: origin.id,
        summary: parsed.summary,
        files: parsed.files,
        question: parsed.question,
        deliver: !parsed.done,
        is_final: parsed.done
      });
      this.store.appendLog(taskId, 'system',
        `message ${reply.message_id} auto-reply to ${origin.id} done=${parsed.done}`);
    } catch (error) {
      this.store.appendLog(taskId, 'system', `auto-reply for ${origin.id} failed: ${error.message}`);
    }
    this.processQueuedDeliveries(threadId);
  }

  list(filters = {}) {
    const requestedTaskId = filters.task_id || null;
    const threadId = filters.thread_id
      || (requestedTaskId ? this.store.getThreadId(requestedTaskId) : null);
    // task_id alone means "show this task's conversation thread"; when both
    // thread_id and task_id are supplied, task_id narrows to that task.
    const taskId = filters.thread_id ? requestedTaskId : null;
    const rows = this.store.listMessages({
      threadId,
      taskId,
      from: filters.from || null,
      to: filters.to || null,
      replyTo: filters.reply_to || null,
      status: filters.status || null,
      limit: filters.limit
    });
    const thread = threadId ? this.store.getThread(threadId) : null;
    return {
      thread: thread
        ? {
          thread_id: thread.thread_id,
          root_task_id: thread.root_task_id,
          state: thread.state,
          exchange_count: thread.exchange_count,
          exchange_limit: this.config.agentMessageLimit,
          message_count: thread.message_count,
          last_message_id: thread.last_message_id,
          waiting_for_user: thread.state === 'WAITING_USER'
        }
        : null,
      messages: rows.map((row) => this.describeMessage(row))
    };
  }
}