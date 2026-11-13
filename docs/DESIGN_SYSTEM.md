# Agent Workbench 设计系统

> 版本：1.0（2026-11-13）
> 适用范围：Electron 桌面端 GUI、网页文档、品牌物料。
> 状态：规范已建立；GUI 组件实现待正式 GUI 工程启动后按本规范落地。
> 图标母版：`assets/branding/source/icon-master.svg`（不得重绘）。品牌规范见 `docs/BRAND_GUIDELINES.md`。

---

## 1. 设计原则

1. **清晰优先**：任务状态、执行器、日志与操作入口必须一眼可辨；不用装饰性元素干扰信息层级。
2. **克制**：中性色承担绝大部分界面，信号橙只用于操作、选中与关键状态；不做发光、玻璃拟态、紫蓝渐变。
3. **可掌控**：界面让用户知道“现在发生了什么、下一步能做什么”，而不是展示无意义仪表盘。
4. **一致**：颜色、字号、间距、圆角、状态反馈全部使用本文档的 token，不临时发明数值。
5. **可访问**：文本对比度、焦点可见性、非颜色提示是硬性要求，不是可选项。

---

## 2. 色彩体系

### 2.1 核心色板

| Token | 色值 | 角色 |
|---|---|---|
| Ink / 墨 | `#1E2126` | 主文字、深色底、图标底板 |
| Paper / 纸 | `#F5F3EE` | 浅色底、深色底上的主文字 |
| Signal Orange / 信号橙 | `#E85D26` | 主操作、焦点、选中、汇聚节点 |
| Gray / 灰 | `#8A8F98` | 次要信息、禁用、分隔与辅助图形 |
| Success / 成功 | `#2E7D5B` | 成功状态、完成 |
| Warning / 警告 | `#D97706` | 警告、需注意 |
| Error / 错误 | `#C0392B` | 错误、失败、危险操作 |

使用比例建议：中性色（墨/纸/灰）约 90%，信号橙不超过 10%，语义色仅在对应状态出现。信号橙不是装饰色。

### 2.2 浅色模式语义 token

| Token | 色值 | 用途 |
|---|---|---|
| `--bg` | `#F5F3EE` | 应用背景 |
| `--surface` | `#FFFFFF` | 卡片、输入框、弹窗 |
| `--surface-subtle` | `#EDEAE2` | 次级面板、表头、禁用底 |
| `--surface-hover` | `#E7E3D9` | 列表/菜单悬停 |
| `--surface-disabled` | `#E6E2D8` | 禁用控件底 |
| `--border` | `#D8D5CC` | 默认边框、分隔线 |
| `--border-strong` | `#BFBBB0` | 悬停边框、强调分隔 |
| `--text` | `#1E2126` | 主文字 |
| `--text-secondary` | `#5F656E` | 次要文字、占位符（5.30:1） |
| `--text-muted` | `#8A8F98` | 禁用、装饰、非关键元数据（2.93:1，不可用于正文） |
| `--accent` | `#E85D26` | 主按钮、选中、焦点 |
| `--accent-hover` | `#F26B36` | 主按钮悬停（与墨 5.33:1） |
| `--accent-pressed` | `#E85D26` + 内阴影 | 主按钮按下（见 6.1，不压暗以免对比度不足） |
| `--accent-text` | `#C0471A` | 浅色底上的橙色文字/链接（4.55:1） |
| `--accent-subtle` | `#FBE8DF` | 橙色浅底、选中行 |
| `--focus-ring` | `rgba(232, 93, 38, 0.35)` | 焦点外环（配合 2px 实线） |
| `--success` | `#2E7D5B` | 成功填充/图标 |
| `--success-text` | `#25684C` | 浅色底成功文字（5.99:1） |
| `--success-subtle` | `#E3F1EA` | 成功提示底 |
| `--warning` | `#D97706` | 警告填充/图标 |
| `--warning-text` | `#9A5B00` | 浅色底警告文字（4.89:1） |
| `--warning-subtle` | `#FCF0DC` | 警告提示底 |
| `--error` | `#C0392B` | 错误填充/图标/危险按钮 |
| `--error-text` | `#A93226` | 浅色底错误文字（5.97:1） |
| `--error-subtle` | `#F9E5E2` | 错误提示底 |
| `--scrim` | `rgba(30, 33, 38, 0.48)` | 弹窗遮罩 |

### 2.3 深色模式语义 token

| Token | 色值 | 用途 |
|---|---|---|
| `--bg` | `#1E2126` | 应用背景 |
| `--surface` | `#25292F` | 卡片、输入框、弹窗 |
| `--surface-subtle` | `#2C3138` | 次级面板、表头、禁用底 |
| `--surface-hover` | `#333941` | 列表/菜单悬停 |
| `--surface-disabled` | `#2C3138` | 禁用控件底 |
| `--border` | `#3A4048` | 默认边框、分隔线 |
| `--border-strong` | `#4A515A` | 悬停边框、强调分隔 |
| `--text` | `#F5F3EE` | 主文字（14.56:1） |
| `--text-secondary` | `#A8ADB5` | 次要文字（7.16:1） |
| `--text-muted` | `#8A8F98` | 禁用、非关键元数据（4.97:1） |
| `--accent` | `#E85D26` | 主按钮、选中、图标（与墨 4.63:1） |
| `--accent-hover` | `#F26B36` | 主按钮/链接悬停（5.33:1） |
| `--accent-pressed` | `#E85D26` + 内阴影 | 按下 |
| `--accent-text` | `#FF8A5C` | 深色底橙色文字/链接（6.95:1） |
| `--accent-subtle` | `#3A2620` | 橙色浅底、选中行 |
| `--focus-ring` | `rgba(255, 138, 92, 0.45)` | 焦点外环 |
| `--success` | `#63C79B` | 成功（7.82:1） |
| `--success-text` | `#63C79B` | 深色底成功文字（7.82:1） |
| `--success-subtle` | `#1F3A2F` | 成功提示底 |
| `--warning` | `#F0A63C` | 警告（7.86:1） |
| `--warning-text` | `#F0A63C` | 深色底警告文字（7.86:1） |
| `--warning-subtle` | `#3A2E1B` | 警告提示底 |
| `--error` | `#F08A7E` | 错误（6.64:1） |
| `--error-text` | `#F08A7E` | 深色底错误文字（6.64:1） |
| `--error-subtle` | `#3A2321` | 错误提示底 |
| `--scrim` | `rgba(0, 0, 0, 0.62)` | 弹窗遮罩 |

### 2.4 对比度实测

以下比值按 WCAG 2.x 相对亮度公式计算（2026-11-13，脚本计算，非估算）：

| 前景 / 背景 | 对比度 | 结论 |
|---|---|---|
| Ink `#1E2126` / Paper `#F5F3EE` | 14.56:1 | AAA |
| Paper / Ink | 14.56:1 | AAA |
| Signal Orange / Ink | 4.63:1 | AA 正文 |
| Ink / Signal Orange | 4.63:1 | AA 正文 |
| Paper / Signal Orange | 3.14:1 | 仅大字号或图形，不可作正文 |
| Signal Orange / Paper | 3.14:1 | 浅色底橙色文字改用 `#C0471A`（4.55:1） |
| Gray `#8A8F98` / Paper | 2.93:1 | 仅禁用/装饰 |
| Gray / Ink | 4.97:1 | AA |
| `#5F656E` / Paper | 5.30:1 | AA |
| `#A8ADB5` / Ink | 7.16:1 | AAA |
| Success `#2E7D5B` / Paper | 4.51:1 | AA（临界，文字优先用 `#25684C`） |
| Success / Ink | 3.23:1 | 深色底改用 `#63C79B`（7.82:1） |
| Warning `#D97706` / Paper | 2.87:1 | 浅色底文字改用 `#9A5B00`（4.89:1） |
| Warning / Ink | 5.07:1 | AA |
| Error `#C0392B` / Paper | 4.90:1 | AA |
| Error / Ink | 2.97:1 | 深色底改用 `#F08A7E`（6.64:1） |

规则：

- 正文（≤ 18px 常规字重）必须 ≥ 4.5:1；大字号或图标 ≥ 3:1。
- 不使用颜色作为唯一信息载体；状态必须同时有文字或图标。
- 浅色底上的橙色正文使用 `--accent-text`，不要直接用 `#E85D26`。
- 深色底上的语义色使用深色模式 token，不要把浅色模式的 `#2E7D5B` / `#C0392B` 直接当文字色。

---

## 3. 字体体系

### 3.1 字体栈

| 用途 | 字体栈 | 说明 |
|---|---|---|
| 界面正文 / 标题 | `"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif` | Windows 优先 Segoe UI；中文回退微软雅黑 UI |
| 等宽 / 日志 / 任务 ID | `"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "SFMono-Regular", monospace` | 日志默认 Cascadia Code；无则 JetBrains Mono / Consolas |
| 品牌字标 | Inter Bold（OFL）轮廓路径 | 已转曲，见 `assets/branding/logo/*.svg`；不在界面中用字体重新排字标 |

### 3.2 字号与行高

| Token | 字号 / 行高 | 字重 | 用途 |
|---|---|---|---|
| `display` | 32 / 40 | 600 | 空状态大标题、关于页产品名 |
| `heading` | 24 / 32 | 600 | 页面标题 |
| `title` | 20 / 28 | 600 | 弹窗标题、卡片组标题 |
| `subtitle` | 16 / 24 | 600 | 区块标题、空状态标题 |
| `body-lg` | 16 / 24 | 400 | 大段说明 |
| `body` | 14 / 22 | 400 | 默认界面正文 |
| `label` | 13 / 20 | 600 | 按钮、表单标签、表头 |
| `small` | 12 / 18 | 400 | 辅助说明、时间戳 |
| `caption` | 11 / 16 | 400 | 极简元数据；不用于长文本 |
| `mono` | 13 / 20 | 400 | 日志、任务 ID、命令 |

规则：

- 界面默认正文 14px；日志与代码 13px 等宽。
- 字重只用 400 / 600 / 700；700 仅用于品牌字标，不用于界面标题。
- 标题字距 `-0.01em`，display `-0.02em`；正文不做负字距。
- 不使用全大写英文长句；缩写（如 ID、MCP）保持原样。
- 数字使用等宽数字 `font-variant-numeric: tabular-nums`（表格、耗时、计数）。

---

## 4. 间距

只使用以下 7 个步进，不新增 6 / 10 / 14 / 20 等中间值：

| Token | 值 | 典型用途 |
|---|---|---|
| `space-1` | 4px | 图标与文字、徽标内边距 |
| `space-2` | 8px | 控件内部间距、紧凑堆叠 |
| `space-3` | 12px | 表单字段间距、列表行内边距 |
| `space-4` | 16px | 卡片内边距、区块间距 |
| `space-5` | 24px | 弹窗内边距、页面边距 |
| `space-6` | 32px | 大区块分隔、面板内边距 |
| `space-7` | 48px | 页面上下留白、空状态垂直节奏 |

例外（不是间距 token）：1px 边框、2px 焦点环、16/20/24px 图标尺寸、组件固定高度。

---

## 5. 圆角与阴影

### 5.1 圆角

| Token | 值 | 用途 |
|---|---|---|
| `radius-xs` | 2px | 进度条 |
| `radius-sm` | 4px | 按钮、输入框、标签、菜单项 |
| `radius-md` | 8px | 卡片、提示条、浮层 |
| `radius-lg` | 12px | 弹窗、大型面板 |
| 图标底板 | 固定几何 | 母版中 `rx=104 / 512`（约 20.3%），仅用于应用图标，不套用到界面组件 |

规则：

- **不做胶囊化**：按钮、输入框、标签、徽标一律不用 `border-radius: 999px`。
- 仅状态圆点、进度条端点、应用图标底板允许全圆或固定几何。
- 同一容器内的圆角层级保持“外大内小”：弹窗 12 → 卡片 8 → 控件 4。

### 5.2 阴影

阴影克制使用，优先用 1px 边框区分层级；禁止彩色阴影、发光和多层装饰阴影。

| Token | 值 | 用途 |
|---|---|---|
| `shadow-1` | `0 1px 2px rgba(30,33,38,.08)` | 卡片悬停、轻微浮起 |
| `shadow-2` | `0 4px 12px rgba(30,33,38,.12)` | 下拉菜单、提示条 |
| `shadow-3` | `0 16px 40px rgba(30,33,38,.18)` | 弹窗、命令面板 |
| 深色模式 | 边框 + 提升底色 | 深色下阴影不明显，靠 `--surface` 分层与 `--border` 区分 |

弹窗阴影必须与 1px `--border` 同时使用；阴影不替代边界。

---

## 6. 组件规范

### 6.1 按钮

尺寸：默认高 32px，紧凑 28px，大号 36px；水平内边距 12 / 16px；圆角 4px；标签 13px / 600；图标 16px，图标与文字间距 8px。

| 状态 | 主要（Primary） | 次要（Secondary） | 幽灵（Ghost） | 危险（Danger） |
|---|---|---|---|---|
| 正常 | 底 `--accent`，字 `#1E2126`（4.63:1） | 底 `--surface`，1px `--border`，字 `--text` | 透明底，字 `--text` | 底 `--error`，字 `#F5F3EE`（4.90:1） |
| 悬停 | 底 `--accent-hover`（5.33:1） | 底 `--surface-subtle`，边框 `--border-strong` | 底 `--surface-hover` | 底 `#A93226`（5.97:1） |
| 按下 | 保持 `--accent` + `inset 0 1px 3px rgba(30,33,38,.22)`，整体下沉 1px | 底 `--surface-hover` + 内阴影 | 底 `--surface-hover` + 内阴影 | 底 `#922B21` |
| 禁用 | 底 `--surface-disabled`，字 `--text-muted`，无阴影 | 同左，边框 `--border` | 透明底，字 `--text-muted` | 同禁用样式 |
| 加载 | 保留宽度；14px 旋转指示器 + 文案（如“正在执行…”）；禁用点击 | 同左，指示器用 `--accent` | 同左 | 同左，指示器用 `#F5F3EE` |
| 错误 | 按钮本身不改变颜色；失败后文案改为“重试”并配错误图标，错误原因放在表单/提示条 | 同左 | 同左 | 危险确认失败时保留弹窗并显示错误提示 |

补充：

- 主按钮不使用 Paper 白字（3.14:1 不达标）；按下时不要大幅压暗背景，改用内阴影与 1px 位移表达反馈。
- 焦点：`outline: 2px solid var(--accent); outline-offset: 2px`；深色模式用 `--accent-text`。
- 加载状态必须锁定按钮宽度，避免布局跳动。
- 同一区域只允许一个主要按钮。

### 6.2 输入框 / 选择框 / 多行文本

尺寸：高 32px（多行最小 80px）；圆角 4px；内边距 0 10px；正文 14px / 400；标签 13px / 600，标签与输入框间距 8px。

| 状态 | 表现 |
|---|---|
| 正常 | 底 `--surface`，1px `--border`，占位符 `--text-secondary` |
| 悬停 | 边框 `--border-strong` |
| 聚焦 | 边框 `--accent` + `box-shadow: 0 0 0 3px var(--focus-ring)` |
| 已填写 | 同正常，文字 `--text` |
| 禁用 | 底 `--surface-subtle`，字 `--text-muted`，`cursor: not-allowed` |
| 只读 | 底 `--surface-subtle`，无边框或透明边框 |
| 加载 | 右侧 14px 指示器；输入内容保留可编辑；提交按钮单独进入加载态 |
| 错误 | 边框 `--error` + 错误图标；下方 12px `--error-text` 说明；焦点时红边框 + 错误色外环 |

规则：

- 错误提示放在字段下方，不使用仅红色边框的表达方式；必须带文字。
- 标签常驻，不用占位符代替标签。
- 数字、任务 ID、路径输入使用等宽字体。
- 选择框复用输入框外观；下拉浮层用 `radius-md` + `shadow-2`，选中项用 `--accent-subtle`。

### 6.3 弹窗（Dialog）

| 项 | 规范 |
|---|---|
| 宽度 | 确认类 420px；表单类 560px；复杂内容最大 720px |
| 圆角 / 阴影 | `radius-lg` 12px；`shadow-3` + 1px `--border` |
| 内边距 | 24px；标题与正文间距 12px；正文与底部操作间距 24px |
| 标题 | 20px / 600；正文 14px / 22；辅助说明 `--text-secondary` |
| 底部 | 按钮右对齐，间距 8px；主操作在最右 |
| 遮罩 | `--scrim`；点击遮罩默认不关闭（有未保存内容时禁止关闭） |
| 打开/关闭 | 160ms ease-out；不做弹跳动画 |

状态：

- **正常**：标题、内容、取消/确认。
- **加载**：主按钮 spinner + 禁用；关闭按钮禁用；内容区可显示骨架。
- **错误**：底部上方插入错误提示条（`--error-subtle` 底 + `--error-text`），保留用户输入，主按钮改为“重试”。
- **危险确认**：使用危险按钮；默认焦点放在“取消”；必须写明不可逆后果。

### 6.4 提示（Toast / Inline Message）

- 宽度 320–420px（Toast）；圆角 8px；内边距 12px 16px；1px 边框；`shadow-2`。
- 结构：16/20px 状态图标 + 标题（13px/600）+ 说明（12px/18，`--text-secondary`）+ 关闭按钮。
- 色调：信息（中性）、成功、警告、错误；背景用对应 `*-subtle`，图标与标题用对应 `*-text`。
- 自动消失：信息/成功 4s，警告 6s，错误不自动消失；悬停暂停计时。
- 同屏最多 3 条，右上角堆叠，距窗口边缘 16px；不使用 Emoji。
- 操作失败必须同时提供文字原因与下一步（重试/查看日志）。

### 6.5 进度

| 类型 | 规范 |
|---|---|
| 确定进度 | 高 4px，圆角 2px；轨道 `--surface-subtle`；填充 `--accent`；变化 200ms ease-out |
| 不确定进度 | 30% 宽度滑块，1.2s 循环；不使用条纹、发光或渐变 |
| 旋转指示器 | 14 / 16 / 20px；1.5px 描边；800ms 线性旋转；颜色 `--accent` |
| 任务状态 | 排队=灰；运行=橙；成功=绿；失败=红；取消=灰；必须配文字标签 |
| 错误 | 进度条停止并变为 `--error`，同时显示错误说明与“重试”；不假装继续 |

### 6.6 空状态

- 容器：最大宽度 360px，水平居中，垂直留白 48px；内边距 24px。
- 图标：32px 线性图标或 `mark-only.svg`，颜色 `--text-muted`；不使用大插画、机器人或 Emoji。
- 标题：16px / 600；说明：13px / 20，`--text-secondary`，最多两行。
- 操作：一个主按钮；可选一个文字链接作为次要操作。
- 变体：
  - **无数据**：说明如何创建第一个任务。
  - **无搜索结果**：提供“清除筛选”。
  - **加载失败**：显示错误原因 + “重试”；不要显示成“暂无数据”。

### 6.7 状态徽标

- 高 20px；水平内边距 8px；圆角 4px（非胶囊）；文字 12px / 600；圆点 6px。
- 颜色：排队 `--text-muted` + `--surface-subtle`；运行 `--accent-text` + `--accent-subtle`；成功 `--success-text` + `--success-subtle`；失败 `--error-text` + `--error-subtle`；取消 `--text-secondary` + `--surface-subtle`。
- 徽标文字使用固定词表：排队、运行中、成功、失败、已取消；不使用 Emoji 或仅靠颜色区分。

---

## 7. 动效

| 场景 | 时长 / 曲线 |
|---|---|
| 悬停、焦点 | 120ms ease-out |
| 弹窗、菜单 | 160ms cubic-bezier(0.2, 0, 0, 1) |
| 面板展开 | 200ms cubic-bezier(0.2, 0, 0, 1) |
| 进度更新 | 200ms ease-out |

- 不做弹跳、旋转入场、视差或持续发光。
- 尊重 `prefers-reduced-motion: reduce`：移除位移与循环动画，保留即时状态切换。
- 加载动画只用于“确实在等待”的场景，不用来装饰。

---

## 8. 可访问性基线

1. 所有可交互元素有可见焦点；焦点环 2px + 2px offset，不被 `outline: none` 移除。
2. 正文对比度 ≥ 4.5:1；大字号/图标 ≥ 3:1；禁用态可低于该值但需明确不可用。
3. 状态不能只用颜色表达，必须同时有文字或图标。
4. 点击目标最小 24×24px（推荐 32×32px）；图标按钮必须有 `aria-label`。
5. 弹窗打开后焦点进入弹窗并循环；关闭后焦点回到触发元素。
6. 日志与错误信息不使用纯红色小字堆叠；提供可复制的文本。
7. 支持键盘完成主要流程；快捷键在界面中可发现。

---

## 9. 实现 token（CSS 变量）

```css
:root {
  --bg: #F5F3EE;
  --surface: #FFFFFF;
  --surface-subtle: #EDEAE2;
  --surface-hover: #E7E3D9;
  --surface-disabled: #E6E2D8;
  --border: #D8D5CC;
  --border-strong: #BFBBB0;
  --text: #1E2126;
  --text-secondary: #5F656E;
  --text-muted: #8A8F98;
  --accent: #E85D26;
  --accent-hover: #F26B36;
  --accent-text: #C0471A;
  --accent-subtle: #FBE8DF;
  --focus-ring: rgba(232, 93, 38, 0.35);
  --success: #2E7D5B;
  --success-text: #25684C;
  --success-subtle: #E3F1EA;
  --warning: #D97706;
  --warning-text: #9A5B00;
  --warning-subtle: #FCF0DC;
  --error: #C0392B;
  --error-text: #A93226;
  --error-subtle: #F9E5E2;
  --scrim: rgba(30, 33, 38, 0.48);
  --radius-xs: 2px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --shadow-1: 0 1px 2px rgba(30, 33, 38, 0.08);
  --shadow-2: 0 4px 12px rgba(30, 33, 38, 0.12);
  --shadow-3: 0 16px 40px rgba(30, 33, 38, 0.18);
}

[data-theme="dark"] {
  --bg: #1E2126;
  --surface: #25292F;
  --surface-subtle: #2C3138;
  --surface-hover: #333941;
  --surface-disabled: #2C3138;
  --border: #3A4048;
  --border-strong: #4A515A;
  --text: #F5F3EE;
  --text-secondary: #A8ADB5;
  --text-muted: #8A8F98;
  --accent: #E85D26;
  --accent-hover: #F26B36;
  --accent-text: #FF8A5C;
  --accent-subtle: #3A2620;
  --focus-ring: rgba(255, 138, 92, 0.45);
  --success: #63C79B;
  --success-text: #63C79B;
  --success-subtle: #1F3A2F;
  --warning: #F0A63C;
  --warning-text: #F0A63C;
  --warning-subtle: #3A2E1B;
  --error: #F08A7E;
  --error-text: #F08A7E;
  --error-subtle: #3A2321;
  --scrim: rgba(0, 0, 0, 0.62);
}
```

---

## 10. 变更管理

- 新增颜色、字号、间距或圆角必须先更新本文档，再进入实现。
- 图标母版与字标属于品牌资产，修改需单独评审，不随组件迭代顺手调整。
- 本规范未覆盖的组件，先按第 1 节原则设计，再补入本文档。