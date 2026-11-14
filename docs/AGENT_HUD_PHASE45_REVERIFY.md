# Agent HUD 第四/五期必须修项独立复评（M1–M5）

> 复评对象：分支 `gui/v0.1`；修复提交 `8c86178`（`fix(gui): address Agent HUD review findings and verify approval flow`）；当前 HEAD `6c08e5e`（`docs: record Agent HUD M1-M3 regression results`）。
> 原评审：`docs/AGENT_HUD_PHASE4_REVIEW.md`（针对 `90296c9` 的 CONDITIONAL PASS，M1–M5 五个必须修）。
> 复评方：独立复核者（只读；未修改实现代码，未改 `src/`、原评审文件、`spike/`、签名；未删除文件；未重启生产 `:8080`）。
> 日期：2026-11-14 环境：Windows 11，Node v22.20.0，仓库根 `D:\Claude\agent-workbench`。
> **结论：CONDITIONAL PASS。**

---

## 0. 只读声明与复评方法

- 逐项以**当前代码/文档/构造产物**为准独立核查，不采信实现方的总结文字；每项都给出实际文件:行号与可复现证据。
- 唯一写入：本报告 `docs/AGENT_HUD_PHASE45_REVERIFY.md` 与 `DAILY_LOG.md` 末尾追加区块；未改动任何实现、原评审文件、`spike/`、签名与生产数据。
- 临时探针脚本与输出只写在 gitignored 的 `data/reverify-phase45/`（PNG 像素统计、图标 alpha bbox、CSS 级联求解、构建日志），不提交。
- 所有 git 结论基于 HEAD `6c08e5e`；工作区除既有未跟踪项（`docs/AGENT_HUD_SPEC.md`、`docs/hud-phase4/*.png`、`spike/`、`uu-remote-screen.png`）外无已跟踪修改。

---

## 1. 结论

**CONDITIONAL PASS。**

- **M1–M5 五个必须修项均已在 `8c86178` 中实质修好**，逐项复评见 §2；其中 M1、M2、M3、M5 为代码/文档 + 实测数据双重确认，M4 为源码与**真实构建产物**的级联求解确认，但**没有**跑成浏览器运行时实测（本机沙箱阻断，见 §5）。
- 发现 **1 个新的必须修项（R1）**：设置页「还原」按钮仍用 `void` 丢弃 HUD 写盘结果并无条件提示“已还原…HUD 配置”，属于 M2 同类残留（§4）。
- `npm run build` 的 `build:renderer` **仍被本机沙箱以 `spawn EPERM` 阻断**（与上次评审一致，非代码错误）；`typecheck` 通过（§3）。
- 因此**不能给无条件 PASS**：代码层面的 5 项已收口，但存在 1 个新的必须修与 2 项环境受限的验证缺口。

---

## 2. 逐项复评

### M1 — 写状态的审批 IPC 被描述为“只读包装” —— ✅ 已修

原评审列出的 5 处，当前文本（HEAD `6c08e5e`）逐处核对：

| # | 位置 | 当前文本（关键片段） | 结论 |
|---|---|---|---|
| 1 | `RESUME.md:771` | “调用新增的 `engine:respond-approval` IPC（对既有 `respond_approval` 工具的**显式包装；会写入审批决定，不是只读操作**）” | ✅ 已改 |
| 2 | `RESUME.md:772` | “新增 IPC 只是对既有 `list_messages`（只读）与 `respond_approval`（**显式用户决定**）工具的包装” | ✅ 已改（不再称只读） |
| 3 | `docs/hud-phase5/README.md:13` | “对既有 `respond_approval` 工具的**显式包装；该调用会写入审批决定，不是只读操作**” | ✅ 已改 |
| 4 | `DAILY_LOG.md:1649` | “对既有 `respond_approval` 工具的**显式用户操作包装：会写入用户回复并终结 pending 审批，不是只读操作**” | ✅ 已改 |
| 5 | `gui/src/components/ConversationPanel.tsx:398-400` | 来源行现为 “`task_status / task_logs / list_messages · 引擎数据`”（原“· 只读”已移除） | ✅ 已改 |

- `git grep "只读包装"` 在仓库中只剩**原评审文件本身**（`docs/AGENT_HUD_PHASE4_REVIEW.md`，本次按约束未改），业务代码/文档已无该表述。
- **独立确认这是写操作**（非仅看文档）：`src/approvals.js:518-527` 在 `respond()` 中 `messages.send({from:'user', … reply_to: approval.message_id, deliver:false})` 写入真实用户回复；`:529` 调 `_finalize()`；`:539-555` 更新审批 `status/decision/responded_at`，`session` 还会 `addApprovalGrant`。GUI 侧确有副作用：`gui/electron/engine.ts:583` `callTool('respond_approval', args)`。
- 结论：5/5 处描述已与实现一致，**M1 关闭**。

### M2 — HUD 写盘失败仍提示“已保存/立即生效” —— ✅ 主路径已修（但有同类残留 R1）

| 位置 | 当前实现 | 结论 |
|---|---|---|
| `gui/src/lib/hud.ts:269-283` `setPaperPlanes` | 返回 `Promise<boolean>`；成功 `publishConfig(next)` 后 `return true`；`catch` 中不再 `publishConfig` 并 `return false`（旧值保持） | ✅ |
| `gui/src/lib/hud.ts:285-299` `setContextWindowTokens` | 同上 | ✅ |
| `gui/src/pages/SettingsPage.tsx:113-126` `togglePaperPlanes` | `const saved = await …`；失败时 `tone:'error'`、标题“纸飞机动画未保存”、正文“**写入 hud.json 失败，原配置保持不变**。请检查数据目录权限。” | ✅ |
| `gui/src/pages/SettingsPage.tsx:128-146` `applyContextWindow` | 同样按 `saved` 分支，失败提示“写入 hud.json 失败，原参考值保持不变” | ✅ |

- **失败是否真的会传播到渲染进程**：`gui/electron/main.ts:352-353` 用 `handle()` 注册 `hud:get-config` / `hud:set-config`；`handle()`（`:181-188`）**不吞异常**，`writeHudConfig()`（`:69-89`）在参数非法、`ensureDataDir()` / `writeFileSync` / `renameSync` 失败时直接 `throw` → IPC promise reject → `hud.ts` 的 `catch` → `false` → 设置页显示错误。
- 结论：原评审指出的两条路径（纸飞机开关、上下文参考上限）已真实修好，**M2 主路径关闭**；但设置页仍有 1 处同类残留（见 §4 R1）。

### M3 — 第五期截图被描述为“深色主题整窗” —— ✅ 已修

- 文档：`docs/hud-phase5/README.md:5` 现为 “`01-settings-hud.png`（设置 → Agent HUD，**浅色主题整窗**）；`02-approval-pending.png` / `03-approval-allowed.png`（隔离引擎审批，**深色主题**）”。
- **独立像素核验**（Pillow，`docs/hud-phase5/01-settings-hud.png`，2139×1296）：
  - 主色 `#FFFFFF` 1,775,051 px（64.03%）+ 纸白 `#F5F3EE` 726,003 px（26.19%）→ **浅色主题**；
  - 深色 token `#1E2126` 仅 17,888 px（0.65%），不是背景。
- 对照 `02-approval-pending.png`：`#25292F` 1,346,682 px（48.58%）、`#1E2126` 766,015 px（27.63%）→ 深色；`03` 同为深色（`#25292F` 61.53%）。
- 结论：描述与 PNG 实际配色一致，**M3 关闭**。

### M4 — reduced-motion 下落地淡出提示不可见 —— ✅ 已修（源码 + 真实构建产物级联求解；浏览器实测被沙箱阻断）

- **关键事实：`brand.css` 的全局规则并没有被删**——`gui/src/styles/brand.css:2101-2110` 仍为：
  `* { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; … }`
- **修法**是原评审允许的“给 `.hud-slot__flash` 豁免”：`gui/src/styles/hud.css:392-412` 在 `@media (prefers-reduced-motion: reduce)` 内为 `.hud-slot__flash` 声明
  `animation: hud-flash-fade 400ms ease-out 1 forwards; animation-duration: 400ms !important;`，`hud-flash-fade` 只动 `opacity`（无位移）。
- **级联求解**（`data/reverify-phase45/m4-cascade.cjs`，按 CSS 规范计算 importance → specificity → 源序）：
  - 两条 `animation-duration` 都是 `!important`；`*` 特异性 (0,0,0)，`.hud-slot__flash` 特异性 (0,1,0) → **类选择器胜出**，生效值 `0.4s`；
  - `animation-name`：媒体块内 `.hud-slot__flash` 的 `hud-flash-fade` 覆盖基础规则的 `hud-flash` → 仅透明度、无 `transform`；
  - 按 `ease-out`（cubic-bezier(0,0,0.58,1)）插值：`t=120ms` 时 opacity≈**0.499**，`t=200ms`≈0.284，`t=400ms` 到 0 → **可见的无位移淡出**，而非原评审所述“0.01ms 内 instantly 到 0、不可见”。
- **真实构建产物佐证**：`gui/dist/assets/index-CL89dtTs.css`（实现方会话 16:38:03 构建，晚于 `90296c9`、早于提交 27s）中确有
  `.hud-slot__flash{animation:hud-flash-fade .4s ease-out 1 forwards;animation-duration:.4s!important}`
  （压缩后为 `.4s`），且同一产物仍含全局 `animation-duration:.01ms!important` —— 两条并存时类选择器胜出，与上述求解一致。源码与产物求解结果相同（均 `0.4s`，`t=120ms` opacity≈0.499）。
- **运行时实测未完成（环境阻断，非代码问题）**：见 §5。已尝试 `agent-browser` 与直接启动 Chrome/系统 Chrome，均被本机沙箱拒绝（socket 目录不可写 / mojo 命名管道 `拒绝访问 0x5`），按约束**未提权、未绕过**。
- 结论：以源码 + 真实产物级联求解确认 N13 所述“无位移淡出”成立，**M4 在代码层面关闭**；运行时可见性仍缺一次浏览器级证明（列为 §4 非阻塞 R3）。

### M5 — 图标“紧贴外接框、四周只留 1px”描述与 PNG 不符 —— ✅ 已修

三处说明均已更正：

| 位置 | 当前文本 |
|---|---|
| `gui/src/assets/sidebar/README.md:17` | “紧贴标志外接框裁剪；为使画布保持正方形，Muse/dsh 上下保留透明边（约 20px / 14px），Claude 约 1–2px…” |
| `docs/hud-phase3/README.md:49` | “…为使画布为正方形，Muse/dsh 上下保留透明边（约 20px / 14px），Claude 约 1–2px。” |
| `RESUME.md:750` | “…为使画布为正方形，Muse/dsh 上下保留透明边（约 20px / 14px），Claude 约 1–2px。” |

- **独立 alpha 外接框实测**（Pillow，与描述逐项吻合）：
  - `muse-mark.png` 117×117：内容 bbox `x 1..115, y 20..96` → 左右各 1px，**上下各 20px**；
  - `dsh-mark.png` 89×89：内容 bbox `x 1..87, y 14..75` → 左右各 1px，**上 14px / 下 13px**；
  - `claude-mark.png` 62×62：内容 bbox `y 2..60` → **上 2px / 下 1px**（约 1–2px）；
  - 三图四角 alpha 均为 0，透明背景与“中性白”描述成立。
- 结论：说明与实际 PNG 一致，**M5 关闭**。

---

## 3. 顺带复核：`npm run build`（`build:renderer`）

在 `gui/` 下执行一次 `npm run build`（原始命令，未改参数、未提权）：

| 阶段 | 结果 |
|---|---|
| `theme:build` | ✅ 成功，写 `gui/src/theme/brand.generated.css`（28,194 B，该文件被 `gui/.gitignore` 忽略、未被跟踪） |
| `build:main` | ✅ 成功（`tsc -p tsconfig.electron.json`） |
| `build:renderer` | ❌ **`Error: spawn EPERM`**，栈顶 `esbuild/lib/main.js:2272 ensureServiceIsRunning` → `bundleConfigFile`（vite 加载配置） |

- 与上次评审记录**完全一致**：本机沙箱禁止子进程管道/命名管道 stdio，esbuild service 无法 spawn；属环境边界，不是代码错误。按约束**未换法重试、未提权**，构建声明无法在本沙箱独立复现（实现方会话记录 `npm run build` 通过，`gui/dist` 产物存在）。
- 另跑 `cd gui && npm run typecheck`：**EXIT=0**（两套 tsconfig 均通过）。
- 范围核查：`git diff 90296c9 8c86178 -- src/` 为空；`8c86178` 无删除文件（`--diff-filter=D` 为空）；`6c08e5e` 仅追加 `RESUME.md`/`DAILY_LOG.md`。

---

## 4. 新问题

### 必须修

**R1 — 设置页「还原」按钮在 HUD 写盘失败时仍提示“已还原…HUD 配置”（M2 同类残留）**

- 位置：`gui/src/pages/SettingsPage.tsx:1144-1156`。
- 证据：点击「还原」执行
  `void updates.setChannel('stable'); void hud.setPaperPlanes(true); void hud.setContextWindowTokens(128_000);`
  随后**无条件** `setNotice({ tone:'info', title:'已还原界面状态与 HUD 配置' })`。
  `void` 丢弃了 `setPaperPlanes`/`setContextWindowTokens` 返回的 `Promise<boolean>`；当 `hud.json` 写盘失败时监听器已按 R1 修复返回 `false`，但该路径仍提示“已还原…HUD 配置”。
- 影响：与 M2 原始问题同一类（用户看到成功、实际未写入），只是入口从“开关/保存”变成了“还原”。
- 建议修法：`const [planes, tokens] = await Promise.all([hud.setPaperPlanes(true), hud.setContextWindowTokens(128_000)])`，成功/失败分别提示；失败时提示“HUD 配置未还原：写入 hud.json 失败”。

### 非阻塞

- **R2** — `gui/src/pages/SettingsPage.tsx:1157-1166` 的「保存更改」按钮无条件提示“HUD 设置已即时保存”。该按钮本身不写配置（HUD 在修改时即时写），若此前一次自动保存失败，点击它会造成“已保存”的误读。建议按最近一次保存结果显示或改文案。
- **R3** — M4 的运行时可见性仍无浏览器级证据（本机沙箱阻断 Chromium/agent-browser）。建议在可启动 GUI 的环境打开系统“减少动画”后，实际触发一次消息到达，确认落地环闪仍有 400ms 淡出。
- **R4** — `build:renderer` 在本沙箱不可复现，`npm run build` 的“通过”只能确认到 `theme:build` + `build:main`。与上次评审同源，非代码缺陷；建议在实现方/CI 环境保留构建证据。
- 既有非阻塞项（原评审 N1/N2/N9/N12/N14/N15/N16 等）本期未复核扩大，维持原记录。

---

## 5. 验证限制（如实记录）

- **M4 运行时实测被阻断**：
  - `agent-browser`（0.41.0）：`Socket directory 'C:\Users\yikai\.agent-browser' is not writable: 拒绝访问 (os error 5)`（工作区外不可写）。
  - 直接启动 `chrome.exe --headless=new --dump-dom`：`FATAL:mojo\public\cpp\platform\platform_channel.cc:112 Check failed: 拒绝访问 (0x5)`；`--single-process`、`--headless=old` 亦失败；系统 Chrome 经 `Start-Process` 启动被拒（`Access is denied`）。
  - 该限制与 `build:renderer` 的 `spawn EPERM` 同源（本机沙箱禁止命名管道/管道 stdio）。按任务约束**未提权、未绕过沙箱**，因此 M4 只有“源码 + 真实构建产物”的级联求解，没有浏览器运行时截图/计算样式读数。
- **M2 失败分支**为代码路径核查（`writeHudConfig` throw → IPC reject → `catch` → 错误提示），未在真实 GUI 中制造写盘失败。
- **额度**：无法直接观测；本次未调用 claude/dsh LLM，仅做只读代码/文档核验、三次本地命令（build/typecheck/像素与级联脚本）。不记录虚构百分比。

---

## 6. 复评命令与证据索引

| 命令/探针 | 结果 |
|---|---|
| `git rev-parse --short HEAD` | `6c08e5e`；`git log --oneline -3`：`6c08e5e` / `8c86178` / `90296c9` |
| `git grep -n "只读包装"` | 仅命中 `docs/AGENT_HUD_PHASE4_REVIEW.md`（原评审，未改） |
| Pillow：`docs/hud-phase5/*.png` 颜色统计 | `01` 白 64.03% + 纸白 26.19%（浅色）；`02`/`03` 为深色 |
| Pillow：三张 `*-mark.png` alpha bbox | muse 上下 20/20、dsh 14/13、claude 2/1（见 M5） |
| `node data/reverify-phase45/m4-cascade.cjs` | source 与 `dist` 产物均解得 `animation-duration: 0.4s`、`animation-name: hud-flash-fade`、`t=120ms opacity≈0.499` |
| `cd gui && npm run typecheck` | EXIT=0 |
| `cd gui && npm run build` | `theme:build` + `build:main` 成功；`build:renderer` `spawn EPERM`（esbuild service） |
| `git diff 90296c9 8c86178 -- src/` | 空 |
| `git show --diff-filter=D --name-only 8c86178` | 空（无删除文件） |

### 6.1 逐项结论汇总

| 必须修 | 内容 | 复评结论 | 关键证据 |
|---|---|---|---|
| M1 | 审批 IPC 不再称“只读包装” | ✅ 已修 | `RESUME.md:771/772`、`docs/hud-phase5/README.md:13`、`DAILY_LOG.md:1649`、`ConversationPanel.tsx:399`；`src/approvals.js:518-529` |
| M2 | 写盘失败不再提示“已保存” | ✅ 主路径已修 | `hud.ts:269-299`、`SettingsPage.tsx:113-146`、`main.ts:181-188/352-353`；残留 R1 |
| M3 | 截图主题描述 | ✅ 已修 | `docs/hud-phase5/README.md:5`；PNG 像素统计 |
| M4 | reduced-motion 落地淡出可见 | ✅ 代码层面已修 | `hud.css:392-412`、`brand.css:2101-2110`、构建产物级联求解；运行时未实测 |
| M5 | 图标留白说明 | ✅ 已修 | `sidebar/README.md:17`、`docs/hud-phase3/README.md:49`、`RESUME.md:750`；alpha bbox |
| — | 新问题 R1 | ❌ 必须修 | `SettingsPage.tsx:1144-1156` |

---

*本次只读复核；除本报告与 `DAILY_LOG.md` 追加外未改动任何文件。*
