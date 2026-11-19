import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AttachmentService,
  formatBytes,
  normalizeChatFile,
  MAX_FILE_BYTES,
  MAX_FILES_PER_UPLOAD,
  type AttachmentDraft,
  type ChatFilePayload,
  type FetchedFile,
} from './attachments';
import { runAttachmentVerification } from './attachment-verify';
import {
  attachmentUrl,
  installChatAttachmentProtocol,
  registerChatAttachmentPrivileges,
} from './chat-protocol';
import { EngineManager, errorMessage } from './engine';
import { UpdateManager, type UpdateChannel, type UpdateState } from './update';
import {
  clampWindowBounds,
  initialWindowGeometry,
  isStoredWindowState,
  type StoredWindowState,
} from './window-state';

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
/**
 * Window geometry next to hud.json (same per-user data directory). Only x/y/
 * width/height and the maximised flag — no user content, no backend state.
 */
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window.json');
const WINDOW_STATE_SAVE_DELAY = 400;
const ATTACHMENTS_TEMP_DIR = path.join(DATA_DIR, 'attachments', 'pending');
const ATTACHMENTS_CACHE_DIR = path.join(DATA_DIR, 'attachments', 'cache');
/** REA Phase 2 Profile Card limit (docs/rea/DATABASE_DESIGN.md, D1). */
const PROFILE_MAX_CHARS = 300;

// The renderer never handles host paths: drafts are opaque ids in this service.
const attachments = new AttachmentService({
  tempDir: ATTACHMENTS_TEMP_DIR,
  cacheDir: ATTACHMENTS_CACHE_DIR,
});

// Scheme privileges must be registered before the app is ready.
registerChatAttachmentPrivileges();

type Result = { ok: boolean; error?: string };

interface HudConfig {
  paperPlanes: boolean;
  contextWindowTokens: number;
}

const DEFAULT_HUD_CONFIG: HudConfig = {
  paperPlanes: true,
  contextWindowTokens: 128_000,
};

function readHudConfig(): HudConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(HUD_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
    const context =
      typeof raw.contextWindowTokens === 'number' &&
      Number.isInteger(raw.contextWindowTokens) &&
      raw.contextWindowTokens >= 1_000 &&
      raw.contextWindowTokens <= 2_000_000
        ? raw.contextWindowTokens
        : DEFAULT_HUD_CONFIG.contextWindowTokens;
    return {
      paperPlanes:
        typeof raw.paperPlanes === 'boolean'
          ? raw.paperPlanes
          : DEFAULT_HUD_CONFIG.paperPlanes,
      contextWindowTokens: context,
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
  if (value.contextWindowTokens != null) {
    const context = Number(value.contextWindowTokens);
    if (!Number.isInteger(context) || context < 1_000 || context > 2_000_000) {
      throw new Error('上下文参考上限必须是 1,000–2,000,000 之间的整数。');
    }
    current.contextWindowTokens = context;
  }
  ensureDataDir();
  const tempFile = `${HUD_CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, HUD_CONFIG_FILE);
  return current;
}

let mainWindow: BrowserWindow | null = null;
let updateManager: UpdateManager | null = null;

/**
 * Last known window geometry, or `null` when there is none (first run, corrupt
 * file, wrong shape). Never fatal: geometry is a convenience.
 */
function readStoredWindowState(): StoredWindowState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    return isStoredWindowState(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist geometry + maximised flag atomically (temp file + rename). */
function saveStoredWindowState(win: BrowserWindow | null): void {
  if (win == null || win.isDestroyed() || win.isMinimized()) {
    return;
  }
  try {
    ensureDataDir();
    const bounds = win.getNormalBounds();
    const state: StoredWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    };
    const tempFile = `${WINDOW_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempFile, WINDOW_STATE_FILE);
  } catch {
    // Non-fatal: the window still works, it just opens at the default size.
  }
}

const VERIFY_MODE = process.argv.includes('--update-verify');
const PRINT_VERSION_MODE = process.argv.includes('--print-version');
/** Headless end-to-end check of the attachment pipeline (see docs). */
const ATTACH_VERIFY_MODE = process.argv.includes('--attachment-verify');

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

// Test seam: point the GUI at an isolated engine without touching the default
// port. Production runs leave this unset.
const ENGINE_PORT_OVERRIDE = Number(process.env.WORKBENCH_GUI_ENGINE_PORT);
const engine = new EngineManager(
  readToken,
  Number.isInteger(ENGINE_PORT_OVERRIDE) && ENGINE_PORT_OVERRIDE > 0
    ? { port: ENGINE_PORT_OVERRIDE }
    : {},
);

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

/** Same trusted-origin gate, but streams progress back to the calling window. */
function handleWithEvent<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Blocked IPC call from an untrusted origin');
    }
    return handler(event, ...args);
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

  handle('engine:message-list', (input) => {
    return engineResult(() => {
      if (input == null) {
        return engine.listMessages({ limit: 500 });
      }
      const value = asRecord(input);
      const limit = optionalInteger(value.limit, 1, 500, 500);
      const taskId =
        value.taskId == null || value.taskId === ''
          ? undefined
          : requireTaskId(value.taskId);
      return engine.listMessages({ limit, taskId });
    });
  });

  handle('engine:chat-list', (input) =>
    engineResult(() => {
      const value = input == null ? {} : asRecord(input);
      return engine.listChats({ includeArchived: value.includeArchived === true });
    }),
  );

  handle('engine:chat-create', (input) =>
    engineResult(() => {
      const value = input == null ? {} : asRecord(input);
      const name =
        value.name == null || value.name === ''
          ? undefined
          : requireText(value.name, '群聊名称', 100);
      return engine.createChat(name);
    }),
  );

  handle('engine:chat-rename', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      return engine.renameChat(requireChatId(value.chatId), requireText(value.name, '群聊名称', 100));
    }),
  );

  handle('engine:chat-message-list', (input) =>
    engineResult(() => readChatMessageQuery(input)),
  );

  // Canonical name from the frozen contract; the legacy channel above stays as
  // an alias so older renderers keep working during the migration.
  handle('engine:chat-messages', (input) => engineResult(() => readChatMessageQuery(input)));

  handle('engine:chat-send', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      const from = value.from == null ? 'user' : value.from;
      if (from !== 'user' && from !== 'muse') {
        throw new Error('发送者必须是 user 或 muse。');
      }
      const to = optionalRecipient(value.to, from === 'user' ? 'muse' : 'user');
      return engine.sendChatMessage({
        chatId: requireChatId(value.chatId),
        from,
        to,
        summary: requireText(value.summary, '消息', 20_000),
        files: optionalIdArray(value.files, '附件', MAX_FILES_PER_UPLOAD),
        mentions: optionalMentionArray(value.mentions),
        replyTo:
          value.replyTo == null || value.replyTo === ''
            ? undefined
            : requireMessageId(value.replyTo, '回复目标'),
        clientMsgId:
          value.clientMsgId == null || value.clientMsgId === ''
            ? undefined
            : requireMessageId(value.clientMsgId, '客户端消息 ID'),
        question:
          value.question == null || value.question === ''
            ? undefined
            : requireText(value.question, '问题', 4_000),
        taskId:
          value.taskId == null || value.taskId === ''
            ? undefined
            : requireTaskId(value.taskId),
      });
    }),
  );

  handle('engine:chat-status', (chatId) =>
    engineResult(() => engine.chatStatus(requireChatId(chatId))),
  );

  handle('engine:chat-participants', (chatId) =>
    engineResult(() => engine.chatParticipants(requireChatId(chatId))),
  );

  handle('engine:chat-mark-read', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      const upToSeq =
        value.upToSeq == null || value.upToSeq === ''
          ? undefined
          : optionalInteger(value.upToSeq, 0, Number.MAX_SAFE_INTEGER, 0);
      const messageId =
        value.messageId == null || value.messageId === ''
          ? undefined
          : requireMessageId(value.messageId, '消息 ID');
      // The engine's `chat_mark_read` contract (src/tools.js) already defines
      // the omitted case: with neither `up_to_seq` nor `message_id` it advances
      // the cursor to the chat's latest seq. Rejecting that here made the
      // Inbox "标为已读" button fail 100% of the time, so the guard is gone and
      // empty values are forwarded untouched — the engine stays the authority.
      // Phase 2 Inbox: `participantId` lets the master token advance a built-in
      // agent's cursor when the owner opens that chat. Absent = token identity.
      const participantId =
        value.participantId == null || value.participantId === ''
          ? undefined
          : requireParticipantId(value.participantId);
      return engine.chatMarkRead({
        chatId: requireChatId(value.chatId),
        participantId,
        upToSeq,
        messageId,
      });
    }),
  );

  // REA Phase 2: per-agent unread counters (`inbox` tool).
  handle('engine:chat-inbox', (input) =>
    engineResult(() => {
      const value = input == null ? {} : asRecord(input);
      const agentId =
        value.agentId == null || value.agentId === ''
          ? undefined
          : requireAgentId(value.agentId);
      const chatId =
        value.chatId == null || value.chatId === ''
          ? undefined
          : requireChatId(value.chatId);
      return engine.chatInbox({ agentId, chatId });
    }),
  );

  // REA Phase 2: Profile Card read / update (`agent_profile` tool). The engine
  // enforces the 300-character cap and the "own profile only" authorization;
  // the main process only rejects obviously malformed input.
  handle('engine:agent-profile', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      const agentId =
        value.agentId == null || value.agentId === ''
          ? undefined
          : requireAgentId(value.agentId);
      let profile: string | undefined;
      if (value.profile !== undefined) {
        if (typeof value.profile !== 'string') {
          throw new Error('简介必须是字符串。');
        }
        if (value.profile.length > PROFILE_MAX_CHARS) {
          throw new Error(`简介不能超过 ${PROFILE_MAX_CHARS} 个字符。`);
        }
        profile = value.profile;
      }
      if (agentId == null && profile === undefined) {
        throw new Error('读取简介需要 agentId。');
      }
      return engine.agentProfile({ agentId, profile });
    }),
  );

  // REA Phase 3: wake / listener status for the Inbox status row. The GUI holds
  // the owner token, so it always names the agent it is displaying; the engine
  // still re-checks that a wake_status read is for the caller's own agent (or
  // that the caller is master/human).
  handle('engine:wake-status', (input) =>
    engineResult(() => {
      const value = input == null ? {} : asRecord(input);
      const agentId =
        value.agentId == null || value.agentId === ''
          ? undefined
          : requireAgentId(value.agentId);
      const chatId =
        value.chatId == null || value.chatId === ''
          ? undefined
          : requireChatId(value.chatId);
      return engine.wakeStatus({ agentId, chatId });
    }),
  );

  handle('engine:listener-status', (input) =>
    engineResult(() => {
      const value = input == null ? {} : asRecord(input);
      const agentId =
        value.agentId == null || value.agentId === ''
          ? undefined
          : requireAgentId(value.agentId);
      return engine.listenerStatus({ agentId });
    }),
  );

  // Owner-only in the engine (`wake_enable` / `wake_disable` require a
  // human/master token); the main process only validates the shape.
  handle('engine:wake-enable', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      return engine.wakeEnable({
        agentId: requireAgentId(value.agentId),
        chatId: requireChatId(value.chatId),
      });
    }),
  );

  handle('engine:wake-disable', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      return engine.wakeDisable({
        agentId: requireAgentId(value.agentId),
        chatId: requireChatId(value.chatId),
      });
    }),
  );

  // ---- Attachment intake (main-process dialog / drop / paste) ----

  handle('chat:pick-files', () => pickChatFiles());

  handle('chat:register-dropped', async (input) => {
    try {
      const value = asRecord(input);
      const source = value.source === 'paste' ? 'paste' : 'drop';
      const drafts = await attachments.registerPaths(value.paths, source);
      return { ok: true, data: { drafts } };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle('chat:register-buffers', async (input) => {
    try {
      const value = asRecord(input);
      const items = Array.isArray(value.items) ? value.items : [];
      if (items.length === 0) {
        return { ok: false, error: '没有可上传的内容。' };
      }
      if (items.length > MAX_FILES_PER_UPLOAD) {
        return { ok: false, error: `一次最多上传 ${MAX_FILES_PER_UPLOAD} 个文件。` };
      }
      const source = value.source === 'paste' ? 'paste' : 'drop';
      const drafts: AttachmentDraft[] = [];
      const errors: Array<{ name: string; error: string }> = [];
      for (const item of items) {
        const record = asRecord(item);
        const raw = record.data;
        const buffer =
          raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.isBuffer(raw) ? raw : null;
        if (buffer == null) {
          errors.push({ name: String(record.name ?? '未知文件'), error: '内容为空或格式无效。' });
          continue;
        }
        try {
          drafts.push(
            await attachments.registerBuffer({
              name: record.name,
              mime: record.mime,
              data: buffer,
              source,
            }),
          );
        } catch (error) {
          errors.push({
            name: String(record.name ?? '未知文件'),
            error: errorMessage(error),
          });
        }
      }
      return { ok: true, data: { drafts, errors } };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle('chat:draft-discard', (draftIds) => {
    attachments.removeDrafts(draftIds);
    return { ok: true };
  });

  // ---- Chunked upload: 1 MB chunks through the engine tools ----

  handleWithEvent('engine:chat-upload', async (event, input) => {
    let chatId: string | null = null;
    try {
      const value = asRecord(input);
      chatId = requireChatId(value.chatId);
      const uploadId = requireMessageId(value.uploadId, '上传 ID');
      const result = await attachments.upload({
        chatId,
        draftIds: value.draftIds,
        uploadId,
        engine,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('chat:upload-progress', progress);
          }
        },
      });
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // ---- File read / open / save (file_id only, never a host path) ----

  handle('engine:chat-file-read', async (input) => {
    try {
      const value = asRecord(input);
      const chatId = requireChatId(value.chatId);
      const fileId = requireFileId(value.fileId);
      const maxBytes =
        value.limit == null || value.limit === ''
          ? undefined
          : optionalInteger(value.limit, 1, 2_000_000, 200 * 1_024);
      const entry =
        value.entry == null || value.entry === '' ? undefined : requireText(value.entry, 'ZIP 路径', 1_024);
      const raw = await engine.readChatFile({ chatId, fileId, entry, maxBytes });
      const text = typeof raw.text === 'string' ? raw.text : '';
      // Normalized shape for the renderer: `text`/`truncated` are the frozen
      // contract; `content`/`mode`/`encoding` keep the older preview caller
      // working during the migration.
      return {
        ok: true,
        data: {
          ...raw,
          file_id: typeof raw.file_id === 'string' ? raw.file_id : fileId,
          mode: 'text',
          encoding: 'utf8',
          content: text,
          text,
          truncated: raw.truncated === true,
          offset: 0,
          next_offset: null,
        },
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // ---- File listing / preview URL / download (file_id only) ----

  handle('engine:chat-files', (input) =>
    engineResult(async () => {
      const value = asRecord(input);
      const chatId = requireChatId(value.chatId);
      const limit =
        value.limit == null || value.limit === ''
          ? undefined
          : optionalInteger(value.limit, 1, 500, 200);
      const result = await engine.listChatFiles({ chatId, limit });
      const files = (Array.isArray(result.files) ? result.files : [])
        .map((file) => normalizeChatFile(file, chatId))
        .filter((file): file is ChatFilePayload => file != null);
      return { chat_id: chatId, files };
    }),
  );

  handle('engine:chat-file-preview', (input) => {
    try {
      const value = asRecord(input);
      const chatId = requireChatId(value.chatId);
      const fileId = requireFileId(value.fileId);
      // A narrow custom-protocol URL; no host path and no localhost file server.
      return { ok: true, data: { url: attachmentUrl(chatId, fileId) } };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  handle('engine:chat-file-open', async (input) => {
    try {
      const value = asRecord(input);
      const chatId = requireChatId(value.chatId);
      const fileId = requireFileId(value.fileId);
      const fetched = await attachments.fetchBytes({ chatId, fileId, engine });
      const target = await attachments.cacheToDisk({
        chatId,
        fileId,
        name: fetched.name,
        bytes: fetched.bytes,
      });
      if (value.action === 'reveal') {
        shell.showItemInFolder(target);
        return { ok: true };
      }
      const error = await shell.openPath(target);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  // Canonical download entry: main-process save dialog + write to disk.
  //
  // Documents cannot be saved from `read_chat_file` (it returns extracted text,
  // not the file), so the original bytes come from the engine's raw-bytes route
  // `GET /chats/:id/files/:fileId`. The text/base64 path stays as the fallback:
  // it still serves images and text, and it fails loudly for everything whose
  // only content is extracted text.
  const saveChatFile = async (input: unknown) => {
    try {
      const value = asRecord(input);
      const chatId = requireChatId(value.chatId);
      const fileId = requireFileId(value.fileId);
      let fetched: FetchedFile;
      try {
        fetched = await attachments.fetchRawBytes({ chatId, fileId, engine });
      } catch {
        // The route is unavailable (older engine, unknown file, network): fall
        // back to the MCP read path, which either has the real bytes (images,
        // text) or reports that only extracted text exists.
        const fallback = await attachments.fetchBytes({ chatId, fileId, engine });
        if (fallback.extracted) {
          throw new Error(
            '该格式目前只能预览解析出的文本；保存原始文件需要后端提供原始字节接口（待联调）。',
          );
        }
        fetched = fallback;
      }
      const options: Electron.SaveDialogOptions = {
        title: '保存附件',
        defaultPath: fetched.name,
      };
      const owner = mainWindow;
      const result =
        owner != null && !owner.isDestroyed()
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
      if (result.canceled || result.filePath == null || result.filePath.length === 0) {
        return { ok: true, data: { savedPath: '' } };
      }
      await attachments.writeTo(result.filePath, fetched.bytes);
      return { ok: true, data: { savedPath: result.filePath } };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  };

  handle('engine:chat-file-download', (input) => saveChatFile(input));
  // Legacy alias kept for the first renderer build during the migration.
  handle('engine:chat-file-save', (input) => saveChatFile(input));

  handle('engine:respond-approval', (input) =>
    engineResult(() => {
      const value = asRecord(input);
      if (value.decision !== 'once' && value.decision !== 'session' && value.decision !== 'deny') {
        throw new Error('审批决定必须是 once、session 或 deny。');
      }
      const taskId =
        value.taskId == null || value.taskId === ''
          ? undefined
          : requireTaskId(value.taskId);
      const approvalId =
        value.approvalId == null || value.approvalId === ''
          ? undefined
          : requireTaskId(value.approvalId);
      if (taskId == null && approvalId == null) {
        throw new Error('审批调用需要 taskId 或 approvalId。');
      }
      const reason =
        value.reason == null ? undefined : requireText(value.reason, '理由', 4_000);
      return engine.respondApproval({
        taskId,
        approvalId,
        decision: value.decision,
        reason,
      });
    }),
  );

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

function requireChatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('群聊 ID 无效。');
  }
  return value;
}

function requireFileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('附件 ID 无效。');
  }
  return value;
}

function requireMessageId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

/** Built-in participant handles plus paired agent ids (agent_<random>). */
function requireParticipantId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:user|muse|claude|dsh|agent_[A-Za-z0-9_-]{1,64})$/.test(value)
  ) {
    throw new Error('参与者 ID 无效。');
  }
  return value;
}

/** Agent ids accept both the canonical agent_* id and the participant handle. */
function requireAgentId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:muse|claude|dsh|agent_[A-Za-z0-9_-]{1,64})$/.test(value)
  ) {
    throw new Error('Agent ID 无效。');
  }
  return value;
}

function optionalRecipient(value: unknown, fallback: string): string {
  if (value == null || value === '') {
    return fallback;
  }
  if (value !== 'user' && value !== 'muse' && value !== 'claude' && value !== 'dsh') {
    throw new Error('收件人必须是 user、muse、claude 或 dsh。');
  }
  return value;
}

function optionalIdArray(value: unknown, label: string, maxItems: number): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组。`);
  }
  if (value.length > maxItems) {
    throw new Error(`${label} 最多 ${maxItems} 项。`);
  }
  return value.map((item) => requireFileId(item));
}

function optionalMentionArray(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('@提及必须是数组。');
  }
  if (value.length > 8) {
    throw new Error('单条消息最多提及 8 个参与者。');
  }
  const allowed = new Set(['user', 'muse', 'claude', 'dsh']);
  const mentions = value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item)) {
      throw new Error('@提及只能包含 user、muse、claude、dsh。');
    }
    return item;
  });
  return [...new Set(mentions)];
}

function readChatMessageQuery(input: unknown): Promise<{
  messages: Array<Record<string, unknown>>;
  has_more?: boolean;
  next_seq?: number;
}> {
  const value = asRecord(input);
  const before =
    value.before == null || value.before === ''
      ? undefined
      : requireText(value.before, '翻页游标', 200);
  const afterSeq =
    value.afterSeq == null || value.afterSeq === ''
      ? undefined
      : optionalInteger(value.afterSeq, 0, Number.MAX_SAFE_INTEGER, 0);
  return engine.listChatMessages({
    chatId: requireChatId(value.chatId),
    limit: optionalInteger(value.limit, 1, 500, 200),
    before,
    afterSeq,
  });
}

async function pickChatFiles(): Promise<
  { ok: true; data: { drafts: AttachmentDraft[] } } | { ok: false; error: string }
> {
  try {
    const options: Electron.OpenDialogOptions = {
      title: '选择要发送给群聊的文件',
      buttonLabel: '加入待发送',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '常用文件',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx',
            'zip', 'txt', 'md', 'csv', 'json', 'ts', 'tsx', 'js', 'py', 'sh', 'log',
          ],
        },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: '文档', extensions: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const owner = mainWindow;
    const result =
      owner != null && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: true, data: { drafts: [] } };
    }
    const drafts = await attachments.registerPaths(result.filePaths, 'dialog');
    return { ok: true, data: { drafts } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
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
  // Attachment previews use one narrow custom scheme, and only for images.
  // Both CSP variants stay in sync: dev must not be looser than production.
  const devCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: chat-attachment:",
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
    "img-src 'self' data: chat-attachment:",
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

  // Geometry: clamp the default size to the display the window will open on and
  // clamp a restored position/size the same way, so a removed or resized display
  // can never leave the window off-screen (Phase 1 audit LAY-2).
  const stored = readStoredWindowState();
  const workArea =
    stored != null
      ? screen.getDisplayMatching({
          x: stored.x,
          y: stored.y,
          width: stored.width,
          height: stored.height,
        }).workArea
      : screen.getPrimaryDisplay().workArea;
  const geometry = initialWindowGeometry(workArea);
  const restored = stored != null ? clampWindowBounds(stored, workArea) : null;

  const win = new BrowserWindow({
    width: restored?.width ?? geometry.width,
    height: restored?.height ?? geometry.height,
    ...(restored != null ? { x: restored.x, y: restored.y } : {}),
    minWidth: geometry.minWidth,
    minHeight: geometry.minHeight,
    show: false,
    backgroundColor: '#090A0B',
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
  mainWindow = win;

  if (stored?.isMaximized === true) {
    win.maximize();
  }

  // Debounced geometry persistence: continuous resizes must not hammer the disk.
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleWindowStateSave = () => {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveStoredWindowState(win);
    }, WINDOW_STATE_SAVE_DELAY);
  };
  win.on('resize', scheduleWindowStateSave);
  win.on('move', scheduleWindowStateSave);
  win.on('close', () => {
    if (saveTimer != null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveStoredWindowState(win);
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      openAllowedExternal(url);
    }
  });

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
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
    installChatAttachmentProtocol({ service: attachments, engine });
    void attachments.sweepTemp();
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

    if (ATTACH_VERIFY_MODE) {
      void runAttachmentVerification({ window: mainWindow, engine, attachments });
      return;
    }

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