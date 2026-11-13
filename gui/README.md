# Agent Workbench GUI

正式 Electron GUI 工程（阶段四）。本轮搭建可运行界面壳：Electron + React 19 + TypeScript + Vite + Astryx 0.7.15 + 品牌适配层与静态主题。

## 运行

```bash
npm install
npm run dev        # Vite + tsc watch + Electron
npm run build      # 生成主题 CSS、主进程、渲染进程
npm start          # 运行已构建的壳
npm run typecheck
npm run release:local   # 打包 NSIS 并校验安装包/blockmap/latest.yml
```

发布与自动更新流程见 `docs/RELEASE_PIPELINE.md`。

首次安装 Electron 二进制若下载失败，可在安装时指定镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## 结构

```text
electron/main.ts      主进程：窗口、单实例、CSP、IPC 白名单、safeStorage
electron/engine.ts    引擎生命周期与主进程内 MCP 调用
electron/update.ts    electron-updater 更新状态机、通道与验证钩子
electron/preload.ts   contextBridge 暴露的最小 API
src/ui/astryx.tsx     Astryx 适配层（Button / Status / Table / Field 等）
src/theme/            静态品牌主题源（defineTheme）与构建产物（忽略提交）
src/pages/            5 个屏：任务、任务详情、派发、设置、关于
src/styles/           品牌样式（来自 mockups）与 Astryx 适配覆盖
scripts/build-theme.mjs    构建时生成主题 CSS，避免运行时注入
scripts/verify-release.mjs 校验安装包、blockmap 与 latest.yml
```

## 安全基线

- 数据目录：`app.getPath('userData')`，Windows 为 `%APPDATA%\agent-workbench`。
- Token：主进程 `safeStorage`（Windows DPAPI）加密后写入 `credentials/token.enc`；渲染进程只能设置/清除，不能读取明文。
- 单实例锁；第二个实例聚焦已有窗口。
- 渲染进程：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- 最小 IPC：固定频道白名单 + 可信来源校验；外部链接仅允许 https 的 GitHub 域名。
- 严格 CSP 由主进程注入；权限请求全部拒绝；禁止导航到外部页面、禁止新窗口与 webview。
- 主题使用构建期生成的静态 CSS，不依赖运行时 `<style>` 注入。

## 当前范围

已接入：5 屏可运行壳、品牌资产、路由、主题切换、Token 安全存储、数据目录与单实例状态展示；引擎生命周期与任务 IPC（派发、跟进、取消、日志轮询）；NSIS 打包、GitHub Actions 发布流水线、资产校验与 electron-updater 自动更新（含预发布通道）。

未接入：日志虚拟列表、设置页除凭据外的配置持久化。界面中相关位置均如实标注。

## 打包与更新

- 打包：`npm run dist`（electron-builder NSIS，输出 `gui/release/`）。
- 校验：`npm run verify:release`；CI 会对构建产物和 Release 下载产物各校验一次。
- 发版：推送 `v*` tag 触发 `.github/workflows/release.yml`；预发布 tag（如 `v0.1.0-rc.2`）自动标记为 prerelease。
- 更新验证：安装包支持 `--print-version`、`--update-verify --update-channel=prerelease`，配合 `AGENT_WORKBENCH_UPDATE_TRACE` 记录检查/下载/安装耗时。细节见 `docs/RELEASE_PIPELINE.md`。