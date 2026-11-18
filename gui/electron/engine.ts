import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type EngineLifecycleState = 'running' | 'starting' | 'stopped' | 'error';

export interface EngineStatus {
  state: EngineLifecycleState;
  healthy: boolean;
  managed: boolean;
  baseUrl: string;
  pid: number | null;
  version: string | null;
  uptimeSeconds: number | null;
  tokenConfigured: boolean;
  tokenSource: 'stored' | 'environment' | 'file' | 'none';
  lastError: string | null;
  checkedAt: string;
  engineRoot: string;
  logFile: string;
}

export interface EngineAgent {
  name: string;
  version: string | null;
  available: boolean;
  capabilities: string[];
  resume_supported: boolean;
  logged_in?: boolean | null;
  gateway?: { base_url: string; model: string | null } | null;
  notes?: string | null;
}

export interface EngineTaskLogEntry {
  seq: number;
  ts: string;
  stream: 'system' | 'stdout' | 'stderr';
  line: string;
}

interface HealthPayload {
  ok: boolean;
  service?: string;
  version?: string;
  uptime_s?: number;
}

interface JsonRpcContentBlock {
  type?: string;
  text?: string;
  /** Image blocks returned by `read_chat_file` for vision-capable callers. */
  data?: string;
  mimeType?: string;
}

interface JsonRpcResponse {
  result?: {
    content?: JsonRpcContentBlock[];
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

export type EngineCallResult<T> = { ok: true; data: T } | { ok: false; error: string };

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const HEALTH_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 20_000;
/** Upload chunks and file reads move megabytes over the local MCP transport. */
const UPLOAD_TIMEOUT_MS = 90_000;
/** Raw-bytes downloads stream a whole stored file (up to the 20 MB upload cap). */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const MAX_LOG_TAIL = 12;

type TokenResolution = {
  token: string | null;
  source: 'stored' | 'environment' | 'file' | 'none';
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return result;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function resolveEngineRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine');
  }
  return path.resolve(__dirname, '..', '..');
}

/**
 * Per-user token file written by scripts/sync-engine-token.mjs at engine
 * startup. This is the only token location shared by the packaged GUI and the
 * externally started engine.
 */
function sharedTokenFile(): string {
  const appData = process.env.APPDATA?.trim() || app.getPath('appData');
  return path.join(appData, 'agent-workbench', 'credentials', 'engine-token');
}

function readSharedToken(): string | null {
  try {
    const value = fs.readFileSync(sharedTokenFile(), 'utf8').trim();
    return value.length > 0 && value.length <= 8192 ? value : null;
  } catch {
    return null;
  }
}

/** Pull `filename`/`filename*` out of an RFC 6266 Content-Disposition header. */
function filenameFromDisposition(header: string | null): string | null {
  if (header == null || header.length === 0) {
    return null;
  }
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended != null) {
    try {
      const decoded = decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (plain != null) {
    const value = (plain[1] ?? plain[2] ?? '').trim();
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

export interface EngineManagerOptions {
  /** Overrides the port only for isolated lifecycle tests; defaults to 8080. */
  port?: number;
}

/**
 * Owns the local MCP engine lifecycle and the authenticated MCP transport.
 *
 * The renderer never sees the bearer token: all engine calls are made here in
 * the main process and exposed through a small set of typed IPC channels.
 */
export class EngineManager {
  readonly port: number;
  readonly baseUrl: string;
  readonly engineRoot = resolveEngineRoot();
  readonly logFile = path.join(app.getPath('userData'), 'engine', 'engine.log');

  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private managed = false;
  private starting: Promise<EngineStatus> | null = null;
  private stopping = false;
  private lastError: string | null = null;
  private logTail: string[] = [];
  private nextRequestId = 1;

  constructor(
    private readonly getStoredToken: () => string | null,
    options: EngineManagerOptions = {},
  ) {
    this.port = options.port ?? DEFAULT_PORT;
    this.baseUrl = `http://${HOST}:${this.port}`;
  }

  private resolveToken(): TokenResolution {
    const stored = this.getStoredToken();
    if (stored) {
      return { token: stored, source: 'stored' };
    }
    const fromEnv = process.env.MCP_BEARER_TOKEN?.trim();
    if (fromEnv) {
      return { token: fromEnv, source: 'environment' };
    }
    const fromSharedFile = readSharedToken();
    if (fromSharedFile) {
      return { token: fromSharedFile, source: 'file' };
    }
    const envFile = readEnvFile(path.join(this.engineRoot, 'workbench.env'));
    const fromFile = envFile.MCP_BEARER_TOKEN?.trim();
    if (fromFile) {
      return { token: fromFile, source: 'environment' };
    }
    return { token: null, source: 'none' };
  }

  tokenConfigured(): boolean {
    return this.resolveToken().token != null;
  }

  private async probeHealth(timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthPayload | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as HealthPayload;
      return body?.ok === true ? body : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<EngineStatus> {
    const resolution = this.resolveToken();
    const health = await this.probeHealth();
    const base = {
      baseUrl: this.baseUrl,
      tokenConfigured: resolution.token != null,
      tokenSource: resolution.source,
      checkedAt: new Date().toISOString(),
      engineRoot: this.engineRoot,
      logFile: this.logFile,
    };

    if (health) {
      return {
        ...base,
        state: 'running',
        healthy: true,
        managed: this.managed,
        pid: this.childPid,
        version: health.version ?? null,
        uptimeSeconds: typeof health.uptime_s === 'number' ? health.uptime_s : null,
        lastError: null,
      };
    }
    if (this.starting) {
      return {
        ...base,
        state: 'starting',
        healthy: false,
        managed: true,
        pid: this.childPid,
        version: null,
        uptimeSeconds: null,
        lastError: this.lastError,
      };
    }
    return {
      ...base,
      state: this.lastError ? 'error' : 'stopped',
      healthy: false,
      managed: this.managed,
      pid: this.childPid,
      version: null,
      uptimeSeconds: null,
      lastError: this.lastError,
    };
  }

  async start(): Promise<EngineStatus> {
    const health = await this.probeHealth(1_000);
    if (health) {
      this.lastError = null;
      return this.status();
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<EngineStatus> {
    this.lastError = null;
    const resolution = this.resolveToken();
    if (!resolution.token) {
      this.lastError =
        '未配置引擎 Token：请在“设置 → 凭据”中保存 Token，或重启引擎以自动同步 Token，或在仓库 workbench.env 中提供 MCP_BEARER_TOKEN。';
      throw new Error(this.lastError);
    }

    const entry = path.join(this.engineRoot, 'src', 'server.js');
    if (!fs.existsSync(entry)) {
      this.lastError = `未找到引擎入口 ${entry}。打包版引擎集成尚未实现，请从仓库开发环境启动。`;
      throw new Error(this.lastError);
    }

    const envFile = readEnvFile(path.join(this.engineRoot, 'workbench.env'));
    const env: NodeJS.ProcessEnv = {
      ...envFile,
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MCP_BEARER_TOKEN: resolution.token,
      MCP_PORT: String(this.port),
    };

    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size > 5 * 1024 * 1024) {
        fs.truncateSync(this.logFile, 0);
      }
    } catch {
      // The log file does not exist yet.
    }

    const child = spawn(process.execPath, [entry], {
      cwd: this.engineRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.childPid = child.pid ?? null;
    this.managed = true;
    this.stopping = false;
    this.logTail = [];

    const record = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      try {
        fs.appendFileSync(this.logFile, `[${stream}] ${text}`, 'utf8');
      } catch {
        // Logging must never take down the engine supervisor.
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        this.logTail.push(`${stream}: ${trimmed}`.slice(0, 500));
        if (this.logTail.length > MAX_LOG_TAIL) {
          this.logTail.shift();
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => record('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => record('stderr', chunk));

    child.on('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.lastError = `引擎进程启动失败：${error.message}`;
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.childPid = null;
      this.managed = false;
      if (!this.stopping) {
        const detail = this.logTail.slice(-6).join('\n');
        this.lastError =
          `引擎进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）。` +
          (detail ? `\n最近输出：\n${detail}` : '');
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child == null) {
        throw new Error(this.lastError ?? '引擎进程在启动期间退出。');
      }
      const health = await this.probeHealth(800);
      if (health) {
        this.lastError = null;
        return this.status();
      }
      await sleep(300);
    }

    this.lastError = `引擎在 ${START_TIMEOUT_MS / 1000} 秒内未通过健康检查。`;
    this.terminateChild();
    throw new Error(this.lastError);
  }

  async stop(): Promise<EngineStatus> {
    if (this.child == null) {
      const health = await this.probeHealth(1_000);
      if (health) {
        this.lastError =
          '引擎由外部进程启动，GUI 未接管其生命周期，无法从界面停止。请停止启动该引擎的脚本或进程。';
        throw new Error(this.lastError);
      }
      this.lastError = null;
      return this.status();
    }

    this.stopping = true;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process may already be gone.
        }
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    this.child = null;
    this.childPid = null;
    this.managed = false;
    this.stopping = false;
    this.lastError = null;
    return this.status();
  }

  /** Fire-and-forget cleanup used while the app is quitting. */
  shutdown(): void {
    const child = this.child;
    if (child == null) {
      return;
    }
    this.stopping = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // Best effort during shutdown.
    }
    this.child = null;
    this.childPid = null;
    this.managed = false;
  }

  private terminateChild(): void {
    const child = this.child;
    if (child == null) {
      return;
    }
    this.stopping = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
    this.child = null;
    this.childPid = null;
    this.managed = false;
  }

  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    const result = await this.callToolRaw(name, args, timeoutMs);
    const raw = this.extractText(result);
    if (raw.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  /**
   * Raw JSON-RPC result. `read_chat_file` returns image content blocks for
   * vision-capable callers, so the bytes cannot be recovered from the text
   * block alone; the attachment service needs the whole content array.
   */
  private async callToolRaw(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<JsonRpcResponse['result']> {
    const resolution = this.resolveToken();
    if (!resolution.token) {
      throw new Error(
        '未配置引擎 Token：请在“设置 → 凭据”中保存 Token，或重启引擎以自动同步 Token，或在仓库 workbench.env 中提供 MCP_BEARER_TOKEN。',
      );
    }

    const id = this.nextRequestId++;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolution.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`引擎响应超时（${Math.round(timeoutMs / 1000)} 秒）。`);
      }
      throw new Error(`无法连接本地引擎 ${this.baseUrl}；请确认引擎已启动。`);
    }

    if (response.status === 401) {
      throw new Error('引擎拒绝了 Token（401）。请在“设置 → 凭据”中更新 Token。');
    }
    if (!response.ok) {
      throw new Error(`引擎返回 HTTP ${response.status}。`);
    }

    const text = await response.text();
    const payload = this.parseJsonRpc(text);
    if (payload.error) {
      throw new Error(`引擎错误：${payload.error.message ?? '未知错误'}`);
    }
    if (payload.result?.isError) {
      const detail = this.extractText(payload.result).replace(/^Error:\s*/i, '');
      throw new Error(detail || '引擎工具调用失败。');
    }
    return payload.result;
  }

  private parseJsonRpc(text: string): JsonRpcResponse {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed) as JsonRpcResponse;
    }
    // Streamable HTTP responses use server-sent events; take the data payload.
    const dataLines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const data = dataLines.join('\n').trim();
    if (data.length === 0) {
      throw new Error('引擎返回了无法解析的响应。');
    }
    return JSON.parse(data) as JsonRpcResponse;
  }

  private extractText(result: JsonRpcResponse['result']): string {
    const first = result?.content?.find((item) => typeof item.text === 'string');
    return first?.text ?? '';
  }

  async agentInfo(): Promise<{ agents: EngineAgent[] }> {
    return this.callTool('agent_info', {});
  }

  async listTasks(limit = 200): Promise<{ tasks: Array<Record<string, unknown>> }> {
    return this.callTool('task_list', { limit });
  }

  async listMessages(input: { limit?: number; taskId?: string } = {}): Promise<{
    thread: Record<string, unknown> | null;
    messages: Array<Record<string, unknown>>;
  }> {
    const args: Record<string, unknown> = { limit: input.limit ?? 500 };
    if (input.taskId != null) {
      args.task_id = input.taskId;
    }
    return this.callTool('list_messages', args);
  }

  async listChats(options: { includeArchived?: boolean } = {}): Promise<{
    chats: Array<Record<string, unknown>>;
  }> {
    // `include_archived` is the list_chats switch between "active only" (the
    // default list) and "active + archived" (the sidebar's 已归档 filter).
    return this.callTool(
      'list_chats',
      options.includeArchived === true ? { include_archived: true } : {},
    );
  }

  async createChat(name?: string): Promise<Record<string, unknown>> {
    return this.callTool('create_chat', name == null ? {} : { name });
  }

  async renameChat(chatId: string, name: string): Promise<Record<string, unknown>> {
    return this.callTool('rename_chat', { chat_id: chatId, name });
  }

  /**
   * Message stream for one chat. `before` pages backwards; `afterSeq` is the
   * incremental cursor the ChatStore uses (only messages with seq > afterSeq).
   */
  async listChatMessages(input: {
    chatId: string;
    limit?: number;
    before?: string;
    afterSeq?: number;
  }): Promise<{
    messages: Array<Record<string, unknown>>;
    has_more?: boolean;
    next_seq?: number;
  }> {
    const args: Record<string, unknown> = {
      chat_id: input.chatId,
      limit: input.limit ?? 200,
    };
    if (input.before != null) {
      args.before = input.before;
    }
    if (input.afterSeq != null) {
      args.after_seq = input.afterSeq;
    }
    return this.callTool('list_chat_messages', args);
  }

  /**
   * Send a chat message. Previously this hard-coded from:'user', to:'muse' and
   * dropped files/question/replyTo; the full contract now crosses the bridge.
   */
  async sendChatMessage(input: {
    chatId: string;
    from?: 'user' | 'muse';
    to?: string;
    summary: string;
    files?: string[];
    mentions?: string[];
    replyTo?: string;
    clientMsgId?: string;
    question?: string;
    taskId?: string;
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      chat_id: input.chatId,
      from: input.from ?? 'user',
      to: input.to ?? 'muse',
      summary: input.summary,
    };
    if (input.files != null && input.files.length > 0) {
      args.files = input.files;
    }
    if (input.mentions != null && input.mentions.length > 0) {
      args.mentions = input.mentions;
    }
    if (input.replyTo != null) {
      args.reply_to = input.replyTo;
    }
    if (input.clientMsgId != null) {
      args.client_msg_id = input.clientMsgId;
    }
    if (input.question != null) {
      args.question = input.question;
    }
    if (input.taskId != null) {
      args.task_id = input.taskId;
    }
    return this.callTool('send_chat_message', args);
  }

  async chatStatus(chatId: string): Promise<Record<string, unknown>> {
    return this.callTool('chat_status', { chat_id: chatId });
  }

  /**
   * Participants + presence for the four-person group chat header.
   *
   * The backend exposes membership through `chat_status` (there is no separate
   * `chat_participants` tool), so this derives the list from that one call.
   */
  async chatParticipants(chatId: string): Promise<Record<string, unknown>> {
    const status = await this.callTool<Record<string, unknown>>('chat_status', { chat_id: chatId });
    const participants = Array.isArray(status?.participants) ? status.participants : [];
    return { chat_id: chatId, participants };
  }

  /**
   * Mark the chat read up to a seq / message id.
   *
   * Backend tool: `chat_mark_read` (store.updateParticipantRead). A backend
   * error surfaces instead of faking a local read state.
   */
  async chatMarkRead(input: {
    chatId: string;
    participantId?: string;
    upToSeq?: number;
    messageId?: string;
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { chat_id: input.chatId };
    // Phase 2 inbox: the master token may advance another participant's
    // cursor, which is how opening a chat from the Inbox clears that agent's
    // per-category counters. Omitted means "the token identity".
    if (input.participantId != null) {
      args.participant_id = input.participantId;
    }
    if (input.upToSeq != null) {
      args.up_to_seq = input.upToSeq;
    }
    if (input.messageId != null) {
      args.message_id = input.messageId;
    }
    return this.callTool('chat_mark_read', args);
  }

  /**
   * Per-chat unread counters for one agent (REA Phase 2 `inbox` tool).
   *
   * Reading the inbox does not mark anything read; the response carries a
   * `you` self-check block so the UI can prove which identity answered.
   */
  async chatInbox(input: { agentId?: string; chatId?: string } = {}): Promise<
    Record<string, unknown>
  > {
    const args: Record<string, unknown> = {};
    if (input.agentId != null) {
      args.agent_id = input.agentId;
    }
    if (input.chatId != null) {
      args.chat_id = input.chatId;
    }
    return this.callTool('inbox', args);
  }

  /**
   * Read a Profile Card, or update one (REA Phase 2 `agent_profile` tool).
   * The engine enforces the 300-character cap and the "own profile only" rule;
   * the renderer never decides authorization on its own.
   */
  async agentProfile(input: { agentId?: string; profile?: string } = {}): Promise<
    Record<string, unknown>
  > {
    const args: Record<string, unknown> = {};
    if (input.agentId != null) {
      args.agent_id = input.agentId;
    }
    if (input.profile !== undefined) {
      args.profile = input.profile;
    }
    return this.callTool('agent_profile', args);
  }

  // ---- Chunked upload (backend tool contract: init → chunk×N → complete) ----

  async uploadChatFileInit(input: {
    chatId: string;
    name: string;
    size: number;
    mime: string;
  }): Promise<Record<string, unknown>> {
    return this.callTool(
      'upload_chat_file_init',
      {
        chat_id: input.chatId,
        name: input.name,
        size: input.size,
        mime: input.mime,
      },
      UPLOAD_TIMEOUT_MS,
    );
  }

  async uploadChatFileChunk(input: {
    uploadId: string;
    index: number;
    dataBase64: string;
  }): Promise<Record<string, unknown>> {
    return this.callTool(
      'upload_chat_file_chunk',
      {
        upload_id: input.uploadId,
        index: input.index,
        data: input.dataBase64,
      },
      UPLOAD_TIMEOUT_MS,
    );
  }

  async uploadChatFileComplete(input: {
    uploadId: string;
    sha256?: string;
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { upload_id: input.uploadId };
    if (input.sha256 != null) {
      args.sha256 = input.sha256;
    }
    return this.callTool('upload_chat_file_complete', args, UPLOAD_TIMEOUT_MS);
  }

  /** All files uploaded to one chat; metadata only, never a host path. */
  async listChatFiles(input: {
    chatId: string;
    limit?: number;
  }): Promise<{ files: Array<Record<string, unknown>> }> {
    const args: Record<string, unknown> = { chat_id: input.chatId };
    if (input.limit != null) {
      args.limit = input.limit;
    }
    return this.callTool('list_chat_files', args);
  }

  /**
   * Read one file by file_id. Text/code/PDF/DOCX/XLSX/PPTX/ZIP return extracted
   * text; images come back as an MCP image block, so the raw result is parsed
   * and the image bytes are preserved next to the metadata.
   */
  async readChatFile(input: {
    chatId: string;
    fileId: string;
    entry?: string;
    maxBytes?: number;
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      chat_id: input.chatId,
      file_id: input.fileId,
    };
    if (input.entry != null) {
      args.entry = input.entry;
    }
    if (input.maxBytes != null) {
      args.max_bytes = input.maxBytes;
    }
    const result = await this.callToolRaw('read_chat_file', args, UPLOAD_TIMEOUT_MS);
    const image = result?.content?.find((item) => item.type === 'image' && item.data != null);
    const raw = this.extractText(result);
    let parsed: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const value = JSON.parse(raw);
        parsed = value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      } catch {
        parsed = { text: raw };
      }
    }
    if (image?.data != null) {
      return {
        ...parsed,
        image: { data: image.data, mimeType: image.mimeType ?? 'application/octet-stream' },
      };
    }
    return parsed;
  }

  /**
   * Raw stored bytes for one uploaded file: `GET /chats/:id/files/:fileId`.
   *
   * `read_chat_file` only returns extracted text for documents, so the original
   * PDF/DOCX/XLSX/PPTX/ZIP bytes are reachable only through this plain HTTP
   * route. It answers with the stored mime plus an attachment Content-Disposition
   * carrying the original filename, and 404 for files it does not know.
   */
  async downloadChatFileRaw(input: {
    chatId: string;
    fileId: string;
    maxBytes?: number;
  }): Promise<{ bytes: Buffer; name: string | null; mime: string | null }> {
    const resolution = this.resolveToken();
    if (!resolution.token) {
      throw new Error(
        '未配置引擎 Token：请在“设置 → 凭据”中保存 Token，或重启引擎以自动同步 Token，或在仓库 workbench.env 中提供 MCP_BEARER_TOKEN。',
      );
    }

    const url =
      `${this.baseUrl}/chats/${encodeURIComponent(input.chatId)}` +
      `/files/${encodeURIComponent(input.fileId)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolution.token}`,
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`引擎响应超时（${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} 秒）。`);
      }
      throw new Error(`无法连接本地引擎 ${this.baseUrl}；请确认引擎已启动。`);
    }

    if (response.status === 401) {
      throw new Error('引擎拒绝了 Token（401）。请在“设置 → 凭据”中更新 Token。');
    }
    if (response.status === 404) {
      throw new Error(`引擎中不存在该文件（404）：${input.fileId}。`);
    }
    if (!response.ok) {
      throw new Error(`引擎返回 HTTP ${response.status}。`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error('引擎返回了空的文件内容。');
    }
    if (input.maxBytes != null && bytes.length > input.maxBytes) {
      throw new Error(
        `文件超过可下载上限（${Math.round(input.maxBytes / (1_024 * 1_024))} MB）。`,
      );
    }
    return {
      bytes,
      name: filenameFromDisposition(response.headers.get('content-disposition')),
      mime: response.headers.get('content-type'),
    };
  }

  async taskStatus(taskId: string): Promise<Record<string, unknown>> {
    return this.callTool('task_status', { task_id: taskId });
  }

  async taskLogs(
    taskId: string,
    cursor = 0,
    limit = 200,
  ): Promise<{
    task_id: string;
    entries: EngineTaskLogEntry[];
    next_cursor: number;
    truncated: boolean;
  }> {
    return this.callTool('task_logs', { task_id: taskId, cursor, limit });
  }

  async startTask(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.callTool('task_start', input);
  }

  async sendTask(taskId: string, prompt: string): Promise<Record<string, unknown>> {
    return this.callTool('task_send', { task_id: taskId, prompt });
  }

  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    return this.callTool('task_cancel', { task_id: taskId });
  }

  async respondApproval(input: {
    taskId?: string;
    approvalId?: string;
    decision: 'once' | 'session' | 'deny';
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = { decision: input.decision };
    if (input.approvalId != null) {
      args.approval_id = input.approvalId;
    }
    if (input.taskId != null) {
      args.task_id = input.taskId;
    }
    if (input.reason != null && input.reason.length > 0) {
      args.reason = input.reason;
    }
    return this.callTool('respond_approval', args);
  }
}

export { errorMessage };