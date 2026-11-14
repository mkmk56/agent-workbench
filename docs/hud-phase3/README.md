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

- `list_messages` 按 `created_at ASC` 返回**最旧**的 N 条；GUI 取 500 条并在前端保留最后 300 条。**消息总数超过 500 条后，新消息确定不会进入窗口，未读与纸飞机停止更新，重启 GUI 也不能恢复**。这是确定性降级，不是偶发遗漏；HUD 的 Muse 悬停卡会在窗口饱和时显示警告。根治需要引擎侧增加 `since`/倒序参数，本期不改引擎消息逻辑。
- 未读状态保存在渲染进程内，重载/重启 GUI 后从当前消息重新建立基线，不跨重启保留。未读定义为“GUI 基线之后的新消息”，不等同于引擎投递状态；`held` 也计入未读，因为它需要用户注意。
- Muse 没有直接 API；“干活中 / 等你输入”是按引擎任务与 `WAITING_USER` 间接推导的，悬停卡文字已注明。
- 截图中的“等你输入”来自验证消息把线程推到 10 条上限；这是真实引擎行为，不是模拟。
- 纸飞机截图是静帧；同屏最多 3 架的并发上限由 `PaperPlaneLayer` 的 `MAX_ACTIVE = 3` 控制，超出部分在发送方显示 Mail 队列角标。
- 窗口宽度 ≤900px 时 HUD 整体隐藏（`hud.css` 媒体查询），纸飞机此时没有可用的槽位坐标，飞行会被静默丢弃；最大窗口宽度下不影响。
- **截图尺寸与采集**：`01`、`08` 为 2139×1296 整窗；`02`–`05` 为 1140×1020 的悬停局部（缩放 2×）；`06`–`07` 为 480×720 的 HUD 局部（最近邻放大 2×）。采集时间：`02` 在 15:16–15:30 之间（早于 `bc86976f` 失败），`03`–`05` 在 15:29–15:40 之间，`06`–`07` 在 15:32–15:34 之间。全部由构建版 Electron + CDP 截图，非手绘。
## 6. 品牌身份图标与居中（2026-11-14 用户补充）

- 用户提供的三张身份图已下载到 `gui/src/assets/sidebar/source/`（`muse.png`、`claude.png`、`dsh.png`），不依赖 2026-11-16 后可能失效的临时链接。
- 实际显示的是 `gui/src/assets/sidebar/*-mark.png`：从源图中央提取**中性白色**标志，去掉源图自带的彩色进度弧、角标、彩色徽章与深色底板，背景透明，紧贴外接框裁剪并留 1px 透明边。处理方式见该目录 `README.md`。
- 源图里的弧线和角标只是状态示意，**没有**在 UI 中重复绘制；状态仍由侧栏自己的 2px 环、状态角标（Play / Hourglass / TriangleAlert / Circle）和悬停卡文字表达。
- 居中修正：
  - 胶囊宽度改为 `60px = 44px 槽位 + 2 × 8px padding`（原 `56px` 的内容盒只有 40px，槽位 44px 会溢出并造成视觉偏心）；
  - `.hud` 使用 `align-items: center`，槽位 `flex: none`，按钮 `display: grid; place-items: center`；
  - 图标为 24×24 盒子 + `object-fit: contain; object-position: center`，不使用任何目测偏移。
  - CDP 实测几何：三个槽位的图标中心与按钮中心偏差均为 `dx = 0, dy = 0`；槽位距胶囊左边 `8px`，胶囊宽 `60px`。
- 证据：`09-identity-icons-light.png`（浅色，含 Muse 悬停卡）与 `10-identity-icons-dark.png`（深色，深色下胶囊提升到 `--surface` 并加强描边）。

## 7. 第三期独立评审必须修项修正（2026-11-14）

- **M1**：`list_messages` 超过 500 条后，新消息确定不会进入窗口，未读/纸飞机停止更新且重启不能恢复。HUD 现在在窗口饱和时于 Muse 悬停卡显示明确警告；会话结论流也会显示饱和提示；文档措辞已改为“确定性降级”。根治仍需要引擎侧 `since`/倒序参数，本期不改引擎消息逻辑。
- **M2**：引擎 `starting` 或 `agent_info` 首次读取失败不再显示红色“出错”；分别显示“连接中”“状态未知”，只有 `agent_info` 成功返回且 `available:false` 或引擎真实离线时才进入错误态。
- **M3**：更正第三期记录——提交 `b3b10f6` **没有**修改 `gui/src/lib/engine.ts`；该文件是在后续第四期（`useTaskMessages`、审批包装）中才修改的。`RESUME.md` / `DAILY_LOG.md` 的新区块会记录此更正。
- 同时处理：N4（0ms timer 清理）、N5（`aria-describedby`）、N6（working/idle 状态角标）、N7（深色主题胶囊与截图）、N11（配置写入失败不产生未处理拒绝）、N13（reduced-motion 保留无位移淡出）。
