import { ArrowLeft, Send } from 'lucide-react';
import { useState } from 'react';
import { Notice, PageHead, RailCard } from '../components/Layout';
import { navigate } from '../lib/router';
import { useAppInfo } from '../lib/workbench';
import type { Executor } from '../types';
import {
  AppBadge,
  AppButton,
  AppStatus,
  AppTextArea,
} from '../ui/astryx';

const EXECUTORS: Array<{ id: Executor; description: string; meta: string }> = [
  {
    id: 'claude',
    description: '适合代码修改、测试与仓库内操作。模型由执行器配置决定。',
    meta: '默认执行器',
  },
  {
    id: 'dsh',
    description: '适合只读审查、文档整理与长上下文分析。模型由执行器配置决定。',
    meta: '备用执行器',
  },
];

const TIMEOUTS = [
  { value: '5', label: '5 分钟' },
  { value: '15', label: '15 分钟' },
  { value: '30', label: '30 分钟' },
  { value: '60', label: '60 分钟' },
  { value: '120', label: '120 分钟' },
];

const DEFAULT_PROMPT =
  '修复登录回调超时：在 src/server.js 的回调处理里增加 5s 超时与一次重试；补充对应测试，并运行 npm test -- auth。不要修改无关文件。';

export function DispatchPage() {
  const { info } = useAppInfo();
  const [executor, setExecutor] = useState<Executor>('claude');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [timeout, setTimeoutValue] = useState('30');
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    text?: string;
  } | null>(null);

  const timeoutLabel = TIMEOUTS.find((item) => item.value === timeout)?.label ?? timeout;
  const workdir = info.cwd;

  const dispatch = () => {
    if (prompt.trim().length === 0) {
      setNotice({
        tone: 'warning',
        title: 'Prompt 不能为空',
        text: '请填写任务内容后再派发。',
      });
      return;
    }
    setNotice({
      tone: 'warning',
      title: '派发接口尚未接入',
      text: '界面校验已通过，但本轮不会创建任务，也不会调用执行器。',
    });
  };

  return (
    <>
      <PageHead
        title="派发任务"
        subtitle="创建一个新的执行器任务。派发接口与执行器状态尚未接入，本轮为可运行界面壳。"
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

          <section className="section" aria-labelledby="executor-title">
            <div className="section__head">
              <h2 className="section__title" id="executor-title">
                执行器
              </h2>
              <span className="dim small">2 个示例选项</span>
            </div>
            <div className="section__body">
              <div className="executor-options" role="radiogroup" aria-label="选择执行器">
                {EXECUTORS.map((item) => (
                  <label
                    className={`executor-card${executor === item.id ? ' is-selected' : ''}`}
                    key={item.id}
                  >
                    <input
                      className="radio-hidden"
                      type="radio"
                      name="executor"
                      value={item.id}
                      checked={executor === item.id}
                      onChange={() => setExecutor(item.id)}
                    />
                    <div className="executor-card__top">
                      <span className="executor-card__name">{item.id}</span>
                      <AppStatus tone="neutral" label="待接入" />
                    </div>
                    <p className="executor-card__desc">{item.description}</p>
                    <div className="executor-card__meta">{item.meta}</div>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="section" aria-labelledby="prompt-title">
            <div className="section__head">
              <h2 className="section__title" id="prompt-title">
                任务内容
              </h2>
              <span className="dim small">必填</span>
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
                  maxLength={4000}
                  containerClassName="prompt-field"
                />
                <p className="field__hint">
                  支持 Markdown；建议写清约束与验收标准。任务以当前工作目录为基准执行；执行器不会自动提交或推送。
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
                  <p className="field__hint">超时后任务会被取消并记录原因。</p>
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
                  <p className="field__hint">来自主进程当前目录；正式工作目录配置待接入。</p>
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
                <span className="mono preview__path">{workdir}</span>
              </div>
              <div className="preview__row">
                <span className="dim">引擎</span>
                <AppStatus tone="neutral" label="未接入" />
              </div>
              <div className="preview__divider" />
              <AppButton
                label="派发任务"
                tone="primary"
                icon={<Send size={15} />}
                className="btn-block"
                onClick={dispatch}
              />
              <p className="preview__note">
                当前为可运行壳：点击派发只做界面校验，不会创建任务。引擎 IPC 接入后再串联执行器。
              </p>
            </div>
          </RailCard>

          <RailCard title="执行器状态" meta={<span className="dim small">待接入</span>}>
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
            <p className="rail-note">执行器不可用时，对应选项会被禁用并显示原因。</p>
          </RailCard>
        </aside>
      </div>
    </>
  );
}