# 架构审计（Phase 0）

> 审计对象：agent-workbench（MOG 生产主机，DESKTOP-MOGQKNK）
> 审计时间：2026-11-18 21:08（快照）+ 22:20（补记 7fcc225）
> 分支：`gui/group-chat-upgrade` @ 3707962（快照时）→ 7fcc225（补记时）
> 审计人：Muse（Newa）。本文件是 Pachat REA 项目 Phase 0 的三份交付之一，
> 另两份为 PACHAT_RESEARCH.md 与 FEATURE_GAP_ANALYSIS.md。

## 1. 快照

| 项目 | 快照值 |
|---|---|
| 分支 / HEAD | gui/group-chat-upgrade @ 3707962（快照时）；7fcc225（补记时） |
| 工作区 | 干净（clean tree），本地与远端同步 |
| src/ | 16 个文件（见 §2） |
| docs/ | 29 个文件；尚无 docs/rea/ |
| 数据库 | data/workbench.db = 514,940,928 B（割接时 491,724,800 B，+23 MB） |
| 引擎 | Node 22，Streamable HTTP，127.0.0.1:8080，SQLite；29 个工具 |
| GUI | 已安装 3707962 构建（126.94 MiB） |

## 2. 源码结构（src/）

```
src/
├── server.js          # 引擎入口（MCP Streamable HTTP 服务）
├── config.js          # 配置：执行器解析、executorTempDir（.tmp-sandbox）
├── store.js           # SQLite 持久层
├── state.js           # 运行时状态
├── chats.js           # 群聊 / 消息 / 会话
├── messages.js        # 消息处理
├── context.js         # buildChatContext（默认 30 条 / 6000 token 预算）
├── approvals.js       # 审批门（当前配置为关闭）
├── auth.js            # 身份与 token
├── credentials.js     # 凭据管理
├── files.js           # 附件存储 / 解析 / 下载
├── scheduler.js       # 定时任务
├── security.js        # 安全策略
├── text.js            # 文本处理
├── tools.js           # MCP 工具注册（29 个，含 muse_heartbeat）
├── mcp-config.js      # 按任务生成 MCP 配置（独立 token）
└── executors/
    ├── process.js     # 进程派生 + env allow-list（P0 隔离核心）
    ├── claude.js      # Claude Code CLI 执行器
    └── dsh.js         # dsh CLI 执行器
```

最新改动时间：2026-11-18 11:23–12:06（深重构 Batch 1）。

## 3. 执行器：真实独立，不是模拟

- **Claude**：真实 Claude Code CLI（native 2.1.326，`C:\Users\——\.local\bin\claude.exe`），
  模型 deepseek-v4.1-flash，经 maas.qianwenaiapi.com/apps/anthropic 网关；
  以 `--dangerously-skip-permissions` 全权限运行（用户 2026-11-18 决定：全部 agent 完全权限）。
- **dsh**：真实 dsh CLI（0.1.0-rc.6，npm 全局），模型 deepseek-v4.1-flash，
  经 dashscope.aliyuncs.com，profile 为 bailian1；
  2026-11-18 22:22 起以 `DSH_PERMISSION_MODE=danger-full-access` 运行（提交 7fcc225，
  同为用户决定），此前其 Windows-ACL 受限令牌沙箱在 Win10 19045 上无法启动
  pwsh/node/where（0xC0000142），shell 故障已由该改动修复（冒烟测试 3 全过）。
- **Muse**：没有本地执行器，只作为 master-token 外部调用方存在。
- **process.js 只是 OS 进程派生**，不含任何 agent 逻辑。

## 4. 防循环与一致性护栏（已验证为真）

- 每线程交换上限 10、回复深度 8、每 epoch agent 消息预算 20、
  client_msg_id 幂等、过期 epoch 拒绝。
- 可见性由显式 `act_recipients`（最多 2 人）控制，没有广播 API。
- 上下文：`buildChatContext` 默认 30 条消息 / 6000 token 预算。

## 5. 身份隔离（P0，已完成并上线）

- 旧漏洞（执行器可读 workbench.env 的 master token 并以 `from=user` 发言）
  已由 09da0b5 + e36eb72 修复；dsh 交叉审发现的 B1–B5 由 48e6154 修复，
  B5 后续由 2a10b9c 修复；TEMP 重定向由 a2f37f8 修复（executorTempDir → `.tmp-sandbox`）。
- `process.js` 的 env allow-list：只放行运行必需变量，BLOCKED 集合拦截
  MCP_BEARER_TOKEN / MCP_HUMAN_TOKEN / MCP_MUSE_TOKEN / MCP_DATA_DIR /
  MCP_DB_PATH / MCP_LOG_DIR / WORKBENCH_ENV_FILE / WORKBENCH_CLAUDE_ENV_JSON；
  APPDATA / LOCALAPPDATA 刻意移除（USERPROFILE 等由 Node 22 子进程机制
  重新合成，属于纵深防御而非硬边界，见 149e392）。
- 每个任务有独立的 MCP 配置与 token（`writeTaskMcpConfig`，见 mcp-config.js），
  human / Muse 使用独立 secret，master 泄漏不再等于 Muse 派发能力。

## 6. 深重构进展（Batch 1 已上线，验收待补）

- P1-1 启动对账、P1-2 投递重试与死信、P1-5 executions/model_calls 表
  已提交（a85fc5b / 4e80fda / a9c9761）并于 2026-11-18 22:05 随引擎重启上线。
  对账冒烟脚本在 MOG 本机直接跑通过（5s，exit 0）。
- **未验证**：Muse 尚未亲自通读 4e80fda 的 diff 对照 REFACTOR_PLAN §3.2；
  完整 typecheck / 全量 npm test 未由 Muse 亲自验证（两次派发任务
  cb1caf90、9599f7ed 均在 Bash 调用中途死亡，原因未明，需持续观察）；
  dsh 交叉审待补（dsh shell 已修复，可派）。
- **待做**：P1-3 自动回复去重、P1-4 Muse 幂等加固、P1-6 会话连续性、
  P1-7 日志写放大（见 §7）、P1-8 agent_info 异步；前端 P1-9~P1-13；
  P2（N+1/索引、上下文去重、下载流式/Range、历史回填、schema 治理、文档同步、结构清理）。

## 7. 已知问题清单（按优先级）

| # | 问题 | 状态 |
|---|---|---|
| 1 | P0-6 未读链断裂：`list_chats` 不返回 `unread`，前端从不调 `chat_mark_read`，`last_read_seq` 全为 0 | 前端批处理待做 |
| 2 | P1-7 日志写放大：`logs` 表曾达 583,343 行 / 约 296 MB；DB 从割接时的 491,724,800 B 涨到 514,940,928 B | 待做 |
| 3 | README.md 仍写 19 个工具，引擎实际 29 个 | 文档漂移，未修 |
| 4 | GROUP_CHAT_UPGRADE_PLAN.md 只存在于本地，未进仓库 | 文档漂移，未修 |
| 5 | AGENT_HUD_SPEC.md 仍写 HUD 胶囊 56px，实际 62px | 文档漂移，未修 |
| 6 | dsh 沙箱在 Win10 19045 上不可用（0xC0000142） | 已绕过（7fcc225，danger-full-access）；上游修复待后台跟进 |
| 7 | 引擎进程 PATH 缺 C:\Claude\pwsh7（会话环境在 setx 之前建立） | 已在执行器层追加（7fcc225）；下次 MOG 重启/重新登录后自然消失 |
| 8 | 两次 Claude CLI 进程在 Bash 调用中途死亡（cb1caf90、9599f7ed） | 原因未明，需观察是否复发 |
| 9 | RESUME.md / DAILY_LOG.md 曾滞后一天（11-18 的工作未记） | 已补记并推送（63ea52a） |

## 8. GUI 架构

- React 18 + TypeScript，Electron（系统标题栏，`autoHideMenuBar`），Vite。
- 设计系统 Astryx（`@astryxdesign/core`）+ 品牌适配层 `gui/src/ui/astryx.tsx`；
  纯全局 CSS（BEM），不用 Tailwind / CSS Modules / CSS-in-JS；图标 lucide-react。
- 主题：Premium Matte Black（高级磨砂黑），token 层已落地（d2e1cb5、e00c2c4、5cd4212）；
  信号橙已从主题 accent 移除（AboutPage logo 与旧 ICNS 除外，用户决定保持原样）。
- 聊天气泡身份色：用户 2026-11-18 决定仅气泡使用克制低饱和身份色
  （Muse 墨色中性 / Claude 哑光陶土 / dsh 哑光石板蓝），预览已发待用户确认；
  其余界面（侧边栏、HUD、按钮）继续无身份色。
- HUD 胶囊为禁区（AgentHud.tsx、hud.css、portal、62px 胶囊、工作环、纸飞机动画——不动）。
- 侧边栏可调 260–480px（步进 8），键盘 ←/→ ±16，Home/双击复位 336，
  持久化 `localStorage["agent-workbench.chatSidebar"]`。

## 9. 部署与运维

- MOG（DESKTOP-MOGQKNK，Windows 10 专业版 10.0.19045.7548，i3-8100T，约 11.8 GB 内存，
  仅 C: 盘）：代码 `C:\Claude\agent-workbench`，DB `data/workbench.db`。
- 自启：Task Scheduler `AgentWorkbench`（LogonTrigger）+ `AgentWorkbenchTunnel`；
  隧道 agent-workbench（f9a3103b-554a-4cac-8d80-80e9b5882cc0）→ wb.mkmk56.uk，
  ingress http://127.0.0.1:8080。
- 推送：MOG 经 SSH 密钥 mkmk56-mog（`C:\Claude\.ssh-mog\`），
  HTTPS 到 github.com 不稳定，SSH 22 通。
- niumoi：引擎已停，数据保留，机器留着开机（用户决定）；Tailscale 曾离线，
  2026-11-18 08:18 由 Claude 修复（托盘客户端退出，重启恢复）。
- Tailscale 在 MOG 也掉过一次（2026-11-18 ~21:40，同样是托盘客户端退出），
  已恢复；自启项已注册，属于运行时退出，需观察复发。
- 并发上限 4（dsh 2）；引擎重启会把未完成任务标记为 FAILED。
- 审批门当前关闭（approval_gate enabled: false）；工作台全自动范围已授权
  （执行器确认跳过、整机任意路径、并行派发 + 可续多轮会话）。

## 10. 审计结论

当前 workbench 是一个**真实可用**的多 agent 群聊工作台：真执行器、真持久化、
真防循环护栏、已落地的 P0 身份隔离、Batch 1 已上线。最大的结构性缺口
（对照 Pachat，详见 FEATURE_GAP_ANALYSIS.md）是：没有异构 agent 接入协议、
没有每 agent 独立 Inbox 与已读游标、@ 不是真实事件投递、没有 opKey/409/2 分钟撤回、
没有多群聊的完整产品形态。深重构的剩余项（P1-3/4/6/7/8、前端批、P2）
与 Pachat REA 的 Phase 2 范围高度重叠，应在 Phase 1 目标架构中合并规划，
而不是跑两条线。
