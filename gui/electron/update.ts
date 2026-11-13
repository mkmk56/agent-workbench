import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';

export type UpdateChannel = 'stable' | 'prerelease';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported';

export interface UpdateState {
  supported: boolean;
  channel: UpdateChannel;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  message: string | null;
  checkedAt: string | null;
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
}

interface TraceEvent {
  at: string;
  elapsedMs: number;
  event: string;
  detail?: unknown;
}

const TRACE_FILE = process.env.AGENT_WORKBENCH_UPDATE_TRACE?.trim() || null;
const AUTO_CHECK_DISABLED = process.env.AGENT_WORKBENCH_AUTO_UPDATE_CHECK === '0';
const STARTED_AT = Date.now();

const logger = {
  info: (message?: unknown) => log('info', message),
  warn: (message?: unknown) => log('warn', message),
  error: (message?: unknown) => log('error', message),
  debug: (message?: unknown) => log('debug', message),
};

function log(level: string, message: unknown): void {
  if (process.env.AGENT_WORKBENCH_UPDATE_DEBUG !== '1') {
    return;
  }
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'engine', 'updater.log'),
      `${new Date().toISOString()} [${level}] ${text}\n`,
      'utf8',
    );
  } catch {
    // Updater logging must never break the update flow.
  }
}

function trace(event: string, detail?: unknown): void {
  if (TRACE_FILE == null) {
    return;
  }
  const entry: TraceEvent = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - STARTED_AT,
    event,
    ...(detail === undefined ? {} : { detail }),
  };
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Verification tracing is best effort.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class UpdateManager {
  private channel: UpdateChannel = 'stable';
  private state: UpdateState;
  private proxyReady: Promise<void>;
  private checkTimer: NodeJS.Timeout | null = null;
  private lastProgressMilestone = -1;

  constructor(private readonly onChange: (state: UpdateState) => void) {
    this.state = {
      supported: app.isPackaged,
      channel: this.channel,
      phase: app.isPackaged ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      availableVersion: null,
      releaseDate: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      message: app.isPackaged ? null : '开发构建不检查更新；请使用打包版本验证更新流程。',
      checkedAt: null,
      canCheck: app.isPackaged,
      canDownload: false,
      canInstall: false,
    };

    this.proxyReady = this.applyProxyPolicy();

    if (app.isPackaged) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowDowngrade = false;
      autoUpdater.logger = logger;
      this.applyChannel();
      this.bindEvents();
    }
  }

  private async applyProxyPolicy(): Promise<void> {
    const direct = process.env.AGENT_WORKBENCH_UPDATE_DIRECT === '1';
    const proxy = process.env.AGENT_WORKBENCH_UPDATE_PROXY?.trim();
    if (!direct && !proxy) {
      return;
    }
    try {
      await autoUpdater.netSession.setProxy(
        direct ? { mode: 'direct' } : { proxyRules: proxy },
      );
      trace('proxy-configured', direct ? { mode: 'direct' } : { proxyRules: proxy });
    } catch (error) {
      trace('proxy-error', { error: errorMessage(error) });
    }
  }

  private applyChannel(): void {
    // GitHub provider: allowPrerelease lets rc/beta releases be discovered.
    // The channel file remains latest.yml, which prerelease builds also emit.
    autoUpdater.allowPrerelease = this.channel === 'prerelease';
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.patch({ phase: 'checking', message: null, progressPercent: null });
      trace('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.patch({
        phase: 'available',
        availableVersion: info.version,
        releaseDate: info.releaseDate ?? null,
        message: `发现新版本 ${info.version}。`,
        checkedAt: new Date().toISOString(),
        progressPercent: null,
        transferred: null,
        total: null,
        canDownload: true,
      });
      trace('update-available', { version: info.version, releaseDate: info.releaseDate ?? null });
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.patch({
        phase: 'not-available',
        availableVersion: null,
        releaseDate: null,
        message: `当前已是最新版本（${info.version}）。`,
        checkedAt: new Date().toISOString(),
        canDownload: false,
        canInstall: false,
      });
      trace('update-not-available', { version: info.version });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.patch({
        phase: 'downloading',
        progressPercent: Math.round(progress.percent * 10) / 10,
        bytesPerSecond: Math.round(progress.bytesPerSecond),
        transferred: progress.transferred,
        total: progress.total,
        canDownload: false,
      });
      const milestone = Math.floor(progress.percent / 25) * 25;
      if (milestone > 0 && milestone % 25 === 0 && milestone !== this.lastProgressMilestone) {
        this.lastProgressMilestone = milestone;
        trace('download-progress', {
          percent: Math.round(progress.percent * 10) / 10,
          milestone,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: Math.round(progress.bytesPerSecond),
        });
      }
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.patch({
        phase: 'downloaded',
        availableVersion: info.version,
        progressPercent: 100,
        message: `新版本 ${info.version} 已下载，可安装并重启。`,
        canDownload: false,
        canInstall: true,
      });
      trace('update-downloaded', { version: info.version });
    });

    autoUpdater.on('error', (error: Error) => {
      this.fail(error);
    });
  }

  private patch(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    this.onChange(this.state);
  }

  private fail(error: unknown): void {
    const message = errorMessage(error);
    const friendly = /net::|ENOTFOUND|ECONN|ETIMEDOUT|proxy|403|404|504/i.test(message)
      ? `更新检查失败：${message}。可检查网络/系统代理，或用 AGENT_WORKBENCH_UPDATE_DIRECT=1 强制直连后重试。`
      : `更新失败：${message}`;
    this.patch({
      phase: 'error',
      message: friendly,
      canCheck: this.state.supported,
      canDownload: false,
      canInstall: false,
    });
    trace('error', { error: message });
  }

  getState(): UpdateState {
    return this.state;
  }

  setChannel(channel: UpdateChannel): UpdateState {
    if (channel !== 'stable' && channel !== 'prerelease') {
      return this.state;
    }
    this.channel = channel;
    if (app.isPackaged) {
      this.applyChannel();
    }
    this.patch({ channel });
    trace('channel-changed', { channel });
    return this.state;
  }

  scheduleAutoCheck(delayMs = 8_000): void {
    if (!app.isPackaged || AUTO_CHECK_DISABLED || this.checkTimer != null) {
      return;
    }
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.check();
    }, delayMs);
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) {
      return this.state;
    }
    await this.proxyReady;
    this.lastProgressMilestone = -1;
    this.patch({
      phase: 'checking',
      message: null,
      availableVersion: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferred: null,
      total: null,
      canDownload: false,
      canInstall: false,
      checkedAt: null,
    });
    trace('check-start', {
      currentVersion: app.getVersion(),
      channel: this.channel,
    });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  async download(): Promise<UpdateState> {
    if (!app.isPackaged || this.state.phase !== 'available') {
      return this.state;
    }
    trace('download-start', { version: this.state.availableVersion });
    this.patch({ phase: 'downloading', message: '正在下载更新…', progressPercent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  install(): { ok: boolean; error?: string } {
    if (!app.isPackaged || this.state.phase !== 'downloaded') {
      return { ok: false, error: '当前没有已下载的更新。' };
    }
    trace('install-start', { version: this.state.availableVersion });
    this.patch({ phase: 'installing', message: '正在退出并安装更新…' });
    try {
      // Silent NSIS install; the app is relaunched by the user or installer.
      autoUpdater.quitAndInstall(true, false);
      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      this.fail(error);
      return { ok: false, error: message };
    }
  }
}

export { errorMessage as updateErrorMessage };