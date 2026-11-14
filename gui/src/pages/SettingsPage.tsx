import {
  Bot,
  Check,
  Database,
  KeyRound,
  MessagesSquare,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Notice } from '../components/Layout';
import { useHudConfig } from '../lib/hud';
import { startEngine, stopEngine, useAgentInfo, useEngineStatus } from '../lib/engine';
import {
  UPDATE_PHASE_LABELS,
  formatBytes,
  formatClock,
  formatUptime,
} from '../lib/labels';
import { testToken, useAppInfo, useUpdateState } from '../lib/workbench';
import type { UpdateChannel } from '../types';
import {
  AlertDialog,
  AppBadge,
  AppBanner,
  AppButton,
  AppStatus,
  AppSwitch,
  AppTextField,
} from '../ui/astryx';

type SectionId = 'credentials' | 'engine' | 'executors' | 'hud' | 'updates' | 'data';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'credentials', label: '凭据', icon: <KeyRound size={15} /> },
  { id: 'engine', label: '引擎', icon: <Server size={15} /> },
  { id: 'executors', label: '执行器', icon: <Terminal size={15} /> },
  { id: 'hud', label: 'Agent HUD', icon: <Bot size={15} /> },
  { id: 'updates', label: '更新', icon: <RefreshCw size={15} /> },
  { id: 'data', label: '数据', icon: <Database size={15} /> },
];

const DEFAULT_STATE = {
  autoStart: true,
  proxy: 'system',
  autoUpdate: true,
};

export function SettingsPage() {
  const { info, refresh } = useAppInfo();
  const engine = useEngineStatus(5_000);
  const agentsState = useAgentInfo(30_000);
  const updates = useUpdateState();
  const hud = useHudConfig();
  const [contextDraft, setContextDraft] = useState('128000');
  const [activeSection, setActiveSection] = useState<SectionId>('credentials');
  const [tokenStored, setTokenStored] = useState<boolean | null>(null);
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [testingToken, setTestingToken] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [engineStopOpen, setEngineStopOpen] = useState(false);
  const [engineBusy, setEngineBusy] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    text?: string;
  } | null>(null);

  const [autoStart, setAutoStart] = useState(DEFAULT_STATE.autoStart);
  const [proxy, setProxy] = useState(DEFAULT_STATE.proxy);
  const [autoUpdate, setAutoUpdate] = useState(DEFAULT_STATE.autoUpdate);

  useEffect(() => {
    setContextDraft(String(hud.config.contextWindowTokens));
  }, [hud.config.contextWindowTokens]);

  const protocol = agentsState.info?.message_protocol ?? null;
  const gate = agentsState.info?.approval_gate ?? null;

  const stored = tokenStored ?? info.tokenStored;
  const encryptionAvailable = info.encryptionAvailable;
  const actualLaunchMode = engine.status?.managed
    ? 'managed'
    : engine.status?.healthy
      ? 'attach'
      : 'stopped';
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

  const scrollTo = (id: SectionId) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const togglePaperPlanes = async (value: boolean) => {
    await hud.setPaperPlanes(value);
    setNotice({
      tone: 'success',
      title: value ? '纸飞机动画已开启' : '纸飞机动画已关闭',
      text: '配置已写入主进程 userData/hud.json，立即生效。',
    });
  };

  const applyContextWindow = async () => {
    const tokens = Number(contextDraft);
    if (!Number.isInteger(tokens) || tokens < 1_000 || tokens > 2_000_000) {
      setNotice({
        tone: 'warning',
        title: '上下文参考值无效',
        text: '请输入 1,000–2,000,000 之间的整数。',
      });
      return;
    }
    await hud.setContextWindowTokens(tokens);
    setNotice({
      tone: 'success',
      title: '上下文参考值已保存',
      text: `会话流按 ${tokens.toLocaleString()} tokens 参考上限显示占用条。`,
    });
  };

  const saveToken = async () => {
    if (tokenDraft.trim().length === 0) {
      setNotice({ tone: 'warning', title: 'Token 为空', text: '请输入 Token 后再保存。' });
      return;
    }
    if (!window.workbench) {
      setNotice({
        tone: 'error',
        title: '主进程未连接',
        text: '浏览器预览无法使用 safeStorage；请在 Electron 中运行。',
      });
      return;
    }
    setSavingToken(true);
    try {
      const result = await window.workbench.setToken(tokenDraft);
      if (result.ok) {
        setTokenDraft('');
        setEditingToken(false);
        setTokenStored(true);
        await refresh();
        setNotice({
          tone: 'success',
          title: 'Token 已加密保存',
          text: '主进程使用 safeStorage（Windows DPAPI）加密；渲染进程不能读取明文。',
        });
      } else {
        setNotice({
          tone: 'error',
          title: 'Token 未保存',
          text: result.error ?? '未知错误。',
        });
      }
    } catch {
      setNotice({ tone: 'error', title: 'Token 未保存', text: '主进程调用失败。' });
    } finally {
      setSavingToken(false);
    }
  };

  const clearToken = async () => {
    if (!window.workbench) {
      setNotice({ tone: 'error', title: '主进程未连接', text: '无法清除 Token。' });
      return;
    }
    const result = await window.workbench.clearToken();
    if (result.ok) {
      setTokenStored(false);
      setEditingToken(false);
      setTokenDraft('');
      await refresh();
      setNotice({ tone: 'success', title: 'Token 已清除' });
    } else {
      setNotice({ tone: 'error', title: 'Token 未清除', text: result.error ?? '未知错误。' });
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

  const handleTestToken = async () => {
    setTestingToken(true);
    try {
      const result = await testToken();
      if (result.ok) {
        setNotice({
          tone: 'success',
          title: '认证通过',
          text: `agent_info 返回 ${result.data.length} 个执行器；连接与 Token 均有效。`,
        });
        await agentsState.refresh();
      } else {
        setNotice({ tone: 'error', title: '连接测试失败', text: result.error });
      }
    } finally {
      setTestingToken(false);
    }
  };

  const handleStartEngine = async () => {
    setEngineBusy('start');
    try {
      const result = await startEngine();
      if (result.ok) {
        setNotice({
          tone: 'success',
          title: '引擎已启动',
          text: `健康检查通过：${result.data.baseUrl}。`,
        });
      } else {
        setNotice({ tone: 'error', title: '引擎启动失败', text: result.error });
      }
      await engine.refresh();
      await agentsState.refresh();
    } finally {
      setEngineBusy(null);
    }
  };

  const handleUpdateCheck = async () => {
    const next = await updates.check();
    if (next.phase === 'error') {
      setNotice({ tone: 'error', title: '检查更新失败', text: next.message ?? '未知错误。' });
    }
  };

  const handleUpdateDownload = async () => {
    const next = await updates.download();
    if (next.phase === 'error') {
      setNotice({ tone: 'error', title: '下载更新失败', text: next.message ?? '未知错误。' });
    }
  };

  const handleUpdateInstall = async () => {
    const result = await updates.install();
    if (!result.ok) {
      setNotice({ tone: 'error', title: '安装更新失败', text: result.error ?? '未知错误。' });
    }
  };

  const handleStopEngine = async () => {
    setEngineStopOpen(false);
    setEngineBusy('stop');
    try {
      const result = await stopEngine();
      if (result.ok) {
        setNotice({ tone: 'success', title: '引擎已停止' });
      } else {
        setNotice({ tone: 'error', title: '引擎未停止', text: result.error });
      }
      await engine.refresh();
      await agentsState.refresh();
    } finally {
      setEngineBusy(null);
    }
  };

  const handleRestartEngine = async () => {
    setEngineBusy('restart');
    try {
      const stopped = await stopEngine();
      if (!stopped.ok) {
        setNotice({ tone: 'error', title: '重启失败：无法停止引擎', text: stopped.error });
        return;
      }
      const started = await startEngine();
      if (started.ok) {
        setNotice({
          tone: 'success',
          title: '引擎已重启',
          text: `健康检查通过：${started.data.baseUrl}。`,
        });
      } else {
        setNotice({ tone: 'error', title: '重启失败：引擎未启动', text: started.error });
      }
      await engine.refresh();
      await agentsState.refresh();
    } finally {
      setEngineBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">
            凭据、引擎生命周期、执行器状态、任务 IPC 与更新管道已接入；HUD 动效与上下文参考值已持久化，引擎协作参数只读。
          </p>
        </div>
      </div>

      <AppBanner
        status="info"
        title="本次接入范围"
        description="Token 使用 safeStorage 加密保存；引擎启停、健康检查、执行器与任务数据来自主进程和本地引擎。HUD 的纸飞机动画与上下文参考值写入 userData/hud.json；引擎协作参数只读展示，修改需重启引擎。日志虚拟列表尚未接入。"
      />

      {notice != null && (
        <div className="settings-notice">
          <Notice tone={notice.tone} title={notice.title}>
            {notice.text}
          </Notice>
        </div>
      )}

      <div className="settings">
        <nav className="settings-nav" aria-label="设置分区">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? 'is-active' : undefined}
              onClick={() => scrollTo(section.id)}
            >
              {section.icon}
              {section.label}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <section className="section" id="credentials" aria-labelledby="credentials-title">
            <div className="section__head">
              <h2 className="section__title" id="credentials-title">
                凭据
              </h2>
              {stored ? (
                <AppBadge tone="success" label="已加密保存" />
              ) : (
                <AppBadge tone="neutral" label="未保存" />
              )}
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">API Token</div>
                  <div className="setting-desc">
                    用于 GUI 调用本地 MCP 引擎。Token 由主进程通过 safeStorage（Windows DPAPI）加密保存，
                    渲染进程无法读取明文。
                  </div>
                </div>
                <div className="setting-control">
                  {editingToken ? (
                    <>
                      <AppTextField
                        label="API Token"
                        type="password"
                        isLabelHidden
                        value={tokenDraft}
                        onChange={setTokenDraft}
                        placeholder="粘贴新的 Token"
                        containerClassName="token-field"
                      />
                      <div className="setting-inline">
                        <AppButton
                          label="保存 Token"
                          tone="primary"
                          size="sm"
                          isLoading={savingToken}
                          isDisabled={savingToken}
                          onClick={() => void saveToken()}
                        />
                        <AppButton
                          label="取消"
                          tone="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingToken(false);
                            setTokenDraft('');
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        className="input"
                        type="text"
                        value={stored ? '••••••••••••••••' : ''}
                        placeholder="尚未保存 Token"
                        readOnly
                        aria-label="API Token"
                        autoComplete="off"
                      />
                      <div className="setting-inline">
                        <AppButton
                          label={stored ? '替换' : '设置 Token'}
                          size="sm"
                          onClick={() => setEditingToken(true)}
                        />
                        {stored && (
                          <AppButton
                            label="清除"
                            tone="ghost"
                            size="sm"
                            onClick={() => setClearOpen(true)}
                          />
                        )}
                      </div>
                    </>
                  )}
                  <div className="setting-inline">
                    <AppStatus
                      tone={stored ? 'success' : 'neutral'}
                      label={stored ? 'Token 已保存' : '未保存 Token'}
                    />
                    <AppButton
                      label={testingToken ? '测试中…' : '测试连接'}
                      tone="ghost"
                      size="sm"
                      isLoading={testingToken}
                      isDisabled={testingToken}
                      onClick={() => void handleTestToken()}
                    />
                  </div>
                  <p className="field__hint">
                    {encryptionAvailable
                      ? '系统安全存储可用（safeStorage / DPAPI）。'
                      : '系统安全存储不可用；Token 不会写入磁盘。'}
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="section" id="engine" aria-labelledby="engine-title">
            <div className="section__head">
              <h2 className="section__title" id="engine-title">
                引擎
              </h2>
              <AppStatus tone={engineTone} label={engineLabel} />
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">引擎地址</div>
                  <div className="setting-desc">
                    GUI 通过主进程访问本地 MCP 引擎；渲染进程不能直接联网。
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input input--mono"
                    type="text"
                    value={engine.status?.baseUrl ?? '127.0.0.1:8080'}
                    readOnly
                    aria-label="引擎地址"
                  />
                  <p className="field__hint">实际值来自主进程；端口配置持久化未接入。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">连接</div>
                  <div className="setting-desc">
                    最近一次 /health 检查：{engine.status ? formatClock(engine.status.checkedAt) : '—'}
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <AppStatus
                      tone={engine.status?.healthy ? 'success' : 'warning'}
                      label={engine.status?.healthy ? '健康检查通过' : '未连接'}
                    />
                    <span className="mono dim">版本 {engine.status?.version ?? '—'}</span>
                    <span className="dim small">
                      运行 {formatUptime(engine.status?.uptimeSeconds ?? null)}
                    </span>
                  </div>
                  <p className="field__hint">
                    Token 来源：
                    {engine.status?.tokenConfigured
                      ? engine.status.tokenSource === 'stored'
                        ? 'safeStorage（已保存）'
                        : '环境变量 / workbench.env'
                      : '未配置'}
                    。生命周期：
                    {engine.status?.managed
                      ? '由 GUI 启动和管理'
                      : engine.status?.healthy
                        ? '外部进程（attach）'
                        : '—'}
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">启动方式</div>
                  <div className="setting-desc">由 GUI 拉起引擎，或连接已经运行的引擎。</div>
                </div>
                <div className="setting-control">
                  <select
                    className="select"
                    aria-label="启动方式"
                    value={actualLaunchMode}
                    disabled
                  >
                    <option value="managed">由 GUI 启动和管理</option>
                    <option value="attach">连接现有引擎</option>
                    <option value="stopped">未运行</option>
                  </select>
                  <p className="field__hint">实际状态只读；启动方式配置持久化未接入。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">随应用启动</div>
                  <div className="setting-desc">
                    打开应用时自动连接或启动引擎；关闭应用时停止由 GUI 启动的引擎。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="muted">仅界面状态，持久化未接入</span>
                    <AppSwitch label="随应用启动" value={autoStart} onChange={setAutoStart} />
                  </div>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">代理</div>
                  <div className="setting-desc">
                    用于 GitHub Releases 更新检查。系统代理可能触发 API 限流，失败时会显示具体原因。
                  </div>
                </div>
                <div className="setting-control">
                  <select
                    className="select"
                    aria-label="代理"
                    value={proxy}
                    onChange={(event) => setProxy(event.target.value)}
                  >
                    <option value="system">跟随系统代理（127.0.0.1:7897）</option>
                    <option value="direct">直连（不使用代理）</option>
                    <option value="custom">自定义代理…</option>
                  </select>
                  <p className="field__hint">仅界面状态，尚未写入配置。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">引擎控制</div>
                  <div className="setting-desc">
                    重启会中断正在运行的任务；停止引擎前会二次确认。外部进程只能 attach，不能由 GUI 停止。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <AppStatus tone={engineTone} label={engineLabel} />
                    <div className="setting-buttons">
                      <AppButton
                        label={engineBusy === 'start' ? '启动中…' : '启动'}
                        size="sm"
                        isLoading={engineBusy === 'start'}
                        isDisabled={
                          engineBusy != null ||
                          engine.status?.healthy === true ||
                          engine.status?.state === 'starting'
                        }
                        onClick={() => void handleStartEngine()}
                      />
                      <AppButton
                        label={engineBusy === 'restart' ? '重启中…' : '重启引擎'}
                        size="sm"
                        isLoading={engineBusy === 'restart'}
                        isDisabled={
                          engineBusy != null ||
                          !engine.status?.managed ||
                          !engine.status?.healthy
                        }
                        title={
                          engine.status?.managed
                            ? '重启会中断正在运行的任务'
                            : '外部启动的引擎不能由 GUI 重启'
                        }
                        onClick={() => void handleRestartEngine()}
                      />
                      <AppButton
                        label={engineBusy === 'stop' ? '停止中…' : '停止'}
                        tone="ghost"
                        size="sm"
                        isLoading={engineBusy === 'stop'}
                        isDisabled={
                          engineBusy != null ||
                          !engine.status?.managed ||
                          !engine.status?.healthy
                        }
                        title={
                          engine.status?.managed
                            ? '停止前会二次确认'
                            : '外部启动的引擎不能由 GUI 停止'
                        }
                        onClick={() => setEngineStopOpen(true)}
                      />
                      <AppButton
                        label="刷新状态"
                        tone="ghost"
                        size="sm"
                        onClick={() => void engine.refresh()}
                      />
                    </div>
                  </div>
                  {engine.status?.lastError && (
                    <p className="field__hint field__hint--error">{engine.status.lastError}</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="section" id="executors" aria-labelledby="executors-title">
            <div className="section__head">
              <h2 className="section__title" id="executors-title">
                执行器
              </h2>
              <AppStatus
                tone={agentsState.error ? 'warning' : agentsState.agents.length > 0 ? 'success' : 'neutral'}
                label={
                  agentsState.error
                    ? '读取失败'
                    : agentsState.agents.length > 0
                      ? `${agentsState.agents.length} 个执行器`
                      : '未读取'
                }
              />
            </div>
            <div className="section__body settings-section__body">
              {agentsState.agents.length === 0 ? (
                <div className="setting-row">
                  <div>
                    <div className="setting-label">没有执行器数据</div>
                    <div className="setting-desc">
                      {agentsState.error ?? '引擎未连接或 agent_info 尚未返回。'}
                    </div>
                  </div>
                  <div className="setting-control">
                    <AppButton
                      label="刷新"
                      size="sm"
                      onClick={() => void agentsState.refresh()}
                    />
                  </div>
                </div>
              ) : (
                agentsState.agents.map((agent) => (
                  <div className="setting-row" key={agent.name}>
                    <div>
                      <div className="setting-label">
                        {agent.name}
                        {agent.version ? ` · v${agent.version}` : ''}
                      </div>
                      <div className="setting-desc">
                        {agent.gateway?.model
                          ? `模型 ${agent.gateway.model} · 网关 ${agent.gateway.base_url}`
                          : '模型由执行器配置'}
                        {agent.notes ? ` · ${agent.notes}` : ''}
                      </div>
                    </div>
                    <div className="setting-control">
                      <div className="setting-inline">
                        <AppStatus
                          tone={agent.available ? 'success' : 'error'}
                          label={agent.available ? '可用' : '不可用'}
                        />
                        <span className="dim small">
                          续跑 {agent.resume_supported ? '支持' : '不支持'}
                          {agent.logged_in == null
                            ? ''
                            : ` · ${agent.logged_in ? '已登录' : '未登录'}`}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="section" id="hud" aria-labelledby="hud-title">
            <div className="section__head">
              <h2 className="section__title" id="hud-title">
                Agent HUD
              </h2>
              <AppBadge tone="neutral" label="本地配置 + 引擎只读" />
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">纸飞机动画</div>
                  <div className="setting-desc">
                    两个 agent 互发结论时，纸飞机沿弧线飞行并留下虚线尾迹。关闭后只保留未读与状态变化；
                    系统“减少动态效果”设置也会自动降级。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="muted">
                      {hud.config.paperPlanes ? '已开启（默认）' : '已关闭'}
                    </span>
                    <AppSwitch
                      label="纸飞机动画"
                      value={hud.config.paperPlanes}
                      onChange={(value) => void togglePaperPlanes(value)}
                    />
                  </div>
                  <p className="field__hint">持久化到 userData/hud.json，立即生效。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">上下文参考上限</div>
                  <div className="setting-desc">
                    结论流顶部的占用条按这个值计算百分比。引擎没有返回真实上下文上限，
                    所以这是可调整的参考值，不是引擎承诺。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline context-input">
                    <input
                      className="input input--mono"
                      type="number"
                      min={1000}
                      max={2000000}
                      step={1000}
                      value={contextDraft}
                      aria-label="上下文参考上限"
                      onChange={(event) => setContextDraft(event.target.value)}
                    />
                    <AppButton
                      label="应用"
                      size="sm"
                      className="context-input__apply"
                      onClick={() => void applyContextWindow()}
                    />
                  </div>
                  <p className="field__hint">范围 1,000–2,000,000 tokens；默认 128,000。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">允许 agent 互发消息</div>
                  <div className="setting-desc">
                    引擎消息协议的总开关；关闭后 <span className="mono">send_message</span> 不可用。
                  </div>
                </div>
                <div className="setting-control">
                  <AppStatus
                    tone={protocol?.enabled ? 'success' : 'neutral'}
                    label={protocol?.enabled ? '引擎已启用' : '引擎未启用'}
                  />
                  <p className="field__hint">只读：由引擎实现决定，本期不提供运行时开关。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">连续来回上限</div>
                  <div className="setting-desc">
                    同一线程中的 agent-to-agent 消息达到上限后暂停，等你说话再恢复。
                  </div>
                </div>
                <div className="setting-control">
                  <span className="mono">
                    {protocol?.exchange_limit != null ? `${protocol.exchange_limit} 条` : '—'}
                  </span>
                  <p className="field__hint">
                    引擎环境变量 <span className="mono">AGENT_MESSAGE_LIMIT</span>，只读。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">结论摘要上限</div>
                  <div className="setting-desc">单条 agent 消息的 summary token 上限，超出会截断。</div>
                </div>
                <div className="setting-control">
                  <span className="mono">
                    {protocol?.summary_max_tokens != null
                      ? `${protocol.summary_max_tokens} tokens`
                      : '—'}
                  </span>
                  <p className="field__hint">
                    引擎环境变量 <span className="mono">AGENT_SUMMARY_MAX_TOKENS</span>，只读。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">自动投递</div>
                  <div className="setting-desc">
                    目标 agent 空闲时是否自动创建任务接收结论。
                  </div>
                </div>
                <div className="setting-control">
                  <AppStatus
                    tone={protocol?.auto_deliver ? 'success' : 'neutral'}
                    label={protocol?.auto_deliver ? '已开启' : '已关闭'}
                  />
                  <p className="field__hint">
                    引擎环境变量 <span className="mono">AGENT_AUTO_DELIVER</span>，只读。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">关键操作审批门</div>
                  <div className="setting-desc">
                    合并代码、删文件、装依赖前是否在聊天里问你。关闭时保持全自动。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <ShieldCheck size={15} aria-hidden="true" />
                    <AppStatus
                      tone={gate?.enabled ? 'warning' : 'neutral'}
                      label={gate?.enabled ? '已开启' : '关闭（默认）'}
                    />
                  </div>
                  <p className="field__hint">
                    引擎环境变量 <span className="mono">AGENT_APPROVAL_GATE</span>，只读；
                    开启后待审批会出现在任务详情顶部。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">消息协议状态</div>
                  <div className="setting-desc">
                    以上协作参数来自引擎 <span className="mono">agent_info</span>；GUI
                    不修改引擎消息与审批逻辑，修改环境变量后需重启引擎。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <MessagesSquare size={15} aria-hidden="true" />
                    <span className="mono dim">
                      {agentsState.error
                        ? `读取失败：${agentsState.error}`
                        : agentsState.info
                          ? 'agent_info 已返回'
                          : '读取中…'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="section" id="updates" aria-labelledby="updates-title">
            <div className="section__head">
              <h2 className="section__title" id="updates-title">
                更新
              </h2>
              <AppStatus
                tone={updates.update.phase === 'error' ? 'error' : info.update.supported ? 'success' : 'neutral'}
                label={
                  info.update.supported
                    ? UPDATE_PHASE_LABELS[updates.update.phase]
                    : '仅打包版可用'
                }
              />
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">更新管道</div>
                  <div className="setting-desc">{info.update.reason}</div>
                </div>
                <div className="setting-control">
                  <AppStatus
                    tone={updates.update.phase === 'error' ? 'error' : info.update.supported ? 'success' : 'neutral'}
                    label={info.update.supported ? 'GitHub Releases' : '未接入'}
                  />
                  <p className="field__hint">
                    当前版本 v{info.version}；通道{' '}
                    {updates.update.channel === 'stable' ? '稳定版' : '预发布版'}。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">自动检查更新</div>
                  <div className="setting-desc">
                    打包版启动 8 秒后检查 GitHub Releases；发现新版本后由用户确认下载与安装。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="muted">仅界面状态</span>
                    <AppSwitch label="自动检查更新" value={autoUpdate} onChange={setAutoUpdate} />
                  </div>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">更新通道</div>
                  <div className="setting-desc">
                    稳定版只接收正式发布；预发布版接收 rc/beta 等测试版本。通道仅本次运行有效。
                  </div>
                </div>
                <div className="setting-control">
                  <select
                    className="select"
                    aria-label="更新通道"
                    value={updates.update.channel}
                    disabled={!info.update.supported}
                    onChange={(event) => {
                      void updates.setChannel(event.target.value as UpdateChannel);
                    }}
                  >
                    <option value="stable">稳定版</option>
                    <option value="prerelease">预发布版</option>
                  </select>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">当前版本</div>
                  <div className="setting-desc">
                    安装包暂未签名，Windows SmartScreen 首次运行时会提示；更新安装为静默 NSIS。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="mono">v{info.version}</span>
                    {updates.update.phase === 'available' ? (
                      <AppButton
                        label="下载更新"
                        size="sm"
                        onClick={() => void handleUpdateDownload()}
                      />
                    ) : updates.update.phase === 'downloaded' ? (
                      <AppButton
                        label="安装并退出"
                        size="sm"
                        onClick={() => void handleUpdateInstall()}
                      />
                    ) : (
                      <AppButton
                        label={updates.update.phase === 'checking' ? '检查中…' : '检查更新'}
                        size="sm"
                        isDisabled={
                          !updates.update.canCheck ||
                          updates.update.phase === 'checking' ||
                          updates.update.phase === 'downloading' ||
                          updates.update.phase === 'installing'
                        }
                        onClick={() => void handleUpdateCheck()}
                      />
                    )}
                  </div>
                  {updates.update.phase === 'downloading' && (
                    <p className="field__hint">
                      {updates.update.progressPercent ?? 0}% ·{' '}
                      {formatBytes(updates.update.transferred)} / {formatBytes(updates.update.total)} ·{' '}
                      {formatBytes(updates.update.bytesPerSecond)}/s
                    </p>
                  )}
                  {updates.update.message != null && (
                    <p className="field__hint">{updates.update.message}</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="section" id="data" aria-labelledby="data-title">
            <div className="section__head">
              <h2 className="section__title" id="data-title">
                数据
              </h2>
              <span className="status status--success">
                <Shield size={14} aria-hidden="true" />
                本地优先
              </span>
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">数据目录</div>
                  <div className="setting-desc">
                    数据库、任务日志与 prompt 存储在用户数据目录，不写入安装目录。
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input input--mono"
                    type="text"
                    value={info.dataDir}
                    readOnly
                    aria-label="数据目录"
                  />
                  <div className="setting-inline">
                    <span className="dim small">来自 app.getPath('userData')</span>
                    <AppButton label="打开目录" size="sm" onClick={() => void openDataDir()} />
                  </div>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">引擎根目录</div>
                  <div className="setting-desc">
                    主进程从这里启动本地引擎；打包版引擎资源集成尚未实现。
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input input--mono"
                    type="text"
                    value={engine.status?.engineRoot ?? '—'}
                    readOnly
                    aria-label="引擎根目录"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">引擎日志</div>
                  <div className="setting-desc">
                    由 GUI 启动的引擎，其 stdout/stderr 追加到此文件（超过 5 MB 时启动前截断）。
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input input--mono"
                    type="text"
                    value={engine.status?.logFile ?? '—'}
                    readOnly
                    aria-label="引擎日志"
                  />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">单实例</div>
                  <div className="setting-desc">
                    应用只允许一个实例运行，避免重复启动引擎与端口冲突。
                  </div>
                </div>
                <div className="setting-control">
                  <AppStatus tone="success" label="已启用" />
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">Token 加密</div>
                  <div className="setting-desc">
                    使用 Electron safeStorage 调用系统凭据保护；Windows 上对应 DPAPI。
                  </div>
                </div>
                <div className="setting-control">
                  <AppStatus
                    tone={encryptionAvailable ? 'success' : 'warning'}
                    label={encryptionAvailable ? 'safeStorage 可用' : 'safeStorage 不可用'}
                  />
                </div>
              </div>
            </div>
          </section>

          <div className="save-bar">
            <div className="save-bar__status">
              <Check size={15} aria-hidden="true" />
              <span>凭据由主进程保存；HUD 配置即时写入 userData；引擎协作参数只读</span>
            </div>
            <div className="save-bar__actions">
              <AppButton
                label="还原"
                tone="ghost"
                onClick={() => {
                  setAutoStart(DEFAULT_STATE.autoStart);
                  setProxy(DEFAULT_STATE.proxy);
                  setAutoUpdate(DEFAULT_STATE.autoUpdate);
                  void updates.setChannel('stable');
                  void hud.setPaperPlanes(true);
                  void hud.setContextWindowTokens(128_000);
                  setNotice({ tone: 'info', title: '已还原界面状态与 HUD 配置' });
                }}
              />
              <AppButton
                label="保存更改"
                tone="primary"
                onClick={() =>
                  setNotice({
                    tone: 'info',
                    title: 'HUD 设置已即时保存',
                    text: '纸飞机动画与上下文参考值在修改时写入主进程；其余非凭据配置仍在既有范围内。',
                  })
                }
              />
            </div>
          </div>
        </div>
      </div>

      <AlertDialog
        isOpen={clearOpen}
        onOpenChange={setClearOpen}
        title="清除已保存的 Token？"
        description="清除后需要重新输入 Token；正在运行的任务不受影响。"
        cancelLabel="保留"
        actionLabel="清除 Token"
        actionVariant="destructive"
        onAction={() => {
          setClearOpen(false);
          void clearToken();
        }}
      />

      <AlertDialog
        isOpen={engineStopOpen}
        onOpenChange={setEngineStopOpen}
        title="停止本地引擎？"
        description="停止会中断正在运行的任务；引擎重启后会将未完成任务标记为 FAILED。GUI 只停止由自己启动的引擎。"
        cancelLabel="保留引擎"
        actionLabel="停止引擎"
        actionVariant="destructive"
        onAction={() => void handleStopEngine()}
      />
    </>
  );
}