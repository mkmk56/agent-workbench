# RESUME — agent-workbench 项目长期状态记忆

> 最后更新：2026-11-13（阶段一 项目接管；含接管后续修正）
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

把 agent-workbench 从“本地 MCP 服务器”发展为**带图形界面的可安装桌面软件**；MCP 服务器继续作为核心引擎，负责执行器管理、任务调度、状态与日志持久化。GUI 技术栈**尚未确定**，候选为 Electron / Tauri，须由用户确认后再锁定，不得擅自选型。

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

- **阶段一：项目接管** —— [IN_PROGRESS]
  - 本文件与 `DAILY_LOG.md` 的建立属于接管初始化，已完成。
  - 接管后的第一项决策是 GUI 技术选型与产品需求确认。
- 后续阶段（命名仅为规划方向，未形成正式排期）：GUI 原型与桌面打包、稳定公网入口、测试与文档完善。

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
| 公网 HTTPS（临时） | `https://compete-cab-superintendent-reasonable.trycloudflare.com/mcp` | Cloudflare quick Tunnel，**URL 会变化**，需换命名 Tunnel |

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
| [DONE] | custom connector 接入 | `custom.agent-workbench` 已连接；2026-11-13 01:20 connector 调用 `agent_info` 返回 `logged_in=true` |
| [DONE] | 首次真实派单 | 通过工作台把本项目发布到 GitHub 公开仓库，任务 `c68b9d69-b138-42a7-88e1-401156e50e38`，2026-11-13 01:24–01:25 CST，耗时约 70 秒；claude tokens 输入 35215、输出 6215（单次任务用量，非每日额度余额） |
| [DONE] | 首次派单审核 | 审核任务 `e4753c1f-d077-401c-93de-782c0a853d9c` |
| [DONE] | 阶段一接管初始化 | 创建 `RESUME.md` 与 `DAILY_LOG.md`，提交 `db9999a` 并推送 |
| [IN_PROGRESS] | 阶段一 项目接管 | 接管持续进行，下一步为 GUI 技术选型与需求确认 |
| [TODO] | GUI 技术选型 | Electron / Tauri 待调研并由用户确认；先产出决策文档，不写大代码 |
| [TODO] | 稳定公网入口 | 将 Cloudflare quick Tunnel 换为命名 Tunnel，获得固定 URL |
| [TODO] | 测试覆盖完善 | 在现有验收脚本基础上补齐自动化与回归覆盖 |
| [TODO] | 文档整理 | 统一 README / TESTS / RESUME 的口径，处理已知文档差异（见 E） |

---

## E 当前遗留问题

1. **[TODO] Cloudflare quick Tunnel URL 临时**
   `https://compete-cab-superintendent-reasonable.trycloudflare.com/mcp` 会在隧道重启后变化，需要命名 Tunnel + 自有域名才能稳定。当前每次变更都要重新配置 connector。

2. **[BLOCKED] Tailscale HTTPS 证书无法签发**
   本机访问 Let's Encrypt ACME（`acme-v02.api.letsencrypt.org`）超时，无法为 tailnet 域名签发 HTTPS 证书。当前 HTTPS 走 Cloudflare Tunnel，tailnet 仅保留 HTTP/80 备用入口；Muse 官方客户端强制 HTTPS，因此 tailnet 入口不可用于该客户端。

3. **[BLOCKED] dsh 无原生续跑（上游限制）**
   `dsh 0.1.0-rc.6` 的 headless 模式不支持 `--resume`；当前由服务端拼接历史实现多轮。`agent_info` 已如实返回 `resume_supported: false`。这不是本项目代码缺陷，但会影响长会话的上下文一致性，需在 GUI 设计时考虑。

4. **[KNOWN_BUG] 历史日志记录过真实 token（执行器检查结论）**
   本地执行器检查 `data/` 时报告历史日志中记录过真实 token（未上传）；该结论来自执行器检查，仓库内无可核验痕迹，分享前仍按已泄露风险处理并轮换 token。

5. **[NEEDS_REVIEW] 公开 README 含基础设施信息**
   README 含内网主机名、tailnet 域名、回环地址 `127.0.0.1` 与本地路径。这些属于基础设施信息而非密钥，但公开分享前应评估是否需要脱敏。

6. **[NEEDS_REVIEW] 文档口径不一致**
   - Claude 登录状态：README 自身存在矛盾——一处说明通过内部网关运行、无需 Anthropic 登录，另一处又写 claude 须单独登录。2026-11-13 两次实测 `agent_info`（00:57 原始调用、01:20 connector 调用）均返回 `logged_in=true`；`TESTS.md` 中的 `logged_in=false` 已过时，以实测为准。
   - 任务日志格式：接管材料写作“每任务 JSONL”，实际代码为按行追加的文本 `.log` + `.prompt` + 元数据 JSON。
   - Cloudflare 状态：`TESTS.md` 的“未通过 / 未验证”表写着“未安装 cloudflared、未创建公网入口”，但同文件第 18–20 项已记录 Cloudflare HTTPS 验收通过，且 2026-11-13 正在使用 quick Tunnel。该表已过时，需要整理。
   - `--max-turns`：工具 schema 接受该参数，但 Claude Code 2.1.270 的 `--help` 中没有此参数，实际被忽略。

7. **[长期约束] 额度数据无法直接观测**
   每日额度策略为总额的 10% 上限，但额度消耗无法直接观测；只能按保守估算控制，禁止在文档或汇报中伪造精确数字。

---

## F 下一步研发计划

按优先级排列，具体排期以用户确认为准：

1. **P1 GUI 技术选型与产品需求确认**
   - 调研 Electron 与 Tauri 在 Windows 11、Node.js 22、现有 MCP 引擎复用、安装包体积、权限模型、自动更新等方面的差异。
   - 产出决策文档与推荐方案，交由用户确认；确认前不锁定技术栈，也不编写大段 GUI 代码。
   - 计划作为下一天的首个小任务执行。

2. **P1 稳定公网入口**
   - 配置 Cloudflare 命名 Tunnel（需自有域名），替换 quick Tunnel，获得固定 HTTPS URL。
   - 更新 connector 配置与 README 部署说明。

3. **P2 完善测试覆盖**
   - 在 `scripts/test-*.mjs` 基础上补充回归用例，覆盖鉴权、并发、取消、崩溃恢复、双执行器与续聊。
   - 保持 TESTS.md 与实际结果同步，避免再次出现状态表互相矛盾。

4. **P3 文档整理**
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

本次接管新增 `RESUME.md` 与 `DAILY_LOG.md`，以一次提交推送到 `origin/main`。接管提交为 `db9999a`（`docs: add project takeover status and daily log`）；本次后续修正提交的 hash 以 `git log -1` 与任务汇报为准（本文件无法记录自身所在提交的 hash）。

---

## H 最终交付状态

- **最终交付目标**：可安装的图形界面桌面软件，MCP 服务器作为核心引擎；用户可在本机管理执行器、任务、日志与配置，并通过稳定入口接受云端编排端派单。
- **当前交付形态**：本地 MCP 引擎已可用并通过验收；公网入口可用但为临时 URL；GUI 尚未开始。
- **整体状态**：[IN_PROGRESS]
- **阶段一（项目接管）**：[IN_PROGRESS]
  - 接管初始化（长期记忆文件 + 每日日志 + 首次同步）：[DONE]
  - GUI 选型与需求确认：待执行（P1）
- **当前可用性结论**：8 个 MCP 工具可用，claude 与 dsh 均可执行任务；claude 支持原生续跑，dsh 依赖服务端历史拼接；Muse connector 已连通；首次真实派单已成功完成。
- **下一次会话入口**：先读本文件与 `DAILY_LOG.md` 最新日期区块，再用 `agent_info` 复核执行器状态，然后按 F 节优先级推进。