import { ExternalLink, RefreshCw } from 'lucide-react';
import logoInverse from '@brand/logo/logo-inverse.svg';
import logoPrimary from '@brand/logo/logo-primary.svg';
import { useState } from 'react';
import { Notice } from '../components/Layout';
import { UPDATE_PHASE_LABELS, formatBytes } from '../lib/labels';
import { openExternal, platformLabel, useAppInfo, useUpdateState } from '../lib/workbench';
import { AppBadge, AppButton, AppStatus } from '../ui/astryx';

const REPO_URL = 'https://github.com/mkmk56/agent-workbench';
const RELEASES_URL = 'https://github.com/mkmk56/agent-workbench/releases';
const ASTRYX_URL = 'https://github.com/meta/astryx';

export function AboutPage() {
  const { info } = useAppInfo();
  const updates = useUpdateState();
  const [notice, setNotice] = useState<string | null>(null);

  const handleUpdateCheck = async () => {
    const next = await updates.check();
    if (next.phase === 'error') {
      setNotice(next.message ?? '检查更新失败');
    } else {
      setNotice(null);
    }
  };

  const handleUpdateDownload = async () => {
    const next = await updates.download();
    if (next.phase === 'error') {
      setNotice(next.message ?? '下载更新失败');
    }
  };

  const handleUpdateInstall = async () => {
    const result = await updates.install();
    if (!result.ok) {
      setNotice(result.error ?? '安装更新失败');
    }
  };

  const open = async (url: string) => {
    const result = await openExternal(url);
    if (!result.ok) {
      setNotice(result.error ?? '无法打开链接');
    } else {
      setNotice(null);
    }
  };

  return (
    <>
      <div className="about">
        <div className="about__brand">
          <img className="logo about__logo logo--light" src={logoPrimary} alt="Agent Workbench" />
          <img className="logo about__logo logo--dark" src={logoInverse} alt="Agent Workbench" />
          <div className="about__meta">
            <h1 className="sr-only">Agent Workbench</h1>
            <p className="about__tagline">AI 编程智能体的任务控制台</p>
            <div className="about__version">
              <AppBadge tone="neutral" label={`v${info.version}`} />
              <AppStatus
                tone={info.isPackaged ? 'success' : 'neutral'}
                label={info.isPackaged ? '已打包构建' : '开发构建'}
              />
            </div>
          </div>
        </div>

        {notice != null && (
          <div style={{ marginBottom: '18px' }}>
            <Notice tone="warning" title="操作未完成">
              {notice}
            </Notice>
          </div>
        )}

        <div className="about__grid">
          <section className="about__section" aria-labelledby="build-title">
            <h2 id="build-title">构建信息</h2>
            <dl className="meta-list">
              <div className="meta-row">
                <dt>版本</dt>
                <dd className="mono">{info.version}</dd>
              </div>
              <div className="meta-row">
                <dt>构建类型</dt>
                <dd>{info.isPackaged ? '打包构建' : '开发构建（Vite）'}</dd>
              </div>
              <div className="meta-row">
                <dt>平台</dt>
                <dd>{platformLabel(info.platform, info.arch)}</dd>
              </div>
              <div className="meta-row">
                <dt>Electron</dt>
                <dd className="mono">{info.versions.electron}</dd>
              </div>
              <div className="meta-row">
                <dt>Node</dt>
                <dd className="mono">{info.versions.node}</dd>
              </div>
              <div className="meta-row">
                <dt>Chromium</dt>
                <dd className="mono">{info.versions.chrome}</dd>
              </div>
              <div className="meta-row">
                <dt>更新源</dt>
                <dd>GitHub Releases{info.update.supported ? '' : '（仅打包版可用）'}</dd>
              </div>
            </dl>
          </section>

          <section className="about__section" aria-labelledby="update-title">
            <h2 id="update-title">更新</h2>
            <p>
              打包版启动后自动检查 GitHub Releases，也可手动检查。更新由 electron-updater
              下载，并通过 NSIS 静默安装；开发构建不检查更新。
            </p>
            <p style={{ marginTop: 8 }}>
              安装包暂未签名，首次运行可能触发 Windows SmartScreen 提示。
            </p>
            <div className="setting-inline" style={{ marginTop: 16 }}>
              <AppStatus
                tone={updates.update.phase === 'error' ? 'error' : info.update.supported ? 'success' : 'neutral'}
                label={
                  info.update.supported
                    ? UPDATE_PHASE_LABELS[updates.update.phase]
                    : '仅打包版可用'
                }
              />
              {updates.update.phase === 'available' ? (
                <AppButton
                  label="下载更新"
                  size="sm"
                  icon={<RefreshCw size={14} />}
                  onClick={() => void handleUpdateDownload()}
                />
              ) : updates.update.phase === 'downloaded' ? (
                <AppButton
                  label="安装并退出"
                  size="sm"
                  icon={<RefreshCw size={14} />}
                  onClick={() => void handleUpdateInstall()}
                />
              ) : (
                <AppButton
                  label={updates.update.phase === 'checking' ? '检查中…' : '检查更新'}
                  size="sm"
                  icon={<RefreshCw size={14} />}
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
              <p className="field__hint" style={{ marginTop: 8 }}>
                {updates.update.progressPercent ?? 0}% ·{' '}
                {formatBytes(updates.update.transferred)} / {formatBytes(updates.update.total)}
              </p>
            )}
            {updates.update.message != null && (
              <p className="field__hint" style={{ marginTop: 8 }}>
                {updates.update.message}
              </p>
            )}
          </section>
        </div>

        <section className="about__section about__section--divided" aria-labelledby="license-title">
          <h2 id="license-title">许可与第三方</h2>
          <p className="about__licenses">
            Agent Workbench 以 MIT 许可证发布。界面组件基于 Astryx（MIT）；品牌图标与字标为项目资产，
            字标轮廓使用 Inter（SIL OFL 1.1）；界面图标风格参考 Lucide（ISC）。
          </p>
        </section>

        <div className="about__links">
          <AppButton
            label="GitHub 仓库"
            size="sm"
            icon={<ExternalLink size={14} />}
            onClick={() => void open(REPO_URL)}
          />
          <AppButton
            label="发布记录"
            tone="ghost"
            size="sm"
            icon={<ExternalLink size={14} />}
            onClick={() => void open(RELEASES_URL)}
          />
          <AppButton
            label="Astryx"
            tone="ghost"
            size="sm"
            icon={<ExternalLink size={14} />}
            onClick={() => void open(ASTRYX_URL)}
          />
        </div>

        <p className="about__footer">
          © 2026 Agent Workbench · 本地优先，任务数据不离开本机
        </p>
      </div>
    </>
  );
}