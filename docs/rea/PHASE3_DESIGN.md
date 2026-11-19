# Phase 3 设计：Listener / Check-in / Wake（后台自主协作）

> 状态：草案，待用户签核后进入实现。签核前不写 Phase 3 代码。
> 依据：TARGET_ARCHITECTURE.md（D7）、MESSAGE_PROTOCOL.md、DATABASE_DESIGN.md、
> SECURITY_DESIGN.md、docs/rea/pachat/RUNTIME_ANALYSIS.md、
> docs/rea/pachat/AGENT_PROTOCOL_ANALYSIS.md、项目文档 §7（第六阶段）。
> 现状核查：2026-11-19 在 MOG 生产代码上实测确认（见 §2）。

## 1. 目标

Phase 2 让 Agent 有了身份、Inbox、@ 事件和多群，但**所有任务仍需有人显式派发**：
没有人点名，Agent 不会自己动。Phase 3 要补上这一块——

**用户关掉聊天页面后，@ 一下 Agent，它自己醒来、读上下文、干活、回群里。**

做到三点就算成：

1. **@ / 回复 / 群主发帖能唤醒 Agent**，不需要人工再派一次任务；
2. **Agent 不在线也能收到事**：SSE 长连接推事件，连不上就定期 check-in 拉；
3. **唤醒有节制**：节流、上限、失败禁用、通知群主，绝不静默失败、绝不无限自启。

### 1.1 不在本期

- **GUI 实时推送**：SSE 端点本期只服务 Listener/CLI；GUI 继续现有轮询，
  实时推送是 Phase 4 的体验项。
- **Webhook 唤醒**（向第三方 URL POST 事件）：本期不做，见 §17 D7。
- **Muse 的本地执行器**：Muse 依然没有本地 executor，唤醒 Muse 只能走
  外部 MCP 调用方（见 §9 映射表）。
- **社区 / 公开群**：Phase 5 暂缓，本期只做 link 群。

## 2. 现状盘点（MOG 实测，2026-11-19）

| 维度 | 现状 | 对 Phase 3 的意义 |
|---|---|---|
| HTTP 层 | 原生 `node:http`，无 Express；MCP 走 StreamableHTTPServerTransport | SSE 端点直接挂在现有 server 上，不引入新框架 |
| @ 事件钩子 | `MessageService` 有 `onMention` 回调（messages.js:287，触发点 944–948），**当前为 null** | 唤醒层只需接上这个钩子，不动消息主路径 |
| Inbox 事件 | `_recordInboxEvents` 已写 mentions/replies 计数并触发钩子 | 事件源现成，不用再解析消息 |
| 派发模型 | 只有显式收件人（`to` / `act_recipients` → message_deliveries）才会建任务；广播和单纯 @ 不建任务（messages.js deliverChatActions / attemptDelivery） | **这就是 Phase 3 要改的唯一行为**：@ / 回复 / 群主发帖自动产生一次唤醒尝试 |
| 任务启动 | `Scheduler.createTask({agent, prompt, cwd, sessionId, model, timeoutMs, threadId, originMessageId, chatId})` → 队列 → `pump()`（全局 ≤4，dsh ≤2）→ `launch()` | 唤醒复用同一条路，不另起执行通道 |
| 防重 | `findActiveTaskForThreadAgent`（每 thread 每 Agent 只一个活动任务）；`agentAutoDeliver` 总开关 | 唤醒的防重在此基础上加每群合并（§8） |
| 定时器 | `Scheduler` 已有 heartbeatTimer / sweepTimer / timeoutTimer | check-in 调度复用 sweep 机制，不另起进程 |
| 上下文 | `buildChatContext`（30 条 / 6000 token 预算）、`buildMessagePrompt` | 唤醒提示词与正常派发一致 |
| SSE | **没有**（`text/event-stream` 全仓无命中） | 新建 `GET /events` |
| check-in | **没有** | 新建 `PUT /checkin` + `checkins` 表 |
| 唤醒记录 | **没有** | 新建 `wake_events` 等表（§11） |
| 心跳 | `muse_heartbeat` 5 分钟租约已存在 | Listener 存活可复用心跳语义，见 §5 |

## 3. 总体方案

三条唤醒路径，一套事件源：

```
群聊消息 ──► _recordInboxEvents ──► onMention / 回复 / 群主事件
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              ▼                               ▼                               ▼
      WakeService（引擎内）            SSE /events                    Check-in（拉）
      内置 Agent：                     第三方/远程 Agent：            连不上 SSE 的 Agent：
      Claude / dsh 直接                 Listener CLI 持长连接，         每 N 分钟 PUT /checkin，
      createTask 起运行                接事件后调 MCP 唤醒            顺带拉 Inbox
              │                               │                               │
              └───────────────► 全部受节流 / 上限 / 失败禁用约束 ◄───────────────┘
```

- **事件只产生一次**：消息写入时记 inbox 计数、发 `onMention`；三种路径
  消费的是同一事件，不重复计数。
- **唤醒不等于派发**：派发是人点的（立即、显式）；唤醒是事件触发的
  （受节流、开关、失败策略约束，可被拒绝——拒绝时事件仍保留在 Inbox，
  下次 check-in 还能看到）。
- **引擎永远在线假设**：MOG 引擎由 Task Scheduler 常驻（AgentWorkbench 任务），
  所以内置 Agent 不需要额外常驻进程；需要常驻进程的只有**跑在别的机器上
  的第三方 Agent**，它们用 Listener CLI。

## 4. 事件模型

### 4.1 事件种类

| kind | 触发条件 | 唤醒对象 |
|---|---|---|
| `mention` | 消息 mentions 列表含某 Agent（`normalizeMentions` 已校验成员身份） | 被 @ 的 Agent |
| `reply` | 消息 reply_to 指向某 Agent 的消息 | 被回复的 Agent |
| `owner_post` | 群主（user）在群里发消息 | 群内全部已启用唤醒的 Agent（见 D2 注） |
| `manual` | 群主或 Agent 调用 `wake_now` | 该 Agent（手动触发；绕过节流但仍计入每日上限） |
| `recall` | 消息被撤回 | 只记事件、**不唤醒**（避免撤回引发无意义运行） |
| `task_done` | 某 Agent 的任务完成并回了结论卡片 | 不唤醒；供 Listener 更新状态用 |

> 实现说明（2026-11-19）：`record()` 只接受 `mention` / `reply` /
> `owner_post` 三种自动事件；未知 kind 直接忽略并记日志，不再强制当成
> `mention`。`manual` 只由 `wake_now` 写入。`@muse` 也会产生事件（Muse 是
> 外部可投递目标，只记录事件、走 SSE / check-in，永不创建本地任务）。

### 4.2 事件包络（SSE 与 check-in 共用）

```json
{
  "id": "evt_01J...",
  "seq": 128,
  "chat_id": "e54c1ee1-...",
  "kind": "mention",
  "from": "user",
  "agent_id": "agent_claude",
  "message_id": "...",
  "message_seq": 128,
  "mentions": ["agent_claude"],
  "created_at": 1763539200000
}
```

- `seq` 全局单调递增（沿用 messages.seq 的分配方式），是断线续接的游标。
- 事件**只发给成员 Agent**：SSE 连接按 token 定身份，非成员收不到该群事件。
- 事件保留 7 天（供续接），过期清理进 sweep。

## 5. SSE 端点 `GET /events`

- **鉴权**：Bearer token（复用 `identifyToken`）；master token 可订阅全部群，
  agent token 只能订阅自己是成员的群；鉴权失败记审计日志（复用 audit.js）。
- **订阅参数**：`?chat_id=`（可选；不给则订阅该 Agent 全部群）、
  `Last-Event-ID` 请求头或 `?since_seq=` 续接。
- **心跳**：每 25 秒发 `: ping` 注释行——Cloudflare 隧道在前面，
  无心跳长连接会被中间层掐掉；25 秒是保守值。
- **断线**：客户端重连时带 `since_seq`，引擎重放该 seq 之后的事件；
  超过 7 天的 gap 不补发，返回 `{"type":"resync","last_seq":...}`，
  客户端改走 check-in 全量拉 Inbox。
- **背压**：单连接未消费事件积压 >1000 条时断开该连接（客户端重连续接），
  防止内存膨胀。
- **不服务 GUI**：本期 SSE 只给 Listener/CLI 用；GUI 仍走现有 MCP 轮询。

## 6. Listener CLI（第三方 / 远程 Agent 用）

单文件 `scripts/listener.mjs`（Node 18+，零依赖，对标 Pachat 的 `pachat.mjs`）：

```
node scripts/listener.mjs --agent agent_xxx --chat <chat_id，可选>
```

- **连接**：持 `GET /events` 长连接；1 分钟连不上引擎 → **自卸载退出**
  （照搬 Pachat 规则：不静默空转、不无限重试）。
- **接事件**：收到本 Agent 的 `mention` / `reply` / `owner_post` 事件后，
  调引擎 MCP `wake_now`（或直接创建任务，见 §12）触发一次运行；
  每群同时只跑一个任务（复用引擎侧防重）。
- **会话**：每群一个会话，可续接（`since_seq` 持久化到本地 `listener-state.json`，
  600 权限，与 token 同目录）。
- **上限**：15 分钟无输出即停、1 小时硬上限、每天每群 ≤100 次运行
  （与 §8 的引擎侧上限同一套数字，两边都掐）。
- **权限**：群主自己的消息 → 完整权限；别人的消息 → 仅限该群目录
  （与 Pachat 一致；引擎侧 FileService 本来就是按群隔离的）。
- **dsh 特别说明**：dsh 走 DeepSeek Harness headless 二进制，应用不必打开；
  但按 2026-11-18 的用户决定，dsh 已是 danger-full-access，
  Listener 安装仍需群主在应用内明确批准一次（§10）。
- **日志**：每次连接、事件、触发、失败都写本地日志文件；失败绝不伪装成功。

## 7. Check-in（拉模式）

- **接口**：`PUT /checkin {every}`，`every` 2–1440 分钟，默认 10 分钟；
  每次调用更新 `last_checkin_at`，并返回该 Agent 的 Inbox 摘要
  （未读数、未读 @ 数、最新 seq）。
- **用途**：SSE 连不上的 Agent（网络受限、远程主机、纯 CLI 场景）用它兜底；
  也是 Listener 断线后的恢复路径。
- **@ 未读提醒**：@ 后 10 分钟仍未读（游标未过该 seq）→ 通知群主（渠道见 §17 D3）。
- **退避**：连续空 check-in（无新事件）3 次后，引擎建议客户端把间隔翻倍
  （仅建议，客户端可不听；不强制）。

## 8. WakeService（引擎内唤醒，核心）

`src/wake.js` 新服务，server.js 组装时把 `onMention` 接到它身上。
其它事件（reply / owner_post）由 MessageService 在同一位置以
`onWakeEvent(event)` 回调发出——消息主路径只多一次回调，不改写逻辑。

### 8.1 触发规则

1. 事件到达 → 查 `agent_wake` 表：该 Agent 在该群是否启用唤醒；
   未启用 → 只记事件，不唤醒。
2. 查节流（§8.2）；被节流 → 事件记为 `throttled`，不丢（Inbox 还能看到）。
3. 查每群每 Agent 活动唤醒任务：已有 → **合并**（coalesce）：
   不新建任务，把本次事件 seq 记到该轮运行的 `pending_mentions` 里，
   运行结束回群时上下文自然包含新消息；不排队、不积压。
4. 无活动任务 → `Scheduler.createTask` 起一轮唤醒运行，
   prompt = `buildChatContext(chatId)` + 本次事件摘要，
   `originMessageId` = 触发消息，`threadId` = 该群 thread；
   运行计入 `wake_events`（`delivered` + `delivery_task_id`）。

### 8.2 节流与上限（照搬 Pachat 数字，全部可配）

| 约束 | 值 | 说明 |
|---|---|---|
| 唤醒间隔 | 每 Agent 每群 10 分钟 ≤1 次 | 连续 @ 不会连打 |
| 每日上限 | 每 Agent 每群每天 ≤30 次 | 跨天 0 点清零 |
| 运行上限 | 每天每群 ≤100 次唤醒运行 | 所有 Agent 合计 |
| 无输出熔断 | 15 分钟无输出即停 | **新增**看门狗（现有 timeoutTimer 只管总超时） |
| 硬上限 | 1 小时 | 复用 `timeoutMs` |
| 重试 | 失败重试 1 次 | 仅对执行器启动失败重试；任务内失败不重试 |
| 连续失败 | 连续 3 次失败 → 该 Agent 在该群的唤醒**禁用** + 通知群主 | 手动重新启用才恢复 |

现有护栏继续生效，不重复造：每 epoch 预算 20、交换上限 10/线程、
回复深度 8、全局并发 ≤4（dsh ≤2）、per-task token、env allow-list。

### 8.3 失败的定义

任务 state = FAILED、执行器启动失败、15 分钟无输出熔断、1 小时硬上限
都算一次失败；用户主动取消不算。每次失败写 `wake_events`（attempts+1）
和一条系统日志；第三次连续失败 → `agent_wake.enabled=false`、
`disabled_at` 打点、通知群主。

## 9. 唤醒种类与各 Agent 的映射

| Agent | 唤醒路径 | 说明 |
|---|---|---|
| Claude（内置） | 引擎直发（WakeService → createTask → Claude executor） | 不需要 Listener 进程 |
| dsh（内置） | 引擎直发（同上 → dsh executor） | 同上；danger-full-access 已授权 |
| Muse（外部调用方） | SSE /events + check-in | Muse 无本地 executor；由外部 Muse 客户端持 SSE 或 2 分钟 watch（现有 chat-muse-watch 即 check-in 的一种）触发 |
| 第三方 Agent | Listener CLI（SSE）或 check-in | 需配对接入（Phase 2 token）；跑在自己的机器上 |
| Webhook | 本期不做 | 见 §17 D7 |

## 10. 权限与安全

- **SSE 鉴权**：Bearer token；agent token 只能看自己成员群的事件；
  越权订阅记审计日志并断开（复用 Phase 2 的 denial 审计单写路径）。
- **唤醒开关是群主专属**：`wake_enable / wake_disable / wake_now` 只接受
  master token（owner-only，复用 `ignore_new` 的 owner-only 模式）。
- **Listener 安装授权**（项目文档 §7.4，一字不改地执行）：
  不擅自安装开机启动服务；不擅自开启 Full Access；
  安装 Listener 必须获得群主明确授权；不同 Agent 用独立 Credential；
  后台任务必须可暂停、查看状态和卸载；运行日志必须可追溯；
  运行失败不能伪装成成功。
- **开机自启**：引擎**不自动注册** Windows 计划任务；Listener 自启是
  文档化的手动步骤（给命令，群主自己跑），见 §17 D4。
- **第三方文件隔离**：第三方 Agent 的唤醒运行只能访问该群目录
  （FileService 按群隔离；不给其它群路径）。
- **Muse 的唤醒不经过执行器**：Muse 的事件只下发，不在引擎内起进程。
- **token 存放**：Listener CLI 的 token 读 600 权限文件，不放命令行、
  不进日志；沿用 Phase 2 的 token 哈希存储。

## 11. 数据库

迁移脚本 `scripts/migrate-rea-phase3.mjs`（仿 Phase 2：幂等、可重跑、
跑之前备份 workbench.db；P1-1 启动对账覆盖新表）。

### wake_events（唤醒事件表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `wake_...` |
| chat_id | TEXT | 群 |
| agent_id | TEXT | 被唤醒 Agent |
| kind | TEXT | `mention` / `reply` / `owner_post` / `manual` |
| message_id | TEXT | 触发消息 |
| message_seq | INTEGER | 触发消息 seq |
| status | TEXT | `pending` / `delivered` / `throttled` / `merged` / `failed` / `cancelled` / `disabled` |
| attempts | INTEGER | 已尝试次数 |
| delivery_task_id | TEXT NULL | 首轮唤醒产生的任务（重试保留首次值，不覆盖） |
| created_at / updated_at | INTEGER | 毫秒时间戳 |

> 实现说明（2026-11-19）：额外增加 `seq INTEGER`（全局事件序，§4.2 的
> `since_seq` 续接需要）。`seq` 由持久计数器 `app_meta.wake_event_seq`
> 分配，不用 `MAX(seq)+1`：7 天保留期清空整表后计数器不回绕，旧游标的
> Listener 不会因此丢事件且 `resync` 仍能发现真实 gap。`from` / `mentions`
> 不重复存储，事件下发时从 `messages` 行读取，避免两份真相。
>
> `merged` = 该事件并入了同一 (chat, agent) 正在进行的一轮唤醒；
> `cancelled` = 用户主动取消，不算 Agent 失败，不计入连续失败次数。

### listener_sessions（Listener 会话表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `ls_...` |
| agent_id | TEXT | Agent |
| chat_id | TEXT NULL | NULL = 全部群 |
| last_event_seq | INTEGER | 已消费到的 seq（续接游标） |
| status | TEXT | `connected` / `disconnected` |
| connected_at / last_seen_at | INTEGER | 毫秒时间戳 |

### checkins（Check-in 表）

| 列 | 类型 | 说明 |
|---|---|---|
| agent_id | TEXT PK | Agent |
| every_minutes | INTEGER | 间隔，默认 10（2–1440） |
| last_checkin_at | INTEGER NULL | 上次 check-in |
| consecutive_empty | INTEGER | 连续空 check-in 次数 |
| updated_at | INTEGER | 毫秒时间戳 |

### agent_wake（唤醒配置表）

| 列 | 类型 | 说明 |
|---|---|---|
| agent_id | TEXT PK | Agent |
| chat_id | TEXT | 群（每群一行；默认全群启用） |
| enabled | INTEGER | 1 = 启用，0 = 禁用 |
| wake_kinds | TEXT | 启用的种类 JSON（如 `["mention","reply"]`，默认全开） |
| consecutive_failures | INTEGER | 连续失败次数 |
| disabled_at | INTEGER NULL | 禁用时间 |
| PRIMARY KEY | (agent_id, chat_id) | |

### app_meta（持久计数器）

| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 目前只有 `wake_event_seq` |
| value | TEXT | 已分配的最大全局事件序 |
| updated_at | INTEGER | 毫秒时间戳 |

索引：`wake_events(chat_id, agent_id, created_at)`、
`listener_sessions(agent_id, chat_id)`。

> `app_meta` 由 Store 构造函数的 `CREATE TABLE IF NOT EXISTS` 创建（旧库
> 打开时自动补齐），计数器在首次分配 seq 时以当时的 `MAX(seq)` 为种子，
> 之后只增不减；保留期清理不会碰它。

## 12. 接口

### REST（server.js 直挂）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events?chat_id=&since_seq=` | SSE 事件流（§5） |
| PUT | `/checkin` | `{every}`，返回 Inbox 摘要（§7） |
| GET | `/health` | 不变；附加 `wake` 段（WakeService 是否在跑） |

### MCP 新工具（tools.js）

| 工具 | 权限 | 说明 |
|---|---|---|
| `agent_checkin` | agent 自身 | 设置间隔 + 拉 Inbox 摘要（REST 的 MCP 版） |
| `listener_status` | master / agent 自身 | 查会话、最后 seq、在线状态 |
| `wake_status` | master / agent 自身 | 查每群唤醒开关、失败计数、今日已用次数 |
| `wake_enable` / `wake_disable` | **owner-only** | 开/关某 Agent 在某群的唤醒 |
| `wake_now` | **owner-only** | 手动唤醒一次（绕过节流，但计入每日上限） |

> 实现说明（2026-11-19）：为了让第三方 Listener（§6）用自己独立的凭据
> 触发一次唤醒，`wake_now` 额外允许 agent token **只唤醒自己**；跨 Agent
> 唤醒仍然 owner-only。若引擎没有该 Agent 的本地执行器，返回
> `woken:false, reason:"no local executor..."`，Listener 据此决定是否执行
> 本地命令，不会伪装成已唤醒。

### CLI

- `node scripts/listener.mjs --agent <id> [--chat <id>]`（§6）。
- `node scripts/migrate-rea-phase3.mjs [--db <path>]`（§11）。

## 13. GUI 最小范围（Phase 3 只做状态，体验打磨放 Phase 4）

- Inbox / Agent 状态行增加三项：唤醒开关、最后 check-in / 最后事件、
  今日唤醒次数与失败计数；禁用态标红。
- 开关切换只允许群主（owner-only，后端同样校验）。
- 不做新页面、不做实时推送、不做 Listener 安装向导——都在 Phase 4。

## 14. 失败与可观测性

- 每次唤醒尝试都写 `wake_events` + 一条 `data/wake.log`（沿用
  security-audit.log 的 append-only 写法，token/配对码同样脱敏）。
- `wake_status` / `listener_status` 随时可查；GUI 状态行同源。
- 失败绝不伪装成功：熔断、禁用、节流都有明确状态和群主通知，
  不存在“看起来醒了其实没跑”的状态。
- 引擎重启后状态从 DB 恢复（P1-1 对账覆盖新表；进行中的唤醒任务
  按现有规则标 FAILED，不悄悄重跑）。`wake.reconcile()` 按
  `wake_events.delivery_task_id` 对账：任务已 COMPLETED 的保持 delivered；
  用户取消的记 `cancelled`；其余在途行记 `failed` 并计入连续失败（不自动
  重跑），达到阈值同样禁用并通知群主。

## 15. 实施顺序

| 步 | 内容 | 负责人 |
|---|---|---|
| 1 | 迁移脚本 + 新表 + WakeService 骨架（只记事件、不唤醒，先跑通测试） | Claude（后端） |
| 2 | 接上 `onMention` / 回复 / 群主事件 → 真唤醒（节流、上限、合并、失败禁用） | Claude |
| 3 | `GET /events` SSE + `PUT /checkin` + MCP 工具 | Claude |
| 4 | Listener CLI（单文件）+ 文档（安装/暂停/卸载/日志） | Claude |
| 5 | GUI 最小状态行 + 开关（owner-only） | dsh（前端） |
| 6 | 交叉审（Claude 审 dsh 前端，dsh 审 Claude 后端）+ 修复 | 交叉 |
| 7 | 迁移 + 重启 + 实测验收（§16） | Muse 验收 |

三条规矩不变：谁写的代码不能由谁自己验收；重要改动必须另一个人交叉审；
同一批文件同一时间只能一个人改。

## 16. 验收标准

1. **关页面唤醒**：GUI 完全关闭的状态下，群里 `@claude`，
   Claude 自动起任务、读上下文、回群里，全程无人手动派发。
2. **SSE 续接**：Listener 断线重连带 `since_seq`，不丢事件、不重复触发。
3. **Check-in 兜底**：停掉 SSE 只走 check-in，@ 事件 10 分钟内被消费。
4. **节流**：10 分钟内连续 @ 两次，只唤醒一次，第二次记 `throttled`。
5. **合并**：一轮唤醒运行进行中再 @ 一次，不新开任务，事件合并进本轮。
6. **失败禁用**：人为制造 3 次连续失败，唤醒自动禁用并通知群主；
   手动启用后恢复。
7. **上限**：15 分钟无输出熔断、1 小时硬上限、100 次/天可测（用低配额测）。
8. **重启恢复**：引擎重启后开关、失败计数、游标都在，不丢不重置。
9. **越权拒绝**：非成员 token 订事件流被拒并记审计日志。
10. 测试：`test/rea-phase3.test.js` 全过；`npm test` 无新增失败；
    `typecheck` 0 失败。

## 17. 待用户定夺的取舍（签核时 grill）

| # | 问题 | 我的推荐 | 为什么 |
|---|---|---|---|
| D1 | 内置 Agent（Claude/dsh）唤醒走引擎直发，不经过 Listener 进程；Listener CLI 只给第三方/远程 Agent | 按推荐做 | 引擎已常驻、已有执行器，另起进程是多余的一层；Pachat 要 Listener 是因为 Agent 各在各的主机上，我方三台 Agent 都在 MOG |
| D2 | @ 提及即唤醒（以 mentions 列表为准）；没有 @ 的广播不唤醒 | 按推荐做 | 与 Phase 2 的 @ 是事件一致；广播都唤醒等于回到无限自回复的老问题 |
| D3 | @ 后 10 分钟未读、唤醒被禁用，用**群内系统消息**通知群主（同时 Inbox 标记） | 按推荐做 | 看得见、可追溯；只亮 GUI 角标的话关了页面就没人知道，只记日志等于没通知 |
| D4 | Listener 开机自启不由引擎自动注册，改为文档化手动步骤，群主自己跑命令 | 按推荐做 | 项目文档 §7.4 明文：不擅自安装开机启动服务，安装 Listener 必须获得明确授权 |
| D5 | 唤醒运行用完整群聊上下文（buildChatContext 30 条/6000 token），与正常派发一致 | 按推荐做 | 被 @ 的 Agent 没上下文等于瞎回；成本与正常派发相同 |
| D6 | 每群每 Agent 同时只跑一个唤醒任务，后到的事件合并进本轮，不排队 | 按推荐做 | Pachat 同款模型；排队会在群里攒出一串迟到的回复 |
| D7 | Webhook 唤醒本期不做，留 Phase 4 | 按推荐做 | 三个内置 Agent 用不上，第三方先有 Listener CLI 就够；少一个出站面少一分风险 |

## 18. 风险

- **隧道掐 SSE**：Cloudflare 隧道可能对长连接不友好；25 秒心跳是缓解，
  若实测仍断，降级为 check-in 为主、SSE 为辅（不改接口）。
- **唤醒风暴**：群主连发多条、@ 多个 Agent 时的并发由节流 + 合并 + 全局
  并发 ≤4 三层兜住；验收第 4/5/7 条专门测这个。
- **dsh 唤醒时的 CLI 进程死亡**：2026-11-18 两次 Claude CLI 在 Bash 调用中途
  死亡的原因至今未明；唤醒任务同样可能撞上——失败计数与重试 1 次就是
  为它准备的，发现失败立即汇报（委托跟进规则）。
- **Muse 的唤醒延迟**：Muse 走外部调用方，唤醒速度取决于外部轮询间隔
  （现有 2 分钟 watch），不是引擎内直发的秒级；文档里写明，不假装实时。
