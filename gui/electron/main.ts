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

type Result = { ok: boolean; error?: string };

let mainWindow: BrowserWindow | null = null;

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

function clearToken(): Result {
  try {
    fs.rmSync(TOKEN_FILE, { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: '删除已保存的 Token 失败。' };
  }
}

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

function registerIpc(): void {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: DATA_DIR,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    tokenStored: hasStoredToken(),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
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
    Menu.setApplicationMenu(null);
    applySessionPolicy();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}