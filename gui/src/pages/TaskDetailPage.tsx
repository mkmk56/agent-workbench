import { AlertTriangle, ArrowLeft, Copy, Database, RefreshCw, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineCode, Notice, RailCard } from '../components/Layout';
import { cancelTask, sendTask, useAgentInfo, useEngineStatus, useTaskDetail } from '../lib/engine';
import { setFlash, takeFlash } from '../lib/flash';
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
import { navigate } from '../lib/router';
import { copyText } from '../lib/workbench';
import type { LogEntry, LogStream, TaskStatus } from '../types';
import {
  AlertDialog,
  AppBadge,
  AppButton,
  AppEmptyState,
  AppIconButton,
  AppSearch,
  AppSegmented,
  AppStatus,
  AppSwitch,
  AppTextArea,
} from '../ui/astryx';

type LogFilter = 'all' | LogStream;

const STATUS_TONE: Record<TaskStatus, 'running' | 'success' | 'error' | 'neutral'> = {
  running: 'running',
  success: 'success',
  failed: 'error',
  cancelled: 'neutral',
  queued: 'neutral',
};

function renderLogMessage(message: string) {
  return message.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <InlineCode key={index}>{part.slice(1, -1)}</InlineCode>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

export function TaskDetailPage({ id }: { id: string }) {
  const detail = useTaskDetail(id);
  const engine = useEngineStatus(5_000);
  const agentState = useAgentInfo(30_000);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [followup, setFollowup] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [flash] = useState<string | null>(() => takeFlash());
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    text?: string;
  } | null>(flash ? { tone: 'success', title: flash } : null);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const task = detail.status;
  const agent = agentState.agents.find((item) => item.name === task?.agent);

  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return detail.logs.filter((entry) => {
      if (logFilter !== 'all' && entry.stream !== logFilter) {
        return false;
      }
      if (needle.length > 0) {
        return `${entry.message} ${LOG_STREAM_LABELS[entry.stream]}`.toLowerCase().includes(needle);
      }
      return true;
    });
  }, [detail.logs, logFilter, query]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [autoScroll, filteredLogs.length]);

  if (detail.loading && task == null) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">正在读取任务</h1>
            <p className="page-subtitle">正在从本地引擎读取任务状态与日志…</p>
          </div>
        </div>
        <AppEmptyState title="连接引擎中" description="任务状态与日志来自引擎 task_status / task_logs。" />
      </>
    );
  }

  if (task == null) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">任务未找到</h1>
            <p className="page-subtitle">
              引擎没有返回任务 #{id}。{detail.error ?? ''}
            </p>
          </div>
        </div>
        <AppEmptyState
          title="无法打开这个任务"
          description={detail.error ?? '请返回任务列表，或检查任务 ID。'}
          action={
            <div className="setting-inline">
              <AppButton
                label="重试"
                icon={<RefreshCw size={15} />}
                onClick={() => void detail.refresh()}
              />
              <AppButton
                label="返回任务列表"
                tone="secondary"
                icon={<ArrowLeft size={15} />}
                onClick={() => navigate('/tasks')}
              />
            </div>
          }
        />
      </>
    );
  }

  const taskStatus = toTaskStatus(task.state);
  const terminal =
    task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELLED';
  const title = taskDisplayTitle(task.task_id, task.summary);

  const copyLogs = async () => {
    const text = filteredLogs
      .map((entry) => `${entry.time} ${LOG_STREAM_LABELS[entry.stream]} ${entry.message}`)
      .join('\n');
    const ok = await copyText(text);
    setNotice({
      tone: ok ? 'success' : 'error',
      title: ok ? '日志已复制' : '复制失败',
      text: ok ? `已复制 ${filteredLogs.length} 行。` : '无法访问系统剪贴板。',
    });
  };

  const copyTaskId = async () => {
    const ok = await copyText(`#${task.task_id}`);
    setNotice({
      tone: ok ? 'success' : 'error',
      title: ok ? '任务 ID 已复制' : '复制失败',
      text: `#${task.task_id}`,
    });
  };

  const sendFollowup = async () => {
    if (followup.trim().length === 0) {
      setNotice({ tone: 'warning', title: '消息为空', text: '请输入跟进内容后再发送。' });
      return;
    }
    setActionBusy(true);
    try {
      const result = await sendTask(task.task_id, followup);
      if (!result.ok) {
        setNotice({ tone: 'error', title: '跟进消息未发送', text: result.error });
        return;
      }
      rememberTaskTitle(result.data.task_id, followup);
      setFlash(`跟进消息已发送；引擎在同一会话中创建任务 #${result.data.task_id}`);
      navigate(`/tasks/${result.data.task_id}`);
    } finally {
      setActionBusy(false);
    }
  };

  const confirmCancel = async () => {
    setCancelOpen(false);
    setActionBusy(true);
    try {
      const result = await cancelTask(task.task_id);
      if (!result.ok) {
        setNotice({ tone: 'error', title: '取消失败', text: result.error });
        return;
      }
      setNotice({
        tone: 'success',
        title: '取消请求已发送',
        text: `引擎返回状态：${result.data.status}。任务进程会在宽限期后结束。`,
      });
      await detail.refresh();
      await engine.refresh();
    } finally {
      setActionBusy(false);
    }
  };

  const openDataDir = async () => {
    const result = await window.workbench?.openDataDir();
    if (result?.ok) {
      setNotice({ tone: 'success', title: '已打开数据目录' });
    } else {
      setNotice({
        tone: 'warning',
        title: '无法打开数据目录',
        text: result?.error ?? '主进程未连接。',
      });
    }
  };

  const statusTone = STATUS_TONE[taskStatus];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="detail-title-row">
            <h1 className="detail-title">{title}</h1>
            <AppBadge tone={statusTone} label={STATUS_LABELS[taskStatus]} />
          </div>
          <p className="page-subtitle">
            执行器 <span className="mono">{task.agent}</span> · 状态{' '}
            <span className="mono">{ENGINE_STATE_LABELS[task.state]}</span> · 派发于{' '}
            {formatClock(task.created_at)}
          </p>
        </div>
        <div className="page-actions">
          <AppButton
            label="发送跟进"
            isDisabled={actionBusy}
            onClick={() => {
              composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.getElementById('followup')?.focus();
            }}
          />
          <AppButton
            label="取消任务"
            tone="danger"
            size="sm"
            isDisabled={terminal || actionBusy}
            title={terminal ? '任务已结束，无需取消' : '取消前会二次确认'}
            onClick={() => setCancelOpen(true)}
          />
        </div>
      </div>

      <div className="detail">
        <div className="detail-main">
          {detail.error != null && (
            <div className="banner banner--warning" role="status">
              <AlertTriangle size={16} className="icon banner__icon" aria-hidden="true" />
              <div className="banner__body">
                <div className="banner__title">实时更新出错</div>
                <div className="banner__desc">
                  {detail.error} 页面会继续按 1.2 秒间隔重试；已获取的日志保留在下方。
                </div>
              </div>
              <div className="banner__actions">
                <AppButton label="立即重试" size="sm" onClick={() => void detail.refresh()} />
              </div>
            </div>
          )}

          {task.blocker != null && (
            <div className="banner banner--warning" role="status">
              <AlertTriangle size={16} className="icon banner__icon" aria-hidden="true" />
              <div className="banner__body">
                <div className="banner__title">引擎报告阻塞</div>
                <div className="banner__desc">
                  blocker = <span className="mono">{task.blocker}</span>；请查看日志与执行器配置。
                </div>
              </div>
            </div>
          )}

          <section className="log-panel" aria-label="任务实时日志">
            <div className="log-toolbar">
              <AppSegmented
                label="日志筛选"
                size="sm"
                value={logFilter}
                onChange={(next) => setLogFilter(next as LogFilter)}
                segments={[
                  { value: 'all', label: '全部' },
                  { value: 'out', label: '输出' },
                  { value: 'warn', label: '警告' },
                  { value: 'system', label: '系统' },
                ]}
              />
              <div className="toolbar__spacer" />
              <AppSearch
                label="搜索日志"
                value={query}
                onChange={setQuery}
                placeholder="搜索日志"
              />
              <div className="switch-row">
                <span>自动滚动</span>
                <AppSwitch label="自动滚动" value={autoScroll} onChange={setAutoScroll} />
              </div>
              <AppIconButton
                label="复制日志"
                title="复制日志"
                icon={<Copy size={15} />}
                onClick={copyLogs}
              />
            </div>

            <div className="log-stream" role="log" aria-label="任务日志流" ref={logRef}>
              {filteredLogs.length === 0 ? (
                <div className="log-empty">
                  {detail.loading ? '正在读取日志…' : '暂无日志（引擎可能尚未写入输出）。'}
                </div>
              ) : (
                filteredLogs.map((entry: LogEntry) => (
                  <div className={`log-row log-row--${entry.stream}`} key={entry.line}>
                    <span className="log-row__ln">{String(entry.line).padStart(3, '0')}</span>
                    <span className="log-row__time">{entry.time}</span>
                    <span className="log-row__stream">{LOG_STREAM_LABELS[entry.stream]}</span>
                    <span className="log-row__msg">{renderLogMessage(entry.message)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="composer" ref={composerRef}>
              <div className="composer__row">
                <AppTextArea
                  id="followup"
                  label="跟进消息"
                  value={followup}
                  onChange={setFollowup}
                  placeholder="向该任务的会话发送跟进消息…"
                  rows={2}
                  containerClassName="composer-field"
                />
                <AppButton
                  label="发送"
                  tone="primary"
                  icon={<Send size={15} />}
                  isLoading={actionBusy}
                  isDisabled={actionBusy}
                  onClick={() => void sendFollowup()}
                />
              </div>
              <div className="composer__hint">
                <span>
                  <span className="kbd">Enter</span> 发送 · <span className="kbd">Shift</span> +{' '}
                  <span className="kbd">Enter</span> 换行
                </span>
                <span>task_send 会在同一会话中创建新的后续任务</span>
              </div>
            </div>

            {notice != null && (
              <div style={{ padding: '0 16px 16px' }}>
                <Notice tone={notice.tone} title={notice.title}>
                  {notice.text}
                </Notice>
              </div>
            )}
          </section>
        </div>

        <aside className="rail" aria-label="任务元数据">
          <RailCard
            title="任务信息"
            meta={
              <AppIconButton
                label="复制任务 ID"
                title="复制任务 ID"
                icon={<Copy size={14} />}
                onClick={copyTaskId}
              />
            }
          >
            <dl className="meta-list">
              <div className="meta-row">
                <dt>任务 ID</dt>
                <dd className="mono">#{task.task_id}</dd>
              </div>
              <div className="meta-row">
                <dt>会话 ID</dt>
                <dd className="mono">{task.session_id}</dd>
              </div>
              <div className="meta-row">
                <dt>执行器</dt>
                <dd className="mono">{task.agent}</dd>
              </div>
              <div className="meta-row">
                <dt>引擎状态</dt>
                <dd className="mono">{task.state}</dd>
              </div>
              <div className="meta-row">
                <dt>派发时间</dt>
                <dd>{formatClock(task.created_at)}</dd>
              </div>
              <div className="meta-row">
                <dt>最后活动</dt>
                <dd>
                  {formatRelative(task.last_activity_at)} · {formatClock(task.last_activity_at)}
                </dd>
              </div>
              <div className="meta-row">
                <dt>退出码</dt>
                <dd className="mono">{task.exit_code ?? '—'}</dd>
              </div>
              <div className="meta-row">
                <dt>Tokens</dt>
                <dd className="num">
                  输入 {task.tokens.input.toLocaleString()} · 输出{' '}
                  {task.tokens.output.toLocaleString()}
                </dd>
              </div>
              <div className="meta-row">
                <dt>修改文件</dt>
                <dd>{task.files_modified.length > 0 ? task.files_modified.join(', ') : '—'}</dd>
              </div>
            </dl>
            <div className="progress-block">
              <div className="progress-label">
                <span>已用时</span>
                <span className="num">{formatDuration(task.elapsed_ms)}</span>
              </div>
            </div>
          </RailCard>

          <RailCard
            title="执行器"
            meta={
              <AppStatus
                tone={agent?.available ? 'success' : agentState.loading ? 'neutral' : 'error'}
                label={agent?.available ? '可用' : agentState.loading ? '读取中' : '不可用'}
              />
            }
          >
            <div className="setting-inline">
              <span className="agent-name">{task.agent}</span>
              <span className="mono dim">
                {agent?.version ? `v${agent.version}` : '版本未知'}
              </span>
            </div>
            <dl className="meta-list" style={{ marginTop: '10px' }}>
              <div className="meta-row">
                <dt>模型</dt>
                <dd>{agent?.gateway?.model ?? '由执行器配置'}</dd>
              </div>
              <div className="meta-row">
                <dt>登录状态</dt>
                <dd>
                  {agent?.logged_in == null
                    ? '—'
                    : agent.logged_in
                      ? '已登录'
                      : '未登录'}
                </dd>
              </div>
              <div className="meta-row">
                <dt>续跑</dt>
                <dd>{agent?.resume_supported ? '支持' : '不支持（服务端拼接历史）'}</dd>
              </div>
              <div className="meta-row">
                <dt>当前任务</dt>
                <dd className="mono">{task.state}</dd>
              </div>
              <div className="meta-row">
                <dt>心跳</dt>
                <dd>{formatRelative(task.last_activity_at)}</dd>
              </div>
            </dl>
            {agent?.notes && <p className="rail-note">{agent.notes}</p>}
          </RailCard>

          <RailCard title="操作">
            <AppButton
              label="复制任务 ID"
              size="sm"
              icon={<Copy size={14} />}
              className="btn-block"
              onClick={copyTaskId}
            />
            <AppButton
              label="打开数据目录"
              size="sm"
              tone="ghost"
              icon={<Database size={14} />}
              className="btn-block"
              onClick={() => void openDataDir()}
            />
          </RailCard>
        </aside>
      </div>

      <AlertDialog
        isOpen={cancelOpen}
        onOpenChange={setCancelOpen}
        title="取消这个任务？"
        description="取消请求会中断执行器进程，引擎会把任务标记为 CANCELLED。此操作不可撤销。"
        cancelLabel="保留任务"
        actionLabel="取消任务"
        actionVariant="destructive"
        onAction={() => void confirmCancel()}
      />
    </>
  );
}