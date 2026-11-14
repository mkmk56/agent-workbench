# Agent HUD 第四/五期与第三期补充独立评审

> 评审对象：分支 `gui/v0.1`，提交 `90296c9`（`feat(gui): add brand identity icons and finish HUD views`）
> 评审方：独立评审者（只读；非实现方）
> 评审日期：2026-11-14
> 环境：Windows 11，Node v22.20.0，仓库根 `D:\Claude\agent-workbench`
> 结论：**CONDITIONAL PASS（有条件通过）** — 核心功能成立、数据真实、未越界改引擎；有 **5 个必须修**（M1–M5）与 16 个非阻塞项。

---

## 0. 只读声明与评审范围

- 本次只**读**代码、文档、提交对象与生产 SQLite（`data/workbench.db`，`readOnly:true`）；未修改任何源码、配置、签名或引擎逻辑；未删除文件；**未提交、未推送**；未调用 claude/dsh；未重启生产 `:8080`。
- 唯一写入文件：本报告 `docs/AGENT_HUD_PHASE4_REVIEW.md`。
- 评审对象以 **提交 `90296c9` 为准**，关键结论用 `git show 90296c9:<path>` 复核；不以工作区文件代替提交内容。
- 评审期间工作区出现**未提交的后续改动**（16:14–16:21 之间陆续写入，详见 §7.2）：`gui/src/lib/hud.ts`、`gui/src/pages/SettingsPage.tsx`、`gui/src/components/ConversationPanel.tsx`、多份 README、`docs/hud-phase5/01-settings-hud.png`，以及新截图 `09-dark-sidebar.png`、`10-saturation-warning.png`、`01-conversation-overview.png`、`02-completed-result-and-cards.png`、`02-approval-pending.png`、`03-approval-allowed.png`。**这些改动不属于 `90296c9`，不计入本报告的通过项**，仅在 §7.2 作为流程事实记录。
- 评审方模型无图像输入能力；本报告对 PNG 的核验采用 Pillow 像素/通道统计与 Windows 内置 OCR（`zh-Hans-CN`）交叉验证，OCR 仅用于判断内容存在性，不作为逐字准确证据（OCR 会把数字/英文读错，例如把 `125,614` 读成 `125 14`）。
- 复跑命令与结果见 §5；额度、环境与局限见 §6；生产库只读核验摘要见 §7.1。

---

## 1. 结论

**CONDITIONAL PASS。**

**成立的部分**

- **第三期 M1/M2/M3 已实质修复**：500 条饱和检测已在 HUD Muse 悬停卡与结论流可见，文档主叙述改为“确定性降级”；`starting` / `agent_info` 首次失败 / `available:false` / 引擎离线四种输入分别落到“连接中 / 状态未知 / 出错 / 出错”；`lib/engine.ts` 的失实记录以追加方式更正，未回改历史区块。
- **身份图标**：源图已入库；`*-mark.png` 为**纯中性白**（RGB 全 255、100% 中性）透明 PNG，源图的彩色进度弧、角标、徽章未被带入（连通域核验）；胶囊 60px、按钮 `grid` 居中、图标 24×24 + `object-fit: contain` 成立，截图像素实测图标中心与槽位中心偏差 ≤0.17 CSS px。
- **第四期**：结论卡片只从 `task_status`、`task_logs` 的 system/warn 行与 `list_messages` 派生；stdout 不会被误判为错误；上下文占用条明确标注“参考”并读取设置；500 条饱和提示、`reply_to`/文件/问题/`WAITING_USER` 展示、两栏与窄屏堆叠均已实现。三张截图经 OCR + 生产库交叉核验为真实数据。
- **第五期**：设置页只读参数与 `agent_info` 同源且与引擎默认值一致；纸飞机与上下文值真实落盘（`hud.json` 含两字段）；审批三选一 IPC 只包装既有 `respond_approval`，参数校验（decision 枚举、task/approval id 正则、reason ≤4000）与可信来源校验完整；审批门默认关闭与“未做真实 pending 端到端验证”均如实记录。
- **范围/安全**：提交无任何 `src/` 改动、无签名/`spike/`/第一二期评审文件改动、无删除文件；新增 IPC 全部走既有 `handle()` + `isTrustedSender()` 白名单。

**必须修的问题（均为小改）**

1. 把会写入审批决定与用户回复的 `engine:respond-approval` 描述成“**只读**包装”，文档与结论流头部共 5 处；
2. 设置页在 `hud.json` 写入失败时仍提示“已保存/立即生效”；
3. 第五期截图被描述为“深色主题整窗”，实际是浅色主题；
4. 声称已修 N13（reduced-motion 保留无位移淡出），但全局 `animation-duration:.01ms !important` 使该淡出瞬时结束，落地提示仍不可见；
5. 图标“紧贴外接框裁剪、四周只留 1px”与实际不符（Muse/dsh 上下分别留了约 20/14px 透明边）。

上述 1、2 已影响用户/审计对“是否只读”“是否保存成功”的判断，3–5 属证据与声明准确性，均应在本期收口。

---

## 2. 必须修项

### M1 — 会写入状态的审批 IPC 被多处描述为“只读包装”

- **文件:行（提交 `90296c9`）**
  - `RESUME.md:771`：“调用新增的只读包装 IPC `engine:respond-approval`”
  - `RESUME.md:772`：“新增 IPC 只是对既有 `list_messages` / `respond_approval` 工具的只读/显式包装”
  - `docs/hud-phase5/README.md:13`：“调用新增的 `engine:respond-approval` IPC（只读包装 `respond_approval` 工具）”
  - `DAILY_LOG.md:1649`：“调用 `engine:respond-approval`（只读包装既有 `respond_approval` 工具）”
  - `gui/src/components/ConversationPanel.tsx:398-400`：结论流来源行写 “`task_status / task_logs / list_messages · 只读`”，但同一面板内就是三选一审批卡（`:438-487`）
- **证据**
  - `gui/electron/engine.ts:567-584` 通过 `callTool('respond_approval', …)` 调用引擎工具；`src/approvals.js:518-527` 在 `respond()` 中 `messages.send({ from:'user', … reply_to: approval.message_id, deliver:false })` 写入一条真实的用户回复消息，`:529` 调 `_finalize()`，`:539-552` 更新审批 `status/decision/responded_at`，`session` 决定还会写 `approval_grants`。这是**写操作**，不是只读。
  - `gui/electron/main.ts:380-406` 的 `engine:respond-approval` 同样是有副作用的 IPC；它只是“显式用户动作的包装”，不应标为只读。
  - 评审期间未提交的后续改动已把 `ConversationPanel.tsx` 的“· 只读”改为“· 引擎数据”，并把三处“只读包装”改为“显式包装；会写入审批决定，不是只读操作”——这反证了 `90296c9` 中的描述确有误。
- **建议修法**：统一改为“**显式用户操作包装（写入用户回复并终结 pending 审批，非只读）**”；结论流来源行改为“`task_status / task_logs / list_messages · 引擎数据（含审批操作）`”或等价表述。`hud:get/set-config` 与 `list_messages` 仍可保留“只读/配置写入”的准确措辞。

### M2 — 设置页在 HUD 配置写盘失败时仍提示“已保存/立即生效”

- **文件:行（提交 `90296c9`）**
  - `gui/src/lib/hud.ts:269-282`（`setPaperPlanes`）：`catch {}` 吞掉失败，返回 `void`，界面上 `paperPlanes` 保持旧值；
  - `gui/src/lib/hud.ts:284-296`（`setContextWindowTokens`）：同样吞错；
  - `gui/src/pages/SettingsPage.tsx:113-120`：`await hud.setPaperPlanes(value)` 之后**无条件**提示“配置已写入主进程 userData/hud.json，立即生效”；
  - `gui/src/pages/SettingsPage.tsx:132-137`：同样无条件提示“上下文参考值已保存”。
- **证据**
  - `hud:set-config` 在主进程侧会因数据目录不可写、`fs.renameSync` 失败等原因抛错（`gui/electron/main.ts:69-89`），该错误经 IPC 以 rejected promise 形式回到 `hud.ts`，被 `catch {}` 吞掉；`publishConfig` 不执行，开关/数值停留在旧值，但提示仍是成功。
  - 这是可复现的“UI 说成功、实际未保存”，且用户没有其它途径发现写盘失败。
- **建议修法**：`setPaperPlanes` / `setContextWindowTokens` 返回 `Promise<boolean>`（失败 `false`），设置页按结果给 success/error、失败时提示“写入 hud.json 失败，原配置保持不变”；可同时把开关回弹到旧值（它本来就不会变）。评审期间未提交的后续改动已按此方向修复，建议随最终提交一起落地。

### M3 — 第五期截图与实践描述不符：README 称“深色主题整窗”，提交内 PNG 是浅色

- **文件:行（提交 `90296c9`）**
  - `docs/hud-phase5/README.md:5`：“`01-settings-hud.png`（设置 → Agent HUD，深色主题整窗）”
  - `docs/hud-phase5/01-settings-hud.png`（提交 blob，292,502 bytes）
- **证据（像素统计 + OCR）**
  - 该 PNG 为 2,139×1,296；出现频率最高的颜色是纯白 `#FFFFFF`（1,775,051 px）与纸白 `#F5F3EE`（726,003 px），即浅色主题的页面/内容底；深色 token `#1E2126`、`#25292F` 不是背景色。
  - OCR 证实图片内容确实是“设置 → Agent HUD”分区（纸飞机动画、上下文参考上限 128000、引擎已启用、10 条、500 tokens、已开启、关闭（默认）、agent_info 已返回），只是配色为浅色。
  - 评审后期工作区把该文件换成了另一版（231,648 bytes，未提交），但仍是浅色（白色仍占多数），README 的“深色”措辞在未提交改动中也没有被修改。
- **建议修法**：二选一——(a) 重新采集一张深色主题的设置页整窗（并与 `02-approval-pending.png` 的深色口径一致）；(b) 把描述改为“浅色主题整窗”。证据说明必须与实际 PNG 一致。

### M4 — N13 声称已修，但 reduced-motion 下的落地提示实际仍不可见

- **文件:行（提交 `90296c9`）**
  - `gui/src/styles/hud.css:390-407`：reduced-motion 下把 `.hud-slot__flash` 改为 400ms 的 `hud-flash-fade`（只动 opacity）；
  - `gui/src/styles/brand.css:2101-2110`：全局 `@media (prefers-reduced-motion: reduce)` 对 `*` 设 `animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;`
  - 声明处：`RESUME.md:766`、`docs/hud-phase3/README.md:62` 均写“N13（reduced-motion 保留无位移淡出）”。
- **证据**
  - `hud.css` 的 `animation: hud-flash-fade 400ms …` 是普通声明，`brand.css` 的 `animation-duration: 0.01ms !important` 优先；动画在 0.01ms 内完成，`forwards` 填充停在 `opacity:0`，元素立刻不可见。
  - 评审时点的构建产物（`gui/dist/assets/index-*.css`，并行进程 16:19 构建）内同时存在 `.hud-slot__flash`、`hud-flash-fade` 与 `animation-duration:.01ms!important`，可确认级联结果。
  - 结果：reduced-motion 用户到达提示仍只剩“未读数字变化”，与 N13 描述不符（该 N13 在第三期评审中本是非阻塞项，但本期明确宣称已处理）。
- **建议修法**：给 `.hud-slot__flash` 豁免全局规则（例如在该选择器上 `animation-duration: 400ms !important`，或改用一次性 `opacity` 状态 + `setTimeout` 清除），**或**把文档改回“reduced-motion 下无到达提示，仅未读角标变化”。`docs/DESIGN_SYSTEM.md:327` 只要求“移除位移与循环动画，保留即时状态切换”，因此改文档也可接受。

### M5 — 图标“紧贴外接框裁剪、四周只留 1px”与实际 PNG 不符

- **文件:行（提交 `90296c9`）**
  - `gui/src/assets/sidebar/README.md:17`：“紧贴标志外接框裁剪，四周只留 1px 透明边”
  - `docs/hud-phase3/README.md:48`、`RESUME.md:750` 同述。
- **证据（Alpha 通道外接框实测）**
  - `muse-mark.png` 117×117，非透明内容 bbox `x 1..115, y 20..96` → 左右 1px，**上下各约 20px** 透明边；
  - `dsh-mark.png` 89×89，内容 bbox `x 1..87, y 14..75` → 左右 1px，**上下约 14/13px**；
  - `claude-mark.png` 62×62，内容 bbox `x 1..60, y 2..60` → 约 1–2px，基本符合。
  - 三张图四角 alpha=0、边界 alpha=0、内部为纯白 + 抗锯齿，透明与“中性白”描述**正确**；只有 muse/dsh 的方形画布为保持正方形留了上下透明边。
- **影响**：`object-fit: contain` 会等比缩放整张方图，透明边不改变渲染后的字形尺寸，因此**不影响视觉**；但“四周只留 1px”是事实错误，且会让后续维护误以为外接框是紧的。
- **建议修法**：把描述改为“紧贴标志外接框裁剪；为使画布为正方形，muse/dsh 上下保留透明边（约 20px / 14px）”，或按内容 bbox 重新导出非正方形图（渲染尺寸不变）。三处文档同步。

---

## 3. 非阻塞项

| 编号 | 文件:行（提交 `90296c9`） | 问题 | 建议 |
|---|---|---|---|
| N1 | `gui/src/lib/hud.ts:320-321`；`gui/src/components/AppFrame.tsx:88`；`gui/src/pages/TaskDetailPage.tsx:63-66` | HUD 常驻且独立轮询 `agent_info(30s)`、`task_list(200,4s)`、`list_messages(500,3s)`；任务详情页又各自轮询 `engine status(5s)`、`agent_info(30s)`、`task_status/logs(1.2s)`、`task_messages(4s)`。任务页同时最多 7 条轮询。 | 状态/任务/消息下沉为共享 store（HUD 与页面订阅同一份），或至少让 HUD 复用页面结果、降低频率。第三期 N1 仍未处理。 |
| N2 | `gui/src/lib/hud.ts:343` | 每 3s 拉最多 500 条**完整**消息（含 `summary` 全文），HUD 只需要少量字段；消息增长后 IPC/JSON 体积可达数百 KB～MB 级。 | 引擎侧提供精简投影或 `since`/倒序参数；与 M1 根治一并规划。第三期 N2 仍未处理。 |
| N3 | `RESUME.md:736`（O.7）；`DAILY_LOG.md:1589`（第三期旧区块） | 历史区块仍写“历史超过 500 条后新消息**可能**不在窗口内”，而 P.3/新区块已改“确定性”。主叙述已正确，但旧句没有交叉引用，单独阅读会低估。 | 在 O.7 / 旧区块后追加一句“以 P 节 / 本日新区块为准：确定性失效”，不回改原文。 |
| N4 | `gui/src/lib/engine.ts:102`（`useAgentInfo.refresh`） | `getAgentInfo()` 没有 `try/catch`；若 IPC promise 直接 reject（而非返回 `{ok:false}`），`loading` 会停在 `true`，HUD 落入 task 推导态而不是“状态未知”，同时产生未处理拒绝。 | 包 `try/catch`，失败时 `setError('…')` 并 `setLoading(false)`。正常 `{ok:false}` 路径已满足 M2。 |
| N5 | `gui/src/components/ConversationPanel.tsx:386-390` | 占用条分子是 `task.tokens.input`（多轮任务**累计输入** tokens），标签却是“上下文占用（参考）”；如 `a78cd852` 累计 125,614 / 128,000 = 98%，但单轮上下文远小于此。 | 标签改为“累计输入 tokens（参考）”或在 note 中说明分子是累计值；当前 note 只说明上限是参考值。 |
| N6 | `gui/src/lib/labels.ts:112-113`；`gui/src/components/ConversationPanel.tsx:59-70,280-318` | `stderr` 被映射为 `warn`，`findLog` 会扫描 `system`+`warn`。若执行器把 `timeout after 1000 ms` / `ENOENT` 之类文本写到 stderr，会生成假“任务超时/执行器错误”卡片。文档只保证“stdout 不误判”，这一点成立。 | 把匹配锚定到引擎 system 行的已知前缀，或只对 `system` 流匹配；至少在 README 说明 stderr 也在扫描范围。 |
| N7 | `gui/src/pages/SettingsPage.tsx:787,836-838,856-858` | `agent_info` 尚未返回时 `protocol`/`gate` 为 `null`，界面显示“引擎未启用”“关闭（默认）”，把“未知”呈现为“关闭”。 | 区分 `null` → “读取中…”；只有 `enabled === false` 才显示“关闭”。 |
| N8 | `docs/BRAND_GUIDELINES.md:164`；`docs/AGENT_HUD_SPEC.md:240,244-249`（未跟踪） | 品牌规范仍写“身份只用 `Cloud`/`Sparkles`/`Terminal`”，spec §4.3 同；实际已换成用户提供的 Muse/Claude/dsh 白色标识。状态三重编码与“不用颜色区分 agent”仍遵守。 | 把身份条目改为“用户提供的 Muse/Claude/dsh 标识（白色形状，仅本机身份识别）”；spec 若仍有效需同步，否则明确标注已被 2026-11-14 用户补充取代。 |
| N9 | `gui/src/styles/hud.css:16-18`；`docs/hud-phase3/README.md:51` | 注释/文档写 `60px = 44px 槽位 + 2 × 8px padding`，未计 1px 边框；`box-sizing: border-box` 下内容盒实为 42px，44px 槽位每侧溢入 padding 1px（视觉上仍居中，实测外沿到槽位 8px、胶囊宽 60.0px）。 | 注释改为 `62 = 44 + 16 + 2`（或说明槽位 1px/侧溢入 padding）；数值本身无需改。 |
| N10 | `src/scheduler.js:70`；`gui/src/components/ConversationPanel.tsx:320-329` | `files_modified_json` 只在建任务时写 `null`，全仓库无写入方；因此“改动了 N 个文件”卡片实际永远不会出现。`docs/hud-phase4/README.md:19` 把它列为可靠展示项，略微夸大。 | 文档明确“`files_modified` 当前恒为空，文件改动卡不会出现”；或后续由引擎提供结构化文件事件后再启用。 |
| N11 | `gui/src/styles/hud.css:148,180` | `.hud-slot__state` / `.hud-slot__unread` 的 1px 边框硬编码 `#1e2126`，而深色主题胶囊是 `#25292f`，深色下会出现 1px 错色描边。 | 改用 `var(--surface)` 或在深色媒体查询里覆盖为 `#25292f`。 |
| N12 | `docs/hud-phase3/README.md:44`；`docs/hud-phase4/README.md:13` | 截图尺寸/采集时间表只覆盖 01–08，新增的 09/10（700×1000）未列入；`reply_to` 渲染已实现，但三张第四期截图没有展示回复引用（生产库仅 `cd9f8040` 一条 reply_to，属于另一线程）。 | 把 09/10 补进尺寸/时间表；如要证明 reply_to，补一张该线程截图或在 README 标注“未截图验证”。 |
| N13 | 全仓库 | GUI 无任何自动化测试脚本/测试文件；M2 的四种输入矩阵、M1 的饱和路径均为代码审查，不是运行验证。 | 至少为 `agentSlot` 的四条分支抽纯函数并加最小单测；或在 README 标注“无自动化测试”。 |
| N14 | `docs/AGENT_HUD_SPEC.md`（未跟踪）；`spike/`（未跟踪） | spec 未入库，且仍写“胶囊 56px / lucide 图标”，与本期实际（60px、品牌图）不一致；第三期评审已记录未跟踪。 | 决定 spec 是入库并更新，还是明确标注为历史草案；不要把过期 spec 当作验收依据。 |
| N15 | `gui/src/lib/engine.ts:252-267` | `useTaskMessages` 对终态任务仍每 4s 轮询；`useTaskDetail` 已对终态停轮询，二者不一致。 | 终态时停止或降频。 |
| N16 | `gui/src/pages/SettingsPage.tsx:1119-1126` | “还原”按钮同时重置 HUD 配置与更新通道（`updates.setChannel('stable')`），语义上不是同组设置。 | 拆分或改文案。 |

---

## 4. 逐项核查表

> ✅ 通过；⚠️ 通过但有限制/待补证；❌ 不通过（对应必须修项）。

### A. 身份图标与居中

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| A1 | 三张源图已入库 | ✅ | 提交新增 `gui/src/assets/sidebar/source/{muse,claude,dsh}.png`（24,558 / 28,347 / 65,912 bytes） |
| A2 | `*-mark.png` 只保留中央中性白标志 | ✅ | 三张 mark 的 RGB 全为 255、中性像素 100%；连通域：muse 1 个（波浪 M）、claude 1 个（星形）、dsh 2 个（鲸身 + 眼孔） |
| A3 | 源图弧线/角标/彩色徽章未被带入 | ✅ | 源图 muse 的贴边弧（8,312px 连通域）、claude 的彩色弧/角标（91–128,74–110 等）、dsh 的右上徽章（76–144,2–74）均不在 mark 内容 bbox 内 |
| A4 | 透明背景 | ✅ | 四角 alpha=0、1px 边界 alpha=0、边缘半透明抗锯齿 |
| A5 | 外接框与说明一致 | ❌ | muse 上下各 20px、dsh 上下约 14px 透明边，与“四周只留 1px”不符（M5） |
| A6 | 胶囊 60px | ✅ | 截图胶囊 175px / 2.917 ≈ 60.0 CSS px；CSS `width:60px` |
| A7 | 槽位布局居中、无 magic number | ✅ | `.hud` `align-items:center`、槽位 `flex:none`、按钮 `display:grid;place-items:center`；无 per-slot 偏移 |
| A8 | 图标 24×24 + `object-fit:contain` | ✅ | `.hud-slot__glyph` 24×24；`.hud-glyph` 100% + contain/position center；`AgentGlyph` 同时给 attrs 与内联 24 |
| A9 | 实测居中偏差 | ✅ | 由截图测量：Muse/Claude/dsh 字形中心与槽位中心 dx ≤0.17 CSS px、dy ≤0.17 CSS px（与“dx=0,dy=0”的声明在像素精度内一致） |
| A10 | 品牌禁用项仍遵守 | ✅ | 新 CSS 无 gradient/backdrop-filter/glow/text-shadow；只有单层中性阴影；身份为白色形状；状态仍由环色+角标+文字三重编码 |
| A11 | 身份图版权/归属说明 | ⚠️ | `BRAND_GUIDELINES.md:167` 已声明用户提供、非 MIT 资产；但同文件 `:164` 仍写 lucide 图标映射（N8） |

### B. 第三期评审必须修项 M1–M3

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| B1 | M1 饱和检测在 HUD Muse 卡可见 | ✅ | `hud.ts:355` 检测 `>=500`；`AgentHud.tsx:163-167` 追加“消息窗口已满…重启 GUI 也不能恢复” |
| B2 | M1 饱和检测在结论流可见 | ✅ | `engine.ts:235` 设 `saturated`；`ConversationPanel.tsx:429-436` 显示 500 条窗口警告 |
| B3 | M1 文档改为“确定性失效” | ✅ | `docs/hud-phase3/README.md:38`、`RESUME.md:763`、`DAILY_LOG.md:1634` 均为确定性表述（历史区块见 N3） |
| B4 | M1 未改引擎消息逻辑 | ✅ | `git diff 970c43e 90296c9 -- src/` 为空 |
| B5 | M2 `starting` → “连接中” | ✅ | `hud.ts:111-115`（中性态，不进入 error）；Muse `:182-186` 同 |
| B6 | M2 `agent_info` 首次失败 → “状态未知” | ✅ | `hud.ts:120-122` + `lib/engine.ts:106-113`（`loading=false` 且 `error` 非空） |
| B7 | M2 真 `available:false` → “出错” | ✅ | `hud.ts:123-126` |
| B8 | M2 引擎离线 → “出错” | ✅ | `hud.ts:116-119` |
| B9 | M2 四种输入的运行级验证 | ⚠️ | 无测试，仅代码路径审查（N13）；`getAgentInfo` reject 的异常路径未覆盖（N4） |
| B10 | M3 追加更正、未回改历史 | ✅ | `git diff b3b10f6 90296c9 -- RESUME.md`、`DAILY_LOG.md` 均只有追加（47/0、66/0）；`RESUME.md:765`、`DAILY_LOG.md:1636` 明确“以本节为准，不回改历史区块” |

### C. 第四期：会话流与结论卡片

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| C1 | 卡片只从真实 `task_status`/`task_logs`/`list_messages` 派生 | ✅ | `ConversationPanel.tsx:228-384`：派发/退出/结果来自 `task`，命令/超时/退出/失败来自 `findLog`，文件与消息来自 `task.files_modified`/`messages` |
| C2 | 不把 stdout JSON 误判为错误 | ✅ | `labels.ts:112-113` stdout→`out`；`findLog` 默认只扫 `system`/`warn`（stderr 在 warn，见 N6） |
| C3 | 上下文占用条标注“参考值” | ✅ | `ConversationPanel.tsx:404-421`：“上下文占用（参考）”“引擎未返回上下文上限；按 128,000 参考值估算” |
| C4 | 占用条随设置读取并立即生效 | ✅ | `ConversationPanel.tsx:225-226` 用 `useHudConfig().contextWindowTokens`；共享 store（`hud.ts:221-298`） |
| C5 | ≥80% 警告、≥95% 错误 | ✅ | `ConversationPanel.tsx:391` |
| C6 | `list_messages({task_id})` IPC 校验 | ✅ | `main.ts:365-378`：`asRecord`、limit 1–500 整数、taskId 正则；`handle()` 可信来源 |
| C7 | 消息 500 条饱和提示 | ✅ | `ConversationPanel.tsx:429-436`（会话/线程级） |
| C8 | `reply_to` / 文件 / 问题 / `WAITING_USER` 展示 | ✅（证据部分） | 代码 `:158-202` 全覆盖；03 截图 OCR 到文件清单与问题，02 截图 OCR 到 WAITING_USER；`reply_to` 未截图（N12） |
| C9 | 结果卡来自 `task_status` | ✅ | 02 截图 OCR 到“任务完成”、`55:22 · 输入…/输出 14,705 tokens`；生产库 `a78cd852` COMPLETED、tokens 125,614/14,705、elapsed 3,322,899ms≈55:22 |
| C10 | 长摘要默认折叠 | ✅ | `ConversationPanel.tsx:356`；`a78cd852.summary` 长 1,917 字符 → 折叠态，与 README 一致 |
| C11 | 两栏布局与窄屏堆叠 | ✅ | `conversation.css:16-39`（>1280 两栏，≤1280 单栏）；`.rail--conversation` 3/2/1 列 |
| C12 | 不伪造“读文件/合并代码”卡片 | ✅ | 无该类卡片；但 `files_modified` 实际恒空，文件改动卡不可达（N10） |
| C13 | 三张截图是真实数据 | ✅ | OCR 内容 + 生产库任务/消息/日志逐项吻合（`bc86976f` FAILED、`a78cd852` COMPLETED、`857e87f3` 带文件+问题） |

### D. 第五期：设置页与审批界面

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| D1 | 设置页新增「Agent HUD」分区 | ✅ | `SettingsPage.tsx:715-889`；截图 OCR 到全部字段 |
| D2 | 只读参数与 `agent_info` 一致 | ✅ | 数据来自 `useAgentInfo`（`getAgentInfo`）；字段 `message_protocol`/`approval_gate` 由 `src/scheduler.js:412-423` 返回；默认 10 / 500 / 自动投递开 / 审批门关（`src/config.js:107-112`） |
| D3 | 纸飞机开关真实持久化 | ✅ | `%APPDATA%\agent-workbench\hud.json` = `{"paperPlanes": true, "contextWindowTokens": 128000}`；`main.ts:69-89` 原子写 |
| D4 | 上下文参考值真实持久化并立即生效 | ✅ | 同上；共享 store + `publishConfig` |
| D5 | 写入失败时反馈正确 | ❌ | 失败被吞、仍提示成功（M2） |
| D6 | 输入校验（客户端+主进程） | ✅ | `SettingsPage.tsx:122-131`；`main.ts:77-83`；1,000–2,000,000 整数 |
| D7 | 审批 IPC 只包装既有 `respond_approval` | ✅ | `main.ts:380-406` → `electron/engine.ts:567-584` → `callTool('respond_approval')`；无新引擎端点/无 `src/` 改动 |
| D8 | 参数校验（decision / task / approval / reason） | ✅ | decision 三值、id 正则 1–128、reason ≤4000、至少一个 id |
| D9 | 权限边界/可信来源 | ✅ | `handle()` + `isTrustedSender()`（`main.ts:169-188`）；CSP 未放宽 |
| D10 | 审批卡三选一 UI | ✅ | `ConversationPanel.tsx:438-487`：允许一次/本会话允许/拒绝，忙碌时禁用 |
| D11 | 审批门默认关闭 | ✅ | `src/config.js:112`；截图 OCR“关闭（默认）” |
| D12 | 未做真实 pending E2E 如实记录 | ✅ | `docs/hud-phase5/README.md:19`、`RESUME.md:772`、`DAILY_LOG.md:1650`；生产库 `approvals` 0 行 |
| D13 | “只读”描述准确 | ❌ | 多处把写操作说成只读（M1） |

### E. 安全与范围

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| E1 | 新增 IPC 走既有白名单/可信来源 | ✅ | `hud:get-config`、`hud:set-config`、`engine:message-list`、`engine:respond-approval` 全部经 `handle()` |
| E2 | 未改 `src/` 引擎消息/审批逻辑 | ✅ | `git diff 970c43e 90296c9 -- src/` 空 |
| E3 | 未触碰签名/`spike/`/第一二期评审 | ✅ | `git show --name-only 90296c9` 无相关文件；`spike/` 仍为未跟踪 |
| E4 | 未删除文件 | ✅ | numstat 无删除条目；66 deletions 均为既有文件的修改行 |
| E5 | `hud:set-config` 参数校验 | ✅ | `main.ts:69-89`（布尔/整数范围），原子写 |
| E6 | 审批 IPC 不提供任意执行/文件能力 | ✅ | 仅 `respond_approval` 工具，引擎侧校验 approval↔task 归属 |
| E7 | 生产数据未被删除 | ✅ | 只读库中验证消息（30 条 messages）仍在 |

### F. 竞态 / 性能 / 可访问性

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| F1 | HUD 与页面重复轮询 | ⚠️ | N1：任务页 7 条轮询 |
| F2 | 500 条/3s 载荷 | ⚠️ | N2：完整消息体 |
| F3 | `aria-describedby` | ✅ | `AgentHud.tsx:176` 指向 popover id（卡片 `display:none` 仍参与描述计算） |
| F4 | reduced-motion | ⚠️ | N4 对应 M4：落地淡出实际不可见；`conversation.css:524-533` 的进度条降级正常 |
| F5 | 深色主题 | ✅（HUD）/ ⚠️（截图） | 10 号截图与 `hud.css:25-30` 的 `#25292f` + 0.22 描边一致；设置页截图主题描述错误（M3） |
| F6 | 悬停卡边缘 | ✅ | `hud.css:250-260` 首/末槽位改 top/bottom；`max-width:calc(100vw-120px)` |
| F7 | 图标 alt/aria | ✅ | `alt=""`、装饰性包裹 `aria-hidden`；按钮 `aria-label` 含名称/状态/活跃/未读/排队 |
| F8 | 设置页输入校验 | ✅ | 客户端 + 主进程双重 |
| F9 | 键盘可达 | ✅ | 原生 `details/summary`、按钮、`:focus-visible` 2px 描边 |
| F10 | 结论流最大高度内滚动 | ✅ | `conversation.css:226-233` `max-height:560px; overflow:auto` |

### G. 文档与提交一致性

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| G1 | `git show --stat` 与文件清单 | ✅ | 35 files changed, 2,119 insertions(+), 66 deletions(-)；无 `src/`、无删除文件 |
| G2 | 提交与 RESUME/DAILY_LOG 文件清单吻合 | ✅ | P.1–P.6 所述资产/代码/截图/文档均在提交中 |
| G3 | RESUME/DAILY_LOG 追加而非回改 | ✅ | 47/0、66/0；P.3 明确不回改历史 |
| G4 | 文档声明与提交内容一致 | ❌ | “只读包装”（M1）、“深色主题截图”（M3）、N13（M4）、1px 外接框（M5） |
| G5 | 并行实现/未验证项未写成已验证 | ✅ | 审批 E2E 明确标注“未做”；构建/几何为声明值，本报告独立复核了可复核部分 |
| G6 | 提交/推送状态 | ✅ | `origin/gui/v0.1` 与 HEAD 均为 `90296c9`（本地 remote-tracking） |
| G7 | 工作区洁净度 | ⚠️ | 评审期间出现未提交后续改动（§7.2），不属于本提交 |

---

## 5. 复跑命令与结果

| 命令 | 结果 |
|---|---|
| `git show --stat 90296c9` | 35 files changed, 2,119 insertions(+), 66 deletions(-)；全部在 `gui/`、`docs/`、`RESUME.md`、`DAILY_LOG.md`；无删除文件 |
| `git show --name-only 90296c9` | 无任何 `src/` 文件；无签名/`spike/`/第一二期评审文件；含 `docs/AGENT_HUD_PHASE3_REVIEW.md`（上一期评审报告随本期入库） |
| `git diff 970c43e 90296c9 -- src/` | 空输出（引擎未改） |
| `git diff b3b10f6 90296c9 -- RESUME.md DAILY_LOG.md` | 47/0、66/0，纯追加 |
| `git rev-parse HEAD` / `origin/gui/v0.1` | 均 `90296c90ed6797a2f675eeaaaf808a0cf5c369a7` |
| `node -v` | v22.20.0 |
| `cd gui && npm run typecheck` | **EXIT=0**（`tsc --noEmit` 两套 tsconfig 均通过）。注：运行时工作区已开始被并行改动，严格说不是对 `90296c9` 的干净快照；提交与工作区在这些文件上的差异仍类型自洽，见 §6 |
| `cd gui && npm run build` | `theme:build` 成功（重写 gitignored 的 `brand.generated.css`；该文件未被 Git 跟踪，无法据此判断内容是否变化）；`build:main`（`tsc -p tsconfig.electron.json`）成功（`dist-electron/` 16:20:32）；`build:renderer` **失败**：`Error: spawn EPERM`（esbuild service 无法使用管道，属本机沙箱边界，非代码错误）。未重试/未提权，构建声明未能独立复现 |
| Pillow 像素分析（提交内 PNG） | 09/10 胶囊 60.0 CSS、字形中心偏差 ≤0.17 CSS px；mark PNG 透明度/中性白/bbox（见 M5）；phase5 截图主色为白/纸白（见 M3） |
| Windows OCR（`zh-Hans-CN`） | 09/10：Muse 悬停卡“有会话在等你回复（线程处于 WAITING_USER）…”；phase4-01：“结论流”“上下文占用（参考）0 / 128,000 tokens · 0%”“任务超时”“执行器异常结束”；phase4-02：“任务完成”“55:22 · 输入…/输出 14,705 tokens”“WAITING_USER”；phase4-03：文件 `src/messages.js`、`gui/src/components/ConversationPanel.tsx` + 问题；phase5-01：设置页 Agent HUD 全部分区 |
| 生产库只读（`node:sqlite`，`readOnly:true`） | `messages` 30 条、`tasks` 69 条、`approvals` 0 条、`approval_grants` 0 条；`a78cd852` COMPLETED（tokens 125,614/14,705，summary 1,917 字符）、`bc86976f` FAILED（timeout 1000ms）、`857e87f3` 真实消息带 `files`+`question`；验证消息未删除 |
| `%APPDATA%\agent-workbench\hud.json` | `{"paperPlanes": true, "contextWindowTokens": 128000}`，mtime 16:08:53（提交前） |

> 说明：`gui/dist/`（评审时点 16:19:18）是评审期间并行进程构建的产物，**不能**作为 `90296c9` 构建通过的证据；但其存在说明 vite 渲染构建在未受限环境下可运行，且当时的 CSS 产物包含 `.hud-slot__flash`/`hud-flash-fade`/`animation-duration:.01ms!important`（佐证 M4）。

---

## 6. 额度 / 环境 / 局限

- **额度**：本次评审未调用 claude/dsh LLM；额度无法直接观测，不记录虚构百分比。
- **未做**：未修改任何源码/配置/签名/引擎逻辑；未删除文件；未提交或推送；未重启生产 `:8080`；未调用其他 claude/dsh 任务；未运行 Electron/CDP。
- **构建限制**：`npm run build` 的渲染阶段被本机沙箱的管道限制阻断（esbuild `spawn EPERM`），按环境规则未换法重试、未提权；因此“构建通过”只能确认到 `theme:build` + `build:main`，渲染包构建未能独立复现。实现方的构建声明本身不与证据冲突，但本报告不把它计为已验证。
- **typecheck 的时点**：类型检查在评审期间执行；此后工作区出现未提交改动（§7.2），因此不是对 `90296c9` 的严格干净快照。提交版本与改动后的差异很小且类型自洽，但如需严格证据，建议最终提交后在干净检出一遍 `npm run typecheck`。
- **图像局限**：评审模型无图像输入；PNG 结论来自 Pillow 像素统计 + Windows OCR（OCR 有数字/英文误读）。凡涉及“截图里是什么”的结论，均与生产库数据交叉核对。
- **运行时局限**：未启动 GUI，未做真实交互（悬停/点击/审批按钮）；M2 四分支、M1 饱和、审批卡三选一均为代码路径审查，无运行级证明；GUI 无测试。
- **生产数据**：验证消息（30 条 messages、相关任务）保留在 `data/workbench.db`，本次仅只读查询，未删除。
- **并发工作区**：见 §7.2；本报告严格以 `90296c9` 为准。

---

## 7. 附录

### 7.1 生产库只读核验摘要（2026-11-14，评审时点）

- `messages` 共 **30** 条（第三期评审时 28 条；新增 `857e87f3` bc86976f 线程第 6 条、`124e6dc4` a5d3198f 线程第 11 条 user 消息）；`tasks` 共 **69** 条；`approvals` / `approval_grants` 均 **0** 条（审批门关闭，未制造 pending）。
- 线程 `a78cd852-353f-496b-b2e9-31cddeef7617`：10 条 claude→dsh，末条 `bce3eaef` **held**，线程 `WAITING_USER`；对应任务 COMPLETED、summary 1,917 字符、tokens 输入 125,614 / 输出 14,705。
- 线程 `bc86976f-8ce1-4f47-ad77-f767bd95cb00`：6 条 dsh→claude，其中 `857e87f3` 带 `files=["src/messages.js","gui/src/components/ConversationPanel.tsx"]` 与 `question`，summary 明确标注“忽略，仅用于会话流截图”。
- `a5d3198f` 线程现为 11 条、`ACTIVE`（第三期 README 描述的是当时的 10 条 `WAITING_USER` 快照，不是当前状态）。
- 结论：第四期三张截图所依赖的任务/消息/日志均真实存在且与 OCR 内容一致。

### 7.2 评审期间出现的未提交改动（不属于 `90296c9`，未纳入结论）

评审期间工作区在 16:14–16:21 被并行进程修改（与第三期评审时的 N14 同类现象）：

- 修改：`gui/src/lib/hud.ts`（setter 改为返回 `Promise<boolean>`）、`gui/src/pages/SettingsPage.tsx`（按结果提示成功/失败）、`gui/src/components/ConversationPanel.tsx`（“· 只读”→“· 引擎数据”）、`RESUME.md`、`DAILY_LOG.md`、`docs/BRAND_GUIDELINES.md`、`docs/hud-phase3/README.md`、`docs/hud-phase4/README.md`、`docs/hud-phase5/README.md`、`gui/src/assets/sidebar/README.md`、`docs/hud-phase5/01-settings-hud.png`。
- 新增：`docs/hud-phase3/09-dark-sidebar.png`、`10-saturation-warning.png`、`docs/hud-phase4/01-conversation-overview.png`、`02-completed-result-and-cards.png`、`docs/hud-phase5/02-approval-pending.png`、`03-approval-allowed.png`。
- 已观察到的对应关系：上述改动正在修 M1（措辞）、M2（写盘失败反馈）、补充深色/饱和/审批 E2E 证据；但**未提交、未经本报告验证**。其中 `01-settings-hud.png` 替换后仍为浅色（白色主色），即 M3 在该未提交改动中仍未解决。
- 建议：最终提交前，由实现方确认这些改动与 `90296c9` 的差异，并对最终提交重新跑 §5 的复核命令；本报告不对未提交内容作通过结论。

### 7.3 复现 M1（只读）的相关证据链

`ConversationPanel.tsx:398-400`（“只读”） → `:438-487`（审批三选一按钮） → `TaskDetailPage.tsx:159-177`（`respondApproval`） → `lib/engine.ts:450-463` → `electron/preload.ts:33-38` → `main.ts:380-406` → `electron/engine.ts:567-584`（`respond_approval`） → `src/approvals.js:518-536`（写用户回复 + `_finalize`）。

---

*本报告只读完成；未提交、未推送。*
