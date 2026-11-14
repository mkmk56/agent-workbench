# Agent HUD 第五期：设置页与审批界面

> 采集日期：2026-11-14
> 环境：Windows 11，构建后的 Electron GUI，生产引擎 `127.0.0.1:8080`。
> 截图：`01-settings-hud.png`（设置 → Agent HUD，浅色主题整窗）；`02-approval-pending.png` / `03-approval-allowed.png`（隔离引擎审批，深色主题）。

## 已落地

- 设置页新增「Agent HUD」分区：
  - **纸飞机动画**开关：写入 `userData/hud.json`，立即生效，默认开；
  - **上下文参考上限**：1,000–2,000,000 tokens，默认 128,000，会话流顶部的占用条使用该值；
  - **引擎协作参数只读展示**：允许 agent 互发消息（引擎已启用）、连续来回上限（10）、结论摘要上限（500 tokens）、自动投递（开）、关键操作审批门（关，默认全自动）。这些参数由引擎环境变量决定，GUI **不修改**引擎消息/审批逻辑；界面明确标注“只读，修改需重启引擎”。
- 任务详情页的审批卡片：`task_status.approval.pending` 非空时显示类别、想做什么、命令、文件、理由，并提供“允许一次 / 这个会话内允许 / 拒绝”三个按钮，调用新增的 `engine:respond-approval` IPC（对既有 `respond_approval` 工具的显式包装；该调用会写入审批决定，不是只读操作）。
- 第四期的上下文参考值改为从 `hud.json` 读取，设置页保存后会话流立即更新。

## 验证边界

- 设置页截图是真实生产环境（审批门默认关闭），只读参数来自 `agent_info`。
- 审批卡片的 UI 与 IPC 已在**隔离引擎** `127.0.0.1:18110` 上完成真实 pending E2E（`AGENT_APPROVAL_GATE=1`、占位任务、真实 `request_approval` / `respond_approval`，未调用 claude/dsh LLM）：`02-approval-pending.png`（三选一卡片）与 `03-approval-allowed.png`（允许一次后卡片消失、返回 `decision=once`）。结果文件在 gitignored 的 `data/approval-ui-verify/request-result.json`（`allowed:true, decision:"once"`）。
- 生产环境没有制造真实 pending 审批（审批门默认关闭）；生产库中的验证消息未删除。
- 未修改引擎消息/审批逻辑（`src/` 无改动）；未改签名；未碰 `spike/`。
## 独立评审与最终修正

`docs/AGENT_HUD_PHASE4_REVIEW.md` 对 `90296c9` 的结论为 CONDITIONAL PASS（5 个必须修项）：
- M1：`engine:respond-approval` 是显式用户操作包装（写入用户回复并终结 pending 审批），不是只读；文档与结论流措辞已统一。
- M2：`setPaperPlanes` / `setContextWindowTokens` 返回 `Promise<boolean>`，设置页按结果提示成功/失败，写盘失败不再显示“已保存”。
- M3：`01-settings-hud.png` 为浅色主题整窗，README 已改正；`02`/`03` 为深色审批截图。
- M4：reduced-motion 下 `.hud-slot__flash` 以 400ms `!important` 保留 opacity 淡出（无位移）。
- M5：图标外接框描述改为“紧贴裁剪；为保持正方形，Muse/dsh 上下保留约 20/14px 透明边”。
