# Agent HUD 第四期：会话流与结论卡片

> 采集日期：2026-11-14
> 环境：Windows 11，构建后的 Electron GUI，连接生产引擎 `127.0.0.1:8080`；全部数据来自真实引擎。
> 截图：`01-conversation-cards.png`（失败任务 `bc86976f…` 的结论流 + 原始日志）、`02-result-card.png`（完成任务的“任务完成”卡片，折叠态）、`03-message-files-question.png`（带文件与问题的真实 agent 消息卡片）。

## 实现

- `TaskDetailPage` 改为左右两栏：左侧 `ConversationPanel` 结论卡片流，右侧原有原始日志；元数据栏移到两栏下方（窄屏自动堆叠）。
- 卡片来源：
  - `task_status`：派发、执行器、超时/退出、文件改动、完成/失败/取消、运行中；
  - `task_logs`：只从 `system`/`warn` 流解析执行器命令、`running pid`、`timeout after`、`finished state/exit`、`ENOENT`/`failed to start`，不把 stdout 里的任意 JSON 误判为错误；
  - `list_messages({task_id})`：agent 之间的真实消息，显示发送方/接收方、状态、token、文件清单、问题、`reply_to` 引用与 `WAITING_USER`。
- 顶部“上下文占用（参考）”：输入 tokens / 可配置的参考上限（默认 128k，设置页可改）；≥80% 变警告色，≥95% 变错误色。引擎未返回真实上下文上限，界面与文档都明确标注“参考值”。
- 消息窗口达到 500 条时显示饱和提示（`list_messages` 按时间正序返回最旧 500 条）。

## 已知限制

- 引擎没有结构化的“读了哪个文件 / 合并了哪个分支 / 命令成功失败”事件，因此不伪造这些卡片；当前只能可靠展示执行器启动命令、超时/退出与 agent 消息。`task_status.files_modified` 目前也恒为空（引擎只在建任务时写入 `null`，全仓库没有写入方），所以“改动了 N 个文件”卡片实际不会出现；代码保留该路径，等引擎提供结构化文件事件后再启用。
- 审批卡片：当 `AGENT_APPROVAL_GATE=1` 且 `task_status.approval.pending` 非空时，结论流顶部显示允许一次/会话内允许/拒绝，并调用 `respond_approval`。生产环境门默认关闭；隔离引擎 `127.0.0.1:18110` 已完成真实 pending E2E（未调用 LLM），截图见 `docs/hud-phase5/02-approval-pending.png` 与 `03-approval-allowed.png`。
- 消息列表超过 500 条后的截断限制与第三期相同，需要引擎侧 `since`/倒序参数根治。
- 截图来自构建版 Electron + CDP/桌面截图；卡片与日志是真实生产数据，验证消息已在 summary 中标注“忽略”。
## 独立评审

`docs/AGENT_HUD_PHASE4_REVIEW.md` 对 `90296c9` 的结论为 CONDITIONAL PASS（5 个必须修项）。最终提交已修正：审批 IPC 的“只读”措辞、写盘失败提示、设置页截图主题、reduced-motion 落地提示、图标外接框描述；非阻塞项中 N4/N5/N6/N7/N8/N10/N11/N13 已记录或修复，N1/N2/N9/N12/N14/N15/N16 保留为后续项。
