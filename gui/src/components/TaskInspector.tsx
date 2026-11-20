import {
  Bot,
  ChevronDown,
  CircleAlert,
  Copy,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Timer,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelTask,
  respondApproval,
  sendTask,
  startTask,
  useTaskDetail,
  useTaskMessages,
} from '../lib/engine';
import {
  ENGINE_STATE_LABELS,
  LOG_STREAM_LABELS,
  STATUS_LABELS,
  formatClock,
  formatDuration,
  formatRelative,
  rememberTaskTitle,
  taskDisplayTitle,
  toTaskStatus,
} from '../lib/labels';
import {
  INSPECTOR_DEFAULT_WIDTH,
  clampInspectorWidth,
  dragInspectorWidth,
  nudgeInspectorWidth,
  readInspectorLayout,
  retryCwdOf,
  retryPromptOf,
  writeInspectorLayout,
  type PanelStorage,
} from '../lib/chat-panels';
import { copyText } from '../lib/workbench';
import type { LogEntry, LogStream, TaskStatus } from '../types';
import { ConversationPanel } from './ConversationPanel';

type LogFilter = 'all' | LogStream;
type Notice = { tone: 'info' | 'success' | 'warning' | 'error'; title: string; text?: string };

const STATUS_TONE: Record<TaskStatus, string> = {
  running: 'is-running',
  success: 'is-success',
  failed: 'is-error',
  cancelled: 'is-muted',
  queued: 'is-muted',
};

/** Labels only — the tone classes above carry the colour. */
const STATUS_TEXT: Record<TaskStatus, string> = STATUS_LABELS;

function storage(): PanelStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * REA Phase 4 [A]: the in-chat task inspector.
 *
 * A right-hand drawer over the chat stream (D1 option A). All data comes from
 * the same three engine tools TaskDetailPage uses (`task_status`, `task_logs`,
 * `list_messages`), and the conclusion / approval / file cards reuse
 * ConversationPanel so the two detail surfaces never drift apart.
 *
 * There is no step progress in the engine (executors report no steps), so the
 * drawer shows elapsed time + last activity + state instead of a fake percent.
 */
export function TaskInspector({
  taskId,
  onClose,
}: {
  taskId: string;
  /** Esc / scrim / the close button. The parent owns which task is open. */
  onClose: () => void;
}) {
  const detail = useTaskDetail(taskId);
  const taskMessages = useTaskMessages(taskId);
  const [width, setWidth] = useState(() => {
    const stored = readInspectorLayout(storage());
    return stored?.width ?? INSPECTOR_DEFAULT_WIDTH;
  });
  const [logsOpen, setLogsOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [followup, setFollowup] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const task = detail.status;

  // Drawer width survives a restart (same storage contract as the sidebar).
  useEffect(() => {
    writeInspectorLayout(storage(), { width });
  }, [width]);

  // Esc closes the drawer from anywhere inside the chat page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return detail.logs.filter((entry) => {
      if (logFilter !== 'all' && entry.stream !== logFilter) {
        return false;
      }
      if (needle.length === 0) {
        return true;
      }
      return `${entry.message} ${LOG_STREAM_LABELS[entry.stream]}`.toLowerCase().includes(needle);
    });
  }, [detail.logs, logFilter, query]);

  useEffect(() => {
    if (logsOpen && logRef.current != null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logsOpen, filteredLogs.length]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
  };

  const onDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag == null) {
      return;
    }
    // Dragging the left edge: moving left widens the drawer.
    setWidth(dragInspectorWidth(drag.startWidth, drag.startX - event.clientX));
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  };

  const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth((current) => nudgeInspectorWidth(current, 1));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth((current) => nudgeInspectorWidth(current, -1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setWidth(clampInspectorWidth(INSPECTOR_DEFAULT_WIDTH));
    }
  };

  const copyPath = async (path: string) => {
    const ok = await copyText(path);
    setNotice({
      tone: ok ? 'success' : 'error',
      title: ok ? '路径已复制' : '复制失败',
      text: path,
    });
  };

  const runCancel = async () => {
    if (task == null) {
      return;
    }
    setCancelOpen(false);
    setBusy(true);
    try {
      const result = await cancelTask(task.task_id);
      setNotice(
        result.ok
          ? {
              tone: 'success',
              title: '取消请求已发送',
              text: `引擎返回状态：${result.data.status}。`,
            }
          : { tone: 'error', title: '取消失败', text: result.error },
      );
      await detail.refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Retry re-runs the task with the parameters the engine recorded: the same
   * executor, the stored `prompt` and the stored `cwd` (both now returned by
   * `task_status`). `summary` is the finished task's *result* text and must
   * never be reused as the input prompt — when the engine does not send the
   * original prompt the action is disabled instead of inventing one.
   */
  const retryPrompt = retryPromptOf(task);
  const retryCwd = retryCwdOf(task);

  const runRetry = async () => {
    if (task == null || retryPrompt == null) {
      setNotice({
        tone: 'warning',
        title: '无法按原参数重跑',
        text: '引擎没有返回该任务的原 prompt，重跑会变成另一个任务。',
      });
      return;
    }
    setBusy(true);
    try {
      const result = await startTask({
        agent: task.agent,
        prompt: retryPrompt,
        ...(retryCwd != null ? { cwd: retryCwd } : {}),
      });
      if (!result.ok) {
        setNotice({ tone: 'error', title: '重跑失败', text: result.error });
        return;
      }
      rememberTaskTitle(result.data.task_id, `重跑 #${task.task_id}`);
      setNotice({
        tone: 'success',
        title: '已用原参数重跑',
        text: `新任务 #${result.data.task_id}（执行器 ${task.agent}${
          retryCwd != null ? `，工作目录 ${retryCwd}` : ''
        }）。`,
      });
    } finally {
      setBusy(false);
    }
  };

  const runFollowup = async () => {
    if (task == null) {
      return;
    }
    const text = followup.trim();
    if (text.length === 0) {
      setNotice({ tone: 'warning', title: '消息为空', text: '请输入追问内容。' });
      return;
    }
    setBusy(true);
    try {
      const result = await sendTask(task.task_id, text);
      if (!result.ok) {
        setNotice({ tone: 'error', title: '追问未发送', text: result.error });
        return;
      }
      rememberTaskTitle(result.data.task_id, text);
      setFollowup('');
      setNotice({
        tone: 'success',
        title: '追问已发出',
        text: `引擎在同一会话中创建任务 #${result.data.task_id}。`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleApproval = async (decision: 'once' | 'session' | 'deny') => {
    if (task == null) {
      return;
    }
    setBusy(true);
    try {
      const result = await respondApproval({ taskId: task.task_id, decision });
      setNotice(
        result.ok
          ? {
              tone: result.data.allowed === false ? 'warning' : 'success',
              title: result.data.allowed === false ? '已拒绝该操作' : '已允许该操作',
            }
          : { tone: 'error', title: '审批未提交', text: result.error },
      );
      await detail.refresh();
    } finally {
      setBusy(false);
    }
  };

  const terminal =
    task != null &&
    (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED');
  const status = task != null ? toTaskStatus(task.state) : null;

  return (
    <>
      <div className="chat-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        className="inspector"
        style={{ width }}
        role="complementary"
        aria-label="任务详情面板"
      >
        <div
          className="inspector__resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整任务面板宽度"
          aria-valuemin={320}
          aria-valuemax={760}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onResizeKey}
          onDoubleClick={() => setWidth(INSPECTOR_DEFAULT_WIDTH)}
        />

        <header className="inspector__head">
          <div className="inspector__title-row">
            <h2 className="inspector__title">
              {task != null ? taskDisplayTitle(task.task_id, task.summary) : '任务详情'}
            </h2>
            {status != null && (
              <span className={`inspector__status ${STATUS_TONE[status]}`}>
                {STATUS_TEXT[status]}
              </span>
            )}
            <button
              type="button"
              className="inspector__close"
              aria-label="关闭任务面板"
              title="关闭（Esc）"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {task != null ? (
            <p className="inspector__meta">
              <span className="mono">#{task.task_id}</span> · 执行器{' '}
              <span className="mono">{task.agent}</span> ·{' '}
              <span className="mono">{ENGINE_STATE_LABELS[task.state]}</span> · 已用时{' '}
              {formatDuration(task.elapsed_ms)} · 最后活动 {formatRelative(task.last_activity_at)}
            </p>
          ) : (
            <p className="inspector__meta">
              {detail.loading ? '正在读取任务状态…' : (detail.error ?? '引擎未返回该任务。')}
            </p>
          )}
        </header>

        {task != null && (
          <div className="inspector__actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={terminal || busy}
              title={terminal ? '任务已结束' : '中断执行器进程'}
              onClick={() => setCancelOpen(true)}
            >
              <CircleAlert size={13} aria-hidden="true" />
              取消任务
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!terminal || busy || retryPrompt == null}
              title={
                terminal
                  ? retryPrompt == null
                    ? '引擎没有返回原 prompt，无法按原参数重跑'
                    : '用原执行器、原 prompt 与原工作目录重新开始'
                  : '只有已结束的任务可以重跑'
              }
              onClick={() => void runRetry()}
            >
              <RotateCw size={13} aria-hidden="true" />
              重试
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void detail.refresh()}
              disabled={busy}
            >
              <RefreshCw size={13} aria-hidden="true" />
              刷新
            </button>
          </div>
        )}

        {cancelOpen && (
          <div className="inspector__confirm" role="alert">
            <p>取消会中断执行器进程，任务会被标记为 CANCELLED。确定取消？</p>
            <div className="inspector__confirm-actions">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => void runCancel()}
              >
                确认取消
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setCancelOpen(false)}
              >
                保留任务
              </button>
            </div>
          </div>
        )}

        {notice != null && (
          <div className={`inspector__notice is-${notice.tone}`} role="status">
            <strong>{notice.title}</strong>
            {notice.text != null && <span>{notice.text}</span>}
            <button
              type="button"
              className="inspector__notice-close"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="inspector__body">
          {detail.error != null && (
            <p className="inspector__warn" role="status">
              <CircleAlert size={13} aria-hidden="true" />
              实时更新出错：{detail.error}
            </p>
          )}

          {task != null && (
            <>
              <section className="inspector__section" aria-label="进度">
                <h3 className="inspector__section-title">进度</h3>
                <dl className="inspector__kv">
                  <div>
                    <dt>状态</dt>
                    <dd>{STATUS_TEXT[toTaskStatus(task.state)]}</dd>
                  </div>
                  <div>
                    <dt>已耗时</dt>
                    <dd>{formatDuration(task.elapsed_ms)}</dd>
                  </div>
                  <div>
                    <dt>最后活动</dt>
                    <dd>
                      {formatRelative(task.last_activity_at)} ·{' '}
                      {formatClock(task.last_activity_at)}
                    </dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>
                      输入 {task.tokens.input.toLocaleString()} · 输出{' '}
                      {task.tokens.output.toLocaleString()}
                    </dd>
                  </div>
                </dl>
                <p className="inspector__hint">
                  执行器未提供步骤进度，因此这里不显示百分比。
                </p>
              </section>

              <ConversationPanel
                task={task}
                logs={detail.logs}
                messages={taskMessages.messages}
                messagesError={taskMessages.error}
                messagesSaturated={taskMessages.saturated}
                onNotice={(next) => setNotice(next)}
                onJumpToLog={() => setLogsOpen(true)}
                onRespondApproval={(decision) => void handleApproval(decision)}
                approvalBusy={busy}
              />

              {task.files_modified.length > 0 && (
                <section className="inspector__section" aria-label="修改的文件">
                  <h3 className="inspector__section-title">
                    <Bot size={13} aria-hidden="true" />
                    修改的文件（{task.files_modified.length}）
                  </h3>
                  <ul className="inspector__files">
                    {task.files_modified.map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          title="点击复制路径"
                          onClick={() => void copyPath(path)}
                        >
                          <Copy size={11} aria-hidden="true" />
                          <span className="mono">{path}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="inspector__hint">
                    引擎只上报宿主机路径、不提供文件体，因此这里只能复制路径，无法内联预览。
                  </p>
                </section>
              )}
            </>
          )}

          <section className="inspector__section inspector__section--logs" aria-label="任务日志">
            <button
              type="button"
              className="inspector__fold"
              aria-expanded={logsOpen}
              onClick={() => setLogsOpen(!logsOpen)}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={logsOpen ? 'is-open' : undefined}
              />
              日志（{detail.logs.length}）
              <span className="inspector__fold-hint">{logsOpen ? '收起' : '展开'}</span>
            </button>
            {logsOpen && (
              <>
                <div className="inspector__log-toolbar">
                  <div className="inspector__log-filters" role="group" aria-label="日志筛选">
                    {(['all', 'out', 'warn', 'system'] as LogFilter[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={`inspector__chip${logFilter === value ? ' is-active' : ''}`}
                        aria-pressed={logFilter === value}
                        onClick={() => setLogFilter(value)}
                      >
                        {value === 'all' ? '全部' : LOG_STREAM_LABELS[value]}
                      </button>
                    ))}
                  </div>
                  <label className="inspector__log-search">
                    <Search size={12} aria-hidden="true" />
                    <input
                      type="search"
                      value={query}
                      aria-label="搜索日志"
                      placeholder="搜索日志"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                </div>
                <div className="inspector__logs" role="log" ref={logRef}>
                  {filteredLogs.length === 0 ? (
                    <p className="inspector__logs-empty">
                      {detail.loading ? '正在读取日志…' : '暂无日志。'}
                    </p>
                  ) : (
                    filteredLogs.map((entry: LogEntry) => (
                      <div
                        className={`inspector__log-row is-${entry.stream}`}
                        key={`${entry.line}-${entry.time}`}
                      >
                        <span className="inspector__log-time">{entry.time}</span>
                        <span className="inspector__log-msg">{entry.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>

          {task != null && (
            <section className="inspector__section" aria-label="追问">
              <h3 className="inspector__section-title">
                <Send size={13} aria-hidden="true" />
                追问
              </h3>
              <div className="inspector__followup">
                <textarea
                  value={followup}
                  rows={2}
                  aria-label="追问内容"
                  placeholder="向这个任务的会话继续发消息…"
                  onChange={(event) => setFollowup(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void runFollowup()}
                >
                  发送
                </button>
              </div>
              <p className="inspector__hint">
                追问通过 task_send 在同一会话中创建新任务；<Timer size={11} aria-hidden="true" />{' '}
                重试会按 task_status 返回的原 prompt 与原工作目录重新开始
                {retryPrompt == null ? '（本次引擎未返回原 prompt，重试已禁用）' : ''}。
              </p>
            </section>
          )}

          {task != null && terminal && (
            <p className="inspector__hint">
              <Play size={11} aria-hidden="true" /> 任务已结束。
            </p>
          )}
        </div>
      </aside>
    </>
  );
}