# GUI 技术选型决策文档（Electron vs Tauri）

> 状态：**调研完成，待用户决策**
> 日期：2026-11-13
> 适用范围：agent-workbench 桌面 GUI（阶段二）
> 结论性质：本文给出推荐方案，但**不锁定技术栈**；最终选型由用户确认。
> 事实边界：文中标注“估算”的体积/耗时数据未在本机实测，来自公开资料的量级判断；精确数字需在选型 spike 中实测。
> 审核记录：2026-11-13 dsh 独立只读审核提出 10 项问题（无高危），已逐项修正；推荐结论不变。

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

- 主进程为 Node.js 环境，可直接使用 `child_process` 拉起现有 `node src/server.js`。
- 引擎有两种使用方式：**attach** 已由现有启动脚本拉起的服务，或由主进程以子进程方式 **spawn**。子进程可使用系统 Node 22，也可用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带 Node 二进制（后者需验证 `node:sqlite` 支持）。
- 渲染进程为 Chromium；通过 preload + IPC 与主进程通信，渲染进程不直接接触 Node、文件系统和 token。
- 打包：electron-builder（NSIS 安装包）；自动更新：electron-updater（GitHub Releases，支持差分更新）。
- 安装包体积：**估算约 80–150 MB**（含 Chromium + Node）；安装后占用更大。具体取决于裁剪与压缩。
- 开发语言：JavaScript/TypeScript 一套；构建链为 Node 生态。

### 方案 B：Tauri 2

- 核心为 Rust；Windows 上使用系统 WebView2 渲染前端。
- 引擎有两种使用方式：**attach** 现有外部服务（当前 `AgentWorkbench.vbs` + `start-workbench.cmd` 形态，GUI 只走 `127.0.0.1:8080`，无需 sidecar），或随包携带 **Node 22 sidecar**（或 SEA 单文件）由 Rust 侧启动/监管。
- 打包：NSIS/MSI；自动更新：`tauri-plugin-updater`，用单个 Ed25519 密钥对签名；公开仓库可用 GitHub Releases 托管 `latest.json`，无需自建静态源或 PKI。
- 安装包体积：**不携带 Node 时估算约 3–10 MB；携带 Node 22 sidecar 后估算约 40–90 MB**。
- 开发语言：Rust + 前端 + Node sidecar（自包含分发时），最多三套运行时/工具链。

### 方案 C（对照，不推荐作为 v1）：保持外部服务 + 浏览器 UI

- 引擎继续由启动脚本管理，GUI 只是一个本地网页。
- 成本最低，但不满足“可安装桌面软件”的目标，且进程管理、开机自启、更新体验仍分散。仅作为过渡形态。

---

## 3. 对比表

评分说明：5 = 最适合本项目，1 = 最不适合。评分为定性判断，不是 benchmark。

| 维度 | Electron | Tauri 2 | 权重 | 说明 |
|---|---|---|---|---|
| 复用现有 Node/MCP 引擎 | **5** | 3 | 30% | Electron 主进程即 Node，attach/spawn 都是原生能力；Tauri 可 attach 外部引擎，若要 GUI 自管理/自包含则需 Node sidecar + Rust 监管层 |
| 开发与维护成本 | **5** | 2 | 25% | Electron 单一 JS/TS 技术栈；Tauri 自包含分发时需 Rust + 前端 + Node 三套技能与构建链 |
| 安装包体积 | 2 | **4** | 10% | 同口径比较：attach 外部 Node 时 Tauri 估算 3–10 MB、Electron 80–150 MB；自包含携带 Node 时 Tauri 估算 40–90 MB、Electron 80–150 MB |
| 自动更新成熟度 | **5** | 4 | 10% | electron-updater 生态成熟、差分更新开箱即用；Tauri updater 可用，单个 Ed25519 密钥对，公开仓库可用 Releases 托管 `latest.json`，无需自建源或 PKI |
| 权限/安全模型 | 3 | **4** | 10% | Electron 12+ 默认 `contextIsolation=true`，20+ 在未启用 `nodeIntegration` 时默认 `sandbox=true`，5+ 默认 `nodeIntegration=false`；CSP、导航/新窗口限制仍需自行配置。Tauri 2 capability 默认拒绝、命令面更细粒度 |
| Windows 11 适配 | **5** | 4 | 5% | Electron 自带 Chromium，渲染一致；Tauri 依赖 WebView2（Win11 预装，但版本随系统更新） |
| 生态与排障资料 | **5** | 3 | 5% | Electron 问题更容易检索；Tauri 2 相对新，Rust 侧排障门槛高 |
| 与现有执行器/子进程配合 | **5** | 3 | 5% | 引擎已大量使用 Node 子进程与进程树清理，Electron 侧可复用同一套逻辑与工具函数 |
| **加权总分** | **4.50** | **3.10** | 100% | Electron 领先，主要来自引擎复用与维护成本 |

### 3.1 加权计算过程

公式：**加权总分 = Σ(维度得分 × 维度权重)**。

| 维度 | 权重 | Electron 得分 | Electron 加权 | Tauri 得分 | Tauri 加权 |
|---|---:|---:|---:|---:|---:|
| 复用现有 Node/MCP 引擎 | 30% | 5 | 5 × 0.30 = 1.50 | 3 | 3 × 0.30 = 0.90 |
| 开发与维护成本 | 25% | 5 | 5 × 0.25 = 1.25 | 2 | 2 × 0.25 = 0.50 |
| 安装包体积 | 10% | 2 | 2 × 0.10 = 0.20 | 4 | 4 × 0.10 = 0.40 |
| 自动更新成熟度 | 10% | 5 | 5 × 0.10 = 0.50 | 4 | 4 × 0.10 = 0.40 |
| 权限/安全模型 | 10% | 3 | 3 × 0.10 = 0.30 | 4 | 4 × 0.10 = 0.40 |
| Windows 11 适配 | 5% | 5 | 5 × 0.05 = 0.25 | 4 | 4 × 0.05 = 0.20 |
| 生态与排障资料 | 5% | 5 | 5 × 0.05 = 0.25 | 3 | 3 × 0.05 = 0.15 |
| 与现有执行器/子进程配合 | 5% | 5 | 5 × 0.05 = 0.25 | 3 | 3 × 0.05 = 0.15 |
| **合计** | **100%** | — | **4.50** | — | **3.10** |

复算：

- Electron：`5×0.30 + 5×0.25 + 2×0.10 + 5×0.10 + 3×0.10 + 5×0.05 + 5×0.05 + 5×0.05 = 4.50`
- Tauri：`3×0.30 + 2×0.25 + 4×0.10 + 4×0.10 + 4×0.10 + 4×0.05 + 3×0.05 + 3×0.05 = 3.10`

### 3.2 权重敏感性

评分含主观判断，结论需要对权重不敏感。示例：把体积权重提高到 30%，其余维度按“引擎 25%、维护 20%、更新 10%、权限 5%、Win11 4%、生态 3%、子进程 3%”重新分配（合计 100%）：

| 维度 | 调整后权重 | Electron 加权 | Tauri 加权 |
|---|---:|---:|---:|
| 安装包体积 | 30% | 2 × 0.30 = 0.60 | 4 × 0.30 = 1.20 |
| 复用现有 Node/MCP 引擎 | 25% | 5 × 0.25 = 1.25 | 3 × 0.25 = 0.75 |
| 开发与维护成本 | 20% | 5 × 0.20 = 1.00 | 2 × 0.20 = 0.40 |
| 自动更新成熟度 | 10% | 5 × 0.10 = 0.50 | 4 × 0.10 = 0.40 |
| 权限/安全模型 | 5% | 3 × 0.05 = 0.15 | 4 × 0.05 = 0.20 |
| Windows 11 适配 | 4% | 5 × 0.04 = 0.20 | 4 × 0.04 = 0.16 |
| 生态与排障资料 | 3% | 5 × 0.03 = 0.15 | 3 × 0.03 = 0.09 |
| 与现有执行器/子进程配合 | 3% | 5 × 0.03 = 0.15 | 3 × 0.03 = 0.09 |
| **合计** | **100%** | **4.00** | **3.29** |

即使把体积权重提高到 30%，Electron 仍以 4.00 对 3.29 领先；结论不依赖原权重表的精确取值。

### 3.3 体积的再说明（同口径）

两种方案都支持 **attach 外部引擎** 与 **自包含分发**，体积必须在同一口径下比较：

| 分发方式 | Electron（估算） | Tauri（估算） | 比值（Electron / Tauri） |
|---|---:|---:|---:|
| attach 外部 Node 服务（不随包携带 Node） | 80–150 MB | 3–10 MB | 约 8×–50× |
| 自包含携带 Node 22 | 80–150 MB | 40–90 MB | 区间端点 0.89×–3.75×，中点约 1.77× |

计算口径：比值 = 区间端点直接相除；中点比 = (80+150)/2 ÷ (40+90)/2 = 115 ÷ 65 ≈ 1.77。**不能概括为固定约 2 倍**：中点约 1.8 倍，按区间端点最坏可达约 3.75 倍；精确值需 spike 实测。

对本项目的影响：

- 若产品接受“用户预装 Node 22、GUI 只 attach”，Tauri 的体积优势明显（3–10 MB vs 80–150 MB）。
- 若产品要求“安装即用、GUI 自管理引擎”，两种方案都要携带 Node 22，Tauri 估算 40–90 MB、Electron 估算 80–150 MB，体积优势收窄但仍在。
- 体积不是唯一因素；对单人维护项目，引入 Rust + Node 双运行时的长期成本是确定项。

---

## 4. 推荐结论

**推荐 Electron（待用户确认）。**

理由按重要性排序：

1. **引擎复用成本最低**：现有引擎是 Node.js 22 服务，Electron 主进程天然是 Node 环境，attach 与 spawn 都是原生能力；Tauri 也能 attach 外部引擎，但若要 GUI 自管理或自包含分发，仍需 Node sidecar 与 Rust 监管层。
2. **单人维护友好**：一套 JavaScript/TypeScript 技术栈、一套 npm 构建链，避免 Rust 工具链与跨语言调试。
3. **自动更新最成熟**：electron-builder + electron-updater 对 GitHub Releases、NSIS、差分更新支持完善，适合当前公开仓库的分发方式。
4. **Windows 11 渲染一致性**：自带 Chromium，不依赖系统 WebView2 的版本差异；对本地工具类应用足够。
5. **体积可接受**：安装包约 80–150 MB（估算），对本机桌面工具不是关键否决项；若后续用户明确要求“极致小体积”，可重新评估 Tauri attach 外部 Node（估算 3–10 MB）或 Node sidecar 方案（估算 40–90 MB）。

**不推荐当前直接选 Tauri 的原因**：
- 本项目的核心资产是 Node 引擎。Tauri 可以 attach 外部服务，但“安装即用、GUI 自管理引擎”的目标最终仍要引入 Node 运行时与 Rust 监管层，这是确定的维护成本。
- Tauri 的 capability 机制约束的是**前端可调用的命令面**（默认拒绝、白名单），不是后端进程的 OS 权限。两种方案的 GUI 后端最终都需要广泛权限（spawn 执行器、读写日志、管理引擎），因此真正的差异在于：Tauri 对前端可触达的命令面有更细粒度的默认约束；Electron 的渲染进程隔离默认值自 12/20/5 起已安全，但 CSP、导航限制与 IPC 暴露面仍需开发者自行设计。Tauri 的权限优势存在，但不应夸大。
- 若用户明确接受“预装 Node + attach 模式”，Tauri 的体积优势（3–10 MB vs 80–150 MB）会很有吸引力，届时可重新评估。

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
| 引擎运行位置 | 独立子进程 / Electron 主进程内 | **独立子进程**：保持边界与崩溃隔离。子进程可用系统 Node 22，或用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带 Node 二进制（需验证内置 Node 版本与 `node:sqlite`） |
| 更新通道 | GitHub Releases / 自建静态源 | GitHub Releases（现有公开仓库） |

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| Electron 自带 Node 的版本与 `node:sqlite` 编译支持不确定 | 若用 `ELECTRON_RUN_AS_NODE=1` 跑引擎，可能缺少模块 | spike 中执行 `ELECTRON_RUN_AS_NODE=1 electron -e "require('node:sqlite')"` 验证；不可用则随包分发独立 Node 22，或依赖系统 Node（attach 模式） |
| 渲染进程安全配置不当 | XSS/远程内容可触达主进程能力 | 确认锁定版本的安全默认值（Electron 12+ `contextIsolation=true`、20+ 未启用 `nodeIntegration` 时 `sandbox=true`、5+ `nodeIntegration=false`）；重点配置严格 CSP、禁止远程内容与外部导航、最小化 preload/IPC 暴露面 |
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
   - 验证 `ELECTRON_RUN_AS_NODE=1` 下 Electron 自带 Node 的版本与 `node:sqlite` 是否可用；不可用则确定“随包独立 Node 22”或“依赖系统 Node（attach）”方案。
3. **确定 GUI MVP 范围**：执行器状态、任务列表/详情/日志、启动与取消、配置编辑、token 管理、开机自启、入口（Tailscale/Cloudflare）状态。
4. **安全基线**：验证 Electron 安全默认值（`contextIsolation` 自 12、`sandbox` 自 20、`nodeIntegration=false` 自 5），配置严格 CSP、导航/新窗口限制、最小化 IPC 暴露面；token 存储、日志脱敏、单实例与进程所有权。
5. **更新与签名**：确定代码签名方案与更新通道，再进入功能开发。
6. 在用户确认前，GUI 相关工作保持 `[TODO]/[NEEDS_USER_DECISION]` 状态，不写入正式排期。

---

## 8. 参考与事实来源

- 本仓库：`package.json`（Node >=22.5、依赖）、`src/server.js`（HTTP/MCP/鉴权）、`src/config.js`（路径与环境变量）、`README.md`（部署与执行器）、`TESTS.md`（2026-11-12 验收）。
- Electron 官方文档：<https://www.electronjs.org/docs/latest/>（安全默认值、`ELECTRON_RUN_AS_NODE`、electron-builder/electron-updater 生态）。
- Tauri 官方文档：<https://v2.tauri.app/>（capabilities/ACL、updater 插件、sidecar、WebView2）。
- 体积与版本类数字为公开资料量级估算，**未在本机实测**；以 spike 实测为准。
- 文中默认值（`contextIsolation`/`sandbox`/`nodeIntegration`）以 Electron 官方文档所述版本引入点为准；**最终以 spike 时锁定的具体版本实测/文档为准**。
- 2026-11-13 调研时网络访问受限，未能在线复核 Electron/Tauri 最新版本文档；本文不写具体版本号，避免过时信息误导。