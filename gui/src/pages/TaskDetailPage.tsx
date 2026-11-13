import { AlertTriangle, ArrowLeft, Copy, Database, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { InlineCode, Notice, RailCard } from '../components/Layout';
import { DEMO_LOGS, DEMO_TASKS, LOG_STREAM_LABELS, STATUS_LABELS } from '../data/demo';
import { navigate } from '../lib/router';
import { copyText } from '../lib/workbench';
import type { LogEntry } from '../types';
import {
  AlertDialog,
  AppBadge,
  AppButton,
  AppEmptyState,
  AppIconButton,
  AppProgress,
  AppSearch,
  AppSegmented,
  AppStatus,
  AppSwitch,
  AppTextArea,
} from '../ui/astryx';

type LogFilter = 'all' | LogEntry['stream'];

const STATUS_TONE = {
  running: 'running',
  success: 'success',
  failed: 'error',
  cancelled: 'neutral',
  queued: 'neutral',
} as const;

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
  const task = DEMO_TASKS.find((item) => item.id === id);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [query, setQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [followup, setFollowup] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'success' | 'warning' | 'error'; title: string; text?: string } | null>(
    null,
  );
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return DEMO_LOGS.filter((entry) => {
      if (logFilter !== 'all' && entry.stream !== logFilter) {
        return false;
      }
      if (needle.length > 0) {
        return `${entry.message} ${LOG_STREAM_LABELS[entry.stream]}`.toLowerCase().includes(needle);
      }
      return true;
    });
  }, [logFilter, query]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [autoScroll, filteredLogs.length]);

  if (!task) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">任务未找到</h1>
            <p className="page-subtitle">没有找到任务 #{id}。示例任务列表只包含 6 条记录。</p>
          </div>
        </div>
        <AppEmptyState
          title="无法打开这个任务"
          description="请返回任务列表，或在地址栏中检查任务 ID。"
          action={
            <AppButton
              label="返回任务列表"
              tone="secondary"
              icon={<ArrowLeft size={15} />}
              onClick={() => navigate('/tasks')}
            />
          }
        />
      </>
    );
  }

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
    const ok = await copyText(`#${task.id}`);
    setNotice({
      tone: ok ? 'success' : 'error',
      title: ok ? '任务 ID 已复制' : '复制失败',
      text: `#${task.id}`,
    });
  };

  const sendFollowup = () => {
    if (followup.trim().length === 0) {
      setNotice({ tone: 'warning', title: '消息为空', text: '请输入跟进内容后再发送。' });
      return;
    }
    setNotice({
      tone: 'warning',
      title: '跟进消息未发送',
      text: '引擎 IPC 尚未接入，本轮不会把消息写入任务上下文。',
    });
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

  const progress = task.status === 'success' || task.status === 'failed' ? 100 : task.status === 'running' ? 7.4 : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="detail-title-row">
            <h1 className="detail-title">{task.title}</h1>
            <AppBadge tone={STATUS_TONE[task.status]} label={STATUS_LABELS[task.status]} />
          </div>
          <p className="page-subtitle">
            执行器 <span className="mono">{task.executor}</span> · 开始于 {task.updatedAt} · 示例数据 ·
            引擎 IPC 未接入
          </p>
        </div>
        <div className="page-actions">
          <AppButton
            label="发送跟进"
            onClick={() => {
              composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.getElementById('followup')?.focus();
            }}
          />
          <AppButton
            label="取消任务"
            tone="danger"
            size="sm"
            title="取消前会二次确认"
            onClick={() => setCancelOpen(true)}
          />
        </div>
      </div>

      <div className="detail">
        <div className="detail-main">
          {task.status === 'running' && (
            <div className="banner banner--warning" role="status">
              <AlertTriangle size={16} className="icon banner__icon" aria-hidden="true" />
              <div className="banner__body">
                <div className="banner__title">执行器返回了未识别的模型标识</div>
                <div className="banner__desc">
                  日志中出现 deepseek-v4.1-flash。任务会继续运行，但模型信息可能不准确；请检查执行器配置。
                </div>
              </div>
              <div className="banner__actions">
                <AppButton label="查看配置" size="sm" onClick={() => navigate('/settings')} />
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
                <div className="log-empty">没有匹配的日志行。</div>
              ) : (
                filteredLogs.map((entry) => (
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
                  placeholder="向运行中的任务发送跟进消息…"
                  rows={2}
                  containerClassName="composer-field"
                />
                <AppButton
                  label="发送"
                  tone="primary"
                  icon={<Send size={15} />}
                  onClick={sendFollowup}
                />
              </div>
              <div className="composer__hint">
                <span>
                  <span className="kbd">Enter</span> 发送 · <span className="kbd">Shift</span> +{' '}
                  <span className="kbd">Enter</span> 换行
                </span>
                <span>发送接口尚未接入引擎 IPC</span>
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
                <dd className="mono">#{task.id}</dd>
              </div>
              <div className="meta-row">
                <dt>原始 ID</dt>
                <dd className="mono">{task.sha}</dd>
              </div>
              <div className="meta-row">
                <dt>执行器</dt>
                <dd className="mono">{task.executor}</dd>
              </div>
              <div className="meta-row">
                <dt>模型</dt>
                <dd>由执行器配置</dd>
              </div>
              <div className="meta-row">
                <dt>工作目录</dt>
                <dd className="mono">{task.workdir}</dd>
              </div>
              <div className="meta-row">
                <dt>派发时间</dt>
                <dd>{task.startedAt}</dd>
              </div>
              <div className="meta-row">
                <dt>超时</dt>
                <dd>30 分钟</dd>
              </div>
              <div className="meta-row">
                <dt>最后活动</dt>
                <dd>{task.updated}</dd>
              </div>
            </dl>
            <div className="progress-block">
              <div className="progress-label">
                <span>已用时</span>
                <span className="num">{task.duration} / 30:00</span>
              </div>
              <AppProgress label="已用时" value={progress} />
            </div>
          </RailCard>

          <RailCard title="执行器" meta={<AppStatus tone="neutral" label="待接入" />}>
            <div className="setting-inline">
              <span className="agent-name">{task.executor}</span>
              <span className="mono dim">PID —</span>
            </div>
            <dl className="meta-list" style={{ marginTop: '10px' }}>
              <div className="meta-row">
                <dt>心跳</dt>
                <dd>未连接</dd>
              </div>
              <div className="meta-row">
                <dt>模型</dt>
                <dd>由执行器配置</dd>
              </div>
              <div className="meta-row">
                <dt>当前任务</dt>
                <dd>—</dd>
              </div>
            </dl>
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
              onClick={openDataDir}
            />
          </RailCard>
        </aside>
      </div>

      <AlertDialog
        isOpen={cancelOpen}
        onOpenChange={setCancelOpen}
        title="取消这个任务？"
        description="取消请求会中断执行器。本轮尚未接入引擎 IPC，因此不会真正发送取消请求。"
        cancelLabel="保留任务"
        actionLabel="取消任务"
        actionVariant="destructive"
        onAction={() => {
          setCancelOpen(false);
          setNotice({
            tone: 'warning',
            title: '取消请求未发送',
            text: '引擎 IPC 尚未接入，任务状态保持不变。',
          });
        }}
      />
    </>
  );
}