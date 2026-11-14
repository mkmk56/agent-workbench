# RESUME — agent-workbench 项目长期状态记忆

> 最后更新：2026-11-13（MVP v0.1 范围确认、MIT 许可证、签名方案纠正为暂不签名；含 GUI 技术选型、Electron spike 实测与 dsh 复核修正）
> 本文件用于跨会话恢复项目上下文。只记录已验证的事实；无法观测的数据（如额度消耗）明确标注，不编造数字或测试结果。
> 事实来源：仓库代码与文档、git 记录、2026-11-13 的运行验证记录。

---

## A 项目基本信息

| 项目 | 内容 |
|---|---|
| 项目名称 | agent-workbench |
| 版本 | 0.1.0（`package.json`，`private: true`，不做 npm 发布） |
| 项目定位 | 本地 MCP 服务器，让云端编排器（Muse）把任务派发到本机的 Claude Code 与 DeepSeek Harness 执行 |
| 项目根目录 | `D:\Claude\agent-workbench` |
| 开发机 | 用户家用 Windows 11 电脑 `niumoi`（Windows 11 Home China，10.0.26100） |
| 运行时 | Node.js 22（`engines.node >=22.5`；TESTS.md 记录实测 Node v22.20.0） |
| 主要依赖 | `@modelcontextprotocol/sdk` ^1.0.0、`cross-spawn` ^7.0.6；SQLite 使用 Node 内置 `node:sqlite` |
| 服务监听 | `127.0.0.1:8080`（仅本机回环） |
| MCP 传输 | Streamable HTTP，端点为 `POST /mcp` |
| 健康检查 | `GET /health`，无需鉴权 |
| GitHub 仓库 | https://github.com/mkmk56/agent-workbench |
| 仓库可见性 / 分支 | 公开仓库（已在 GitHub 页面核实）/ `main` |
| 关键文档 | `README.md`（使用与部署）、`TESTS.md`（2026-11-12 验收记录）、`workbench.env.example`（配置样例） |

---

## B 产品需求与功能规划

### 最终目标

把 agent-workbench 从“本地 MCP 服务器”发展为**带图形界面的可安装桌面软件**；MCP 服务器继续作为核心引擎，负责执行器管理、任务调度、状态与日志持久化。GUI 技术栈已由用户确认 **Electron**，并已完成可行性 spike；正式 GUI 工程尚未开始。

2026-11-13：MVP v0.1 范围已由用户确认，见 `docs/MVP_SCOPE.md`。分发范围为用户本人自用 + 小圈子分享，不做面向公众的正式分发与推广；**签名方案为暂不签名**：SmartScreen 首次安装点一次“仍要运行”即可，以后如需公开分发再考虑 SignPath 免费签名。

### 当前产品形态

- Muse 经公网 HTTPS 调用；tailnet HTTP 入口仅作本机与手工调试备用。
- 本地服务调度 `claude` / `dsh` 两个执行器，管理并发、超时、取消、日志与续聊。
- 任务结果通过 `task_status` / `task_logs` / `wait_for_task` 回传。
- 当前没有图形界面；`dsh --profile web` 的 UI 与本项目无关，未使用。

### 已具备的核心能力

- 任务启动、续跑（`task_send`）、状态查询、增量日志、取消、任务列表、长轮询。
- 全局并发限制与 dsh 专属并发限制、任务超时、心跳日志、STALE 判定。
- SQLite 任务状态持久化 + 每任务文件日志；服务重启后将未完成任务标记为 FAILED 并清理进程树。
- Bearer Token 鉴权、按客户端限流、仅绑定回环地址。
- 双执行器：Claude Code（原生续跑）与 DeepSeek Harness（服务端拼接历史续聊）。

### 研发阶段

- **阶段一：项目接管** —— [DONE]
  - 本文件与 `DAILY_LOG.md` 的建立属于接管初始化，已完成。
  - GUI 技术选型与产品需求确认已完成。
- **阶段二：GUI 技术选型** —— [DONE]
  - 决策文档 `docs/gui-decision.md`，用户已确认 Electron。
- **阶段三：GUI 可行性** —— [DONE]
  - Electron spike 五项全部通过，见 `docs/gui-spike-results.md`。
- **阶段四：GUI 产品化** —— [IN_PROGRESS]（准备中）
  - MVP v0.1 范围与工程基线已确认（`docs/MVP_SCOPE.md`，2026-11-13）；正式 GUI 工程尚未创建。
  - 签名方案：**暂不签名**（自用 + 小圈子分享；SmartScreen 首次安装点“仍要运行”）；以后如需公开分发再评估 SignPath 免费签名。
- 2026-11-13：GUI 技术选型调研完成，决策文档 `docs/gui-decision.md`，推荐 Electron；**用户已确认 Electron**。
- 2026-11-13：Electron 选型 spike 完成（独立分支 `spike/electron`，提交 `ef09762`），五项验证全部通过；实测结果见 `docs/gui-spike-results.md`。核心 `src/` 未修改，spike 代码不并入 main。后续 spike 分支推进到 `56904d2`（接入 Converge 品牌图标），仅作验证记录，不改变正式工程边界。
- 2026-11-13：MVP v0.1 范围确认；仓库补充 MIT LICENSE；签名方案确定为**暂不签名**（自用 + 小圈子分享），见 `docs/MVP_SCOPE.md`。
- 2026-11-13 14:08 用户明确决定：暂不签名，SignPath 取消。提交 `9e4ba3c` / `1800683` 中误记的 SignPath 方案作废；`docs/SIGNING_SIGNPATH.md` 已删除，纠正记录见 `DAILY_LOG.md` 最新区块。

---

## C 当前系统架构

### 代码结构（仓库内已验证）

```
src/
  server.js          HTTP 服务、鉴权、限流、MCP Streamable HTTP、/health、PID 文件
  tools.js           注册 8 个 MCP 工具
  scheduler.js       任务调度、并发控制、执行器生命周期
  state.js           任务状态定义与状态流转
  store.js           基于 node:sqlite 的状态持久化 + 任务文件落盘
  config.js          环境变量与路径配置
  executors/
    process.js       子进程启动、输出采集、进程树清理
    claude.js        Claude Code 执行器
    dsh.js           DeepSeek Harness 执行器
scripts/             测试、远程检查、任务查询、消息复制等辅助脚本
start-workbench.cmd  启动脚本
start-hidden.vbs     隐藏启动入口
```

### 数据持久化（以实际代码为准）

- SQLite：`data/workbench.db`，使用 `node:sqlite` 的 `DatabaseSync`，开启 WAL（`journal_mode = WAL`、`synchronous = NORMAL`）。
- 每任务文件：
  - `data/<task-id>.log`：按行追加的文本日志（格式 `[时间] [流] 内容`），**不是 JSONL**。
  - `data/<task-id>.prompt`：任务提示词原文。
  - 任务元数据同时以 JSON 文件形式写入 `data/`。
- `data/`、`logs/`、`workbench.env` 均在 `.gitignore` 中，不进入仓库。

### MCP 工具（8 个，已核对 `src/tools.js`）

`agent_info`、`task_start`、`task_send`、`task_status`、`task_logs`、`task_cancel`、`task_list`、`wait_for_task`。

### 执行器

| 执行器 | 版本 | 能力 | 实现方式 |
|---|---|---|---|
| claude | 2.1.270 | 可用、支持原生续跑 | `claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`；首轮 `--session-id`，后续 `--resume`；注入 `~/.claude/settings.json` 的 `env` |
| dsh | 0.1.0-rc.6 | 可用、headless 一次性、不支持原生续跑 | `dsh --profile headless <prompt>`；多轮由服务端拼接历史 |

- claude 实际通过内部 DeepSeek 网关运行：`https://maas.qianwenaiapi.com/apps/anthropic`，模型 `deepseek-v4.1-flash`（见 README / TESTS.md）。
- dsh headless 使用独立扁平凭据文件 `C:\Users\yikai\.dsh\.credentials-headless.yaml`，桌面端凭据文件未改动。

### 对外入口

| 入口 | 地址 | 状态与限制 |
|---|---|---|
| 本机 | `http://127.0.0.1:8080/mcp` | 正常 |
| tailnet（备用） | `http://niumoi.tail117bda.ts.net/mcp` | Tailscale Serve HTTP/80；Muse 官方客户端不支持该 HTTP 入口 |
| 公网 HTTPS（临时） | `https://distinct-wish-invoice-animal.trycloudflare.com/mcp` | Cloudflare quick Tunnel；2026-11-13 验证当日生效，**URL 会随隧道重启变化**，需换命名 Tunnel |

### 安全与运行保障

- 仅监听 `127.0.0.1`；通过 Tailscale Serve / Cloudflare Tunnel 暴露。
- 强制 Bearer Token；缺少 token 时服务拒绝启动。
- 按客户端 IP 限流，默认 600 请求/分钟。
- 服务本身不暴露任意命令执行工具；执行器以显式授权的完整权限运行。
- 自启：用户 Startup 文件夹中的 `AgentWorkbench.vbs` 隐藏运行 `start-workbench.cmd`；非零退出时每 5 秒重启（Task Scheduler 方案因需管理员权限被拒）。
- 服务 PID 写入 `logs/server.pid`。

### 默认调度参数（README 已记录）

全局并发 4、dsh 并发 2、单任务超时 30 分钟、STALE 静默阈值 10 分钟、心跳 15 秒、限流 600 次/分钟。可用 `workbench.env` 覆盖。

---

## D 当前开发进度

| 状态 | 事项 | 说明 |
|---|---|---|
| [DONE] | MCP 核心服务 | initialize、鉴权、8 个工具、任务调度与持久化均已实现 |
| [DONE] | 2026-11-12 验收 | `TESTS.md` 记录 21 项验收通过（含鉴权、工具列表、dsh/claude 任务与续聊、并发、取消、崩溃恢复、tailnet 入口、看门狗、Cloudflare HTTPS、token 轮换） |
| [DONE] | GitHub 首次发布 | 公开仓库（已在 GitHub 页面核实），`main` 分支，基线提交 `be2a86a`（Initial commit，2026-11-13 01:25 CST 提交），27 个追踪文件，工作区干净 |
| [DONE] | 2026-11-13 MCP 在线验证 | `initialize` 返回 200；`tools/list` 返回 8 个工具；`agent_info` 返回的两个执行器符合预期。证据：验证任务 `40d7e908-e68d-4161-8d36-39d414b7d742` |
| [DONE] | 2026-11-13 token 鉴权排障 | 复核 token 来源（仅 `workbench.env` → 进程环境 → `config.token`，无系统环境变量、无任务计划、无硬编码副本）；`workbench.env` 的 token 经本机与公网隧道 `initialize` 均返回 200，无需轮换。定位到 401 真因是 `authorized()` 对 `Authorization` 头做逐字节比较，scheme 大小写或缺少 `Bearer` 前缀即拒绝；已改为忽略 scheme 大小写、容忍空白与裸 token，并新增不泄露 token 的 401 诊断日志。重启后 PID 3980，三种写法本机/公网均 200，错误 token 仍 401 |
| [DONE] | 首次真实派单 | 通过工作台把本项目发布到 GitHub 公开仓库，任务 `c68b9d69-b138-42a7-88e1-401156e50e38`，2026-11-13 01:24–01:25 CST，耗时约 70 秒；claude tokens 输入 35215、输出 6215（单次任务用量，非每日额度余额） |
| [DONE] | 首次派单审核 | 审核任务 `e4753c1f-d077-401c-93de-782c0a853d9c` |
| [DONE] | 阶段一接管初始化 | 创建 `RESUME.md` 与 `DAILY_LOG.md`，提交 `db9999a` 并推送 |
| [DONE] | 阶段一 项目接管 | 接管初始化、GUI 选型与用户确认均已完成 |
| [DONE] | 阶段三 GUI 可行性 | Electron spike 五项全部通过；正式 GUI 工程尚未开始 |
| [DONE] | GUI 技术选型调研 | 2026-11-13 完成 Electron / Tauri 对比，决策文档 `docs/gui-decision.md`；推荐 Electron（引擎复用、单人维护、自动更新成熟），Tauri 作为体积优先时的备选。调研阶段未锁定技术栈；后已由用户确认 Electron |
| [DONE] | GUI 决策文档审核修正 | 2026-11-13 dsh 独立只读审核提出 10 项问题（无高危），已逐项修正：加权总分改为 4.50 / 3.10 并附计算过程与敏感性分析；修正 Electron 安全默认值、Tauri attach/sidecar 同口径、体积比值、权限论证、`ELECTRON_RUN_AS_NODE`、Tauri Ed25519 更新密钥、官方文档链接、Cloudflare URL 口径。推荐结论不变 |
| [DONE] | GUI 技术栈确认 | 2026-11-13 用户确认 Electron；决策文档 `docs/gui-decision.md` |
| [DONE] | Electron GUI spike | 2026-11-13 完成，分支 `spike/electron` @ `ef09762`；五项全通过：引擎启停、`/health` 与任务日志、NSIS 打包（安装包 **119.18 MiB**、解包 386.13 MiB）、GitHub Releases 自动更新（0.0.1→0.0.2）、`ELECTRON_RUN_AS_NODE`（内置 Node 24.21.0 + `node:sqlite` 可用）。结果见 `docs/gui-spike-results.md` |
| [DONE] | dsh spike 文档复核修正 | 2026-11-13 dsh 只读审核（任务 `faf4d74d-3bd6-4e8c-b5c8-1bf588ff3967`）指出 11 项文档问题，结论“Electron 可行”不变。已修正：下载耗时改为缓存命中如实表述、打包版 attach 需 `SPIKE_EXISTING_ENV`、blockmap 字节数、`tools/list` 补证据、`:8080` 只读口径、源码仅存于 spike 分支、Release 可追溯性与未测风险。README 修正提交 `82a4bfd` |
| [DONE] | MVP v0.1 范围确认 | 2026-11-13 用户确认 v0.1 包含/不做/工程基线，正式文档 `docs/MVP_SCOPE.md` |
| [DONE] | MIT LICENSE | 2026-11-13 在 `main` 根目录补充 MIT LICENSE（Copyright (c) 2026 mkmk56） |
| [DONE] | 签名方案确定 | 2026-11-13 14:08 用户最终确认：**暂不签名**（自用 + 小圈子分享，不做公开分发）；SmartScreen 首次安装点一次“仍要运行”即可；以后如需公开分发再考虑 SignPath 免费签名 |
| [DONE] | SignPath 资格预评估（暂缓） | 2026-11-13 曾核对官方条件；若未来公开分发，需可追溯 CI 构建、README Code signing policy、隐私/数据流说明、产品元数据统一与 MFA/角色。该方案已取消，不进入 v0.1；`docs/SIGNING_SIGNPATH.md` 已删除 |
| [DONE] | v0.0.2 测试 Release 保留 | 2026-11-13 13:16 用户决定保留 Release/tag `v0.0.2`；但其产物不可追溯，不作为签名或发布流水线证据 |
| [TODO] | 稳定公网入口 | 将 Cloudflare quick Tunnel 换为命名 Tunnel，获得固定 URL |
| [TODO] | 测试覆盖完善 | 在现有验收脚本基础上补齐自动化与回归覆盖 |
| [TODO] | 文档整理 | 统一 README / TESTS / RESUME 的口径，处理已知文档差异（见 E） |

---

## E 当前遗留问题

1. **[TODO] Cloudflare quick Tunnel URL 临时**
   当前有效入口为 `https://distinct-wish-invoice-animal.trycloudflare.com/mcp`（2026-11-13 验证），会在隧道重启后变化，需要命名 Tunnel + 自有域名才能稳定。当前每次变更都要重新配置 connector。
   （2026-11-13 修正：早前记录的 `https://compete-cab-superintendent-reasonable.trycloudflare.com/mcp` 已失效；quick Tunnel URL 随隧道重启变化，以最新验证记录为准。）

2. **[BLOCKED] Tailscale HTTPS 证书无法签发**
   本机访问 Let's Encrypt ACME（`acme-v02.api.letsencrypt.org`）超时，无法为 tailnet 域名签发 HTTPS 证书。当前 HTTPS 走 Cloudflare Tunnel，tailnet 仅保留 HTTP/80 备用入口；Muse 官方客户端强制 HTTPS，因此 tailnet 入口不可用于该客户端。

3. **[BLOCKED] dsh 无原生续跑（上游限制）**
   `dsh 0.1.0-rc.6` 的 headless 模式不支持 `--resume`；当前由服务端拼接历史实现多轮。`agent_info` 已如实返回 `resume_supported: false`。这不是本项目代码缺陷，但会影响长会话的上下文一致性，需在 GUI 设计时考虑。

4. **[KNOWN_BUG] 历史日志记录过真实 token（执行器检查结论）**
   本地执行器检查 `data/` 时报告历史日志中记录过真实 token（未上传）；该结论来自执行器检查，仓库内无可核验痕迹，分享前仍按已泄露风险处理并轮换 token。
   2026-11-13 复核：`workbench.env` 的 token 与运行进程实际使用值一致（本机与公网 `initialize` 均 200），本次未轮换；历史泄露风险仍按已泄露对待。

5. **[NEEDS_REVIEW] 公开 README 含基础设施信息**
   README 含内网主机名、tailnet 域名、回环地址 `127.0.0.1` 与本地路径。这些属于基础设施信息而非密钥，但公开分享前应评估是否需要脱敏。

6. **[NEEDS_REVIEW] 文档口径不一致**
   - Claude 登录状态：README 自身存在矛盾——一处说明通过内部网关运行、无需 Anthropic 登录，另一处又写 claude 须单独登录。2026-11-13 两次实测 `agent_info`（00:57 原始调用、01:20 connector 调用）均返回 `logged_in=true`；`TESTS.md` 中的 `logged_in=false` 已过时，以实测为准。
   - 任务日志格式：接管材料写作“每任务 JSONL”，实际代码为按行追加的文本 `.log` + `.prompt` + 元数据 JSON。
   - Cloudflare 状态：`TESTS.md` 的“未通过 / 未验证”表写着“未安装 cloudflared、未创建公网入口”，但同文件第 18–20 项已记录 Cloudflare HTTPS 验收通过，且 2026-11-13 正在使用 quick Tunnel。该表已过时，需要整理。
   - `--max-turns`：工具 schema 接受该参数，但 Claude Code 2.1.270 的 `--help` 中没有此参数，实际被忽略。

7. **[长期约束] 额度数据无法直接观测**
   每日额度策略为总额的 10% 上限，但额度消耗无法直接观测；只能按保守估算控制，禁止在文档或汇报中伪造精确数字。

8. **[DECIDED] 自动更新测试 Release 保留**
   2026-11-13 13:16 用户决定**保留**公开 Release/tag `v0.0.2`（安装包 + blockmap + `latest.yml`，约 119 MiB）；删除会移除已安装 0.0.2 的后续更新源，因此不删除。
   复核补充：tag `v0.0.2` 指向 `581725b`，资产由未提交工作区构建（上传于 12:50 CST，spike 源码 13:00:55 CST 才提交为 `ef09762`）；该 Release `isDraft=false`、`isPrerelease=false`，是公开正常发布，任何指向该仓库/更新通道的客户端都能看到。保留不等于其产物可追溯。

9. **[TODO] electron-builder 发布流水线不完整**
   本机执行 `--publish always` 时返回 422（`Published releases must have a valid tag`），Release 虽创建且上传了安装包，但漏传 `latest.yml`/blockmap；本次用 `gh release upload --clobber` 手工补齐。正式发布需在 CI/脚本中校验资产完整性，并调查 422 的重复发布竞态。

10. **[DECIDED] 安装包暂不签名**
    2026-11-13 14:08 用户最终决定：应用自用 + 小圈子分享，不做公开分发，v0.1 **暂不签名**；SmartScreen 首次安装点一次“仍要运行”即可。
    SignPath 已评估并暂缓，不进入 v0.1；若未来公开分发，需要的结论（可追溯 CI 构建、Code signing policy、隐私说明等）记入 `DAILY_LOG.md`，原 `docs/SIGNING_SIGNPATH.md` 已删除。

11. **[RISK] 首次启动引擎耗时明显**
    打包版首次拉起引擎实测 **4,264 ms**（引擎资源 3,670 个文件，冷缓存/Defender 扫描），热启动 264–273 ms。正式产品需评估预启动、减少文件数或安装后预热。

12. **[TODO] GUI spike 运行环境与生命周期覆盖不足**
    - 默认 `:8080` 端口冲突未验证：spike 固定 `18080`，只对 `18080` 做占用预检；正式产品与现有常驻服务冲突如何处理未测。
    - 孤儿引擎只验证“正常停止”：GUI 被强杀/崩溃时是否留下引擎、是否占用 `:8080` 未验证。
    - 未在干净机器、无 Node、非管理员账户环境验证。
    - 双实例并发未测；正式产品需要单实例锁。

---

## F 下一步研发计划

按优先级排列，具体排期以用户确认为准：

1. **P1 GUI 技术栈与 spike（已完成）**
   - [DONE] 调研 Electron 与 Tauri 在 Windows 11、Node.js 22、现有 MCP 引擎复用、安装包体积、权限模型、自动更新、维护成本等方面的差异。
   - [DONE] 产出决策文档 `docs/gui-decision.md`，推荐 Electron，含对比表、风险与下一步。
   - [DONE] dsh 独立审核（只读）提出 10 项问题（无高危），已逐项修正并复算加权总分；推荐结论不变。
   - [DONE] 用户确认 Electron（2026-11-13）。
   - [DONE] 执行 1–2 天 spike（分支 `spike/electron` @ `ef09762`）：引擎启停、`/health`、任务与日志、NSIS 打包、自动更新、`ELECTRON_RUN_AS_NODE` 全部通过；结果见 `docs/gui-spike-results.md`。
   - [DONE] spike 已完成并经 dsh 复核修正；MVP 范围与安全基线已确认（`docs/MVP_SCOPE.md`，2026-11-13）。
   - [DONE] 签名方案已确认：**暂不签名**（自用 + 小圈子分享）；SignPath 已评估并暂缓，不进入 v0.1。
   - [DONE] 创建正式 GUI 工程（与 spike 分离）：分支 `gui/v0.1`，目录 `gui/`，可运行界面壳；未触碰 `spike/electron`。

2. **P1 正式 GUI 工程（进行中）**
   - [DONE] 技术栈落地：Electron 44 + React 19 + TypeScript + Vite + Astryx 0.7.15 + 适配层；品牌主题用 `defineTheme` 在构建期生成静态 CSS，避免运行时 `<style>` 注入与 CSP 冲突。
   - [DONE] 5 屏可运行壳：任务列表、任务详情 + 实时日志、派发、设置、关于；数据为标注的示例数据，引擎相关状态如实显示“未接入”。
   - [DONE] 合并 `assets/branding/`（来自 `design/brand-icon`，未重画图标/字标）。
   - [DONE] 工程基线：数据目录 `app.getPath('userData')`；token 使用 `safeStorage`/DPAPI；单实例；`contextIsolation`/`sandbox`/关闭 `nodeIntegration`；IPC 白名单与可信来源校验；严格 CSP；权限拒绝与导航/新窗口防护。
   - [DONE] 引擎 IPC 对接（2026-11-13）：主进程 `EngineManager` 接管引擎生命周期与 MCP 传输，渲染进程不接触 token/网络；5 屏全部改用真实数据；共 16 个白名单 IPC（原 6 + 新增 10）。真实任务派发、日志轮询、跟进与二次确认取消已端到端验证；`/health` 不可达时界面如实显示 `lastError`，不静默失败。
   - [DONE] GitHub Actions 发布流水线（2026-11-13）：`.github/workflows/release.yml` 在 `windows-latest` 构建 NSIS，强制校验安装包 + blockmap + `latest.yml`（构建目录与 Release 下载后各一次），任一缺失或字节不一致即失败；产物上传 Actions Artifacts，并支持 tag 触发与手动触发。rc.1 / rc.2 两次真实运行通过（约 2 分钟/次），详见 `docs/RELEASE_PIPELINE.md`。
   - [DONE] 自动更新（2026-11-13）：设置页/关于页接入 electron-updater 状态机（检查、下载、安装）、稳定/预发布通道与真实进度；rc.1 → rc.2 实机验证检查、下载、静默安装、新版本启动全部通过；清缓存完整下载经代理 14.6 s、安装完成 37.5 s，无需手动干预；差分更新仅下载 800,228 B。
   - [NEXT] 日志虚拟列表、设置页非凭据配置持久化。当前引擎若由外部脚本启动，GUI 只 attach、不接管生命周期，界面会如实标注。
   - [TODO] 正式 v0.1 Release 待 IPC 与流水线稳定后由用户确认；v0.1 暂不做代码签名。
   - [TODO] 现有 `v0.0.2` 按用户决定保留（E-8），但其产物不可追溯；正式发布一律走 tag → CI 构建，不从工作区直接发布。

3. **P1 稳定公网入口**
   - 配置 Cloudflare 命名 Tunnel（需自有域名），替换 quick Tunnel，获得固定 HTTPS URL。
   - 更新 connector 配置与 README 部署说明。

4. **P2 完善测试覆盖**
   - 在 `scripts/test-*.mjs` 基础上补充回归用例，覆盖鉴权、并发、取消、崩溃恢复、双执行器与续聊。
   - 保持 TESTS.md 与实际结果同步，避免再次出现状态表互相矛盾。

5. **P3 文档整理**
   - 统一 README / TESTS / RESUME / DAILY_LOG 的事实口径。
   - 处理 E-5、E-6 中的基础设施信息与文档差异。

> 额度控制：每日不超过总额的 10%，数据无法直接观测，按保守估算执行。接管当天只做文档初始化，不启动新的开发任务。

---

## G GitHub 同步状态

- 仓库：https://github.com/mkmk56/agent-workbench
- 可见性：公开（已在 GitHub 页面核实）
- 默认分支：`main`
- 接管前基线：`be2a86a` — `Initial commit: local MCP agent workbench server`
- 基线提交时间：2026-11-13 01:25 CST
- 基线追踪文件：27 个
- 接管前工作区：干净
- 本地被忽略目录：`data/`、`logs/`、`node_modules/`、`bin/`、`.certs-test/`、`workbench.env`

本次接管新增 `RESUME.md` 与 `DAILY_LOG.md`，以一次提交推送到 `origin/main`。接管提交为 `db9999a`（`docs: add project takeover status and daily log`）；接管后续修正提交为 `2f04f2e`（`docs: correct takeover records and status details`）；GUI 决策修正提交为 `581725b`（`docs: address GUI decision review findings`）。

2026-11-13 Electron spike：
- `main` 分支：`394500e`（`docs: record Electron GUI spike results`）已推送；本次 dsh 复核修正的提交 hash 以 `git log -1` 与任务汇报为准（本文件无法记录自身所在提交的 hash）。
- spike 分支 `spike/electron`：`ef09762`（原型）→ `82a4bfd`（README 引擎隔离口径修正）→ `56904d2`（接入 Converge 品牌图标与 NSIS 图标），已推送到 `origin/spike/electron`（经系统代理 `127.0.0.1:7897`）。
- **源码仅存于 `spike/electron` 分支提交**（`package.json`、`main.js`、`preload.cjs`、`renderer/`、`scripts/`）；`main` 工作区没有这些源文件，只有被忽略/未跟踪的 `spike/electron/artifacts/`、`release/`、`node_modules/`。
- `spike/electron/.gitignore`（`node_modules/`、`release/`、`artifacts/`、`.tmp/`）只存在于 spike 分支；在 `main` 上这些目录是普通未跟踪项，**不进入主线**。
- `main` 分支仅新增/修改文档：`docs/gui-spike-results.md`、`docs/gui-decision.md`、`RESUME.md`、`DAILY_LOG.md`；未修改 `src/`、`start-workbench.cmd` 等核心服务代码。
- 2026-11-13 MVP/许可更新（`main`）：新增根目录 `LICENSE`（MIT）、`docs/MVP_SCOPE.md`，并更新 `RESUME.md` / `DAILY_LOG.md`；提交 `7dc4474`。未修改 `src/`、`spike/electron`、`design/brand-icon`。
- 2026-11-13 签名口径纠正（`main`）：提交 `9e4ba3c` / `1800683` 中关于 SignPath 的记录**作废**；`docs/SIGNING_SIGNPATH.md` 已删除，`docs/MVP_SCOPE.md` / `RESUME.md` / `DAILY_LOG.md` 统一为“暂不签名”。本次纠正提交 hash 以 `git log -1` 与任务汇报为准。推送经系统代理 `127.0.0.1:7897`，推送后用 `git ls-remote` 核对远程 HEAD。
- 实测数据与本机证据（`artifacts/`、`release/`）不提交。
- 并发状态：`design/brand-icon` 分支 `62957d8`（`design: add brand icon assets, design system and brand guidelines`，含 `assets/branding/**`、`docs/BRAND_GUIDELINES.md`、`docs/DESIGN_SYSTEM.md`）已提交但**未合并 main**；本次修正期间本地主工作区被切到 `spike/electron`，并有未提交的品牌图标接入改动（`main.js`、`package.json`、`renderer/` 等），本次未触碰。

---

## H 最终交付状态

- **最终交付目标**：可安装的图形界面桌面软件，MCP 服务器作为核心引擎；用户可在本机管理执行器、任务、日志与配置，并通过稳定入口接受云端编排端派单。
- **当前交付形态**：本地 MCP 引擎已可用并通过验收；公网入口可用但为临时 URL；GUI 技术栈已确认 Electron，spike 已完成并全部通过；MVP v0.1 范围与工程基线已确认，正式 GUI 工程尚未开始；v0.1 暂不签名（自用 + 小圈子分享）。
- **整体状态**：[IN_PROGRESS]
- **阶段一（项目接管）**：[DONE]
  - 接管初始化（长期记忆文件 + 每日日志 + 首次同步）：[DONE]
- **阶段二（GUI 技术选型）**：[DONE]
  - GUI 选型调研：已完成，决策文档 `docs/gui-decision.md`，推荐 Electron
  - GUI 技术栈确认：用户已确认 Electron（2026-11-13）
- **阶段三（GUI 可行性）**：[DONE]
  - Electron spike：全部 5 项通过，结果见 `docs/gui-spike-results.md`
- **阶段四（GUI 产品化）**：[IN_PROGRESS] 准备中
  - MVP v0.1 范围与工程基线已确认（`docs/MVP_SCOPE.md`，2026-11-13）
  - 签名方案：**暂不签名**（自用 + 小圈子分享，SmartScreen 首次安装点“仍要运行”）；SignPath 已评估并暂缓，不进入 v0.1
  - 正式 GUI 工程尚未创建。品牌资产已在 `design/brand-icon` 分支 `62957d8` 准备（图标/logo/设计规范），spike 分支 `56904d2` 已接入图标，但均未合并 `main`，不代表正式 GUI 工程已启动
- **当前可用性结论**：8 个 MCP 工具可用，claude 与 dsh 均可执行任务；claude 支持原生续跑，dsh 依赖服务端历史拼接；Muse connector 已连通；首次真实派单已成功完成。
- **下一次会话入口**：先读本文件与 `DAILY_LOG.md` 最新日期区块，再用 `agent_info` 复核执行器状态，然后按 F 节优先级推进。签名方案以“暂不签名”为准；历史 SignPath 记录已作废。

---

## I Agent HUD 第一期：引擎内 agent 互发消息（2026-11-14）

> 本节为追加记录，不改写上文历史。上文 C/D 节“8 个 MCP 工具”描述的是生产 `:8080` 当前运行的旧代码；本节记录 `gui/v0.1` 分支上的新引擎代码。本阶段只改引擎，不碰 GUI、签名与审批。

### I.1 范围与状态

- **范围**：只修改 `src/` 与验证脚本 `scripts/verify-agent-messages.mjs`；未修改 `gui/`、`spike/`、签名配置或审批机制（审批仍为全自动/关闭）。未删除文件，未做破坏性 git 操作。
- **代码状态**：[DONE] 已实现并在隔离引擎 `127.0.0.1:18091` 上完成真实 claude + dsh 端到端验证。
- **生产状态**：[PENDING] 生产 `:8080` 仍运行旧代码（本次任务进程由该引擎拉起，任务内重启会杀死自身）。需在任务外重启引擎后，`send_message` / `list_messages` 才在生产入口可用。
- **分支与提交**：`gui/v0.1`；引擎提交 `f121f0b` 已推送到 `origin/gui/v0.1`，远程 HEAD 已核对。本文件与 `DAILY_LOG.md` 的文档提交随后推送。

### I.2 引擎改动

- **claude 连接本地 MCP**：启动参数新增 `--mcp-config <data/claude-mcp.json>`；配置由 `src/mcp-config.js` 原子写入（临时文件 + rename），内容为 `http://127.0.0.1:<port>/mcp` + Bearer token。POSIX 上以 mode `0600` 写入；Windows 上 Node 的 `mode` 不生效，生成时用 `icacls` 移除继承并仅授权当前用户、`SYSTEM` 与 `Administrators`（临时文件先收紧再 rename）。服务启动时写一次，每次 claude 启动前重写。配置位于 gitignored 的 `data/`，不提交、不打印 token。
- **环境变量**：`src/executors/process.js` 不再删除子进程的 `MCP_*` / `WORKBENCH_*`，执行器可继承服务端环境与本地 MCP 配置。
- **新工具**：`send_message` 与 `list_messages`；代码中工具总数为 10 个（生产重启前仍为 8 个）。
- **持久化**：SQLite 新增 `threads`、`task_threads`、`messages` 表；`message_id` 由服务端生成 UUID；`reply_to` 有唯一索引，一条消息最多一个回复；消息与线程状态可查询、重启后保留。
- **结论体**：`{summary, files, question}`；`summary` 默认 500 tokens 上限，采用保守估算（CJK 每字 1 token，其他每 4 字符 1 token），超限截断并记录 `summary_truncated`；`files` 最多 100 项。
- **交换上限**：同一线程内 agent-to-agent 连续消息默认 10 条；第 10 条写入为 `held`，线程进入 `WAITING_USER`，`task_status` / `list_messages` 暴露 `waiting_for_user: true`；第 11 条 agent 消息被拒绝；用户消息重置计数为 0 并恢复 `ACTIVE`。发给 `user` 的最终报告不计入上限；默认 `deliver`（true）下在 `WAITING_USER` 中也写入为 `stored`，不再被误标 `failed`（2026-11-14 修正 B1）。
- **自动投递**：目标 agent 空闲时创建任务（续用线程内该 agent 最近的 session），忙碌时置 `queued`；任务结束后处理队列。dsh 没有 MCP 客户端，其回复从任务最终结果中的 `<agent_reply>{...}</agent_reply>` JSON 解析；任务若自己调用了 `send_message`，以实际消息为准，避免重复回复。
- **提示词占位符**：`{{task_id}}`、`{{session_id}}`、`{{thread_id}}`、`{{agent}}` 在任务启动时渲染，存储的 prompt 保持可复用。
- **配置项**：`AGENT_MESSAGE_LIMIT`（默认 10）、`AGENT_SUMMARY_MAX_TOKENS`（默认 500）、`AGENT_AUTO_DELIVER`（默认 1，设为 `0` 关闭自动投递）。

### I.3 评审回路与修正

- **流程已验证**：claude 任务通过 `send_message` 向 dsh 发出结论；dsh 任务收到消息卡并通过 `reply_to` 回复 review；回复自动投递给 claude revision 任务；revision 任务完成并再次通过 `send_message` 回复。全程无用户介入。
- **dsh 第一轮发现**：`held` 消息没有任何重试/失败路径；且回复被写成 `held` 时仍把原消息标为 `answered`；`attemptDelivery` 在非 `ACTIVE` 线程上写 `held` 形成死状态。已修正：只有非 `held` 回复才标 `answered`；非 `ACTIVE` 线程的投递改为 `failed` 并记日志；`onTaskFinished` 改用状态感知的回复查询，只有 `delivered/stored/queued` 回复才把原消息标为 `answered`，`held/failed` 记日志但不标。
- **dsh 第二轮发现**：`onTaskFinished` 的 `taskHasReplyFrom` 仍会把 `held` 回复算作 answered；另指出“达到上限时发给 user 的消息也会被 held”。已修正并纳入协议回归验证（对 user 报告在 `WAITING_USER` 下成功写入、计数不变；第 9 条在 10 条 held 后保持 `stored`）。
- **dsh 独立评审必须修项（2026-11-14）**：B1 调整 `attemptDelivery()` 判断顺序，非 agent 收件人先按 `stored` 处理，发给 `user` 的报告在默认 `deliver` 下不再因 `WAITING_USER` 被标 `failed`；回归脚本改为不传 `deliver` 并断言 `status === 'stored'`。B2 `src/mcp-config.js` 在 Windows 上用 `icacls` 移除继承并仅保留当前用户 / `SYSTEM` / `Administrators`，POSIX 仍 chmod `0600`；已有含真实 token 的 `data/mcp-probe/config.json` 与历史日志已按同一 ACL 收紧。评审的非阻塞项（N1–N8）本期不扩范围处理。
- **未采纳的建议**：dsh 建议“用户恢复时把 held 消息重排投递”。本期将 held-at-cap 视为可见终态（`list_messages` 可查），用户恢复后不自动重放，避免用户刚恢复就再次消耗额度；后续如需保留该结论，可改为重排或由用户显式触发。
- **说明**：revision 任务是只读协议测试，未授权改文件；上述修正由实现方在评审后完成，并用协议回归重新验证。

### I.4 验证证据（隔离实例，不触碰生产）

- **隔离环境**：`127.0.0.1:18091`，独立 `MCP_DATA_DIR` / `MCP_DB_PATH` / `MCP_LOG_DIR`，随机 48 字符 token；生产 `:8080` 仅做只读健康检查。所有测试实例在结束后关闭。
- **真实流最终运行**：`data/agent-hud-verify-20261113193005/verify-result.json`（`ok: true`）
  - claude 任务 `c9c136b4-89f6-4a1d-bdd9-676aed549df0`，`COMPLETED`，tokens 输入 5686 / 输出 432；MCP init 报告 `agent-workbench: connected`；实际调用 `mcp__agent-workbench__send_message` 与 `agent_info`；服务端记录 `tools/list` 3 次、`tools/call` 56 次。
  - 消息 1 `bd32c451-7622-4134-a448-7c31b43217fb`：claude→dsh，`reply_to: null`，37 tokens，投递到 dsh 任务 `00607ace-f783-49a0-8560-acad18be4cf2`（`COMPLETED`）。
  - 消息 2 `50f4c445-a446-40dd-8d45-cf81e362c1d0`：dsh→claude，`reply_to` = 消息 1，241 tokens，投递到 claude revision 任务 `a04547df-4eb8-4ab7-ab0a-daae4addfcce`（`COMPLETED`）。
  - 消息 3 `6c1f1dca-2775-446f-97d6-5898fe48b93f`：claude→dsh，`reply_to` = 消息 2，199 tokens，投递到后续 dsh 任务 `cf3a3a3d-e8b6-416a-b086-b976fc49e936`；测试清理时取消该后续任务，不影响三段链。
  - 线程 `ACTIVE`，`exchange_count: 3`。
- **协议回归最终运行**：`data/agent-hud-verify-20261113193307/verify-result.json`（`ok: true`）
  - 上限线程 `ea00be09-5151-4ad3-b095-578a4d29e71b`：10 条 agent 消息；第 10 条 `held`；线程 `WAITING_USER`，`waiting_for_user: true`；第 11 条被拒绝，错误为“waiting for user input; send a message from user to resume”。
  - 第 9 条在第 10 条 held 后保持 `stored`，不再误标 `answered`；对 user 的最终报告写入成功（`stored`），`exchange_count` 保持 10；用户消息把计数重置为 0 / `ACTIVE`，下一条 agent 消息计数为 1。
  - 截断：消息 `a0550e3d-0ac0-44be-9859-d0259ad1dc4b`，`summary_tokens: 500`，`summary_truncated: true`，存储 2000 字符。
  - 持久化：重启前后均为 13 条消息，`reply_to` 链完整，线程状态保留。
- **评审原文证据（较早真实流）**：`data/agent-hud-verify-20261113192546`，消息 `383e13c1-410d-4b28-ac3b-087bab190689` → `1a8adcad-b310-4b74-94d0-b40dc5d59890`（500 tokens，已截断）→ `9bff8e95-db86-45a8-a1bf-254eacee2f12`（`is_final: true`），dsh 在该轮指出 held/answered 问题。
- **服务端日志**：`data/agent-hud-verify-20261113193005/server.log` 第 1 行记录 claude MCP 配置路径，第 4 行监听 18091；`MCP tools/list` 出现 3 次，`MCP tools/call` 多次；未记录 token 或参数。
- **B1/B2 修正回归（2026-11-14）**：隔离实例 `127.0.0.1:18097`，`VERIFY_SKIP_AGENTS=1`，未调用 agent LLM。结果 `data/agent-hud-verify-20261114003514/verify-result.json`（`ok: true`）：默认 `deliver` 的 user 报告为 `stored`、`error: null`、`exchange_count: 10`、`waiting_for_user: true`；第 10 条仍 `held`、第 11 条仍被拒、用户消息重置为 0/`ACTIVE`、重置后计数为 1；重启前后 13/13 条。探针汇总写在 `data/review-phase1/fix-user-report-20261114003514/probe-result.json`（新目录，未覆盖 dsh 的探针）。
- **B2 ACL 实测**：隔离实例生成的 `claude-mcp.json` 的 Node `mode_octal` 仍为 `666`（Windows 忽略 `mode`），`Get-Acl` / `icacls` 显示仅 `NT AUTHORITY\SYSTEM`、`BUILTIN\Administrators`、`NIUMOI\yikai` 为 FullControl，继承权限已移除，`BUILTIN\Users` / `Authenticated Users` 不再出现。`data/mcp-probe/config.json` 与含当前 token 的历史日志 `data/c68b9d69-…log` 已同样收紧。

### I.5 已知限制与后续

- 生产 `:8080` 未重启，新工具尚未上线；重启需在任务外进行（当前任务由该引擎拉起）。
- dsh 无 MCP 客户端，自动回复依赖最终输出解析；输出格式异常时回退全文或失败。
- token 估算为保守上界，不等同于真实 tokenizer；非 CJK、非拉丁文字可能被低估（dsh 评审的非阻塞项）。
- held-at-cap 不自动重放；用户恢复后仍可在 `list_messages` 中查看。
- 额度消耗无法直接观测；本日只做隔离验证与少量真实流，不记录虚构百分比。
- 运行时生成的 `data/claude-mcp.json`（或对应 `MCP_DATA_DIR` 下的同名文件）含真实 token，位于 gitignored `data/`；POSIX 上 mode `0600`，Windows 上 Node `mode` 不生效，实际由 `icacls` ACL 限制为当前用户 / `SYSTEM` / `Administrators`。不得提交或打印。

### I.6 评审必须修项修正（2026-11-14）

- **范围**：只修 dsh 独立评审（`docs/AGENT_HUD_PHASE1_REVIEW.md`）的两个必须修项 B1、B2；未改评审文件、GUI、侧栏、纸飞机、结论卡 UI、审批或签名；审批仍为全自动/关闭。
- **B1**：[DONE] `src/messages.js` 的 `attemptDelivery()` 先判断收件人是否为 agent，非 agent（`user`）直接置 `stored`，再检查线程状态。默认 `deliver` 下 `WAITING_USER` 线程中的 user 最终报告现为 `stored`，`exchange_count` 保持 10；第 10 条 `held`、第 11 条被拒、用户重置等行为不变。回归脚本 `scripts/verify-agent-messages.mjs` 已去掉 user 报告的 `deliver:false`，改为默认 `deliver` 并断言 `stored`。
- **B2**：[DONE] `src/mcp-config.js` 在 Windows 上改用 `icacls`：临时文件写入后先 `/inheritance:r` 并仅授权当前用户、`SYSTEM`、`Administrators`，再原子 rename，rename 后再收紧一次；当前用户无法解析时在写 token 前失败。POSIX 继续 `chmod 0600`。已有含真实 token 的 `data/mcp-probe/config.json` 与历史日志 `data/c68b9d69-…log` 已按同一 ACL 收紧；两者均被 `.gitignore` 的 `data/` 覆盖、未被 git 跟踪、内容未打印。生产路径 `data/claude-mcp.json` 仍未生成（生产引擎未重启）。
- **证据**：`data/agent-hud-verify-20261114003514/verify-result.json`（`ok: true`）与 `data/review-phase1/fix-user-report-20261114003514/probe-result.json`；B2 ACL 由 `Get-Acl` / `icacls` 在本机核实。
- **明确未做**：评审 N1–N8 非阻塞项未处理；未复跑 `f121f0b` 上的真实 claude↔dsh 往返（N2 建议，本期验收只要求 B1/B2，且控制额度）；生产 `:8080` 未重启。
- **提交**：`src/messages.js`、`src/mcp-config.js`、`scripts/verify-agent-messages.mjs`、`RESUME.md`、`DAILY_LOG.md` 随后提交并推送到 `origin/gui/v0.1`；提交 hash 以 `git log -1` 与任务汇报为准。
- 未做 GUI/sidebar/纸飞机动画/结论卡/审批；未改签名；v0.1 仍不签名。

---

## J Agent HUD 第一期真实效果演示（2026-11-14）

> 本节为追加记录，不改写上文历史。演示只使用真实消息，不编造内容。

### J.1 生产环境状态

- 生产引擎 `127.0.0.1:8080` 已于 2026-11-14 11:53 重启（PID 21568，`/health` 返回 ok）。
- `agent_info` 实测返回 `message_protocol.enabled: true`、`exchange_limit: 10`、`summary_max_tokens: 500`、`auto_deliver: true`；`send_message` / `list_messages` 在生产入口可用。

### J.2 真实往返

- 演示任务 `cabe7c6a-718c-4aa0-8ec6-676e40d30ce6`（claude，本会话）通过 `send_message` 向 dsh 发送 B1 修复的评审结论。
- dsh 由引擎自动投递任务 `e3b9e909-a8d3-40dc-8e28-df2c0a1dd34c`（COMPLETED，122.9 s），其最终结果中的 `<agent_reply>` 带 `done: true`；引擎据此写入回信且不再投递下一轮，正好一轮往返。
- 消息链：
  - `9d339998-8b66-4f58-bdaf-b386cb599cde`：claude→dsh，`reply_to: null`，98 tokens，`status: answered`，创建于 `2026-11-14T04:31:04.302Z`（12:31:04 CST）。
  - `cd9f8040-00e5-4cb4-a1a6-3a0537ddbfef`：dsh→claude，`reply_to: 9d339998-8b66-4f58-bdaf-b386cb599cde`，299 tokens，`status: stored`，`is_final: true`，无投递任务，创建于 `2026-11-14T04:33:07.189Z`（12:33:07 CST）。
- 线程 `cabe7c6a-718c-4aa0-8ec6-676e40d30ce6`：`ACTIVE`，`exchange_count: 2 / 10`，`message_count: 2`，`waiting_for_user: false`；两条 summary 均未截断。

### J.3 效果图产物

- HTML：`docs/phase1-demo.html`。品牌色 Ink `#1E2126`、Paper `#F5F3EE`、信号橙 `#E85D26`；内容为往返时序图、两条消息卡（发送方、内容、token、时间、`reply_to` 连线）、协议要点（10 条上限、500 token、`reply_to` 线程）；无渐变、发光、玻璃拟态或 emoji 图标。
- PNG：`docs/phase1-demo.png`，真实浏览器截图（gstack headless Chromium，1027×2000，约 508 KiB），console 无错误。截图命令：`browse goto file:///.../docs/phase1-demo.html` → `viewport 1280x900 --scale 2` → `screenshot`。

### J.4 范围与额度

- 未改 `src/`、协议、GUI、`spike/`、签名与审批；未删除文件；未触碰 `docs/AGENT_HUD_PHASE1_REVIEW.md`。
- 本次只消耗 1 个 dsh 任务真实调用（122.9 s）；额度消耗无法直接观测，不记录虚构百分比。
- 提交与推送：分支 `gui/v0.1`；推送使用单条命令临时 `-c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897`，未改全局 git 配置；文档提交 hash 以 `git log -1` 与任务汇报为准。

---

## K 引擎执行器命令解析根治：不再缓存 claude / dsh 路径（2026-11-14）

> 本节为追加记录，不改写上文历史。根因采用调查任务 `d9c4ac81-d421-4a6b-991c-0113eacd7ae5` 的结论，本次未重复调查。

### K.1 事故与根因

- 2026-11-14 12:34:59 npm 全局升级把 `D:\workbuddy-tools\node\global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（2.1.270）改名为 `claude.exe.old.<ms>`，新版 2.1.325 装到另一个 npm 前缀 `D:\nodejs`；workbuddy 树从此缺 `bin\claude.exe`。
- 引擎（PID 21568，11:53:24 起未重启）`src/config.js` 在模块加载时用 `existsSync` 解析一次并永久缓存 `claudeEntry`；升级后所有 claude 任务都 spawn 那个已消失的绝对路径，瞬间 ENOENT。
- 同类隐患：`dshEntry` 也是启动时快照。当前 dsh 的 `lib\bin.js` 仍存在，所以 dsh 还能跑；一旦 dsh 升级换前缀，会以同样方式全挂。

### K.2 代码改动（`gui/v0.1`）

| 文件 | 改动 |
|---|---|
| `src/config.js` | 删除模块加载时的 `claudeEntryCandidate` / `dshEntryCandidate` 与 `config.claudeEntry` / `config.dshEntry` 快照；新增 `nodePrefix`（第 20–22 行）与 `CLAUDE_ENTRY_SEGMENTS` / `DSH_ENTRY_SEGMENTS`（24–25 行）；第 62–180 行新增候选列表 `claudeCommandCandidates()`（103）、`dshCommandCandidates()`（119）、惰性解析 `resolveExecutable()`（135）、`resolveClaudeCommand()`（157）、`resolveDshCommand()`（161）与单行日志 `describeResolution()`（166） |
| `src/executors/claude.js` | 第 1 行引入解析函数；第 22–33 行 `start()` 每次任务启动时解析、写日志、spawn 使用解析出的绝对路径；未命中时抛明确错误 |
| `src/executors/dsh.js` | 第 1 行引入解析函数；第 32–45 行同样改为每次启动解析（JS 入口仍用当前 Node 执行 `bin.js`），spawn 命令与 prefixArgs 均来自解析结果 |
| `scripts/verify-command-resolution.mjs` | 新增只读验证脚本：断言无快照字段、按序解析、死路径被跳过、每次调用重新读取环境/文件系统 |

### K.3 解析顺序（每次任务启动按序探测，命中即用）

claude：
1. `WORKBENCH_CLAUDE_ENTRY`（若设置）；
2. `WORKBENCH_CLAUDE_BIN`（若设置，按 PATH / 绝对路径解析）；
3. `WORKBENCH_NPM_GLOBAL`（默认 `D:\workbuddy-tools\node\global`）下 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`；
4. 运行中 Node 的 npm 前缀 `dirname(process.execPath)` 下同一路径（当前即 `D:\nodejs`）；
5. `claude` 走 PATH（按 PATHEXT 探测，当前命中 `D:\nodejs\claude.cmd`）。

dsh：
1. `WORKBENCH_DSH_ENTRY`（经当前 Node 执行）；
2. `WORKBENCH_DSH_BIN`（若设置）；
3. `WORKBENCH_NPM_GLOBAL` 下 `node_modules\@deepseek-ai\dsh\lib\bin.js`；
4. 运行中 Node 前缀下的同一路径；
5. `dsh` 走 PATH。

全部未命中时任务以 `failed to start: ...` 结束，并在日志里列出尝试过的全部路径。

### K.4 任务日志

每次启动执行器写一行 system 日志（不含 token），例如：

- `claude command=D:\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe source=npm-prefix D:\nodejs; skipped missing: D:\workbuddy-tools\node\global\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
- `dsh command=D:\nodejs\node.exe D:\workbuddy-tools\node\global\node_modules\@deepseek-ai\dsh\lib\bin.js source=npm-prefix D:\workbuddy-tools\node\global`

路径哪天再次消失，从这行日志即可定位。

### K.5 静态验证（未重启生产）

- `node --check`：`src/config.js`、`src/executors/claude.js`、`src/executors/dsh.js`、`scripts/verify-command-resolution.mjs` 全部通过。
- `node scripts/verify-command-resolution.mjs` → `ok: true`（输出保存于 gitignored `data/verify-command-resolution.json`）：
  - claude 解析到 `D:\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（source `npm-prefix D:\nodejs`），`--version` 为 **2.1.325 (Claude Code)**；
  - workbuddy 死路径 `...\@anthropic-ai\claude-code\bin\claude.exe` 出现在 `skipped`，且 skipped 中每个路径都确实不存在；
  - dsh 解析到 workbuddy 的 `lib\bin.js`（经当前 Node 执行），`--version` 为 **0.1.0-rc.6**；
  - 惰性证明：把 `WORKBENCH_CLAUDE_ENTRY` 设为不存在路径 → 被跳过；设为 `process.execPath` → 无需重启立刻采用；清空后回到原命令；
  - 本机工具沙箱禁止管道 stdio，脚本改用临时文件承接子进程输出来读取版本号（不是代码缺陷）。
- 直接 shell 复核：`D:\nodejs\claude.cmd --version` 与 `D:\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe --version` 均为 2.1.325。

### K.6 提交与推送

- 分支 `gui/v0.1`；提交内容：3 个源文件 + 验证脚本 + 本文件与 `DAILY_LOG.md`。
- 推送使用单条 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push`；未改全局 git 配置；命令、文档与日志中无 token。
- 提交 hash 以 `git log -1` 与任务汇报为准。

### K.7 重启：任务内无法直接杀引擎，已安排引擎侧延迟重启

- 实测本任务的工具沙箱把每次调用放进 `KILL_ON_JOB_CLOSE` 的 Job 对象（`LimitFlags=0x2000`，不允许 breakaway）：`Start-Process` 子进程在调用结束即被回收；`explorer.exe` 打开文件、`ShellExecute` COM、`schtasks`、WMI 均不可用；`taskkill.exe` 被拒绝（`Stop-Process` 可用）；升级 `danger-full-access` 需要审批而该 composition 没有审批通道。
- 因此无法按“独立 PowerShell 进程延迟 20 秒”实现。已安排的替代方式：任务结束前通过引擎 `send_message` 排队一条 `from=user → to=dsh`、`is_final=true` 的维护消息（`525e8e94-e0e9-471f-8c1d-2bb028b393df`，`status=queued`，298 tokens）。引擎在本任务终止时经 `onTaskFinished → processQueuedDeliveries` 自动把它投递成新的 dsh 任务；该任务执行 `Start-Sleep 20` 后，仅当 `logs/server.pid` 仍为 `21568` 时执行 `Stop-Process -Id 21568 -Force`，随后由 Startup 文件夹的 `AgentWorkbench.vbs` 看门狗在约 5 秒内用新代码拉起引擎。
- 不确定性（如实记录）：投递顺序由引擎保证，但后续任务是否按指令执行取决于 dsh agent；`Stop-Process` 终止沙箱外引擎进程的权限未能在沙箱内验证。若未生效，手动兜底（普通权限即可，无需管理员）：
  `powershell -NoProfile -Command "$p=(Get-Content 'D:\Claude\agent-workbench\logs\server.pid' -Raw).Trim(); Stop-Process -Id ([int]$p) -Force"`（或在任务管理器结束 PID 21568），看门狗会自动重启。
- 重启后应验证：`/health` 返回 `ok:true` 且 `uptime_s` 重新计时、`logs/server.pid` 变化、`tools/list` 仍为 10 个工具、`agent_info` 的 claude `available=true`/2.1.325、派一个 claude 小任务确认能启动，并检查新 claude 任务日志第一行是否为 `resolved claude command=D:\nodejs\... source=npm-prefix D:\nodejs`。重启恢复期间可能出现一个 `FAILED` 的 dsh 维护任务，属于预期的投递任务。

### K.8 明确未做

- 未升级 Node；未往 workbuddy 前缀重装 claude；未删除 `claude.exe.old.*` 残留；未改 GUI、`spike/`、签名与审批；未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`；未删除任何文件。
- 未改 `src/` 其他逻辑；`scheduler.agentInfo()` 仍用 `claudeBin`/`dshBin`（PATH 解析）做版本/登录探测，本次未调整。
- 额度消耗无法直接观测，不记录虚构百分比；本次额外排队 1 个 dsh 维护任务（短指令）。

---

## L Agent HUD 第二期：引擎聊天式审批（默认关）（2026-11-14）

> 本节为追加记录，不改写上文历史。本期只做引擎审批机制；GUI、侧栏、纸飞机、结论卡片界面、设置页 UI 属第五期，本次未做。

### L.1 范围与状态

- **代码状态**：[DONE] 已在隔离引擎上完成协议级端到端验证，未调用任何 agent LLM。
- **分支与提交**：`gui/v0.1`；引擎、验证脚本与文档提交 `e7b05f4`（`feat(engine): add chat approval gate for critical operations`）。本文件与 `DAILY_LOG.md` 的文档提交随后推送，hash 以 `git log -1` 与任务汇报为准。
- **默认值**：`AGENT_APPROVAL_GATE=0`（关闭）。关闭时 `request_approval` 立即返回 `allowed:true, decision:"disabled", asked:false`，不写消息、不等待、不改线程状态；执行器提示词与环境与第一期完全一致。
- **生产状态**：[PENDING] 生产 `:8080` 仍运行旧代码，未在任务内重启；新工具与门逻辑需在任务外重启后上线。
- **输入口径**：用户指定的计划文件 `~/workspace/goals/multi-agent-workbench-on-home-pc/files/agent-hud-schedule/agent-hud-schedule.md` 在本机不存在（已搜索 `C:\`、`D:\`）；本期按用户任务中的逐项要求与 `D:\Claude\muse-hud-requirements.md` §4.4 实施，并已在该需求中确认“聊天里问、不弹审批卡片、默认关闭”。

### L.2 关键操作清单（代码与文档同源）

清单定义在 `src/approvals.js` 的 `APPROVAL_CATEGORIES`，完整边界见 `docs/AGENT_HUD_APPROVAL.md`：

| 类别 | 需要审批（核心） | 不需要审批（边界示例） |
|---|---|---|
| `merge` 合并代码 | `git merge` / `rebase` / `cherry-pick`；`git push`（含 force / tags）；会产生 merge/rebase 的 `git pull`；`gh pr merge` | `git fetch`、`git pull --ff-only`、`status/diff/log`、`add` / `commit`、建/切分支、`stash push/pop`、已 push 后开 PR、单提交 `revert` |
| `delete` 删文件 | `rm` / `del` / `Remove-Item` 等；`git rm`、`git clean -fd`、`git reset --hard`、`checkout --` / `restore`；`stash drop/clear`、删分支/标签、`push --delete`；整文件截断/覆盖；`DROP/TRUNCATE`、无 WHERE 的 `DELETE` | `node_modules/`、`dist/`、`build/`、`out/`、`coverage/`、`.cache/`、`tmp/`、`temp/`、系统临时目录；当前任务自建的临时文件；编辑器正常修改；`stash push/pop`、带 WHERE 的普通行删除 |
| `dependencies` 装依赖 | `npm install <pkg>` / uninstall / update / audit fix；pnpm/yarn/bun/pip/poetry/uv/cargo/go/dotnet/composer/gem/winget/choco/scoop 的安装/移除/升级；修改依赖声明或 lockfile | `npm ci` 与 `--frozen-lockfile` 安装；`npm test`、`npm run <script>`、`npx`；`npm ls` / `outdated` / `pip list`；读取 manifest；改 `package.json` 非依赖字段 |

> 边界有争议时按更严格的一侧处理：不确定是否属于关键操作，就问。

### L.3 提问与回复流程

- **工具**：新增 `request_approval`（agent 用）、`respond_approval`（用户用）、`list_approvals`（审计/查询）；工具总数从 10 个变为 13 个。
- **提问**：`request_approval` 通过第一期 `messages` 表写入一条 `from=agent, to=user, status=stored` 的消息，`reply_to=null`；`summary` 以 `[Agent HUD · 来自 <agent> · <task> <message-id>] 关键操作需要你的批准` 开头，正文含类别、想做什么、命令、涉及文件、为什么、三选一说明；完整文件清单同时写入 `files` 字段，`question` 字段独立保存三选一说明。
- **等待**：线程置为 `WAITING_USER`；`task_status` / `list_messages` / `list_approvals` 均可见 `waiting_for_user: true` 与 pending 审批；`request_approval` 阻塞轮询，默认 10 分钟超时（`APPROVAL_TIMEOUT_MS`）。
- **回复**：`respond_approval(decision=once|session|deny)`，或用户在聊天里用 `send_message` 回复审批消息（`reply_to` 指向提问）。引擎解析中文/英文关键字与 `{"decision":...}` JSON。
- **结果**：`once` → `allowed:true, decision:"once"`，只覆盖本次；`session` → `allowed:true, decision:"session"`，同时写入 `approval_grants`，该 `thread_id + category` 后续不再问；`deny` → `allowed:false, stop:true`；超时 → `allowed:false, decision:"timeout", stop:true`。用户回复按第一期规则把线程恢复 `ACTIVE` 并重置 `exchange_count`。
- **一致性**：同一线程同时只允许一个 pending 审批；条件更新保证一个审批只被解析一次；任务取消/结束或引擎重启时 pending 审批标记 `abandoned` 并释放线程；无法识别的聊天回复不猜测，线程继续保持 `WAITING_USER`，可用 `respond_approval` 显式回答。
- **提示词**：门开时在 claude 任务提示词前注入审批契约（工具名、三类清单、允许/拒绝后的行为）；dsh 没有 MCP 客户端，提示词明确 `request_approval` 不可用，并要求不要执行三类关键操作。门关时不注入任何内容。

### L.4 与第一期协议衔接

- 审批提问和用户回复都是 `messages` 行，沿用 `reply_to` 线程；`list_messages` 可直接看到问答链。
- 发给 `user` 的审批消息在 `WAITING_USER` 下仍为 `stored`，第一期 B1 不变；审批提问是 agent→user，不占 10 条交换上限；用户回复按第一期语义重置计数。上限 10、第 10 条 `held`、第 11 条拒绝均未改动。
- 未修改 `messages` 表结构；新增 `approvals`、`approval_grants` 两张表；`store.js` 新增对应查询/条件更新方法。`send_message` 工具 schema 未新增字段；`message_id` 仅作为审批服务的内部参数，agent 不可设置。
- `agent_info` 新增 `approval_gate`（enabled/categories/options/timeout/question_format/enforcement）；`task_status` 新增 `approval_gate` 与 `approval`（pending/last）。

### L.5 配置与运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_APPROVAL_GATE` | `0` | `1/true/on/yes` 打开聊天审批门 |
| `APPROVAL_TIMEOUT_MS` | `600000` | 审批超时；超时按拒绝处理 |

- 门开时 claude 执行器设置 `MCP_TOOL_TIMEOUT = max(120000, APPROVAL_TIMEOUT_MS + 60000)`，降低客户端先超时的风险；该变量是否被具体 Claude Code 版本识别已如实写入限制。
- `workbench.env.example` 与 `README.md` 已补配置说明、13 个工具列表与审批门小节；新增 `docs/AGENT_HUD_APPROVAL.md` 作为完整规格。

### L.6 验证证据（隔离实例，未调用 agent LLM）

- **审批门回归**：`scripts/verify-approval-gate.mjs`，结果 `data/approval-verify-20261114054507/verify-result.json`，`ok: true`，`errors: []`。
  - 门 OFF（`127.0.0.1:18101`）：`request_approval` 6 ms 返回 `allowed:true, decision:"disabled", asked:false`；线程无消息、`ACTIVE`、`waiting_for_user:false`；`respond_approval` 返回 gate disabled。
  - 门 ON（`127.0.0.1:18102`，`APPROVAL_TIMEOUT_MS=5000`）：
    - `once`：提问消息 `from=claude, to=user, status=stored`，卡片前缀与文件/问题字段符合格式；线程 `WAITING_USER`、`waiting_for_user:true`、`exchange_count:0`；`respond_approval(once)` 后阻塞调用返回 `allowed:true, decision:"once"`，线程恢复 `ACTIVE`，用户回复 `reply_to` 指向提问。
    - `deny`：`allowed:false, stop:true`；deny 不产生 session 授权，同类别再次请求仍会提问。
    - `session`：同线程同类别下一次请求 3 ms 内直接 `allowed:true, asked:false, decision:"session"`，`grant_source` 指向创建授权的审批；不同类别仍提问。
    - 聊天自由回复「这个会话内允许」被解析为 session；歧义回复「晚点再说」保持 pending 与 `WAITING_USER`，随后 `respond_approval(deny)` 可显式解析且不重复写回复。
    - 超时 5,138 ms 返回 `allowed:false, decision:"timeout", stop:true`，线程释放 `ACTIVE`，审批记录 `timed_out`。
    - 审批问答后 agent→agent 消息的 `exchange_count` 从 1 开始，10 条上限语义未变。
    - 引擎重启后 session 授权仍生效；pending 审批标记 `abandoned`，线程恢复 `ACTIVE`。
- **第一期回归**：`scripts/verify-agent-messages.mjs`，`VERIFY_SKIP_AGENTS=1`，两次均 `ok: true`：
  - 门 OFF：端口 18105，结果 `data/agent-hud-verify-20261114054525/verify-result.json`。
  - 门 ON：端口 18106，`AGENT_APPROVAL_GATE=1`，结果 `data/agent-hud-verify-20261114054528/verify-result.json`。
  - 覆盖结论往返、`reply_to` 唯一回复、10 条上限、第 10 条 `held`、第 11 条拒绝、`WAITING_USER`、user 报告默认 `deliver` 下 `stored`（B1）、summary 500 token 截断、重启前后 13/13 条持久化。
- **额度**：本次未调用 claude/dsh LLM，未消耗 agent 额度；额度消耗无法直接观测，不记录虚构百分比。

### L.7 已知限制

- **不是沙箱**：引擎无法检查执行器进程内部执行的命令；审批是“agent 遵守提示词与工具结果”的闸门。强制拦截需要 Claude Code 的 permission-prompt-tool/hook 与 dsh 适配，本期未做。
- **dsh 不能发起审批**：dsh headless 无 MCP 客户端；门开时只要求它不要执行三类操作，无法调用 `request_approval`。
- **阻塞式调用依赖客户端超时**：已尽力提高 `MCP_TOOL_TIMEOUT`；若客户端不识别或另有更短超时，用户回答过晚可能先在客户端侧失败。
- **卡片受 500 token summary 上限**：完整文件清单在 `files`，三选一说明在 `question`。
- **无 GUI**：设置页开关与结论卡片界面属第五期。
- **生产未重启**：`:8080` 仍运行旧代码；新工具与门逻辑待任务外重启后上线。

### L.8 提交与范围

- 代码提交 `e7b05f4`（12 个文件，1902 insertions / 10 deletions）；推送使用单条 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push`，未改全局 git 配置，命令、文档与日志中无 token。
- 未做 GUI、侧栏、纸飞机、结论卡片界面、设置页、审批卡片/弹窗、签名；未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`；未碰 `spike/`；未删除文件；未改 `src/messages.js` 的 10 条上限与 B1 逻辑。
- `docs/AGENT_HUD_SPEC.md` 与 `spike/` 保持未跟踪，未提交。

---

## M 容器化改造与 Cloady 部署准备（2026-11-14）

> 本节为追加记录，不改写上文历史。只做容器化改造与本地验证；本次**没有部署到 Cloady**，也未改动 GUI、`spike/`、签名与审批。

### M.1 结论与状态

- **代码状态**：[DONE] 引擎可通过 `MCP_BIND` 监听 `0.0.0.0`，Claude/dsh 凭据可全部从环境变量或挂载文件提供；新增 `Dockerfile`、`.dockerignore`、`docker-entrypoint.sh` 与 `docs/CLOADY_DEPLOY.md`。
- **Docker 验证**：[BLOCKED] 本机没有 Docker / WSL / podman（`docker`、`podman` 均 command not found；`wsl --status` 提示未安装 Linux 发行版）。因此镜像**未构建、未运行**，需在装有 Docker 的机器上验证。
- **真实小任务**：未执行。无 Docker，未使用本机网关凭据跑真实 claude/dsh 任务；本次未调用 agent LLM，额度消耗无法直接观测。
- **生产 `:8080`**：未重启、未改动；隔离实例使用 18127/18128，结束后端口已释放。
- **分支**：`gui/v0.1`；提交 hash 以 `git log -1` 与任务汇报为准。

### M.2 Linux 可行性（实测/证据边界）

| 项目 | 结论 | 依据与边界 |
|---|---|---|
| Claude Code CLI | Linux 可用（官方 npm 安装）。2.1.325 声明 Linux x64/arm64 的 glibc 与 musl 可选二进制；`install.cjs` 把对应原生二进制放到 `bin/claude.exe`（Linux 上是 ELF）。`engines.node >=22`。 | npm registry 元数据 + 本机安装目录 `install.cjs` 检查；用 npm `--os=linux --cpu=x64 --libc=glibc --package-lock-only` 复核 Linux 可选包进入依赖图。**未在 Linux 上执行** `claude --version`（本机无 Linux 运行时）。 |
| dsh Linux 版 | 有 Linux 安装路径：npm 包无 `os`/`cpu` 限制；GitHub Releases 只有 npm 标签、无平台二进制资产；原生可选依赖有 Linux glibc 版本（`node-addon-require-builtin-linux-x64-gnu`、`@koromix/koffi-linux-x64`、`@img/sharp-linux-x64`）。 | npm registry + GitHub Release 元数据 + 本机依赖树检查。**未在 Linux 上执行** `dsh --version` 或 headless 任务；完整 dsh 依赖图的 `npm --package-lock-only` 解析在 240 s 内无输出而超时，不能作为执行证据。 |
| node-pty | 发布包只有 darwin/win32 预编译；Linux 走 `node-gyp rebuild`。 | 本机安装目录 `prebuilds/` 仅 4 个平台目录。Dockerfile 构建阶段装 `python3 make g++`，并使用 Node 镜像自带 headers。 |
| 版本 | dsh `latest` 0.2.2-rc.1 要求 Node >=24.9.0；镜像按用户要求用 Node 22，因此固定 dsh **0.1.0-rc.6**（本机 Windows 上已在 Node 22.20.0 实测可运行）。 | npm `engines` + RESUME §K。迁移到 dsh 0.2.x 需 Node 24+ 底图。 |

### M.3 代码改动

| 文件 | 改动 |
|---|---|
| `src/config.js` | `MCP_BIND` 环境变量（默认仍 `127.0.0.1`）；`0.0.0.0`/`::` 时内部 MCP URL 用 `127.0.0.1`；Claude gateway env 支持 `WORKBENCH_CLAUDE_ENV_JSON`（内联 JSON，覆盖文件）与 `WORKBENCH_CLAUDE_SETTINGS`（挂载文件路径），默认仍读 `~/.claude/settings.json`；内联 JSON 解析后从 `process.env` 删除，避免执行器继承原始密钥；JSON 解析错误不再回显输入；npm 全局前缀解析新增 POSIX `<prefix>/lib/node_modules` 布局，Windows 顺序不变；仍每次任务启动惰性解析，无快照。 |
| `Dockerfile` | Node 22 两阶段：构建阶段装 claude 2.1.325 + dsh 0.1.0-rc.6（`INSTALL_DSH=0` 可只装 claude），运行阶段装 git/CA，拷全局 node_modules，`npm ci --omit=dev`，非 root `node` 用户，`MCP_BIND=0.0.0.0`，`EXPOSE 8080`，healthcheck，entrypoint。`NPM_REGISTRY` 可覆盖（默认 npmjs；lockfile 里的 npmmirror host 会被替换）。 |
| `.dockerignore` | 排除 `.git`、node_modules、data/logs、GUI、spike、design/assets、docs、scripts、env 与数据库文件。 |
| `docker-entrypoint.sh` | 校验 `MCP_BEARER_TOKEN`；从 `DSH_CREDENTIALS_YAML` 生成 `~/.dsh/.credentials-headless.yaml`（Linux 上 chmod 600）、从 `DSH_HEADLESS_PATCH_YAML` 生成 headless profile patch；随后 `exec` 服务进程。dsh 的 profile 初始化只补缺失文件，已存在的 patch 不会被覆盖。 |
| `docs/CLOADY_DEPLOY.md` | 变量清单、Docker 构建/运行、Cloady CLI 方向与面板步骤、已知限制。 |
| `README.md` / `workbench.env.example` | 增加容器入口说明与占位变量；本地默认行为不变。 |
| `.gitattributes` | `docker-entrypoint.sh` / `Dockerfile` 强制 LF，避免 Windows 检出后 shebang 失效。 |

### M.4 本地验证

- `node --check src/config.js`、`node --check src/server.js`、`sh -n docker-entrypoint.sh` 通过。
- 默认 `config.bind=127.0.0.1`、`mcpUrl=http://127.0.0.1:8080/mcp`；`MCP_BIND=0.0.0.0` 时 `bind=0.0.0.0`、内部 URL 仍为 loopback。
- `WORKBENCH_CLAUDE_ENV_JSON` 生效且覆盖 `WORKBENCH_CLAUDE_SETTINGS`；解析后原始 JSON 环境变量已从 `process.env` 删除；非法 JSON 以非零退出，输出不含输入片段（用哑值验证无回显）。
- 缺失/过短 `MCP_BEARER_TOKEN` 仍拒绝启动（exit 1）。
- 隔离引擎 `127.0.0.1:18127`/`18128`，`MCP_BIND=0.0.0.0`、独立 `MCP_DATA_DIR`/`MCP_LOG_DIR`、48 字符哑 token：
  - `/health` 200；无 token `/mcp` 401；带 Bearer 的 `initialize` 200（`serverInfo.name=agent-workbench`）；`tools/list` 13 个工具；启动日志显示监听 `http://0.0.0.0:<port>/mcp`；结束后端口关闭。
  - 说明：不带 `Accept: application/json, text/event-stream` 时 Streamable HTTP 返回 406，带正确头即 200；不是引擎故障。
- `scripts/verify-command-resolution.mjs` → `ok: true`，Windows 解析顺序与惰性行为未变。
- entrypoint 用哑值验证：生成 credentials/patch 文件，子进程内 `DSH_CREDENTIALS_YAML` 已 unset；缺 token 时 exit 1。Git Bash 在 Windows 上 `stat` 显示 644（Windows 不映射 POSIX mode），脚本对 Linux 显式 `chmod 600`，需在 Linux 上复核。
- **未构建镜像、未跑真实任务**：本机无 Docker/WSL/podman。

### M.5 明确未做

- 未部署到 Cloady（需要用户登录，另行安排）；未登录、未创建应用、未推送镜像。
- 未改 GUI、`spike/`、签名、审批；未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`；未删除文件。
- 未在任何文件、命令或日志中写入真实凭据；文档与示例只含占位。
- 未验证 dsh 在 Linux 上的实际执行；未验证 Docker 构建与 `node-pty` 编译。
- 未把 dsh 完整依赖图解析成功作为证据（该检查超时）；Linux 结论基于 registry 元数据与本机依赖树检查。
- 额度消耗无法直接观测；本次未调用 claude/dsh LLM。

---

## N Agent HUD 第二期评审必须修项 M1 修正（2026-11-14）

> 本节为追加记录，不改写上文历史。只修 `docs/AGENT_HUD_PHASE2_REVIEW.md` 的必须修项 M1；评审 N6 与 M1 同处，随本次一并解决。N1–N5、N7–N8 按用户要求本次不动（与第一期 N1–N8 暂缓处理一致）。

### N.1 范围与状态

- **范围**：只改 `src/approvals.js` 与 `scripts/verify-approval-gate.mjs`；未改 `docs/AGENT_HUD_PHASE2_REVIEW.md`、`docs/AGENT_HUD_PHASE1_REVIEW.md`、GUI、`spike/`、签名。
- **代码状态**：[DONE] 门关短路已移到 `request()` 最前；隔离实例回归通过。
- **生产 `:8080`**：未重启、未写入；生产仍运行旧代码。
- **分支**：`gui/v0.1`；提交 hash 以 `git log -1` 与任务汇报为准。

### N.2 代码修正

- **M1**：`src/approvals.js` 的 `request()` 现在第一步计算 `taskId` / `threadId`（`getThreadId` 只读），第二步即检查 `agentApprovalGate`。门关时立即返回 `allowed:true, decision:"disabled", asked:false, stop:false, gate_enabled:false`，不执行 agent/category/action/files/command 校验，不调用 `ensureThread`，不写消息、不等待、不改线程状态；缺 `files`/`command` 与 `delete + files:[]` 的 schema 合法调用不再抛错。
- **N6**：门关路径不再调用 `ensureThread`，没有 `task_threads` 行的任务不会再被新建 `threads` 行；`thread_id` 仅来自只读的 `getThreadId`（无链接时按既有规则回退为 task_id）。
- **门开路径**：所有原有校验、`ensureThread`、并发 pending 检查、session 授权、卡片写入与阻塞等待逻辑保持原顺序，行为不变。

### N.3 验证证据（隔离实例，未调用 agent LLM）

- **审批门回归**：`VERIFY_APPROVAL_OFF_PORT=18301 VERIFY_APPROVAL_ON_PORT=18302 VERIFY_APPROVAL_TIMEOUT_MS=4000 node scripts/verify-approval-gate.mjs` → `ok:true`、`errors:[]`；结果 `data/approval-verify-20261114063742/verify-result.json`。
  - 门 OFF：正常调用 7 ms 返回 disabled；`respond_approval` 仍报 gate disabled。
  - 门 OFF edge probe（新增，任务无 `task_threads` 行）：缺 `files`/`command` 与 `delete + files:[]` 均在 13 ms 内返回 `allowed:true, decision:"disabled", asked:false`，不抛错、消息 0 条、`threads` 行数为 0（M1 + N6 同时覆盖）。
  - 门 ON：`once` / `deny` / `session`（含不同类别仍问）/ 聊天自由回复 / 歧义回复 / 超时（4,061 ms）/ 审批后 10 条上限计数 / 重启后 session 授权 / pending `abandoned` 恢复全部通过。
- **第一期回归**（`VERIFY_SKIP_AGENTS=1`）两次均 `ok:true`：
  - 门 OFF，端口 18305：`data/agent-hud-verify-20261114063755/verify-result.json`。
  - 门 ON，端口 18306：`data/agent-hud-verify-20261114063759/verify-result.json`。
  - 覆盖 `reply_to` 链、10 条上限、第 10 条 `held`、第 11 条拒绝、`WAITING_USER`、B1 user 报告 `stored`、500 token 截断、重启前后 13/13 条。
- 测试实例均已关闭；18301/18302/18305/18306 无 LISTEN（仅客户端 TIME_WAIT）。额度消耗无法直接观测；本次未调用 claude/dsh LLM。

### N.4 明确未做

- 评审 N1–N5、N7–N8 未处理；未改 `docs/AGENT_HUD_PHASE2_REVIEW.md`、`docs/AGENT_HUD_PHASE1_REVIEW.md`、`docs/AGENT_HUD_APPROVAL.md`。
- 未做真实 claude↔用户审批往返；未重启生产 `:8080`；未改 GUI、`spike/`、签名；未删除文件。

---

## O Agent HUD 第三期：左侧胶囊侧栏 + 纸飞机动画（2026-11-14）

> 本节为追加记录，不改写上文历史。本期只改 GUI（`gui/`）；未改引擎消息与审批逻辑（第一、二期已上线），未碰 `spike/`、签名与两份评审文件，未删除文件。

### O.1 范围与状态

- **代码状态**：[DONE] GUI 已构建并在生产引擎 `127.0.0.1:8080` 上完成真实数据验证。
- **分支**：`gui/v0.1`；提交与推送见 O.6，hash 以 `git log -1` 与任务汇报为准。
- **视觉依据**：`docs/DESIGN_SYSTEM.md`、`docs/BRAND_GUIDELINES.md`；并在品牌规范 §6 追加“常驻 HUD 浮层例外”，明确墨色胶囊、环形进度与纸飞机的允许边界，仍禁止发光、渐变、玻璃拟态、emoji 与仅靠颜色表达。
- **数据原则**：只用真实引擎数据（`agent_info` / `task_list` / `list_messages`）；缺数据时显示“—/暂无”，不生成假状态。

### O.2 改动文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `gui/src/components/AgentHud.tsx` | 新增 | 墨色胶囊、三个槽位、状态环、状态角标、未读/排队角标、悬停详情卡、点击跳转 |
| `gui/src/components/PaperPlaneLayer.tsx` | 新增 | Canvas 纸飞机：二次贝塞尔弧线、虚线尾迹、机头朝切线、最多 3 架、180ms 间隔排队、落地环闪、reduced-motion 降级 |
| `gui/src/lib/hud.ts` | 新增 | 真实数据聚合与四态推导、未读计数、新消息转纸飞机事件、共享 HUD 配置 store |
| `gui/src/styles/hud.css` | 新增 | HUD/环/角标/悬停卡/Canvas 样式与 reduced-motion 规则 |
| `gui/src/components/AppFrame.tsx`、`gui/src/styles/brand.css`、`gui/src/main.tsx` | 修改 | 布局加入 72px HUD 列并挂载 HUD/动画层 |
| `gui/src/types.ts`、`gui/src/lib/engine.ts` | 修改 | 消息列表/消息类型/HUD 配置类型 |
| `gui/electron/engine.ts`、`gui/electron/main.ts`、`gui/electron/preload.ts` | 修改 | 新增 `engine:message-list`、`hud:get-config`、`hud:set-config`；配置持久化到 `userData/hud.json` |
| `docs/BRAND_GUIDELINES.md` | 修改 | §6.1 HUD 浮层例外 |
| `docs/hud-phase3/**` | 新增 | 8 张真实截图 + 证据说明 README |
| `RESUME.md`、`DAILY_LOG.md` | 追加 | 本记录 |

### O.3 侧栏实现

- **槽位**：Muse（`Cloud`）、claude（`Sparkles`）、dsh（`Terminal`）；身份只用图形形状区分，颜色只表示状态。
- **四态推导（全部真实数据）**：
  - `出错`：引擎离线、执行器 `available=false`、存在 `BLOCKED/STALE` 活跃任务，或该执行器最近一条任务在 15 分钟内 `FAILED`；
  - `等你输入`：存在 `WAITING` 活跃任务；
  - `干活中`：存在 `PENDING/STARTING/WORKING` 活跃任务；
  - `空闲`：以上都不成立。
  - Muse 无直接 API：按“存在 `WAITING_USER` 线程 → 等你输入；有活跃任务 → 干活中；否则空闲”间接推导，悬停卡文字明确说明。
- **进度环**：2px；工作中为信号橙不定式弧（1.4s 旋转）、等你输入为琥珀弧、出错为错误色满环、空闲只留灰底环；同时用角标图形（Hourglass / TriangleAlert）和悬停卡文字“空闲/干活中/等你输入/出错”三重编码。
- **悬停详情**：名称、状态、当前任务或最近任务、模型、活跃任务数、本轮用时、未读数、排队数、单击提示；焦点可见时同样显示。
- **未读**：按 `list_messages` 的新消息计数；发给该 agent 的消息计到该槽位，发给 `user` 的消息计到 Muse；点击槽位清零。
- **跳转**：点击 claude/dsh 跳到其活跃或最近任务详情；Muse 跳到任务列表。
- **排队**：纸飞机排队期间，发送方槽位左下角显示 `Mail` 角标。

### O.4 纸飞机实现

- Canvas 覆盖层 `pointer-events: none`，固定全窗口；只在有飞行或尾迹时执行 `requestAnimationFrame`。
- 轨迹为二次贝塞尔，控制点取中点沿垂直方向向窗口内侧偏移 25% 距离；机头取轨迹切线角；尾迹为 4/6 虚线、`#8A8F98`、透明度 0.45，落地后 400ms 淡出。
- 同时最多 3 架，超出排队；相邻起飞间隔 180ms；落地目标环闪一次（400ms 描边淡出，不发光）。
- `prefers-reduced-motion: reduce` 或配置关闭时不飞行，只保留状态变化/环闪。
- 配置：`%APPDATA%\agent-workbench\hud.json` 的 `paperPlanes`，默认 `true`；主进程 IPC 读写，第五期设置页直接暴露。

### O.5 验证证据（真实数据，非模拟）

- `npm run typecheck`、`npm run build` 通过。
- 构建后的 Electron 连接生产引擎 `127.0.0.1:8080`；用 CDP 驱动悬停与截图。截图与说明：`docs/hud-phase3/README.md`。
  - 空闲：`02-state-idle.png`；干活中：`03-state-working.png`；等你输入：`04-state-waiting.png`；出错：`05-state-error.png`。
  - 未读/排队/纸飞机：`06-planes-outbound.png`（dsh 未读 20、Mail 排队角标、纸飞机+尾迹）、`07-planes-return.png`（claude 未读 5、反向飞行、落地环闪）。
  - 跳转：`08-click-jump.png`，点击 dsh 后到 `#/tasks/bc86976f-8ce1-4f47-ad77-f767bd95cb00`，未读清零。
- 真实数据来源：任务 `a5d3198f…`（WORKING）、`bc86976f…`（dsh，1000ms 超时 FAILED，tokens 0/0）、两个 10 条消息的 `WAITING_USER` 线程、5 条 dsh→claude 消息；消息 ID 见 `docs/hud-phase3/README.md`。
- 配置 IPC 实测：`true → false → true`，`hud.json` 落盘为 `{"paperPlanes": true}`。
- 额度：本期实现与截图未调用 claude/dsh LLM；用于制造“出错”状态的 dsh 任务是 1000ms 超时，引擎记录 tokens 0/0。dsh 独立评审另计；额度无法直接观测，不记录虚构百分比。

### O.6 提交与推送

- 分支 `gui/v0.1`；提交内容为上述 GUI 源码、品牌文档、截图与两份追加文档。
- 推送使用单条 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push`；未改全局 git 配置；命令、文档与日志中无 token。
- 提交 hash 与远程 HEAD 以 `git log -1`、`git ls-remote` 及任务汇报为准。

### O.7 已知限制与明确未做

- `list_messages` 按 `created_at ASC` 返回前 N 条；GUI 取 500 条并保留最后 300 条，历史超过 500 条后新消息可能不在窗口内。本期不改引擎消息逻辑。
- 未读状态只在渲染进程内保存，重载/重启后从当前消息重建基线。
- 验证用真实消息保留在生产 SQLite 中；未删除数据。
- 未改 `src/`、`spike/`、签名、`docs/AGENT_HUD_PHASE1_REVIEW.md`、`docs/AGENT_HUD_PHASE2_REVIEW.md`；未删除文件。

---

## P Agent HUD 第三期补充：品牌身份图标、居中修正与评审必须修项（2026-11-14）

> 本节为追加记录，不改写上文历史。GUI 侧新增/修改；引擎消息与审批逻辑仍未被修改（`src/` 无改动），未碰 `spike/`、签名与 `docs/AGENT_HUD_PHASE1_REVIEW.md`、`docs/AGENT_HUD_PHASE2_REVIEW.md`，未删除文件。

### P.1 品牌身份图标（用户 2026-11-14 补充要求）

- 用户提供的三张临时链接图片已下载到 `gui/src/assets/sidebar/source/`：Muse 波浪 M、Claude 星形、dsh 鲸鱼；原件入库，不依赖临时链接长期有效。
- 实际显示的是 `gui/src/assets/sidebar/{muse,claude,dsh}-mark.png`：仅提取源图中央的中性白色标志，去掉源图自带的彩色进度弧、角标、彩色徽章与深色底板；背景透明，紧贴外接框裁剪并留 1px 透明边。处理说明见 `gui/src/assets/sidebar/README.md`。
- 源图的弧线与角标**没有**在 UI 中重复绘制；状态仍由侧栏自己的 2px 环、状态角标（Play / Hourglass / TriangleAlert / Circle）与悬停卡文字表达；身份只由图形形状区分。

### P.2 居中修正

- 原胶囊宽 `56px`、padding `8px`，内容盒仅 `40px`，而槽位是 `44px`，槽位会溢出并造成视觉偏心。现胶囊宽改为 `60px = 44px 槽位 + 2 × 8px padding`。
- `.hud` 使用 `align-items: center`；槽位 `flex: none`；按钮 `display: grid; place-items: center`；图标为 `24×24` 盒子 + `object-fit: contain; object-position: center`，没有目测偏移或 magic number。
- CDP 实测三个槽位图标中心相对按钮中心 `dx = 0, dy = 0`，槽位距胶囊左边 `8px`，胶囊宽 `60px`。
- 证据：`docs/hud-phase3/09-identity-icons-light.png`（浅色，含 Muse 悬停卡）、`docs/hud-phase3/10-identity-icons-dark.png`（深色；深色下胶囊提升到 `--surface` 并加强描边）。深色例外已补入 `docs/BRAND_GUIDELINES.md` §6.1。

### P.3 第三期独立评审必须修项修正

- 评审报告：`docs/AGENT_HUD_PHASE3_REVIEW.md`（dsh 任务 `e8e6a880-02b0-4637-8e53-16d98393c781`，结论 CONDITIONAL PASS，3 个必须修）。
- **M1 已修**：`list_messages` 按 `created_at ASC` 返回最旧 500 条；超过 500 条后未读与纸飞机**确定性停止更新且重启不能恢复**。现在 `useHudData` 检测饱和并在 Muse 悬停卡显示警告，`ConversationPanel` 在会话消息达到 500 条时显示饱和提示；`docs/hud-phase3/README.md` 等措辞已改为“确定性降级”。根治仍需引擎侧 `since`/倒序参数，本期不改引擎消息逻辑。
- **M2 已修**：引擎 `starting` / 尚未拿到状态时显示“连接中”，`agent_info` 读取失败显示“状态未知”，只有引擎真实离线、`agent_info` 成功返回且执行器 `available:false`、或存在 `BLOCKED/STALE`/15 分钟内 `FAILED` 时才显示红色“出错”。
- **M3 更正**：`RESUME.md` O.2 与 `DAILY_LOG.md` 第三期区块曾把 `gui/src/lib/engine.ts` 列为第三期修改，但提交 `b3b10f6` 实际**没有**该文件；该文件是在后续第四期（`useTaskMessages`、审批 IPC 包装）中才修改的。以本节为准，不回改历史区块。
- 同时处理非阻塞项：N4（0ms timer 纳入卸载清理）、N5（悬停卡 `aria-describedby`）、N6（working/idle 增加状态角标）、N7（深色主题胶囊与截图）、N11（配置写入失败不产生未处理拒绝）、N13（reduced-motion 保留无位移淡出）；N1/N2/N3/N8/N9/N10/N12 已在文档如实记录，未做数据层重构。

### P.4 第四期会话流与第五期设置/审批界面（同工作树，已落地）

- **第四期**：`TaskDetailPage` 改为左侧结论卡片流 + 右侧原始日志；卡片来源限定为 `task_status`、`task_logs` 的 system/warn 行与 `list_messages`，包含派发、执行器启动命令、超时/退出、文件改动、agent 消息（文件、问题、`reply_to`、`WAITING_USER`）、完成/失败/取消与运行中；顶部上下文占用条使用设置页可配置的参考上限（默认 128k，≥80% 警告、≥95% 错误）。证据：`docs/hud-phase4/`。
- **第五期**：设置页新增「Agent HUD」分区，暴露纸飞机开关与上下文参考上限（写入 `userData/hud.json`，立即生效）；引擎协作参数（互发消息、来回上限、摘要上限、自动投递、审批门）只读展示，并明确“修改需重启引擎”。任务详情页在 `approval.pending` 非空时显示三选一审批卡片，调用新增的只读包装 IPC `engine:respond-approval`。证据：`docs/hud-phase5/`。
- 未修改引擎消息/审批逻辑；新增 IPC 只是对既有 `list_messages` / `respond_approval` 工具的只读/显式包装。审批卡片**未**在生产环境做真实 pending 审批端到端验证（审批门默认关闭），已在 `docs/hud-phase5/README.md` 如实标注。

### P.5 验证

- `cd gui && npm run typecheck`、`npm run build` 通过。
- 图标与居中：CDP 几何实测 `dx=dy=0`（三个槽位）；浅色/深色截图见 P.2。
- 第四期：生产任务 `bc86976f…`（FAILED，timeout 1000ms）与 `a78cd852…`（COMPLETED，结果摘要、10 条消息/`WAITING_USER`）的真实卡片与日志截图；带文件与问题的真实消息卡片截图。
- 第五期：设置页真实生产数据截图；审批门关闭、协作参数只读展示。
- 额度：本次图标/居中与第四期截图未调用 claude/dsh LLM；dsh 评审任务 `e8e6a880…` 执行约 436 秒，`task_status` 的 tokens 记录为 0/0（dsh 未上报 token），实际额度消耗无法直接观测，不记录虚构百分比。

### P.6 提交与推送

- 分支 `gui/v0.1`；提交包含品牌图标资产与提取图、HUD 居中/评审修正、第四期会话流、第五期设置/审批界面、证据截图与本节记录。
- 推送使用单条 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push`；未改全局 git 配置；命令、文档与日志中无 token。
- 提交 hash 与远程 HEAD 以 `git log -1`、`git ls-remote` 及任务汇报为准。
