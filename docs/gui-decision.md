# GUI 技术选型决策文档（Electron vs Tauri）

> 状态：**调研完成，待用户决策**
> 日期：2026-11-13
> 适用范围：agent-workbench 桌面 GUI（阶段二）
> 结论性质：本文给出推荐方案，但**不锁定技术栈**；最终选型由用户确认。
> 事实边界：文中标注“估算”的体积/耗时数据未在本机实测，来自公开资料的量级判断；精确数字需在选型 spike 中实测。

---

## 1. 背景与约束

### 1.1 产品目标

把当前“本地 MCP 服务器 + 启动脚本”的形态，升级为**带图形界面的可安装 Windows 桌面软件**：

- MCP 引擎（现有 Node.js 服务）继续作为核心，负责执行器管理、任务调度、状态与日志持久化。
- GUI 负责执行器状态、任务列表、日志查看、任务启动/取消、配置与 token 管理、开机自启与入口状态展示。
- 云端编排器（Muse）仍通过公网 HTTPS 调用 `POST /mcp`，GUI 不改变这条链路。

### 1.2 本项目特有约束

| 约束 | 现状 | 对选型的影响 |
|---|---|---|
| 操作系统 | 仅 Windows 11（用户家用机 `niumoi`，10.0.26100） | 不需要跨平台；WebView2 在 Win11 上预装但不保证版本一致 |
| 运行时 | Node.js 22（实测 v22.20.0），ESM，`node:sqlite` | 引擎必须跑在 Node 22；GUI 不能假设浏览器环境能替代 Node |
| 引擎形态 | 独立进程，`127.0.0.1:8080`，Streamable HTTP `/mcp`，`/health` 免鉴权 | GUI 可作为客户端连接，也可作为进程管理者；边界清晰，利于复用 |
| 引擎依赖 | `@modelcontextprotocol/sdk`、`cross-spawn`、`node:sqlite`、子进程管理 | 引擎不需要重写；GUI 只需“启动/停止/查询” |
| 维护人力 | 单人维护的小型项目 | 技术栈数量、构建链复杂度是硬成本 |
| 分发方式 | GitHub 公开仓库，当前无安装包 | 需要打包、签名、自动更新方案 |
| 安全现状 | Bearer Token、仅回环监听、执行器全权限运行 | GUI 必须妥善保管 token，不能把 token 暴露给渲染进程 |

### 1.3 非目标（本次不决定）

- 不选定 UI 框架（React/Vue/Svelte/原生）与组件库。
- 不决定是否把引擎重写为 Rust 或嵌入 GUI 主进程。
- 不开始写 GUI 业务代码；本文只做技术路线决策。

---

## 2. 候选方案

### 方案 A：Electron

- 主进程为 Node.js 环境，可直接使用 `child_process` 拉起现有 `node src/server.js`，或后续把引擎作为子进程随应用分发。
- 渲染进程为 Chromium；通过 preload + IPC 与主进程通信，渲染进程不直接接触 Node、文件系统和 token。
- 打包：electron-builder（NSIS 安装包）；自动更新：electron-updater（GitHub Releases，支持差分更新）。
- 安装包体积：**估算约 80–150 MB**（含 Chromium + Node）；安装后占用更大。具体取决于裁剪与压缩。
- 开发语言：JavaScript/TypeScript 一套；构建链为 Node 生态。

### 方案 B：Tauri 2

- 核心为 Rust；Windows 上使用系统 WebView2 渲染前端。
- 复用现有 Node 引擎需要 **Node sidecar**：随应用分发 Node 22 运行时（或 SEA 单文件），由 Rust 侧启动/监管；GUI 通过 Rust command 代理 HTTP 请求。
- 打包：NSIS/MSI；自动更新：`tauri-plugin-updater`（需签名密钥与更新清单托管）。
- 安装包体积：**不含 Node 时估算约 3–10 MB；含 Node 22 sidecar 后估算约 40–90 MB**。体积优势随 Node 运行时引入而明显缩小。
- 开发语言：Rust + 前端 + Node sidecar，三套运行时/工具链。

### 方案 C（对照，不推荐作为 v1）：保持外部服务 + 浏览器 UI

- 引擎继续由启动脚本管理，GUI 只是一个本地网页。
- 成本最低，但不满足“可安装桌面软件”的目标，且进程管理、开机自启、更新体验仍分散。仅作为过渡形态。

---

## 3. 对比表

评分说明：5 = 最适合本项目，1 = 最不适合。评分为定性判断，不是 benchmark。

| 维度 | Electron | Tauri 2 | 权重 | 说明 |
|---|---|---|---|---|
| 复用现有 Node/MCP 引擎 | **5** | 3 | 30% | Electron 主进程即 Node，可直接 spawn/监管；Tauri 必须引入 Node sidecar 并用 Rust 管理 |
| 开发与维护成本 | **5** | 2 | 25% | Electron 单一 JS/TS 技术栈；Tauri 需 Rust + 前端 + Node 三套技能与构建链 |
| 安装包体积 | 2 | **4** | 10% | Tauri 裸壳很小，但带 Node sidecar 后差距缩小到约 2 倍以内（估算） |
| 自动更新成熟度 | **5** | 4 | 10% | electron-updater 生态成熟、差分更新开箱即用；Tauri updater 可用但需自管签名与清单 |
| 权限/安全模型 | 3 | **4** | 10% | Tauri 2 默认拒绝 + capability 白名单更严格；Electron 需自行启用 contextIsolation/sandbox/CSP |
| Windows 11 适配 | **5** | 4 | 5% | Electron 自带 Chromium，渲染一致；Tauri 依赖 WebView2（Win11 预装，但版本随系统更新） |
| 生态与排障资料 | **5** | 3 | 5% | Electron 问题更容易检索；Tauri 2 相对新，Rust 侧排障门槛高 |
| 与现有执行器/子进程配合 | **5** | 3 | 5% | 引擎已大量使用 Node 子进程与进程树清理，Electron 侧可复用同一套逻辑与工具函数 |
| **加权总分** | **4.55** | **3.05** | 100% | Electron 明显领先，主要来自引擎复用与维护成本 |

### 3.1 体积的再说明

Tauri 的体积优势常以“裸壳 3–10 MB”宣传，但本项目**无法省掉 Node 22**：

- 引擎依赖 `node:sqlite`、ESM、`cross-spawn` 与现有子进程管理，短期重写为 Rust 不现实。
- 因此 Tauri 方案实际是“WebView2 壳 + Node 运行时 sidecar”，估算 40–90 MB；Electron 估算 80–150 MB。
- 对家用 Windows 11 单机分发，几十 MB 的差异**不足以抵消**引入 Rust 与双运行时带来的长期维护成本。

---

## 4. 推荐结论

**推荐 Electron（待用户确认）。**

理由按重要性排序：

1. **引擎复用成本最低**：现有引擎是 Node.js 22 服务，Electron 主进程天然是 Node 环境，启动、健康检查、进程树清理、日志读取都可用同一语言实现；Tauri 需要额外的 Node sidecar 与 Rust 监管层。
2. **单人维护友好**：一套 JavaScript/TypeScript 技术栈、一套 npm 构建链，避免 Rust 工具链与跨语言调试。
3. **自动更新最成熟**：electron-builder + electron-updater 对 GitHub Releases、NSIS、差分更新支持完善，适合当前公开仓库的分发方式。
4. **Windows 11 渲染一致性**：自带 Chromium，不依赖系统 WebView2 的版本差异；对本地工具类应用足够。
5. **体积可接受**：安装包约 80–150 MB（估算），对本机桌面工具不是关键否决项；若后续用户明确要求“极致小体积”，可重新评估 Tauri + Node sidecar。

**不推荐当前直接选 Tauri 的原因**：不是 Tauri 不好，而是本项目的核心资产是 Node 引擎；Tauri 的优势（小体积、严格权限）会被 Node sidecar 和“GUI 需要广泛文件/进程权限”这两个事实大幅稀释，而引入的 Rust 维护成本是确定的。

**决策保留项**：如果用户更看重安装包体积、希望长期把引擎迁移到 Rust、或已有 Rust 维护能力，Tauri 仍是可行路线；本文不替代用户决策。

---

## 5. 推荐架构（Electron 方案）

```
┌─────────────────────────────────────────────────────────┐
│ Electron App                                             │
│                                                         │
│  Renderer (Chromium)                                    │
│    - 任务列表 / 日志 / 执行器状态 / 设置                 │
│    - 无 Node 权限，无 token                              │
│         │ contextBridge + IPC (preload)                 │
│         ▼                                               │
│  Main Process (Node.js)                                 │
│    - 窗口与托盘、单实例锁                                │
│    - token 读取/生成（safeStorage/DPAPI）                │
│    - 进程监管：启动/停止/健康检查 MCP 引擎               │
│    - HTTP 客户端 → 127.0.0.1:8080 /health、/mcp          │
│         │ child_process.spawn                            │
│         ▼                                               │
│  MCP 引擎（现有 Node.js 22 服务，尽量不改）              │
│    - 调度 claude / dsh，SQLite + 文件日志                │
└─────────────────────────────────────────────────────────┘
```

关键原则：

- **引擎边界不变**：GUI 通过 `/health` 与 `/mcp` 与引擎交互，不直接读写 SQLite，避免与内部 schema 耦合。
- **token 不进渲染进程**：主进程持有 token；渲染进程只通过 IPC 请求“已鉴权的结果”。
- **单实例与进程归属**：GUI 启动时用单实例锁；检测 8080 是否已有引擎在跑（attach 模式），否则由 GUI spawn（manage 模式），避免与现有 Startup VBS 看门狗重复拉起。
- **过渡兼容**：v1 可先 attach 现有启动脚本拉起的服务；确认稳定后再把进程所有权迁移到 GUI。

### 5.1 待确认的集成问题

| 问题 | 选项 | 建议 |
|---|---|---|
| GUI 如何调用引擎 | 直接 MCP JSON-RPC / 新增本地 admin HTTP API / 直接读 SQLite | 优先复用 MCP 工具；日志与任务列表若 MCP 工具不足，再评估薄 admin API，不直接读库 |
| token 存储 | 继续 `workbench.env` 明文 / OS 凭据存储 | GUI 生成并存入 Windows DPAPI（Electron `safeStorage`），spawn 时注入环境变量；保留 `workbench.env` 兼容 |
| 进程所有权 | Startup VBS / GUI / 两者 | 长期由 GUI 单一管理；过渡期用 attach 模式避免双实例 |
| 引擎运行位置 | 独立子进程 / Electron 主进程内 | **独立子进程**：保持边界，避免 Electron 内置 Node 对 `node:sqlite` 的支持差异 |
| 更新通道 | GitHub Releases / 自建静态源 | GitHub Releases（现有公开仓库） |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Electron 内置 Node 与 `node:sqlite` 兼容性不确定 | 若把引擎跑在主进程内，可能启动失败 | 引擎始终作为独立子进程运行；spike 中验证随包分发的 Node 22 runtime |
| 渲染进程安全配置不当 | XSS/远程内容可触达主进程能力 | `contextIsolation: true`、`sandbox: true`、禁用 `nodeIntegration`、严格 CSP、禁止加载远程内容 |
| token 泄露 | 本地任意进程可调用引擎 | token 存 DPAPI；日志不打印 token；渲染进程不可见；保持回环监听 |
| 进程双启/端口冲突 | 两个引擎同时跑，SQLite 与调度冲突 | 单实例锁 + `/health` 探测 + 端口占用处理；明确进程所有权 |
| 自动更新签名与 SmartScreen | 未签名安装包触发警告；更新被篡改 | 尽早确定代码签名证书；更新包签名校验；先做手动更新兜底 |
| 安装包体积增长 | 下载与更新成本 | electron-builder 裁剪、asar、差分更新；设定体积预算并在 CI 记录 |
| 引擎 `node:sqlite` 仍属实验特性 | Node 升级可能带来 API 变化 | 锁定 Node 大版本；升级前跑 `TESTS.md` 回归 |
| 选型反复 | 返工成本 | 先做 1–2 天 spike（启动/停止/健康检查/日志/打包/更新），用实测数据再最终确认 |

---

## 7. 下一步

1. **用户确认技术栈**（Electron / Tauri / 暂缓）。确认前不创建 GUI 工程、不锁定依赖。
2. **选型 spike（1–2 天，确认后执行）**：
   - 最小 Electron 应用：启动/停止现有引擎、读取 `/health`、展示任务列表与增量日志、打开数据目录。
   - 打包 NSIS 安装包，记录**实测**安装包体积、冷启动时间、内存占用。
   - 走通一次 GitHub Releases 自动更新（可先用测试 tag）。
   - 验证随包 Node 22 的 `node:sqlite` 可用性，或确认依赖系统 Node 的降级方案。
3. **确定 GUI MVP 范围**：执行器状态、任务列表/详情/日志、启动与取消、配置编辑、token 管理、开机自启、入口（Tailscale/Cloudflare）状态。
4. **安全基线**：contextIsolation/sandbox/CSP、token 存储、日志脱敏、单实例与进程所有权。
5. **更新与签名**：确定代码签名方案与更新通道，再进入功能开发。
6. 在用户确认前，GUI 相关工作保持 `[TODO]/[NEEDS_USER_DECISION]` 状态，不写入正式排期。

---

## 8. 参考与事实来源

- 本仓库：`package.json`（Node >=22.5、依赖）、`src/server.js`（HTTP/MCP/鉴权）、`src/config.js`（路径与环境变量）、`README.md`（部署与执行器）、`TESTS.md`（2026-11-12 验收）。
- 体积与版本类数字为公开资料量级估算，**未在本机实测**；以 spike 实测为准。
- 2026-11-13 调研时网络访问受限，未能在线复核 Electron/Tauri 最新版本文档；本文不写具体版本号，避免过时信息误导。