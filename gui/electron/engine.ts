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
  tokenSource: 'stored' | 'environment' | 'none';
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

interface JsonRpcResponse {
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

export type EngineCallResult<T> = { ok: true; data: T } | { ok: false; error: string };

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const HEALTH_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 30_000;
const MAX_LOG_TAIL = 12;

type TokenResolution = {
  token: string | null;
  source: 'stored' | 'environment' | 'none';
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
        '未配置引擎 Token：请在“设置 → 凭据”中保存 Token，或在仓库 workbench.env 中提供 MCP_BEARER_TOKEN。';
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

  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const resolution = this.resolveToken();
    if (!resolution.token) {
      throw new Error(
        '未配置引擎 Token：请在“设置 → 凭据”中保存 Token，或在仓库 workbench.env 中提供 MCP_BEARER_TOKEN。',
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
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`引擎响应超时（${CALL_TIMEOUT_MS / 1000} 秒）。`);
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

    const raw = this.extractText(payload.result);
    if (raw.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
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