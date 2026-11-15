# 阶段四：群聊整合联调与图标重做

> 负责人：Claude（前端/集成）· 日期：2026-11-16 · 分支：`gui/redesign-chat`
> 基底：`gui/v0.1`（`dcb803a`）· 合并：`gui/redesign-chat-backend`（`75cfe85`）+ `gui/redesign-chat-frontend`（`9d6483d`）

## 1. 合并结果

| 项 | 结果 |
|---|---|
| 整合分支 | `gui/redesign-chat`，由 `gui/v0.1` 新建 |
| 后端合并 | `245d36a`，8 文件 +1665/−76，无冲突 |
| 前端合并 | `f5f395b`，17 文件 +2977/−143，无冲突 |
| 文件重叠 | 无（后端仅 `src/`、`scripts/`、`docs/CHAT_BACKEND.md`；前端仅 `gui/`） |
| 未触碰 | 他人未提交的 `docs/AGENT_HUD_SPEC.md`、`docs/hud-phase4/*.png`、`spike/`、`uu-remote-screen.png` |

## 2. 强制检查（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `cd gui && npm run typecheck` | **EXIT 0**（两套 tsconfig） |
| 生产构建 | `cd gui && npm run build` | **EXIT 0**（theme:build / build:main / vite build，3220 modules） |
| 后端验证 | `node scripts/verify-chat-backend.mjs` | **`ok:true`、`errors:[]`、47 次 MCP 调用、0 次 LLM、EXIT 0**；证据 `data/chat-backend-verify-20261115161811/verify-result.json` |

## 3. 引擎与数据

生产 `:8080` 仍由旧引擎进程（PID 29088）监听；**本次会话本身是该引擎托管的 claude 任务**（进程树 `engine 29088 → claude.exe 30408 → bash`）。`Scheduler.shutdown()` / `recover()` 会对运行中的任务执行 `killTree`，因此在会话内重启生产引擎会直接杀掉本任务，无法在结束前汇报。按用户指示，生产引擎切换留给独立的后续任务；本次用隔离实例完成全部联调：

- **合并版引擎**：`MCP_PORT=18093`、`MCP_DATA_DIR=data/phase4/integration-data`，`/health` 正常；19 个工具（含 6 个 chat 工具）。
- **真实数据库副本迁移**：对运行中的 `data/workbench.db` 做 `VACUUM INTO` 一致副本，用合并版引擎在 `:18094` 启动：日志到达 `listening`，无迁移错误；迁移后 **37 messages / 86 tasks 行数不变**，`messages.chat_id` 存在，`task_id.notnull=0`，`chats` / `chat_tasks` 表已建。
- 会话在 00:26 被环境终止（exit 1）；18094 日志显示已成功监听，无代码错误。恢复会话后重新启动 18093，数据完整。

## 4. 12 点检查清单

证据文件：`data/phase4/checklist-evidence.json`（机器断言，11/11 API 项通过）；截图目录：`C:\Users\yikai\AppData\Local\Temp\aw-chat-preview\shots\`。

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 建群聊 OK | **PASS** | `create_chat` 返回 `联调验证 A` / `联调验证 B`（`6aa4d5c4…` / `221532ed…`）；`list_chats` 重启后仍在 |
| 2 | 多群聊独立保存 | **PASS** | A=3 条 `[user,muse,claude]`，B=4 条 `[user,muse,dsh,user]`；A 无 dsh、B 无 claude；重启后计数不变 |
| 3 | 群聊里能发任务 | **PASS** | API 写入 user→muse；真实 Electron 输入框发送「GUI 发送测试…」→ 落库（`2026-11-15T16:25:15.889Z`），`phase4-light-chat-B-gui-send.png` |
| 4 | Muse 分拆派发 | **PASS** | `send_chat_message(from=muse)` → claude 子任务 `ed55d680…`、dsh 子任务 `f513c36b…`，均 `delivered`；分配间隔 153 ms |
| 5 | Claude 直接接活并在群聊汇报 | **PASS** | 子任务 `COMPLETED`（7.5 s，exit 0）；群聊出现 `from=claude` 结论「Claude 已在群聊 A 接活并完成联调验证。」 |
| 6 | dsh 同样 | **PASS** | 子任务 `COMPLETED`（66.6 s，exit 0）；`<agent_reply>` 被解析，群聊出现 `from=dsh` 结论 |
| 7 | 发送人身份正确 | **PASS** | A `[user,muse,claude]`、B `[user,muse,dsh,user]`；muse 冒充 claude 任务被拒：`task … belongs to claude, not muse` |
| 8 | agent 状态真实更新 | **PASS** | 轮询见 `WORKING → COMPLETED`；`chat_status` A.claude=`completed`、B.dsh=`completed`；GUI 发送后 Muse 显示「等 Muse 回复」（`needs_reply`） |
| 9 | 多群聊并行互不干扰 | **PASS** | 两个子任务同一秒派发（间隔 153 ms）并行执行；各任务 `chat_id` 绑定各自群聊，消息零泄漏 |
| 10 | 切换群聊恢复完整历史 | **PASS** | 引擎重启后 `list_chat_messages` 仍返回 A 3 条、B 4 条升序完整历史；GUI 切 A/B 均恢复；`phase4-*-chat-A/B.png`、`phase4-light-chat-B-after-restart.png` |
| 11 | 白天/黑夜主题完整 | **PASS** | 浅色 `phase4-light-chat-A.png` / `phase4-light-chat-B.png`；深色 `phase4-dark-chat-A.png` / `phase4-dark-chat-B.png`；群聊列表、消息流、输入框齐全 |
| 12 | 原有引擎/执行器功能仍可用 | **PASS** | `agent_info`：claude 2.1.325 / dsh 0.1.0-rc.6 均 available；legacy `task_start` → `LEGACY_OK`（1.8 s）；`task_send` → `TURN2_OK`（同 session）；`task_logs` / `task_list` 正常 |

### 4.1 说明（不编造）

- “Muse 分拆派发”由测试脚本以 `from=muse` 调用 `send_chat_message` 完成（引擎文档规定的外部编排器契约）；本次未驱动云端 Muse 本体。
- B 群聊最后一条是 GUI 测试消息，因此 `needs_muse=true`、Muse=`needs_reply`，这是真实状态，不是失败。
- 生产 `:8080` 未切换为合并版（原因见 §3），由用户另派任务重启。

## 5. 真实 Electron 截图

全部为构建版 Electron（`gui/dist`）+ 隔离合并引擎 `:18093` + 真实引擎数据，无 mock。

| 文件 | 内容 |
|---|---|
| `phase4-light-chat-A.png` | 浅色，群聊 A：列表 + 消息流 + 结论卡 + 输入框 |
| `phase4-dark-chat-A.png` | 深色，群聊 A |
| `phase4-light-chat-B.png` | 浅色，群聊 B（dsh 结论） |
| `phase4-dark-chat-B.png` | 深色，群聊 B |
| `phase4-light-chat-B-gui-send.png` | GUI 输入框发送后：新消息 + 未读橙点 + Muse「等 Muse 回复」 |
| `phase4-light-chat-B-after-restart.png` | 引擎重启后 GUI 自动重连，完整恢复 B 历史 |

## 6. 图标重做

- 设计原样落盘：`assets/branding/source/icon-master.svg`（Paper 底 + 72/512 Y + r=56 橙点）、新增 `assets/branding/source/icon-small.svg`（16 格专用）、`assets/branding/app-icon/generate_icons.py`（PIL，4× 超采样）。
- 生成：`python generate_icons.py .` → `icon-16/24/32/48/128/256/512.png` + `agent-workbench.ico`；ICNS 保留旧版（Windows 目标平台）。
- 校验：ICO 目录 5 项，尺寸 **16/24/32/48/256**；16px 像素统计 paper=130、ink=21、orange=13（256 像素全不透明）；深色底预览 `data/phase4/icon-16-dark-preview.png`、16/24/32 条带 `data/phase4/icon-small-strip.png` 肉眼可辨。
- 打包/安装/深色任务栏实拍：见 §6.1。

### 6.1 安装包与任务栏

- `cd gui && npm run dist` → **EXIT 0**；产物 `gui/release/AgentWorkbench-Setup-0.1.0.exe`（132,954,504 bytes，2026-11-16 00:36），未签名（按既定方案）。
- 静默安装 `/S` → **EXIT 0**；安装到 `C:\Users\yikai\AppData\Local\Programs\agent-workbench-gui\Agent Workbench.exe`。
- 安装包与安装后 exe 的提取图标均为新标（Paper 底 + 深色 Y + 橙点）。
- 深色任务栏实拍（`SystemUsesLightTheme=0`）：`phase4-taskbar-dark-16px-zoom.png`（10× 放大）、`phase4-taskbar-dark-context.png`（4×，含相邻图标与活动指示条）、`phase4-taskbar-strip.png`（原始 2560×110）。16px 图标在深色任务栏上肉眼可辨。
- 安装版 GUI 以 `WORKBENCH_GUI_ENGINE_PORT=18093` 启动，界面显示“引擎在线”，确认打包后的 IPC/引擎连接正常。

## 7. 关机权限探针

- `shutdown /s /t 3600` → **EXIT 0**（已计划）。
- `shutdown /a` → **EXIT 0**（中止成功）。
- 再次 `shutdown /a` → **EXIT 92 / Windows 错误 1116**「没有进行中的关机进程」，证明没有遗留的关机计划；未真正关机。

## 8. 已知限制

- 生产 `:8080` 仍是旧引擎（13 工具），合并版切换未在本次会话执行；真实库迁移已在一致副本上验证，但正式迁移要在重启任务中发生。
- `npm run dist` 首次打包耗时较长（复制 `../node_modules` 到 `resources/engine`）；若安装包构建失败，图标源文件与生成物仍已落盘，可单独重跑。
- 未驱动云端 Muse 本体（仅按契约模拟 `from=muse`）。
- 截图目录在系统临时目录，不在仓库内；仓库只记录路径。