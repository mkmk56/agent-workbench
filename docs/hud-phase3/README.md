# Agent HUD 第三期截图证据（侧栏 + 纸飞机）

> 采集日期：2026-11-14
> 环境：Windows 11，构建后的 Electron GUI（`npm run build` 后 `electron .`），连接生产引擎 `127.0.0.1:8080`。
> 方法：GUI 以 `--remote-debugging-port=9222` 启动，用 CDP `Input.dispatchMouseEvent` 悬停槽位、`Page.captureScreenshot` 截图；**全部数据来自真实引擎**（`agent_info` / `task_list` / `list_messages`），没有示例数据或模拟状态。
> 截图目录：`data/hud-verify/` 为原始帧（已 gitignore）；本目录只保留代表帧。

## 1. 四态验证

| 状态 | 截图 | 真实数据依据 |
|---|---|---|
| 空闲 | `02-state-idle.png` | dsh 无活跃任务；它上一次真实失败（任务 `8dc8aa3b`，15:01:29）已超过 15 分钟窗口，所以不再算“出错”。悬停卡显示活跃任务 0、本轮用时 —。 |
| 干活中 | `03-state-working.png` | claude 有活跃任务 `a5d3198f-a301-43e1-80b2-3c099182b224`（本会话，WORKING）；悬停卡显示模型 `deepseek-v4.1-flash`、活跃 1、本轮用时。Muse 同时因引擎有任务而显示干活中。 |
| 等你输入 | `04-state-waiting.png` | 两个真实线程达到 10 条 agent 消息上限并进入 `WAITING_USER`（`a5d3198f…`、`a78cd852…`）；`list_messages` 返回 `waiting_for_user: true`，Muse 槽位因此显示“等你输入”。 |
| 出错 | `05-state-error.png` | dsh 真实任务 `bc86976f-8ce1-4f47-ad77-f767bd95cb00` 在 15:30:44 以 `timeout after 1000 ms` 失败（tokens 输入 0 / 输出 0）；悬停卡显示“最近任务失败（… 分钟前）”。 |

## 2. 未读、排队与跳转

- `06-planes-outbound.png`：10 条真实的 claude→dsh 消息（`deliver:false`）触发纸飞机；dsh 槽位未读数 20（两个线程各 10 条），左下角 Mail 角标表示还有消息在排队。
- `07-planes-return.png`：5 条真实的 dsh→claude 消息（`deliver:false`）让纸飞机反向飞行；claude 未读数 5，虚线尾迹、弧线与机头朝向可见，目标环闪一次。
- `08-click-jump.png`：点击 dsh 槽位后跳到它的最新任务详情 `#/tasks/bc86976f-8ce1-4f47-ad77-f767bd95cb00`，未读清零；截图右上角面包屑即任务 ID。

## 3. 真实消息 ID（可复核）

- 线程 `a5d3198f-a301-43e1-80b2-3c099182b224`：`c4d01e77-291b-4bdd-a60b-496403f1d13e`（1/10）… `4a75df02-0908-4001-b5fb-1a3b3911fefc`（10/10，`held`，线程 `WAITING_USER`）。
- 线程 `a78cd852-353f-496b-b2e9-31cddeef7617`：`41c0a0ed-4a6c-41ab-b63c-963d29cf8f1b`（1/10）… `bce3eaef-d984-42ea-ba9b-a711d394227d`（10/10，`held`，线程 `WAITING_USER`）。
- 线程 `bc86976f-8ce1-4f47-ad77-f767bd95cb00`：`8fd2a86b-87e0-4a0f-8c31-c5b4ebd7aeb6` … `885b62fc-616c-4bdf-a6af-28b985c32d1a`（dsh→claude，5 条，均 `stored`）。

这些消息是**验证用真实消息**，summary 已明确标注“忽略；用于验证”。它们留在生产 SQLite 中，未做删除。

## 4. 开关配置

- 主进程持久化 `%APPDATA%\agent-workbench\hud.json`，默认 `{"paperPlanes": true}`。
- 通过 IPC 实测：`getHudConfig()` → `{paperPlanes:true}`；`setHudConfig({paperPlanes:false})` → `false`；再设回 `true` 后文件内容为 `{"paperPlanes": true}`。第五期设置页只需调用 `useHudConfig().setPaperPlanes` 暴露开关。

## 5. 已知限制（如实记录）

- `list_messages` 按 `created_at ASC` 返回前 N 条；GUI 取 500 条并在前端保留最后 300 条。历史超过 500 条后，新消息可能不在窗口内；根治需要引擎侧增加 `since`/倒序参数，本期不改引擎消息逻辑。
- 未读状态保存在渲染进程内，重载/重启 GUI 后从当前消息重新建立基线，不跨重启保留。
- Muse 没有直接 API；“干活中 / 等你输入”是按引擎任务与 `WAITING_USER` 间接推导的，悬停卡文字已注明。
- 截图中的“等你输入”来自验证消息把线程推到 10 条上限；这是真实引擎行为，不是模拟。
- 纸飞机截图是静帧；同屏最多 3 架的并发上限由 `PaperPlaneLayer` 的 `MAX_ACTIVE = 3` 控制，超出部分在发送方显示 Mail 队列角标。