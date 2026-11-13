const byId = (id) => document.getElementById(id);
const api = window.spike;

let info = null;
let selectedTaskId = null;

function text(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

function renderEngine(status) {
  const grid = byId('engineInfo');
  grid.replaceChildren();
  const rows = [
    ['状态', status.running ? '运行中' : '已停止'],
    ['端口', status.port],
    ['启动耗时', formatDuration(status.startMs)],
    ['停止耗时', formatDuration(status.stopMs)],
    ['Node 方式', status.nodeKind],
    ['健康检查', status.health ? `ok · uptime ${status.health.uptime_s}s` : '不可达'],
    ['现有引擎 :8080', status.existing?.ok ? `ok · uptime ${status.existing.health.uptime_s}s` : (status.existing?.error || '不可达')]
  ];
  if (status.lastError) rows.push(['最近错误', status.lastError]);
  for (const [label, value] of rows) {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = text(value);
    cell.append(dt, dd);
    grid.append(cell);
  }
  const lines = (status.logs || []).slice(-14).map((item) => `[${item.stream}] ${item.line}`);
  byId('engineLog').textContent = lines.length ? lines.join('\n') : '尚未启动';
}

function renderRunAsNode(result) {
  const box = byId('runAsNodeBox');
  if (!result) {
    box.textContent = '未验证';
    return;
  }
  const lines = [
    `ok=${result.ok} exitCode=${text(result.exitCode)}`,
    `node=${text(result.versions?.node)} electron=${text(result.versions?.electron)} v8=${text(result.versions?.v8)}`,
    `node:sqlite round-trip=${result.sqliteOk === true ? 'PASS' : 'FAIL'}`,
    `execPath=${text(result.execPath)}`
  ];
  if (result.error) lines.push(`error=${result.error}`);
  if (result.stderr) lines.push(`stderr=${result.stderr}`);
  box.textContent = lines.join('\n');
}

function renderTasks(tasks) {
  const tbody = byId('taskRows');
  tbody.replaceChildren();
  if (!tasks.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'muted';
    cell.textContent = '没有任务';
    row.append(cell);
    tbody.append(row);
    return;
  }
  for (const task of tasks) {
    const row = document.createElement('tr');
    if (task.task_id === selectedTaskId) row.classList.add('selected');
    row.addEventListener('click', () => loadLogs(task.task_id));
    for (const value of [task.task_id.slice(0, 8), task.agent, task.state, task.updated_at]) {
      const cell = document.createElement('td');
      cell.textContent = text(value);
      row.append(cell);
    }
    tbody.append(row);
  }
}

async function refreshEngine() {
  try {
    renderEngine(await api.engineStatus());
  } catch (error) {
    byId('engineLog').textContent = `状态读取失败：${error.message}`;
  }
}

async function refreshTasks() {
  const source = byId('sourceSelect').value;
  try {
    const result = await api.listTasks({ source, limit: 20 });
    renderTasks(result.tasks || []);
    if (source === 'existing' && !info?.existingTokenAvailable) {
      byId('taskLog').textContent = '未找到现有引擎 token（SPIKE_EXISTING_ENV 或仓库 workbench.env）';
    }
  } catch (error) {
    renderTasks([]);
    byId('taskLog').textContent = `任务读取失败：${error.message}`;
  }
}

async function loadLogs(taskId) {
  selectedTaskId = taskId;
  byId('logTaskId').textContent = taskId.slice(0, 8);
  const source = byId('sourceSelect').value;
  try {
    const result = await api.taskLogs({ source, taskId, limit: 300 });
    const lines = (result.entries || []).map((entry) => `[${entry.ts}] [${entry.stream}] ${entry.line}`);
    byId('taskLog').textContent = lines.length ? lines.join('\n') : '（无日志）';
    await refreshTasks();
  } catch (error) {
    byId('taskLog').textContent = `日志读取失败：${error.message}`;
  }
}

function renderUpdateState(state) {
  const packaged = state.packaged ?? info?.packaged;
  byId('checkUpdateBtn').disabled = !packaged;
  byId('installUpdateBtn').disabled = !state.downloaded;
  const parts = [
    `当前版本 ${state.currentVersion || info?.appVersion || '—'}`,
    `状态 ${state.status || 'idle'}`,
    state.availableVersion ? `可用 ${state.availableVersion}` : null,
    state.progress !== undefined ? `下载 ${state.progress}%` : null,
    state.downloaded ? `已下载 ${state.downloadedVersion}` : null
  ].filter(Boolean);
  byId('updateStatus').textContent = packaged
    ? parts.join(' · ')
    : '开发模式不启用自动更新；打包后可对 GitHub Releases 检查更新。';
  const events = (state.events || []).slice(-12)
    .map((event) => `[${event.t}] ${event.type}${event.detail ? ` — ${event.detail}` : ''}`);
  byId('updateEvents').textContent = events.join('\n');
}

async function loadInfo() {
  info = await api.info();
  byId('versionLine').textContent = [
    `v${info.appVersion}`,
    `Electron ${info.electron}`,
    `Node ${info.node}`,
    `Chromium ${info.chrome}`,
    info.packaged ? 'packaged' : 'dev'
  ].join(' · ');
  byId('packagedBadge').textContent = info.packaged ? '打包版本' : '开发模式';
  renderRunAsNode(info.runAsNode);
  byId('sourceSelect').value = info.existingTokenAvailable ? 'existing' : 'managed';
  renderUpdateState(await api.updateState());
}

byId('startElectronBtn').addEventListener('click', async () => {
  byId('startElectronBtn').disabled = true;
  try {
    await api.startEngine({ nodeKind: 'electron-as-node' });
  } catch (error) {
    byId('engineLog').textContent = `启动失败：${error.message}`;
  } finally {
    byId('startElectronBtn').disabled = false;
    await refreshEngine();
  }
});

byId('startSystemBtn').addEventListener('click', async () => {
  byId('startSystemBtn').disabled = true;
  try {
    await api.startEngine({ nodeKind: 'system-node' });
  } catch (error) {
    byId('engineLog').textContent = `启动失败：${error.message}`;
  } finally {
    byId('startSystemBtn').disabled = false;
    await refreshEngine();
  }
});

byId('stopBtn').addEventListener('click', async () => {
  byId('stopBtn').disabled = true;
  try {
    await api.stopEngine();
  } finally {
    byId('stopBtn').disabled = false;
    await refreshEngine();
  }
});

byId('refreshTasksBtn').addEventListener('click', refreshTasks);
byId('sourceSelect').addEventListener('change', () => {
  selectedTaskId = null;
  byId('taskLog').textContent = '选择左侧任务查看日志';
  refreshTasks();
});
byId('runAsNodeBtn').addEventListener('click', loadInfo);

byId('checkUpdateBtn').addEventListener('click', async () => {
  try {
    renderUpdateState(await api.checkUpdate());
  } catch (error) {
    byId('updateStatus').textContent = `检查失败：${error.message}`;
  }
});
byId('installUpdateBtn').addEventListener('click', async () => {
  try {
    await api.installUpdate();
  } catch (error) {
    byId('updateStatus').textContent = `安装失败：${error.message}`;
  }
});

api.onUpdateEvent((event) => {
  api.updateState().then(renderUpdateState).catch(() => {});
});

async function init() {
  console.log('renderer init: start');
  await loadInfo();
  console.log('renderer init: info loaded');
  await refreshEngine();
  console.log('renderer init: engine loaded');
  await refreshTasks();
  console.log('renderer init: tasks loaded');
  setInterval(refreshEngine, 2000);
  setInterval(() => { if (!selectedTaskId) refreshTasks(); }, 5000);
  api.ready();
}

init().catch((error) => {
  byId('versionLine').textContent = `初始化失败：${error.message}`;
});