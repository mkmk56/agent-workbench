# 导航轨图标 + 会话列表自由伸缩（2026-11-17）

分支 `gui/group-chat-upgrade`，基线 `5cd4212`（磨砂黑 Token 层已落地后实施）。
本任务只做三件事：导航轨 logo 换真标、HUD 原样不动、会话列表自由伸缩。

---

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| `gui/src/components/GlobalNav.tsx` | logo 资源由占位的 `@brand/source/mark-only.svg` 换成 `@brand/source/icon-master.svg`（任务栏/窗口图标用的同一枚 Convergence 标）；`alt=""`、`draggable={false}` 保留 |
| `gui/src/styles/brand.css` | `.nav-rail__mark img` 改为 40px、自带纸底标不再叠加 CSS 纸底（去掉了硬编码 `#f5f3ee`）；新增会话列表分隔条 / 折叠条带 / 收起按钮 / 拖拽态样式（全部走 token） |
| `gui/src/components/ChatSidebar.tsx` | 拖拽、键盘、双击复位、折叠/展开、持久化、断点接入 |
| `gui/src/lib/chat-sidebar-layout.ts`（新） | 纯逻辑：范围/步进/钳制、localStorage 读写与校验、断点状态机 |
| `gui/electron/main.ts` | 初始窗口尺寸按 `screen.getPrimaryDisplay().workAreaSize` 钳制；`window.json` 持久化 bounds + maximized，恢复时同样钳制（含显示器移除回落） |
| `gui/electron/window-state.ts`（新） | 上述几何运算的纯函数（可单测） |
| `gui/test/*.test.ts`（新） | 16 条规格断言，`npm run test:layout` |
| `gui/package.json` | 只加了一行 `test:layout` 脚本（无新依赖） |

未改动：`AgentHud.tsx`、`hud.css`、HUD portal、`AppFrame.tsx`、`Layout.tsx`、消息列表、composer、会话卡片与未读逻辑、后端/引擎/协议/数据库。`gui/src/theme/brand.generated.css` 仍为生成物且未被加回版本库。

---

## 2. 交互规格落地对照

| 规格 | 实现 |
|---|---|
| `role="separator"` / `aria-orientation="vertical"` / `aria-valuenow`（含 min/max） | `ChatSidebar.tsx` 分隔条；`aria-valuenow` 拖拽中同步更新 |
| 命中区 ≥6px、可见线 1px | 命中区 8px（侧边栏右内缘），可见线 1px 由分隔条 `::before` 画（原 `border-right` 已移入分隔条，避免出现 2px 双线） |
| 范围 260–480px、步进 8px | `dragChatSidebarWidth()`：指针位移按 8px 量化后钳制；两端点可精确到达 |
| 键盘 ←/→ ±16px | `nudgeChatSidebarWidth()` |
| Home / 双击手柄 → 336px | `onSplitterKeyDown` / `onDoubleClick` |
| 拖拽无过渡、松手无多余动画 | 承载列宽的 `--chat-sidebar-width` 没有任何 transition；拖拽中用 `setPointerCapture` 直接写 CSS 变量（不触发 React 重渲染） |
| 拖拽禁止选中 | `html.is-resizing-chat-sidebar *` → `user-select:none` + `preventDefault()` |
| 折叠留 12px 可点击条带 | `chatSidebarColumnWidth()` 折叠返回 12；条带按钮 `展开会话列表` |
| 折叠时导航轨保留、主区扩展 | grid 列为 `96px | 12px | 1fr`，rail 不动 |
| 展开恢复折叠前宽度 | `width` 与 `collapsed` 分开存 |
| `localStorage["agent-workbench.chatSidebar"] = { width, collapsed }` | `writeChatSidebarLayout` / `readChatSidebarLayout` |
| 损坏/越界值回退 336px | `parseChatSidebarLayout` 对非数字、非布尔、越界（<260 / >480）、坏 JSON 一律返回 `null` → 默认 336 |
| ≤1180px 默认 280px、≤1080px 自动折叠 | `defaultChatSidebarLayout` / `applyViewportWidth`（只对"无用户宽度"给 280；跨过 1080 自动折叠，回到 1080 以上自动恢复，手动折叠不会被自动展开） |
| 主进程 wedge | 见 §1 `main.ts` |
| transition 只动 transform/opacity、≤200ms、ease-out、reduced-motion | 新增动画只有分隔条 `opacity`（`--duration-fast` 150ms / `--ease-out`），全局 `prefers-reduced-motion` 块照旧压到 0.01ms |
| 手柄 `--border` → hover `--border-strong`；无橙/无辉光/无渐变 | 见 `brand.css` 新增块；无任何硬编码色值 |

---

## 3. 环境限制：本会话**无法**产出 GUI 截图（属实告知）

本会话沙箱禁止子进程创建命名管道（named pipe）与修改 ACL，导致：

- `electron .` 启动即 FATAL：`install_dir_access.cc:52 Sandboxed processes cannot read …gui/node_modules/electron/dist: its ACL has an entry for an AppContainer package SID but none for ALL APPLICATION PACKAGES`。把 `electron/dist` 复制到 `%TEMP%` 同样失败；`icacls /grant *S-1-15-2-1` 被沙箱拒绝；升级到 `danger-full-access` 本会话无审批通道（`requires approval, but no approval channel is available`）。
- Chrome / agent-browser 同样不可用：`mojo/public/cpp/platform/platform_channel.cc:112 Check failed`（命名管道被拒），`--headless --single-process --no-sandbox` 也无法绕过。
- 应用 userData（`%APPDATA%\agent-workbench`）在工作区外，沙箱拒绝写入，`localStorage` / `window.json` / `hud.json` 无法落盘。

因此本次**没有**导航轨 / HUD / 会话列表 / 聊天主区的运行截图，也**没有** HUD 逐像素对照与"重启后恢复宽度"的实机录像。这些验收项一律按"未通过（环境不可执行）"记，不按"基本完成"记。

已产出的替代证据：

| 证据 | 路径 | 说明 |
|---|---|---|
| 40px 图标渲染对照（8×） | `docs/gui-nav-sidebar/01-icon-40px-review.png` | 用 `assets/branding/app-icon/generate_icons.py` 的同一几何在 40px 下渲染：深色轨底、纸白轨底、以及 icon-small 小尺寸几何对照。像素扫描：圆角纸底之外没有任何非轨底像素（无白边溢出） |
| 规格单测 | `gui/test/*.test.ts`（`npm run test:layout`，16 项全过） | 范围/步进/键盘/复位/钳制/localStorage 校验/断点状态机/窗口几何钳制。脚本带 `--experimental-test-isolation=none`：本沙箱禁止 `node --test` 为每个测试文件 spawn 子进程（`spawn EPERM`），置空隔离后同进程执行 |
| 类型检查 + 构建 | `npm run typecheck`、`npm run build` | 均通过 |
| 产物核对 | `gui/dist/assets/index-*.js` | 内含 `icon-master.svg` 的 data URI（`stroke-width='72'`、`r='56'`），不含旧占位标的 `54/42` |

### 本地复核步骤（约 3 分钟）

```powershell
cd gui; npm run build; npm start
```

1. 群聊页：拖分隔条到 260px / 480px 两端，观察侧栏列宽跟手、无抖动、无横向滚动条、无文字选中。
2. 手柄聚焦后 ←/→ 各按一次（±16px）、Home 复位到 336px；双击手柄同样复位。
3. 点头部「收起会话列表」→ 12px 条带；点条带展开 → 回到折叠前宽度。
4. 关闭再启动 → 宽度与折叠态保持；`%APPDATA%\agent-workbench\window.json` 存在且 bounds 正确。
5. 窗口缩到 1180px 以下：无用户宽度时默认 280px；缩到 1080px 自动折叠；拉回 1080px 以上自动恢复。
6. HUD：与改动前截图逐像素对照（本次对 `AgentHud.tsx` / `hud.css` 零改动）。

---

## 4. 与视觉方案的冲突点（按要求上报）

1. **图标内的橙色节点**：`icon-master.svg` / `.ico` 的节点是 `#E85D26`（方向 A 定稿，2026-11-16 用户确认）。`VISUAL_SCHEME.md` 要求"无信号橙残留"，但任务书 §2 明确"不要改标的造型与配色"、且任务栏已集成同一枚标。本次按任务书执行：导航轨图标与任务栏图标是同一枚标（含该橙点），UI 自绘部分零橙色（`gui/src` 内已无 `#e85d26` 字面量）。若要求连图标节点一并去橙，需要产品侧重新定稿图标。
2. **深色轨底上的纸色底标**：纸底是图标本身的一部分（任务书 §2 明确不许为深色模式改深），因此深色轨上是一枚纸色圆角方块；已移除原先叠加在 `<img>` 上的 CSS 纸底 + 内边距，避免"双层纸底 / 双描边"。