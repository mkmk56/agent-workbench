import { ChevronRight, Plus, RefreshCw, Terminal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHead, Panel, RailCard } from '../components/Layout';
import { DEMO_TASKS, STATUS_LABELS } from '../data/demo';
import { navigate } from '../lib/router';
import type { Executor, TaskStatus } from '../types';
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

export function TasksPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [executor, setExecutor] = useState<ExecutorFilter>('all');
  const [query, setQuery] = useState('');
  const [lastUpdated, setLastUpdated] = useState(() =>
    new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  );

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: DEMO_TASKS.length };
    for (const task of DEMO_TASKS) {
      result[task.status] = (result[task.status] ?? 0) + 1;
    }
    return result;
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return DEMO_TASKS.filter((task) => {
      if (filter !== 'all' && task.status !== filter) {
        return false;
      }
      if (executor !== 'all' && task.executor !== executor) {
        return false;
      }
      if (needle.length > 0) {
        const haystack = `${task.title} ${task.id} ${task.executor} ${task.sha}`.toLowerCase();
        return haystack.includes(needle);
      }
      return true;
    });
  }, [executor, filter, query]);

  const segments = [
    { value: 'all', label: `全部 ${counts.all ?? 0}` },
    { value: 'running', label: `运行中 ${counts.running ?? 0}` },
    { value: 'success', label: `成功 ${counts.success ?? 0}` },
    { value: 'failed', label: `失败 ${counts.failed ?? 0}` },
    { value: 'cancelled', label: `已取消 ${counts.cancelled ?? 0}` },
  ];

  return (
    <>
      <PageHead
        title="任务"
        subtitle={`${DEMO_TASKS.length} 个示例任务 · ${counts.running ?? 0} 个运行中 · 最后更新 ${lastUpdated}`}
        actions={
          <>
            <AppButton
              label="刷新"
              icon={<RefreshCw size={15} />}
              onClick={() =>
                setLastUpdated(
                  new Date().toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                )
              }
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

          {filtered.length === 0 ? (
            <AppEmptyState
              title="没有匹配的任务"
              description="请调整状态、执行器或搜索条件。"
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
                        <span>{task.sha}</span>
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
                  renderCell: (task) => (
                    <AppStatus
                      tone={STATUS_TONE[task.status]}
                      label={STATUS_LABELS[task.status]}
                      isPulsing={task.status === 'running'}
                    />
                  ),
                },
                {
                  key: 'duration',
                  header: '用时',
                  width: proportional(10),
                  align: 'end',
                  renderCell: (task) => <span className="num">{task.duration}</span>,
                },
                {
                  key: 'updated',
                  header: '更新时间',
                  width: proportional(17),
                  renderCell: (task) => (
                    <div>
                      <span className="muted">{task.updated}</span>
                      <div className="cell-sub">{task.updatedAt}</div>
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
              显示 {filtered.length} / {DEMO_TASKS.length} 个示例任务
            </span>
            <span>自动刷新未接入 · 数据为界面示例</span>
          </div>
        </Panel>

        <aside className="rail" aria-label="引擎与执行器状态">
          <RailCard title="引擎" meta={<AppStatus tone="neutral" label="未接入" />}>
            <dl className="kv">
              <dt>地址</dt>
              <dd className="mono">127.0.0.1:8080</dd>
              <dt>连接</dt>
              <dd>
                <AppStatus tone="neutral" label="IPC 未接入" />
              </dd>
              <dt>执行器</dt>
              <dd>状态未知</dd>
              <dt>健康检查</dt>
              <dd>
                <AppStatus tone="neutral" label="未执行" />
              </dd>
            </dl>
            <div className="rail-actions">
              <AppButton
                label="管理引擎"
                size="sm"
                className="btn-block"
                onClick={() => navigate('/settings')}
              />
            </div>
          </RailCard>

          <RailCard title="执行器" meta={<span className="dim small">待接入</span>}>
            <div className="agent-row">
              <div>
                <div className="agent-name">
                  <AppStatus tone="neutral" label="claude" />
                </div>
                <div className="agent-meta">模型由执行器配置</div>
              </div>
              <AppBadge tone="neutral" label="默认" />
            </div>
            <div className="agent-row">
              <div>
                <div className="agent-name">
                  <AppStatus tone="neutral" label="dsh" />
                </div>
                <div className="agent-meta">模型由执行器配置</div>
              </div>
            </div>
            <p className="rail-note">执行器状态将在引擎 IPC 接入后显示。</p>
          </RailCard>

          <RailCard
            title="最近失败"
            meta={
              <a className="text-link" href="#/tasks">
                全部
              </a>
            }
          >
            <a className="recent-failure" href="#/tasks/T-1040">
              <div className="recent-failure__title">排查 dsh 执行器退出码 1</div>
              <div className="recent-failure__meta">
                <AppStatus tone="error" label="失败" />
                <span className="dim small">18 分钟前</span>
              </div>
            </a>
          </RailCard>
        </aside>
      </div>
    </>
  );
}