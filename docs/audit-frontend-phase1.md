# Phase 1 前端审计报告

> 审计对象：`D:\Claude\agent-workbench\gui`，分支 `gui/group-chat-upgrade`，HEAD `a08d9d1`（2026-11-16 21:00 +0800）
> 审计日期：2026-11-17
> 审计方式：只读代码审查（React/Electron/CSS/引擎契约逐行追溯）+ 现有验收快照（UI 无障碍树）+ 附件落盘文件核对
> 明确未做：未修改任何业务代码；未重启引擎；未操作正在运行的 GUI/任务；未运行 `npm run typecheck`/`build`；未做像素级设计对照；未做 React Profiler/CPU 采样。本报告中的“运行时证据”来自仓库内已有快照文件，不是本次新跑。

---

## 0. 结论先行

### 0.1 一句话结论

**三栏骨架、设计 token、身份四色、附件存储链路都已真实落地；但两条主链路属于“看起来有、实际不通”：**

1. **群聊消息附件只返回 `file_id`，前端把 ID 当作历史路径处理 → 所有新附件的卡片显示 UUID、0 B、`legacy-path`**（存储本身完全正确）。
2. **`list_chats` 不返回 `unread`，且 `chat_mark_read` 从未被前端调用 → 侧栏未读徽标与“有未读”筛选永远为空。**

再加上聊天页存在 **两路独立 3 s 消息轮询**、每 3 s 一次 **全量重渲染**、以及 `summary` 截断/无历史分页，当前版本不建议直接进入视觉打磨，应先修 P0/P1。

### 0.2 最高优先级结论

| 级别 | 结论 | 关键证据 |
|---|---|---|
| **P0** | 群聊消息里的附件卡片把 `file_id` 当路径：名称=UUID、大小=0 B、状态=`legacy-path`；MIME/解析状态一并失真。存储层（名称/大小/MIME/sha256/parse_status/parse_error/路径）全部正确 | `src/chats.js:257-259`；`gui/src/lib/chat.ts:270-289,326-330`；`gui/src/components/FileCard.tsx:137-142`；运行时：`.tmp-phase6-retest/chat.json` 显示 `下载 e4dbf66d-…`，同 ID 在 `files-final.json` 显示 `phase6-summary.pdf` / `PDF · 2.3 KB · parsed`；磁盘 `data/chat-files/dc1aa3bc-…/e4dbf66d-…-phase6-summary.pdf` 2316 B |
| **P0** | 未读链路整条为空：`unread` 不在 `list_chats` 响应里（恒为 0），`useMarkChatRead` 未被任何组件使用，`chat_mark_read` 无调用者 | `src/chats.js:43-55,226-234`；`gui/src/lib/chat.ts:231`；`gui/src/components/ChatSidebar.tsx:114-115,122,155-159`；`gui/src/lib/chat-store.ts:430-438` |
| **P1** | 聊天页两路 3 s 消息轮询（ChatStore + HUD `list_messages`），且 HUD 读的是同表“最旧 500 条”；聊天消息会挤占窗口，超过 500 条后 HUD 未读/纸飞机永久冻结 | `gui/src/lib/chat-store.ts:37,140-145`；`gui/src/lib/hud.ts:48-49,338-430`；`src/store.js:704-726`；`gui/electron/main.ts:410-419` |
| **P1** | 轮询每次轮询都 `set` 新快照并通知全部订阅者；`MessageBubble` 未 memo，3 s 一次对最多 200 条消息重跑 Markdown 解析 | `gui/src/lib/chat-store.ts:124-134,235`；`gui/src/components/MessageBubble.tsx:315-355`；`gui/src/components/MessageList.tsx:104-110` |
| **P1** | 浅色主题下会话列表的身份头像不可见：白色 PNG 标识叠在近白 `*-subtle` 底上（聊天内用实色底，正常） | `gui/src/styles/brand.css:2389-2425`；`gui/src/assets/sidebar/README.md:13-15`；对照 `gui/src/styles/chat.css:994-1007` |
| **P1** | 无历史分页：只取最新 200 条；引擎 `has_more` 被解析后丢弃；>200 条的群聊无法回看更早消息 | `gui/src/lib/chat-store.ts:40,210-235`；`gui/src/lib/chat.ts:742,764`；`src/chats.js:270` |
| **P1** | 消息正文只渲染 `summary`（500 token 截断），引擎已返回的 `body` 被前端丢弃；无“已截断”提示，且折叠按钮作用在 summary 上 | `src/chats.js:254-255`；`src/messages.js:353-360`；`gui/src/lib/chat.ts:342`；`gui/src/components/MessageBubble.tsx:324-329,354` |
| **P1** | 身份橙与品牌强调色、HUD“干活中”环同为 `#e85d26`：同一种橙同时表示主操作/选中、Claude 身份、Agent 工作中；并与 `BRAND_GUIDELINES.md:164`“不用颜色区分 agent”冲突 | `gui/src/styles/brand.css:24,53`；`gui/src/styles/hud.css:90-94`；`docs/BRAND_GUIDELINES.md:164`；`docs/DESIGN_SYSTEM.md`（无身份 token） |
| **P1** | 解析失败原因 `parse_error` 在四层被丢弃（引擎 → 主进程 normalize → 渲染层 type/normalize → 卡片），用户只看到英文 `failed` | `src/files.js:447-461`；`gui/electron/attachments.ts:314-341`；`gui/src/types.ts:352-368`；`gui/src/lib/chat.ts:304-317`；`gui/src/components/FileCard.tsx:140-143` |
| **P1** | 侧栏拖拽宽度/折叠/持久化/双击重置在代码中完全不存在（无指针事件、无 collapsed 状态、无持久化键） | `gui/src/components/ChatSidebar.tsx`（全文）；`gui/src/components/AppFrame.tsx:43`；`gui/src/styles/brand.css:78,297-299` |

### 0.3 六个问题的直接回答

| # | 问题 | 结论 |
|---|---|---|
| 1 | 三栏布局（导航/会话列表/聊天主区） | **成立**：`96px + 336px + 1fr`。但侧栏**不可拖拽、不可折叠、不持久化、无双击重置**；窗口固定 1440×900、最小 1080×700，不读屏幕工作区，1366×768/高缩放下会越界；900px 断点在应用内不可达 |
| 2 | 组件复用与视觉一致性 | 拆分总体合理，但存在**双消息渲染栈、双状态字典、三套按钮、三份文件类型/大小工具、五处身份名称常量**；无渐变/发光/玻璃/emoji 图标，token 基本遵守；浅色头像对比度与“白字橙底”是硬伤 |
| 3 | 附件卡片（UUID / 0B / legacy-path） | **显示/契约 bug，不是存储 bug**：`list_chat_messages` 只回 `file_id`，前端按旧数据格式反序列化。`file_id` 本身正确，预览/下载仍可用；但名称/大小/MIME/解析状态全错，失败原因不显示 |
| 4 | 轮询与状态同步 | 存在重复轮询（3 s×2、5 s×2、4 s、30 s、1.2 s）；Agent 状态只有**任务级真实状态**，没有“思考/生成/调用工具/读附件”这些阶段；不发流式；发送后无乐观气泡；未读端到端失效；轮询本身不读附件字节，但图片预览无缓存、每次挂载回源 |
| 5 | 身份颜色与消息气泡 | 四色（Muse `#8b7cff` / Claude `#e85d26` / dsh `#3b82f6` / User `#8a8f98`）**已按目标实现**；但 Claude 橙=品牌 accent=HUD 工作中环，语义冲突；名字硬编码，引擎 `display_name` 被丢弃；聊天内不显示模型；不可配置 |
| 6 | 是否可进入 Phase 2 | **可以进入，但不能直接做视觉打磨**：先把附件元数据、未读、轮询/渲染、浅色头像、正文截断这几项修完（预计 4–6 人日），再做交互与视觉统一 |

---

## 1. 审计方法与证据边界

### 1.1 已读材料

- `RESUME.md`（I–U 节，含群聊合并与 token 自动同步）、`DAILY_LOG.md` 尾段（2026-11-16）。
- `docs/CHAT_BACKEND.md`、`docs/upgrade-backend-phase4.md`、`docs/PHASE4_INTEGRATION.md`、`docs/BRAND_GUIDELINES.md`、`docs/DESIGN_SYSTEM.md`、`docs/review-frontend-phase1.md`（旧提交 `275ddc3`，仅作对照）、`docs/audit-backend-phase1.md`（同日后端审计，用于交叉引用）。
- `gui/src` 全量：`App.tsx`、`AppFrame.tsx`、`GlobalNav.tsx`、`ChatSidebar.tsx`、`ChatPage.tsx`、`ChatHeader.tsx`、`MessageList.tsx`、`MessageBubble.tsx`、`FileCard.tsx`、`AttachmentBar.tsx`、`Composer.tsx`、`AgentHud.tsx`、`AgentPresence.tsx`、`ConversationPanel.tsx`、`FilesPage.tsx`、`SettingsPage.tsx`、`lib/*`、`styles/*`、`types.ts`、`theme/*`。
- `gui/electron`：`main.ts`、`engine.ts`、`preload.ts`、`attachments.ts`、`chat-protocol.ts`。
- 引擎：`src/chats.js`、`src/messages.js`、`src/files.js`、`src/context.js`、`src/store.js`、`src/state.js`、`src/text.js`、`src/tools.js`。

### 1.2 本次使用的运行时证据

| 证据 | 内容 |
|---|---|
| `.tmp-phase6-retest/chat.json` | 2026-11-17 01:05 的 GUI 无障碍树。群聊消息区附件按钮名为 `下载 e4dbf66d-1668-42a6-a251-315933ae635c`（`FileCard` 的 `aria-label=下载 ${file.name}`，说明 `name` 就是 UUID） |
| `.tmp-phase6-retest/files-final.json` | 同一群聊的文件页：同一 `file_id` 显示 `下载 phase6-summary.pdf`，卡片 meta 为 `PDF · 2.3 KB · parsed`；另有 `PDF · 2.6 KB · failed` 等 |
| `data/chat-files/dc1aa3bc-70c4-45b3-bae6-bed4f89ea55a/` | `e4dbf66d-…-phase6-summary.pdf` 2316 B + `e4dbf66d-….extracted.txt` 552 B，证明存储、解析都成功 |
| 截图 `.tmp-phase6/screenshots/*.png`、`docs/hud-phase4/*.png` | 深色聊天/文件页现状；本次未新增截图 |

### 1.3 证据边界（未验证项）

- **未启动生产 GUI 实测**，因此以下三项只有代码推导，需要 Phase 2 一次运行确认：
  1. CSP `img-src` 缺少 `blob:` 时，发送前图片缩略图是否被 Chromium 拦截（`main.ts:988,1001` vs `AttachmentBar.tsx:30-37`）。
  2. 浅色主题会话列表头像的实际观感（代码与素材说明已足以判定“白底白图”，但仍建议截图留证）。
  3. 5–20 MB 图片预览失败时是否只表现为“无缩略图”（`files.js:736-739` → `chat-protocol.ts:97-98` → `FileCard.tsx:80-87`），以及文档提取文本超过 2 MB 时的截断表现。
- 未做 CPU/内存 profile；第 5.2 节的查询量是按代码路径的**量级估算**，不是采样值。
- 像素级设计对照（1080/1280/1440、浅/深）未做；本报告只判断实现与规范/代码事实是否一致。

---

## 2. 布局：三栏结构与会话侧栏

### 2.1 现状

| 区域 | 实现 | 证据 |
|---|---|---|
| 全局导航栏 | 96px 图标轨；群聊/工作台/任务记录/文件；中部嵌 Agent HUD；底部引擎灯/主题/设置/帮助 | `gui/src/styles/brand.css:77,322-465`；`gui/src/components/GlobalNav.tsx:1-151` |
| 会话列表 | 仅聊天路由渲染；`sticky; height:100vh`；宽度只来自 token | `gui/src/components/AppFrame.tsx:31-47`；`gui/src/styles/brand.css:78,297-299,2149-2158` |
| 聊天主区 | `content--chat` 无 max-width，flex 列；消息流内部滚动 | `gui/src/styles/brand.css:2517-2525`；`gui/src/styles/chat.css:10-19,424-441` |
| 窗口 | 1440×900，min 1080×700；无 `screen` 导入、无 bounds 持久化 | `gui/electron/main.ts:1041-1045,1-12` |

### 2.2 侧栏能力矩阵（需求 vs 实现）

| 需求 | 现状 | 证据 |
|---|---|---|
| 可拖拽调整宽度 | **无**。全文件无 pointer/mouse 事件、无分割线元素 | `gui/src/components/ChatSidebar.tsx`（全 298 行）；全仓 `onPointerDown/onMouseDown` 仅 `Composer.tsx:385,403`（表情/提及） |
| 可折叠/展开 | **无**。聊天路由无条件渲染；无 collapsed 状态、无“收起侧栏”按钮 | `gui/src/components/AppFrame.tsx:43`；`ChatSidebar.tsx` 无相关 state |
| 宽度/折叠状态持久化 | **无**。全仓只有主题（localStorage）与 `hud.json` 两处持久化 | `gui/src/lib/theme.ts:5-28`；`gui/electron/main.ts:50`；无 `chatSidebar*` 键 |
| 双击重置宽度 | **无**。全仓无 `onDoubleClick`/`dblclick` | grep 结果为空 |
| 键盘可调 | **无** | 同上 |

**结论：用户要求的两项核心交互（拖拽宽度、折叠）在代码里完全不存在，不是“做了但没生效”。**

### 2.3 窗口状态与屏幕适配

1. **首开尺寸大于常见笔记本屏幕**：默认 1440×900；1080p、125% 缩放时逻辑工作区约 1536×816，900 高已超出任务栏可用高度；1366×768 机器直接越界。Electron 不会自动收缩外部尺寸。
2. **最小尺寸与断点冲突**：`minWidth: 1080`（`main.ts:1044`）；`brand.css` 的 1180px 断点只处理 `.workspace/.detail/.form-layout`、`.rail`、`.settings`（`2042-2058`），**不涉及聊天三栏**；聊天唯一的窄屏分支是 900px（`chat.css:27-31,960-973`）与 `hud.css:377-381`，而窗口永远 ≥1080 → **900px 分支在应用内不可达**，也没有“1080–1180 收侧栏”的中间态。
3. **最大化表现**：三栏按比例拉伸，会话栏固定 336px，聊天区无限变宽；消息体 `max-width: min(720px, 78%)`（`chat.css:486`）且左对齐，2560 宽下右侧出现大面积空白，阅读列不居中。是否可接受属于设计决策，但目前没有 max-width/居中规则，也没有断点说明。
4. **窗口位置/大小不记忆**：无 `getBounds/setBounds/window-state`（grep 为空），每次启动都是 1440×900 并交给系统摆放；多显示器用户每次要重新摆窗口。

### 2.4 建议（含交互规格）

- 侧栏改为 `--chat-sidebar-width` 驱动 + 拖拽手柄（`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`）：
  - 范围 260–480px，步进 8px；键盘 ←/→ ±16px，Home/双击重置 336px；
  - 拖拽中 `cursor: col-resize` 且禁用文本选择；释放时写 `localStorage["agent-workbench.chatSidebar"] = {width, collapsed}`；
  - 折叠时宽度 0，但保留 12px 可点击条或导航轨上的展开按钮，折叠状态同样持久化；
  - 启动时读取并 clamp 到 `[260,480]`，避免旧值把主区挤没。
- 主进程：`import { screen }`，按 `screen.getPrimaryDisplay().workAreaSize` clamp 初始尺寸；启动恢复上次 bounds（JSON 文件，和 `hud.json` 同目录），`isMaximized` 单独记；显示器移除时回落到主屏工作区。
- 断点：以 1180px 为“窄屏”——会话栏降到 280px；以 1080px 为“收起”——自动折叠为 0 并显示展开按钮；900px 分支保留给未来浏览器预览但不再承担应用内职责。
- 宽屏：给消息列加 `max-width: 960px; margin-inline:auto`，或明确“左对齐是设计决定”并写进 DESIGN_SYSTEM。

---

## 3. 组件复用与视觉一致性

### 3.1 组件结构（实际）

```
App
└─ Theme + AppFrame
   ├─ GlobalNav (rail)                       brand.css §3
   │  └─ AgentHud → PaperPlaneLayer          hud.css
   ├─ ChatSidebar (chat routes only)         brand.css §12 + ChatSidebar.tsx
   └─ main.content
      ├─ ChatPage                            chat.css
      │  ├─ ChatHeader (rename/archive/search/members)
      │  │  ├─ AgentPresence (row)
      │  │  └─ AgentPresenceList (popover)
      │  ├─ MessageList
      │  │  └─ MessageBubble → FileCard
      │  └─ Composer → AttachmentBar
      ├─ TasksPage / TaskDetailPage          Layout.tsx + conversation.css
      │  └─ ConversationPanel（另一套消息卡片流）
      ├─ FilesPage                           FileCard 复用
      └─ DispatchPage / SettingsPage / AboutPage
```

### 3.2 重复实现清单

| 类别 | 重复项 | 证据 |
|---|---|---|
| 消息渲染 | `MessageBubble`（聊天）与 `ConversationPanel.CardView`（任务详情）各自渲染消息卡片、文件、问题、状态 | `gui/src/components/MessageBubble.tsx:303-386`；`gui/src/components/ConversationPanel.tsx:50-57,92-106,108+` |
| 投递状态字典 | `DELIVERY_STATUS` vs `MESSAGE_STATUS`，label 相同、tone 体系不同 | `MessageBubble.tsx:28-37`；`ConversationPanel.tsx:50-57` |
| 文件渲染 | `FileCard` vs `FileChips`（路径芯片），语义与交互完全不同 | `FileCard.tsx:66-179`；`ConversationPanel.tsx:92-106` |
| 按钮 | `AppButton/AppIconButton`（Astryx）＋ `.btn` 原生类＋聊天专用按钮，同屏混用 | `gui/src/ui/astryx.tsx:38-103`；`brand.css:519+`；`ChatPage.tsx:82-90`；`chat.css:54-119,760-775` |
| 字节格式化 | 三份：`FileCard.formatSize`、`AttachmentBar.formatSize`、`labels.formatBytes`（单位还不一致：KB/MB vs KiB/MiB） | `FileCard.tsx:6-14`；`AttachmentBar.tsx:13-21`；`labels.ts:213-228` |
| 文件类型判定 | 三份：`FileCard.kindOf`、`chat.ts:guessKindFromName`、`attachments.ts:detectKind`（词表不同，FileCard 不认 pptx） | `FileCard.tsx:16-38`；`chat.ts:257-303`；`electron/attachments.ts:325-327` |
| 身份名称 | 五处硬编码：`IDENTITIES`、`AGENT_NAMES`、`THINKING_NAMES`、`MARKS`、`MENTION_CANDIDATES`；另有 `defaultParticipantName` | `MessageBubble.tsx:19-26`；`ChatHeader.tsx:15`；`MessageList.tsx:11-15`；`AgentPresence.tsx:38-42`；`chat.ts:500-511,530-535` |
| @提及解析 | `Composer.parseMentions` 与 `chat.ts.parseMentions` 两套正则（前者不认 @user/@你） | `Composer.tsx:36-45`；`chat.ts:537-580` |

### 3.3 设计 token 与规范核对

| 规则 | 结果 | 证据 |
|---|---|---|
| 只用实色，不用紫蓝渐变 | **通过**。全仓无 `linear-gradient/radial-gradient`；身份色是实色 token | `brand.css:47-61,119-130`；`chat.css:975-1019` |
| 不用发光/玻璃拟态 | **通过**。无 `backdrop-filter`、无多层彩色阴影 | grep 结果为空 |
| 不用 emoji 作图标 | **通过**。emoji 只出现在 Composer 的内容选择器（插入文本），图标全部 lucide | `Composer.tsx:11-15,396-412`；其余组件均为 `lucide-react` |
| 字重只用 400/600/700 | **通过**。`gui/src/styles` 统计：600 约 60 处，400 仅 2 处，700 为 0；Wordmark 是图片 | 无 `fontWeight` 内联；`brand.css` 各节 |
| 圆角不滥用 | **基本通过**。组件 8/12px；两个例外：HUD 胶囊 28px（规范已豁免）、发送按钮 999px（未记录） | `brand.css:63-66`；`hud.css:23`；`chat.css:768`；`BRAND_GUIDELINES.md:157` |
| 阴影使用 token | **未通过**。多处硬编码 `rgba(30,33,38,0.16)`，未用 `--shadow-*` | `chat.css:142,160,827,1386`；`brand.css:68-70` |
| 前景/背景对比 | **未通过**。选中会话与未读徽标用白字橙底（#fff on #e85d26 ≈ 3.5:1，13px 正文/11px 徽标低于 AA 4.5:1），且与 `--on-accent: #1e2126` 规范相悖 | `brand.css:41-42,2359-2367,2443-2444` |
| 浅色/深色一致 | **未通过**。会话列表身份头像在浅色下白图叠近白底；聊天内是实色底，正常 | `brand.css:2389-2425`；`chat.css:994-1007` |

### 3.4 问题与建议

- **UI-1（P2）双消息栈**：两套消息/状态/文件渲染会持续漂移（本次附件 bug 只影响聊天栈，任务页栈因为用路径芯片反而“看起来正常”）。建议抽 `MessageCard` 供两处复用，或明确下线 `ConversationPanel`。
- **UI-2（P2）三套按钮**：同一屏里 `+ 新建会话` 是 `.btn btn-primary`（ChatPage:82），侧栏重试是 `AppButton`，发送是自定义 pill。建议聊天也统一到 `AppButton/AppIconButton`，或把聊天按钮提炼成 `ChatButton` 并在 DESIGN_SYSTEM 登记。
- **UI-3（P3）工具函数重复**：统一用 `labels.formatBytes`（同时修 KiB/MiB 与 KB/MB 的口径）与同一个 `fileKind`；`ChatFile.kind` 已经存在却被 `FileCard` 忽略，应改为优先 `file.kind`、回退名称。
- **UI-4（P1）浅色头像**：`assets/sidebar/README.md:13` 明确写“中性白色标志”；会话列表却给 `--identity-*-subtle` 近白底。修复：侧栏头像改用身份实色底（与聊天 `chat-avatar--*` 一致），或为浅色主题提供深色 mark 变体；验收时给浅色截图。
- **UI-5（P1）白字橙底**：把选中行/未读徽标改为 `--on-accent`（墨色），或把选中态改回“浅底 + 左侧 2px 实色条”；同时删掉 `brand.css:2228-2234` 与 `2359-2380` 这对互相覆盖的规则（前者注释说“background tint”，后者实际是实色），只保留一套。
- **UI-6（P3）硬编码色/阴影**：`chat.css:397` 的 `#1e2126`、`chat.css:142/160/827/1386` 的阴影、`brand.css:358` 的 `#f5f3ee` 都应由 token 生成；HUD 的 ink 例外可以保留，但建议在 `hud.css` 顶部声明局部变量而非散布裸值。
- **UI-7（P3）死样式/魔法数字**：`.chat-avatar--agent`、`.chat-avatar--mark`（`chat.css:395-406`）永远不会命中（调用方用的是 `chat-avatar--muse/claude/dsh/user`）；`chat.css:375` 的注释“white marks need an ink plate”与下方身份实色规则矛盾；336/28/-8 等数字建议进 token。

**“AI 味”结论：通过。** 没有渐变、发光、玻璃拟态、emoji 图标；紫色/蓝色只作为小面积身份色（名字/头像/浅底气泡），符合“实色”原则。唯一需要克制的是 3–4 种浅底气泡并置时的“彩色卡片墙”观感，这是目标设计本身的选择，不是实现跑偏。

---

## 4. 附件卡片：UUID / 0 B / legacy-path

### 4.1 现象与证据链

用户看到的卡片（群聊消息内）：

```
e4dbf66d-1668-42a6-a251-315933ae635c
文件 · 0 B · legacy-path        [预览] [下载]
```

同一文件在“文件”页：

```
phase6-summary.pdf
PDF · 2.3 KB · parsed           [下载]
```

**运行时证据**（仓库内已有快照）：

- `.tmp-phase6-retest/chat.json`：附件按钮可访问名 `下载 e4dbf66d-1668-42a6-a251-315933ae635c`。
- `.tmp-phase6-retest/files-final.json`：`下载 phase6-summary.pdf`、`PDF · 2.3 KB · parsed`。
- `data/chat-files/dc1aa3bc-70c4-45b3-bae6-bed4f89ea55a/`：`e4dbf66d-1668-42a6-a251-315933ae635c-phase6-summary.pdf`（2316 B）、`e4dbf66d-1668-42a6-a251-315933ae635c.extracted.txt`（552 B）。

**结论：文件本身、名称、大小、解析结果、磁盘路径都正确；错的是消息 → 卡片这一段的契约与反序列化。**

### 4.2 根因（逐层）

1. **引擎契约只给 ID**：`src/chats.js:257-259`
   ```js
   files: attached.length > 0
     ? attached.map((file) => file.file_id)
     : parseJsonArray(row.files_json),
   ```
   文档也是这么定的：`docs/CHAT_BACKEND.md:68`、`docs/upgrade-backend-phase4.md:171`（“聊天消息的 `files` 只接受 `file_id`”）。
2. **主进程原样透传**：`gui/electron/engine.ts:listChatMessages` 不做附件补全；`main.ts:443-449` 只是路由。
3. **渲染层把字符串当旧路径**：`gui/src/lib/chat.ts:326-330` 对 `record.files` 逐项 `normalizeChatFile`；`270-289` 的分支是给“旧版 `files_json` 裸路径”准备的：
   ```ts
   if (typeof raw === 'string') {
     if (raw.length === 0) {
       return null;
     }
     const name = raw.split(/[\\/]/).pop() ?? raw;
     return {
       file_id: raw,
       name,
       size: 0,
       mime: 'application/octet-stream',
       kind: guessKindFromName(name),
       sha256: null,
       status: 'legacy-path',
       preview_text: null,
       preview_truncated: false,
       uploader: null,
       created_at: '',
     };
   }
   ```
   UUID 里没有 `/` 或 `\`，`name` 就等于 UUID；`size` 硬编码 0；`status` 硬编码 `legacy-path`。
4. **卡片原样渲染**：`FileCard.tsx:137-142` 输出 `name`、`KIND_LABEL[kind] · formatSize(size) · status`；`kindOf` 又忽略 `file.kind` 与真实 MIME，只看 UUID 名称 → `文件`。

**为什么测试没发现**：Phase 4 的 12 项检查只断言消息文本/条数/重启恢复；文件页走的是 `list_chat_files`（返回完整元数据），所以“文件页正常”掩盖了“聊天页错误”。

### 4.3 数据核对表

| 字段 | 存储/`list_chat_files` | 群聊消息卡片 | 评价 |
|---|---|---|---|
| `file_id` | 真实 UUID | 真实 UUID（被塞进 `name`） | **值正确、语义错位**；预览/下载按 ID 仍可用 |
| `name` | `phase6-summary.pdf` | `e4dbf66d-…` | 错（显示层） |
| `size` | 2316 | 0 → `0 B` | 错（显示层） |
| `mime` | 真实 MIME | `application/octet-stream` | 错（显示层） |
| `kind` | pdf/image/docx/… | `other` → “文件” | 错（显示层） |
| `parse_status` | `parsed` / `failed` / … | `legacy-path` | 错（显示层） |
| `parse_error` | 有（如 PDF 无可提取文本） | 从未返回 | 缺失（四层都丢） |
| 路径 | `data/chat-files/<chat>/<file_id>-<name>`；不暴露给渲染层 | 不显示路径 | 正确（安全） |
| 预览/下载 | 按 `file_id`，走 `chat-attachment:` / raw GET | 可用（新文件） | 功能正确、标签错误 |

> 术语：系统里没有 `attachment_id`，唯一句柄就是 `chat_files.file_id`。

### 4.4 其他附件问题

- **ATT-2（P1）失败原因不可见**：`src/files.js:457-458` 已返回 `parse_error`；`electron/attachments.ts:314-341` 的 `normalizeChatFile` 丢掉；`types.ts:352-368` 没字段；`chat.ts:304-317` 丢掉；`FileCard` 只显示 `status`。用户点“预览”时 `read_chat_file` 会抛 `cannot read …: <parse_error>`（`files.js:791-793`），所以原因**存在但只在交互后以错误条出现**，卡片本身不解释。
- **ATT-3（P2）英文状态直出**：`legacy-path` / `parsed` / `failed` / `pending` / `unsupported` 原样上屏（`FileCard.tsx:142`；文件页快照 `PDF · 2.6 KB · failed`）。需要状态 → 中文 label 映射，并把 `parse_error` 放进 tooltip/第二行。
- **ATT-4（P2）历史裸路径被当作 `file_id` 使用**：`chat.ts:277` 把旧路径当 `file_id`；`FileCard` 预览/下载会把它发给引擎（`FileCard.tsx:80,105,118`），引擎按 `chat_files` 查不到 → `file not found`。建议后端把旧数据放到独立字段 `legacy_paths`，前端渲染“历史附件（不可下载）”，不要伪造 `ChatFile`。
- **ATT-5（P2）预览/读取上限不一致，失败静默**：上传允许 20 MB（`attachments.ts:140`）；协议把 `MAX_INLINE_BYTES = 32 MB` 传给 `fetchBytes`（`chat-protocol.ts:22,74`）；`fetchBytes` 又固定用 `Math.min(maxBytes, 2_000_000)` 读引擎（`attachments.ts:644`）。对图片，引擎忽略该参数、按 **5 MB** 内联上限拒绝（`files.js:736-739`），于是 **5–20 MB 的图片能上传成功、能下载，但预览必然失败**；`protocol.handle` 的 catch 统一返回 404 `file unavailable`（`chat-protocol.ts:97-98`），`FileCard` 的图片预览只处理成功分支（`FileCard.tsx:80-87`），用户只看到“没有缩略图”，没有任何原因。对文档，2 MB 读取上限会让提取文本被**静默截断**（`files.js:862,868` 返回的 `truncated` 在 `fetchBytes` 里被忽略），“打开”拿到的是半截内容。建议：图片统一 5 MB、文本明确 2 MB 并在 UI 标注“预览已截断”；协议层不要吞掉错误（返回 4xx 文本或记日志）；卡片展示 `previewError`。
- **ATT-6（P3）无缓存回源**：协议响应 `Cache-Control: no-store`（`chat-protocol.ts:84,94`），`<img>` 每次挂载都会重新 `read_chat_file`；切换群聊/打开文件页会重复读。图片无提取缓存，文档读的是上传时缓存的 `.extracted.txt`（`files.js:858-862`）。建议主进程按 `file_id+sha256` 做 LRU，或允许私有缓存。
- **ATT-7（P2，待实测）CSP 缺 `blob:`**：`img-src 'self' data: chat-attachment:`（`main.ts:988,1001`），但发送前缩略图用 `URL.createObjectURL`（`AttachmentBar.tsx:30-37`）。Chromium 通常要求显式 `blob:`；若被拦截，缩略图会破图/回落。建议直接补 `blob:`（对安全无实质放宽，因为 blob 由渲染器自己创建）。
- **ATT-8（P2）批量上传“全有全无”导致重复/孤儿**：任一文件失败时 `uploadChatFiles` 整体返回 `!ok`（`chat.ts:992-997`），Composer 把**所有**待传文件标 failed（`Composer.tsx:198-205`）；已成功上传的文件仍留在引擎（`files.js:550-571` 每次 `complete` 都新建 `randomUUID`，无 sha256 去重），重试再传一份 → 同名多份/孤儿。文件页出现多份 `phase6-report.pdf` 与该机制一致（是否为该原因需看当次操作日志）。建议逐文件成败、成功的保留 `fileId`，失败的重试；后端按 `chat_id+sha256` 去重或提供“引用已有文件”。
- **ATT-9（P3）`intake_source` 恒为 `drop`**：`chat.ts:951` 对选择器/拖拽/粘贴一律传 `'drop'`，丢失来源信息。
- **ATT-10（P1）无历史分页**：只取最新 200 条（`chat-store.ts:40`），`has_more` 被丢弃（`chat.ts:764`）；增量轮询若两次之间新增 >200 条，`afterSeq + LIMIT 200` 会跳过中间消息。
- **ATT-11（P1）只渲染 summary，body 丢弃**：`chats.js:255` 已返回 `body`，`ChatMessage` 类型没有 `body`（`types.ts:377-393`），`normalizeMessage` 只读 `summary`（`chat.ts:342`），气泡只渲染 `summary`（`MessageBubble.tsx:354`）。`summary` 被 `truncateSummary(body, agentSummaryMaxTokens)` 截到 500 token（`messages.js:359`、`text.js:23-37`），长用户消息/长结论会在聊天里永久缺尾，且无“已截断/查看全文”。`body` 上限 100k 字符（`messages.js:356-357`）。

### 4.5 修复方案

**方案 A（推荐，后端改 1 处 + 前端收口）**

1. `src/chats.js:257-259` 改为返回附件对象，复用 `src/context.js:12-20` 的 `fileRef`（补 `parse_error`）：
   ```js
   files: attached.length > 0 ? attached.map(fileRef) : []
   legacy_paths: attached.length === 0 ? parseJsonArray(row.files_json) : []
   ```
2. 同步更新 `docs/CHAT_BACKEND.md`（`files: object[]`）与 `types.ts`；渲染层 `normalizeChatFile` 的字符串分支只服务 `legacy_paths`。
3. 不改的兼容点：`file_id` 仍是唯一句柄，预览/下载/权限逻辑不动。

**方案 B（纯前端，后端不动）**

1. 消息加载后收集本页 `file_id`，对每个群聊调用一次 `list_chat_files`（已有接口）建 `Map<file_id, ChatFile>`，合并进消息；按 `chatId` 缓存，发送/上传后失效。
2. 未命中的 ID 渲染“附件（file_id 前 8 位）”，不伪造大小/状态；`status==='legacy-path'` 渲染“历史附件（路径）”，禁用预览/下载。
3. 代价：每条消息页多一次文件列表请求（可与 `list_chat_messages` 并行），且超过 200 个文件时需分页/按 ID 查询接口。

**两个方案都要做**：`FileCard` 状态中文化 + `parse_error` 展示；`kindOf` 优先用 `file.kind`；补 `blob:`；统一 5 MB 预览上限；逐文件上传失败处理。

---

## 5. 轮询与状态同步

### 5.1 轮询清单（聊天路由）

| 轮询 | 周期 | 数据 | 证据 |
|---|---|---|---|
| ChatStore 消息 | 3 s（仅 active chat，`after_seq` 增量） | `list_chat_messages` LIMIT 200 | `gui/src/lib/chat-store.ts:37,140-145,210-241` |
| ChatStore 状态 + 群聊列表 | 5 s（同一 timer，两次 IPC） | `chat_status` + `list_chats` | `chat-store.ts:38-39,146-155` |
| HUD 消息 | 3 s | `list_messages` LIMIT 500（最旧 500 条） | `gui/src/lib/hud.ts:48-49,338-430` |
| HUD 任务列表 | 4 s | `task_list` 200 | `hud.ts:324` |
| HUD 执行器信息 | 30 s | `agent_info` | `hud.ts:323` |
| 全局引擎状态 | 5 s | `getEngineStatus` | `gui/src/components/AppFrame.tsx:29`；`lib/engine.ts:19-79` |
| 任务详情 | 1.2 s（status + 最多 20×500 日志） | `task_status`/`task_logs` | `lib/engine.ts:367-371,322-345` |
| 任务消息 | 4 s | `list_messages` 500 | `lib/engine.ts:208-279`；`TaskDetailPage.tsx:64` |

### 5.2 重复、放大与冻结

- **POLL-1（P1）双 3 s 消息轮询**：聊天页同时跑 ChatStore 的 `list_chat_messages`（200 条）和 HUD 的 `list_messages`（500 条）。两者都走引擎/主进程，互相独立；HUD 的数据源**没有排除群聊消息**（`src/messages.js:878-893` 无 chat 过滤；`src/store.js:704-726` 无 `chat_id IS NULL`），而群聊消息与旧线程消息同表，所以聊天越活跃，HUD 越容易被挤占。
- **HUD 只读最旧 500 条**：`ORDER BY created_at ASC LIMIT 500`（`store.js:724-726`）；`hud.ts:355-358` 自己也注释了这一点。超过 500 条后 HUD 的未读/纸飞机**永久冻结**（只有悬停提示，`AgentHud.tsx:166-170`），重启 GUI 也不会恢复。
- **POLL-10（P1）N+1 放大**：后端审计已列（`docs/audit-backend-phase1.md:352-364`）：
  - `list_chat_messages` 每行一次 `listMessageFiles` → 200 查询/3 s ≈ **67 查询/s**；
  - HUD `list_messages` 500 行、每行 `getThread` → ≈ **167 查询/s**；
  - `task_list` 每任务完整 `statusPayload`（最多 200 任务、每次 3–5 条查询）≈ **150–250 查询/s**；
  - 合计**约 380–480 查询/s**（按代码路径估算，未采样）。空闲聊天页 30 s 约 **46 次 IPC**。
- **POLL-2（P1）通知风暴 / 重渲染**：`patchSlice` 每次构造新 slice 并 `set`（`chat-store.ts:124-134`），即使 `mergeMessages` 对空增量返回原数组（`75-78`），快照对象仍是新的；`useSyncExternalStore` 因此通知所有订阅者（`chat-store.ts:361-364`）。`MessageBubble` 是普通函数组件（`MessageBubble.tsx:315`），`MessageList` 直接 map（`104-110`），每 3 s 对最多 200 条消息重跑 `RichText/parseBlocks`（`MessageBubble.tsx:73-263`）。没有虚拟列表。
- **POLL-3（P3）隐藏窗口**：ChatStore 两个 timer 都检查 `document.hidden`（`142,147`）；但 `useEngineStatus`、`useTaskList`、`useAgentInfo`、HUD 的 task_list 都没有检查（`engine.ts:69-76,196-203; hud.ts:323-324`），隐藏时仍在 4–5 s 轮询。
- **POLL-8（P2）无流式**：主进程只解析一次性 JSON-RPC 响应（`electron/engine.ts` 单次 `callTool`），没有 SSE 长连接；Agent 文本只在任务完成后由 `messages.js:832-875` 写入群聊。UI 的“思考中”是 `chat_status` 轮询 + 三个点动画（`MessageList.tsx:7,111-131`），不是流式 token。

### 5.3 Agent 状态真实性

| 需求状态 | 是否有真实数据 | 前端表现 | 证据 |
|---|---|---|---|
| 等待调度/排队 | 任务有 PENDING/STARTED；群聊参与者有 `pending_deliveries` | 聊天内无展示；HUD 的“排队消息”来自纸飞机动画队列，不是后端投递队列 | `src/state.js`；`chats.js:146-170`；`hud.ts:436-460`（slot.queued 固定 0）；`AgentHud.tsx:203-205` |
| 思考中 | **无** | 用 `WORKING/STARTING/WAITING` 近似成“正在执行…” | `MessageList.tsx:7,111-131` |
| 生成中 | **无** | 同上 | — |
| 调用工具 | **无**（只在任务日志） | 聊天内看不到 | `src/state.js` 无此状态 |
| 读附件 | **无**（只有任务日志里的 `read_chat_file`） | 聊天内看不到 | `src/tools.js` 文件工具 |
| 完成 | 有 `COMPLETED` | 任务态/群聊态显示“已完成”；60 s 后回落 idle | `chats.js:111-134`（TTL 60 s） |
| 失败/阻塞 | 有 `FAILED/BLOCKED/STALE` | 红色 tone；但 `BLOCKED` 仍算在线（见 POLL-6） | `chats.js:111-134`；`AgentPresence.tsx:31` |

- **POLL-5（P2）状态粒度**：UI 文案来自 `AGENT_STATE_LABELS`（`chat.ts:405-417`）与 `normalizeAgentState`（`419-455`）；`needs_reply` 被映射成 `idle` + label“等 Muse 回复”（`chat.ts:450-451,467-468`），于是 `normalizeChatStatus:486-489` 的“needsMuse → waiting”分支永远不命中，Muse 的 tone/thinking 判断实际是 idle。建议 `normalizeAgentState('needs_reply')` 单独返回 `waiting`，不要把展示 label 当状态。
- **POLL-6（P3）在线口径**：`OFFLINE_STATES = failed/stale/unknown`（`AgentPresence.tsx:31`），`BLOCKED` 不计入离线，于是 `ChatHeader` 的“4 人”会在 agent 阻塞时仍算在线（`ChatHeader.tsx:63-76`）；同时 tone 又是 error，视觉与文字矛盾。建议把 `blocked` 纳入离线或单独显示“阻塞”。
- **POLL-9（P3）重试幂等**：`Composer` 每次 `send()` 都生成新的 `clientMsgId`（`Composer.tsx:219`），而超时/网络失败后重试会用新 key；后端幂等只对相同 `client_msg_id` 生效（`messages.js:408-525`）。若第一次实际已落库，重试会重复。建议在 `send()` 外生成一次并保存到草稿。

### 5.4 是否反复读附件、重建上下文

- **轮询不读附件字节**：消息列表只返回元数据（目前甚至只有 ID）；`FileCard` 的图片预览只在挂载时请求一次（`FileCard.tsx:77-92`），文本预览在点击时请求（`94-113`）。
- **每次挂载会回源**：协议 `no-store`（`chat-protocol.ts:84,94`）→ 切群/开文件页重复 `read_chat_file`；文档读的是上传时缓存的 `.extracted.txt`，图片每次读原文件并 base64。
- **上下文确实每轮重建**：`deliverChatActions` 对每个 recipient 各调用一次 `buildChatContext`（`messages.js:734-745`）；上下文包含最近 30 条消息（默认）+ **本群全部 200 个文件的清单**（`context.js:48-57,80-92`），不是本次附件。后端审计 §5.4 已列为重复构建；前端能感知到的后果是“每次派发 prompt 都带全量文件清单”，与轮询无关。
- **结论**：用户担心的“轮询导致反复读附件”**不成立**；真正的浪费是“每轮派发重复构建/全量文件清单 + 图片预览无缓存”。

### 5.5 发送与显示

- **POLL-7（P2）无乐观消息**：`Composer.send()` 先逐文件上传（`Composer.tsx:184-210`），再 `sendChatMessage`（`212-220`），成功后才清空并 `await onSent()`（`227-232`）；`onSent` → `refreshActive()` → 再拉 `chats/messages/status`（`ChatPage.tsx:54-56`；`chat-store.ts:324-331`）。空窗期 = 上传 + 发送 + 3 次拉取，慢网下明显。
- **双发送路径**：`chatStore.send()` 实现了“发送后自行刷新”（`chat-store.ts:299-309`），但 Composer 完全不调用它，改走 `lib/chat.sendChatMessage + ChatPage.refreshActive`；两条路径并存，后续容易只改一条。
- **POLL-4（P0）未读链路断裂**：
  1. 引擎 `list()` 只返回 `describe + needs_muse + agents{claude,dsh}`（`src/chats.js:226-234`），**没有 `unread`**；
  2. 前端 `normalizeChat` 的 `unread` 回退 0（`chat.ts:231`）；
  3. 侧栏未读徽标/筛选永远空（`ChatSidebar.tsx:114-115,122,155-159`），注释还写着“server-side chat.unread”（`27-31`）；
  4. `markChatRead` 只在 `chatStore.markRead` 里被调用（`chat-store.ts:311-321`），而 `useMarkChatRead` 无任何组件引用（`430-438`），`preload.chatMarkRead`/`main.ts:508` 因此成为死通道。
  后端审计 P2-8 也确认 `last_read_seq` 全 0、`chat_mark_read` 未被 GUI 使用。

### 5.6 建议

1. **单一数据源**：HUD 不再自己拉 `list_messages`；改用 ChatStore 的群聊快照（或新增 `presence` 聚合接口），并让 `list_messages` 默认排除 `chat_id IS NOT NULL`（保留 `chat_id` 参数给显式查询）。
2. **轮询分层**：消息 3 s 只在“最近 90 s 有活动或窗口可见”时跑；空闲退到 10 s；错误指数退避（3→6→12→30 s）；所有 poller 统一 `document.hidden` 暂停。
3. **快照相等性**：`fetchMessages` 在 `incoming.length===0` 时直接 return（不 `set`）；`fetchChats/fetchStatus` 比较关键字段后再 set；`React.memo(MessageBubble)` + `useMemo(parseBlocks, [text])`；>100 条时虚拟列表。
4. **分页**：`before` + `has_more` 做“加载更早”，内存上限 500 条；`after_seq` 增量若一次 >200 条，循环拉到追平。
5. **未读**：`list_chats` 增加 `unread`（基于 `last_read_seq` 与最大 seq）；ChatPage 在 `newestSeq` 前进时调用 `useMarkChatRead`；侧栏选中会话后徽标清零。
6. **乐观发送**：用 `client_msg_id` 插入 pending 气泡，`list_chat_messages` 返回后按 ID 替换；失败保留重试，且复用同一个 `client_msg_id`。
7. **流式**：短期用“任务 WORKING + 最近日志摘要”做占位；中期让引擎提供 SSE/事件表，前端订阅 token/阶段，而不是再加轮询。

---

## 6. 身份颜色与消息气泡

### 6.1 规范 vs 实现

| 身份 | 规范要求 | 实现 | 证据 |
|---|---|---|---|
| Muse | 紫 | `--identity-muse: #8b7cff`；名字 `#6d28d9`；头像实色紫；气泡 `#f1eeff` | `brand.css:50-52`；`chat.css:982-983,994-997,1009-1011` |
| Claude | 橙 | `--identity-claude: #e85d26`（= 品牌 accent）；名字 `#c0471a`；气泡 `#fbe8df` | `brand.css:24,53-55`；`chat.css:986-987,999-1002,1013-1015` |
| dsh | 蓝 | `--identity-dsh: #3b82f6`；名字 `#1d4ed8`；气泡 `#ebf2fe` | `brand.css:56-58`；`chat.css:990-991,1004-1007,1017-1019` |
| User | 灰 | `--identity-user: #8a8f98`；名字 `#5f656e`；气泡保持 `--surface`（中性） | `brand.css:59-61`；`chat.css:519-522,1021-1023` |

- 深色 token 成对存在（`brand.css:119-130`），聊天内头像/气泡切换正常。
- 四色都写进了 Astryx 主题（`theme/brand-theme.mjs:80-91`，含 purple/blue 的 background/border/icon/text），但 `docs/DESIGN_SYSTEM.md §9` 没有登记 `--identity-*`，而 `chat.css:1-4` 头部注释却写“Tokens: docs/DESIGN_SYSTEM.md §9”。

### 6.2 问题

- **ID-1（P1）橙色三重语义**：`--accent`（主按钮、选中态、聚焦环）＝ `--identity-claude` ＝ HUD `hud-ring__arc--working` 的 `#e85d26`（`brand.css:24,53`；`hud.css:90-94`）。同一屏里，“橙色”既表示“可点击主操作”，又表示“Claude”，又表示“某 agent 正在干活”。目标设计要 Claude 橙可以保留，但必须把 HUD 的 working 环改成墨色/中性动画，或给 Claude 换一个不与 accent 重合的橙。
- **ID-2（P1）规范冲突**：`BRAND_GUIDELINES.md:164`（HUD 例外节）明确“身份只用单色图形区分……不用颜色区分 agent”，而群聊新 UI 用四色身份；`gui/src/assets/sidebar/README.md:21` 仍声称“图标仅用于身份识别（形状），颜色/文字/状态角标负责表达状态，符合 §6”。规范、素材说明、实现三份口径不一致；且 HUD 仍是“白标 + 状态色”，聊天是“身份色 + 白标”，同一个 agent 跨面视觉不统一。
- **ID-3（P1）名字/模型不可配置**：
  - 名字硬编码在 5 处（见 UI 表）；
  - 引擎 `chat_participants.display_name` 存在（`src/store.js:194-206,927-950`；`chats.js:146-170` 也返回了 `display_name`），但 `normalizeParticipant` 只读 `name/label`（`chat.ts:247`），**`display_name` 被丢弃**；
  - `current_task_id`/`pending_deliveries` 同样被丢弃（`chat.ts:251` 读的是 `task_id`）；
  - 聊天内没有模型信息；只有 HUD 悬停卡的“模型”行（`AgentHud.tsx:99-101`，值来自 `hud.ts:159` 的 `gateway.model`）和设置页执行器行（`SettingsPage.tsx:724-726`）。
  - 没有头像/显示名/模型开关或设置项；`hud.json` 只有 `paperPlanes/contextWindowTokens`。
- **ID-4（P2）侧栏头像缺 Muse**：`list_chats` 的 `agents` 只有 `claude/dsh`（`chats.js:230-233`），`ChatSidebar` 用 `Object.keys(chat.agents)` 渲染（`123,137-141`）→ 会话列表只显示 claude/dsh/User，看不到 Muse；而 `ChatSummary.agents` 类型声明为三位（`types.ts:333`），类型掩盖了缺失。
- **ID-5（P3）头像风格**：侧栏 28px 白标 + 细边 + `-8px` 叠放（`brand.css:2389-2402`），聊天 32px 实色圆（`chat.css:390-393`）；User 用 lucide 线条图标，agent 用白色位图，风格不统一。白标在身份色底上对比 ≈3.2:1（图形可接受），但在浅色 subtle 底上失效。
- **ID-6（P2）气泡/元信息**：气泡只显示发送者名、时间、投递状态（`MessageBubble.tsx:339-346`），没有模型、任务、回复链；`message.status` 是投递状态（`stored/answered/held`），不是 agent 状态，容易被误读为“已回复=任务完成”。
- **ID-7（P3）@提及**：输入侧支持并传给后端，但消息渲染不解析 `mentions`（`MessageBubble` 未使用该字段），`@claude` 仍是纯文本；`ChatMessage.mentions` 目前只存在于类型里。

### 6.3 建议

- 建 `lib/identity.ts`：`{ id, name, mark, colorVar, mention }` 单一来源；名称优先 `participants[].display_name`，回退常量。
- 聊天成员浮层增加“模型 / 当前任务 / 待投递”行（数据已在 `chat_status` 里，只需透传 `display_name/current_task_id/pending_deliveries`）。
- 侧栏头像改实色底 + 白标（与聊天一致）；浅色/深色各截一张图作为验收。
- 解决橙色冲突：HUD working 环改 `--text`/墨色；把“Claude 橙”限定在身份元素（名字/头像/气泡边），不要同时承担主操作色；在 BRAND_GUIDELINES/DESIGN_SYSTEM 增补“身份色例外”条款并同步 README。
- 若要“可配置”，先做只读展示（display_name/model），配置化放 Phase 3；这需要后端提供 per-chat participant 更新接口，当前只有 store 层 upsert。

---

## 7. 其他发现

- **DOC-1（P3）文档漂移**：`gui/src/lib/chat.ts:21` 引用不存在的 `docs/upgrade-frontend-phase4.md`；`MessageList.tsx:20-21` 注释声称“Messages carry their attachments as full ChatFile objects”，与事实相反；`ChatSidebar.tsx:27-31` 注释声称 unread 是 server-side；`gui/README.md` 仍描述旧“五屏”；`DESIGN_SYSTEM.md §9` 无身份 token；后端文档工具数 19/27 与实际 28 不一致（见后端审计 P2-10）。
- **DOC-2（P3）死代码/死通道**：`LIST_POLL_MS`（`chat-store.ts:39`）；`chatStore.send`（`299-309`）；`.chat-avatar--agent/--mark`（`chat.css:395-406`）；`preload.pickChatFiles/discardChatDrafts`（`preload.ts` 有、渲染层无调用）；`engine:chat-messages` 别名（`main.ts:449`）；`engine:message-list` 旧路径；`ChatMessage.mentions` 未渲染。
- **DOC-3（P2）文件页刷新不刷文件**：刷新按钮只 `refreshChats()`（`FilesPage.tsx:20-33,78`），文件列表只在 `selectedId` 变化时拉（`40-64`）；同一群聊新增文件后点刷新看不到；且 `listChatsOnce` 默认只取 active，归档群文件不可达。
- **DOC-4（P2）搜索范围**：只搜已加载的 `message.summary`（`ChatPage.tsx:48-52`；`MessageList.tsx:72-76`），不搜 `body`、文件名、发送者；无“加载更多结果”。
- **DOC-5（P3）无障碍**：会话列表 `role="list"` 但 item 是裸 `div`，无 `role="listitem"`（`ChatSidebar.tsx:213` 起）；成员头像 `aria-hidden`，在线状态只靠颜色点（`AgentPresence.tsx:139-153`）；`chat-item__unread` 有 aria-label（好），但徽标数字无 `aria-live`。

---

## 8. 问题清单（按风险）

> 编号与上文一致；“依据”均为当前 HEAD `a08d9d1` 的真实代码/快照。

风险口径：**P0** = 需求主链路实际不可用或数据展示错误，必须先修；**P1** = 显著影响体验/正确性且有系统性成因，本阶段应修；**P2** = 结构、一致性或边界问题，随重构修；**P3** = 整洁度与打磨。

### P0（必须先修）

| # | 问题 | 依据 | 建议 |
|---|---|---|---|
| ATT-1 | 群聊附件卡片 UUID/0 B/legacy-path | `chats.js:257-259`；`chat.ts:270-289,326-330`；`FileCard.tsx:137-142`；运行时快照 | 消息返回附件对象（复用 `context.fileRef`），或在渲染层用 `list_chat_files` 合并；卡片只认真实元数据 |
| POLL-4 | 未读链路为空（徽标/筛选恒 0，mark_read 从未调用） | `chats.js:43-55,226-234`；`chat.ts:231`；`ChatSidebar.tsx:114-159`；`chat-store.ts:430-438` | `list_chats` 返回 `unread`；ChatPage 接 `useMarkChatRead`；侧栏选中即清零 |

### P1（体验/正确性）

| # | 问题 | 依据 | 建议 |
|---|---|---|---|
| LAY-1 | 侧栏不可拖拽/折叠/持久化/双击重置（明确需求全部缺失） | `ChatSidebar.tsx` 全文；`AppFrame.tsx:43`；无 localStorage | 加手柄/折叠/持久化/键盘 |
| ATT-2 | `parse_error` 四层丢失，失败原因不可见 | `files.js:457-458`；`attachments.ts:314-341`；`types.ts:352-368`；`FileCard.tsx:140-143` | 全链路加 `parse_error`，卡片显示“失败原因” |
| UI-4 | 浅色主题会话头像不可见 | `brand.css:2389-2425`；`assets/sidebar/README.md:13` | 侧栏改用实色身份底或深色 mark |
| UI-5 | 白字橙底 3.5:1；选中态 CSS 重复覆盖 | `brand.css:2359-2377,2443-2444`；`2228-2234` | 用 `--on-accent`；删重复规则 |
| POLL-1 | 双 3 s 消息轮询 + HUD 最旧 500 条冻结 | `chat-store.ts:37,140-145`；`hud.ts:48-49,338-430`；`store.js:724-726` | HUD 复用 ChatStore；`list_messages` 排除群聊 |
| POLL-2 | 每次轮询全量通知/重渲染，无 memo/虚拟列表 | `chat-store.ts:124-134,235`；`MessageBubble.tsx:315`；`MessageList.tsx:104-110` | 相等性短路 + memo + 虚拟列表 |
| POLL-10 | N+1 放大（≈400 查询/s 量级） | 后端审计 §5.3；本报告 5.2 | 批量 `IN`；轻量 status；缓存 |
| ATT-10 | 无历史分页，`has_more` 丢弃 | `chat-store.ts:40`；`chat.ts:764`；`chats.js:270` | `before` 分页 + 追平增量 |
| ATT-11 | 只渲染 summary，body 丢弃，无截断提示 | `chats.js:254-255`；`messages.js:353-360`；`chat.ts:342`；`MessageBubble.tsx:354` | 渲染 body；显示“已截断”；搜索 body |
| ID-1 | 橙色三重语义（accent/Claude/working） | `brand.css:24,53`；`hud.css:90-94` | HUD working 改墨色；橙色限定身份 |
| ID-2 | 身份色与 BRAND_GUIDELINES 冲突，跨面不一致 | `BRAND_GUIDELINES.md:164`；`assets/sidebar/README.md:21`；`chat.css:994-1019` | 更新规范为“群聊身份色例外”；HUD 同步 |
| ID-3 | 名字硬编码、display_name 丢弃、模型不可见 | `chat.ts:237-255`；`MessageBubble.tsx:19-26`；`AgentHud.tsx:99-101` | 统一 identity 源；成员浮层显示模型/任务 |

### P2（结构/一致性）

| # | 问题 | 依据 | 建议 |
|---|---|---|---|
| LAY-2 | 窗口不 clamp 屏幕、不持久化 bounds | `main.ts:1041-1045`；无 `screen` | 按 workArea clamp + 保存 bounds |
| ATT-5 | 预览/读取上限不一致（图片 5 MB 引擎 vs 20 MB 上传；文档 2 MB 静默截断），失败被 404 吞掉 | `attachments.ts:140,644,656-658`；`files.js:736-739,862-868`；`chat-protocol.ts:74,97-98`；`FileCard.tsx:80-87` | 上限统一并在 UI 标注截断；协议层保留错误；卡片展示 previewError |
| ATT-8 | 批量上传全有全无 → 重复/孤儿文件 | `Composer.tsx:198-205`；`chat.ts:992-997`；`files.js:550-571` | 逐文件成败 + 后端去重/引用 |
| UI-1 | 双消息栈（MessageBubble vs ConversationPanel） | `MessageBubble.tsx`；`ConversationPanel.tsx:50-57,92-106` | 抽公共卡片或下线旧栈 |
| UI-2 | 三套按钮体系混用 | `astryx.tsx:38-103`；`brand.css:519+`；`ChatPage.tsx:82` | 统一到 AppButton 或登记聊天 primitives |
| ATT-3 | 状态英文直出 | `FileCard.tsx:142`；快照 `failed/parsed` | 中文状态映射 |
| ATT-4 | 历史路径被当 `file_id` | `chat.ts:277`；`FileCard.tsx:80,105,118` | 独立 `legacy_paths`，禁用操作 |
| ATT-7 | CSP 缺 `blob:`（缩略图，待实测） | `main.ts:988,1001`；`AttachmentBar.tsx:30-37` | 补 `blob:` |
| POLL-3 | 隐藏窗口仍轮询 | `engine.ts:69-76,196-203`；`hud.ts:323-324` | 统一 hidden 暂停 |
| POLL-5 | 状态粒度/`needs_reply` 映射错 | `chat.ts:450-451,486-489` | 独立 waiting 状态 |
| POLL-7 | 无乐观消息 + 双发送路径 | `Composer.tsx:170-232`；`chat-store.ts:299-309` | 乐观气泡；收口一条发送路径 |
| POLL-8 | 无流式 | `messages.js:832-875`；单次 JSON-RPC | 中期 SSE/事件表 |
| ID-4 | 侧栏缺 Muse 头像 | `chats.js:230-233`；`ChatSidebar.tsx:123` | 后端补 muse 或前端固定 4 人 |
| ID-6 | 元信息缺模型/任务/回复链 | `MessageBubble.tsx:339-346` | 扩展 meta 行 |
| DOC-3 | 文件页刷新不刷文件 | `FilesPage.tsx:20-64,78` | 刷新同时拉 files |
| DOC-4 | 搜索仅 summary | `ChatPage.tsx:48-52`；`MessageList.tsx:72-76` | 搜 body/文件名/发送者 |

### P3（整洁/打磨）

| # | 问题 | 依据 |
|---|---|---|
| LAY-3 | 900px 断点在应用内不可达；1180px 断点不涉及聊天；无“窄屏收侧栏”中间态 | `brand.css:2042-2111`；`chat.css:27-31,960-973`；`hud.css:377-381`；`main.ts:1044` |
| LAY-4 | 宽屏无阅读列上限/居中 | `chat.css:10-19,486` |
| UI-3 | 三份 formatSize、三份 kind 判定、两套 mention 解析 | `FileCard.tsx:6-38`；`AttachmentBar.tsx:13`；`labels.ts:213`；`chat.ts:537`；`Composer.tsx:36` |
| UI-6 | 硬编码阴影/颜色 | `chat.css:142,160,397,827,1386`；`brand.css:358` |
| UI-7 | 死样式/魔法数字 | `chat.css:395-406`；`brand.css:336/28/-8` |
| ATT-6 | `no-store` 无缓存 | `chat-protocol.ts:84,94` |
| ATT-9 | intake source 恒 drop | `chat.ts:951` |
| POLL-6 | BLOCKED 计在线 | `AgentPresence.tsx:31`；`ChatHeader.tsx:69-76` |
| POLL-9 | 重试不复用 clientMsgId | `Composer.tsx:219`；`messages.js:408-525` |
| ID-5 | 头像风格/叠放不统一 | `brand.css:2389-2402`；`chat.css:390-393` |
| DOC-1/2/5 | 文档漂移、死通道、a11y 细节 | 见 §7 |

### 核对通过项（不是问题）

- 无渐变、发光、玻璃拟态、emoji 图标；无“AI 味”视觉。
- 字重仅 400/600，未滥用 700。
- 附件存储/解析/路径校验/权限边界正确；`file_id` 是唯一句柄，无 host path 泄漏；CSP 只放行 `chat-attachment:`。
- 三栏网格、`content--chat`、消息流内部滚动、HUD 悬停 portal 等布局实现是正确的。
- 后端已有 `client_msg_id` 幂等、sha256 校验、per-chat 目录校验，前端只需要正确使用。

---

## 9. Phase 2 重构建议

### 9.1 第一批（P0/P1，前端可独立完成，约 2–3 人日）

1. 附件卡片修复：先用方案 B（`list_chat_files` 合并）立刻消除 UUID/0 B；同时提后端契约变更（方案 A）排进下一批。
2. 状态中文化 + `parse_error` 透传四层（`attachments.ts/types.ts/chat.ts/FileCard`）。
3. 未读：`list_chats` 返回 `unread`（后端小改）+ `useMarkChatRead` 接线。
4. 浅色头像 + 白字橙底修复；删重复 CSS。
5. 轮询：HUD 停用独立消息轮询；`list_messages` 排除群聊；快照相等性短路；`React.memo` + `parseBlocks` memo；全 poller hidden 暂停 + 错误退避。
6. 侧栏拖拽/折叠/持久化/双击重置；窗口 clamp + bounds 持久化。

### 9.2 第二批（需要后端契约，约 2–3 人日）

1. `list_chat_messages` 返回附件对象（`fileRef` + `parse_error`），legacy 路径独立字段；更新 `CHAT_BACKEND`/类型。
2. `list_chat_messages` 批量取附件（消 N+1）；`list_chats` 单条聚合（unread/agents/pending）。
3. 分页 `before/has_more` 与增量追平；`body` 透出与 `summary_truncated`。
4. 逐文件上传结果与 sha256 去重/引用。
5. 统一的 `presence`/`chat_status` 轻量接口（为 HUD 复用 ChatStore 铺路）。

### 9.3 第三批（视觉/交互统一）

1. 抽 `MessageCard` 统一聊天/任务详情；统一按钮/文件/字节格式化。
2. 身份规范落文档：`DESIGN_SYSTEM` §9 增 `--identity-*`，`BRAND_GUIDELINES` 增“群聊身份色例外”，`README` 同步；HUD 去掉橙色 working 环。
3. 身份可配置（display_name/model 只读展示 → 设置页可改）。
4. 流式/阶段指示（SSE 或事件表），替代纯轮询。
5. 宽屏阅读列、浅/深双主题截图回归。

### 9.4 验收标准（可直接作为 Phase 2 的 DoD）

1. 新建群聊 → 发送 1 个 PDF + 1 张 PNG：聊天卡片显示真实名称/大小/类型/解析状态；失败文件显示原因；历史路径显示“历史附件（不可下载）”且不调用文件接口。
2. 1080×700 / 1440×900 / 1920×1080 × 浅/深 共 6 张截图；侧栏 260–480 拖拽、折叠、重启恢复、双击 336 全部可用。
3. 200+ 条消息的群聊可“加载更早”；未读徽标收发正确、切换会话清零；“有未读”筛选可用。
4. 聊天页空闲 30 s 的 IPC 调用显著下降（目标 <20）；React DevTools Profiler 中无 3 s 一次的全列表提交。
5. 发送后 ≤100 ms 出现 pending 气泡；失败重试不产生重复消息。
6. 身份：四色 token 生效、浅色头像可见、成员浮层显示模型/任务、橙色不再同时表示 working。
7. `npm run typecheck` / `npm run build` 通过，控制台无新增错误；本报告 P0/P1 项全部关闭。

---

## 10. 附录

### A. 关键文件行号索引

| 主题 | 位置 |
|---|---|
| 三栏网格 / token | `gui/src/styles/brand.css:77-78,290-299` |
| 侧栏样式 / 头像 | `brand.css:2149-2158,2389-2430` |
| 选中态/未读 | `brand.css:2228-2234,2359-2380,2443-2444` |
| 聊天页/消息流 | `gui/src/styles/chat.css:10-31,424-441,481-522` |
| 身份色 | `brand.css:47-61,119-130`；`chat.css:981-1023`；`theme/brand-theme.mjs:80-91` |
| 附件卡片 | `gui/src/components/FileCard.tsx:6-38,77-143` |
| 消息气泡 | `gui/src/components/MessageBubble.tsx:19-37,265-301,315-386` |
| 会话列表 | `gui/src/components/ChatSidebar.tsx:27-49,107-160,213-280` |
| 轮询 | `gui/src/lib/chat-store.ts:37-39,124-155,210-241`；`gui/src/lib/hud.ts:48-49,323-430`；`gui/src/lib/engine.ts:19-79,140-206,208-279,367-371` |
| 引擎契约 | `src/chats.js:43-55,111-134,146-170,208-272`；`src/messages.js:353-360,734-745,832-875` |
| 文件服务 | `src/files.js:447-461,536-583,585-627,724-871`；`src/context.js:12-21,45-108` |
| 主进程窗口/CSP/协议 | `gui/electron/main.ts:988,1001,1041-1045`；`gui/electron/chat-protocol.ts:22,50-101` |
| 上传归一化 | `gui/electron/attachments.ts:140,314-341,633-686` |

### B. 复现附件问题的步骤（Phase 2 验证用）

1. 启动 GUI（隔离引擎即可），进入群聊 `dc1aa3bc-70c4-45b3-bae6-bed4f89ea55a`（或任一新群聊）。
2. 上传 `phase6-summary.pdf`，等待 Muse/Claude 回执。
3. 观察消息卡片：名称应为 UUID、meta 应为 `文件 · 0 B · legacy-path`；打开“文件”页，同一文件显示 `phase6-summary.pdf · PDF · 2.3 KB · parsed`。
4. 点击卡片“下载”应成功（`file_id` 正确）；点击“预览”对 `failed` PDF 应显示 `cannot read …` 的引擎原因（证明原因存在但卡片不展示）。

### C. 未验证项 / 下一步

- 浅色主题截图（头像、选中行、未读徽标对比度）。
- `blob:` 缩略图在 CSP 下的实际表现。
- 5–20 MB 图片预览失败的表现（是否只缺缩略图），以及文档提取文本 >2 MB 时的截断。
- 真实 200+ 消息的滚动性能与 React 提交次数。
- 目标设计图的像素级对照（本报告未做）。