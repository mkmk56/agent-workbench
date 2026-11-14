import {
  Bot,
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock3,
  Copy,
  CornerDownRight,
  FileCode2,
  FilePenLine,
  MessageSquare,
  Play,
  ScrollText,
  ShieldAlert,
  Terminal,
  Timer,
} from 'lucide-react';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { copyText } from '../lib/workbench';
import { useHudConfig } from '../lib/hud';
import { formatClock, formatDuration, formatRelative } from '../lib/labels';
import type { EngineMessage, EngineTaskStatus, LogEntry } from '../types';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

interface Notice {
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  text?: string;
}

interface Card {
  key: string;
  tone: Tone;
  icon: ReactNode;
  title: string;
  meta?: string;
  open?: boolean;
  body: ReactNode;
  copyText?: string;
}

const APPROVAL_CATEGORY: Record<string, string> = {
  merge: '合并代码',
  delete: '删除文件/分支',
  dependencies: '安装或变更依赖',
};

const MESSAGE_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: '排队', tone: 'neutral' },
  delivered: { label: '已投递', tone: 'accent' },
  stored: { label: '已存储', tone: 'neutral' },
  answered: { label: '已回复', tone: 'success' },
  held: { label: '上限暂停', tone: 'warning' },
  failed: { label: '投递失败', tone: 'error' },
};

function findLog(
  logs: LogEntry[],
  pattern: RegExp,
  streams: LogEntry['stream'][] = ['system', 'warn'],
): LogEntry | null {
  for (const entry of logs) {
    if (streams.includes(entry.stream) && pattern.test(entry.message)) {
      return entry;
    }
  }
  return null;
}

function messageTone(message: EngineMessage): Tone {
  if (message.status === 'failed') {
    return 'error';
  }
  if (message.status === 'held' || message.waiting_for_user) {
    return 'warning';
  }
  if (message.from !== 'user' && message.to !== 'user') {
    return 'accent';
  }
  return 'neutral';
}

function participantLabel(value: string): string {
  if (value === 'user') {
    return '用户';
  }
  return value;
}

function FileChips({ files }: { files: string[] }) {
  if (files.length === 0) {
    return null;
  }
  return (
    <ul className="conv-files" aria-label="涉及文件">
      {files.map((file) => (
        <li key={file} className="conv-file">
          <FileCode2 size={12} aria-hidden="true" />
          <span className="mono">{file}</span>
        </li>
      ))}
    </ul>
  );
}

function CardView({
  card,
  onNotice,
  onJumpToLog,
}: {
  card: Card;
  onNotice: (notice: Notice) => void;
  onJumpToLog: () => void;
}) {
  const copy = async () => {
    if (card.copyText == null) {
      return;
    }
    const ok = await copyText(card.copyText);
    onNotice({
      tone: ok ? 'success' : 'error',
      title: ok ? '结论已复制' : '复制失败',
      text: ok ? `${card.title} 的正文已复制到剪贴板。` : '无法访问系统剪贴板。',
    });
  };

  return (
    <details className={`conv-card conv-card--${card.tone}`} open={card.open ?? true}>
      <summary className="conv-card__summary">
        <span className="conv-card__icon" aria-hidden="true">
          {card.icon}
        </span>
        <span className="conv-card__title">{card.title}</span>
        {card.meta != null && <span className="conv-card__meta">{card.meta}</span>}
        <ChevronDown size={14} className="conv-card__chevron" aria-hidden="true" />
      </summary>
      <div className="conv-card__body">{card.body}</div>
      {(card.copyText != null || card.tone === 'error') && (
        <div className="conv-card__actions">
          {card.copyText != null && (
            <button type="button" className="conv-action" onClick={() => void copy()}>
              <Copy size={12} aria-hidden="true" />
              复制结论
            </button>
          )}
          <button type="button" className="conv-action" onClick={onJumpToLog}>
            <ScrollText size={12} aria-hidden="true" />
            在日志中查看
          </button>
        </div>
      )}
    </details>
  );
}

function messageCard(
  message: EngineMessage,
  byId: Map<string, EngineMessage>,
): Card {
  const status = MESSAGE_STATUS[message.status] ?? {
    label: message.status,
    tone: 'neutral' as Tone,
  };
  const reply = message.reply_to != null ? byId.get(message.reply_to) : null;
  return {
    key: `message-${message.message_id}`,
    tone: messageTone(message),
    icon: <MessageSquare size={14} />,
    title: `${participantLabel(message.from)} → ${participantLabel(message.to)}`,
    meta: `${status.label} · ${message.summary_tokens} tokens · ${formatClock(message.created_at)}`,
    // Agent messages stay folded to one line by default; the observer expands
    // only the conclusions they care about.
    open: false,
    copyText: message.summary,
    body: (
      <>
        {reply != null && (
          <div className="conv-reply">
            <CornerDownRight size={12} aria-hidden="true" />
            <span>
              回复 {reply.message_id.slice(0, 8)}：{reply.summary.slice(0, 120)}
            </span>
          </div>
        )}
        <p className="conv-text">{message.summary}</p>
        <FileChips files={message.files} />
        {message.question != null && message.question.length > 0 && (
          <div className="conv-question">
            <strong>需要回答</strong>
            <p>{message.question}</p>
          </div>
        )}
        {message.waiting_for_user && (
          <p className="conv-waiting">线程处于 WAITING_USER，正在等你回复。</p>
        )}
        {message.error != null && <p className="conv-error-text">{message.error}</p>}
      </>
    ),
  };
}

export function ConversationPanel({
  task,
  logs,
  messages,
  messagesError,
  messagesSaturated,
  onNotice,
  onJumpToLog,
  onRespondApproval,
  approvalBusy,
}: {
  task: EngineTaskStatus;
  logs: LogEntry[];
  messages: EngineMessage[];
  messagesError: string | null;
  messagesSaturated: boolean;
  onNotice: (notice: Notice) => void;
  onJumpToLog: () => void;
  onRespondApproval: (decision: 'once' | 'session' | 'deny') => void;
  approvalBusy: boolean;
}) {
  const { config } = useHudConfig();
  const referenceTokens = config.contextWindowTokens;
  const pendingApproval = task.approval?.pending ?? null;
  const cards = useMemo(() => {
    const result: Card[] = [];
    const sortedMessages = [...messages].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );
    const byId = new Map(sortedMessages.map((message) => [message.message_id, message]));

    result.push({
      key: 'start',
      tone: 'neutral',
      icon: <Play size={14} />,
      title: '任务已派发',
      meta: `${task.agent} · ${formatClock(task.created_at)}`,
      body: (
        <dl className="conv-kv">
          <div>
            <dt>执行器</dt>
            <dd className="mono">{task.agent}</dd>
          </div>
          <div>
            <dt>会话</dt>
            <dd className="mono">{task.session_id}</dd>
          </div>
          <div>
            <dt>任务</dt>
            <dd className="mono">#{task.task_id}</dd>
          </div>
        </dl>
      ),
    });

    const commandLine = findLog(
      logs,
      /^(?:claude|dsh) command=.* source=.*$/,
    );
    const pidLine = findLog(logs, /running pid=\d+/);
    if (commandLine != null) {
      result.push({
        key: 'command',
        tone: 'neutral',
        icon: <Terminal size={14} />,
        title: '执行器已启动',
        meta: commandLine.time,
        body: (
          <>
            <p className="conv-text mono conv-break">{commandLine.message}</p>
            {pidLine != null && <p className="conv-muted mono">{pidLine.message}</p>}
          </>
        ),
      });
    }

    const timeoutLine = findLog(logs, /timeout after \d+ ms/);
    if (timeoutLine != null) {
      result.push({
        key: 'timeout',
        tone: 'warning',
        icon: <Timer size={14} />,
        title: '任务超时',
        meta: timeoutLine.time,
        body: <p className="conv-text">{timeoutLine.message}</p>,
      });
    }

    const exitLine = findLog(logs, /finished state=\S+ exit=\S+/);
    if (exitLine != null) {
      const finishedState =
        /finished state=(\S+)/.exec(exitLine.message)?.[1] ?? '';
      const failed = finishedState === 'FAILED';
      const cancelled = finishedState === 'CANCELLED';
      result.push({
        key: 'exit',
        tone: failed ? 'error' : cancelled ? 'neutral' : 'success',
        icon: failed ? <CircleX size={14} /> : <CircleCheck size={14} />,
        title: failed ? '执行器异常结束' : cancelled ? '执行器已取消' : '执行器已结束',
        meta: exitLine.time,
        body: <p className="conv-text mono">{exitLine.message}</p>,
      });
    }

    const failureLine = findLog(logs, /\bENOENT\b|^failed to start:/i);
    if (failureLine != null) {
      result.push({
        key: 'failure-line',
        tone: 'error',
        icon: <CircleX size={14} />,
        title: '执行器错误',
        meta: failureLine.time,
        body: <p className="conv-text mono conv-break">{failureLine.message}</p>,
      });
    }

    if (task.files_modified.length > 0) {
      result.push({
        key: 'files',
        tone: 'accent',
        icon: <FilePenLine size={14} />,
        title: `改动了 ${task.files_modified.length} 个文件`,
        meta: '来自 task_status.files_modified',
        body: <FileChips files={task.files_modified} />,
      });
    }

    for (const message of sortedMessages) {
      result.push(messageCard(message, byId));
    }

    if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED') {
      const tone: Tone =
        task.state === 'COMPLETED' ? 'success' : task.state === 'CANCELLED' ? 'neutral' : 'error';
      result.push({
        key: 'result',
        tone,
        icon:
          task.state === 'COMPLETED' ? (
            <CircleCheck size={14} />
          ) : task.state === 'FAILED' ? (
            <CircleX size={14} />
          ) : (
            <Clock3 size={14} />
          ),
        title:
          task.state === 'COMPLETED'
            ? '任务完成'
            : task.state === 'FAILED'
              ? '任务失败'
              : '任务已取消',
        meta: `${formatDuration(task.elapsed_ms)} · 输入 ${task.tokens.input.toLocaleString()} / 输出 ${task.tokens.output.toLocaleString()} tokens`,
        open: (task.summary?.length ?? 0) <= 600,
        copyText: task.summary ?? undefined,
        body:
          task.summary != null && task.summary.length > 0 ? (
            <p className="conv-text">{task.summary}</p>
          ) : (
            <p className="conv-muted">引擎未返回结果摘要。</p>
          ),
      });
    } else {
      result.push({
        key: 'running',
        tone: 'accent',
        icon: <Bot size={14} />,
        title: '任务正在执行',
        meta: `${formatRelative(task.last_activity_at)} · 已用时 ${formatDuration(task.elapsed_ms)}`,
        body: (
          <>
            <div className="conv-progress" aria-hidden="true">
              <span />
            </div>
            <p className="conv-muted">日志与结论会随引擎轮询持续更新。</p>
          </>
        ),
      });
    }

    return result;
  }, [logs, messages, task]);

  const inputTokens = task.tokens.input;
  const percent = Math.min(
    100,
    Math.round((inputTokens / Math.max(1, referenceTokens)) * 100),
  );
  const level = percent >= 95 ? 'error' : percent >= 80 ? 'warning' : 'normal';

  return (
    <section className="conversation-panel" aria-label="结论流">
      <div className="conversation-panel__head">
        <div>
          <h2 className="conversation-panel__title">结论流</h2>
          <p className="conversation-panel__source">
            task_status / task_logs / list_messages · 只读
          </p>
        </div>
      </div>

      <div className="context-meter">
        <div className="context-meter__row">
          <span>上下文占用（参考）</span>
          <span className="num">
            {inputTokens.toLocaleString()} / {referenceTokens.toLocaleString()} tokens · {percent}%
          </span>
        </div>
        <div className="progress">
          <div
            className={`progress__fill${level === 'normal' ? '' : ` progress__fill--${level}`}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="context-meter__note">
          引擎未返回上下文上限；按 {referenceTokens.toLocaleString()} 参考值估算（可在设置中调整）。输出{' '}
          {task.tokens.output.toLocaleString()} tokens。
        </p>
      </div>

      {messagesError != null && (
        <div className="conv-inline-error" role="status">
          <MessageSquare size={14} aria-hidden="true" />
          <span>会话消息读取失败：{messagesError}</span>
        </div>
      )}
      {messagesSaturated && (
        <div className="conv-inline-warning" role="status">
          <MessageSquare size={14} aria-hidden="true" />
          <span>
            该会话消息达到 500 条窗口上限；`list_messages` 按时间正序返回，更新的消息不会出现在结论流中。
          </span>
        </div>
      )}

      {pendingApproval != null && (
        <div className="approval-card" role="alert">
          <div className="approval-card__head">
            <ShieldAlert size={16} aria-hidden="true" />
            <strong>关键操作需要你的批准</strong>
            <span className="approval-card__category">
              {APPROVAL_CATEGORY[pendingApproval.category] ?? pendingApproval.category}
            </span>
          </div>
          <p className="approval-card__action">{pendingApproval.action}</p>
          <dl className="approval-card__meta">
            <dt>谁</dt>
            <dd className="mono">{pendingApproval.agent}</dd>
            <dt>命令</dt>
            <dd className="mono conv-break">{pendingApproval.command ?? '—'}</dd>
            <dt>为什么</dt>
            <dd>{pendingApproval.reason}</dd>
          </dl>
          <FileChips files={pendingApproval.files} />
          <div className="approval-card__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={approvalBusy}
              onClick={() => onRespondApproval('once')}
            >
              允许一次
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={approvalBusy}
              onClick={() => onRespondApproval('session')}
            >
              本会话允许
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={approvalBusy}
              onClick={() => onRespondApproval('deny')}
            >
              拒绝
            </button>
          </div>
          <p className="approval-card__hint">
            拒绝或超时后 agent 会停止该操作；审批门关闭时不会出现此卡片。
          </p>
        </div>
      )}

      <div className="conversation-stream">
        {cards.map((card) => (
          <CardView
            key={card.key}
            card={card}
            onNotice={onNotice}
            onJumpToLog={onJumpToLog}
          />
        ))}
      </div>
    </section>
  );
}