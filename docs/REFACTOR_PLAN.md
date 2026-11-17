# 重构方案（REFACTOR_PLAN.md）

> 项目：Agent Workbench 深度重构与多智能体协作能力升级
> 依据：`docs/ARCHITECTURE_AUDIT.md`（2026-11-17，Muse 亲自写）+ `docs/audit-backend-phase1.md`（Claude）+ `docs/audit-frontend-phase1.md`（dsh）
> 审计基线：分支 `gui/group-chat-upgrade`，HEAD `a08d9d1`；审计报告提交后 HEAD `621aec2`
> 作者：Muse（总负责）。本方案由 Muse 亲自写成。
> 状态：第一轮 grill-me 决策已由用户全部批准（2026-11-17 01:43，原话“就按照你推荐的做”）。

---

## 1. 已确认的决策（第一轮，全部批准）

| # | 决策 | 批准的方案 |
|---|---|---|
| D-1 | P0 身份隔离 | 子进程 env 白名单 + master token 移出执行器可读路径 + per-task 短期 token + 消息表记录 `auth_kind`/`principal_id` |
| D-2 | Muse 身份 | 给 Muse 独立 token/principal + 强制 `client_msg_id` + 心跳/lease；Muse 仍是外部调用者，**不建本地假执行器** |
| D-3 | 消息身份字段 | 新增 `executions`/`model_calls` 表，消息行补 `provider`/`model`/`token_usage`/`latency_ms`（完整方案，不只补任务级） |
| D-4 | 重启对账 | 启动时 `reconcile()`：标 origin failed、重放 pending/queued、记录 delivery 尝试 |
| D-5 | 附件契约 | 最终方案 A（后端返回附件对象）；第一批先方案 B（前端合并 `list_chat_files`）快速消除 UUID/0B。两步走 |
| D-6 | 视觉重构排期 | 先修 P0/P1，再做 Premium Matte Black；视觉方案先给用户看、确认后再开发；Claude 身份橙与“彻底去橙”规则的冲突在视觉方案里解决 |

---

## 2. 目标与非目标

### 目标

1. **身份可信**：任何一条消息都能回答“谁发的、凭什么身份、哪次执行”；执行器再也不能冒充 user/muse；Muse 的身份可验证。
2. **消息可靠**：重启、失败、重试不再丢消息、不再重复派发模型调用；每条投递的状态可查、可重试。
3. **执行可追溯**：每次模型调用都有 provider/model/token/latency/request 记录；dsh 不再是黑盒。
4. **性能可量**：先建基线再动手，修完能量出对比；消除已知的写放大与轮询放大。
5. **附件正确**：聊天卡片显示真实名称/大小/类型/解析状态与失败原因；未读链路端到端打通；侧栏可拖拽/折叠/持久化。
6. **视觉升级**：在 P0/P1 之后做 Premium Matte Black（见 `~/workspace/agent-workbench-upgrade/ui-redesign-task.md`），做成桌面级开发控制中心，不是一张黑色 AI 聊天网页。

### 非目标（本次不做）

- 不重写整个项目、不换技术栈、不改 Agent 通信协议的对外语义（只补字段与收紧鉴权）。
- 不做 SSE/流式输出的完整实现（列为中期项；短期用“任务 WORKING + 最近日志摘要”做占位）。
- 不做 dsh 的 MCP 客户端（dsh 仍无 MCP；其执行记录靠服务端侧补齐，见 §3.2）。
- 不删除任何已有功能、不删除旧数据（legacy 路径只读保留，见 §3.3）。
- 不做 macOS 签名/ICNS（已知 limitation，不在本次范围）。

---

## 3. 架构改动（按优先级）

### 3.1 P0 — 安全与身份（最先做，Claude 主做，dsh 交叉审）

#### P0-1 切断 master token 可见性（后端审计 P0-1）

- `src/executors/process.js`：`spawnProcess` 显式构造 env 白名单，只传执行器必需的变量；删除 `MCP_BEARER_TOKEN`、`MCP_DATA_DIR`、`MCP_DB_PATH` 等引擎侧 secrets。
- `workbench.env` 移出仓库根（执行器 `cwd` 即仓库根可直接读到），改由 OS 凭据存储或引擎启动时从受限路径读取；同时把 `workbench.env` 与 `data/chat-files` 的 ACL 收紧到与 `data/claude-mcp.json` 同等（`icacls /inheritance:r`，仅 SYSTEM/Administrators/当前用户）。
- 执行器 `cwd` 改到不含 secrets 的 workspace 目录。
- 验收：新增端到端安全测试——执行器进程内 `process.env.MCP_BEARER_TOKEN` 为空；`APPDATA`/`LOCALAPPDATA` 不再进入执行器，无法用 `%APPDATA%\agent-workbench\credentials\engine.env` 推导真实 master 路径；以 user/muse 发消息被拒；读另一 agent 的 `*-mcp.json` 被拒（真实 `data/` 路径）；知道 master 也不能用 HMAC 派生 human/muse。
  - 限制：同一 Windows 用户下 ACL 无法阻止显式绝对路径读取；且 Node 会把 `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`/`USERNAME` 重新合成到子进程（实测），`os.homedir()` 仍可得到用户目录。因此不声称“物理上读不到”。真正的权限边界是 human/muse 改为独立随机 token，读到 master 也不能派生 muse/human 或获得派发权。

#### P0-2 拆分 principal（后端审计 P0-1/P0-3）

- `human` token：独立的随机 secret（`MCP_HUMAN_TOKEN`，生成后存入 engine.env），只能 `from=user`，默认不能设 `act_recipients`、不能调用 `task_start`/`respond_approval`。
- `muse` token：独立的随机 secret（`MCP_MUSE_TOKEN`，生成后存入 engine.env），只能 `from=muse`，可派发；强制 `client_msg_id`（无则拒绝，见 P1-4）；要求心跳/lease（见 P0-4）。
- 两者都**不再默认由 master 派生**；`WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1` 仅作为显式回滚开关（会重新打开 master → muse 派发链）。
- agent token：绑定 task/agent/exp/scope，按任务短期签发，通过私有通道注入（不落盘到共享可读目录）；不能派发、不能审批；过期即失效。旧静态 agent token 默认拒绝（`WORKBENCH_LEGACY_AGENT_TOKENS=1` 仅为显式回滚）。
- 过渡期：旧 master token 保留一个版本兼容期，仅接受 `from=user` 的 GUI 直连调用，引擎日志记 `deprecated-master-token` 告警；过渡期结束即吊销。回滚见 §5.2。

#### P0-3 记录来源（后端审计 P0-1/P0-3）

- `messages` 新增 `auth_kind`（`human|muse|agent:claude|agent:dsh`）、`principal_id`、`request_id`；`send` 写入；服务端日志记录 tool 名/参数摘要/结果/耗时。
- `chat_deliveries` 增加 attempt 历史（或独立 `delivery_attempts` 表：`created_at`、`attempts`、`first_attempt_at`、`finished_at`）。

#### P0-4 Muse 身份可验证（D-2）

- Muse 独立 token/principal（与 human token 分离）；引擎按 token 种类记录 `auth_kind=muse`。
- Muse 写入强制 `client_msg_id`；`chat-muse-watch` 轮询携带心跳（`last_seen_at` + lease），`chat_status.agents.muse` 从“`idle|needs_reply` 推导”改为真实在线状态（心跳超时 → `offline`）。
- 明确：Muse 不在本地建执行器，不伪造本地 Muse 任务；`task_id=NULL` 的 Muse 协调消息是设计如此，在文档中写明。

#### P0-5 附件契约（D-5，前后端协同）

- 最终方案 A：`src/chats.js:257-259` 改为返回附件对象，复用 `src/context.js:12-20` 的 `fileRef`（补 `parse_error`）；`legacy_paths` 独立字段；同步更新 `docs/CHAT_BACKEND.md`（`files: object[]`）与 `types.ts`；渲染层 `normalizeChatFile` 的字符串分支只服务 `legacy_paths`。
- 第一批方案 B（先行）：消息加载后收集本页 `file_id`，对每个群聊调用一次 `list_chat_files` 建 `Map<file_id, ChatFile>` 合并进消息；按 `chatId` 缓存，发送/上传后失效；未命中 ID 渲染“附件（file_id 前 8 位）”，不伪造大小/状态；`status==='legacy-path'` 渲染“历史附件（路径）”，禁用预览/下载。
- 两个方案都要做：`FileCard` 状态中文化 + `parse_error` 展示；`kindOf` 优先用 `file.kind`；补 CSP `blob:`；统一 5 MB 预览上限并在 UI 标注截断；逐文件上传失败处理（见 §3.3）。

#### P0-6 未读链路（前端审计 POLL-4）

- `list_chats` 返回 `unread`（基于 `last_read_seq` 与最大 seq，单条聚合 SQL）；`ChatPage` 在 `newestSeq` 前进时调用 `useMarkChatRead`；侧栏选中会话后徽标清零；“有未读”筛选可用。

### 3.2 P1 — 可靠性与可追溯性

#### P1-1 启动对账（D-4，后端审计 P1-1）

- `Scheduler.recover()` 改为 `reconcile()`：标 origin failed、扫描 pending/queued 并重放、记录 delivery 尝试；初始化顺序改为先装配 `messages` 再 recover；加周期 sweep（兜底）。
- `shutdown()` 同样先对账再清空 running/queue。

#### P1-2 投递重试与状态一致（后端审计 P1-2）

- 区分 transient/permanent 失败；指数退避重试 + dead-letter；消息状态由 delivery 聚合得出（不再由单个 delivery 覆盖）；queued-only 时置消息 `queued`；保留 attempt 历史。

#### P1-3 自动回复去重（后端审计 P1-3）

- 以 `task_id` 判断“该任务是否已回复”（不只看 `reply_to`）；prompt 必带 `reply_to`；空输出不自动回复（不写 `[no summary provided]` 占位）；记录 `auto_reply=true`。

#### P1-4 Muse 幂等（后端审计 P1-4）

- master/Muse 写入强制/强烈建议 `client_msg_id`；增加内容哈希去重窗口；文档明确。`Composer` 重试复用同一个 `client_msg_id`（不在每次 `send()` 生成新的）。

#### P1-5 执行记录表（D-3，后端审计 P1-5/P1-9）

- 新增 `executions`/`model_calls` 表：`execution_id`、`task_id`、`agent`、`provider`、`model`、`provider_request_id`、`token_usage`（input/output/cache_read/cache_creation）、`cost_usd`、`latency_ms`（`duration_api_ms`）、`session_id`、`created_at`。
- Claude：解析 stream-json `result` 的 model/usage/cache/cost/duration 入库；任务创建时写入实际 model/provider（不再全 NULL）。
- dsh：捕获 stderr 的 request_id；记录 dsh session 目录 id、stdout/stderr 摘要；若 dsh 有 usage ledger 则入库；否则明确记 `usage=unknown`（不伪造数字）。
- 消息行补 `provider`/`model`/`token_usage`/`latency_ms`（或通过 `task_id` 关联 executions 表，二选一写进方案实施记录；推荐消息行冗余关键字段以便列表查询）。

#### P1-6 会话连续性（后端审计 P1-6）

- 为 `(chat_id, agent)` 维护 session 指针；派发时传 `sessionId`（Claude `--resume`；dsh 用持久化历史或 chat-scoped session）；记录实际使用的 context 窗口（`context_seq_from`/`context_seq_to`/`context_tokens`，替代语义不足的 `context_version`）。

#### P1-7 日志写放大（后端审计 P1-7）

- 日志按 100–500 ms 或 64 KB 批量写入；`last_activity_at` 最多每秒更新一次，且不每次重写整个任务 JSON；任务 JSON 只在状态转换时写；日志只保留一份（DB 或文件）并加保留期/轮转/归档；过滤 `thinking_tokens` 等高频低价值事件或聚合后再落盘。

#### P1-8 `agent_info` 异步化（后端审计 P1-8）

- 改为异步 spawn/后台刷新；缓存时间加长；启动时预热；使用实际解析到的命令（与执行器同一来源，消除 PATH 歧义）。

#### P1-9 侧栏与窗口（前端审计 LAY-1/LAY-2，任务书 §5）

- 侧栏改为 `--chat-sidebar-width` 驱动 + 拖拽手柄（`role="separator"`，`aria-orientation="vertical"`，`aria-valuenow`）：范围 260–480px、步进 8px；键盘 ←/→ ±16px，Home/双击重置 336px；拖拽中 `cursor: col-resize` 且禁用文本选择；释放写 `localStorage["agent-workbench.chatSidebar"] = {width, collapsed}`；折叠保留 12px 可点击条或导航轨展开按钮，折叠状态同样持久化；启动读取并 clamp 到 `[260,480]`。
- 主进程：按 `screen.getPrimaryDisplay().workAreaSize` clamp 初始尺寸；启动恢复上次 bounds（JSON 文件，与 `hud.json` 同目录），`isMaximized` 单独记；显示器移除时回落主屏工作区。
- 断点：1180px 窄屏（侧栏 280px）；1080px 收起（自动折叠 + 展开按钮）；宽屏消息列加 `max-width: 960px; margin-inline:auto` 或明确“左对齐是设计决定”并写进 DESIGN_SYSTEM。

#### P1-10 轮询与渲染（前端审计 POLL-1/POLL-2/POLL-5）

- 单一数据源：HUD 不再自己拉 `list_messages`；改用 ChatStore 群聊快照（或新增 `presence` 聚合接口）；`list_messages` 默认排除 `chat_id IS NOT NULL`。
- 轮询分层：消息 3 s 只在“最近 90 s 有活动或窗口可见”时跑，空闲退到 10 s；错误指数退避（3→6→12→30 s）；所有 poller 统一 `document.hidden` 暂停。
- 快照相等性：`fetchMessages` 在增量为空时直接 return；`fetchChats/fetchStatus` 比较关键字段后再 set；`React.memo(MessageBubble)` + `useMemo(parseBlocks, [text])`；>100 条时虚拟列表。
- 状态修正：`normalizeAgentState('needs_reply')` 单独返回 `waiting`；`BLOCKED` 纳入离线或单独显示“阻塞”。
- 乐观发送：用 `client_msg_id` 插入 pending 气泡，返回后按 ID 替换；失败保留重试。

#### P1-11 历史与正文（前端审计 ATT-10/ATT-11）

- 分页：`before` + `has_more` 做“加载更早”，内存上限 500 条；`after_seq` 增量若一次 >200 条循环拉到追平；`has_more` 改为多取 1 条判断（修假阳性）。
- 渲染 `body`（不再只渲染 `summary`）；显示“已截断”提示与查看全文；搜索覆盖 body/文件名/发送者。

#### P1-12 附件细节（前端审计 ATT-2/ATT-5/ATT-8）

- `parse_error` 全链路透传（`attachments.ts`/`types.ts`/`chat.ts`/`FileCard`），卡片显示失败原因；状态英文直出改为中文映射。
- 预览上限统一：图片 5 MB、文档提取文本 2 MB，UI 标注“预览已截断”；协议层不吞错误；卡片展示 `previewError`；图片预览加缓存（按 `file_id+sha256` LRU）。
- 批量上传逐文件成败，成功的保留 `fileId`，失败的重试；后端按 `chat_id+sha256` 去重或提供“引用已有文件”。

#### P1-13 身份与视觉缺陷（前端审计 ID-1/ID-2/ID-3/UI-4/UI-5）

- HUD working 环改墨色/中性动画，与 Claude 橙解耦；“Claude 橙”限定在身份元素（名字/头像/气泡边）。
- 浅色头像改实色底（与聊天一致）；选中行/未读徽标改 `--on-accent`（墨色）；删 `brand.css:2228-2234` 与 `2359-2380` 的重复覆盖规则。
- 建 `lib/identity.ts` 单一来源 `{ id, name, mark, colorVar, mention }`；名称优先 `participants[].display_name`；成员浮层增加“模型 / 当前任务 / 待投递”行；侧栏补 Muse 头像。

### 3.3 P2 — 性能与结构

- **N+1 与索引**：`listMessageFiles` 改按 `message_id` 批量 `IN` 一次取回；`statusPayload` 拆轻量 `state`；`task_list` 直接查 `tasks.state`；`chatNeedsMuse` 单条聚合 SQL；加索引 `messages(reply_to)`、`messages(chat_id, from_agent, seq)`、`messages(chat_id, status, seq)`、`tasks(agent, created_at)`、`tasks(state, created_at)`；用 EXPLAIN 验证。
- **上下文**：一次构建、多 recipient 复用；prompt 去重（`context.text` 已含派发消息，不再单独写一遍）；文件清单只放本次附件或按相关度筛选，单独 token 预算；超长 body 硬截断并记录 `body_truncated`。
- **下载与附件**：下载用 `createReadStream` + `Range`；下载路由加限流（移到限流检查之后）与审计日志；收紧 `data/chat-files` ACL；启动清理 `.uploads`；上传过期 GC。
- **旧数据回填**：`root_message_id`/`depth` 按 `reply_to` 重建因果树；旧聊天 epoch 按用户消息重算；Muse 派发消息要求 `reply_to` 用户消息，或新增 `root_request_id`。
- **Schema 治理**：新增 `schema_version` 与正式迁移脚本；逐步加 FK/CHECK（先写入层校验，再启用 `foreign_keys=ON`）；`chat_deliveries` 保留 attempt 历史；`files_json` 与 `message_files` 单一事实源（`files_json` 只保留 legacy 兼容）。
- **文档同步**：统一工具清单（实测 28 个）与 RESUME/CHAT_BACKEND/upgrade 文档；修 `chat.ts:21` 的死引用与 `MessageList` 的错误注释；加工具清单测试。
- **结构统一**：抽 `MessageCard` 供聊天/任务详情复用（或明确下线 `ConversationPanel`）；统一按钮到 `AppButton/AppIconButton` 或登记聊天 primitives；统一 `labels.formatBytes` 与 `fileKind`；两套 mention 解析合一；清死代码/死通道（`chatStore.send`、`LIST_POLL_MS`、`.chat-avatar--agent/--mark`、`preload.pickChatFiles` 等）。
- **中期（不在本次交付内，但方案预留）**：流式/阶段指示（SSE 或事件表）；`presence`/`chat_status` 轻量接口；身份可配置（display_name/model 只读展示 → 设置页可改，需后端 per-chat participant 更新接口）。

### 3.4 UI 视觉重构（D-6，独立任务书）

- 详见 `~/workspace/agent-workbench-upgrade/ui-redesign-task.md`（Premium Matte Black）。
- 执行顺序：P0/P1 修复 → Phase 1 现状审查（可用 dsh 前端审计打底）→ Phase 2 视觉方案（**先给用户看并确认**，含 Claude 身份橙冲突的处理办法）→ Phase 3 开发（Token → 主窗口 → 侧栏 → 聊天 → Agent 状态 → 输入框/上传 → 设置 → 弹窗细节）→ Phase 4 视觉验收（主界面/聊天/设置/弹窗，含橙色残留、对比度、毛玻璃、层级、旧 CSS 覆盖、控制台报错检查）→ Phase 5 交付（改了哪些文件、哪些橙色被移除、Anti-AI Slop 优化、功能测试、未解决问题 + 前后截图）。
- 设计 Skills 落地检查（用户已安装，动手前必读）：impeccable（UI 动手前必读 `reference/craft-floor.md`，Operate 模式 = 精确与克制）；hallmark（既有设计只取 Floor：token 颜色、不 `transition: all`、不做紫蓝渐变/卡片套卡片）；unslop（去 AI 味打磨，九遍）；review-animations（动效 sub-300ms、ease-out、只动 transform/opacity、照顾 reduced-motion）；brand-identity（品牌/图标，16/32px 必看）。

---

## 4. 性能基线计划（动手前建，验收时对比）

按任务书要求，实施前先建基线（真实数据，均值 + P50/P95）：

| 维度 | 测量方法 |
|---|---|
| 发送/接收 | `send_chat_message` 落库到 `list_chat_messages` 可见的耗时 |
| 队列/派发 | 消息落库到子任务启动的耗时；`queued` 停留时长 |
| 模型 | TTFT（首 token）与全生成耗时（Claude stream-json `result.duration_api_ms`；dsh 用任务墙钟差） |
| DB | `logs` 表行数/体积、`data/` 总体积；`list_chat_messages`（200 条）与 `task_list` 的查询耗时 |
| 文件提取 | 各类型附件解析耗时（PDF/DOCX/XLSX/ZIP/图片） |
| 聚合 | 聊天页空闲 30 s 的 IPC 调用数；React 提交次数（DevTools Profiler） |

基线文件：`docs/PERF_BASELINE.md`（实施前快照 + 实施后对比）。验收标准：日志写放大消除后 `logs` 增速与 DB 体积显著下降；聊天页空闲 30 s IPC < 20；3 s 轮询不再触发全列表提交。

---

## 5. 迁移与回滚

### 5.1 数据库迁移

- 新增表：`executions`、`model_calls`（或合一）、`delivery_attempts`；新增列：`messages.auth_kind`、`messages.principal_id`、`messages.request_id`、`messages.body_truncated`、`messages.auto_reply`；新增索引（§3.3）。
- 迁移脚本：正式 `schema_version` 表 + 幂等迁移（沿用现有 `PRAGMA table_info` 判断风格，但集中登记版本号）；旧数据回填（root/depth/epoch）在迁移内完成，分批执行避免锁库。
- 回滚：新增字段全部可空，旧代码忽略新字段；新表不影响旧查询；`schema_version` 记录每次迁移的逆操作（删表/删列脚本随迁移一起提交）。

### 5.2 Token 拆分（breaking）

- 拆分 `human`/`muse` token 与 per-task agent token 是 breaking change：旧 master token 在过渡期（一个版本）内仍接受 GUI 直连的 `from=user` 调用并记告警；过渡期后吊销。
- 回滚：恢复 master token 接受 `user|muse`（`WORKBENCH_LEGACY_MASTER_ALLOW_MUSE=1`）；恢复 human/muse 派生（`WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1`）；恢复静态 agent token（`WORKBENCH_LEGACY_AGENT_TOKENS=1`，仅在开启时 per-task 签发失败才回退到静态 scoped token 并写日志告警）。
- 部署顺序：后端先行（新 token 体系 + 兼容旧 master）→ 前端随后（新 token 接入 + 未读/附件契约）→ 过渡期结束再收紧。引擎重启前确认无进行中任务（重启会把未完成任务标 FAILED，是已知行为）。

### 5.3 附件契约（breaking）

- `list_chat_messages` 返回附件对象是 breaking change：前端同步改（方案 A 与方案 B 的代码同批上线，B 作 A 的回退）。
- 回滚：前端保留字符串分支兼容（方案 B 的 `list_chat_files` 合并逻辑可独立工作）；后端保留 `file_id` 数组字段（新增 `files_detail` 对象数组，旧 `files` 字段保留一个版本）。

### 5.4 部署与验证顺序

1. 后端 P0（身份隔离 + token 拆分 + 来源记录）→ 安全测试通过 → 提交。
2. 后端 P1（对账 + 重试 + 执行记录 + 日志）→ 性能基线对比 → 提交。
3. 前端 P0/P1（附件 B → A、未读、侧栏、轮询、分页、正文）→ 6 张截图验收（1080×700 / 1440×900 / 1920×1080 × 浅/深）→ 提交。
4. P2（N+1/索引/上下文/下载/回填/文档）→ 提交。
5. 视觉重构（独立流程，用户确认方案后开发）→ 视觉验收 → 提交。
6. 每批完成后跑 Phase 4 验收（见 §6），通过再进下一批；任何一批失败即停在该批，不跨批。

---

## 6. 测试与验收（Phase 4）

验收报告 `ACCEPTANCE_REPORT.md`：每项标 已通过 / 未通过 / 尚未验证 / 暂时无法实现——未验证的绝不标通过。

### 6.1 功能验收（复用 Phase 6 的 7 项测试，全部重跑）

- Test 1：新群聊，用户发「老大你好！」→ 三方各回「老大你好！有什么要吩咐！」，各自由真实运行时回复（execution_id + 后端日志核对，模型自报只作辅助）。
- Test 2：接力 37×24=888 → +100=988（dsh 必须收到 Claude 的真实消息内容 + 消息 ID）。
- Test 3：上传 PDF/Word/Excel/图片/ZIP；上传/预览/下载/解析全过；聊天卡片显示真实名称/大小/类型/解析状态；失败文件显示原因；历史路径显示“历史附件（不可下载）”且不调用文件接口。
- Test 4：一份 PDF，三方各自独立摘要（每方独立读，绝不由 Muse 读完再分发；失败写明原因）。
- Test 5：一 agent 离线，另两方仍正常工作。
- Test 6：刷新/重启/重进，消息 + 附件持久化；重启后 pending/queued 重放，消息不卡死。
- Test 7：UI 与目标设计图对照（运行中的程序内）。

### 6.2 安全验收（P0 新增）

- 执行器进程内没有 master/human/muse token；`APPDATA`/`LOCALAPPDATA` 不再泄漏；不能以 user/muse 发消息；不能读另一 agent 的 token 配置；知道 master 也不能派生 human/muse 或获得 Muse 派发权；`respond_approval` 不能自批（执行器 token 被拒）。
  - 不在本批声称：同一 Windows 用户下用绝对路径物理读取 `engine.env` 仍可能成功（ACL 对同用户无效，`USERPROFILE`/`os.homedir()` 不受 env 白名单影响，Node 会重新合成）；需 OS 级隔离才能消除。
- `user`/`muse` 身份在 DB 里可归因（`auth_kind`/`principal_id`/`request_id` 有值）；Muse 消息有 `client_msg_id`；心跳超时后 `chat_status` 显示 Muse 离线。

### 6.3 性能验收（对照 §4 基线）

- 日志增速、DB 体积、IPC 调用数、React 提交次数达到 §4 目标；`task_list`/`list_chat_messages` 查询耗时下降（EXPLAIN 验证索引命中）。

### 6.4 视觉验收（见 ui-redesign-task.md Phase 4）

- 无明显信号橙残留；颜色统一；文字对比度 ≥4.5:1；无毛玻璃滥用；无层级混乱/布局错位；旧 CSS 不覆盖新样式；原有交互不受影响；控制台无报错；主界面/聊天/设置/弹窗四处必查；前后截图存档。

---

## 7. 分工（用户 2026-11-17 01:17 批准）

- **Claude：后端和核心工程。** 消息路由、调用链、身份鉴权、调度、数据库、性能。长会话、多轮调试都是它；只有它能执行关机等高权限操作。主力工程师。
- **dsh：前端实现 + 独立审查。** 前端组件、布局、交互归它；同时是另一双眼睛，专门审 Claude 的后端、做独立测试。dsh 是一次性的、不能断点续跑，给它边界清晰的任务，别扔超长多轮的大活。
- **Muse：总负责、架构、验收、设计把关。** 不写大块生产代码，但亲自读所有人的代码、核对每个结论、写审计和方案、拍板架构取舍、跟用户对齐。优势是全局视角和判断，不是手速。
- 三条规矩：谁写的代码不能由谁自己验收；重要改动必须另一个人交叉审；同一批文件同一时间只能一个人改。
- 本次分工细化：Claude = 后端核心（§3.1/§3.2 后端部分 + §3.3 后端部分）；dsh = 前端组件与交互（§3.1 P0-5/P0-6、§3.2 前端部分）+ Claude 后端的独立审查与测试；Muse = 方案、拆分、验收、设计把关、亲自核对代码与测试结果。

---

## 8. 附录：证据来源

- `docs/ARCHITECTURE_AUDIT.md`（Muse，2026-11-17；提交 621aec2）
- `docs/audit-backend-phase1.md`（Claude，2026-11-17；提交 9a9ff29）
- `docs/audit-frontend-phase1.md`（dsh，2026-11-17；提交 9a9ff29）
- Muse 个人核查笔记：`~/workspace/agent-workbench-upgrade/phase1-muse-personal-notes.md`（含两处自我纠正：冒充结论、legacy-path 范围）
- 任务书：`~/workspace/agent-workbench-upgrade/deep-refactor-task.md`（含用户补充与第一轮决策）
- 视觉任务书：`~/workspace/agent-workbench-upgrade/ui-redesign-task.md`（Premium Matte Black）