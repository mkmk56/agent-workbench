import {
  Bot,
  Check,
  Database,
  KeyRound,
  Link2,
  MessagesSquare,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Terminal,
  UserCog,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Notice } from '../components/Layout';
import {
  AGENT_LIST_SOURCE_NOTE,
  agentReadOnlyReason,
  agentRoleLabel,
  agentStatusLabel,
  agentStatusTone,
  canRevokeAgent,
  describePairResult,
  formatJoinedAt,
  formatPairingExpiry,
  isBuiltinAgent,
  isExternalAgent,
  isOwnerAgent,
  loadPairedAgents,
  pairChatOptions,
  platformLabel,
  validatePairChatSelection,
  validatePairForm,
} from '../lib/agent-registry';
import type { PairChatOption, PairOutcome } from '../lib/agent-registry';
import { createPairingCode, listChatsOnce, pairAgent, revokeAgentToken } from '../lib/chat';
import { useHudConfig } from '../lib/hud';
import { startEngine, stopEngine, useAgentInfo, useEngineStatus } from '../lib/engine';
import {
  UPDATE_PHASE_LABELS,
  formatBytes,
  formatClock,
  formatUptime,
} from '../lib/labels';
import { testToken, useAppInfo, useUpdateState } from '../lib/workbench';
import type { PairedAgent, PairingCodeResult, UpdateChannel } from '../types';
import '../styles/settings-agent.css';
import {
  AlertDialog,
  AppBadge,
  AppBanner,
  AppButton,
  AppStatus,
  AppSwitch,
  AppTextField,
} from '../ui/astryx';

type SectionId = 'credentials' | 'engine' | 'executors' | 'agents' | 'hud' | 'updates' | 'data';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'credentials', label: '凭据', icon: <KeyRound size={15} /> },
  { id: 'engine', label: '引擎', icon: <Server size={15} /> },
  { id: 'executors', label: '执行器', icon: <Terminal size={15} /> },
  { id: 'agents', label: 'Agent 管理', icon: <UserCog size={15} /> },
  { id: 'hud', label: 'Agent HUD', icon: <Bot size={15} /> },
  { id: 'updates', label: '更新', icon: <RefreshCw size={15} /> },
  { id: 'data', label: '数据', icon: <Database size={15} /> },
];

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

  // Agent 管理 (REA Phase 4 §6.3): paired agents are the union of chat_members,
  // because the engine has no global agent-list tool. Pairing/revocation use the
  // real engine tools, so every mutation below refreshes this list.
  const [agents, setAgents] = useState<PairedAgent[]>([]);
  const [agentChatCount, setAgentChatCount] = useState(0);
  const [agentErrors, setAgentErrors] = useState<string[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCodeResult | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [pairForm, setPairForm] = useState({ code: '', name: '', platform: '' });
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<PairOutcome | null>(null);
  // Paired agents are only visible through chat membership, so the form joins
  // the new agent to at least one chat (acceptance §11 #5: pair → list seen).
  const [pairChatChoices, setPairChatChoices] = useState<PairChatOption[]>([]);
  const [pairChatIds, setPairChatIds] = useState<string[]>([]);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      // The chat list feeds the pairing form's chat picker: a new agent has to
      // join a chat to be visible at all (the list is the chat_members union).
      const [result, chatResult] = await Promise.all([loadPairedAgents(), listChatsOnce()]);
      if (chatResult.ok) {
        const choices = pairChatOptions(chatResult.data);
        setPairChatChoices(choices);
        // Drop selections whose chat disappeared or became archived.
        setPairChatIds((current) =>
          current.filter((id) => choices.some((choice) => choice.chat_id === id)),
        );
      }
      if (!result.ok) {
        // Real engine error, shown verbatim; the previous list is kept as-is.
        setAgentsError(result.error);
        return;
      }
      setAgentsError(null);
      setAgents(result.data.agents);
      setAgentChatCount(result.data.chatCount);
      setAgentErrors(result.data.errors);
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  // The list can only be read while the engine answers. If the first attempt
  // happened during startup, retry once it reports healthy instead of leaving a
  // stale error on screen until the user clicks 刷新.
  useEffect(() => {
    if (engine.status?.healthy === true && agentsError != null) {
      void refreshAgents();
    }
  }, [engine.status?.healthy, agentsError, refreshAgents]);

  const generatePairingCode = async () => {
    setGeneratingCode(true);
    setPairResult(null);
    try {
      const result = await createPairingCode();
      if (!result.ok) {
        setNotice({ tone: 'error', title: '生成配对码失败', text: result.error });
        return;
      }
      setPairingCode(result.data);
      setPairForm((prev) => ({ ...prev, code: result.data.code }));
      setNotice({
        tone: 'success',
        title: '配对码已生成',
        text: `${formatPairingExpiry(result.data.expires_at, Date.now())}；配对码只显示这一次，请立即交给要配对的 Agent。`,
      });
    } finally {
      setGeneratingCode(false);
    }
  };

  const submitPair = async () => {
    const problem = validatePairForm(pairForm);
    if (problem != null) {
      setNotice({ tone: 'warning', title: '配对信息不完整', text: problem });
      return;
    }
    const chatProblem = validatePairChatSelection(pairChatIds);
    if (chatProblem != null) {
      setNotice({ tone: 'warning', title: '还没有选择群', text: chatProblem });
      return;
    }
    setPairing(true);
    setPairResult(null);
    try {
      const platform = pairForm.platform.trim();
      const result = await pairAgent({
        code: pairForm.code.trim(),
        name: pairForm.name.trim(),
        platform: platform.length > 0 ? platform : undefined,
        // `agent_pair` joins these chats in the same transaction, which is what
        // makes the new agent show up in the list above right away.
        chatIds: pairChatIds,
      });
      if (!result.ok) {
        setNotice({ tone: 'error', title: '配对失败', text: result.error });
        return;
      }
      const outcome = describePairResult(result.data);
      setPairResult(outcome);
      setNotice({
        tone: 'success',
        title: `${outcome.displayName ?? outcome.agentId ?? '新 Agent'} 已配对`,
        text: `引擎已创建 Agent 记录并加入 ${pairChatIds.length} 个群，列表已刷新。`,
      });
      setPairForm({ code: '', name: '', platform: '' });
      setPairChatIds([]);
      await refreshAgents();
    } finally {
      setPairing(false);
    }
  };

  const togglePairChat = (chatId: string) => {
    setPairChatIds((current) =>
      current.includes(chatId)
        ? current.filter((id) => id !== chatId)
        : [...current, chatId],
    );
  };

  /**
   * 停用 = 撤销 Token. The engine has no `agent_enable` / `agent_disable` tool
   * (`agents.status` is written by pairing and token revocation only), so a UI
   * switch labelled "启用/停用" would be a lie. Instead the per-row action is
   * labelled 停用（撤销 Token）, runs the real `agent_revoke_token`, and the section
   * note tells the user that only re-pairing brings the agent back.
   */
  const revokeAgent = async (agent: PairedAgent) => {
    setConfirmRevokeId(null);
    setRevokingId(agent.agent_id);
    try {
      const result = await revokeAgentToken({ agentId: agent.agent_id });
      if (!result.ok) {
        setNotice({
          tone: 'error',
          title: `${agent.display_name} 停用失败`,
          text: result.error,
        });
        return;
      }
      setNotice({
        tone: 'success',
        title: `${agent.display_name} 的 Token 已撤销`,
        text: '该 Agent 无法再调用引擎；需要重新配对才能恢复。',
      });
      await refreshAgents();
    } finally {
      setRevokingId(null);
    }
  };

  const togglePaperPlanes = async (value: boolean) => {
    const saved = await hud.setPaperPlanes(value);
    setNotice({
      tone: saved ? 'success' : 'error',
      title: saved
        ? value
          ? '纸飞机动画已开启'
          : '纸飞机动画已关闭'
        : '纸飞机动画未保存',
      text: saved
        ? '配置已写入主进程 userData/hud.json，立即生效。'
        : '写入 hud.json 失败，原配置保持不变。请检查数据目录权限。',
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
    const saved = await hud.setContextWindowTokens(tokens);
    setNotice({
      tone: saved ? 'success' : 'error',
      title: saved ? '上下文参考值已保存' : '上下文参考值未保存',
      text: saved
        ? `会话流按 ${tokens.toLocaleString()} tokens 参考上限显示占用条。`
        : '写入 hud.json 失败，原参考值保持不变。请检查数据目录权限。',
    });
  };

  // Only settings that actually persist are restored: paper planes and the context
  // reference value (userData/hud.json) plus the update channel (main process).
  const restoreDefaults = async () => {
    void updates.setChannel('stable');
    const [planes, tokens] = await Promise.all([
      hud.setPaperPlanes(true),
      hud.setContextWindowTokens(128_000),
    ]);
    const saved = planes && tokens;
    if (saved) {
      setNotice({
        tone: 'info',
        title: '已还原 HUD 默认值',
        text: '纸飞机动画已开启、上下文参考值回到 128,000，更新通道回到稳定版。',
      });
    } else {
      setNotice({
        tone: 'error',
        title: 'HUD 配置未还原',
        text: '写入 hud.json 失败，未能还原的配置项保持原值。请检查数据目录权限。',
      });
    }
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
            凭据、引擎生命周期、执行器状态、Agent 配对与注销、更新管道已接入；HUD
            动效与上下文参考值已持久化，引擎协作参数只读。
          </p>
        </div>
      </div>

      <AppBanner
        status="info"
        title="本次接入范围"
        description="Token 使用 safeStorage 加密保存；引擎启停、健康检查、执行器数据来自主进程和本地引擎。Agent 管理直接调用引擎的 agent_pairing_code / agent_pair / agent_revoke_token，列表来自各群成员表。HUD 的纸飞机动画与上下文参考值写入 userData/hud.json；引擎协作参数只读展示，修改需重启引擎。"
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
                  {/* Was a read-only input with a "持久化未接入" hint: the address is
                      information, not a setting, so it is plain text now. */}
                  <p className="setting-readout">{engine.status?.baseUrl ?? '127.0.0.1:8080'}</p>
                  <p className="field__hint">
                    只读：实际值来自主进程；端口在引擎进程的配置里改，GUI 不保存该配置。
                  </p>
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
                        : engine.status.tokenSource === 'file'
                          ? '引擎启动时自动同步'
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
                  <div className="setting-desc">
                    由 GUI 拉起引擎，或连接已经运行的引擎；由主进程的实际生命周期决定。
                  </div>
                </div>
                <div className="setting-control">
                  {/* The disabled <select> looked editable but could never be saved. */}
                  <p className="setting-readout setting-readout--plain">
                    {actualLaunchMode === 'managed'
                      ? '由 GUI 启动和管理'
                      : actualLaunchMode === 'attach'
                        ? '连接现有引擎（attach）'
                        : '未运行'}
                  </p>
                  <p className="field__hint">
                    只读：GUI 没有启动方式配置项，是否需要托管由主进程在启动时判断。
                  </p>
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
                  {/* The old switch only changed component state. Main process always
                      attaches-or-starts on app ready, so this is reported, not toggled. */}
                  <AppStatus tone="success" label="由主进程固定执行" />
                  <p className="field__hint">
                    只读：这是主进程启动流程的固定行为（启动时连接或拉起引擎），没有可关闭的开关。
                  </p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">更新代理</div>
                  <div className="setting-desc">
                    用于 GitHub Releases 更新检查。系统代理可能触发 API 限流，失败时会显示具体原因。
                  </div>
                </div>
                <div className="setting-control">
                  {/* No IPC path for a proxy setting: the policy lives in the main
                      process env, so the fake select became read-only text. */}
                  <p className="setting-readout setting-readout--plain">由主进程环境变量决定</p>
                  <p className="field__hint">
                    只读：<span className="mono">AGENT_WORKBENCH_UPDATE_PROXY</span> 指定代理，
                    <span className="mono">AGENT_WORKBENCH_UPDATE_DIRECT=1</span> 直连，都不设置时跟随系统代理。
                  </p>
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

          <section className="section" id="agents" aria-labelledby="agents-title">
            <div className="section__head">
              <h2 className="section__title" id="agents-title">
                Agent 管理
              </h2>
              <div className="agent-admin__head-actions">
                <AppStatus
                  tone={agentsError != null ? 'warning' : agents.length > 0 ? 'success' : 'neutral'}
                  label={
                    agentsLoading
                      ? '读取中…'
                      : agentsError != null
                        ? '读取失败'
                        : `${agents.length} 个 Agent`
                  }
                />
                <AppButton
                  label="刷新"
                  icon={<RefreshCw size={14} />}
                  tone="ghost"
                  size="sm"
                  isLoading={agentsLoading}
                  isDisabled={agentsLoading}
                  onClick={() => void refreshAgents()}
                />
              </div>
            </div>
            <div className="section__body settings-section__body">
              <p className="agent-admin__source">{AGENT_LIST_SOURCE_NOTE}</p>

              {agentsError != null && (
                <p className="agent-admin__error">读取失败：{agentsError}</p>
              )}
              {agentErrors.length > 0 && (
                <p className="agent-admin__error">
                  部分群的成员表读取失败，列表不完整：{agentErrors.join('；')}
                </p>
              )}

              {agents.length === 0 ? (
                <p className="agent-admin__empty">
                  {agentsLoading
                    ? '正在读取各群成员…'
                    : agentsError != null
                      ? '引擎返回错误，暂时无法推导已配对 Agent；修复后点“刷新”。'
                      : agentChatCount === 0
                        ? '引擎还没有群聊：已配对 Agent 只能从群成员表推导，先建群并把 Agent 加进去。'
                        : '现有群的成员表里还没有 Agent 记录。'}
                </p>
              ) : (
                <div className="agent-admin__list">
                  {agents.map((agent) => {
                    const external = isExternalAgent(agent);
                    const builtin = isBuiltinAgent(agent);
                    const owner = isOwnerAgent(agent);
                    const confirming = confirmRevokeId === agent.agent_id;
                    const revocable = canRevokeAgent(agent);
                    return (
                      <div className="agent-admin__row" key={agent.agent_id}>
                        <div className="agent-admin__identity">
                          <div className="agent-admin__name">
                            <span>{agent.display_name}</span>
                            <span className="agent-admin__id">{agent.agent_id}</span>
                          </div>
                          <div className="agent-admin__meta">
                            <span>平台：{platformLabel(agent.platform)}</span>
                            <span>角色：{agentRoleLabel(agent.role)}</span>
                            {/* Raw engine status, before the Chinese label. */}
                            <span>状态：{agent.status}</span>
                            <span>加入：{formatJoinedAt(agent.joined_at)}</span>
                          </div>
                        </div>
                        <div className="agent-admin__state">
                          <AppStatus
                            tone={agentStatusTone(agent.status)}
                            label={agentStatusLabel(agent.status)}
                          />
                          {external && <AppBadge tone="warning" label="外部 Agent" />}
                          {builtin && !external && <AppBadge tone="neutral" label="内置" />}
                          {owner && <AppBadge tone="neutral" label="所有者" />}
                        </div>
                        <div className="agent-admin__actions">
                          {confirming ? (
                            <div className="agent-admin__confirm">
                              <span className="agent-admin__confirm-text">
                                确认停用 {agent.display_name}？Token 将立即撤销。
                              </span>
                              <AppButton
                                label="确认撤销"
                                tone="danger"
                                size="sm"
                                isLoading={revokingId === agent.agent_id}
                                isDisabled={revokingId != null}
                                onClick={() => void revokeAgent(agent)}
                              />
                              <AppButton
                                label="取消"
                                tone="ghost"
                                size="sm"
                                isDisabled={revokingId != null}
                                onClick={() => setConfirmRevokeId(null)}
                              />
                            </div>
                          ) : revocable ? (
                            <AppButton
                              label="停用（撤销 Token）"
                              tone="ghost"
                              size="sm"
                              isLoading={revokingId === agent.agent_id}
                              isDisabled={revokingId != null}
                              title="引擎没有停用工具：停用即撤销该 Agent 的 Token"
                              onClick={() => setConfirmRevokeId(agent.agent_id)}
                            />
                          ) : (
                            /* Built-ins are rejected by the engine
                               (cannot_revoke_builtin) and the owner cannot revoke
                               itself: no button, just the honest reason. */
                            <span className="agent-admin__readonly">
                              {agentReadOnlyReason(agent) ?? '只读'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <p className="agent-admin__note">
                引擎没有独立的启用/停用工具：“停用”执行的就是撤销该 Agent 的 Token
                （<span className="mono">agent_revoke_token</span>），撤销后它不能再调用引擎，
                需要重新配对才能恢复。Muse、Claude、dsh 是引擎内置身份，不持有独立 Token，
                撤销会被引擎拒绝（<span className="mono">cannot_revoke_builtin</span>），
                因此只读；只有真正配对出来的 Agent 可以撤销。
              </p>

              <div className="agent-admin__pair">
                <div className="agent-admin__pair-head">
                  <div>
                    <div className="setting-label">配对新 Agent</div>
                    <div className="setting-desc">
                      向引擎申请一次性配对码（
                      <span className="mono">agent_pairing_code</span>
                      ），再由 Agent 用配对码换 Token。
                    </div>
                  </div>
                  <AppButton
                    label={pairingCode != null ? '重新生成配对码' : '生成配对码'}
                    icon={<Link2 size={15} />}
                    size="sm"
                    isLoading={generatingCode}
                    isDisabled={generatingCode}
                    onClick={() => void generatePairingCode()}
                  />
                </div>

                {pairingCode != null && (
                  <div className="agent-admin__code">
                    <span className="agent-admin__code-value">{pairingCode.code}</span>
                    <div className="agent-admin__code-meta">
                      <span>有效期至 {formatPairingExpiry(pairingCode.expires_at, Date.now())}</span>
                      <span>最多可配对 {pairingCode.max_agents} 个 Agent</span>
                      <span>已使用 {pairingCode.uses} 次</span>
                    </div>
                    {/* The engine returns the code once and has no API to read it back. */}
                    <p className="field__hint">
                      配对码只在这里显示一次（引擎不提供再次查询）：离开本页或重新生成前请先复制。
                    </p>
                  </div>
                )}

                <div className="agent-admin__form">
                  <AppTextField
                    label="配对码"
                    value={pairForm.code}
                    onChange={(value) => setPairForm((prev) => ({ ...prev, code: value }))}
                    placeholder="粘贴配对码"
                    containerClassName="pair-field"
                  />
                  <AppTextField
                    label="Agent 名称"
                    value={pairForm.name}
                    onChange={(value) => setPairForm((prev) => ({ ...prev, name: value }))}
                    placeholder="例如 Reviewer"
                    containerClassName="pair-field"
                  />
                  <AppTextField
                    label="平台（可选）"
                    value={pairForm.platform}
                    onChange={(value) => setPairForm((prev) => ({ ...prev, platform: value }))}
                    placeholder="claude / dsh / muse"
                    containerClassName="pair-field"
                  />
                  <div className="agent-admin__form-actions">
                    <AppButton
                      label="完成配对"
                      tone="primary"
                      size="sm"
                      isLoading={pairing}
                      isDisabled={pairing || pairChatChoices.length === 0}
                      onClick={() => void submitPair()}
                    />
                  </div>
                </div>

                {/* `agent_pair` accepts `chat_ids`; joining here is what makes the
                    new agent appear in the list above immediately. */}
                <fieldset className="agent-admin__chats">
                  <legend className="setting-label">加入哪些群（至少一个）</legend>
                  <p className="field__hint">
                    已配对 Agent 的列表来自各群成员表（引擎没有全局 Agent 列表工具），
                    不加入任何群的 Agent 不会出现在上面的列表里。
                  </p>
                  {pairChatChoices.length === 0 ? (
                    <p className="agent-admin__empty">
                      引擎还没有可加入的群聊：先在聊天里建一个群，再回来配对。
                    </p>
                  ) : (
                    <div
                      className="agent-admin__chat-list"
                      role="group"
                      aria-label="选择要加入的群"
                    >
                      {pairChatChoices.map((choice) => (
                        <label className="agent-admin__chat" key={choice.chat_id}>
                          <input
                            type="checkbox"
                            checked={pairChatIds.includes(choice.chat_id)}
                            onChange={() => togglePairChat(choice.chat_id)}
                          />
                          <span className="agent-admin__chat-name">{choice.name}</span>
                          <span className="agent-admin__chat-id">{choice.chat_id}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>

                {pairResult != null && (
                  <div className="agent-admin__result">
                    <span className="agent-admin__result-line">
                      已配对：{pairResult.displayName ?? pairResult.agentId ?? '新 Agent'}
                      {pairResult.agentId != null && pairResult.displayName != null
                        ? `（${pairResult.agentId}）`
                        : ''}
                    </span>
                    {pairResult.token != null && (
                      <>
                        <span className="agent-admin__result-line">
                          Agent Token（引擎只返回这一次，请立即交给该 Agent 保存）：
                        </span>
                        <span className="agent-admin__result-token">{pairResult.token}</span>
                      </>
                    )}
                  </div>
                )}
              </div>
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
                    tone={protocol == null ? 'neutral' : protocol.enabled ? 'success' : 'neutral'}
                    label={
                      protocol == null
                        ? '读取中…'
                        : protocol.enabled
                          ? '引擎已启用'
                          : '引擎未启用'
                    }
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
                    {protocol == null
                      ? '读取中…'
                      : protocol.exchange_limit != null
                        ? `${protocol.exchange_limit} 条`
                        : '—'}
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
                    {protocol == null
                      ? '读取中…'
                      : protocol.summary_max_tokens != null
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
                    tone={protocol == null ? 'neutral' : protocol.auto_deliver ? 'success' : 'neutral'}
                    label={
                      protocol == null
                        ? '读取中…'
                        : protocol.auto_deliver
                          ? '已开启'
                          : '已关闭'
                    }
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
                      tone={gate == null ? 'neutral' : gate.enabled ? 'warning' : 'neutral'}
                      label={
                        gate == null ? '读取中…' : gate.enabled ? '已开启' : '关闭（默认）'
                      }
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
                  {/* The old switch was pure component state; the main process owns
                      the schedule, so the real behaviour is reported as text. */}
                  <AppStatus
                    tone={info.update.supported ? 'success' : 'neutral'}
                    label={info.update.supported ? '打包版自动执行' : '仅打包版'}
                  />
                  <p className="field__hint">
                    只读：由主进程调度（
                    <span className="mono">AGENT_WORKBENCH_AUTO_UPDATE_CHECK=0</span> 可禁用）；
                    GUI 没有开关。
                  </p>
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
              <span>
                凭据由主进程保存；HUD 配置修改即写入 userData；引擎协作参数与配对信息只读或直接调用引擎
              </span>
            </div>
            <div className="save-bar__actions">
              {/* No "保存更改" button: HUD settings save on change (hud.json), so the
                  only honest action left here is restoring their defaults. */}
              <AppButton
                label="还原 HUD 默认值"
                tone="ghost"
                title="纸飞机动画开启、上下文参考值 128,000、更新通道稳定版"
                onClick={() => {
                  void restoreDefaults();
                }}
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