import { app, BrowserWindow, ipcMain, session } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged;
const devRoot = isPackaged ? null : resolve(__dirname, '..', '..');
const engineRoot = isPackaged ? join(process.resourcesPath, 'engine') : devRoot;
const engineEntry = join(engineRoot, 'src', 'server.js');
const APP_USER_MODEL_ID = 'com.mkmk56.agent-workbench.spike';
const appIconPath = join(__dirname, 'assets', 'branding', 'app-icon', 'agent-workbench.ico');
const spikePort = Number(process.env.SPIKE_ENGINE_PORT || 18080);
const existingPort = Number(process.env.SPIKE_EXISTING_PORT || 8080);
const isSmoke = process.argv.includes('--smoke-test');
const isAttachOnly = process.argv.includes('--attach');
const isUpdateCheck = process.argv.includes('--update-check');
const isPrintVersion = process.argv.includes('--print-version');
const proxyRules = process.env.SPIKE_PROXY || '';
const engineToken = randomBytes(24).toString('hex');

app.setAppUserModelId(APP_USER_MODEL_ID);

let win = null;
let healthTimer = null;
let runAsNodeCheck = null;
let updater = null;
let rendererReadyResolve = null;
const rendererReady = new Promise((resolvePromise) => { rendererReadyResolve = resolvePromise; });
let updateState = { status: 'idle', currentVersion: app.getVersion(), events: [] };

ipcMain.on('renderer:ready', () => rendererReadyResolve());

const engine = {
  child: null,
  running: false,
  port: spikePort,
  startMs: null,
  stopMs: null,
  health: null,
  startedAt: null,
  lastError: null,
  nodeKind: 'electron-as-node',
  logs: []
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : '';
}

function outputDir() {
  const explicit = argValue('--out-dir');
  if (explicit) return resolve(explicit);
  return isPackaged ? join(app.getPath('userData'), 'spike-artifacts') : join(__dirname, 'artifacts');
}

const redact = (value) => String(value).split(engineToken).join('<redacted>');

function pushEngineLog(stream, chunk) {
  for (const line of redact(chunk).split(/\r?\n/)) {
    if (!line) continue;
    engine.logs.push({ t: new Date().toISOString(), stream, line });
  }
  if (engine.logs.length > 300) engine.logs.splice(0, engine.logs.length - 300);
}

function engineStatus() {
  return {
    running: engine.running,
    port: engine.port,
    startMs: engine.startMs,
    stopMs: engine.stopMs,
    health: engine.health,
    lastError: engine.lastError,
    nodeKind: engine.nodeKind,
    logs: engine.logs.slice(-80)
  };
}

async function fetchHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(1500)
  });
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json();
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetchHealth(port);
    } catch (error) {
      lastError = error;
      await delay(120);
    }
  }
  throw new Error(`health did not become ready: ${lastError?.message || 'timeout'}`);
}

async function startEngine(nodeKind = 'electron-as-node') {
  if (engine.running) return engineStatus();
  if (!existsSync(engineEntry)) throw new Error(`engine entry not found: ${engineEntry}`);
  try {
    const occupied = await fetchHealth(spikePort);
    throw new Error(`port ${spikePort} already in use (uptime ${occupied.uptime_s}s); stop it before starting a new spike engine`);
  } catch (error) {
    if (String(error.message).includes('already in use')) throw error;
  }

  const env = {
    ...process.env,
    MCP_PORT: String(spikePort),
    MCP_BEARER_TOKEN: engineToken,
    MCP_DB_PATH: 'data/spike/workbench.db',
    MCP_LOG_DIR: 'logs/spike',
    RATE_LIMIT_PER_MIN: '600'
  };
  if (nodeKind === 'electron-as-node') {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  const command = nodeKind === 'system-node' ? (process.env.SPIKE_NODE_BIN || 'node') : process.execPath;
  const startedAt = Date.now();
  engine.startedAt = startedAt;
  engine.startMs = null;
  engine.stopMs = null;
  engine.lastError = null;
  engine.nodeKind = nodeKind;
  engine.logs = [];
  pushEngineLog('spike', `starting engine: ${command} ${engineEntry} (${nodeKind}, port ${spikePort})`);

  const child = spawn(command, [engineEntry], {
    cwd: engineRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  engine.child = child;
  child.stdout.on('data', (chunk) => pushEngineLog('stdout', chunk));
  child.stderr.on('data', (chunk) => pushEngineLog('stderr', chunk));
  child.on('error', (error) => {
    engine.lastError = error.message;
    engine.running = false;
    pushEngineLog('spike', `engine spawn error: ${error.message}`);
  });
  child.on('exit', (code, signal) => {
    pushEngineLog('spike', `engine exited code=${code} signal=${signal}`);
    engine.child = null;
    engine.running = false;
    engine.health = null;
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  });

  try {
    engine.health = await waitForHealth(spikePort);
    engine.startMs = Date.now() - startedAt;
    engine.running = true;
    pushEngineLog('spike', `engine healthy after ${engine.startMs} ms`);
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(async () => {
      try {
        engine.health = await fetchHealth(spikePort);
      } catch {
        engine.health = null;
      }
    }, 2000);
    healthTimer.unref?.();
    return engineStatus();
  } catch (error) {
    engine.lastError = error.message;
    pushEngineLog('spike', `engine failed to become healthy: ${error.message}`);
    await stopEngine();
    throw error;
  }
}

async function stopEngine() {
  const startedAt = Date.now();
  const pids = new Set();
  if (engine.child?.pid) pids.add(engine.child.pid);
  try {
    const pidFromFile = Number(readFileSync(join(engineRoot, 'logs', 'spike', 'server.pid'), 'utf8').trim());
    if (Number.isInteger(pidFromFile) && pidFromFile > 0) pids.add(pidFromFile);
  } catch {
    // pid file is optional
  }

  if (pids.size === 0) {
    engine.running = false;
    engine.health = null;
    return engineStatus();
  }

  pushEngineLog('spike', `stopping engine pids=${[...pids].join(',')}`);
  for (const pid of pids) {
    await new Promise((resolvePromise) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolvePromise());
    });
  }
  const deadline = Date.now() + 5000;
  while (engine.child && Date.now() < deadline) await delay(100);
  try {
    await fetchHealth(spikePort);
    engine.lastError = 'health still reachable after stop';
  } catch {
    engine.stopMs = Date.now() - startedAt;
    engine.lastError = null;
  }
  engine.running = false;
  engine.health = null;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  pushEngineLog('spike', `engine stopped in ${engine.stopMs ?? '?'} ms`);
  return engineStatus();
}

function readExistingToken() {
  const envPath = process.env.SPIKE_EXISTING_ENV
    || (devRoot ? join(devRoot, 'workbench.env') : '');
  if (!envPath || !existsSync(envPath)) return '';
  try {
    const match = readFileSync(envPath, 'utf8').match(/^\s*MCP_BEARER_TOKEN\s*=\s*(.+?)\s*$/m);
    if (!match) return '';
    return match[1].replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function sourceConfig(source) {
  if (source === 'managed') {
    return { port: spikePort, token: engineToken, available: true };
  }
  const token = readExistingToken();
  return { port: existingPort, token, available: Boolean(token) };
}

async function mcpToolCall(source, name, args) {
  const { port, token, available } = sourceConfig(source);
  if (!available) throw new Error(source === 'existing' ? 'existing engine token not found' : 'managed engine unavailable');
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (response.status === 401) throw new Error('engine rejected token (401)');
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const payload = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  const block = payload.result?.content?.find?.((item) => item.type === 'text');
  const raw = block?.text ?? JSON.stringify(payload.result);
  if (payload.result?.isError) throw new Error(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function verifyElectronAsNode() {
  if (runAsNodeCheck) return runAsNodeCheck;
  runAsNodeCheck = new Promise((resolvePromise) => {
    const code = [
      "const { DatabaseSync } = require('node:sqlite');",
      "const db = new DatabaseSync(':memory:');",
      "db.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(42)');",
      "const row = db.prepare('SELECT x FROM t').get();",
      "const out = { versions: process.versions, sqliteOk: row.x === 42, execPath: process.execPath };",
      'db.close(); console.log(JSON.stringify(out));'
    ].join(' ');
    const child = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ ok: false, error: 'timeout after 20s' });
    }, 20000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: error.message });
    });
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      try {
        const lastLine = stdout.trim().split(/\r?\n/).pop();
        resolvePromise({ ok: true, exitCode, ...JSON.parse(lastLine), stderr: redact(stderr).slice(0, 1000) });
      } catch {
        resolvePromise({
          ok: false,
          exitCode,
          stdout: redact(stdout).slice(0, 2000),
          stderr: redact(stderr).slice(0, 2000)
        });
      }
    });
  });
  return runAsNodeCheck;
}

async function existingHealth() {
  try {
    return { ok: true, health: await fetchHealth(existingPort) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function initUpdater() {
  if (updater) return updater;
  const updaterModule = await import('electron-updater');
  const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
  if (!autoUpdater) throw new Error('electron-updater autoUpdater export not found');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.logger = {
    info: (message) => pushUpdateEvent('info', message),
    warn: (message) => pushUpdateEvent('warn', message),
    error: (message) => pushUpdateEvent('error', message),
    debug: () => {}
  };
  autoUpdater.on('checking-for-update', () => pushUpdateEvent('checking-for-update'));
  autoUpdater.on('update-available', (info) => {
    updateState.availableVersion = info?.version;
    pushUpdateEvent('update-available', `version=${info?.version}`);
  });
  autoUpdater.on('update-not-available', (info) => {
    updateState.availableVersion = null;
    pushUpdateEvent('update-not-available', `version=${info?.version}`);
  });
  autoUpdater.on('download-progress', (progress) => {
    updateState.progress = Math.round(progress?.percent || 0);
    pushUpdateEvent('download-progress', `${updateState.progress}%`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState.downloaded = true;
    updateState.downloadedVersion = info?.version;
    updateState.status = 'downloaded';
    pushUpdateEvent('update-downloaded', `version=${info?.version}`);
    if (isUpdateCheck) {
      const outPath = argValue('--update-out') || join(outputDir(), 'update-result.json');
      writeUpdateResult(outPath);
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(true, !isUpdateCheck);
        } catch (error) {
          pushUpdateEvent('install-error', error.message);
          writeUpdateResult(outPath);
          app.exit(4);
        }
      }, 1500);
    }
  });
  autoUpdater.on('error', (error) => {
    updateState.status = 'error';
    pushUpdateEvent('error', error?.message || String(error));
    if (isUpdateCheck) {
      const outPath = argValue('--update-out') || join(outputDir(), 'update-result.json');
      writeUpdateResult(outPath);
      app.exit(2);
    }
  });
  updater = autoUpdater;
  return updater;
}

function pushUpdateEvent(type, detail) {
  const event = { t: new Date().toISOString(), type, detail: detail ? redact(detail) : undefined };
  updateState.events.push(event);
  if (updateState.events.length > 200) updateState.events.shift();
  if (win && !win.isDestroyed()) win.webContents.send('update:event', event);
}

function writeUpdateResult(outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  updateState.currentVersion = app.getVersion();
  writeFileSync(outPath, JSON.stringify(updateState, null, 2));
  console.log(`UPDATE_RESULT ${outPath}`);
}

async function runUpdateCheckForCli() {
  const outPath = argValue('--update-out') || join(outputDir(), 'update-result.json');
  updateState.status = 'checking';
  const startedAt = Date.now();
  const timeout = setTimeout(() => {
    updateState.status = 'timeout';
    pushUpdateEvent('timeout', 'no update-downloaded event within 10 minutes');
    writeUpdateResult(outPath);
    app.exit(3);
  }, 10 * 60 * 1000);
  timeout.unref?.();
  try {
    const autoUpdater = await initUpdater();
    updateState.status = 'checking';
    await autoUpdater.checkForUpdates();
    updateState.status = 'check-returned';
    pushUpdateEvent('check-returned', `${Date.now() - startedAt} ms`);
    if (!updateState.downloaded) {
      // Wait for download events; fall back to a short grace period when no update exists.
      setTimeout(() => {
        if (!updateState.downloaded) {
          updateState.status = 'done-not-downloaded';
          writeUpdateResult(outPath);
          app.exit(0);
        }
      }, 30000);
    }
  } catch (error) {
    updateState.status = 'error';
    pushUpdateEvent('error', error.message);
    writeUpdateResult(outPath);
    app.exit(2);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    title: `Agent Workbench Spike ${app.getVersion()}`,
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message ?? ''}`);
  });
  win.loadFile(join(__dirname, 'renderer', 'index.html'));
  return win;
}

async function runSmoke() {
  const startedAt = Date.now();
  const result = {
    timestamp: new Date().toISOString(),
    kind: 'smoke',
    packaged: isPackaged,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    engineRoot,
    spikePort,
    iconPath: appIconPath,
    iconExists: existsSync(appIconPath),
    appUserModelId: APP_USER_MODEL_ID,
    attachOnly: isAttachOnly,
    appReadyMs: Math.round(process.uptime() * 1000),
    runAsNode: null,
    engine: null,
    tasks: null,
    logs: null
  };

  result.runAsNode = await verifyElectronAsNode();

  if (!isAttachOnly) {
    try {
      await startEngine('electron-as-node');
      result.engine = { started: true, startMs: engine.startMs, health: engine.health };
    } catch (error) {
      result.engine = { started: false, error: error.message };
    }
  }

  try {
    const list = await mcpToolCall('existing', 'task_list', { limit: 5 });
    const first = Array.isArray(list?.tasks) ? list.tasks[0] : null;
    result.tasks = {
      source: 'existing',
      port: existingPort,
      count: list?.tasks?.length ?? 0,
      firstTaskId: first?.task_id ?? null,
      sample: (list?.tasks ?? []).slice(0, 2)
    };
    if (first?.task_id) {
      const logs = await mcpToolCall('existing', 'task_logs', { task_id: first.task_id, limit: 20 });
      result.logs = { taskId: first.task_id, entries: logs?.entries?.length ?? 0, nextCursor: logs?.next_cursor ?? null };
    }
  } catch (error) {
    result.tasks = { source: 'existing', error: error.message };
  }

  await Promise.race([rendererReady, delay(5000)]);
  try {
    const firstTask = result.tasks?.firstTaskId;
    await win.webContents.executeJavaScript(
      `refreshEngine();${firstTask ? ` loadLogs(${JSON.stringify(firstTask)});` : ''}`
    );
  } catch (error) {
    result.rendererRefreshError = error.message;
  }
  await delay(700);
  const outDir = outputDir();
  mkdirSync(outDir, { recursive: true });
  try {
    const image = await win.webContents.capturePage();
    const screenshot = join(outDir, 'smoke.png');
    writeFileSync(screenshot, image.toPNG());
    result.screenshot = screenshot;

    await win.webContents.executeJavaScript("document.getElementById('about').scrollIntoView({ block: 'end' }); true");
    await delay(300);
    const aboutImage = await win.webContents.capturePage();
    const aboutScreenshot = join(outDir, 'about.png');
    writeFileSync(aboutScreenshot, aboutImage.toPNG());
    result.aboutScreenshot = aboutScreenshot;
  } catch (error) {
    result.screenshotError = error.message;
  }

  if (engine.running) {
    await stopEngine();
    result.engine = { ...(result.engine || {}), stopMs: engine.stopMs };
  }

  result.durationMs = Date.now() - startedAt;
  const outPath = argValue('--smoke-out') || join(outDir, 'smoke-result.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`SMOKE_RESULT ${outPath}`);
  app.exit(0);
}

if (isPrintVersion) {
  console.log(`version=${app.getVersion()}`);
  process.exit(0);
}

if (!isSmoke && !isUpdateCheck) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (win) {
        win.show();
        win.focus();
      }
    });
  }
}

app.whenReady().then(async () => {
  await session.defaultSession.setProxy(
    proxyRules
      ? { proxyRules, proxyBypassRules: '<local>' }
      : { mode: 'direct' }
  );

  if (isUpdateCheck) {
    try {
      await runUpdateCheckForCli();
    } catch (error) {
      updateState.status = 'error';
      pushUpdateEvent('fatal', error?.stack || error?.message || String(error));
      const outPath = argValue('--update-out') || join(outputDir(), 'update-result.json');
      writeUpdateResult(outPath);
      app.exit(2);
    }
    return;
  }

  createWindow();
  win.webContents.on('did-finish-load', async () => {
    if (isSmoke) await runSmoke();
  });
  win.on('closed', () => { win = null; });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isSmoke && !isUpdateCheck) app.quit();
});

ipcMain.handle('app:info', async () => ({
  appVersion: app.getVersion(),
  packaged: isPackaged,
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  engineRoot,
  engineEntry,
  engineEntryExists: existsSync(engineEntry),
  appUserModelId: APP_USER_MODEL_ID,
  iconPath: appIconPath,
  iconExists: existsSync(appIconPath),
  spikePort,
  existingPort,
  existingTokenAvailable: Boolean(readExistingToken()),
  proxy: proxyRules || null,
  runAsNode: await verifyElectronAsNode()
}));

ipcMain.handle('engine:status', async () => ({
  ...engineStatus(),
  existing: await existingHealth()
}));

ipcMain.handle('engine:start', async (_event, options = {}) => {
  const status = await startEngine(options.nodeKind === 'system-node' ? 'system-node' : 'electron-as-node');
  return { ok: true, ...status };
});

ipcMain.handle('engine:stop', async () => ({ ok: true, ...(await stopEngine()) }));

ipcMain.handle('tasks:list', async (_event, { source = 'existing', limit = 20 } = {}) => {
  const list = await mcpToolCall(source, 'task_list', { limit });
  return { ok: true, source, ...list };
});

ipcMain.handle('tasks:logs', async (_event, { source = 'existing', taskId, limit = 200 } = {}) => {
  const logs = await mcpToolCall(source, 'task_logs', { task_id: taskId, limit });
  return { ok: true, source, ...logs };
});

ipcMain.handle('update:state', async () => ({
  ...updateState,
  packaged: isPackaged,
  allowPrerelease: true
}));

ipcMain.handle('update:check', async () => {
  if (!isPackaged) throw new Error('auto-update requires a packaged build');
  const autoUpdater = await initUpdater();
  updateState.status = 'checking';
  await autoUpdater.checkForUpdates();
  return { ...updateState };
});

ipcMain.handle('update:install', async () => {
  if (!updater) throw new Error('updater not initialized');
  updater.quitAndInstall(true, true);
  return { ok: true };
});