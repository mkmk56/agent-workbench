import {
  Database,
  KeyRound,
  RefreshCw,
  Server,
  Shield,
  Check,
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Notice } from '../components/Layout';
import { useAppInfo } from '../lib/workbench';
import {
  AlertDialog,
  AppBadge,
  AppBanner,
  AppButton,
  AppStatus,
  AppSwitch,
  AppTextField,
} from '../ui/astryx';

type SectionId = 'credentials' | 'engine' | 'updates' | 'data';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'credentials', label: '凭据', icon: <KeyRound size={15} /> },
  { id: 'engine', label: '引擎', icon: <Server size={15} /> },
  { id: 'updates', label: '更新', icon: <RefreshCw size={15} /> },
  { id: 'data', label: '数据', icon: <Database size={15} /> },
];

const DEFAULT_STATE = {
  port: '8080',
  launchMode: 'managed',
  autoStart: true,
  proxy: 'system',
  autoUpdate: true,
  channel: 'stable',
};

export function SettingsPage() {
  const { info, refresh } = useAppInfo();
  const [activeSection, setActiveSection] = useState<SectionId>('credentials');
  const [tokenStored, setTokenStored] = useState<boolean | null>(null);
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'error';
    title: string;
    text?: string;
  } | null>(null);

  const [port, setPort] = useState(DEFAULT_STATE.port);
  const [launchMode, setLaunchMode] = useState(DEFAULT_STATE.launchMode);
  const [autoStart, setAutoStart] = useState(DEFAULT_STATE.autoStart);
  const [proxy, setProxy] = useState(DEFAULT_STATE.proxy);
  const [autoUpdate, setAutoUpdate] = useState(DEFAULT_STATE.autoUpdate);
  const [channel, setChannel] = useState(DEFAULT_STATE.channel);

  const stored = tokenStored ?? info.tokenStored;
  const encryptionAvailable = info.encryptionAvailable;

  const scrollTo = (id: SectionId) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">
            凭据保存已接入主进程；引擎、更新与其余设置仍是界面状态，本轮不会持久化。
          </p>
        </div>
      </div>

      <AppBanner
        status="info"
        title="本轮为可运行界面壳"
        description="Token 使用 safeStorage 加密保存并已接入；引擎 IPC、任务派发、更新管道与其余设置尚未接入。修改非凭据设置只影响当前界面状态。"
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
                      label="测试连接"
                      tone="ghost"
                      size="sm"
                      isDisabled
                      title="引擎 IPC 尚未接入"
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
              <AppStatus tone="neutral" label="未接入" />
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">本地端口</div>
                  <div className="setting-desc">
                    GUI 通过 127.0.0.1 连接引擎。修改端口后需要重启引擎。
                  </div>
                </div>
                <div className="setting-control">
                  <input
                    className="input input--mono"
                    type="text"
                    inputMode="numeric"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    aria-label="本地端口"
                  />
                  <p className="field__hint">范围 1024–65535；默认 8080。仅界面状态。</p>
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
                    value={launchMode}
                    onChange={(event) => setLaunchMode(event.target.value)}
                  >
                    <option value="managed">由 GUI 启动和管理</option>
                    <option value="attach">连接现有引擎</option>
                  </select>
                  <p className="field__hint">连接现有引擎时需要提供 Token。</p>
                </div>
              </div>

              <div className="setting-row">
                <div>
                  <div className="setting-label">随应用启动</div>
                  <div className="setting-desc">
                    打开应用时自动启动引擎；关闭应用时停止由 GUI 启动的引擎。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="muted">仅界面状态</span>
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
                  <div className="setting-desc">重启会中断正在运行的任务；停止引擎前会二次确认。</div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <AppStatus tone="neutral" label="未接入" />
                    <div className="setting-buttons">
                      <AppButton
                        label="重启引擎"
                        size="sm"
                        isDisabled
                        title="引擎 IPC 尚未接入"
                      />
                      <AppButton
                        label="停止"
                        tone="ghost"
                        size="sm"
                        isDisabled
                        title="引擎 IPC 尚未接入"
                      />
                    </div>
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
              <AppStatus tone="neutral" label="更新管道未接入" />
            </div>
            <div className="section__body settings-section__body">
              <div className="setting-row">
                <div>
                  <div className="setting-label">自动检查更新</div>
                  <div className="setting-desc">
                    启动时检查 GitHub Releases；发现新版本后提示下载与安装。
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
                  <div className="setting-desc">稳定版只接收正式发布；预发布版用于验证更新流程。</div>
                </div>
                <div className="setting-control">
                  <select
                    className="select"
                    aria-label="更新通道"
                    value={channel}
                    onChange={(event) => setChannel(event.target.value)}
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
                    安装包暂未签名，Windows SmartScreen 首次运行时会提示；自动更新管道尚未实现。
                  </div>
                </div>
                <div className="setting-control">
                  <div className="setting-inline">
                    <span className="mono">v{info.version}</span>
                    <AppButton
                      label="检查更新"
                      size="sm"
                      isDisabled
                      title="更新管道尚未接入"
                    />
                  </div>
                  <p className="field__hint">本轮不实现 GitHub Actions 发布流水线与更新验证。</p>
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
              <span>凭据由主进程保存；其余设置为界面状态</span>
            </div>
            <div className="save-bar__actions">
              <AppButton
                label="还原"
                tone="ghost"
                onClick={() => {
                  setPort(DEFAULT_STATE.port);
                  setLaunchMode(DEFAULT_STATE.launchMode);
                  setAutoStart(DEFAULT_STATE.autoStart);
                  setProxy(DEFAULT_STATE.proxy);
                  setAutoUpdate(DEFAULT_STATE.autoUpdate);
                  setChannel(DEFAULT_STATE.channel);
                  setNotice({ tone: 'info', title: '已还原界面状态' });
                }}
              />
              <AppButton
                label="保存更改"
                tone="primary"
                onClick={() =>
                  setNotice({
                    tone: 'warning',
                    title: '设置尚未持久化',
                    text: '本轮只接入凭据保存；引擎、更新与数据设置的主进程存储将在后续任务实现。',
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
    </>
  );
}