import { ChevronRight, Plus, RefreshCw, Server, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHead, Panel, RailCard } from '../components/Layout';
import { startEngine, useAgentInfo, useEngineStatus, useTaskList } from '../lib/engine';
import {
  ENGINE_STATE_LABELS,
  STATUS_LABELS,
  formatClock,
  formatDuration,
  formatRelative,
  formatUptime,
} from '../lib/labels';
import { navigate } from '../lib/router';
import type { TaskRow, TaskStatus, Executor } from '../types';
import {
  AppBadge,
  AppButton,
  AppEmptyState,
  AppIconButton,
  AppSearch,
  AppSegmented,
  AppStatus,
  Table,
  proportional,
} from '../ui/astryx';

type StatusFilter = 'all' | TaskStatus;
type ExecutorFilter = 'all' | Executor;

const STATUS_TONE = {
  running: 'running',
  success: 'success',
  failed: 'error',
  cancelled: 'neutral',
  queued: 'neutral',
} as const;

function displayStatus(task: TaskRow): {
  tone: 'running' | 'success' | 'error' | 'neutral';
  label: string;
} {
  if (task.engineState === 'BLOCKED') {
    return { tone: 'error', label: '阻塞' };
  }
  if (task.engineState === 'STALE') {
    return { tone: 'error', label: '静默' };
  }
  if (task.engineState === 'WAITING') {
    return { tone: 'running', label: '等待中' };
  }
  return { tone: STATUS_TONE[task.status], label: STATUS_LABELS[task.status] };
}

export function TasksPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [executor, setExecutor] = useState<ExecutorFilter>('all');
  const [query, setQuery] = useState('');
  const [starting, setStarting] = useState(false);

  const tasksState = useTaskList(200, 5_000);
  const engine = useEngineStatus(5_000);
  const agentsState = useAgentInfo(30_000);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: tasksState.tasks.length };
    for (const task of tasksState.tasks) {
      result[task.status] = (result[task.status] ?? 0) + 1;
    }
    return result;
  }, [tasksState.tasks]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasksState.tasks.filter((task) => {
      if (filter !== 'all' && task.status !== filter) {
        return false;
      }
      if (executor !== 'all' && task.executor !== executor) {
        return false;
      }
      if (needle.length > 0) {
        const haystack = `${task.title} ${task.id} ${task.executor} ${task.sessionId}`.toLowerCase();
        return haystack.includes(needle);
      }
      return true;
    });
  }, [executor, filter, query, tasksState.tasks]);

  const failures = tasksState.tasks.filter((task) => task.status === 'failed').slice(0, 3);
  const lastUpdated = tasksState.lastUpdated
    ? tasksState.lastUpdated.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

  const refreshAll = () => {
    void tasksState.refresh();
    void engine.refresh();
    void agentsState.refresh();
  };

  const handleStart = async () => {
    setStarting(true);
    try {
      await startEngine();
      await engine.refresh();
      await tasksState.refresh();
      await agentsState.refresh();
    } finally {
      setStarting(false);
    }
  };

  const segments = [
    { value: 'all', label: `全部 ${counts.all ?? 0}` },
    { value: 'running', label: `运行中 ${counts.running ?? 0}` },
    { value: 'success', label: `成功 ${counts.success ?? 0}` },
    { value: 'failed', label: `失败 ${counts.failed ?? 0}` },
    { value: 'cancelled', label: `已取消 ${counts.cancelled ?? 0}` },
  ];

  const engineTone = engine.status?.healthy
    ? 'success'
    : engine.status?.state === 'starting'
      ? 'warning'
      : engine.status?.state === 'error'
        ? 'error'
        : 'neutral';
  const engineLabel = engine.status?.healthy
    ? '在线'
    : engine.status?.state === 'starting'
      ? '启动中'
      : engine.status?.state === 'error'
        ? '启动失败'
        : '离线';

  return (
    <>
      <PageHead
        title="任务"
        subtitle={
          tasksState.error
            ? `引擎数据读取失败：${tasksState.error}`
            : `${tasksState.tasks.length} 个任务 · ${counts.running ?? 0} 个运行中 · 最后更新 ${lastUpdated}`
        }
        actions={
          <>
            {!engine.status?.healthy && (
              <AppButton
                label={starting ? '正在启动引擎…' : '启动引擎'}
                tone="primary"
                icon={<Server size={15} />}
                isLoading={starting}
                isDisabled={starting || engine.status?.state === 'starting'}
                onClick={() => void handleStart()}
              />
            )}
            <AppButton
              label="刷新"
              icon={<RefreshCw size={15} />}
              onClick={refreshAll}
            />
            <AppButton
              label="派发任务"
              tone="primary"
              icon={<Plus size={15} />}
              onClick={() => navigate('/dispatch')}
            />
          </>
        }
      />

      <div className="workspace">
        <Panel label="任务列表">
          <div className="panel__toolbar">
            <AppSegmented
              label="按状态筛选"
              value={filter}
              segments={segments}
              onChange={(next) => setFilter(next as StatusFilter)}
            />
            <div className="toolbar__spacer" />
            <AppSearch
              label="搜索任务"
              value={query}
              onChange={setQuery}
              placeholder="搜索任务、ID 或执行器"
            />
            <select
              className="select select--compact"
              aria-label="按执行器筛选"
              value={executor}
              onChange={(event) => setExecutor(event.target.value as ExecutorFilter)}
            >
              <option value="all">执行器：全部</option>
              <option value="claude">执行器：claude</option>
              <option value="dsh">执行器：dsh</option>
            </select>
          </div>

          {tasksState.loading && tasksState.tasks.length === 0 ? (
            <AppEmptyState title="正在读取任务" description="正在从本地引擎加载任务列表…" />
          ) : tasksState.error && tasksState.tasks.length === 0 ? (
            <AppEmptyState
              title="无法读取任务列表"
              description={tasksState.error}
              action={
                <AppButton
                  label="重试"
                  tone="secondary"
                  icon={<RefreshCw size={15} />}
                  onClick={refreshAll}
                />
              }
            />
          ) : filtered.length === 0 ? (
            <AppEmptyState
              title={tasksState.tasks.length === 0 ? '还没有任务' : '没有匹配的任务'}
              description={
                tasksState.tasks.length === 0
                  ? '通过“派发任务”创建第一个真实任务。'
                  : '请调整状态、执行器或搜索条件。'
              }
            />
          ) : (
            <Table
              data={filtered}
              idKey="id"
              className="table task-table"
              density="compact"
              dividers="rows"
              hasHover
              textOverflow="truncate"
              columns={[
                {
                  key: 'title',
                  header: '任务',
                  width: proportional(38),
                  renderCell: (task) => (
                    <div>
                      <a className="task-link" href={`#/tasks/${task.id}`}>
                        {task.title}
                      </a>
                      <div className="task-meta">
                        <span>#{task.id}</span>
                        <span className="mono">{task.engineState}</span>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'executor',
                  header: '执行器',
                  width: proportional(14),
                  renderCell: (task) => (
                    <span className="executor">
                      <Terminal size={14} aria-hidden="true" />
                      {task.executor}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: '状态',
                  width: proportional(13),
                  renderCell: (task) => {
                    const display = displayStatus(task);
                    return (
                      <AppStatus
                        tone={display.tone}
                        label={display.label}
                        isPulsing={task.status === 'running'}
                      />
                    );
                  },
                },
                {
                  key: 'duration',
                  header: '用时',
                  width: proportional(10),
                  align: 'end',
                  renderCell: (task) => <span className="num">{formatDuration(task.durationMs)}</span>,
                },
                {
                  key: 'updated',
                  header: '更新时间',
                  width: proportional(17),
                  renderCell: (task) => (
                    <div>
                      <span className="muted">{formatRelative(task.updatedAt)}</span>
                      <div className="cell-sub">{formatClock(task.updatedAt)}</div>
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  width: proportional(8),
                  align: 'end',
                  renderCell: (task) => (
                    <AppIconButton
                      label="打开任务详情"
                      icon={<ChevronRight size={16} />}
                      onClick={() => navigate(`/tasks/${task.id}`)}
                    />
                  ),
                },
              ]}
            />
          )}

          <div className="panel__footer">
            <span>
              显示 {filtered.length} / {tasksState.tasks.length} 个任务
            </span>
            <span>自动刷新 5 秒 · 数据来自本地引擎</span>
          </div>
        </Panel>

        <aside className="rail" aria-label="引擎与执行器状态">
          <RailCard title="引擎" meta={<AppStatus tone={engineTone} label={engineLabel} />}>
            <dl className="kv">
              <dt>地址</dt>
              <dd className="mono">{engine.status?.baseUrl ?? '127.0.0.1:8080'}</dd>
              <dt>连接</dt>
              <dd>
                <AppStatus
                  tone={engine.status?.healthy ? 'success' : 'neutral'}
                  label={engine.status?.healthy ? '健康检查通过' : '未连接'}
                />
              </dd>
              <dt>版本</dt>
              <dd className="mono">{engine.status?.version ?? '—'}</dd>
              <dt>运行时长</dt>
              <dd>{formatUptime(engine.status?.uptimeSeconds ?? null)}</dd>
              <dt>生命周期</dt>
              <dd>
                {engine.status?.managed
                  ? '由 GUI 启动和管理'
                  : engine.status?.healthy
                    ? '外部进程（attach）'
                    : '—'}
              </dd>
              <dt>Token</dt>
              <dd>
                {engine.status?.tokenConfigured
                  ? engine.status.tokenSource === 'stored'
                    ? '已保存（safeStorage）'
                    : '来自环境 / workbench.env'
                  : '未配置'}
              </dd>
            </dl>
            {engine.status?.lastError && (
              <p className="rail-note rail-note--error">{engine.status.lastError}</p>
            )}
            <div className="rail-actions">
              <AppButton
                label="管理引擎"
                size="sm"
                className="btn-block"
                onClick={() => navigate('/settings')}
              />
            </div>
          </RailCard>

          <RailCard
            title="执行器"
            meta={<span className="dim small">{agentsState.loading ? '读取中…' : 'agent_info'}</span>}
          >
            {agentsState.agents.length === 0 ? (
              <p className="rail-note">
                {agentsState.error ?? '暂无执行器数据；请确认引擎已启动。'}
              </p>
            ) : (
              agentsState.agents.map((agent) => (
                <div className="agent-row" key={agent.name}>
                  <div>
                    <div className="agent-name">
                      <AppStatus
                        tone={agent.available ? 'success' : 'error'}
                        label={agent.name}
                      />
                    </div>
                    <div className="agent-meta">
                      {agent.version ? `v${agent.version}` : '版本未知'}
                      {agent.gateway?.model ? ` · ${agent.gateway.model}` : ''}
                    </div>
                  </div>
                  <AppBadge
                    tone={agent.available ? 'success' : 'error'}
                    label={agent.available ? '可用' : '不可用'}
                  />
                </div>
              ))
            )}
            {agentsState.error && agentsState.agents.length > 0 && (
              <p className="rail-note rail-note--error">{agentsState.error}</p>
            )}
            <p className="rail-note">执行器状态来自引擎 agent_info，每 30 秒刷新。</p>
          </RailCard>

          <RailCard
            title="最近失败"
            meta={
              <a className="text-link" href="#/tasks">
                全部
              </a>
            }
          >
            {failures.length === 0 ? (
              <p className="rail-note">当前没有失败任务。</p>
            ) : (
              failures.map((task) => (
                <a className="recent-failure" href={`#/tasks/${task.id}`} key={task.id}>
                  <div className="recent-failure__title">{task.title}</div>
                  <div className="recent-failure__meta">
                    <AppStatus tone="error" label={ENGINE_STATE_LABELS[task.engineState]} />
                    <span className="dim small">{formatRelative(task.updatedAt)}</span>
                  </div>
                </a>
              ))
            )}
          </RailCard>
        </aside>
      </div>
    </>
  );
}