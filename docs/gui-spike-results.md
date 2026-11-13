# Electron GUI Spike 实测结果

> 日期：2026-11-13
> 分支/提交：`spike/electron` @ `ef09762`；README 口径修正提交 `82a4bfd`
> 代码位置：`spike/electron/`（临时验证代码，不并入正式 GUI 工程）
> 核心服务：**未修改** `src/` 任何文件
> 事实边界：本文数字均为本机实测；无法直接观测的额度消耗不记录百分比或余额。
> 复核记录：2026-11-13 dsh 只读审核（任务 `faf4d74d-3bd6-4e8c-b5c8-1bf588ff3967`）指出 11 项文档问题，已按 `artifacts/` 证据逐项修正；**“Electron 可行”的结论不变**。
> 关联文档：`docs/gui-decision.md`、`RESUME.md`、`DAILY_LOG.md`

---

## 1. 结论

**Electron 在本项目可行。** 五项 spike 目标全部完成并通过：

| # | 目标 | 结果 |
|---|---|---|
| 1 | 主进程拉起/停止现有 MCP 引擎 | 通过（开发与打包环境均验证；停止后端口释放） |
| 2 | `/health`、任务与日志展示 | 通过（只读 MCP 调用，读取 5 个任务、20 条日志） |
| 3 | NSIS 打包实测 | 通过（安装包 **119.18 MiB**，解包 **386.13 MiB**） |
| 4 | GitHub Releases 自动更新 | 通过（0.0.1 → 0.0.2，安装后版本经 exe 实测确认） |
| 5 | `ELECTRON_RUN_AS_NODE` | 成立（Electron 44.4.5 内置 Node 24.21.0，`node:sqlite` 可用） |

剩余问题属于工程化事项（代码签名、发布流水线、数据目录、首启耗时），不是可行性否决项。

---

## 2. 实测环境与版本

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11 Home China 10.0.26100 |
| 系统 Node / npm | Node v22.20.0 / npm 10.9.3 |
| Electron | 44.4.5（使用本机已有 44.4.5 缓存/镜像下载） |
| Electron 内置 Node | 24.21.0 |
| Chromium | 152.0.7977.130 |
| electron-builder | 26.18.0 |
| electron-updater | 6.8.11 |
| 构建方式 | `electron-builder --win nsis`，x64，oneClick，per-user，未签名 |
| spike 代码 | `spike/electron/`，分支 `spike/electron` @ `ef09762` |

引擎启动方式：主进程 `child_process.spawn(process.execPath, ['.../src/server.js'])`，子进程环境设置 `ELECTRON_RUN_AS_NODE=1`；spike 实例使用端口 `18080`、独立 DB `data/spike/workbench.db`、独立日志 `logs/spike`，不干扰 `:8080` 正式引擎。

---

## 3. 分项实测

### 3.1 引擎拉起与停止

| 场景 | 启动耗时（spawn → `/health` 成功） | 停止耗时（taskkill → 端口不可达） |
|---|---:|---:|
| 开发模式，Electron Node | 269 / 390 ms（2 次样本：`smoke-result.json`、`final/smoke-result.json`） | 468 / 494 ms |
| 打包版，热启动 | 264 / 273 ms（2 次样本：`packaged/smoke-result-1.json`、`-2.json`） | 451 / 464 ms |
| 打包版，首次启动（冷文件缓存/Defender 扫描） | **4,264 ms** | 468 ms |

> 数字归属修正：264 ms 属于打包版热启动，不是开发模式；开发模式实测为 269 / 390 ms。

- 引擎在 Electron 自带 Node 下正常监听 `127.0.0.1:18080`，`/health` 返回 `ok: true`。
- 停止使用 `taskkill /T /F` 清理进程树，并读取 `logs/spike/server.pid` 兜底；停止后端口释放。
- 首次实现曾出现“停止失败留下孤儿进程，下一次启动误连旧实例”的问题：已增加启动前端口占用预检与 PID 文件兜底，复测通过。

### 3.2 `/health`、任务与日志

- `GET /health` 返回：`{"ok":true,"service":"agent-workbench","version":"0.1.0","uptime_s":...}`。
- 通过 MCP `tools/call` 只读调用 `task_list`（limit 5）与 `task_logs`（limit 20）：读取到 5 个任务、20 条日志。
- **自管引擎（:18080）**：token 由主进程 `randomBytes(24)` 现场生成，通过子进程环境注入；token 只在主进程，**不进入渲染进程**。
- **attach 现有引擎（:8080）**：token 从 `workbench.env`（开发模式）或 `SPIKE_EXISTING_ENV`（显式指定）读取。打包后 `devRoot` 为 `null`，默认路径为空，**必须设置 `SPIKE_EXISTING_ENV`**，否则报 `existing engine token not found`；`artifacts/startup-smoke.json` 与 `postupdate-smoke.json` 即该失败态证据（`attachOnly: true`、`tasks.error` 为该错误、`engine: null`）。
- 对 `:8080` 只做只读 MCP 调用（`task_list` / `task_logs`），**不写入、不改动其任务状态**；`smoke-result.json` 中 `tasks.source = "existing"`、`port = 8080`、`count = 5` 即该调用记录。
- 渲染进程安全配置：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、严格 CSP、preload 仅暴露白名单 IPC。
- 证据（本机、已 gitignore）：`spike/electron/artifacts/smoke.png`、`smoke-result.json`；打包版截图在 `artifacts/packaged/smoke.png`。

### 3.3 NSIS 打包实测

| 指标 | 0.0.1 | 0.0.2 |
|---|---:|---:|
| 安装包字节数 | 124,969,012 | 124,969,066 |
| 安装包体积 | **119.18 MiB** | **119.18 MiB** |
| blockmap | 132,822 B（0.13 MiB） | 132,853 B（0.13 MiB） |
| 解包目录 | 386.13 MiB / 3,744 文件 | 386.13 MiB / 3,744 文件 |
| 安装后目录 | — | 386.26 MiB / 3,745 文件 |
| 其中引擎资源 | 16.62 MiB / 3,670 文件（`resources/engine`，含完整 `node_modules`） | 同左 |

- 决策文档原估算“80–150 MB”**被实测覆盖**：实际安装包 119.18 MiB，处于估算区间内。
- 打包版窗口就绪（`appReadyMs`，进程启动 → 渲染层加载完成）：302–450 ms（多次运行）。
- 外部 wall-clock 冒烟周期 1.46–2.31 s（样本 1,455–2,311 ms），包含固定的 0.7 s 截图等待、Electron-as-Node 子进程验证、任务读取等开销，**不是**纯启动时间。
- 未配置图标（使用 Electron 默认图标）、未签名；SmartScreen 提示未在静默安装流程中直接观察。
- NSIS 默认安装后自动启动应用，会占用安装文件并干扰后续覆盖安装；spike 已设置 `runAfterFinish: false`。正式产品应保留“安装后启动”，但更新流程需处理运行中实例。

### 3.4 GitHub Releases 自动更新

测试发布：公开仓库 `mkmk56/agent-workbench` 的 **v0.0.2** Release，资产为安装包、blockmap、`latest.yml`。

流程与结果：

1. 安装 0.0.1（NSIS，per-user）。
2. 运行 0.0.1：`--update-check`。
3. electron-updater 检查 GitHub Releases：**2.2 s** 找到 0.0.2。
4. 下载 0.0.2：**本次验证命中 updater 缓存**。`update-result.json` 在检查完成（2,225 ms）后 213 ms 记录 `Update has already been downloaded to ...pending...`，随后触发 `update-downloaded`；全程没有 `download-progress` 事件，也没有对完整下载单独计时。此前“6–10 s / 0→100%”的说法没有证据，已删除；如需该数字，需清空 `%LOCALAPPDATA%\agent-workbench-gui-spike-updater\pending` 后复测，并把 `download-progress` 落盘到 `artifacts/`。
5. 触发 `update-downloaded`，写入结果文件，调用 `quitAndInstall(true, false)` 静默安装。
6. 安装完成后运行打包版冒烟测试：`artifacts/postupdate-smoke.json` 记录 `appVersion: "0.0.2"`，`update-result.json` 记录 `downloadedVersion: "0.0.2"`；`postupdate-startup.json` 两次运行 `exitCode: 0`，无残留进程。此前“`--print-version` 输出”无落盘证据，已改为引用上述产物。

过程中发现并修正的问题：

- **ESM 导入**：`import('electron-updater')` 的命名空间不含 `autoUpdater`，必须取 `module.default.autoUpdater`；否则更新检查静默不启动。
- **系统代理**：本机 Windows 系统代理为 `127.0.0.1:7897`，经代理访问 GitHub API 触发共享出口限流（403）；直连 API 为 200。spike 在未指定 `SPIKE_PROXY` 时强制 `direct` 模式。正式产品应保留用户代理配置并提供可诊断的失败信息。
- **发布接口 422**：`electron-builder --publish always` 创建了 Release 并上传安装包，但返回 `422 Published releases must have a valid tag`，且**未上传 `latest.yml`/blockmap**；最终通过 `gh release upload --clobber` 手工补齐。正式发布流水线必须在发布后校验资产完整性。
- 测试 Release/tag `v0.0.2` **当前仍保留在公开仓库**，是否删除待用户确认（删除会移除已安装 0.0.2 的后续更新源）。
- **发布可追溯性（补充）**：远程 tag `v0.0.2` 指向 `581725b`（09:43 CST 的文档提交），而 Release 资产在 04:50:48Z（12:50 CST）上传、spike 源码在 13:00:55 CST 才提交为 `ef09762`。即安装包由**未提交的工作区**构建，tag 提交不包含 spike 源码。该 Release `isDraft=false`、`isPrerelease=false`，是公开仓库上的正常发布；任何指向该仓库/更新通道的客户端都能看到它。正式流水线必须采用“tag → CI 构建 → 资产校验”，不得从工作区直接发布。

### 3.5 `ELECTRON_RUN_AS_NODE` 验证

```text
ELECTRON_RUN_AS_NODE=1 electron.exe -p process.versions
→ electron 44.4.5, node 24.21.0, v8 15.2.124.28-electron.0

ELECTRON_RUN_AS_NODE=1 electron.exe -e "node:sqlite 建表/插入/查询"
→ sqliteOk=true
```

进一步用该模式实际启动 `src/server.js`（隔离端口 `18080`）：`/health` 正常；`tools/list` 实测返回 8 个工具（证据 `artifacts/tools-list.json`），工具名与 `src/tools.js` 注册项一致；业务工具实测仅只读调用 `task_list` / `task_logs` 成功，**未实测** `task_start` / `task_send` / `task_cancel` / `wait_for_task`。**无需随包额外分发独立 Node 22**；但 Electron 内置 Node 24 与项目 `engines.node >=22.5` 的长期兼容性仍需在正式版本锁定后回归。

---

## 4. 风险与限制

| 级别 | 风险 | 说明与建议 |
|---|---|---|
| 高 | 安装包未签名 | SmartScreen 会拦截/警告；自动更新无法提供发布者身份保证。正式分发前必须确定代码签名方案 |
| 高 | 发布流水线不完整 | electron-builder 发布出现 422 且漏传 `latest.yml`；需在 CI/脚本中强制校验 Release 资产（安装包、blockmap、latest.yml） |
| 高 | 发布可追溯性 | `v0.0.2` 资产由未提交工作区构建，tag `v0.0.2` 指向 `581725b`，不含 spike 源码；且该 Release 为非 prerelease 的公开正式发布。正式流水线必须“tag → CI 构建 → 资产校验” |
| 中 | 测试 Release 留在公开仓库 | `v0.0.2` 含约 119 MiB 资产与 tag；应由用户决定保留或删除 |
| 中 | 默认端口冲突未验证 | spike 固定 `18080` 且只对 `18080` 做占用预检；正式产品绑定 `:8080` 时与现有常驻服务冲突如何处理未测 |
| 中 | 孤儿引擎/崩溃路径未验证 | 只验证了“正常停止”；GUI 被强杀或崩溃时是否留下引擎、是否占用 `:8080` 未验证 |
| 中 | 环境覆盖不足 | 未在干净机器、无 Node、非管理员账户环境验证 |
| 中 | 双实例并发未测 | 未验证两个实例同时启动时的端口、DB 与进程竞争；正式产品需单实例锁 |
| 中 | 首次启动引擎 4.26 s | 3,670 个引擎文件触发冷缓存/Defender 扫描；正式产品可考虑减少文件数、预启动或随 GUI 启动预热 |
| 中 | 引擎数据目录位于安装目录 | spike 沿用 `src/config.js` 的 root；正式产品应改为 `app.getPath('userData')`，避免升级/权限问题 |
| 中 | 代理处理 | spike 为绕过 API 限流强制直连；正式产品应尊重系统代理，并对 403/超时给出可诊断信息 |
| 低–中 | Electron Node 24 vs 项目 Node 22 | 当前引擎与 `node:sqlite` 实测可用；升级 Electron 前需跑 `TESTS.md` 回归 |
| 低 | 安装包 119.18 MiB / 解包 386 MiB | 对桌面工具可接受；可考虑裁剪 locales、压缩与差分更新 |
| 低 | 差分更新未单独验证 | 已生成 blockmap，但本次测试命中完整安装包缓存，未测量差分下载量 |
| 低 | 无自动回滚 | 更新失败时缺少回退机制，正式产品需设计 |

---

## 5. 下一步建议

1. **确认 Electron 并冻结版本**：建议锁定 Electron 44.4.5（或经回归后的固定版本），明确使用 `ELECTRON_RUN_AS_NODE` 跑引擎，系统 Node 作为回退。
2. **建立正式 GUI 工程**：与 `spike/electron` 分离；先做引擎管理、`/health`、任务列表/日志、配置与 token 存储的最小闭环。
3. **修正工程化基线**：数据目录移到 `app.getPath('userData')`；单实例与进程所有权；`safeStorage`/DPAPI 保存 token；严格 CSP 与最小 IPC。
4. **发布与更新流水线**：代码签名、图标、NSIS 配置、发布后资产校验、稳定/预发布通道、失败回滚与诊断日志。建议用 GitHub Actions 构建并发布，避免本机网络与手工上传差异。
5. **性能预算**：记录安装包/解包体积与首启耗时；评估减少引擎文件数或预启动，目标把首次引擎就绪压到可接受范围。
6. **清理测试资产**：确认是否删除 GitHub Release/tag `v0.0.2` 及本机 updater 缓存。

---

## 6. 复现命令（摘要）

```bat
:: 源码只在 spike/electron 分支；main 工作区只有被忽略/未跟踪的构建产物
git switch spike/electron
cd spike\electron
npm install

:: attach 现有 :8080 引擎时（打包版必须显式指定，否则读不到 token）
set SPIKE_EXISTING_ENV=D:\Claude\agent-workbench\workbench.env

node_modules\electron\dist\electron.exe . --smoke-test --out-dir=artifacts

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win nsis --publish never

node scripts\measure-start.mjs --exe "<installed>\Agent Workbench Spike.exe" --runs 3
"<installed>\Agent Workbench Spike.exe" --update-check --update-out=artifacts\update-result.json
```

> 开发模式下 attach `:8080` 默认读取仓库根的 `workbench.env`；打包版没有 `devRoot`，必须设置 `SPIKE_EXISTING_ENV`。不设置时 attach 仅能失败降级，不能读取任务/日志。

---

## 7. 证据位置

- 代码：分支 `spike/electron`，提交 `ef09762`（README 口径修正 `82a4bfd`，远程 `origin/spike/electron`）。**源码仅存于该分支提交**；`main` 工作区没有 `main.js`、`preload.cjs`、`renderer/` 等源文件，只有被忽略/未跟踪的 `spike/electron/artifacts/`、`release/`、`node_modules/`。`spike/electron/.gitignore` 只存在于 spike 分支；在 `main` 上这些目录是普通未跟踪项。
- 本机实测产物（JSON 11 份、PNG 3 张；均在 spike 分支被 gitignore，不入库）：
  - `smoke-result.json` — **通过**；开发模式自管引擎，任务读取走 `:8080` 只读
  - `final/smoke-result.json` — **通过**；开发模式 0.0.2
  - `packaged/smoke-result.json` — **通过**；打包版自管引擎（0.0.1）
  - `packaged/smoke-result-1.json` — **通过**；打包版热启动 264 ms；截图 `UnknownVizError`
  - `packaged/smoke-result-2.json` — **通过**；打包版热启动 273 ms；截图 `UnknownVizError`
  - `startup-smoke.json` — **降级**；打包版 attach，缺 `SPIKE_EXISTING_ENV`，`existing engine token not found`
  - `postupdate-smoke.json` — **降级**；打包版 attach，同一 token 缺失；`appVersion=0.0.2`
  - `startup-measure.json` — **通过**；打包版 3 次启动测量
  - `postupdate-startup.json` — **通过**；更新后 2 次启动测量
  - `update-result.json` — **通过**；更新检查、缓存命中、静默安装；无 `download-progress`
  - `tools-list.json` — **通过**；`:18080` 隔离引擎 `tools/list`，返回 8 个工具
  - `smoke.png`、`final/smoke.png`、`packaged/smoke.png` — 截图（`packaged` 有效；`smoke-result-1/2` 因 `UnknownVizError` 无截图）
- GitHub Release：<https://github.com/mkmk56/agent-workbench/releases/tag/v0.0.2>