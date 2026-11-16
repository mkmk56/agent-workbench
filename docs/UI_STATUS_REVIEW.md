# UI 视觉重构 Phase 1：现状审查（只读审计）

> 审计对象：`D:\Claude\agent-workbench\gui`（渲染层 + 主进程）与 `docs/` 设计规范
> 分支：`gui/group-chat-upgrade`；基线 HEAD：`7d1f8c1`（docs: Phase 2 refactor plan）
> 审计日期：2026-11-17
> 底本：`docs/audit-frontend-phase1.md`（同日的前端审计。本报告**不重做**功能/契约审计，只补全视觉维度；引用其结论时标注「底本」）
> 目标方向：Premium Matte Black（去信号橙 → 高级磨砂黑 + 冷银灰强调色）
>
> **只读声明**：本次未修改任何业务代码、未运行 GUI、未执行 `npm run typecheck/build`、未新增截图。所有行号均对基线 HEAD 的源码；`gui/dist`、`gui/dist-electron`、`gui/release` 属于构建产物，**不计入统计**。`gui/src/theme/brand.generated.css` 是 `scripts/build-theme.mjs` 从 `brand-theme.mjs` 生成的产物，但它被签入仓库并被 `main.tsx` 直接 import，因此**计入**源码统计（改动必须改源文件 `brand-theme.mjs` 后重新生成）。

---

## 0. 结论先行

### 0.1 一句话结论

**Palette 集中度很高（这是好消息），但橙色的语义被摊薄在 5 个层面，且视觉系统本身存在 3 处结构性冲突（双消息栈、三套按钮、双 settings-nav），去橙不能只改 `brand.css:24`。**

三条主要结论：

1. **改色成本低**：颜色几乎全部走 `:root` / `html[data-theme="dark"]` 的自定义属性（`brand.css:9-135`）与 Astryx 主题源（`theme/brand-theme.mjs`）。真正的硬编码只集中在 5 个文件（`brand.css`、`hud.css`、`chat.css`、`astryx-overrides.css`、`PaperPlaneLayer.tsx`），其中橙色字面色值 58 个，而 `hud.css` 一件就有 20 处裸色，是最大的一块「脱离 token」的旧债（底本未覆盖，本报告新增）。
2. **改语义成本高**：`--accent`（主操作/选中/焦点）、`--identity-claude`（Claude 身份）、HUD `hud-ring__arc--working`（Agent 干活中）、Astryx `--color-info` + `AppStatus tone="running"`（任务运行中）**四个概念共用同一个橙**。只换色值 = 四个概念一起变成银灰，界面上「主操作」和「正在执行」会失去区分度。必须先定语义，再定色值。
3. **视觉问题的根因不是颜色，是层次**：磨砂黑目标的 surface 阶梯（`#090A0B → #0D0F11 → #101214 → #141619 → #181A1D → #1D2024`）相邻对比只有 **1.02–1.10:1**（本报告实测），而目标边框 `#292D32` 对 `#101214` 只有 **1.35:1**。这意味着「只换色值」会得到一个**没有层次的纯黑平板**——必须改用 1px 边框 + 内侧 1px 高光（`inset 0 1px 0 rgba(255,255,255,.04)`，**不是外发光**）+ 间距与字号层级来建立层次。这正是任务书「Anti-AI Slop」要防的反面。

### 0.2 关键数字（演讲/汇报口径）

| 指标 | 数值 | 口径 |
|---|---|---|
| 橙色触点总数 | **170 处** | 见 §2.4 分解：字面橙 27 + 橙色阶字面 31 + `var(--accent*)` 89 + `var(--identity-claude*)` 6 + `var(--focus-ring)` 6 + 橙底白字/白点 5 + Astryx 橙色 token 名 5 + `running:'orange'` 1 |
| 其中字面十六进制 | **58 处** | `#e85d26` 27 + `#f26b36/#c0471a/#fbe8df/#ff8a5c/#3a2620` 31 |
| 涉及橙色定义/引用的文件 | **9 个** | brand.css、chat.css、hud.css、conversation.css、astryx-overrides.css、brand-theme.mjs、brand.generated.css、ui/astryx.tsx、PaperPlaneLayer.tsx（纸飞机墨色，非橙但同源硬编码） |
| 任务书 16 个模块 | **16 个全部有实现** | 但「顶部标题栏」「滚动条」「Tooltip/右键菜单」属于**缺失或半缺失**，见 §3 |
| 需要修改的文件 | **25 个必改 + 7 个复核** | 5 CSS + 2 主题 + 14 组件/适配层 + 3 页面 + 1 Electron 主进程 |
| 死 CSS（确认无引用） | 约 **158 行** mockup 索引 + 约 **90 行** chat-card + 若干 topbar 残留 | 见 §4.7 |
| 白字橙底对比度 | **3.49:1** | `#fff` / `#E85D26`，13px 会话名、11px 未读徽标均低于 AA 4.5:1 |
| 浅色底橙字对比度 | **4.26:1** | `#C0471A` on `#FBE8DF`（选中行名字），**低于 AA 4.5:1**；底本与 `DESIGN_SYSTEM.md` 都只算了 on-Paper 的 4.55:1 |

### 0.3 给用户的三项待拍板（本报告不替你决定）

1. **Claude 身份如何表达**（§6，3 个选项）；
2. **浅色主题去留**（§7：继续双主题维护，还是改为 dark-first + 「纸白」变体，直接决定工作量 2 倍差）；
3. **warning/error 语义色是否也去饱和**（磨砂黑下 `#F0A63C` 琥珀 / `#F08A7E` 珊瑚仍带橙味，且 HUD waiting 环用的就是它）。

---

## 1. 当前 UI 架构

### 1.1 技术栈与构建

| 层 | 现状 | 证据 |
|---|---|---|
| 框架 | React 18 + TypeScript，`StrictMode` | `gui/src/main.tsx:1-19`；`gui/package.json` |
| 桌面壳 | Electron（主进程 + preload 白名单桥），`autoHideMenuBar: true`，**默认系统标题栏**（无 `titleBarStyle`/`frame:false`） | `gui/electron/main.ts:1041-1050` |
| 构建 | Vite（`vite.config.ts`）+ `tsconfig.electron.json` 双编译 | `gui/vite.config.ts` |
| 组件体系 | **Astryx 设计系统**（`@astryxdesign/core`）为主，配一层品牌适配 `ui/astryx.tsx`（`AppButton/AppIconButton/AppStatus/AppBadge/AppEmptyState/AppSegmented…`） | `gui/src/ui/astryx.tsx:1-360` |
| 样式方案 | **纯全局 CSS**，BEM 风格类名。**无 Tailwind、无 CSS Modules、无 CSS-in-JS**；内联样式仅 11 处（`AgentHud` 2、`AttachmentBar` 1、`ConversationPanel` 1、`AboutPage` 5、`TaskDetailPage` 2，均非颜色） | 全仓 grep `style={{` |
| 图标 | `lucide-react`，`strokeWidth` 1.6–2，尺寸 12–32 | 各组件 |
| 字体 | Segoe UI Variable / 微软雅黑 UI（`--font-ui`）；Cascadia Code（`--font-mono`） | `brand.css:72-75` |

### 1.2 样式分层与加载顺序（重要风险）

`main.tsx:3-9` 的 import 顺序即 CSS 级联顺序：

```
@astryxdesign/core/reset.css      ← 第三方 reset
@astryxdesign/core/astryx.css     ← 第三方组件（@layer astryx-base/astryx-theme）
./theme/brand.generated.css       ← 由 brand-theme.mjs 生成的 Astryx token（light-dark()）
./styles/brand.css                ← 品牌 token + 全站基础/组件/布局（2540 行，最重）
./styles/astryx-overrides.css     ← 覆盖 Astryx（未分层，靠「无 layer 胜有 layer」）
./styles/hud.css                  ← HUD 胶囊 + 纸飞机（硬编码色集中区）
./styles/conversation.css         ← 结论卡片流（任务详情用）
[路由级] pages/ChatPage.tsx:14 → ../styles/chat.css   ← 聊天页样式，由页面组件 import
```

**风险 R1**：`chat.css` 是**页面级导入**，而 `brand.css` 里同时定义了大量聊天相关选择器（`.chat-sidebar`、`.chat-item*`、`.content--chat` 在 §12/13，即 `brand.css:2142-2540`）。同一界面（会话列表）的样式横跨两个文件、两种加载时机——生产构建下 CSS 抽取顺序由模块图决定，**不能依赖源码顺序**。改造时如果按「先 chat.css 再 brand.css」改，容易出现改了无效/互相覆盖。

**风险 R2**：`astryx-overrides.css` 用「无 layer 规则盖 layer」的方式工作。任何新增的 Astryx 组件样式必须继续走这个文件，否则会被 `@layer astryx-theme` 内部顺序吃掉。

**风险 R3（底本未列）**：`astryx-overrides.css` 里 `--duration-fast: 125ms / -medium-*: 225ms / -slow-*: 525–935ms` 来自 `brand.generated.css:148-165`（Astryx tempo 刻度）。我们的手写 CSS 用死的 `120ms`（20 处）。两套动效刻度并存，任务书要求的「hover 120–180 / 状态 150–220 / 弹窗 180–250」目前在**手写层**没有 token，在 **Astryx 层**有近似但不一致的值。

### 1.3 主题机制

- 双主题：`:root`（浅色）与 `html[data-theme="dark"]`（深色），均在 `brand.css:9-135`。
- 运行时：`lib/theme.ts:5-28` 从 `localStorage["agent-workbench.theme"]` 读，回退 `prefers-color-scheme`；`App.tsx` 把 `mode` 传给 Astryx `<Theme theme={brandTheme} mode={mode}>`，由 Astryx 写 `html[data-theme]`。
- Astryx token：`theme/brand-theme.mjs` 是**唯一真源**（116 行），`scripts/build-theme.mjs` 生成 `theme/brand.generated.css`（680 行，`light-dark(#x,#y)` 双值）。**改 Astryx 侧颜色必须改 .mjs 再重新生成，直接改 generated.css 会被下次构建覆盖。**
- 主进程窗口背景是**硬编码浅色**：`main.ts:1047 backgroundColor: '#F5F3EE'`。切到磨砂黑后，启动瞬间会闪一帧浅米色。

### 1.4 颜色来源（三层 + 一处漂移）

```
docs/DESIGN_SYSTEM.md §2.1「核心色板」        ← 规范层：Ink #1E2126 / Paper #F5F3EE / Signal Orange #E85D26
        ↓（人工同步）
gui/src/styles/brand.css :root / [data-theme=dark]   ← 语义 token 层（--bg/--surface/--accent/--identity-*）
gui/src/theme/brand-theme.mjs → brand.generated.css   ← Astryx token 层（--color-accent/--color-*-orange/--color-background-*）
        ↓（消费）
各 .css 规则（var()） + Astryx 组件内部 var(--color-*) + ui/astryx.tsx 的语义映射
        ↓（漂移）
hud.css / PaperPlaneLayer.tsx / brand.css 残留 16 处裸色 ← 不受主题切换影响（HUD 永远「墨色」是有意为之，其余是旧债）
```

**关键事实**：`--accent` 与 `--identity-claude` 在浅/深两套里都是同一个 `#e85d26`（`brand.css:24` vs `:53`，`:97` vs `:122`）；Astryx 侧 `--color-accent`、`--color-info`、`--color-icon-accent`、`--color-border-orange`、`--color-icon-orange` 五个 token 全是 `#E85D26`（`brand-theme.mjs:22,44,51,77,78`）。也就是说**橙色在 token 层被复制了 7 次**（2 组 brand.css + 5 个 Astryx），没有「单一真源」保护。

---

## 2. 颜色系统全量清单

### 2.1 Token 定义位置（定义点清单）

| 文件 | 区间 | 内容 | 备注 |
|---|---|---|---|
| `gui/src/styles/brand.css` | `9-80` | 浅色 token：`--bg #f5f3ee`、`--surface #ffffff`、`--surface-subtle #edeae2`、`--surface-hover #e7e3d9`、`--surface-disabled #e6e2d8`、`--border #d8d5cc`、`--border-strong #bfbbb0`、`--text #1e2126`、`--text-secondary #5f656e`、`--text-muted #8a8f98`、`--accent #e85d26`、`--accent-hover #f26b36`、`--accent-text #c0471a`、`--accent-subtle #fbe8df`、`--focus-ring rgba(232,93,38,.35)`、`--success/-text/-subtle`、`--warning*`、`--error*`、`--scrim`、`--on-accent/-success/-warning/-error`、`--identity-{muse,claude,dsh,user}{,-text,-subtle}`、`--radius-xs/sm/md/lg (2/4/8/12)`、`--shadow-1/2/3`、`--font-ui/-mono`、`--nav-rail-width 96px`、`--chat-sidebar-width 336px`、`--content-max 1600px` | 37 个颜色 token + 4 个身份 token，共 74 个字面色值 |
| `gui/src/styles/brand.css` | `82-135` | 深色同名 token（`--bg #1e2126`、`--surface #25292f`、`--border #3a4048`、`--text #f5f3ee`、`--accent #e85d26` …）+ 深色 identity | 与浅色一一对应 |
| `gui/src/theme/brand-theme.mjs` | `21-99` | Astryx token 源：accent 系 4 个、background 8 个、overlay 3 个、text/icon 8 个、border/track/skeleton/shadow 5 个、语义色 12 个、orange/purple/blue/green/yellow/red 命名族 24 个、radius 6 个 | 唯一真源 |
| `gui/src/theme/brand.generated.css` | `~190-260` | 生成物：`--color-accent: light-dark(#E85D26,#E85D26)` 等 | 勿手改 |
| `gui/src/styles/hud.css` | `7,30` | 局部变量 `--hud-bg`（#1e2126 / #25292f） | HUD 唯一 token 化部分 |

### 2.2 `--accent` 引用关系（89 处，按文件）

| 文件 | 处数 | 代表位置与用途 |
|---|---|---|
| `brand.css` | 41 | 链接与 selection（174/193）、` :focus-visible` 全局（198-203）、导航选中（390-395）、`.btn-primary`（544-551）、输入焦点（699）、勾选控件（823-824）、`status--running`（866）、`badge--running`（907-908）、表格选中行（1081-1085）、settings nav（1674-1675）、会话选中（2228-2234 / 2359-2380）、未读徽标（2443-2444）、focus 描边 5 处（198/395/2310/2476/2513） |
| `chat.css` | 29 | 菜单 hover（179-180）、搜索清除（220）、重命名焦点（295）、成员状态（360）、`chat-card__link`（598-607）、折叠按钮（1051）、@mention（1071-1072）、拖拽态（1339-1340）、附件进度条（1489）、文件页选中（1563-1565）、11 处 focus 描边 |
| `astryx-overrides.css` | 14 | 主按钮（42-53）、输入/文本域焦点（148/196）、Switch 选中（293-294）、橙色徽标（333-336）、进度填充（482）、settings-nav 选中（534-535）、卡片焦点（563） |
| `conversation.css` | 3 | 结论卡片 `conv-card--accent` 左边框（249）、图标（290）、进度条（511） |
| `hud.css` | 2 | `hud-badge--working`（298-299） |

`var(--identity-claude*)` 6 处：`chat.css:987`（发送者名）、`1000`（头像底）、`1014`（气泡底）、`1194`（成员行名字）、`brand.css:2418-2419`（侧栏头像）。`var(--focus-ring)` 6 处：`chat.css:733/1340`、`astryx-overrides:149/197`、`chat.css:296`（重命名）、`brand.css` 无（全局 focus 用实线）。

### 2.3 硬编码颜色逐文件清单（token 之外的裸值）

**`gui/src/styles/hud.css`（20 处，最重灾区）**

| 行 | 值 | 用途 | 评价 |
|---|---|---|---|
| 7 / 30 | `#1e2126` / `#25292f` | `--hud-bg` | 与 `--bg/--surface` 重复定义 |
| 22 / 32 | `rgba(245,243,238,.10)` / `.22` | 胶囊边框 | 应为 Paper 上的 alpha token |
| 24 | `rgba(30,33,38,.18)` | 胶囊阴影 | 未用 `--shadow-*` |
| 51 / 57 | `rgba(245,243,238,.06)` / `.12` | 槽位底/hover | — |
| 52 | `#f5f3ee` | 槽位图标色 | = Paper |
| 61 | `#ff8a5c` | 槽位 focus 描边 | **橙色硬编码**，且是深色 `--accent-text` |
| 76 | `rgba(245,243,238,.15)` | 环轨道 | — |
| 91 | `#e85d26` | **working 环（第三重橙语义）** | 必须去橙 |
| 98 / 104 | `#f0a63c` / `#f08a7e` | waiting / error 环 | 深色 warning/error 字面复制 |
| 153 / 186 | `#1e2126` | 状态点/未读徽标的墨色文字 | — |
| 157 | `#8a8f98` | idle 点 | — |
| 161 / 185 | `#e85d26` | 状态点 working / 未读徽标底 | 未读徽标 = 面积虽小但纯橙 |
| 165 / 169 | `#f0a63c` / `#f08a7e` | waiting / error 点 | — |
| 205 / 213 | `#f5f3ee` | 排队徽标底 / flash 环 | — |
| 267-270 | `#1e2126` ×3 + `#f5f3ee` | 悬停卡图标底板 | — |

**`gui/src/styles/chat.css`（2 处 hex + 6 处 rgba）**：`397` `#1e2126`（`.chat-avatar--agent/--mark` 底——**该规则永不命中，是死样式**）、`398` rgba 边、`142/160/827/1386` `rgba(30,33,38,.16)` 阴影（应走 `--shadow-2`）、`941-942` `rgba(30,33,38,.35)` + `#1e2126`（spinner 在橙底上）。

**`gui/src/styles/brand.css`（token 块外约 16 处）**：`354` rgba 边、`358` `#f5f3ee`（导航 mark 纸底）、`391` `#fff`（导航选中图标，**白字橙底**）、`555` 内阴影、`586-592` `#a93226/#f6a99f`（danger hover，深浅各一）、`1330/1334` rgba 分隔线、`2124/2128` `var(--status-error, #b42318)`——**`--status-error` 这个 token 根本不存在，实际一直用硬编码 `#b42318`**（新增发现）、`2325` 阴影、`2366/2370/2378/2444` `#fff`（选中行文字/白点/未读底）。

**`gui/src/styles/astryx-overrides.css`（4 处 hex）**：`84-85` `#a93226`、`89-90` `#f6a99f`（destructive hover）、`53` rgba 内阴影。

**`gui/src/components/PaperPlaneLayer.tsx`（4 处）**：`118` `rgba(138,143,152,α)`、`135` `#F5F3EE`、`138` `#1E2126`、`144` `#8A8F98`——canvas 手绘纸飞机，**完全绕过 CSS 与主题**，磨砂黑下这些「纸白/墨」在近黑底上会过于刺眼或不可见。

### 2.4 橙色出现位置总数：170 处

> 口径：`gui/src` 下所有 `.css/.tsx/.ts/.mjs`，**排除 `gui/dist`、`gui/dist-electron`、`gui/release`**。同一条规则里的一处算 1。可逐条复算。

| 类别 | 处数 | 明细 |
|---|---|---|
| ① 字面 `#e85d26` | **27** | `brand.css` 4（24/53/97/122）、`hud.css` 3（91/161/185）、`brand-theme.mjs` 10（5 个 token × 双值）、`brand.generated.css` 10（同上，生成物） |
| ② 橙色阶字面色 | **31** | `#f26b36/#c0471a/#fbe8df`（brand.css 10）、`#ff8a5c`（hud.css 1 + brand.css 2 计入门内）、`brand-theme.mjs` 10、`brand.generated.css` 10 |
| ③ `var(--accent*)` 引用 | **89** | brand.css 41 / chat.css 29 / astryx-overrides 14 / conversation.css 3 / hud.css 2 |
| ④ `var(--identity-claude*)` | **6** | chat.css 4 / brand.css 2 |
| ⑤ `var(--focus-ring)` | **6** | chat.css 3 / astryx-overrides 2 / brand.css 1 |
| ⑥ 橙底上的白字/白点 | **5** | brand.css 391、2366、2370、2378、2444 |
| ⑦ Astryx 橙色 token 名 | **5** | `--color-accent`、`--color-icon-accent`、`--color-info`、`--color-border-orange`、`--color-icon-orange`（各含定义+生成两份，按 token 计 5） |
| ⑧ 语义映射 `running: 'orange'` | **1** | `ui/astryx.tsx:131` → Astryx `Badge variant="orange"` → 橙 |
| **合计** | **170** | |

补充口径：若只统计**必然要改写的字面色值**（①+②），是 **58 处**；若只统计**语义定义点**（token 定义 + 映射），是 **12 处**（brand.css 4 + mjs 5 + astryx.tsx 1 + hud.css working 弧 1 + focus-ring 定义 2，去重后）。**改色只需动 12 个定义点，但要让整个界面「没有橙」必须复核 170 个触点**——因为很多引用是「跟随 accent」的，改完 token 后语义会一起变，正是 §6 要拍板的问题。

### 2.5 对比度实测（WCAG 2.x，脚本计算）

**当前问题（新增/修正底本的数据）**

| 前景 / 背景 | 实测 | 结论 | 位置 |
|---|---|---|---|
| `#fff` / `#E85D26` | **3.49:1** | 低于 AA 4.5:1 | 会话选中名/时间/预览 `brand.css:2363-2367`；导航选中图标 `391`；未读徽标 11px `2444` |
| `#1E2126` / `#E85D26`（`--on-accent`） | 4.63:1 | 达 AA，但全站**没被用在橙底文字上**（选中行用了白） | 规范正确、实现跑偏 |
| `#C0471A` / `#FBE8DF` | **4.26:1** | **低 AA**（13px 正文） | 选中行名字 `2229-2233`、settings-nav `1674-1675`、@mention `1071-1072`、文件页选中 `1563-1565`、表格选中 `1081` |
| `#8A8F98` / `#FFFFFF` | 3.25:1 | 低 AA | 浅色下所有 `--text-muted` 小字（时间戳、文件 meta） |
| `#FFFFFF` 位图 / `#EDEAE2` | **1.20:1** | 图形不可见 | 侧栏头像（底本 UI-4，本次确认） |
| `#FF8A5C` / `#3A2620` | 6.12:1 | 通过 | 深色 accent-subtle 上的强调字 |
| `#FF8A5C` / `#25292F` | 6.29:1 | 通过 | 深色链接 |

**目标磨砂黑色板预验证（供 Phase 3 定 token 直接使用）**

| token | 值 | 对 `#090A0B` / `#101214` | 用途建议 |
|---|---|---|---|
| `--text-primary` | `#F2F3F4` | 17.83 / 16.90 | 正文与标题 |
| `--text-secondary` | `#D1D4D8` | 13.32 / 12.62 | 次要正文（消息体、说明） |
| `--text-tertiary` | `#9298A1` | 6.82 / 6.46 | 元信息（时间、状态、meta） |
| `--text-muted` | `#686F78` | **3.90 / 3.70** | **仅大字号/图形/非关键**，不得作 11–13px 正文 |
| `--text-faint` | `#4B5159` | **2.47 / 2.34** | 仅装饰、禁用、分隔符 |
| `--accent` | `#C5CBD3` | 11.98 / 11.49 | 主按钮填充（配 `--on-accent #0B0C0E`）、进度、选中条、focus 实线 |
| `--accent-hover` | `#E0E4E9` | ~14 / — | 主按钮 hover |
| `--accent-quiet` | `#A3ABB5` | 8.43 | 次级强调、图标、未选中态可交互提示 |
| `--accent-dim` | `#8D97A3` | 6.60 | 小字强调/链接（≥4.5 安全） |

**由此得到的两个硬约束（必须写进新 token 注释）**

1. **surface 阶梯自身几乎不可区分**（相邻 1.02–1.10:1）：`#090A0B/#0D0F11/#101214/#141619/#181A1D/#1D2024` 不能靠「色差」表达层级，必须靠 **1px 边框 + 一层 1px 内高光（`inset 0 1px 0 rgba(255,255,255,.04)`）+ 间距**。这直接反驳「只换色值加渐变发光」——但也不许靠发光，所以**边框与内高光是磨砂黑唯一可用的层次工具**，需要在 Phase 3 S1 就定义好 2–3 档。
2. **目标边框 `#292D32` = 1.35:1**，低于 WCAG 1.4.11 对"识别控件所需视觉信息"的 3:1。解决方式二选一（需拍板）：(a) 控件边界用 `#5F666F`（3.23:1）而分隔线仍用 `#292D32`；(b) 保持低调边框，但所有可交互控件必须带 accent 焦点/悬停态。建议 (a)+(b) 并用。

### 2.6 不重复造轮子：底本已覆盖、本报告只做视觉追加的部分

- 附件 UUID/0 B/`legacy-path`（ATT-1）、未读链路（POLL-4）、双 3s 轮询（POLL-1）、`body` 丢弃（ATT-11）、侧栏不可拖拽折叠（LAY-1）——**功能问题不在此重述**，但它们的修复与视觉改造在同一批文件里（`FileCard.tsx`、`ChatSidebar.tsx`、`ChatHeader.tsx`），Phase 3 排期必须与 Phase 2 功能修复合并，否则同一文件改两遍。
- 底本 §3.3 的「token 与规范核对」在本报告中**修正两处**：① `--status-error` 是冒牌 token（§2.3）；② 浅色 `accent-text on accent-subtle` 只有 4.26:1，底本与设计文档都漏算。

---

## 3. 需要修改的组件清单（按任务书 16 模块）

> 「改动点」只列视觉/结构改动；功能 bug 见底本。★ = 必改文件（25 个），☆ = 只受 token 影响、验收截图即可（7 个）。

| # | 模块 | 涉及文件 | 当前实现要点 | 视觉改动点 |
|---|---|---|---|---|
| 1 | 主窗口 / 全局背景 | ★`electron/main.ts:1041-1047`、★`components/AppFrame.tsx`、★`brand.css:9-158,290-299,467-478`、★`main.tsx:3-9` | `body{background:var(--bg)}`；三栏 grid `96px + var(--chat-sidebar-width) + 1fr`；窗口 1440×900 / min 1080×700，`backgroundColor:'#F5F3EE'`，无 bounds 持久化 | 新增 5 层 surface token（app/secondary/rail/workspace/overlay）+ `--bg-window`；`backgroundColor` 改 `#090A0B`（消除启动闪白）；`.app` 增加 1px 内高光/分栏边框以替代色差 |
| 2 | 左导航栏（rail） | ★`components/GlobalNav.tsx`、★`brand.css:319-465`、★`ui/astryx.tsx:80-103` | 96px 图标轨，选中 = 橙底白图标（3.49:1），hover 120ms，名字靠 `title` 属性 | 选中改「中性底 `#1D2024` + 左侧 2px `#C5CBD3` 条 + 图标 `#F2F3F4`」；未选中图标 `#9298A1`；hover 150ms 背景 `#191C20`；`title` → 自绘 tooltip（§M15）；底部引擎点/主题/设置归入同一视觉层级 |
| 3 | 顶部标题栏 | ★`electron/main.ts`（决策）、★`brand.css:483-514`、★`chat.css:36-52` | **应用内没有标题栏**：Windows 原生窗口框 + `autoHideMenuBar`；页面级用 `.page-head`（24px 标题）；聊天内用 `.chat-header__topline` | 决策项：保留系统框（0 风险，推荐 Phase 1）或 `titleBarStyle:'hidden'`+`titleBarOverlay`（需自绘最小化/最大化/关闭、拖拽区、双击还原）。无论哪条，`.page-head`/`chat-header` 的标题层级（24/20/14px 三档）要统一到新字阶 |
| 4 | 主聊天 | ★`pages/ChatPage.tsx`、★`chat.css:7-31,421-465,879-955`、★`brand.css:2517-2535` | `.chat-page` 无 max-width，`gap:12px`，消息流内部滚动，`scrollbar-gutter:stable` | 新增阅读列 `max-width: min(960px, 100%)` + `margin-inline:auto`（宽屏 2560 下当前左对齐留大片空白）；流内间距 24px → 按「同发送者合并」分档（16/28px）；`content--chat` 背景用 workspace 层而非 `--bg` |
| 5 | Agent 气泡 | ★`components/MessageBubble.tsx`、★`chat.css:466-628,981-1074,1076-1110` | 头像 + 名字（身份色）+ 时间 + 投递状态；气泡 `--surface` + 身份 `-subtle` 底；用户气泡中性；Markdown 手写解析，代码块带复制按钮 | **气泡不再按身份染色**（`1014` 等 3 条规则删除或改中性）；身份改由「头像图形 + 名字 + 细边框/标签」承载（见 §6）；气泡底用 `#191C20`，用户气泡 `#1D2024` 或加 1px 边框区分；meta 行 11px `#9298A1` 与 12px 分层；代码块底 `#0D0F11` + 1px `#292D32`，复制按钮改幽灵态 |
| 6 | 多 Agent 协作状态 | ★`components/AgentPresence.tsx`、★`components/ChatHeader.tsx`、★`components/MessageList.tsx:7-15,111-131`、★`chat.css:1112-1211` | 成员行 = 头像 + 身份色名字 + 绿点；`4 人` 浮层列真实状态；三 agent 同时 thinking 时渲染 3 条 `chat-thinking`（900ms 无限 opacity 脉冲） | 名字全部中性化；在线点从「绿点」改为「银点 + 文字」（颜色不作唯一载体）；thinking 指示器改「首字/头像 + 文字 + 极轻 1px 进度条」而非三点脉冲；多 agent 同时回复时按 agent 分组（`data-sender` 分组容器，而非 3 条同样式重复行） |
| 7 | 输入框与发送 | ★`components/Composer.tsx`、★`chat.css:707-877,1333-1408` | 单行 field 容器 + 附件/emoji/发送；发送按钮 `border-radius:999px`（任务书禁止 20px+，未登记豁免）；focus 用橙环 | 发送按钮 999px → 8px（与按钮组统一）；`focus-within` 改 `border:1px solid #5F666F` + `box-shadow:0 0 0 3px rgba(197,203,211,.16)`；placeholder 用 `#9298A1`；`drag-over` 态改「1px 虚线 accent + 底 `#191C20`」，不用橙色 |
| 8 | 文件上传 | ★`components/AttachmentBar.tsx`、★`Composer.tsx:170-232`、★`chat.css:1410-1514` | 缩略图（`URL.createObjectURL`）+ 名字 + 大小 + 3px 进度条（橙色填充）+ 移除 | 进度条填充改 `#C5CBD3`；失败态去掉整块橙红底，改「1px `#F08A7E` 左边框 + 图标 + 文字」；缩略图容器改 `#0D0F11` + 1px 边框；批量失败要能逐条呈现（配合底本 ATT-8） |
| 9 | 文件预览 | ★`components/FileCard.tsx`、★`chat.css:1213-1331`、★`pages/FilesPage.tsx`、★`chat.css:1516-1619` | 40px 缩略图 + 名字 + `类型 · 大小 · status`（英文直出）+ 预览/下载按钮列 | 卡片从「三层嵌套卡片」降为「一行式文件条」（磨砂黑下卡片套卡片会变糊）；状态中文化并把 `parse_error` 放到第二行（配合 ATT-2/ATT-3）；预览展开区底 `#0D0F11`、等宽 12px；`file-card__action` 改幽灵按钮，hover 才显边 |
| 10 | 任务分配与执行状态 | ★`conversation.css`（534 行）、★`components/ConversationPanel.tsx`、☆`pages/TasksPage.tsx`、☆`pages/TaskDetailPage.tsx`、☆`pages/DispatchPage.tsx`、★`brand.css:981-1141,1142-1500`、★`astryx-overrides.css:306-483` | 两套消息栈（聊天 vs 结论卡片）；表格/面板/日志控制台；`AppBadge tone="running"` → 橙 | 结论卡片的 5 档 tone（neutral/accent/success/warning/error）里 `accent` 必须重定义（见 §6 选项）；日志行/表格选中行去橙；`status--running`/`badge--running` 改银灰；进度条 `--accent` 改银 |
| 11 | Agent 状态指示器 | ★`components/AgentHud.tsx`、★`styles/hud.css`（整文件）、★`components/PaperPlaneLayer.tsx`、★`ui/astryx.tsx:105-135` | 44px 槽位 + SVG 环（working 橙、waiting 琥珀、error 珊瑚）+ 状态点 + 未读徽标（橙底墨字）+ 纸飞机 canvas；`AppStatus running→'orange'` | working 环去橙（→ `#C5CBD3` 或墨色动画）；未读徽标改 `#C5CBD3` 底 + `#0B0C0E` 字（11.98:1）；PaperPlaneLayer 4 个颜色参数改深色系并跟随主题（需把颜色传入 canvas 而非硬编码）；HUD 弹层（`hud-popover`）改「磨砂面板 + 1px 边框 + shadow-2」，取消 ink-on-ink 的 `#1e2126` 硬编码；`hud-flash` 白环改 accent |
| 12 | 设置页 | ★`pages/SettingsPage.tsx`、★`brand.css:1637-1783`、★`astryx-overrides.css:511-537` | 200px 分区导航（sticky）+ 7 个 `.section` 面板 + sticky `save-bar`；导航选中橙浅底 | 删掉 `.settings-nav a`（1655-1676 与 511-537 双实现，只留 button 一份）；选中改「中性底 + 2px 左边条」；`.setting-row` 网格 280px 控制列在 1080 宽下偏挤，建议 320→自适应；分区标题字重 600 / 说明 400 已有，补 11px 区段标签；`save-bar` 背景 `--bg` → workspace 层 |
| 13 | 弹窗 / 菜单 / 下拉 | ★`astryx-overrides.css:499-505`、★`chat.css:121-181,815-846,1372-1408`、★`brand.css:2314-2347`、★`SettingsPage.tsx`(AlertDialog) | Astryx `AlertDialog`（radius 12）+ 5 处手写 popover（`--surface` + `rgba(30,33,38,.16)` 阴影） | 统一「浮层 = `#151719`（或 `#1D2024`）+ 1px `#292D32` + `shadow-3` + radius 14」；菜单项 hover 从橙浅底改中性 `#1D2024`；`scrim` 改纯黑 0.6；补 180–250ms 进出场（当前无任何入场动画） |
| 14 | 滚动条 | ★`brand.css`（新增块）、★`chat.css` 已有 `scrollbar-gutter` | **全站没有滚动条样式**（只有 `.nav-rail` 隐藏）→ 走 Chromium 默认浅/深滚动条，在磨砂黑下会出现浅灰条 | 新增 `::-webkit-scrollbar`（宽 8–10px、thumb `#383D44`、hover `#4A5058`、track 透明）+ 标准 `scrollbar-color/width`；`chat-stream`/`chat-list`/`files-page__list` 显式声明 |
| 15 | Tooltip / 右键菜单 | ★`brand.css`（新增）、★`GlobalNav.tsx`/`ChatHeader.tsx`（替换 `title`）、☆ 无右键菜单 | **零实现**：全部靠原生 `title` 属性（延迟 ~1s、不可样式化、无 a11y 关联）；HUD 悬停卡是唯一的自绘浮层（portal）；`onContextMenu` 全仓 0 处 | 新增 `Tooltip` 原语（delay 400ms、1px 边框、`#151719` 底、11px、`aria-describedby`）替换 rail/header 的 `title`；**右键菜单属于新功能**（非视觉重构），建议本阶段**明确不做**并写进范围说明，避免"破坏/新增功能"红线 |
| 16 | 空 / 加载 / 错误状态 | ★`chat.css:879-955,1583-1619`、★`brand.css:2190-2208`、★`astryx-overrides.css:486-497`、★`brand.css:2123-2131` | `.chat-empty`（图标+标题+描述）、`chat-spinner`（1.5px 环，橙顶）、`chat-stream__status`、`chat-list__note/error`、`files-page__empty`、`AppEmptyState`、`Notice`/`Banner` 四色、`field__hint--error`（死 token） | 统一一套「空/载/错」组件族（尺寸 32px 图标 / 14px 标题 / 13px 说明 / 12px 错误）；spinner 顶色改 `#C5CBD3`；错误统一 `#F08A7E` 文字 + 1px 左边框，不用整块浅红底（浅红底在磨砂黑下破坏材质）；把 `--status-error` 换成真实 token |

**文件计数**：必改 25 = CSS 5（brand/chat/hud/conversation/astryx-overrides）+ 主题 2（brand-theme.mjs、brand.generated.css）+ 组件 14（GlobalNav、AppFrame、ChatSidebar、ChatHeader、MessageList、MessageBubble、Composer、AttachmentBar、FileCard、AgentPresence、AgentHud、PaperPlaneLayer、ConversationPanel、ui/astryx.tsx）+ 页面 3（ChatPage、FilesPage、SettingsPage）+ Electron 1（main.ts）；复核 7 = TasksPage、TaskDetailPage、DispatchPage、AboutPage、Layout.tsx、App.tsx、lib/theme.ts。

---

## 4. 样式冲突与重复实现

### 4.1 双消息栈（底本 UI-1，视觉上是最大的不一致源）

| | 聊天栈 | 任务详情栈 |
|---|---|---|
| 组件 | `MessageBubble.tsx`（387 行） | `ConversationPanel.tsx`（501 行）`CardView` |
| 样式 | `chat.css §5/§10` | `conversation.css`（534 行） |
| 状态字典 | `DELIVERY_STATUS`（`MessageBubble:28-37`，8 项，纯 label） | `MESSAGE_STATUS`（`ConversationPanel:50-57`，6 项，label+tone） |
| 文件 | `FileCard`（可选预览/下载） | `FileChips`（纯路径芯片） |
| 气泡形制 | 头像 + 名字 + 时间 + 气泡 | 左侧 3px tone 边条 + 卡片 |

同一产品里「消息」有两种视觉语言、两套状态文案（`queued/queued` 同，`helD` 被叫「等待回复」vs「上限暂停」）。**磨砂黑下 3px 彩色左边条是"廉价发光条"的等价物**（`conversation.css:151,238`），要么统一到「1px 边框 + 图标 tone」，要么明确任务页是"日志视图"并停止模仿聊天气泡。

### 4.2 三套按钮

| 体系 | 定义 | 用在哪 | 半径/高度 |
|---|---|---|---|
| Astryx `AppButton/AppIconButton` | `ui/astryx.tsx:38-103` + `astryx-overrides.css:12-124` | 侧栏重试/创建、导航底、设置页、任务页 | 4px / 32px |
| 原生 `.btn` | `brand.css:519-624` | `ChatPage.tsx:82`（新建会话）、`ChatHeader.tsx:194-205`（保存/取消）、`MessageList.tsx:83`（重试） | 4px / 32px |
| 聊天专用 | `chat.css:760-775`（发送 pill 999px）、`.file-card__action`、`.chat-md__copy`、`.chat-msg__fold` | 聊天内 | 999px / 4px |

三套的 hover/disabled/focus 行为各自实现；其中只有 Astryx 版有 `isLoading`。任务书「优先复用现有组件统一样式」→ 建议保留 Astryx 为唯一按钮源，把 `.btn` 降级为 alias（映射到同一组 token），删掉 pill。

### 4.3 三份文件工具（底本 UI-3，视觉后果是单位不一致）

`FileCard.formatSize`（`FileCard.tsx:6-14`，KB/MB）、`AttachmentBar.formatSize`（`:13-21`，KB/MB）、`labels.formatBytes`（`labels.ts:213-228`，KiB/MiB/GiB）。同一文件在"发送前条"显示 `2.3 MB`、在"文件页"显示 `2.2 MiB`。`kindOf` 也有三份（`FileCard` 不认 pptx）。**统一时顺手统一措辞**，否则新视觉里数字仍会打架。

### 4.4 重复/互相覆盖的 CSS 规则

| 位置 | 冲突 |
|---|---|
| `brand.css:2228-2234` vs `2359-2380` | `.chat-item.is-selected` 定义两次：先「浅橙底 + 橙字」，后被「实橙底 + 白字」覆盖；前者注释写 "selected state is a background tint"（§12 文件头 `2146`），后者是实色——**同一文件自相矛盾**，且最终生效的是不合规的那个 |
| `brand.css:1655-1676` vs `astryx-overrides.css:511-537` | `.settings-nav a.is-active` 与 `.settings-nav button.is-active` 两套实现（页面实际只渲染 button） |
| `chat.css:710-715` vs `1334-1336` | `.chat-composer` 拆成两段（基础 + `position:relative`），后者依赖文件后半段 |
| `hud.css:7-33` vs `brand.css:119-130` | `--hud-bg` 重复定义 `--bg/--surface` 的值，主题切换时两者可能不同步 |
| `brand.css:2123-2131` | `var(--status-error, #b42318)`：token 不存在，永远走 fallback 硬编码 |
| `astryx-overrides.css:333-336` vs `brand.generated.css:448-450` | 都定义 `[data-variant="orange"]` 徽标，靠加载顺序（overrides 后加载）生效 |

### 4.5 token 与硬编码混用（高风险位置）

1. **HUD 整个子系统**：`hud.css` 20 处裸色 + `PaperPlaneLayer` 4 处 canvas 色 → 这是唯一"换主题颜色不变"的区域（HUD 永远 ink 是有意设计，但现在要变磨砂黑，ink 系必须重算）。
2. **阴影**：`chat.css:142/160/827/1386`、`brand.css:2325` 五处 `0 8px 24px rgba(30,33,38,.16)`，与 `--shadow-2`（4px 12px .12）并存 → 浮层阴影有两种规格。
3. **`#fff` 5 处**（橙底白字）→ 与 `--on-accent` 规范直接冲突。
4. **danger hover 的 `#a93226/#f6a99f`** 在 `brand.css:586-592` 与 `astryx-overrides.css:84-90` 各写一遍。

### 4.6 死样式 / 死选择器（改造前先删，减少 30% 改动面）

确认在 `.tsx` 中**零引用**的选择器族（已在源码中逐一核对）：

| 区块 | 行 | 说明 |
|---|---|---|
| mockup 索引页 | `brand.css:1882-2039`（约 158 行：`.index__*`、`.screen-card*`、`.swatch*`、`.sprite`、`.org`） | 早期设计稿索引页遗留 |
| 已删除的 topbar | `brand.css:2065-2094`（`.sidenav`、`.topbar__brand`、`.topbar__rule`、`.breadcrumb*`、`.search--sm`、`.textarea--*`、`.segmented--sm`） | 顶栏在 group-chat 升级中移除，响应式规则仍引用 |
| 旧结论卡 | `brand.css:537-628` | `.chat-card*` 全套（聊天已改用 `.chat-bubble`），仅 `chat-card .conv-question` 一条还在生效 |
| 聊天零碎 | `.chat-sidebar__brand`(2160-2165)、`.chat-list__section`(2480-2487)、`.chat-placeholder`(2527-2534)、`.chat-empty--welcome`(893)、`.chat-spinner*`(929-955)、`.status__dot`(857-863) | 组件未渲染 |
| 头像死类 | `chat.css:395-406` `.chat-avatar--agent/--mark` | 调用方用的是 `--muse/--claude/--dsh/--user`（底本 UI-7） |
| 未使用变量 | `--radius-lg`（仅 dialog 用 1 次）、`--radius-xs`（9 次） | 圆角体系缺一档，需重排（见 §5 S1） |

---

## 5. 具体改造方案（按任务书 Phase 3 顺序）

> 原则：**每一步都可独立提交、可独立回滚、可独立截图验收**。每步结束跑 `npm run typecheck`，改 CSS 的步骤必须提供 1440×900 深色截图（磨砂黑）与 1080×700 窄屏截图。
> 顺序理由：Token 不定则后面全是返工；shell/rail 决定"第一眼"；聊天是主战场但依赖前两步的层次系统。

### S0（前置，0.5 人日）删除死样式 + 修 3 个"假 token"

- 文件：`brand.css`（删 §4.6 六组）、`chat.css`（删 395-406）、`astryx-overrides.css`（删 511-537 中的 `a` 版）、`brand.css:2228-2234`（删浅橙底那版）。
- 额外：`brand.css:2124/2128` 的 `--status-error` → `--error-text`；`hud.css` 顶部声明局部变量组（`--hud-on:#F2F3F4` 等）替代散布裸值，为 S5 做铺垫。
- 预期：CSS 净减约 250 行，后续 grep 噪声下降；无视觉变化（**必须人工确认无视觉变化**）。
- 风险：低。唯一风险是误删"动态拼接"的类名——S0 只删已逐一确认的族。

### S1（1.5 人日）全局 Token 重建：磨砂黑 + 冷银灰 + 圆角 + 动效

- 文件：`brand.css:9-135`（重写 token 两块）、`brand-theme.mjs`（同步 Astryx）、重新生成 `brand.generated.css`、`brand.css` 新增 `--dur-*`/`--radius-*`/`--elevation-*`。
- Token 建议（已预验证对比度，见 §2.5）：

```
/* 背景层级（替代 --bg/--surface 二分法） */
--bg-app:#090A0B; --bg-secondary:#0D0F11; --bg-rail:#0B0C0E; --bg-workspace:#101214;
--surface-overlay:#151719; --surface-panel:#141619; --surface-panel-deep:#191C20; --surface-hover:#1D2024;
--border-subtle:#202328; --border:#292D32; --border-strong:#383D44; --border-control:#5F666F; /* 控件边界≥3:1 */
--text-primary:#F2F3F4; --text-secondary:#D1D4D8; --text-tertiary:#9298A1;
--text-muted:#686F78; --text-faint:#4B5159;   /* 后两者不得用于≤13px正文 */
--accent:#C5CBD3; --accent-hover:#E0E4E9; --accent-quiet:#A3ABB5; --accent-dim:#8D97A3;
--on-accent:#0B0C0E; --accent-subtle:#1D2024;  /* 选中底改为中性，不再彩色 */
--focus-ring:0 0 0 3px rgba(197,203,211,.18); --focus-line:#C5CBD3;
--radius-control:6px; --radius-button:8px; --radius-panel:10px; --radius-dialog:14px;
--dur-hover:150ms; --dur-state:180ms; --dur-overlay:220ms;
--elev-1:inset 0 1px 0 rgba(255,255,255,.04);           /* 磨砂内高光：层次的唯一非颜色手段 */
--elev-2:inset 0 1px 0 rgba(255,255,255,.05), 0 4px 12px rgba(0,0,0,.45);
--elev-3:inset 0 1px 0 rgba(255,255,255,.06), 0 16px 40px rgba(0,0,0,.55);
```

- 兼容策略（关键）：**保留旧变量名做别名**（`--bg: var(--bg-app)`、`--surface: var(--surface-panel)`、`--radius-sm: var(--radius-control)`…），使 89 + 52 + 23 处引用**零改动**即可换肤；圆角与按钮半径再单独精修。这样 S1 一次提交就能看到"整体变磨砂黑"，但不会一次打爆 2000 行 CSS。
- Astryx 同步：`--color-accent/-muted/-on-accent`、`--color-background-body/surface/card/popover/muted`、`--color-text-primary/secondary/disabled`、`--color-border(-emphasized)`、`--color-overlay*`、`--color-icon-accent`、`--color-info*`、`--color-*-orange` → 全部改银灰或中性；`--radius-*` 六档改 6/8/10/14。
- 预期：整站一屏变磨砂黑，橙消失 90%（HUD 与 canvas 除外）。
- 风险：**中高**。①浅色主题会在这一刻"塌掉"（若决定保留，必须同时给出浅色映射，工作量翻倍，见 §7）；②`light-dark()` 生成物与 `brand.css` 双写可能不一致，需一次脚本校验；③别名策略下 `.btn-primary` 从"橙底墨字"变"银底墨字"，按钮的"主次"必须改由**实心/描边/字重**表达，否则主操作不再显眼——这是本步最大的设计风险，需截图评审。

### S2（0.5 人日）主窗口 / 布局 / 标题栏决策

- 文件：`main.ts:1041-1047`（`backgroundColor:'#090A0B'`，顺手 `screen` clamp + bounds 持久化，与底本 LAY-2 合并）、`AppFrame.tsx`（`.app` 加 `--elev-1` 与分栏边框）、`brand.css:290-299,467-478`、`.page-head`（483-514）。
- 预期：启动不闪白；三栏有明确边界（rail 深一档、sidebar 中间档、workspace 最亮），靠 1px 边框 + 内高光而非色差。
- 风险：低。标题栏若选自绘方案则升为"新功能"，建议本阶段**保持系统标题栏**，把自绘放入独立需求。

### S3（1 人日）左导航栏 + Tooltip 原语

- 文件：`GlobalNav.tsx`（选中态、图标尺寸收敛、`title` → `Tooltip`）、`brand.css:319-465`、新增 `Tooltip` 组件（放 `ui/`）+ `brand.css` 对应样式。
- 预期：选中 = 中性底 + 2px 左条；hover 150ms；图标 1.6 线宽统一；tooltip 400ms 延迟、11px、`#151719` 底。
- 风险：中。Tooltip 涉及 portal/定位/`aria-describedby`，是**新代码**；若时间紧，可先保留 `title` 只改视觉，把 Tooltip 放 S7。

### S4（2 人日）侧栏 + 聊天主区骨架

- 文件：`ChatSidebar.tsx`、`brand.css:2149-2540`、`chat.css:7-31,421-465`、`ChatPage.tsx`。
- 内容：选中行去橙（`#1D2024` 底 + 2px `#C5CBD3` 左条，名字 `#F2F3F4`）；未读徽标 `#C5CBD3` 底 + `#0B0C0E` 字（11.98:1）；时间/meta 用 `#9298A1`；头像容器改实色/描边（顺手修底本 UI-4 浅色不可见）；侧栏拖拽手柄与折叠（底本 LAY-1，与视觉同批做，避免二次改文件）；消息列 `max-width:960px` 居中；消息间距分档。
- 预期：侧栏"深色磨砂 + 灰阶选中"；聊天区不再是"一摞等距卡片"。
- 风险：中。侧栏与聊天同时改容易一次提交过大 → **拆成 S4a 侧栏 / S4b 聊天骨架两个提交**。

### S5（2 人日）聊天内容：气泡、身份、Markdown、附件

- 文件：`MessageBubble.tsx`、`chat.css:466-628,981-1130,1213-1331`、`FileCard.tsx`、`AgentPresence.tsx`。
- 内容：气泡去身份染色（或按 §6 选定方案）；名字/头像/标签承载身份；meta 行 11px 分层；代码块 `#0D0F11` + 复制按钮幽灵化；附件卡改"一行式文件条"；状态中文化。
- 预期：Agent 辨识度靠头像 + 名字 + 1px 边框，不靠颜色；同屏多个 Agent 回复仍然"能分清是谁"。
- 风险：**高**。这是"辨识度 vs 克制"的正面战场；必须先有 §6 的决策，否则会返工。

### S6（1 人日）Agent 状态 / 多 Agent 协作 / HUD

- 文件：`AgentPresence.tsx`、`MessageList.tsx:111-131`、`hud.css`（整文件）、`AgentHud.tsx`（canvas 颜色传参）、`PaperPlaneLayer.tsx`、`ui/astryx.tsx:105-135`（`running` 映射）。
- 内容：working 环去橙；状态点 + 文字双通道；thinking 指示器改"头像 + 名字 + 极细进度"；纸飞机颜色随主题；HUD 弹层改磨砂面板。
- 预期：HUD 与聊天内状态视觉一致；不再有"橙色无限旋转"。
- 风险：中高。`PaperPlaneLayer` 是动画层，改色要考虑 canvas 每帧读色成本（建议挂载时读一次 CSS 变量，不用每帧 `getComputedStyle`）。

### S7（1 人日）输入框 / 上传 / 设置 / 弹窗 / 滚动条 / 状态族

- 文件：`Composer.tsx`、`AttachmentBar.tsx`、`chat.css:707-877,1333-1514`、`SettingsPage.tsx` + `brand.css:1637-1783`、`astryx-overrides.css:486-542`、`brand.css` 新增滚动条块、`brand.css:2123-2131`。
- 内容：发送按钮去 pill；focus 环改银；进度条银；设置页导航统一；浮层统一（`#151719` + 1px + `elev-3` + 14px + 220ms 入场）；滚动条 8–10px；空/载/错三态统一。
- 预期：细节全部闭合，任务书 16 模块全部覆盖。
- 风险：低（都是点状改动），但要注意 Astryx 弹窗是 portal，必须在 `astryx-overrides` 里改而不是页面里。

### 验收标准（Phase 3 DoD）

1. 全仓 grep `e85d26|E85D26|identity-claude` 仅剩"身份方案"明确保留的定义（0 处为最佳）。
2. 深色 1440×900 / 1080×700 + （若保留）浅色 2 张，共 2–4 张截图，无橙、无渐变、无发光。
3. 所有正文对比度 ≥4.5:1、图形/控件 ≥3:1（用 §2.5 的表逐项核对）。
4. 圆角：控件 5–7、按钮 7–9、面板 9–12、弹窗 12–16，全仓无 20px+（HUD 28px 需在 DESIGN_SYSTEM 明确豁免并登记）。
5. 动效：仅 `--dur-hover/state/overlay` 三档；`prefers-reduced-motion` 下仍有 4 处 `infinite` 动画（`chat-spin` 800ms、`chat-thinking-pulse` 900ms、`hud-orbit` 1.4s、`conv-indeterminate` 1.2s）+ 1 处一次性 `hud-flash`，全部需归零。
6. 不新增业务逻辑 diff：`git diff --stat` 中 `.tsx` 改动只允许 className/style/结构微调，无 state/请求变化。

---

## 6. Claude 身份橙冲突：3 个处理选项（请用户拍板）

### 6.1 冲突事实（三重 + 第四重，底本 ID-1 + 本报告新增）

| 语义 | 定义 | 被谁消费 |
|---|---|---|
| A. **主操作/选中/焦点** | `--accent #e85d26`（`brand.css:24,97`）+ Astryx `--color-accent/--color-info` | 主按钮、导航选中、会话选中、输入焦点环、进度条、@mention、settings 导航、Switch、全站 17 处 `outline:2px solid var(--accent)` 与 5 处 accent 焦点边框 |
| B. **Claude 身份** | `--identity-claude #e85d26`（`brand.css:53,122`） | 发送者名、头像底、气泡底、成员行名字、侧栏头像（6 处） |
| C. **Agent 干活中** | `hud-ring__arc--working` 硬编码 `#e85d26`（`hud.css:91`）+ 状态点 `161` + 未读徽标 `185` | HUD 44px 槽位 |
| D.（新增）**任务运行中** | `AppStatus tone="running"` → `'orange'`（`ui/astryx.tsx:131`）→ `status--running`/`badge--running` 用 `--accent-*` | 任务表、任务详情、关于页、设置页引擎状态 |

**问题不是"橙色不好看"，而是：同一屏里"这是主按钮""这是 Claude""这个 Agent 正在干活""这个任务在跑"四种信息共用一个颜色。** 加上白字橙底 3.49:1，橙底本身也不合规。

另外 `BRAND_GUIDELINES.md:164` 写的是"身份只用单色图形区分……不用颜色区分 agent"，与当前四色身份实现直接冲突（底本 ID-2）。**任何方案都必须同时更新规范，否则改造完仍是"文档-实现"两张皮。**

### 6.2 选项 A：彻底无身份色（单色 + 图形/标签）

- **做法**：所有 agent 用同一套中性色（`#F2F3F4` 名字、`#9298A1` 状态）；辨识完全靠 ①头像图形（Muse/Claude/dsh 现有 mark PNG）②名字 ③可选 1px 描边或小号等宽标签（`MUSE`/`CLAUDE`/`DSH`）；气泡、边框、底全部中性。删除 `--identity-*` 全部 12 个 token（或仅保留 `subtle` 作头像底）。
- **利**：①最符合"Less is More / 克制"，也最符合现有 BRAND_GUIDELINES 条款；②彻底消灭身份色与 accent 的语义冲突（A/B/C/D 只剩 A/C 需要定）；③深浅两套维护成本最低；④磨砂黑下不会出现"紫/蓝小块"破坏材质。
- **弊**：①**辨识度依赖头像位图质量**（现在 28px 白底 PNG，浅色下已经不可见，磨砂黑下反而更好）；②"谁在说话"要靠读名字，长会话滚动时扫读效率下降；③需要一次"消息分组/头像常显"的结构调整（否则同色气泡会连成一片）；④改动面最大（`chat.css:981-1023`、`brand.css:2402-2430`、`MessageBubble` 结构、`theme` 的 purple/blue token 全部作废）。
- **对现有设计的影响**：四色身份是 2026-11-16 群聊升级的核心视觉特征（底本 §6.1），删除等于回退一个已交付的设计决策，需要用户明确认可。

### 选项 B：冷银灰亮度阶梯（同色相、4 档亮度）

- **做法**：身份改为同一冷银灰相位的 4 档：`Claude #E0E4E9` / `Muse #C5CBD3` / `dsh #A3ABB5` / `User #8D97A3`（对比度 8.4–12:1，安全）。**只用于头像底/描边与名字**，气泡一律中性。1px 描边 + 名称是第一识别通道，亮度是弱第二通道。
- **利**：①保留"一眼能分 4 个成员"的弱线索，又不引入新色相 → 仍属"克制"；②与 accent 同源，`--accent` 与身份不再"撞色"，只是**亮度**接近（Claude=E0E4E9 与 accent-hover 同值 → 需把 hover 提到 `#EDF0F3` 错开）；③token 改动小（12 个 identity token 改值即可，6 处引用不动）；④浅色主题可给镜像值（深梯度），维护成本低。
- **弊**：①**亮度差在近黑底上的可辨识性弱**（`#E0E4E9` vs `#C5CBD3` 的 ΔL 约 8%，缩到 28px 头像基本看不出来）——实际上"看起来像同一色"，但又要维护 4 个 token，属于"半吊子"；②仍需头像/名称兜底，收益不如 A 彻底；③容易滑向"用颜色区分 agent"的旧范式（规范冲突仍在）。
- **对现有设计的影响**：最小。可作为 A 的过渡态（先改值，观察一周再决定是否删 token）。

### 选项 C：身份仅限"头像 + 一个可开关的低饱和标记"，文本层全中性

- **做法**：名字/气泡/边框全中性（同 A）；保留 4 个身份色但**降饱和到 20–30% 并只用于 16×16 头像底或 1px 内描边**（例如 Claude 由 `#E85D26` → `#B08C7E`、Muse `#8B7CFF` → `#8E8AA9`、dsh `#3B82F6` → `#7E8FA3`）；并在设置页提供"身份标记：开/关"。同时给 Claude 一个**非橙**的替代色相，避免与"去橙"目标矛盾。
- **利**：①在"彻底去橙"与"保留辨识"之间取平衡；②小面积（16px 以下）低饱和色不构成"彩色 UI"，符合"强调色只用于必要处"；③可关闭 → 用户可自选"极简/可辨"。
- **弊**：①**引入新功能（设置开关）**，触碰"不新增功能/不改业务逻辑"的红线边缘（虽是纯前端偏好，但要落 localStorage + 设置项 + 文案）；②低饱和色在近黑底上容易"发脏"（`#B08C7E` 这类暖灰在 `#101214` 上会显得像"褪色的橙"，反而更解释不清）；③仍需解决"Claude 用什么色"——只要不是橙，就要为它发明一个新身份，等于把问题往后推；④token 数与 A 相当，收益低于 A。
- **对现有设计的影响**：中。需要新增设置项与持久化，Phase 3 排期 +0.5 人日。

### 6.3 三个选项的取舍矩阵（供拍板，不含倾向）

| 维度 | A 彻底单色 | B 亮度阶梯 | C 低饱和标记 |
|---|---|---|---|
| 与"去信号橙"目标一致性 | 高 | 高 | 中（仍需为 Claude 造新色） |
| 与 BRAND_GUIDELINES「不用颜色区分 agent」 | 一致 | 冲突（弱化） | 冲突（但可开关） |
| Agent 扫读辨识度 | 中（靠头像/名字） | 弱 | 中高 |
| token 改动量 | 大（删 12 个） | 小（改 12 个值） | 中（改值 + 加开关） |
| 需要新增功能 | 否 | 否 | **是**（设置开关 + 持久化） |
| 浅色主题连带成本 | 低 | 中（需镜像梯度） | 中 |
| 可回滚性 | 中（删 token 后难恢复） | 高（只改值） | 高 |
| 主要风险 | 已交付的四色身份被回退 | "看起来像同一色"的半吊子 | 暖灰在近黑上发脏 + 新功能 |

### 6.4 无论选哪个都必须做的两件事

1. **C（工作中）与 D（任务运行中）从橙里拆出来**：HUD working 环与 `AppStatus tone="running"` 建议统一改为 `--accent #C5CBD3` 的"细环 + 低频旋转/进度"，`waiting` 保留 warning、`error` 保留 error（是否去饱和见 §7/§0.3 第 3 项）。
2. **更新三份文档**：`DESIGN_SYSTEM.md §2.1/2.2/2.3/2.4/§9`（信号橙 → 冷银灰，重新登记 contrast 表）、`BRAND_GUIDELINES.md §5.5/§6.1`（身份表达条款）、`gui/src/assets/sidebar/README.md`（"中性白色标志"与实现/新方案的对应关系）。否则 Phase 3 完成后规范仍在描述一个不存在的界面。

---

## 7. 浅色主题影响：逐项清单

> 前提：任务书给的是**深色主背景**（`#090A0B` 系）。浅色主题是否保留是 Phase 3 的第一个决策。以下按"保留浅色"评估影响面；若决定 dark-only，则本清单的每一项都变成"删除浅色分支"的小任务（成本反而更低）。

### 7.1 会直接受"去橙"影响的浅色元素

| # | 元素 | 位置 | 当前 | 去橙后会发生什么 |
|---|---|---|---|---|
| 1 | 侧栏会话选中行（底、名字、时间、预览） | `brand.css:2359-2380` | 橙实底 + 白字（3.49:1） | 选中变中性底后，**白字必须改深色**，否则白字白底不可见——这是最容易漏改的一处 |
| 2 | 未读徽标 | `brand.css:2437-2449` | 橙底 + 白字 11px | 改银底 + 墨字后，浅色下"未读"的告警感会完全消失 → 需在浅色用「实心深色底 + 白字」镜像 |
| 3 | 侧栏头像（4 个身份） | `brand.css:2389-2430` | 近白 `*-subtle` 底 + **白色 PNG**（1.20:1，不可见） | token 改值后若仍用 `-subtle` 底，白色 mark 依旧不可见；**必须同时改为实色底或加深色 mark 变体**（底本 UI-4） |
| 4 | 导航轨选中项 | `brand.css:389-392` | 橙底 + 白图标 | 改中性底后，浅色下需要"深底 + 白图标"或"浅底 + 深图标"二选一，不能沿用深色的银条 |
| 5 | 焦点环 | `brand.css:28,101`；`chat.css:733/1340`；`astryx-overrides:149/197` | 橙 rgba | 改银 rgba 后，在浅色底上 3px 银色几乎不可见 → 浅色需改用深灰 rgba（约 12–15% 黑） |
| 6 | 链接 / accent-text | `brand.css:26,174`；`chat.css:220,598,1051` | `#c0471a`（on Paper 4.55:1） | 银灰 `#8D97A3` 在白底只有 2.8:1 左右，**链接会失去可读性** → 浅色链接必须用 `#3F464E` 一类的深灰 |
| 7 | 选中/强调浅底 | `--accent-subtle #fbe8df` 共 **14 处**（`brand.css:193/907/1081/1547/1674/2229/2345`、`chat.css:179/1071/1406/1563`、`astryx-overrides:334/534`、`hud.css:298`） | 橙调米色 | 改中性浅灰后，浅色下"选中"与"hover"几乎无差别 → 必须引入左边条/描边作为第二通道 |
| 8 | 主按钮 | `brand.css:543-556`；`astryx-overrides:41-54` | 橙底 + 墨字 4.63:1 | 银底 + 墨字在白底会"融进背景"（12:1 的银是浅色！）→ 浅色主按钮必须改深色实心（`#101214` 底 + 白字） |
| 9 | 表格选中行 | `brand.css:1080-1086` | 浅橙底 + 2px 橙条 | 同上，需改中性底 + 深灰条 |
| 10 | HUD（不随主题） | `hud.css` 全文件 | ink 胶囊 | 磨砂黑下 HUD 若保持 `#1e2126` 会"浮"在 `#090A0B` 上但又不属于任何一层 → 需要新的胶囊配色（`#181A1D` + 1px `#292D32`） |
| 11 | PaperPlaneLayer canvas | `PaperPlaneLayer.tsx:135-144` | 纸白 `#F5F3EE` + 墨 `#1E2126` | 近黑底上"白纸飞机"会非常亮 → 需改 `#F2F3F4` @ 低 alpha |
| 12 | 窗口背景 | `main.ts:1047` | `#F5F3EE` | 深色下启动闪白 → 改 `#090A0B`；若保留浅色主题，则需按主题切换（当前无此机制，需新增） |
| 13 | AboutPage logo | `AboutPage.tsx:55-56`（`logo--light` / `logo--dark` 切换 `brand.css:301-317`） | 浅色用 ink logo，深色用 inverse | 磨砂黑下反白 logo 可用，但若品牌强调色去橙，logo 本身（`design/branding`）是否含橙需核对——**品牌资产改色需单独评审**（`DESIGN_SYSTEM.md:416`） |

### 7.2 浅色主题的"隐性成本"（决策依据）

- `brand.generated.css` 的每个 token 都是 `light-dark(a, b)` 双值 → **浅色保留 = 每个 token 要设计两个值**（约 40 个语义 token），S1 工作量 ×1.8。
- 验收截图从 2 张变 4 张，回归范围翻倍。
- 现有浅色主题的对比度问题不止橙色（`--text-muted` on white 3.25:1、`#C0471A` on `#FBE8DF` 4.26:1）——如果保留浅色，这些都得一起修，否则"新视觉"在浅色下依然不合格。
- **建议（供决策，不替代决策）**：Phase 3 先做 dark-only（把浅色分支保留但标记 `deprecated`，`lib/theme.ts` 默认 dark），视觉稳定后用一个独立 phase 补浅色映射。这样 S1 从 1.5 人日降到 0.8 人日，且不用两次评审同一批对比度。

---

## 8. 风险登记与红线对照

| 风险 | 说明 | 缓解 |
|---|---|---|
| R-A 语义先于色值 | 只改色值 → 主操作/Claude/工作中/任务运行 一起变银，界面失去主次 | §6 必须先拍板；S1 用别名策略分两步走 |
| R-B 层次消失 | surface 阶梯 1.02–1.10:1，边框 1.35:1 → 磨砂黑变纯黑平板 | 强制 `--elev-1/2/3` + `--border-control`；S1 定义、S2 起逐屏验证 |
| R-C 命名与加载顺序 | `chat.css` 页面级导入 + `brand.css` 已含聊天选择器；Astryx 靠 layer 覆盖 | 改造前先合并聊天样式归属（建议把 `brand.css §12/13` 迁到 `chat.css`，或反之统一），一次性解决；本阶段只做"不新增跨文件选择器" |
| R-D 双份主题真源 | `brand-theme.mjs` 与 `brand.css` 双写同义 token，靠人肉同步 | 新增一个校验脚本（对比关键 token 值），或接受"generated 只服务 Astryx"的边界并写进注释 |
| R-E HUD/animation | HUD 20 处裸色 + canvas + `infinite` 动画 | S6 单独排期；动画全部加 reduced-motion 归零 |
| R-F 文件重复改动 | `ChatSidebar/ChatHeader/FileCard` 同时是 Phase 2 功能修复目标 | 排期合并：功能修复与视觉同批提交，避免冲突 |
| R-G 规范漂移 | 3 份文档仍描述信号橙 | S1 提交时同步文档（§6.4） |
| 红线-不重写 | 方案全部是 token + 局部规则替换，无组件重写 | S1 别名策略保证 89+52+23 处引用零改动 |
| 红线-不破功能 | 不改 state/请求/协议；`git diff` 仅 className/style/结构微调 | DoD 第 6 条 |
| 红线-不删功能 | 唯一"删除"是死 CSS 与重复规则（有清单） | S0 单独提交 + 截图确认无视觉变化 |
| 红线-不换技术栈 | 继续 React + Astryx + 全局 CSS | — |
| 红线-响应式 | 1080/1180/900 三档断点现状混乱（900 在应用内不可达，底本 LAY-3） | S2 顺手定断点，避免视觉改完窄屏崩 |

---

## 9. 附录

### A. 文件 → 模块索引（改造时按此顺序打开）

| 文件 | 行数 | 主责模块 |
|---|---|---|
| `styles/brand.css` | 2540 | 1,2,3,10,12,13,14,16 |
| `styles/chat.css` | 1629 | 4,5,6,7,8,9,13,16 |
| `styles/hud.css` | 403 | 6,11,13 |
| `styles/conversation.css` | 534 | 10 |
| `styles/astryx-overrides.css` | 634 | 2,5,7,10,12,13,16 |
| `theme/brand-theme.mjs` | 116 | 全部（Astryx 侧真源） |
| `theme/brand.generated.css` | 680 | 生成物，勿手改 |
| `components/GlobalNav.tsx` | 151 | 2,15 |
| `components/AppFrame.tsx` | 50 | 1 |
| `components/ChatSidebar.tsx` | 298 | 4 |
| `components/ChatHeader.tsx` | 345 | 3,6,13,16 |
| `components/MessageList.tsx` | 151 | 4,6,16 |
| `components/MessageBubble.tsx` | 387 | 5 |
| `components/Composer.tsx` | 415 | 7,8 |
| `components/AttachmentBar.tsx` | 105 | 8 |
| `components/FileCard.tsx` | 179 | 9,16 |
| `components/AgentPresence.tsx` | 208 | 6,11 |
| `components/AgentHud.tsx` | 303 | 11 |
| `components/PaperPlaneLayer.tsx` | 360 | 11 |
| `components/ConversationPanel.tsx` | 501 | 10 |
| `ui/astryx.tsx` | 360 | 2,5,10,11 |
| `pages/ChatPage.tsx` | 127 | 4,16 |
| `pages/FilesPage.tsx` | 147 | 9 |
| `pages/SettingsPage.tsx` | 1234 | 12,13 |
| `pages/TasksPage.tsx` / `TaskDetailPage.tsx` / `DispatchPage.tsx` / `AboutPage.tsx` | 443 / 569 / 352 / 211 | 10（复核） |
| `components/Layout.tsx` / `App.tsx` / `lib/theme.ts` / `main.tsx` | 78 / 56 / 34 / 21 | 1,12（复核） |
| `electron/main.ts` | 1172 | 1,3 |

### B. 复算命令（任何人可复现 §2.4 的 170）

```powershell
cd D:\Claude\agent-workbench\gui\src
# ① 字面橙
Get-ChildItem -Recurse -File -Include *.css,*.tsx,*.ts,*.mjs | Select-String -Pattern 'e85d26' -AllMatches -CaseSensitive:$false |
  ForEach-Object { $_.Matches.Count } | Measure-Object -Sum     # 27
# ② 橙色阶
... -Pattern 'f26b36|c0471a|fbe8df|ff8a5c|3a2620'              # 31
# ③ accent 引用
... -Pattern 'var\(--accent[a-z-]*\)'                           # 89
# ④⑤⑥ 依次替换 pattern（identity-claude / focus-ring / \bfff\b）
```

### C. 本次未验证（Phase 3 需实测）

1. 磨砂黑下 1080×700 的实际层次（surface 差 1.02–1.10 是否真的会糊）——需要真机截图。
2. 低饱和银灰在 100% sRGB 与 Windows 夜灯/HDR 下的观感偏移。
3. HUD canvas 纸飞机改色后的性能（每帧读 CSS 变量的成本）。
4. Astryx 组件的入场动画时长（生成物里的 tempo token 是否真的被组件消费）。
5. 浅色主题在当前 HEAD 的完整截图（底本 UI-4 只有代码推导）。