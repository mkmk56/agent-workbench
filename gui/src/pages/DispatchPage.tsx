import { ArrowLeft, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Notice, PageHead, RailCard } from '../components/Layout';
import { startEngine, startTask, useAgentInfo, useEngineStatus } from '../lib/engine';
import { setFlash } from '../lib/flash';
import { rememberTaskTitle } from '../lib/labels';
import { navigate } from '../lib/router';
import { useAppInfo } from '../lib/workbench';
import type { Executor } from '../types';
import {
  AppBadge,
  AppButton,
  AppStatus,
  AppTextArea,
} from '../ui/astryx';

const EXECUTOR_INFO: Record<Executor, string> = {
  claude: '适合代码修改、测试与仓库内操作；支持原生续跑。',
  dsh: '适合只读审查、文档整理与长上下文分析；headless 单轮执行。',
};

const TIMEOUTS = [
  { value: '5', label: '5 分钟' },
  { value: '15', label: '15 分钟' },
  { value: '30', label: '30 分钟' },
  { value: '60', label: '60 分钟' },
  { value: '120', label: '120 分钟' },
];

const MAX_PROMPT = 20_000;

export function DispatchPage() {
  const { info } = useAppInfo();
  const engine = useEngineStatus(5_000);
  const agentState = useAgentInfo(30_000);
  const [executor, setExecutor] = useState<Executor>('claude');
  const [prompt, setPrompt] = useState('');
  const [timeout, setTimeoutValue] = useState('30');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    text?: string;
  } | null>(null);

  const timeoutLabel = TIMEOUTS.find((item) => item.value === timeout)?.label ?? timeout;
  const workdir = info.engineWorkdir || info.cwd;

  const agentOptions = useMemo(
    () =>
      (['claude', 'dsh'] as Executor[]).map((id) => {
        const agent = agentState.agents.find((item) => item.name === id);
        return {
          id,
          agent,
          available: agent?.available === true,
        };
      }),
    [agentState.agents],
  );

  useEffect(() => {
    if (agentState.agents.length === 0) {
      return;
    }
    const selected = agentOptions.find((option) => option.id === executor);
    if (selected?.available) {
      return;
    }
    const fallback = agentOptions.find((option) => option.available);
    if (fallback) {
      setExecutor(fallback.id);
    }
  }, [agentOptions, agentState.agents.length, executor]);

  const dispatch = async () => {
    if (prompt.trim().length === 0) {
      setNotice({ tone: 'warning', title: 'Prompt 不能为空', text: '请填写任务内容后再派发。' });
      return;
    }
    if (prompt.length > MAX_PROMPT) {
      setNotice({
        tone: 'warning',
        title: 'Prompt 过长',
        text: `最多 ${MAX_PROMPT} 个字符。`,
      });
      return;
    }
    const selected = agentOptions.find((option) => option.id === executor);
    if (!selected?.available) {
      setNotice({
        tone: 'error',
        title: '执行器不可用',
        text: `执行器 ${executor} 未通过 agent_info 可用性检查。`,
      });
      return;
    }

    setSubmitting(true);
    setNotice({ tone: 'info', title: '正在派发任务…' });
    try {
      if (!engine.status?.healthy) {
        const started = await startEngine();
        await engine.refresh();
        if (!started.ok) {
          setNotice({
            tone: 'error',
            title: '引擎未启动，任务未创建',
            text: started.error,
          });
          return;
        }
      }

      const result = await startTask({
        agent: executor,
        prompt,
        cwd: workdir || undefined,
        timeoutMs: Number(timeout) * 60_000,
      });
      if (!result.ok) {
        setNotice({ tone: 'error', title: '任务创建失败', text: result.error });
        return;
      }

      rememberTaskTitle(result.data.task_id, prompt);
      setFlash(`任务已创建并交给引擎：#${result.data.task_id}`);
      navigate(`/tasks/${result.data.task_id}`);
    } finally {
      setSubmitting(false);
    }
  };

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
        title="派发任务"
        subtitle="校验通过后直接调用引擎 task_start 创建真实任务；创建成功后进入任务详情。"
        actions={
          <AppButton
            label="返回任务列表"
            icon={<ArrowLeft size={15} />}
            onClick={() => navigate('/tasks')}
          />
        }
      />

      <div className="form-layout">
        <div className="form-main">
          {notice != null && (
            <Notice tone={notice.tone} title={notice.title}>
              {notice.text}
            </Notice>
          )}

          {!engine.status?.healthy && (
            <Notice tone="warning" title="引擎当前未连接">
              {engine.status?.lastError ??
                '派发时会尝试启动本地引擎；如果启动失败，任务不会创建，错误会显示在这里。'}
            </Notice>
          )}

          <section className="section" aria-labelledby="executor-title">
            <div className="section__head">
              <h2 className="section__title" id="executor-title">
                执行器
              </h2>
              <span className="dim small">来自引擎 agent_info</span>
            </div>
            <div className="section__body">
              <div className="executor-options" role="radiogroup" aria-label="选择执行器">
                {agentOptions.map((item) => (
                  <label
                    className={`executor-card${executor === item.id ? ' is-selected' : ''}${
                      item.available ? '' : ' is-disabled'
                    }`}
                    key={item.id}
                  >
                    <input
                      className="radio-hidden"
                      type="radio"
                      name="executor"
                      value={item.id}
                      checked={executor === item.id}
                      disabled={!item.available}
                      onChange={() => setExecutor(item.id)}
                    />
                    <div className="executor-card__top">
                      <span className="executor-card__name">{item.id}</span>
                      <AppStatus
                        tone={item.available ? 'success' : 'error'}
                        label={item.available ? '可用' : '不可用'}
                      />
                    </div>
                    <p className="executor-card__desc">{EXECUTOR_INFO[item.id]}</p>
                    <div className="executor-card__meta">
                      {item.agent?.version ? `v${item.agent.version}` : '版本未知'}
                      {item.agent?.gateway?.model ? ` · ${item.agent.gateway.model}` : ''}
                      {item.agent?.logged_in === false ? ' · 未登录' : ''}
                    </div>
                  </label>
                ))}
              </div>
              {agentState.error && (
                <p className="field__hint field__hint--error">{agentState.error}</p>
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="prompt-title">
            <div className="section__head">
              <h2 className="section__title" id="prompt-title">
                任务内容
              </h2>
              <span className="dim small">必填 · 最多 {MAX_PROMPT} 字符</span>
            </div>
            <div className="section__body form-grid">
              <div className="field">
                <label className="field__label" htmlFor="prompt">
                  Prompt
                </label>
                <AppTextArea
                  id="prompt"
                  label="Prompt"
                  value={prompt}
                  onChange={setPrompt}
                  rows={9}
                  maxLength={MAX_PROMPT}
                  placeholder="描述要执行的任务、约束与验收标准…"
                  containerClassName="prompt-field"
                />
                <p className="field__hint">
                  支持 Markdown；建议写清约束与验收标准。执行器不会自动提交或推送。
                </p>
              </div>

              <div className="form-row">
                <div className="field">
                  <label className="field__label" htmlFor="timeout">
                    超时
                  </label>
                  <select
                    className="select"
                    id="timeout"
                    value={timeout}
                    onChange={(event) => setTimeoutValue(event.target.value)}
                  >
                    {TIMEOUTS.map((item) => (
                      <option value={item.value} key={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <p className="field__hint">超时后引擎会取消任务并记录原因。</p>
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="workdir">
                    工作目录
                  </label>
                  <input
                    className="input input--mono"
                    id="workdir"
                    type="text"
                    value={workdir}
                    readOnly
                  />
                  <p className="field__hint">来自主进程解析的引擎根目录；目录配置持久化未接入。</p>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside className="rail" aria-label="派发预览与执行器状态">
          <RailCard title="派发预览">
            <div className="preview">
              <div className="preview__row">
                <span className="dim">执行器</span>
                <span className="mono">{executor}</span>
              </div>
              <div className="preview__row">
                <span className="dim">超时</span>
                <span>{timeoutLabel}</span>
              </div>
              <div className="preview__row">
                <span className="dim">工作目录</span>
                <span className="mono preview__path">{workdir || '由引擎默认值决定'}</span>
              </div>
              <div className="preview__row">
                <span className="dim">引擎</span>
                <AppStatus tone={engineTone} label={engineLabel} />
              </div>
              <div className="preview__divider" />
              <AppButton
                label={submitting ? '正在派发…' : '派发任务'}
                tone="primary"
                icon={<Send size={15} />}
                className="btn-block"
                isLoading={submitting}
                isDisabled={submitting || agentOptions.every((option) => !option.available)}
                onClick={() => void dispatch()}
              />
              <p className="preview__note">
                点击后调用引擎 task_start；成功后跳转到新任务详情，失败会显示引擎返回的错误。
              </p>
            </div>
          </RailCard>

          <RailCard title="执行器状态" meta={<span className="dim small">agent_info</span>}>
            {agentOptions.map((item) => (
              <div className="agent-row" key={item.id}>
                <div>
                  <div className="agent-name">
                    <AppStatus
                      tone={item.available ? 'success' : 'error'}
                      label={item.id}
                    />
                  </div>
                  <div className="agent-meta">
                    {item.agent?.version ? `v${item.agent.version}` : '版本未知'}
                    {item.agent?.resume_supported ? ' · 支持续跑' : ' · 单轮'}
                  </div>
                </div>
                <AppBadge
                  tone={item.available ? 'success' : 'error'}
                  label={item.available ? '可用' : '不可用'}
                />
              </div>
            ))}
            {agentOptions.length === 0 && <p className="rail-note">正在读取执行器状态…</p>}
            <p className="rail-note">不可用的执行器无法选中；状态来自引擎。</p>
          </RailCard>
        </aside>
      </div>
    </>
  );
}