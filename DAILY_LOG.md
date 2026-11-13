# DAILY LOG — agent-workbench 每日研发日志

> 记录规则：追加式，每个日期一个区块，新日期追加在文件末尾；已写入的历史区块不回改（需要修正时新增说明）。
> 事实要求：只记录已验证的内容；额度等无法观测的数据明确标注，不编造数字。

---

## 2026-11-13（周五）

### 今日目标

- 执行阶段一首次项目接管：建立项目长期状态记忆 `RESUME.md` 与每日研发日志 `DAILY_LOG.md`。
- 核对仓库基线（分支、提交、工作区、GitHub 同步状态）。
- 以一次提交把两个文档推送到 `origin/main`。
- 接管工作不启动新的开发任务（首次派单属于发布类任务，已另行完成），不修改任何代码或配置。

### 资源额度

- 每日额度策略：不超过总额的 10%。
- 额度消耗数据无法直接观测，按保守估算控制；本日志不记录虚构的百分比或精确余额。
- 今日为文档型小任务：只新增两个 Markdown 文件，不做大范围代码检索、不改代码。

### 代理分工

- 用户：下达接管任务、验收结果，并保留 GUI 技术栈的最终决策权。
- 编排侧（Muse）：通过已连接的 `custom.agent-workbench` connector 发起任务、查询状态。
- 本地执行侧（agent-workbench）：负责调度、任务状态与日志持久化；本次接管文档由当前接管会话编写、提交并推送。
- 可用执行器：
  - `claude` 2.1.270：可用、支持原生续跑，通过内部 DeepSeek 网关运行（模型 `deepseek-v4.1-flash`）。
  - `dsh` 0.1.0-rc.6：可用、headless 一次性，不支持原生续跑，多轮由服务端拼接历史。

### 实际执行内容

1. 核对仓库基线：
   - 当前分支 `main`，HEAD 为 `be2a86a`（`Initial commit: local MCP agent workbench server`）。
   - 远端 `origin` 为 https://github.com/mkmk56/agent-workbench.git。
   - 追踪文件 27 个，工作区干净。
2. 核对项目事实来源：`package.json`、`README.md`、`TESTS.md`、`.gitignore` 及 `src/` 关键文件，确认工具数量、执行器实现、持久化方式与部署入口。
3. 创建 `RESUME.md`：按 A–H 章节记录项目基本信息、产品规划、系统架构、开发进度、遗留问题、下一步计划、GitHub 同步状态与最终交付状态。
4. 创建 `DAILY_LOG.md`：建立本日期区块与后续追加模板。
5. 记录核对过程中发现的文档差异（详见“遗留问题”），未修改任何既有文件。
6. 提交前用 `git status` 核对：工作区只新增 `RESUME.md` 与 `DAILY_LOG.md`；随后提交并推送到 `origin/main`。

### 测试与验证

- **MCP 在线验证（今日已完成）**：
  - 证据任务：`40d7e908-e68d-4161-8d36-39d414b7d742`。
  - `initialize` 返回 200。
  - `tools/list` 返回 8 个工具：`agent_info`、`task_start`、`task_send`、`task_status`、`task_logs`、`task_cancel`、`task_list`、`wait_for_task`。
  - `agent_info` 返回的两个执行器符合预期；00:57 原始调用与 01:20 connector 调用均返回 claude `logged_in=true`。
- **connector**：`custom.agent-workbench` 已连接（01:20 connector 调用）。
- **首次真实派单（今日已完成）**：任务 `c68b9d69-b138-42a7-88e1-401156e50e38`，2026-11-13 01:24–01:25 CST；通过工作台把本项目发布到 GitHub 公开仓库；耗时约 70 秒；claude tokens 输入 35215、输出 6215（单次任务用量，非每日额度余额）。
- **首次派单审核**：审核任务 `e4753c1f-d077-401c-93de-782c0a853d9c`。
- **历史验收**：`TESTS.md` 记录 2026-11-12 共 21 项验收通过（鉴权、工具列表、双执行器任务与续聊、并发、取消、崩溃恢复、tailnet 入口、看门狗、Cloudflare HTTPS、token 轮换）。
- **本次文档提交验证**：
  - 提交前 `git status` 仅显示两个新增文件，无其他改动。
  - 推送后核对本地 `HEAD` 与 `origin/main` 指向同一提交；本次接管提交 hash 为 `db9999a`。

### GitHub 同步

- 仓库：https://github.com/mkmk56/agent-workbench（已在 GitHub 页面核实为公开）。
- 分支：`main`。
- 接管前基线：`be2a86a`，2026-11-13 01:25 CST 提交，27 个文件，工作区干净。
- 本次同步内容：新增 `RESUME.md`、`DAILY_LOG.md`，一次提交推送至 `origin/main`。
- 本次接管提交 hash：`db9999a`（`docs: add project takeover status and daily log`）。本次后续修正提交的 hash 以 `git log -1` 或任务汇报为准。
- `workbench.env`、`data/`、`logs/` 等未进入仓库；`.gitignore` 已覆盖。

### 遗留问题

1. **Cloudflare quick Tunnel URL 临时**：当前公网入口 `https://compete-cab-superintendent-reasonable.trycloudflare.com/mcp` 会在隧道重启后发生变化，需换用命名 Tunnel 获得固定 URL。
2. **Tailscale HTTPS 证书无法签发**：Let's Encrypt ACME 超时；tailnet 仅保留 HTTP/80 备用入口，Muse 官方客户端不可用。
3. **dsh 无原生续跑**：上游 0.1.0-rc.6 限制，当前依赖服务端拼接历史；`agent_info` 已标注 `resume_supported: false`。
4. **历史 token 风险（执行器检查结论）**：本地执行器检查 `data/` 时报告历史日志中记录过真实 token（未上传）；该结论来自执行器检查，仓库内无可核验痕迹，分享前仍按已泄露风险处理并轮换 token。
5. **公开 README 含基础设施信息**：内网主机名、tailnet 域名、回环地址 `127.0.0.1` 与本地路径，非密钥，但公开分享前应评估脱敏。
6. **文档口径差异**：
   - Claude 登录状态在 README 中自相矛盾（一处说无需 Anthropic 登录，另一处说 claude 须单独登录）；2026-11-13 两次 `agent_info` 实测（00:57 原始调用、01:20 connector 调用）均返回 `logged_in=true`，`TESTS.md` 的 `false` 已过时，以实测为准。
   - 接管材料称“每任务 JSONL”，实际为按行追加的文本 `.log` + `.prompt` + 元数据 JSON。
   - `TESTS.md` 的“未通过 / 未验证”表称未安装 cloudflared，但同文件第 18–20 项已验收 Cloudflare HTTPS，该表已过时。
   - 工具 schema 接受 `--max-turns`，但 Claude Code 2.1.270 无此参数，实际被忽略。
7. **长期约束：额度不可观测**：每日 10% 上限无法直接计量，只能保守估算。今日只做接管初始化，未启动新开发任务。

### 今日成果

- 项目长期状态记忆 `RESUME.md` 建立，覆盖 A–H 全部章节。
- 每日研发日志 `DAILY_LOG.md` 建立，形成可追加的记录模板。
- 仓库基线、工具数量、执行器能力、持久化方式与部署入口完成复核。
- 首次真实派单成果归档：GitHub 公开仓库发布成功，约 70 秒，claude tokens 输入 35215、输出 6215。
- 两个文档已通过提交 `db9999a` 推送到 `origin/main`，项目恢复入口就绪。

### 下一次启动建议

1. 先读 `RESUME.md` 与 `DAILY_LOG.md` 最新日期区块，恢复上下文。
2. 调用 `agent_info` 复核 claude / dsh 的可用性与 `logged_in` / `resume_supported` 状态，统一登录口径。
3. 执行 P1 小任务：调研 Electron 与 Tauri，形成 GUI 技术选型决策文档；只做调研与文档，不写大段 GUI 代码。
4. 待用户确认 GUI 技术栈后再排期开发；不要擅自锁定选型。
5. 推进 Cloudflare 命名 Tunnel，替换临时 URL；同步更新 connector 与 README。
6. 在任何分享、备份或迁移动作前，先轮换 token 并清理历史数据中的敏感信息。
7. 继续遵守每日 10% 额度上限，按保守估算控制用量。

> 修正说明（接管后续修正）：原标题“2026-11-13（周四）”星期写错，已更正为“2026-11-13（周五）”。

---

## 2026-11-13（周五）· 补充：Muse 401 与 token 鉴权排障

### 问题

Muse 经公网隧道调用 `/mcp` 持续收到 401，保险库中的 token 与当日对话中给出的 token 都不通过。

### 排查过程

1. 复核 token 来源，确认只有一个来源：`workbench.env` → `start-workbench.cmd` 的 `--env-file-if-exists=workbench.env` → `process.env.MCP_BEARER_TOKEN` → `config.token`。
   - 用户级 / 系统级 `MCP_BEARER_TOKEN`：均为空。
   - 任务计划程序：无 agent-workbench 相关任务。
   - 启动项：`Startup\AgentWorkbench.vbs` 与仓库内 `start-hidden.vbs` 内容一致，只负责调起 `start-workbench.cmd` 并看门狗重启。
   - 仓库内无硬编码 token 副本（仅 `workbench.env` 与历史 `data/` 日志出现过，后者属既有遗留风险）。
2. 验证 token 有效性：
   - 本机 `POST http://127.0.0.1:8080/mcp` `initialize` → 200。
   - 公网隧道 `POST https://distinct-wish-invoice-animal.trycloudflare.com/mcp` `initialize` → 200。
   - 本地与隧道 `/health` 的 `uptime_s` 一致（1631 / 1632），确认隧道确实指向 PID 25844 这一个进程。
   - 结论：服务器实际使用的 token 与 `workbench.env` 一致，**不存在 token 不一致，也无需轮换**。
3. 定位真正原因：`src/server.js` 的 `authorized()` 把整个 `Authorization` 头与 `Bearer <token>` 逐字节比较，因此 `bearer`、`BEARER` 或缺少 `Bearer` 前缀时即使 token 正确也返回 401；而 HTTP 认证 scheme 按 RFC 7235 不区分大小写。
   - 实测：同一 token 写成 `bearer <token>` 经隧道返回 401，写成 `Bearer <token>` 返回 200。

### 改动

- `src/server.js`：
  - `authorized()` 改为忽略 scheme 大小写、去除首尾空白、并接受裸 token；仍用 `timingSafeEqual` 做定长比较，密钥要求不变。
  - 401 分支新增诊断日志，只记录头长度与是否带 `bearer` 前缀，不记录 token。
- 按项目既有方式重启：结束 PID 25844，启动项看门狗 5 秒内拉起新进程 PID 3980。

### 验证结果

| 用例 | 结果 |
|---|---|
| 本机 `Bearer <token>` | 200 |
| 本机 `bearer <token>` | 200 |
| 本机裸 token | 200 |
| 本机错误 token | 401（日志记录 `len=42, bearer_prefix=true`） |
| 公网 `Bearer <token>` | 200 |
| 公网 `bearer <token>` | 200 |
| 公网 `/health` | 200 |

### 遗留说明

- token 未写入任何文件、日志或外发；本日文档与日志均不含 token 明文。
- 若 Muse 仍 401，需在 Muse 侧确认 connector 的认证字段：必须发送 `Authorization: Bearer <token>` 请求头（不能只填 API key 走别的头），并确认 token 无多余空格或换行；此时 401 诊断日志会记录到 `logs/server.log` 以便定位。
- 公网入口仍为 quick Tunnel，URL 会随隧道重启变化。
---

## 2026-11-13（周五）· 补充：GUI 技术选型调研（P1）

### 今日目标

- 恢复项目状态：读取 `RESUME.md` 与 `DAILY_LOG.md`，确认今早鉴权修复的记录情况。
- 完成 GUI 技术选型调研（Electron vs Tauri），产出决策文档，交由用户决策。
- 只做调研与文档：不写 GUI 业务代码，不锁定技术栈，不修改核心服务逻辑。

### 资源额度

- 每日额度策略：不超过总额的 10%。
- 额度消耗无法直接观测，按保守估算控制；本区块不记录虚构的百分比或精确余额。
- 本次为文档型小任务：一次技术调研 + 一份决策文档 + 两处状态文件更新，未启动批量代码检索或构建。

### 代理分工

- 用户：下达调研任务，保留 GUI 技术栈最终决策权。
- 本地接管会话：恢复状态、调研、写决策文档、更新 `RESUME.md` / `DAILY_LOG.md`、提交并推送。
- MCP 引擎：本任务未调用执行器派单；现有服务运行状态未改动。

### 实际执行内容

1. 状态恢复与鉴权修复核对：
   - 读取 `RESUME.md`、`DAILY_LOG.md`，确认 2026-11-13 的 `authorized()` 修复已记录在 `RESUME.md` D 节“2026-11-13 token 鉴权排障”与 `DAILY_LOG.md` 的“Muse 401 与 token 鉴权排障”补充区块（scheme 大小写/空白兼容、裸 token 兼容、不泄露 token 的 401 诊断日志）。记录完整，本次未重复补记。
   - 核对工作区：`src/server.js` 的鉴权修复与上述文档改动当时尚未提交；本次随调研文档一并提交，未再修改服务代码。
2. GUI 选型调研：
   - 对比 Electron 与 Tauri 2 在 Windows 11、Node.js 22 引擎复用、安装包体积、权限模型、自动更新、开发维护成本等维度的差异。
   - 结合本项目约束（Node 22 + `node:sqlite` + Streamable HTTP 引擎、单人维护、GitHub Releases 分发）形成推荐。
   - 结论：推荐 Electron；Tauri 在“体积优先且愿意引入 Rust + Node sidecar”时仍是备选。**技术栈未锁定，等待用户确认。**
3. 文档产出：
   - 新增 `docs/gui-decision.md`：背景与约束、候选方案、加权对比表、推荐结论、推荐架构、风险与缓解、下一步。
   - 更新 `RESUME.md`：B 研发阶段、D 开发进度（调研完成 / 待用户决策）、F 下一步、G 同步状态、H 交付状态。
   - 追加本区块到 `DAILY_LOG.md`。

### 测试与验证

- 本次未修改核心服务代码，未运行服务级测试；验证范围为文档与仓库状态。
- 决策文档中的安装包体积为公开资料量级估算，已在文中明确标注“未实测”，并列入确认后的 spike 验证项。
- 调研时网络访问受限，未能在线复核 Electron/Tauri 最新版本文档；文档未写具体版本号，避免过时信息误导。
- 提交前用 `git status` / `git diff --stat` 核对改动范围；推送后用 `git ls-remote origin main` 核对远程 `main` 与本地 HEAD 一致。

### GitHub 同步

- 仓库：https://github.com/mkmk56/agent-workbench
- 分支：`main`。
- 本次同步内容：`docs/gui-decision.md`（新增）、`RESUME.md`、`DAILY_LOG.md`、以及今早已完成但未提交的 `src/server.js` 鉴权修复。
- 本次提交 hash：以 `git log -1` 与任务汇报为准（本文件无法记录自身所在提交的 hash）。
- `workbench.env`、`data/`、`logs/` 仍未进入仓库；本次文档不含 token 明文。

### 遗留问题

- 沿用 `RESUME.md` E 节，本次无新增。
- GUI 技术栈仍待用户确认；确认前不创建 GUI 工程、不锁定依赖。
- 决策文档中的体积/启动耗时数据为估算，需在 spike 中实测。

### 今日成果

- GUI 技术选型决策文档完成：`docs/gui-decision.md`，推荐 Electron，含对比表、推荐架构、风险与下一步。
- 今早鉴权修复的记录已确认完整，其代码与文档改动已随本次提交入库。
- `RESUME.md` 与 `DAILY_LOG.md` 已同步到最新状态。

### 下一次启动建议

1. 先读 `RESUME.md` 与 `DAILY_LOG.md` 最新区块，恢复上下文。
2. 等待用户对 GUI 技术栈的决策；确认 Electron 后再启动 1–2 天 spike（启动/停止引擎、`/health`、任务与日志、NSIS 打包实测、自动更新）。
3. 确认前不创建 GUI 工程、不改核心服务代码。
4. 继续推进 P1 稳定公网入口（Cloudflare 命名 Tunnel），与 GUI 选型互不阻塞。
5. 继续遵守每日 10% 额度上限，按保守估算控制用量。
