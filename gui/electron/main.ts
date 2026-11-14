import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EngineManager, errorMessage } from './engine';
import { UpdateManager, type UpdateChannel, type UpdateState } from './update';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';
const DEV_ORIGIN = new URL(DEV_URL).origin;
const PROD_INDEX_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'index.html'),
).href;

// Data lives in the per-user application data directory, never in the
// install directory. This is also the directory the settings screen shows.
app.setName('Agent Workbench');
app.setPath('userData', path.join(app.getPath('appData'), 'agent-workbench'));

const DATA_DIR = app.getPath('userData');
const CREDENTIALS_DIR = path.join(DATA_DIR, 'credentials');
const TOKEN_FILE = path.join(CREDENTIALS_DIR, 'token.enc');
const HUD_CONFIG_FILE = path.join(DATA_DIR, 'hud.json');

type Result = { ok: boolean; error?: string };

interface HudConfig {
  paperPlanes: boolean;
}

const DEFAULT_HUD_CONFIG: HudConfig = { paperPlanes: true };

function readHudConfig(): HudConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(HUD_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    return {
      paperPlanes:
        typeof raw.paperPlanes === 'boolean'
          ? raw.paperPlanes
          : DEFAULT_HUD_CONFIG.paperPlanes,
    };
  } catch {
    return { ...DEFAULT_HUD_CONFIG };
  }
}

function writeHudConfig(patch: unknown): HudConfig {
  const current = readHudConfig();
  const value = patch != null && typeof patch === 'object' && !Array.isArray(patch)
    ? (patch as Record<string, unknown>)
    : {};
  if (typeof value.paperPlanes === 'boolean') {
    current.paperPlanes = value.paperPlanes;
  }
  ensureDataDir();
  const tempFile = `${HUD_CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, HUD_CONFIG_FILE);
  return current;
}

let mainWindow: BrowserWindow | null = null;
let updateManager: UpdateManager | null = null;

const VERIFY_MODE = process.argv.includes('--update-verify');
const PRINT_VERSION_MODE = process.argv.includes('--print-version');

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hasStoredToken(): boolean {
  try {
    return fs.statSync(TOKEN_FILE).isFile();
  } catch {
    return false;
  }
}

function writeToken(token: string): Result {
  const value = token.trim();
  if (value.length === 0 || value.length > 8192) {
    return { ok: false, error: 'Token 长度无效（1–8192 个字符）。' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: '系统安全存储不可用，未保存 Token。' };
  }

  try {
    ensureDataDir();
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    const encrypted = safeStorage.encryptString(value);
    const tempFile = `${TOKEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, encrypted, { mode: 0o600 });
    fs.renameSync(tempFile, TOKEN_FILE);
    try {
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch {
      // Windows does not implement POSIX modes; the file is still under userData.
    }
    return { ok: true };
  } catch {
    // Never include the token or raw exception text in messages to the renderer.
    return { ok: false, error: '保存 Token 失败，请检查数据目录写入权限。' };
  }
}

function readToken(): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const encrypted = fs.readFileSync(TOKEN_FILE);
    const value = safeStorage.decryptString(encrypted).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function clearToken(): Result {
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: '删除已保存的 Token 失败。' };
  }
}

const engine = new EngineManager(readToken);

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (isDev) {
    try {
      return new URL(url).origin === DEV_ORIGIN;
    } catch {
      return false;
    }
  }
  return url === PROD_INDEX_URL || url.startsWith(`${PROD_INDEX_URL}#`);
}

function handle<T>(channel: string, handler: (...args: unknown[]) => T): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Blocked IPC call from an untrusted origin');
    }
    return handler(...args);
  });
}

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
]);

async function openExternal(rawUrl: unknown): Promise<Result> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return { ok: false, error: '链接无效。' };
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(url.hostname)) {
      return { ok: false, error: '该链接不在允许打开的外部站点列表中。' };
    }
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: '无法打开该链接。' };
  }
}

function currentUpdateState(): UpdateState {
  if (updateManager != null) {
    return updateManager.getState();
  }
  return {
    supported: false,
    channel: 'stable',
    phase: 'unsupported',
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseDate: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferred: null,
    total: null,
    message: '更新管理器尚未初始化。',
    checkedAt: null,
    canCheck: false,
    canDownload: false,
    canInstall: false,
  };
}

function writeVerificationRecord(kind: string, payload: Record<string, unknown>): void {
  const target = process.env.AGENT_WORKBENCH_UPDATE_TRACE?.trim();
  const record = {
    at: new Date().toISOString(),
    kind,
    version: app.getVersion(),
    packaged: app.isPackaged,
    executable: app.getPath('exe'),
    ...payload,
  };
  if (target == null || target.length === 0) {
    console.log(JSON.stringify(record));
    return;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(`${target}.result.jsonl`, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Verification output is best effort.
  }
}

function updateChannelFromArgs(): UpdateChannel {
  const arg = process.argv.find((value) => value.startsWith('--update-channel='));
  const value = arg?.slice('--update-channel='.length) ?? process.env.AGENT_WORKBENCH_UPDATE_CHANNEL;
  return value === 'prerelease' ? 'prerelease' : 'stable';
}

async function runUpdateVerification(manager: UpdateManager): Promise<void> {
  const channel = updateChannelFromArgs();
  manager.setChannel(channel);
  writeVerificationRecord('verify-start', { channel, argv: process.argv.slice(1) });

  const checked = await manager.check();
  if (checked.phase !== 'available') {
    writeVerificationRecord('verify-no-update', { phase: checked.phase, message: checked.message });
    app.quit();
    return;
  }

  const downloaded = await manager.download();
  if (downloaded.phase !== 'downloaded') {
    writeVerificationRecord('verify-download-failed', {
      phase: downloaded.phase,
      message: downloaded.message,
    });
    app.quit();
    return;
  }

  writeVerificationRecord('verify-install', {
    availableVersion: downloaded.availableVersion,
  });
  const installed = manager.install();
  if (!installed.ok) {
    writeVerificationRecord('verify-install-failed', { error: installed.error });
    app.quit();
    return;
  }
  // quitAndInstall exits the process. The timer is a fallback if the
  // installer fails to take over within 60 seconds.
  setTimeout(() => app.quit(), 60_000).unref();
}

function registerIpc(): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: DATA_DIR,
    cwd: process.cwd(),
    engineWorkdir: engine.engineRoot,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    tokenStored: hasStoredToken(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    update: {
      supported: app.isPackaged,
      channel: currentUpdateState().channel,
      reason: app.isPackaged
        ? 'GitHub Releases（electron-updater，支持预发布通道）。'
        : '开发构建不检查更新；请使用打包版本验证更新流程。',
    },
    versions: {
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '',
    },
  }));

  handle('credentials:set-token', (token) => writeToken(typeof token === 'string' ? token : ''));
  handle('credentials:clear-token', () => clearToken());
  handle('app:open-data-dir', async () => {
    ensureDataDir();
    const error = await shell.openPath(DATA_DIR);
    return error ? { ok: false, error } : { ok: true };
  });
  handle('app:open-external', (url) => openExternal(url));
  handle('clipboard:write-text', (text) => {
    if (typeof text !== 'string' || text.length > 500_000) {
      return { ok: false, error: '复制内容无效或过大。' };
    }
    clipboard.writeText(text);
    return { ok: true };
  });

  handle('update:state', () => currentUpdateState());
  handle('update:check', () => updateManager?.check() ?? currentUpdateState());
  handle('update:download', () => updateManager?.download() ?? currentUpdateState());
  handle('update:install', () => updateManager?.install() ?? { ok: false, error: '更新管理器未初始化。' });
  handle('update:set-channel', (channel) => {
    if (channel !== 'stable' && channel !== 'prerelease') {
      throw new Error('更新通道必须是 stable 或 prerelease。');
    }
    return updateManager?.setChannel(channel) ?? currentUpdateState();
  });

  handle('hud:get-config', () => readHudConfig());
  handle('hud:set-config', (patch) => writeHudConfig(patch));

  handle('engine:status', () => engineResult(() => engine.status()));
  handle('engine:start', () => engineResult(() => engine.start()));
  handle('engine:stop', () => engineResult(() => engine.stop()));
  handle('engine:agent-info', () => engineResult(() => engine.agentInfo()));

  handle('engine:task-list', (limit) => {
    const resolved = optionalInteger(limit, 1, 500, 200);
    return engineResult(() => engine.listTasks(resolved));
  });

  handle('engine:message-list', (limit) => {
    const resolved = optionalInteger(limit, 1, 500, 500);
    return engineResult(() => engine.listMessages(resolved));
  });

  handle('engine:task-status', (taskId) =>
    engineResult(() => engine.taskStatus(requireTaskId(taskId))),
  );

  handle('engine:task-logs', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      const taskId = requireTaskId(value.taskId);
      const cursor = optionalInteger(value.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = optionalInteger(value.limit, 1, 1000, 200);
      return engine.taskLogs(taskId, cursor, limit);
    }),
  );

  handle('engine:task-start', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      if (value.agent !== 'claude' && value.agent !== 'dsh') {
        throw new Error('执行器必须是 claude 或 dsh。');
      }
      const prompt = requireText(value.prompt, 'Prompt', 20_000);
      const cwd =
        value.cwd == null || value.cwd === ''
          ? undefined
          : requireText(value.cwd, '工作目录', 1_024);
      const timeoutMs = optionalInteger(value.timeoutMs, 1_000, 86_400_000, 30 * 60 * 1000);
      return engine.startTask({ agent: value.agent, prompt, cwd, timeout_ms: timeoutMs });
    }),
  );

  handle('engine:task-send', (taskId, prompt) =>
    engineResult(() =>
      engine.sendTask(requireTaskId(taskId), requireText(prompt, '跟进消息', 20_000)),
    ),
  );

  handle('engine:task-cancel', (taskId) =>
    engineResult(() => engine.cancelTask(requireTaskId(taskId))),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('参数格式无效。');
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串。`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} 不能为空。`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} 超过 ${maxLength} 个字符。`);
  }
  return value;
}

function requireTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('任务 ID 无效。');
  }
  return value;
}

function optionalInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`数值参数必须是 ${min}–${max} 之间的整数。`);
  }
  return parsed;
}

async function engineResult<T>(
  call: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function applySessionPolicy(): void {
  const devCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${DEV_URL} ws://127.0.0.1:5173`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  const prodCsp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  const csp = isDev ? devCsp : prodCsp;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function openAllowedExternal(rawUrl: string): void {
  void openExternal(rawUrl);
}

function createWindow(): void {
  const iconPath = path.join(
    __dirname,
    '..',
    '..',
    'assets',
    'branding',
    'app-icon',
    'agent-workbench.ico',
  );

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#F5F3EE',
    autoHideMenuBar: true,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (url !== current) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow == null) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  void app.whenReady().then(() => {
    ensureDataDir();
    app.setAppUserModelId('com.agentworkbench.gui');

    if (PRINT_VERSION_MODE) {
      writeVerificationRecord('version', {});
      app.quit();
      return;
    }

    applySessionPolicy();
    updateManager = new UpdateManager((state) => {
      if (mainWindow != null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:state', state);
      }
    });
    registerIpc();

    if (VERIFY_MODE) {
      void runUpdateVerification(updateManager);
      return;
    }

    Menu.setApplicationMenu(null);
    createWindow();

    // Attach to an already running engine, otherwise start one that this
    // process owns. Failures are surfaced through engine:status and the UI.
    void engine.start().catch(() => {
      // The manager keeps the detailed error in lastError/status.
    });

    updateManager.scheduleAutoCheck();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('before-quit', () => {
    engine.shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}