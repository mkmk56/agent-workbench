# Agent HUD 第三期独立评审：左侧胶囊侧栏 + 纸飞机动画

> 评审对象：分支 `gui/v0.1`，提交 `b3b10f6`（`feat(gui): add Agent HUD sidebar and paper-plane animation`）
> 评审方：独立评审者（非实现方，只读）
> 评审日期：2026-11-14
> 环境：Windows 11，Node v22.20.0，仓库根 `D:\Claude\agent-workbench`
> 结论：**CONDITIONAL PASS（有条件通过）** — 核心功能成立、数据真实、未越界改引擎；有 **3 个必须修**（M1–M3）与 14 个非阻塞项（N1–N14）。

---

## 0. 只读声明与评审范围

- 本次只**读**代码、文档、截图元数据与生产 SQLite（`data/workbench.db`，`readOnly:true`）；未修改任何源码、配置、签名、引擎逻辑；未删除文件；未提交、未推送；未调用 claude/dsh；未重启生产 `:8080`。
- 唯一写入文件：本报告 `docs/AGENT_HUD_PHASE3_REVIEW.md`。
- 评审对象以 **提交 `b3b10f6` 为准**，通过 `git show b3b10f6:<path>` 读取。当前工作区存在**未提交的第四期 WIP**（见 N14），已排除在评审结论之外，但作为流程项记录。
- 评审方模型无图像输入能力，**无法逐像素查看 8 张 PNG**；已核验文件存在性、尺寸、提交/mtime，并核对了截图声称依赖的真实生产数据（任务状态、线程状态、消息 ID）。此局限已在 §6 说明。

---

## 1. 结论

**CONDITIONAL PASS。**

- 四态推导确实只使用真实引擎数据（`agent_info` / `task_list` / `list_messages`），Muse 的间接推导有文字标注；15 分钟失败窗口不会把旧失败永久显示为出错。
- 未读计数、点击清零、纸飞机弧线/虚线尾迹/切线朝向/`MAX_ACTIVE=3`/180ms 排队/落地环闪/Mail 角标均按规格落地；`prefers-reduced-motion` 与配置关闭有降级；Canvas/RAF/定时器清理基本正确，StrictMode 双挂载未发现重复动画。
- 配置默认 `paperPlanes:true`、写入 `userData/hud.json`、IPC 有白名单与参数校验，第五期设置页可复用 `useHudConfig` 共享 store。
- IPC 新增 `engine:message-list` 为只读，未改引擎消息/审批逻辑，未越界。
- **但**：① 生产消息数超过 500 后，未读与纸飞机将**确定性且不可自愈地**停止更新，现行文档严重低估；② 引擎 `starting` 或 `agent_info` 首次失败时，两个执行器会被误报为红色“出错”；③ 第三期记录声称修改了 `gui/src/lib/engine.ts`，但该提交并未包含此文件。

---

## 2. 必须修项

### M1 — `list_messages` 的 ASC + 500 上限会让未读/纸飞机在消息累计超过 500 条后永久冻结（文档低估 + 无可见降级）

- **文件:行**
  - `gui/src/lib/hud.ts:48-49`（`MESSAGE_LIMIT = 500`、`MESSAGE_TAIL = 300`）
  - `gui/src/lib/hud.ts:302`（`listMessages(MESSAGE_LIMIT)`）
  - `gui/src/lib/hud.ts:311`（`...slice(-MESSAGE_TAIL)`）
  - `gui/src/lib/hud.ts:314-328`（基线 + `fresh` 计算）
  - `gui/electron/main.ts:338-341`（`engine:message-list` 上限 500）
  - `docs/hud-phase3/README.md:38`（现行措辞：“可能不在窗口内”）
- **证据**
  - 引擎侧：`src/store.js:341` 为 `SELECT * FROM messages ... ORDER BY created_at ASC, id ASC LIMIT ?`；`src/tools.js:172` 的 `limit` 上限为 500。即 `list_messages` 返回的是**最旧的 500 条**，不是最新的。
  - 渲染侧：`hud.ts:311` 对返回结果取 `slice(-300)`，得到的是“最旧 500 条中的最后 300 条”。当 `messages` 总行数 > 500 后，新写入的消息**永远不会**进入这 500 条窗口，`seenMessages` 也永远看不到它们，`fresh` 恒为空 → 未读计数与纸飞机永不再触发；**重启 GUI 也一样**（基线仍是同一批旧消息）。
  - 现行 `README.md:38` 写作“历史超过 500 条后，新消息**可能**不在窗口内；根治需要引擎侧增加 `since`/倒序参数”。实际是**超过 500 条后必然、且不可通过重启恢复**，措辞明显低估。
  - 只读核验：当前生产库 `messages` 共 **28** 条，尚未触发；但这是确定性阈值，不是概率问题。
- **建议修法**（不改引擎消息写入逻辑，符合本期边界）
  1. 把 `docs/hud-phase3/README.md:38`、`RESUME.md` O.7、`DAILY_LOG.md` 已知限制改写为准确描述：**超过 500 条后未读/纸飞机确定失效且重启不能恢复**，属“功能降级”而非“偶发遗漏”。
  2. 在 `hud.ts` 增加饱和检测：当 `result.data.messages.length === MESSAGE_LIMIT` 时，在 Muse 悬停卡（或全局 HUD 提示）显示“消息窗口已满，未读/纸飞机可能停止更新”，让用户可见。
  3. 在第四/五期排期引擎侧 `since` 或 `DESC` 参数作为根治，并在本报告中作为遗留项跟踪。
- **为何必须修**：这不是可选优化，而是核心 HUD 在数据增长后**静默失效**；文档又把它写成“可能”，会误导后续验收。

### M2 — 引擎 `starting` 或 `agent_info` 首次失败会把两个执行器误报为红色“出错”

- **文件:行**
  - `gui/src/lib/hud.ts:109-116`（`!engine.healthy` → “引擎离线”；`agentsLoaded && meta == null` → “引擎未返回该执行器信息”）
  - `gui/src/lib/hud.ts:396`（`agentsLoaded = !agentState.loading`）
  - `gui/src/lib/engine.ts:103-109`（`agent_info` 失败时 `agents` 保持旧值；若首次即失败则为空数组，`loading` 仍置 false）
- **证据**
  - `agent_info` 失败时 `useAgentInfo` 不会把“加载失败”与“执行器不可用”区分开：首次失败 → `agents=[]`、`loading=false` → `meta==null` → 两个槽位同时进入 `error`，文案为“引擎未返回该执行器的信息。”。
  - 引擎处于 `starting` 时 `engine.healthy=false`，`agentSlot` 直接进入 `!engine.healthy` 分支，文案为“引擎离线，无法读取执行器状态。”——但顶栏此时显示的是“引擎启动中”。
  - 结果：真实数据并未表明执行器异常，HUD 却给出红色“出错”，违反“缺数据/未就绪时不生成假状态”的数据原则。
- **建议修法**
  1. 把 `engine.state === 'starting'` 单独处理为中性“启动中”（不进入 `error`）。
  2. 向 `agentSlot` 传入 `agentState.error`（或“成功加载过”的标志）：仅当 `agent_info` **成功返回**且对应 agent `available === false` 时才置 `error`；加载失败时显示“状态未知/读取失败”，保留旧状态或中性态。
  3. 单测/自检覆盖：首次 `agent_info` 失败、引擎 `starting`、`available:false` 三种输入分别得到“状态未知”“启动中”“出错”。

### M3 — 第三期记录声称修改 `gui/src/lib/engine.ts`，但提交 `b3b10f6` 未包含该文件

- **文件:行**
  - `RESUME.md:688`（`| gui/src/types.ts、gui/src/lib/engine.ts | 修改 | 消息列表/消息类型/HUD 配置类型 |`）
  - `DAILY_LOG.md:1554`（`| gui/src/types.ts、gui/src/lib/engine.ts | 新增消息列表、消息、HUD 配置类型 |`）
- **证据**
  - `git show --name-only --format='' b3b10f6` 的文件清单中**没有** `gui/src/lib/engine.ts`。
  - `git diff 970c43e b3b10f6 -- gui/src/lib/engine.ts` 输出为空。
  - 实际第三期实现是在 `gui/src/lib/hud.ts:9` 引入 `useAgentInfo/useTaskList`，并在 `hud.ts:302` 直接调用 `window.workbench.listMessages(...)`；`lib/engine.ts` 的 `listMessages` 包装是当前**未提交的第四期 WIP**（见 N14）。
- **建议修法**：把 `RESUME.md` O.2 与 `DAILY_LOG.md` 改动表中的 `gui/src/lib/engine.ts` 删除或改为“未改；`hud.ts` 直接调用 preload 暴露的 `listMessages`”。文档必须与提交内容一致。

---

## 3. 非阻塞项

| 编号 | 文件:行 | 问题 | 建议 |
|---|---|---|---|
| N1 | `gui/src/lib/hud.ts:280-281`；`gui/src/pages/TasksPage.tsx:60`；`gui/src/components/AppFrame.tsx:88` | HUD 独立实例化 `useAgentInfo(30s)` 与 `useTaskList(200,4s)`，与页面自身的 `useTaskList(200,5s)` / `useAgentInfo(30s)` **重复轮询**（任务页同时有两个 `task_list`，多数页面有两个 `agent_info`），再加每 3s 的 `list_messages`。 | 将引擎状态/任务/消息下沉为共享 store 或 Context，HUD 与页面订阅同一份数据；至少让 HUD 复用页面 `task_list` 结果或降低频率。 |
| N2 | `gui/src/lib/hud.ts:302`；`src/messages.js:138-159,450` | 每 3s 拉取最多 500 条**完整消息**（含 `summary` 全文，单条上限 500 token），而 HUD 只需要 `message_id/from/to/created_at/thread_state`。消息多时 JSON 与 IPC 体积可达数百 KB～MB 级。 | 引擎侧提供精简投影或 `fields`/`since` 参数；HUD 侧只取必要字段。与 M1 的 `since` 一并规划。 |
| N3 | `gui/src/components/AgentHud.tsx:186-189` | `messagesError` 只显示在 **Muse** 悬停卡；`list_messages` 失败时 claude/dsh 的未读与纸飞机同样陈旧，却没有提示。 | 在 HUD 全局或每个受影响槽位提示，或至少在 Muse 提示中说明影响范围（已部分说明）。 |
| N4 | `gui/src/components/PaperPlaneLayer.tsx:257` | `window.setTimeout(pump, 0)` 的 timer id 未保存；组件卸载后仍可能触发一次 `pump`（可能再排 `pumpTimer`/`ensureLoop`），清理函数只清 `pumpTimer.current`。 | 保存该 timeout id 并在 unmount 清理，或用统一的 timer 集合。 |
| N5 | `gui/src/components/AgentHud.tsx:52,139` | `role="tooltip"` 的悬停卡没有通过 `aria-describedby` 绑定到按钮；键盘用户能聚焦按钮，但读屏不会朗读卡片内的模型/用时/详情。 | 给按钮加 `aria-describedby` 指向 popover id；或把卡片内容并入 `aria-label`（当前 label 已含状态/活跃数/未读/排队，核心信息可读）。 |
| N6 | `gui/src/components/AgentHud.tsx:22-25` | 品牌 §6.1 要求“进度环颜色 + **状态角标图形** + 悬停卡文字”三重编码；当前 `STATE_ICONS` 只对 `waiting`/`error` 提供角标，`idle`/`working` 没有角标图形。 | 为 `working`/`idle` 补一个角标（如 `Loader`/`Circle`）或明确在文档中说明“环弧形状本身即图形编码”。 |
| N7 | `gui/src/styles/hud.css:17`；`docs/DESIGN_SYSTEM.md:71` | 深色主题下 `--bg` 也是 `#1E2126`，HUD 胶囊同为 `#1e2126`，仅靠 1px `rgba(245,243,238,0.10)` 描边与一个在深色上看不见的阴影区分；8 张截图无深色主题。 | 补一张深色主题截图；深色下把描边提到可辨识对比度（如 `0.18`–`0.24`）或给胶囊列加 `--surface` 底。文字对比本身达标（Paper/Ink 14.56:1）。 |
| N8 | `gui/src/styles/hud.css:351-355`；`gui/src/components/PaperPlaneLayer.tsx:31-38,206-215` | `max-width:900px` 时 HUD 整体 `display:none`，但 `PaperPlaneLayer` 仍在运行；`buildPlane` 对隐藏槽位取到零矩形，`length<1` 返回 null，该次飞行被静默丢弃且不触发落地闪。README 未记录“窄屏隐藏 HUD”。 | 在 README 已知限制补“≤900px 隐藏 HUD 与动画”；或在 HUD 隐藏时直接不生成 flights。 |
| N9 | `gui/src/lib/hud.ts:331-339` | 未读统计对所有 `to=claude/dsh` 的非 user 消息计数，包括 `held`（未投递）与 `answered`。`held` 语义上从未送达接收方，却计入“未读”。 | 在文档中明确定义“未读 = GUI 基线之后的新消息，不等于引擎投递状态”；或按需排除 `held`。 |
| N10 | `gui/src/lib/hud.ts:70-72,105-107` | `useTaskList(200)` 只取最新 200 条任务；若某 agent 长期无任务（超出 200 条），会显示“暂无任务。”，而非“最近任务在更早历史中”。当前生产库共 66 条任务，暂不触发。 | 文案改为“最近 200 条任务中无记录”，或在 HUD 中按 agent 单独查询。 |
| N11 | `gui/src/lib/hud.ts:249-257` | `setPaperPlanes` 未 `try/catch`；主进程写盘/IPC 失败时 Promise 会 reject。第五期设置页若无错误处理会出现未捕获拒绝。 | 包 `try/catch`，失败时保留旧值并向设置页返回错误。 |
| N12 | `docs/hud-phase3/README.md:12,19-21`；`docs/hud-phase3/*.png` | 截图尺寸不一致：`01`/`08` 为 2139×1296，`02`–`05` 为 1140×1020，`06`–`07` 为 480×720（后两者明显是局部裁剪）；README 未说明哪些是裁剪帧，也未给出每张的**采集时间/命令**。`02-state-idle` 的“上一次失败已超过 15 分钟”只在 `bc86976f` 创建（15:30:43）**之前**成立，依赖时间窗口但未标注。 | 在 README 标注裁剪/缩放与每张采集时间；为 `02` 注明“采集于 15:16–15:30 之间”。 |
| N13 | `gui/src/styles/hud.css:357-365`；`PaperPlaneLayer.tsx:302-310` | reduced-motion 下不飞、只调 `onArrive` 触发 `.hud-slot__flash`，但同一媒体查询把 flash 动画 `display:none`，因此 reduced-motion 用户**没有任何到达提示**（仅未读数字变化）。 | reduced-motion 下保留一个无动画的短暂描边或依赖未读角标即可；至少在文档中说明。 |
| N14 | 工作区 | `git status` 显示 `gui/electron/engine.ts`、`main.ts`、`preload.ts`、`gui/src/lib/engine.ts`、`hud.ts`、`TaskDetailPage.tsx`、`types.ts` 已修改，并有未跟踪 `gui/src/components/ConversationPanel.tsx` ——这是**第四期 WIP**（会话面板、`useTaskMessages`、`listMessages({limit,taskId})`），不属于 `b3b10f6`；评审期间该工作区仍在被另一进程改动（又出现 `gui/src/main.tsx`、`conversation.css`）。 | 提交前确认这些 WIP 不会混入第三期提交；本报告已按 `git show b3b10f6` 评审。 |

---

## 4. 逐项核查表

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 四态（空闲/干活中/等你输入/出错）只用真实引擎数据 | ✅ 通过 | `hud.ts:89-197` 只用 `agent_info`（`available/model`）、`task_list`（`state/updated_at`）、`list_messages`（`waiting_for_user`）；无硬编码假状态。 |
| 2 | 15 分钟失败窗口合理、不永久显示旧失败 | ✅ 通过 | `hud.ts:47,133-139`：仅当 `latest.state==='FAILED'` 且 `updated_at` 在 15 分钟内才 `error`；否则回落 `idle`。`latest` 为最新任务，若更新的任务已完成/运行则不误报。 |
| 3 | Muse 间接推导如实标注 | ✅ 通过 | `hud.ts:159-197`；悬停卡 detail 明写“通过引擎任务活动间接感知”“线程处于 WAITING_USER”；README:40 一致。 |
| 4 | 未读计数语义（发给 agent / 发给 user→Muse；user 发出不计） | ✅ 基本通过 | `hud.ts:330-345`：`from==='user'` 跳过；`to` 为 claude/dsh 计入对应槽；`to==='user'` 计入 Muse。 |
| 5 | 点击清零 | ✅ 通过 | `AgentHud.tsx:113-120` `openSlot` → `markRead(slot.id)` → `hud.ts:384-386` 置 0。 |
| 6 | 重复计数 / 漏计 | ⚠️ 受 M1 限制 | 正常窗口内以 `seenMessages` 基线 + `fresh` 去重，无重复；但总消息 >500 后**漏计全部新消息**（M1）。 |
| 7 | 跨线程 / 跨 agent 边界 | ✅ 通过 | `list_messages` 不带 thread 过滤，统计所有线程；按 `to` 归属槽位；线程 `held`/`answered` 计入（见 N9）。 |
| 8 | 重载后基线行为可接受 | ✅ 通过（已记录） | `hud.ts:314-319` 首次成功轮询设为基线，历史不回放；README:39 已说明“不跨重启保留”。 |
| 9 | 纸飞机二次贝塞尔弧线 | ✅ 通过 | `PaperPlaneLayer.tsx:40-79`：P1=中点+垂直向内 `length*0.25`。 |
| 10 | 虚线尾迹（4/6、#8A8F98、0.45、落地 400ms 淡出） | ✅ 通过 | `PaperPlaneLayer.tsx:96-121,262-269`。 |
| 11 | 机头朝切线 | ✅ 通过（与规格 +45° 略异） | `PaperPlaneLayer.tsx:89-94,123-147` 直接按切线旋转；规格 §5 写 `angle+45°`，属实现约定差异，视觉正确。 |
| 12 | `MAX_ACTIVE=3` + 180ms 排队 + Mail 角标 | ✅ 通过 | `PaperPlaneLayer.tsx:21-22,200-224`；`hud.ts`/`AgentHud.tsx:167-175` 队列角标。 |
| 13 | 落地环闪 | ✅ 通过（400ms vs 规格 300ms） | `PaperPlaneLayer.tsx:254-257`；`hud.css:174-193`。 |
| 14 | `prefers-reduced-motion` / 配置关闭降级 | ✅ 通过（见 N13） | `PaperPlaneLayer.tsx:302-310`；`hud.css:357-365`；`hud.ts:347-362` 配置关不发 flight。 |
| 15 | Canvas 生命周期、RAF/定时器清理 | ✅ 基本通过（N4） | `PaperPlaneLayer.tsx:318-348` 清理 RAF/pumpTimer；`:257` 的 0ms timeout 未纳入清理。 |
| 16 | StrictMode 双挂载是否重复动画/泄漏 | ✅ 通过 | `initialized/seen` ref 保留，二次 effect `fresh` 为空；`ensureLoop` 去重；`pump` 先清旧 timer；RAH 在 cleanup 取消。 |
| 17 | `hud.json` 默认 `paperPlanes:true` | ✅ 通过 | `main.ts:41`（`DEFAULT_HUD_CONFIG`）、`:43-55` 读取、`:57-70` 原子写入；本机 `%APPDATA%\agent-workbench\hud.json` 实为 `{"paperPlanes": true}`。 |
| 18 | IPC 白名单校验 | ✅ 通过 | `main.ts:154-161` `handle` + `isTrustedSender`；`:325-326` hud 配置；`:338-341` message-list，`optionalInteger(limit,1,500,500)`。 |
| 19 | 第五期复用 `useHudConfig` 共享 store | ✅ 通过 | `hud.ts:199-260` 模块级 `sharedConfig` + listeners + `setPaperPlanes`；设置页同窗口可直接复用。 |
| 20 | 品牌禁用项（发光/渐变/玻璃/emoji） | ✅ 通过 | `hud.css` 无 gradient/glow/backdrop-filter；图标全为 lucide 线性；`BRAND_GUIDELINES.md:155-165` 例外与代码一致。 |
| 21 | 身份只用形状 | ✅ 通过 | `AgentHud.tsx:16-20`：Cloud/Sparkles/Terminal，颜色只表状态。 |
| 22 | 状态颜色+图形+文字 | ⚠️ 部分通过 | 环色都有；角标图形仅 waiting/error（N6）；文字在悬停卡（可读）。 |
| 23 | aria-label、焦点可见 | ✅ 通过（N5） | `AgentHud.tsx:139` `aria-label` 含名称/状态/活跃/未读/排队；`hud.css:47-50` `:focus-visible` 2px 描边。tooltip 未 `aria-describedby`（N5）。 |
| 24 | 悬停卡边缘溢出 | ✅ 通过 | `hud.css:196-228` 首/末槽位改 top/bottom，`max-width:calc(100vw-120px)`。 |
| 25 | 窄屏 | ✅ 可用但隐藏（N8） | `hud.css:351-355` ≤900px `display:none`；README 未记。 |
| 26 | 深色主题 | ⚠️ 待补证（N7） | 文字对比达标；胶囊与深色背景同色，仅 1px 低透明描边；无深色截图。 |
| 27 | `engine:message-list` 只读、未改引擎消息/审批 | ✅ 通过 | `tools.js:162-174` `messages.list` 只读；提交无任何 `src/` 改动（`git show --name-only b3b10f6`）。 |
| 28 | 截图与文档是否夸大/缺证 | ⚠️ 部分通过（N12、M3） | 8 张 PNG 存在且已提交；DB 佐证消息 ID/线程计数；但尺寸不一（裁剪未披露）、无逐张时间、`lib/engine.ts` 改动记录失实。 |
| 29 | 已知限制记录充分性 | ❌ 不充分（M1） | 500 条窗口被写成“可能”，实际确定性失效；深色/窄屏未记录。 |
| 30 | 性能（500 条/3s） | ⚠️ 有风险（N1/N2） | 每 3s 拉 500 条完整消息并叠加重复轮询；当前 28 条尚可。 |

---

## 5. 复跑命令与结果

| 命令 | 结果 |
|---|---|
| `git show --stat b3b10f6` | 23 files changed, 1666 insertions(+), 1 deletion(-)；全部在 `gui/`、`docs/`、`RESUME.md`、`DAILY_LOG.md`。 |
| `git show --name-only --format='' b3b10f6` | 无任何 `src/` 文件；**无** `gui/src/lib/engine.ts`（对应 M3）。 |
| `git diff 970c43e b3b10f6 -- gui/src/lib/engine.ts` | 空输出。 |
| `cd gui && npm run typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.electron.json`，**EXIT=0**。 |
| `node -v` | v22.20.0 |
| 截图尺寸（System.Drawing） | 01:2139×1296；02–05:1140×1020；06–07:480×720；08:2139×1296（对应 N12）。 |
| 生产库只读（`node:sqlite`，`readOnly:true`） | `messages` 28 条；`a5d3198f…` 10 条（1 held）、`a78cd852…` 10 条（1 held）、`bc86976f…` 5 条（dsh→claude）；README 列出的 6 个消息 ID 全部存在且状态一致。 |
| `%APPDATA%\agent-workbench\hud.json` | `{"paperPlanes": true}`。 |

> 说明：`typecheck` 是在当前工作区（= `b3b10f6` + 第四期 WIP，见 N14）上运行并通过；`b3b10f6` 是其子集。未运行 `npm run build`（会写 `dist/`，用户只授权 `typecheck`）。

---

## 6. 额度 / 环境说明与局限

- **额度**：本次评审未调用 claude/dsh LLM，未产生模型额度消耗；额度本身不可直接观测，**不记录虚构百分比**。
- **未做**：未修改任何源码/配置/签名/引擎逻辑；未删除文件；未提交或推送；未重启生产 `:8080`；未运行 `npm run build`；未调用其他任务。
- **生产数据**：`a5d3198f…`、`a78cd852…`、`bc86976f…` 线程的验证消息**未删除**，只读查询确认仍在库中（见 §5）。
- **图像局限**：评审模型无图像输入能力，未逐像素查看 8 张 PNG；结论中的“截图内容”以 README 描述、文件元数据与真实 DB 数据交叉核对为准。建议实现方在第四期前人工目视复核 `01`/`08` 的整窗与 `06`/`07` 的纸飞机细节。
- **工作区状态**：当前有未提交的第四期 WIP（N14）；本报告已明确以 `b3b10f6` 为评审对象。

---

## 7. 附录：生产库只读核验摘要（2026-11-14）

- `messages` 总计 **28** 条；按线程：
  - `a5d3198f-a301-43e1-80b2-3c099182b224`：10 条，claude→dsh，末条 `4a75df02-…` **held**；线程 `WAITING_USER`。
  - `a78cd852-353f-496b-b2e9-31cddeef7617`：10 条，claude→dsh，末条 `bce3eaef-…` **held**；线程 `WAITING_USER`。
  - `bc86976f-8ce1-4f47-ad77-f767bd95cb00`：5 条，dsh→claude，均 `stored`。
- 任务：`a5d3198f…` claude WORKING；`bc86976f…` dsh FAILED（created 15:30:43，updated 15:33:28）；`8dc8aa3b…` dsh FAILED（updated 15:01:29）；`e8e6a880…` dsh WORKING（created 15:39:54，**晚于**提交 15:39:30）。
- 据此，`02-state-idle` 中的“上次失败 8dc8aa3b 已超 15 分钟”只在 15:16:29–15:30:43 之间成立；`05-state-error` 的 `bc86976f` 在该窗口后成立。时间线自洽，但 README 未标注逐张采集时间（N12）。
- 当前任务总数 66（< 200），HUD 的 `task_list(200)` 暂不会漏掉各 agent 最近任务（N10 为潜在项）。
