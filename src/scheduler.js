import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import crossSpawn from 'cross-spawn';
import { ORCH_STATE, PROCESS_STATE, TURN_STATE, deriveState } from './state.js';
import { claudeExecutor } from './executors/claude.js';
import { dshExecutor } from './executors/dsh.js';
import { killTree } from './executors/process.js';
import { issueAgentToken } from './auth.js';
import { cleanupTaskMcpConfig } from './mcp-config.js';

const EXECUTORS = { claude: claudeExecutor, dsh: dshExecutor };
const TERMINAL = new Set([ORCH_STATE.COMPLETED, ORCH_STATE.FAILED, ORCH_STATE.CANCELLED]);

function summaryText(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

export class Scheduler {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.queue = [];
    this.running = new Map();
    this.pumping = false;
    this.versionCache = null;
    this.sweepTimer = null;
    // reconcile() is called explicitly by server.js after MessageService is
    // wired (P1-1). Running it in the constructor would mark tasks failed
    // before the message layer exists, so pending deliveries could not replay.
  }

  _now() {
    return new Date().toISOString();
  }

  createTask({ agent, prompt, cwd, sessionId, model, timeoutMs, threadId, originMessageId, chatId }) {
    const executor = EXECUTORS[agent];
    if (!executor) throw new Error(`unknown agent: ${agent}`);
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('prompt must be a non-empty string');

    // Executors default to a workspace outside the repository. The old default
    // (repo root) contained workbench.env and made the master token readable.
    const dir = cwd || this.config.executorWorkspace || this.config.root;
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`cwd does not exist or is not a directory: ${dir}`);
    }

    let resume = false;
    let sessionIdFinal = sessionId || null;
    if (sessionIdFinal) {
      const session = this.store.getSession(sessionIdFinal);
      if (!session) throw new Error(`session not found: ${sessionIdFinal}`);
      if (session.agent !== agent) throw new Error(`session ${sessionIdFinal} belongs to ${session.agent}, not ${agent}`);
      resume = true;
    } else {
      sessionIdFinal = randomUUID();
    }
    this.store.ensureSession(sessionIdFinal, agent);

    const id = randomUUID();
    const now = this._now();
    const timeout = Math.max(1000, Number(timeoutMs) || this.config.taskTimeoutMs);
    const task = {
      id,
      session_id: sessionIdFinal,
      agent,
      cwd: dir,
      prompt,
      state: ORCH_STATE.PENDING,
      process_state: PROCESS_STATE.CREATED,
      turn_state: TURN_STATE.NONE,
      blocker: null,
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      exit_code: null,
      pid: null,
      tokens_json: null,
      files_modified_json: null,
      summary: null,
      timeout_ms: timeout,
      stale_after_ms: this.config.staleAfterMs,
      resume: resume ? 1 : 0,
      model: model || null
    };
    this.store.insertTask(task);
    this.store.setTaskThread(id, threadId || id, originMessageId || null);
    // P1-5: one execution row per run, written at creation with the provider
    // and model we can already prove. Claude's stream-json result later fills
    // the token/cost/latency columns; dsh reports usage from its ledger or
    // stays explicitly 'unknown'.
    this.store.insertExecution({
      execution_id: id,
      task_id: id,
      agent,
      provider: this._providerFor(agent),
      model: model || this._defaultModelFor(agent),
      session_id: sessionIdFinal,
      usage_source: 'pending',
      created_at: now,
      updated_at: now
    });
    // A chat sub-task keeps its own thread but is linked to the group chat, so
    // its conclusion can be stamped back into that chat.
    if (chatId) {
      this.store.linkChatTask(chatId, id);
      // Running a task in a chat makes the executor a participant, which is
      // also the unit of its token's read/dispatch scope.
      this.store.upsertChatParticipant({
        chat_id: chatId,
        participant_id: agent,
        kind: 'agent',
        role: agent,
        display_name: agent,
        auto_participate: true
      });
    }
    this.store.appendLog(id, 'system',
      `queued agent=${agent} cwd=${dir} thread=${threadId || id}${chatId ? ` chat=${chatId}` : ''}`);
    this.queue.push(id);
    this.pump();
    return { task_id: id, session_id: sessionIdFinal, status: ORCH_STATE.PENDING };
  }

  // Provider/model known at task creation. Claude's env tells us the gateway
  // and model; dsh's actual model comes from its usage ledger on completion, so
  // only the provider and an env override are recorded here.
  _providerFor(agent) {
    if (agent === 'claude') {
      return this.config.claudeEnv?.ANTHROPIC_BASE_URL ? 'gateway' : 'anthropic';
    }
    if (agent === 'dsh') return this.config.dshProvider || 'deepseek';
    return null;
  }

  _defaultModelFor(agent) {
    if (agent === 'claude') return this.config.claudeEnv?.ANTHROPIC_MODEL || null;
    if (agent === 'dsh') return this.config.dshModel || null;
    return null;
  }

  _limits() {
    let dsh = 0;
    for (const entry of this.running.values()) if (entry.agent === 'dsh') dsh += 1;
    return { total: this.running.size, dsh };
  }

  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let index = 0;
      while (index < this.queue.length) {
        const limits = this._limits();
        if (limits.total >= this.config.maxParallel) break;
        const taskId = this.queue[index];
        const task = this.store.getTask(taskId);
        if (!task || task.state !== ORCH_STATE.PENDING) {
          this.queue.splice(index, 1);
          continue;
        }
        if (task.agent === 'dsh' && limits.dsh >= this.config.dshParallel) {
          index += 1;
          continue;
        }
        this.queue.splice(index, 1);
        this.launch(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  launch(task) {
    const entry = {
      taskId: task.id,
      agent: task.agent,
      sessionId: task.session_id,
      startedAt: Date.now(),
      lastOutputAt: Date.now(),
      timeoutTimer: null,
      heartbeatTimer: null,
      cancel: null,
      result: null,
      cancelled: false,
      finished: false
    };
    this.running.set(task.id, entry);
    this.store.updateTask(task.id, {
      state: ORCH_STATE.STARTING,
      process_state: PROCESS_STATE.STARTING,
      turn_state: TURN_STATE.STARTING,
      last_activity_at: this._now()
    });
    this.store.appendLog(task.id, 'system', `starting ${task.agent}`);

    const ctx = {
      config: this.config,
      log: (stream, line) => {
        entry.lastOutputAt = Date.now();
        this.store.appendLog(task.id, stream, line);
      },
      setSessionId: (sessionId) => {
        if (!sessionId || sessionId === entry.sessionId) return;
        entry.sessionId = sessionId;
        this.store.updateTask(task.id, { session_id: sessionId });
      },
      setResult: (result) => {
        entry.result = result;
      },
      exit: (info) => this.finish(entry, info),
      history: task.resume ? this.store.getSessionMessages(task.session_id, 20) : []
    };

    // Agents need their own task id to call send_message; render placeholders
    // at launch time so the stored prompt stays reusable.
    const threadId = this.store.getThreadId(task.id);
    // A chat sub-task needs its chat id in the prompt so the agent can call
    // send_message with chat_id and land its conclusion in the right chat.
    const taskChatId = this.store.getChatForTask(task.id)?.chat_id ?? null;

    // Short-lived, task-bound credential. It is passed only to this executor
    // (private MCP config file / child env) and never written to the task row,
    // prompt or log. Expiry covers the task timeout plus a safety margin.
    const ttlMs = Math.max(60_000, (Number(task.timeout_ms) || this.config.taskTimeoutMs || 30 * 60 * 1000)
      + 5 * 60 * 1000);
    let authToken;
    let tokenKind = 'agent-task';
    try {
      authToken = issueAgentToken(this.config.token, {
        agent: task.agent,
        taskId: task.id,
        chatId: taskChatId,
        scope: taskChatId ? `chat:${taskChatId}` : 'task',
        ttlMs: Math.min(ttlMs, Number(this.config.agentTokenTtlMs) || ttlMs)
      });
    } catch (error) {
      // Rollback path from REFACTOR_PLAN §5.2: fall back to the static scoped
      // token and warn. Static tokens are rejected unless the installation
      // explicitly opted into the compatibility mode, so do not hand one to
      // the executor when it would only fail authentication later.
      if (!this.config.legacyAgentTokensEnabled) {
        const failure = new Error(`per-task token issue failed: ${error.message}`);
        this.store.appendLog(task.id, 'system', `failed to issue credential: ${failure.message}`);
        this.finish(entry, { code: null, signal: null, error: failure });
        return;
      }
      authToken = this.config.agentTokens?.[task.agent];
      tokenKind = 'agent-legacy';
      this.store.appendLog(task.id, 'system',
        `per-task token issue failed (${error.message}); using legacy scoped token`);
    }
    if (!authToken) throw new Error(`no credential available for agent ${task.agent}`);

    const gateBlock = this.approvals?.promptBlock(task) || '';
    const combinedPrompt = gateBlock
      ? `${gateBlock}\n\n---\n\n${String(task.prompt)}`
      : String(task.prompt);
    const renderedPrompt = combinedPrompt
      .replaceAll('{{task_id}}', task.id)
      .replaceAll('{{session_id}}', task.session_id)
      .replaceAll('{{thread_id}}', threadId)
      .replaceAll('{{chat_id}}', taskChatId ?? '')
      .replaceAll('{{agent}}', task.agent);
    if (gateBlock) {
      this.store.appendLog(task.id, 'system',
        `approval gate enabled; request_approval contract injected (agent=${task.agent})`);
    }

    try {
      const started = EXECUTORS[task.agent].start({
        ...task,
        prompt: renderedPrompt,
        thread_id: threadId,
        chat_id: taskChatId,
        auth_token: authToken,
        auth_token_kind: tokenKind
      }, ctx);
      entry.cancel = started.cancel;
      this.store.updateTask(task.id, {
        state: ORCH_STATE.WORKING,
        process_state: PROCESS_STATE.RUNNING,
        turn_state: TURN_STATE.WORKING,
        pid: started.pid ?? null,
        last_activity_at: this._now()
      });
      this.store.appendLog(task.id, 'system',
        `running pid=${started.pid ?? 'unknown'} auth=${tokenKind}`);
    } catch (error) {
      this.store.appendLog(task.id, 'system', `failed to start: ${error.message}`);
      this.finish(entry, { code: null, signal: null, error });
      return;
    }

    entry.timeoutTimer = setTimeout(() => {
      if (entry.finished) return;
      this.store.appendLog(task.id, 'system', `timeout after ${task.timeout_ms} ms`);
      entry.cancelled = true;
      try { entry.cancel?.(); } catch { /* ignore */ }
      this.finish(entry, { code: null, signal: null }, ORCH_STATE.FAILED, 'tooling');
    }, task.timeout_ms);

    entry.heartbeatTimer = setInterval(() => {
      if (entry.finished) return;
      if (Date.now() - entry.lastOutputAt >= this.config.heartbeatMs) {
        this.store.appendLog(task.id, 'system', 'heartbeat: no output');
        entry.lastOutputAt = Date.now();
      }
    }, this.config.heartbeatMs);
  }

  finish(entry, info, forcedState = null, forcedBlocker = null) {
    if (entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.timeoutTimer);
    clearInterval(entry.heartbeatTimer);
    this.running.delete(entry.taskId);

    const task = this.store.getTask(entry.taskId);
    if (!task) return;

    const wasCancelled = entry.cancelled || task.state === ORCH_STATE.CANCELLED;
    let state;
    let processState;
    let blocker = forcedBlocker;

    if (forcedState === ORCH_STATE.FAILED) {
      state = ORCH_STATE.FAILED;
      processState = PROCESS_STATE.EXITED_FAILURE;
      blocker = forcedBlocker || 'tooling';
    } else if (wasCancelled) {
      state = ORCH_STATE.CANCELLED;
      processState = PROCESS_STATE.CANCELLED;
      blocker = null;
    } else if (info?.error) {
      state = ORCH_STATE.FAILED;
      processState = PROCESS_STATE.EXITED_FAILURE;
      blocker = 'tooling';
      this.store.appendLog(task.id, 'system', `process error: ${info.error.message}`);
    } else if (info?.code === 0 && !entry.result?.isError) {
      state = ORCH_STATE.COMPLETED;
      processState = PROCESS_STATE.EXITED_SUCCESS;
      blocker = null;
    } else {
      state = ORCH_STATE.FAILED;
      processState = PROCESS_STATE.EXITED_FAILURE;
      blocker = null;
    }

    const summary = entry.result?.text?.trim() || null;
    this.store.updateTask(task.id, {
      state,
      process_state: processState,
      turn_state: state === ORCH_STATE.FAILED ? TURN_STATE.FAILED : TURN_STATE.IDLE,
      blocker,
      exit_code: info?.code ?? null,
      summary,
      tokens_json: entry.result?.tokens ? JSON.stringify(entry.result.tokens) : null,
      last_activity_at: this._now()
    });
    this._recordExecutionMetrics(task, entry, summary);
    if (summary) this.store.appendSessionMessage(entry.sessionId, 'assistant', summary);
    this.store.appendLog(task.id, 'system', `finished state=${state} exit=${info?.code ?? 'n/a'}`);
    this.pump();
    try {
      this.messages?.onTaskFinished(task.id);
    } catch (error) {
      this.store.appendLog(task.id, 'system', `message routing failed: ${error.message}`);
    }
    try {
      this.approvals?.onTaskFinished(task.id);
    } catch (error) {
      this.store.appendLog(task.id, 'system', `approval cleanup failed: ${error.message}`);
    }
    cleanupTaskMcpConfig(this.config, task.id);
  }

  _recordExecutionMetrics(task, entry, summary) {
    const metrics = entry.result?.metrics ?? null;
    const wallMs = Math.max(0, Date.now() - (entry.startedAt || Date.now()));
    const latencyMs = Number.isFinite(metrics?.latency_ms) ? Number(metrics.latency_ms) : wallMs;
    const provider = metrics?.provider ?? this._providerFor(task.agent);
    const model = metrics?.model ?? task.model ?? this._defaultModelFor(task.agent);
    const usageSource = metrics?.usage_source ?? (task.agent === 'dsh' ? 'unknown' : null);
    try {
      this.store.updateExecution(task.id, {
        provider,
        model,
        provider_request_id: metrics?.provider_request_id ?? null,
        token_usage_json: metrics?.token_usage_json ?? null,
        cost_usd: Number.isFinite(metrics?.cost_usd) ? Number(metrics.cost_usd) : null,
        latency_ms: latencyMs,
        session_id: entry.sessionId,
        usage_source: usageSource
      });
      // dsh always records a call row: even without a usage ledger the request
      // happened, and 'unknown' is a fact, not a zero.
      if (metrics || task.agent === 'dsh') {
        this.store.insertModelCall({
          execution_id: task.id,
          task_id: task.id,
          agent: task.agent,
          provider,
          model,
          provider_request_id: metrics?.provider_request_id ?? null,
          token_usage_json: metrics?.token_usage_json ?? null,
          cost_usd: Number.isFinite(metrics?.cost_usd) ? Number(metrics.cost_usd) : null,
          latency_ms: latencyMs,
          duration_api_ms: Number.isFinite(metrics?.duration_api_ms) ? Number(metrics.duration_api_ms) : null,
          ttft_ms: Number.isFinite(metrics?.ttft_ms) ? Number(metrics.ttft_ms) : null,
          usage_source: usageSource ?? 'unknown',
          request_summary: metrics?.request_summary ?? null,
          response_summary: metrics?.response_summary ?? summaryText(summary),
          session_id: entry.sessionId
        });
      }
      this.store.backfillMessageMetrics(task.id, {
        provider,
        model,
        tokenUsageJson: metrics?.token_usage_json ?? null,
        latencyMs
      });
    } catch (error) {
      this.store.appendLog(task.id, 'system', `execution record failed: ${error.message}`);
    }
  }

  cancel(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error('task not found');
    if (TERMINAL.has(task.state)) return { task_id: taskId, status: task.state };

    const queuedIndex = this.queue.indexOf(taskId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.store.updateTask(taskId, {
        state: ORCH_STATE.CANCELLED,
        process_state: PROCESS_STATE.CANCELLED,
        turn_state: TURN_STATE.NONE,
        blocker: null
      });
      this.store.appendLog(taskId, 'system', 'cancelled while queued');
      cleanupTaskMcpConfig(this.config, taskId);
      return { task_id: taskId, status: ORCH_STATE.CANCELLED };
    }

    const entry = this.running.get(taskId);
    if (entry) {
      entry.cancelled = true;
      this.store.appendLog(taskId, 'system', 'cancel requested');
      try { entry.cancel?.(); } catch { /* ignore */ }
      setTimeout(() => {
        if (entry.finished) return;
        this.store.appendLog(taskId, 'system', 'cancel grace expired; forcing finalize');
        this.finish(entry, { code: null, signal: null }, ORCH_STATE.CANCELLED);
      }, 5000);
      return { task_id: taskId, status: ORCH_STATE.CANCELLED };
    }

    this.store.updateTask(taskId, {
      state: ORCH_STATE.CANCELLED,
      process_state: PROCESS_STATE.CANCELLED
    });
    return { task_id: taskId, status: ORCH_STATE.CANCELLED };
  }

  statusPayload(task) {
    const state = deriveState(task);
    let tokens = { input: 0, output: 0 };
    let filesModified = [];
    try { if (task.tokens_json) tokens = JSON.parse(task.tokens_json); } catch { /* ignore */ }
    try { if (task.files_modified_json) filesModified = JSON.parse(task.files_modified_json); } catch { /* ignore */ }
    const created = Date.parse(task.created_at);
    const updated = Date.parse(task.updated_at);
    const thread = this.store.getThreadForTask(task.id);
    const approval = this.approvals?.describeForTask(task.id) ?? null;
    const execution = this.store.getExecutionForTask?.(task.id) ?? null;
    return {
      task_id: task.id,
      session_id: task.session_id,
      agent: task.agent,
      state,
      process_state: task.process_state,
      turn_state: task.turn_state,
      blocker: task.blocker,
      created_at: task.created_at,
      updated_at: task.updated_at,
      last_activity_at: task.last_activity_at,
      exit_code: task.exit_code,
      elapsed_ms: Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : 0,
      tokens,
      files_modified: filesModified,
      summary: task.summary,
      thread_id: thread.thread_id,
      chat_id: this.store.getChatForTask(task.id)?.chat_id ?? null,
      thread_state: thread.state,
      waiting_for_user: thread.state === 'WAITING_USER',
      exchange_count: thread.exchange_count ?? 0,
      exchange_limit: this.config.agentMessageLimit,
      message_count: thread.message_count ?? 0,
      approval_gate: {
        enabled: Boolean(this.config.agentApprovalGate)
      },
      approval,
      execution: execution ? {
        execution_id: execution.execution_id,
        provider: execution.provider ?? null,
        model: execution.model ?? null,
        provider_request_id: execution.provider_request_id ?? null,
        token_usage: (() => {
          try { return execution.token_usage_json ? JSON.parse(execution.token_usage_json) : null; } catch { return null; }
        })(),
        cost_usd: execution.cost_usd ?? null,
        latency_ms: execution.latency_ms ?? null,
        usage_source: execution.usage_source ?? null
      } : null
    };
  }

  async waitForTask(taskId, timeoutS = 30) {
    const seconds = Math.min(40, Math.max(1, Number(timeoutS) || 30));
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const task = this.store.getTask(taskId);
      if (!task) throw new Error('task not found');
      const payload = this.statusPayload(task);
      if (TERMINAL.has(payload.state) || Date.now() >= deadline) return payload;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ---------------------------------------------------------------------------
  // P1-1 startup reconciliation (D-4)
  //
  // Called by server.js after MessageService/ChatService are wired. Every
  // non-terminal task is failed with its origin message and delivery rows, then
  // pending/queued/retry-due deliveries are replayed. A periodic sweep is a
  // backstop for deliveries whose task-finished hook was lost.
  // ---------------------------------------------------------------------------
  reconcile({ replay = true, reason = 'service restart' } = {}) {
    const summary = {
      reason,
      failed_tasks: [],
      origin_messages_failed: [],
      deliveries_failed: [],
      replayed: { legacy: 0, chat: 0 },
      sweep_interval_ms: null
    };

    for (const task of this.store.nonTerminalTasks()) {
      this._markTaskFailed(task, reason, summary);
    }

    if (replay && this.messages) {
      try {
        const replayed = this.messages.replayPendingDeliveries({ reason });
        summary.replayed = replayed ?? summary.replayed;
      } catch (error) {
        console.error(`reconcile: delivery replay failed: ${error.message}`);
      }
      this._startSweep();
      summary.sweep_interval_ms = this.config.deliverySweepMs ?? 30_000;
    }

    console.log(
      `reconcile(${reason}): failed_tasks=${summary.failed_tasks.length}`
      + ` origin_messages_failed=${summary.origin_messages_failed.length}`
      + ` deliveries_failed=${summary.deliveries_failed.length}`
      + ` replayed_legacy=${summary.replayed.legacy} replayed_chat=${summary.replayed.chat}`
    );
    return summary;
  }

  _markTaskFailed(task, reason, summary) {
    if (task.pid) {
      try {
        process.kill(task.pid, 0);
        killTree(task.pid);
      } catch { /* already gone */ }
    }
    this.store.updateTask(task.id, {
      state: ORCH_STATE.FAILED,
      process_state: PROCESS_STATE.EXITED_FAILURE,
      turn_state: TURN_STATE.FAILED,
      blocker: 'tooling',
      exit_code: null
    });
    this.store.appendLog(task.id, 'system', `reconciled after ${reason}; marked FAILED`);

    // The originating message cannot be considered delivered: the task died
    // with the engine. Record the failure and the attempt so the chat history
    // explains why the agent went silent.
    const link = this.store.getTaskThread(task.id);
    if (link?.origin_message_id) {
      const origin = this.store.getMessage(link.origin_message_id);
      if (origin && origin.status !== 'answered') {
        this.store.updateMessage(origin.id, {
          status: 'failed',
          error: `task ${task.id} did not finish: ${reason}`
        });
        if (summary) summary.origin_messages_failed.push(origin.id);
      }
    }
    for (const delivery of this.store.deliveriesForTask(task.id)) {
      if (delivery.status === 'visible') continue;
      this.store.updateDelivery(delivery.message_id, delivery.agent, {
        status: 'failed',
        error_kind: 'task_failed',
        error: `task ${task.id} did not finish: ${reason}`,
        next_attempt_at: null
      });
      if (summary) summary.deliveries_failed.push(`${delivery.message_id}:${delivery.agent}`);
    }
    if (summary) summary.failed_tasks.push(task.id);
  }

  _startSweep() {
    if (this.sweepTimer) return;
    const interval = Math.max(5_000, Number(this.config.deliverySweepMs) || 30_000);
    this.sweepTimer = setInterval(() => {
      try {
        this.messages?.sweepDeliveries?.();
      } catch (error) {
        console.error(`delivery sweep failed: ${error.message}`);
      }
    }, interval);
    this.sweepTimer.unref?.();
  }

  _stopSweep() {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  _version(bin) {
    try {
      const result = crossSpawn.sync(bin, ['--version'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true
      });
      return result.status === 0 ? String(result.stdout).trim() : null;
    } catch {
      return null;
    }
  }

  agentInfo() {
    if (this.versionCache && Date.now() - this.versionCache.at < 60000) return this.versionCache.data;

    const claudeVersion = this._version(this.config.claudeBin);
    const dshVersion = this._version(this.config.dshBin);
    const claudeEnv = this.config.claudeEnv || {};
    const claudeGateway = claudeEnv.ANTHROPIC_BASE_URL
      ? { base_url: claudeEnv.ANTHROPIC_BASE_URL, model: claudeEnv.ANTHROPIC_MODEL || null }
      : null;
    let claudeLoggedIn = null;
    try {
      const result = crossSpawn.sync(this.config.claudeBin, ['auth', 'status'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true
      });
      claudeLoggedIn = JSON.parse(result.stdout || '{}')?.loggedIn ?? null;
    } catch {
      claudeLoggedIn = null;
    }

    const data = {
      message_protocol: {
        enabled: true,
        exchange_limit: this.config.agentMessageLimit,
        summary_max_tokens: this.config.agentSummaryMaxTokens,
        auto_deliver: this.config.agentAutoDeliver
      },
      chat_protocol: {
        senders: ['user', 'muse', 'claude', 'dsh'],
        agent_statuses: ['idle', 'pending', 'working', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'],
        exchange_limit_per_subtask_thread: this.config.agentMessageLimit,
        needs_muse: 'derived: a user message exists with no Muse message at or after it'
      },
      approval_gate: this.approvals?.info() ?? {
        enabled: Boolean(this.config.agentApprovalGate),
        categories: ['merge', 'delete', 'dependencies'],
        options: ['once', 'session', 'deny'],
        timeout_ms: this.config.approvalTimeoutMs
      },
      agents: [
        {
          name: 'claude',
          version: claudeVersion ? (claudeVersion.match(/\d+\.\d+\.\d+/) || [claudeVersion])[0] : null,
          available: Boolean(claudeVersion),
          capabilities: ['print_stream_json', 'resume', 'multi_turn', 'bypass_permissions'],
          resume_supported: true,
          logged_in: claudeLoggedIn,
          gateway: claudeGateway,
          notes: claudeGateway
            ? 'Uses ~/.claude/settings.json env (custom gateway); Anthropic login is not required.'
            : (claudeLoggedIn === false ? 'CLI is not logged in; run `claude auth login` once.' : null)
        },
        {
          name: 'dsh',
          version: dshVersion,
          available: Boolean(dshVersion),
          capabilities: ['headless_oneshot'],
          resume_supported: false,
          notes: 'Headless one-shot only; multi-turn is server-side history stitching.'
        }
      ]
    };
    this.versionCache = { at: Date.now(), data };
    return data;
  }

  // P1-1: reconcile before clearing. Running and queued tasks cannot survive
// this process, so they are failed (with their origin messages/deliveries)
// rather than left for the next start to guess about. No replay happens during
// shutdown; the next start's reconcile() replays whatever is still pending.
  shutdown({ reason = 'service shutdown' } = {}) {
    this._stopSweep();
    const summary = {
      reason, failed_tasks: [], origin_messages_failed: [], deliveries_failed: [],
      replayed: { legacy: 0, chat: 0 }
    };
    const inflight = [
      ...this.running.values(),
      ...[...new Set(this.queue)].map((taskId) => ({ taskId, cancel: null, timeoutTimer: null, heartbeatTimer: null }))
    ];
    for (const entry of inflight) {
      entry.cancelled = true;
      // Prevent a late child-exit callback from overwriting the FAILED state
      // we are about to write.
      entry.finished = true;
      clearTimeout(entry.timeoutTimer);
      clearInterval(entry.heartbeatTimer);
      try { entry.cancel?.(); } catch { /* ignore */ }
      const task = this.store.getTask(entry.taskId);
      if (task && !TERMINAL.has(task.state)) {
        this._markTaskFailed(task, reason, summary);
      }
      cleanupTaskMcpConfig(this.config, entry.taskId);
    }
    this.running.clear();
    this.queue = [];
    console.log(
      `shutdown reconcile(${reason}): failed_tasks=${summary.failed_tasks.length}`
      + ` origin_messages_failed=${summary.origin_messages_failed.length}`
      + ` deliveries_failed=${summary.deliveries_failed.length}`
    );
    return summary;
  }
}