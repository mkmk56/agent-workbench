# Electron GUI Spike（临时验证代码）

> 状态：spike 验证代码，**不属于正式 GUI 工程**，位于独立分支 `spike/electron`。
> 目的：在 1–2 天内验证 Electron 能否复用现有 MCP 引擎、打包 NSIS、走通 GitHub Releases 自动更新、确认 `ELECTRON_RUN_AS_NODE` 与 `node:sqlite`。
> 边界：不修改 `src/` 核心服务；引擎以子进程方式原样启动。

## 目录

```
spike/electron/
  main.js               Electron 主进程：窗口、引擎生命周期、/health、MCP 只读调用、更新
  preload.cjs           contextBridge（渲染进程不接触 Node / token）
  renderer/             原生 HTML/CSS/JS 界面
  assets/branding/      品牌图标（从 design/brand-icon 原样复制，未重绘）
  scripts/measure-start.mjs  冷启动耗时测量（spawn 打包后的 exe 并计时）
  release/              electron-builder 产物（gitignored）
  artifacts/            截图与实测 JSON（gitignored）
```

## 品牌图标集成

图标方向 A「汇聚」的资产取自 `design/brand-icon` 提交 `62957d8`，原样复制、未改动图形结构与颜色：

| 位置 | 使用的资产 |
|---|---|
| BrowserWindow 窗口图标 | `assets/branding/app-icon/agent-workbench.ico` |
| 应用 exe / 任务栏 / 开始菜单快捷方式 | `win.icon` 同一 ICO；AppUserModelID `com.mkmk56.agent-workbench.spike` |
| NSIS 安装包 / 卸载器 | `nsis.installerIcon`、`installerHeaderIcon`、`uninstallerIcon` 同一 ICO |
| 主界面字标 | `assets/branding/logo/logo-inverse.svg` |
| 关于区 | `assets/branding/app-icon/icon-256.png` |

验证截图与 JSON 在 `artifacts/packaged-icon-integration/`（gitignored）。

## 运行

```bat
cd spike\electron
npm install
npm start
```

开发模式默认：

- 主进程可用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`）或系统 Node 启动 `../../src/server.js`，端口 `18080`，独立 DB `data/spike/workbench.db` 与日志 `logs/spike`；不写入、不改动 `:8080` 正式引擎的状态，仅在 attach 模式下对它做只读 MCP 调用（`task_list` / `task_logs`）。
- 自管引擎的 token 由主进程 `randomBytes(24)` 现场生成并注入子进程环境；“现有引擎 :8080（只读）”的 token 才从 `../../workbench.env`（或 `SPIKE_EXISTING_ENV`）读取。token 只留在主进程，渲染进程不可见。
- **打包版 attach 必须设置 `SPIKE_EXISTING_ENV`**：打包后 `devRoot` 为 `null`，默认路径为空，未设置该变量时读取 token 失败并报 `existing engine token not found`（`artifacts/startup-smoke.json`、`postupdate-smoke.json` 即该失败态证据）。
- 任务与日志通过 MCP `tools/call`（`task_list` / `task_logs`）读取，不直接读 SQLite。`tools/list` 已在 `:18080` 隔离引擎上实测并落盘到 `artifacts/tools-list.json`（8 个工具）。

## 验证命令

```bat
:: ELECTRON_RUN_AS_NODE + node:sqlite
node_modules\electron\dist\electron.exe -e "console.log(process.versions)"

:: GUI 冒烟：启动引擎、/health、任务/日志、截图、停止、退出
node_modules\electron\dist\electron.exe . --smoke-test

:: 打包 NSIS
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win nsis --publish never

:: 冷启动测量
node scripts\measure-start.mjs --exe "%LOCALAPPDATA%\Programs\Agent Workbench Spike\Agent Workbench Spike.exe" --runs 3
```

## 自动更新

打包配置已写入 `package.json > build.publish`（GitHub `mkmk56/agent-workbench`）。更新测试流程：

1. 构建并安装旧版本；
2. 提升 `version` 后构建并发布到 GitHub Releases；
3. 运行旧版本 exe：`--update-check --update-out=<result.json>`，等待下载与静默安装；
4. 再运行 `--print-version` 核对版本。

发布为真实 GitHub Release，测试后应清理测试 release/tag。

## 已知限制（spike 范围）

- 无代码签名，SmartScreen 会警告。
- 打包版 attach 现有 `:8080` 引擎依赖 `SPIKE_EXISTING_ENV`，否则读不到 token；这是 spike 的已知限制，不是正式产品行为。
- 主进程无自动更新失败回滚。
- 引擎数据目录跟随 `src/config.js` 的 root，安装在 per-user 目录下；正式产品应改为 `app.getPath('userData')`。
- UI 无框架、无托盘、无单实例之外的进程归属设计。
- 安装包体积包含完整 `node_modules`（约 24 MB 源码依赖），未做裁剪优化。