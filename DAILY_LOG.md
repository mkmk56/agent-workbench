# DAILY LOG — agent-workbench 每日研发日志

> 记录规则：追加式，每个日期一个区块，新日期追加在文件末尾；已写入的历史区块不回改（需要修正时新增说明）。
> 事实要求：只记录已验证的内容；额度等无法观测的数据明确标注，不编造数字。

---

## 2026-11-13（周四）

### 今日目标

- 执行阶段一首次项目接管：建立项目长期状态记忆 `RESUME.md` 与每日研发日志 `DAILY_LOG.md`。
- 核对仓库基线（分支、提交、工作区、GitHub 同步状态）。
- 以一次提交把两个文档推送到 `origin/main`。
- 今日不启动新的开发任务，不修改任何代码或配置。

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
  - `initialize` 返回 200。
  - `tools/list` 返回 8 个工具：`agent_info`、`task_start`、`task_send`、`task_status`、`task_logs`、`task_cancel`、`task_list`、`wait_for_task`。
  - `agent_info` 返回的两个执行器符合预期。
- **connector**：`custom.agent-workbench` 已连接。
- **首次真实派单（今日已完成）**：通过工作台把本项目发布到 GitHub 公开仓库；任务耗时约 70 秒；claude tokens 输入 35215、输出 6215。
- **历史验收**：`TESTS.md` 记录 2026-11-12 共 21 项验收通过（鉴权、工具列表、双执行器任务与续聊、并发、取消、崩溃恢复、tailnet 入口、看门狗、Cloudflare HTTPS、token 轮换）。
- **本次文档提交验证**：
  - 提交前 `git status` 仅显示两个新增文件，无其他改动。
  - 推送后核对本地 `HEAD` 与 `origin/main` 指向同一提交；提交 hash 见任务汇报与 `git log -1`。

### GitHub 同步

- 仓库：https://github.com/mkmk56/agent-workbench（公开）。
- 分支：`main`。
- 接管前基线：`be2a86a`，2026-11-13 01:25 CST 推送，27 个文件，工作区干净。
- 本次同步内容：新增 `RESUME.md`、`DAILY_LOG.md`，一次提交推送至 `origin/main`。
- 本次提交 hash 无法写入自身文件，以 `git log -1` 或任务汇报为准。
- `workbench.env`、`data/`、`logs/` 等未进入仓库；`.gitignore` 已覆盖。

### 遗留问题

1. **Cloudflare quick Tunnel URL 临时**：当前公网入口 `https://compete-cab-superintendent-reasonable.trycloudflare.com/mcp` 会随隧道重启变化，需换命名 Tunnel 获得固定 URL。
2. **Tailscale HTTPS 证书无法签发**：Let's Encrypt ACME 超时；tailnet 仅保留 HTTP/80 备用入口，Muse 官方客户端不可用。
3. **dsh 无原生续跑**：上游 0.1.0-rc.6 限制，当前依赖服务端拼接历史；`agent_info` 已标注 `resume_supported: false`。
4. **历史 token 风险**：本地 `data/` 日志与 `workbench.db` 历史上记录过真实 token（未上传）；分享、备份或迁移前需轮换 token 并清理/脱敏。`TESTS.md` 2026-11-12 的扫描记录不能替代当前复核。
5. **公开 README 含基础设施信息**：内网主机名、tailnet 域名、IP 与本地路径，非密钥，但公开分享前应评估脱敏。
6. **文档口径差异**：
   - Claude 登录状态在 README、`TESTS.md`、接管材料中的表述不一致；实际可用性依赖内部 DeepSeek 网关，需以 `agent_info` 实测为准。
   - 接管材料称“每任务 JSONL”，实际为按行追加的文本 `.log` + `.prompt` + 元数据 JSON。
   - `TESTS.md` 的“未通过 / 未验证”表称未安装 cloudflared，但同文件第 18–20 项已验收 Cloudflare HTTPS，该表已过时。
   - 工具 schema 接受 `--max-turns`，但 Claude Code 2.1.270 无此参数，实际被忽略。
7. **额度不可观测**：每日 10% 上限无法直接计量，只能保守估算。今日只做接管初始化，未启动新开发任务。

### 今日成果

- 项目长期状态记忆 `RESUME.md` 建立，覆盖 A–H 全部章节。
- 每日研发日志 `DAILY_LOG.md` 建立，形成可追加的记录模板。
- 仓库基线、工具数量、执行器能力、持久化方式与部署入口完成复核。
- 首次真实派单成果归档：GitHub 公开仓库发布成功，约 70 秒，claude tokens 输入 35215、输出 6215。
- 两个文档已提交并推送到 `origin/main`，项目恢复入口就绪。

### 下一次启动建议

1. 先读 `RESUME.md` 与 `DAILY_LOG.md` 最新日期区块，恢复上下文。
2. 调用 `agent_info` 复核 claude / dsh 的可用性与 `logged_in` / `resume_supported` 状态，统一登录口径。
3. 执行 P1 小任务：调研 Electron 与 Tauri，形成 GUI 技术选型决策文档；只做调研与文档，不写大段 GUI 代码。
4. 待用户确认 GUI 技术栈后再排期开发；不要擅自锁定选型。
5. 推进 Cloudflare 命名 Tunnel，替换临时 URL；同步更新 connector 与 README。
6. 在任何分享、备份或迁移动作前，先轮换 token 并清理历史数据中的敏感信息。
7. 继续遵守每日 10% 额度上限，按保守估算控制用量。