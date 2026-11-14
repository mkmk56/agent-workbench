import { randomUUID } from 'node:crypto';
import { normalizeFiles, truncateSummary } from './messages.js';

// ---------------------------------------------------------------------------
// Critical-operation catalog
//
// This is the single source of truth shared by the engine, the agent prompt and
// docs/AGENT_HUD_APPROVAL.md. Keep the boundaries explicit: a vague catalog is
// worse than no gate because agents and users disagree about what needs asking.
// ---------------------------------------------------------------------------

export const APPROVAL_CATEGORIES = Object.freeze({
  merge: Object.freeze({
    key: 'merge',
    label_zh: '合并代码',
    label_en: 'merge / integrate / publish code',
    includes: [
      'git merge, git rebase, git cherry-pick',
      'git push, including --force, --force-with-lease and --tags',
      'git pull when it creates a merge or rebase (prefer git pull --ff-only)',
      'gh pr merge, or merging a pull request through an API'
    ],
    excludes: [
      'git fetch, git pull --ff-only, git status/diff/log/show',
      'git add, git commit, creating/switching branches, git stash push/pop',
      'opening a pull request when the branch was already pushed',
      'git revert of a single local commit'
    ],
    examples: ['git merge feature/login into main', 'git push origin main']
  }),
  delete: Object.freeze({
    key: 'delete',
    label_zh: '删文件',
    label_en: 'delete files / discard existing work',
    includes: [
      'rm, rm -rf, rmdir, del, erase, rd, Remove-Item, and scripted unlink/rmtree calls',
      'git rm, git clean -fd/-fdx, git reset --hard, git checkout -- <path>, git restore <path>',
      'git stash drop/clear, git branch -d/-D, git tag -d, git push --delete',
      'whole-file truncation or clobbering via shell redirection (> file, Set-Content, Out-File -Force)',
      'DROP TABLE, TRUNCATE TABLE, DELETE FROM without a WHERE clause'
    ],
    excludes: [
      'paths under node_modules/, dist/, build/, out/, coverage/, .cache/, tmp/, temp/, or the OS temp directory',
      'scratch files created by the current task, and emptying a file the task just created',
      'normal editing through the editor/apply-patch tools (not a deletion)',
      'git stash push/pop and DELETE FROM ... WHERE ... (ordinary row deletion)'
    ],
    examples: ['rm src/old-auth/session.ts', 'git clean -fd']
  }),
  dependencies: Object.freeze({
    key: 'dependencies',
    label_zh: '装依赖',
    label_en: 'install / remove / upgrade dependencies',
    includes: [
      'npm install <pkg>, npm uninstall, npm update, npm audit fix',
      'pnpm add/remove/update, yarn add/remove/upgrade, bun add/remove',
      'pip install/uninstall, poetry add/remove/update, uv add/remove',
      'cargo add/remove/update, go get, dotnet add package, composer require/remove',
      'gem install, winget/choco/scoop install (including global installs)',
      'editing dependency declarations or lockfiles (package.json deps, package-lock.json, pnpm-lock.yaml, yarn.lock, requirements.txt, poetry.lock, Cargo.toml deps/Cargo.lock, go.mod/go.sum, *.csproj PackageReference)'
    ],
    excludes: [
      'npm ci, pnpm install --frozen-lockfile, yarn install --frozen-lockfile (restore the lockfile exactly)',
      'npm test, npm run <script>, npx <tool> (no project manifest change)',
      'npm ls, npm outdated, pip list, reading manifests/lockfiles',
      'editing non-dependency package.json fields such as scripts or version'
    ],
    examples: ['npm install axios', 'pip install requests']
  })
});

export const APPROVAL_OPTIONS = Object.freeze(['once', 'session', 'deny']);

const POLL_MS = 200;
const AGENTS = new Set(['claude', 'dsh']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireText(value, name, max) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim().slice(0, max);
}

function optionalText(value, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function firstLine(text, max) {
  const line = String(text ?? '').split(/\r?\n/).find((part) => part.trim() !== '') || '';
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(1, max - 1))}…` : compact;
}

function shortLabel(value, fallback, max = 80) {
  const raw = typeof value === 'string' && value.trim() ? value : fallback;
  return firstLine(raw, max) || '未命名任务';
}

export function normalizeDecision(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['once', 'allow_once', 'allow-once', '一次', '允许一次'].includes(text)) return 'once';
  if (['session', 'allow_session', 'allow-session', '会话', '会话内允许', '这个会话内允许'].includes(text)) {
    return 'session';
  }
  if (['deny', 'reject', 'no', '拒绝', '不允许'].includes(text)) return 'deny';
  return null;
}

// Users answer in chat. Accept a JSON decision, the three Chinese labels, or
// the English equivalents. Deny is checked first so "不允许" cannot be read as
// "允许", and session is checked before once so "这个会话内允许" is not once.
export function parseApprovalDecision(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object' && typeof json.decision === 'string') {
      return normalizeDecision(json.decision);
    }
  } catch { /* not JSON */ }

  if (/(拒绝|不允许|不批准|不要|别做|停止|取消|deny|reject|not\s+allowed|do\s+not|cancel|\bno\b)/i.test(raw)) {
    return 'deny';
  }
  if (/(会话内|本会话|这个会话|此会话|以后都|后续都|总是|一直允许|allow\s*session|session\s*allow|always\s*allow)/i.test(raw)) {
    return 'session';
  }
  if (/(允许一次|这次允许|同意一次|仅这一次|只这一次|allow\s*once|approve\s*once|\bonce\b)/i.test(raw)) {
    return 'once';
  }
  if (/^(允许|同意|批准|approve|allow|yes|ok|session|once|deny)$/i.test(raw)) {
    return normalizeDecision(raw) || 'once';
  }
  return null;
}

export function buildApprovalPromptBlock(config, task) {
  if (!config?.agentApprovalGate) return '';

  if (task?.agent !== 'claude') {
    return [
      '[agent-workbench approval gate — ON]',
      'This runtime has no MCP client, so request_approval is unavailable here.',
      'Do not perform any merge, delete or dependency operation in this task.',
      'If one is required, stop and state exactly what you would do, which files are involved and why, so the user can approve it in a separate task.'
    ].join('\n');
  }

  const catalog = Object.values(APPROVAL_CATEGORIES)
    .map((category) => `- ${category.key} (${category.label_zh}): ${category.includes.join('; ')}. Not gated: ${category.excludes.join('; ')}.`)
    .join('\n');

  return [
    '[agent-workbench approval gate — ON]',
    'You MUST ask the user before any critical operation. Call the MCP tool',
    'mcp__agent-workbench__request_approval and wait for its result. The tool posts',
    'the question into the chat and blocks until the user answers or the approval',
    'timeout expires.',
    '',
    'Critical operations:',
    catalog,
    '',
    'When you call it, provide: agent={{agent}}, task_id={{task_id}}, category,',
    'action (who does what), files (every path involved), reason (why), and the',
    'exact command when known. Do not batch unrelated critical operations into one',
    'request, and do not call it when no critical operation is involved.',
    '',
    'Only after allowed:true may you perform the operation, and only the operation',
    'you listed. "once" covers this request; "session" also covers later critical',
    'operations of the same category in this thread.',
    'If allowed:false or stop:true, do not perform the operation. Tell the user it',
    'was denied and end your turn. Never retry a denied operation or work around it.'
  ].join('\n');
}

function buildApprovalCard({
  messageId, approvalId, agent, taskLabel, category, action, command, files, reason
}) {
  const meta = APPROVAL_CATEGORIES[category];
  const shownFiles = files.slice(0, 8);
  const fileLines = shownFiles.length
    ? shownFiles.map((file) => `- ${file}`)
    : ['- （未列出具体文件；请以操作说明与命令为准）'];
  if (files.length > shownFiles.length) {
    fileLines.push(`- … 另有 ${files.length - shownFiles.length} 个文件，完整清单见 files 字段`);
  }

  return [
    `[Agent HUD · 来自 ${agent} · ${taskLabel} ${messageId}] 关键操作需要你的批准`,
    `类别：${category}（${meta.label_zh}）`,
    `想做什么：${action}`,
    ...(command ? [`命令：${command}`] : []),
    '涉及文件：',
    ...fileLines,
    `为什么：${reason}`,
    `请三选一回复：允许一次 / 这个会话内允许 / 拒绝（approval_id=${approvalId}）`
  ].join('\n');
}

function buildApprovalQuestion(approvalId, category) {
  return `是否允许这次「${category}」操作？请回复：允许一次 / 这个会话内允许 / 拒绝。`
    + `也可调用 respond_approval（approval_id=${approvalId}，decision=once|session|deny）。`;
}

function decisionSummary(decision, reason) {
  const label = decision === 'once'
    ? '允许一次'
    : decision === 'session'
      ? '这个会话内允许'
      : '拒绝';
  const suffix = reason ? `：${String(reason).slice(0, 1000)}` : '';
  return `[approval] ${label}${suffix}`;
}

function parseFiles(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export class ApprovalService {
  constructor({ store, config, messages, scheduler }) {
    this.store = store;
    this.config = config;
    this.messages = messages;
    this.scheduler = scheduler;
  }

  info() {
    return {
      enabled: Boolean(this.config.agentApprovalGate),
      categories: Object.keys(APPROVAL_CATEGORIES),
      options: [...APPROVAL_OPTIONS],
      timeout_ms: this.config.approvalTimeoutMs,
      question_format: '[Agent HUD · 来自 <agent> · <task> <message-id>] <body>',
      enforcement: {
        mode: 'agent-honored',
        note: 'The engine asks in chat through request_approval; it cannot inspect commands executed inside an executor process. claude has the MCP client; dsh does not.'
      }
    };
  }

  promptBlock(task) {
    return buildApprovalPromptBlock(this.config, task);
  }

  describe(row) {
    if (!row) return null;
    const thread = this.store.getThread(row.thread_id);
    return {
      approval_id: row.id,
      thread_id: row.thread_id,
      task_id: row.task_id,
      agent: row.agent,
      category: row.category,
      action: row.action,
      command: row.command,
      files: parseFiles(row.files_json),
      reason: row.reason,
      message_id: row.message_id,
      response_message_id: row.response_message_id,
      status: row.status,
      decision: row.decision,
      error: row.error,
      created_at: row.created_at,
      responded_at: row.responded_at,
      thread_state: thread?.state ?? 'ACTIVE',
      waiting_for_user: thread?.state === 'WAITING_USER'
    };
  }

  describeForTask(taskId) {
    const pending = this.store.findPendingApprovalForTask(taskId);
    const last = pending || this.store.getLastApprovalForTask(taskId);
    return {
      gate_enabled: Boolean(this.config.agentApprovalGate),
      pending: pending ? this.describe(pending) : null,
      last: last ? this.describe(last) : null
    };
  }

  _log(taskId, line) {
    try { this.store.appendLog(taskId, 'system', line); } catch { /* task may be gone */ }
  }

  async request(input = {}) {
    const taskId = typeof input.task_id === 'string' ? input.task_id : '';
    const threadId = taskId ? this.store.getThreadId(taskId) : null;

    // Gate off: fully automatic, exactly the pre-phase-2 behaviour. This must be
    // the very first branch: any schema-valid call returns disabled even when it
    // omits files/command, and nothing below (input validation, ensureThread,
    // messages, waiting, thread state) may run. Phase-2 review M1 + N6.
    if (!this.config.agentApprovalGate) {
      return {
        approval_id: null,
        gate_enabled: false,
        asked: false,
        allowed: true,
        decision: 'disabled',
        stop: false,
        category: input.category ?? null,
        task_id: taskId || null,
        thread_id: threadId,
        instructions: 'Approval gate is off; proceed. No user question was sent.'
      };
    }

    const agent = input.agent;
    if (!AGENTS.has(agent)) throw new Error(`invalid agent: ${agent}`);
    if (!taskId) throw new Error('task_id is required');
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.agent !== agent) throw new Error(`task ${taskId} belongs to ${task.agent}, not ${agent}`);

    const category = input.category;
    if (!Object.hasOwn(APPROVAL_CATEGORIES, category)) {
      throw new Error(`invalid category: ${category}; expected one of ${Object.keys(APPROVAL_CATEGORIES).join(', ')}`);
    }
    const action = requireText(input.action, 'action', 2000);
    const reason = requireText(input.reason, 'reason', 4000);
    const command = optionalText(input.command, 4000);
    const files = normalizeFiles(input.files);
    if (category === 'delete' && files.length === 0) {
      throw new Error('delete approval requires at least one file path');
    }
    if (files.length === 0 && !command) {
      throw new Error('list at least one file or the command being approved');
    }

    this.store.ensureThread(threadId, threadId);

    const pending = this.store.findPendingApprovalForThread(threadId);
    if (pending) {
      throw new Error(`thread ${threadId} already has a pending approval: ${pending.id}`);
    }

    const grant = this.store.getApprovalGrant(threadId, category);
    if (grant) {
      this._log(taskId,
        `approval skipped: session grant for ${category} in thread ${threadId}`
        + ` source=${grant.source_approval_id ?? 'unknown'}`);
      return {
        approval_id: null,
        gate_enabled: true,
        asked: false,
        allowed: true,
        decision: 'session',
        stop: false,
        category,
        task_id: taskId,
        thread_id: threadId,
        grant_source: grant.source_approval_id ?? null,
        instructions: 'This category is already allowed for the session; proceed.'
      };
    }

    const approvalId = randomUUID();
    const messageId = randomUUID();
    const taskLabel = shortLabel(input.task, firstLine(task.prompt, 80));
    const card = buildApprovalCard({
      messageId,
      approvalId,
      agent,
      taskLabel,
      category,
      action,
      command,
      files,
      reason
    });
    const fitted = truncateSummary(card, this.config.agentSummaryMaxTokens);
    const question = buildApprovalQuestion(approvalId, category);

    // Send through the phase-1 message protocol so the question is a normal
    // thread message (reply_to works) and a report to the user is stored even
    // while the thread is WAITING_USER (phase-1 B1 invariant).
    this.messages.send({
      message_id: messageId,
      from: agent,
      to: 'user',
      task_id: taskId,
      summary: card,
      files,
      question,
      deliver: false
    });

    const now = new Date().toISOString();
    this.store.insertApproval({
      id: approvalId,
      thread_id: threadId,
      task_id: taskId,
      agent,
      category,
      action,
      command,
      files_json: JSON.stringify(files),
      reason,
      message_id: messageId,
      response_message_id: null,
      status: 'pending',
      decision: null,
      error: null,
      created_at: now,
      updated_at: now,
      responded_at: null
    });
    this.store.updateThread(threadId, { state: 'WAITING_USER' });
    this._log(taskId,
      `approval ${approvalId} requested agent=${agent} category=${category} message=${messageId}`
      + `; thread ${threadId} WAITING_USER${fitted.truncated ? ' (card truncated)' : ''}`);

    const resolved = await this._wait(approvalId, taskId, messageId);
    return {
      approval_id: resolved.approval_id,
      gate_enabled: true,
      asked: true,
      allowed: resolved.status === 'allowed',
      decision: resolved.decision,
      stop: resolved.status !== 'allowed',
      category: resolved.category,
      task_id: resolved.task_id,
      thread_id: resolved.thread_id,
      message_id: resolved.message_id,
      response_message_id: resolved.response_message_id,
      thread_state: resolved.thread_state,
      instructions: resolved.status === 'allowed'
        ? 'Approved; perform exactly the listed operation.'
        : 'Do not perform the operation; report the decision to the user and stop.'
    };
  }

  async _wait(approvalId, taskId, messageId) {
    const deadline = Date.now() + this.config.approvalTimeoutMs;
    let unparsedReplyId = null;

    for (;;) {
      const approval = this.store.getApproval(approvalId);
      if (!approval) throw new Error(`approval not found: ${approvalId}`);
      if (approval.status !== 'pending') return this.describe(approval);

      const reply = this.store.getReply(messageId);
      if (reply && reply.from_agent === 'user') {
        const decision = parseApprovalDecision(reply.summary);
        if (decision) {
          this._finalize(approval, decision, { source: 'chat_reply', responseMessageId: reply.id });
          continue;
        }
        if (unparsedReplyId !== reply.id) {
          unparsedReplyId = reply.id;
          this._log(taskId,
            `approval ${approvalId}: user reply ${reply.id} has no recognizable decision; still waiting`);
        }
        // A user message normally resets the thread to ACTIVE (phase-1 rule).
        // The approval is still unresolved, so park the thread again; otherwise
        // task_status would claim the user is not being waited on.
        const thread = this.store.getThread(approval.thread_id);
        if (thread && thread.state !== 'WAITING_USER') {
          this.store.updateThread(approval.thread_id, { state: 'WAITING_USER' });
        }
      }

      if (Date.now() >= deadline) {
        this._finalize(approval, 'timeout', { source: 'timeout' });
        continue;
      }
      await sleep(POLL_MS);
    }
  }

  respond(input = {}) {
    if (!this.config.agentApprovalGate) {
      throw new Error('approval gate is disabled (AGENT_APPROVAL_GATE=0)');
    }
    const decision = normalizeDecision(input.decision);
    if (!decision) throw new Error('decision must be once, session or deny');

    let approval = typeof input.approval_id === 'string' && input.approval_id
      ? this.store.getApproval(input.approval_id)
      : null;
    if (!approval && typeof input.task_id === 'string' && input.task_id) {
      approval = this.store.findPendingApprovalForTask(input.task_id);
    }
    if (!approval) throw new Error('pending approval not found');
    if (input.task_id && approval.task_id !== String(input.task_id)) {
      throw new Error('approval does not belong to the given task');
    }

    if (approval.status !== 'pending') {
      const resolved = this.describe(approval);
      return {
        ...resolved,
        allowed: resolved.status === 'allowed',
        stop: resolved.status !== 'allowed',
        already_resolved: true
      };
    }

    const existingReply = this.store.getReply(approval.message_id);
    let replyId = existingReply?.id ?? null;
    if (existingReply) {
      const parsed = parseApprovalDecision(existingReply.summary);
      // An ambiguous free-text reply can be resolved explicitly through this
      // tool; reply_to is unique, so do not try to write a second message.
      if (parsed && parsed !== decision) throw new Error(`approval already answered: ${parsed}`);
    } else {
      const reply = this.messages.send({
        from: 'user',
        to: approval.agent,
        task_id: approval.task_id,
        reply_to: approval.message_id,
        summary: decisionSummary(decision, input.reason),
        deliver: false
      });
      replyId = reply.message_id;
    }

    this._finalize(approval, decision, { source: 'respond_approval', responseMessageId: replyId });
    const resolved = this.describe(this.store.getApproval(approval.id));
    return {
      ...resolved,
      allowed: resolved.status === 'allowed',
      stop: resolved.status !== 'allowed',
      already_resolved: false
    };
  }

  _finalize(approval, decision, { source, responseMessageId = null } = {}) {
    const status = decision === 'deny' ? 'denied' : decision === 'timeout' ? 'timed_out' : 'allowed';
    const changed = this.store.finalizeApproval(approval.id, {
      status,
      decision,
      response_message_id: responseMessageId,
      responded_at: new Date().toISOString()
    });
    if (!changed) return false;
    if (decision === 'session') {
      this.store.addApprovalGrant(approval.thread_id, approval.category, approval.id);
    }
    this._log(approval.task_id,
      `approval ${approval.id} ${status} decision=${decision} source=${source}`
      + `${responseMessageId ? ` reply=${responseMessageId}` : ''}`);
    this._resumeThreadIfIdle(approval.thread_id);
    return true;
  }

  _resumeThreadIfIdle(threadId) {
    const thread = this.store.getThread(threadId);
    if (!thread || thread.state !== 'WAITING_USER') return;
    if (this.store.countPendingApprovalsForThread(threadId) > 0) return;
    // A phase-1 exchange-cap wait is not an approval wait: if the thread is
    // still at the cap, leave it waiting for an explicit user message.
    if (Number(thread.exchange_count ?? 0) >= this.config.agentMessageLimit) return;
    this.store.updateThread(threadId, { state: 'ACTIVE' });
  }

  // Called by the scheduler when a task reaches a terminal state. A task that
  // dies while its approval tool call is pending must not leave the thread
  // parked in WAITING_USER forever.
  onTaskFinished(taskId) {
    const expired = this.store.expirePendingApprovalsForTask(taskId, 'abandoned');
    for (const approval of expired) {
      this._log(taskId, `approval ${approval.id} abandoned: task ${taskId} finished`);
      this._resumeThreadIfIdle(approval.thread_id);
    }
  }

  // On engine restart, pending approvals cannot be answered any more: the
  // waiting tool call is gone. Mark them abandoned and release their threads.
  recover() {
    const expired = this.store.expireAllPendingApprovals('abandoned');
    for (const approval of expired) {
      this._resumeThreadIfIdle(approval.thread_id);
    }
    return expired.length;
  }

  list(filters = {}) {
    const rows = this.store.listApprovals({
      threadId: filters.thread_id || null,
      taskId: filters.task_id || null,
      status: filters.status || null,
      limit: filters.limit
    });
    return {
      gate_enabled: Boolean(this.config.agentApprovalGate),
      approvals: rows.map((row) => this.describe(row))
    };
  }
}