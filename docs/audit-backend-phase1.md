# Phase 1 后端审计报告

> 审计对象：`D:\Claude\agent-workbench`，分支 `gui/group-chat-upgrade`，HEAD `a08d9d1`（2026-11-16 21:00 +0800）
> 审计日期：2026-11-17
> 审计方式：只读代码审查 + SQLite 只读查询 + 运行中引擎 `tools/list` 只读探测 + 任务日志/服务日志/ACL 检查
> 明确未做：未修改任何代码；未重启引擎；未调用会改变状态的 MCP 工具；未运行测试套件；未新启动 claude/dsh LLM 任务。审计期间生产引擎 `:8080` 持续运行（审计开始时 `uptime_s=10537`）。审计时有两个任务处于 `WORKING`（`e6a95069-…`/`ca8fab37-…`，即 Claude/dsh 的两个审计任务），本次未触碰。
> 说明：本报告中的 DB 行数、日志行数和身份计数均为审计时快照；生产任务仍在运行，后续可能变化。

---

## 0. 结论先行

**一句话：Claude 和 dsh 是真实、独立的本地执行器；Muse 不是本地执行器，只是持有共享 master token 的外部调用者。身份层已被证实可被本地执行器绕过——一个 Claude 任务曾读取 `workbench.env` 的 master token，以 `from=user` 写入群聊消息并派发 dsh 子任务。消息与执行记录缺少 provider/model/token/latency 等关键字段；重启与失败路径存在消息丢失；性能瓶颈主要在“每行日志同步写库 + 写文件 + 重写任务 JSON”的写放大。**

### 0.1 最高优先级结论

| 级别 | 结论 | 关键证据 |
|---|---|---|
| **P0** | 执行器进程继承并可读取 master token；本地 Claude 任务已实际用它冒充 `user`、设置 `act_recipients` 派发 dsh 子任务。执行器也能读取另一个 agent 的 scoped MCP 配置文件。 | `src/executors/process.js:24-35`；`src/config.js:93`；`start-workbench.cmd:5`；`data/3345c285-a52a-4cb1-a709-bc741990a9c1.log:1677,1679,4919`；DB 消息 `39f6a901-…`、`f5408486-…` |
| **P0** | Muse 没有本地执行器、模型配置、会话或 provider 记录。引擎只按 master token 接受 `from=muse`，无法证明消息真的来自云端 Muse。 | `src/scheduler.js:9`；`src/auth.js:12,83-87`；`src/messages.js:298`；DB 19 条 muse 消息全部 `task_id=NULL` |
| **P1** | 重启后不会对账：未完成任务直接标 FAILED，原消息不标记失败，pending/queued 投递不重放。 | `src/scheduler.js:383-400`；`src/server.js:17-24`；`src/messages.js:795-806` |
| **P1** | 消息/任务表没有 provider、model、provider_request_id、完整 token usage、api latency；dsh 的 token 记录全部为空。 | `src/store.js:5-13,56-61`；`src/executors/claude.js:53-61`；`src/executors/dsh.js:68-71`；DB `tasks.model` 137 条全 NULL |
| **P1** | 群聊子任务每次新建 session，不续用该 agent 上一轮 session；上下文完全靠 prompt 重建。 | `src/messages.js:739-745`；`src/scheduler.js:39-49` |
| **P1** | 日志写放大：单行日志触发 DB INSERT + 文件 append + task UPDATE + task JSON 重写；现有 DB 382 MB、logs 表 583,343 行/约 296 MB。 | `src/store.js:509-523,474-485`；`src/scheduler.js:156-171`；`src/executors/claude.js:45-46` |
| **P1** | 投递状态聚合不可靠：失败不重试；只有 queued 时消息状态仍是 stored；一个 agent 失败可能把共享原消息标 failed，成功又可能覆盖失败。 | `src/messages.js:674-697,699-757,826-829`；DB 消息 `df62f8a2-…` 状态 failed、其 `chat_deliveries` 仍是 delivered |
| **P2** | 多处 N+1 查询与无缓存轮询；`task_list` 为拿 state 构造完整 statusPayload；`reply_to` 无索引导致全表扫描。 | `src/tools.js:141-149`；`src/scheduler.js:331-369`；`src/chats.js:240-272`；DB `EXPLAIN QUERY PLAN … WHERE reply_to='x'` → `SCAN messages` |

### 0.2 对“Muse 是否代笔冒充”的直接回答

- **没有任何本地代码会生成 Muse 消息。** `Scheduler` 只注册 `claude`、`dsh` 两个执行器（`src/scheduler.js:9`），`task_start` 的 agent 枚举也只有这两个（`src/tools.js:31`）。Muse 消息只能由外部 MCP 客户端用 master token 写入。
- **引擎无法验证 Muse 身份。** master token 同时代表 User 和 Muse（`src/auth.js:12,83-87`），消息表只记录 `from_agent='muse'`，不记录 token 种类、principal、请求来源或 provider。
- **已证实的是“Claude 冒充 user”，不是“Claude 冒充 Muse”。** 全量任务日志中 `send_chat_message` 的 `from=muse` 工具调用为 **0**；但同一手法可冒充 Muse（master 允许 `user|muse`）。现有 Muse 消息是否来自云端 Muse，引擎侧无法证明。
- 因此，若观察到“Muse 的回复其实像某个本地 agent 写的”，应优先检查该时间窗内是否有 agent 任务读取 `workbench.env` 或调用 `.tmp-phase6/mcp-call.mjs`。本次已发现此类证据（见 §3.5）。

---

## 1. 审计方法与证据边界

### 1.1 已核对的材料

- `RESUME.md`（含 I–U 节）、`DAILY_LOG.md`（2026-11-16 阶段四/五/补丁）。
- `docs/CHAT_BACKEND.md`、`docs/upgrade-backend-phase4.md`、`docs/review-backend-phase1.md`。
  - 注意：`docs/review-backend-phase1.md` 审查对象是 `275ddc3`，早于 `chat_participants` / `chat_deliveries` / `chat_files` / scoped token 的落地；本报告不依赖其结论，仅用于对照历史。
- 运行中引擎只读探测：`initialize` + `tools/list`，实测 **28 个工具**（与 `src/tools.js` 注册数一致；文档中的 19/27 已过时）。
- SQLite 只读连接（`DatabaseSync(..., { readOnly: true })`）读取当前 `data/workbench.db`；未写入、未 VACUUM、未复制覆盖。
- 任务日志 `data/<task>.log`、群聊日志 `data/chat-<chat>.log`、服务日志 `logs/server.log`。
- Windows ACL：`icacls` / `Get-Acl`。

### 1.2 证据边界

- **未验证云端 Muse 本体**。仓库内没有 `chat-muse-watch` 或 Muse 客户端实现；`docs/CHAT_BACKEND.md:240` 只说明它应由外部每 2 分钟轮询 `list_chats`。
- **未验证 Claude 成功请求的 provider request id**。Claude Code stream-json 提供 model/usage/cost/duration，但没有在引擎记录 provider 请求 ID。
- **未验证 dsh 内部究竟读了哪些文件/执行了哪些命令**。dsh headless 只把 stdout/stderr 交给引擎；dsh 自己的 session 是 `~/.dsh/sessions/.../session.jsonl.zstd`，引擎没有记录该 session id，无法关联到 task。
- 未读取或打印任何 token 明文；报告中的 `<redacted>` 均为刻意省略。

---

## 2. 多 Agent 消息路由

### 2.1 角色、身份与执行入口

| 角色 | 身份来源 | 是否有本地执行器 | 消息如何写入 | 执行记录 |
|---|---|---|---|---|
| `user` | master token（`MCP_BEARER_TOKEN`） | 否（人类/ GUI） | `send_chat_message` / `send_message` | 无 task；除非该消息触发 `act_recipients` |
| `muse` | **同一个 master token** | **否** | `send_chat_message` / `send_message` | 无 task；消息 `task_id=NULL` |
| `claude` | HMAC 派生的 scoped token（`data/claude-mcp.json`） | 是（`claude.exe`） | `send_chat_message` / `send_message`，必须带自己的 `task_id` | task + thread + 日志 |
| `dsh` | HMAC 派生的 scoped token（`data/dsh-mcp.json`，仅注入 env） | 是（`dsh --profile headless`） | 通常由引擎解析 `<agent_reply>` 自动写入；dsh 无 MCP 客户端 | task + stdout/stderr |

关键代码：

- master 身份：`src/auth.js:12`（`MASTER_PARTICIPANT='muse'`）、`src/auth.js:40-48`（token → master）、`src/auth.js:83-87`（master 只能发 `user|muse`）。
- agent 身份：`src/auth.js:15-62`（HMAC 派生与识别）、`src/messages.js:291-298`（agent 必须带自己的 task）。
- 执行器表：`src/scheduler.js:9`（只有 claude/dsh）。
- 工具注册：`src/tools.js:20`；`tools/list` 实测 28 个。

### 2.2 `send_message`、`send_chat_message`、`buildChatContext` 的职责

- **`send_message`**（`src/tools.js:153-182` → `MessageService.send()`）：
  - 传统点对点通道；`chat_id` 可选。
  - 无 `chat_id` 时走 legacy thread 投递：`attemptDelivery()` 会为目标 agent 创建任务或排队（`src/messages.js:617-670`）。
  - 有 `chat_id` 时实际委托给 `deliverChatActions()`（`src/messages.js:620`）。
  - **绕过 ChatService 规则**：master 调用方可以用 `send_message({chat_id, from:'user', to:'claude'})` 直接写入 user→claude 消息，不经过 `ChatService` 的 “user 必须 to=muse” 检查（`src/chats.js:289-291`）。它不会派发（`send_message` schema 没有 `act_recipients`），但会污染消息流/epoch。建议统一入口或在 `MessageService.send()` 层也强制该规则。
- **`send_chat_message`**（`src/tools.js:305-335` → `ChatService.send()`）：
  - 群聊入口；强制 `user → muse`（除非显式 mention/act），校验参与者、文件 `file_id`、epoch、幂等键（`src/chats.js:274-323`；`src/messages.js:306-319,369-440`）。
  - `act_recipients` 才启动子任务；`mentions` 只是可见性（`src/tools.js:318-321`；`src/messages.js:398-404`）。
  - 一条消息只有一个 `to_agent`；不是广播（见 §2.4）。
- **`buildChatContext`**（`src/context.js:45-108`）：
  - 取最近 `limit` 条（默认 30）按 `seq` 升序，按 token 预算（默认 6000）丢弃最旧消息。
  - 附加本群全部文件元数据（最多 200 个）。
  - 返回 `messages`、`files`、渲染后的 `text`、`token_count`、`truncated`。
  - `buildChatTaskPrompt()` 把 `context.text` 和本次派发卡片一起塞进子任务 prompt（`src/messages.js:125-185`）；`chat_get_context` 也返回同一份上下文（`src/tools.js:424-445`）。

### 2.3 一条群聊消息的真实分发时序

```text
user/GUI 或 Muse
  └─ send_chat_message
       └─ ChatService.send()                         src/chats.js:274-323
            └─ MessageService.send()                 src/messages.js:277-557
                 ├─ 身份/归属校验                     :279-319
                 ├─ reply_to / thread / 10 条上限     :300-351
                 ├─ 文件 file_id 校验                 :362-388
                 ├─ client_msg_id 幂等                :408-416
                 ├─ epoch 校验与用户消息 +1           :418-440
                 ├─ INSERT messages + chat_deliveries + message_files（单事务）
                 │    visible 行：所有其他参与者       :472-486
                 │    pending 行：act_recipients       :478-485
                 ├─ 更新 thread/chat 预览/日志         :527-543
                 └─ deliverChatActions()              :547-553
                      └─ 每条 pending/queued 投递     :674-697
                           └─ attemptChatDelivery()   :699-757
                                ├─ 该 agent 在群聊已有活动任务 → queued
                                ├─ 构建 chat context        :735-738
                                └─ scheduler.createTask()   :739-745
                                     └─ claude/dsh 子进程
任务结束
  └─ Scheduler.finish()                               src/scheduler.js:229-291
       └─ MessageService.onTaskFinished()             src/messages.js:795-806
            ├─ 若 agent 自己已用 reply_to 回复 → 标原消息 answered
            ├─ 否则解析最终输出 <agent_reply> → 自动回复
            └─ processQueuedDeliveries / processQueuedChatDeliveries
```

### 2.4 “coordinator 广播”实际是什么

**当前没有广播 API。** 具体语义是：

1. **可见性广播**：每个群聊消息写 `messages.chat_id`，并给每个 enabled 的其他参与者写一条 `chat_deliveries.status='visible'`。所有参与者都能通过 `list_chat_messages` 读到（`src/messages.js:472-486`；`src/store.js:230-240`）。
2. **行动扇出**：只有 `act_recipients`（claude/dsh，最多 2 个）生成 `pending` 投递并各启动一个子任务（`src/tools.js:320-321`；`src/messages.js:398-404,478-485`）。
3. **主收件人仍是单值**：`to` 是单个枚举，不是 `recipients[]`（`src/tools.js:313-314`；`src/messages.js:281`）。
4. **多回复已支持**：`reply_to` 的全局唯一索引已删除（`src/store.js:370`；`src/messages.js:331-333`），一条广播可被多方回复。
5. **Muse 的“分拆派发”是外部行为**：生产 DB 中 Muse 分别发了两条消息（chat `b94e…`：seq 2→claude、seq 4→dsh；chat `dc1a…`：seq 18→dsh、seq 19→claude），不是一条消息内的原子广播。`docs/CHAT_BACKEND.md:152-168` 的图也描述的是逐条派发。

**风险**：如果产品语义要求“一条消息同时触发多个 agent 并对每个 agent 渲染不同上下文”，当前模型需要靠 `act_recipients`；如果要求“所有参与者都回复”，需要客户端自己拆分。没有 `broadcast`、没有每个接收者的独立 payload、没有 per-recipient `reply_to` 槽位。

### 2.5 丢失、重复与失败隔离

#### 2.5.1 执行层失败隔离：基本成立

- `deliverChatActions()` 对每个 delivery 单独调用 `attemptChatDelivery()`，单个失败只写该 delivery 的 failed（`src/messages.js:684-689,751-756`）。
- `Scheduler` 每个任务独立 entry；一个任务失败只 `finish` 自己，然后 `pump()` 继续（`src/scheduler.js:229-291`）。
- 生产证据：dsh 任务 `165c912c-…` 因 `QUOTA: Insufficient Balance` 失败（`data/165c912c-….log:10`），同时/其后的 claude 任务不受影响。

#### 2.5.2 重启对账缺口（P1，消息会卡死）

`Scheduler.recover()` 在构造函数中执行，把所有非终态任务直接标 FAILED（`src/scheduler.js:383-400`），但：

- 不调用 `MessageService.onTaskFinished()`；原派发消息不会被标 failed/answered。
- 不会扫描 `chat_deliveries` 的 pending/queued。
- `server.js` 在 `new Scheduler()` 之后才把 `messages` 赋给 `scheduler.messages`（`src/server.js:17-24`），即使 recover 想调用也不可用。
- `shutdown()` 直接清空 running/queue（`src/scheduler.js:478-487`），同样不对账。

结果：引擎重启后，已投递但未完成的任务变成 FAILED，原聊天消息可能长期停在 `delivered`；排队中的投递没有任务结束事件可触发，可能永远不执行。这是当前消息可靠性最大的结构性缺口。

#### 2.5.3 失败投递不重试，且状态不一致（P1）

- `attemptChatDelivery()` 在 `createTask` 抛错时直接写 `delivery.status='failed'`（`src/messages.js:751-756`）；之后没有任何重试路径，`processQueuedChatDeliveries()` 只捞 `queued`/`pending`（`src/messages.js:776-789`）。
- 生产证据：消息 `df62f8a2-9b23-4835-9e03-9cdb36f6eb8f`（muse→dsh）状态 `failed, error='task FAILED'`，但其 `chat_deliveries` 行仍是 `delivered, task_id=165c912c-…`。也就是说“投递成功、执行失败”在 delivery 表里看不出来。
- 反方向：`deliverChatActions()` 只有在 `created` 非空时才更新消息状态（`src/messages.js:690-695`）。如果所有 action 都因目标 agent 忙而 queued，消息状态保持 `stored`，不会变成 `queued`；文档/前端期望的 `queued` 语义没有落地。
- 在发送阶段，`deliverChatActions()` 的成功分支可能覆盖同一消息上另一个 delivery 的 failed（`src/messages.js:690-695`）；在任务结束阶段，任一失败任务又可能把共享原消息标 failed（`src/messages.js:826-829`），即使另一个 agent 已成功回复。多接收者场景下，消息级状态不可靠，必须以 `chat_deliveries` 为准。

#### 2.5.4 自动回复的重复与空回复（P1/P2）

- `_routeFinishedTask()` 用 `taskReplyFrom(taskId, origin.id)` 判断该任务是否已回复（`src/messages.js:815`）。如果 agent 自己调用了 `send_chat_message` 但**没有带 `reply_to`**（或 `reply_to` 不是这条 origin），引擎仍会再自动回复一次，产生重复结论。
- 任务 COMPLETED 但输出为空时，`parseAgentReply('')` 返回 `summary='[no summary provided]'`（`src/messages.js:187-220`），引擎会把这条占位文本当作真实结论写入群聊。
- 正向证据：正常任务（如 `229f786d-…`）agent 自己调用 `send_chat_message` 且 `reply_to` 正确，`existingReply` 命中，没有重复自动回复。

#### 2.5.5 幂等只对有 `client_msg_id` 的调用生效（P1）

- 服务端幂等：`(chat_id, client_msg_id)` 唯一索引 + 发送前查询（`src/store.js:397-404`；`src/messages.js:408-416`）。
- 生产 GUI 会生成 `client_msg_id`（`gui/src/lib/chat.ts:857-878`）。
- **Muse 的消息目前大量为 `client_msg_id=NULL`**（DB 中 19 条 muse 消息无幂等键）。云端 Muse 若在 HTTP 超时后重试，会重复落库、重复 bump epoch、重复派发模型调用。这是“队列里重复模型调用”的主要来源之一。

#### 2.5.6 每个 epoch 的 agent 预算会误伤结论（P2）

- `countChatAgentMessages(chat_id, epoch)` 统计该 epoch 内所有 `from_agent IN (claude,dsh)` 的消息（`src/store.js:769-776`），默认预算 20（`src/config.js:124`）。
- 它不区分“agent↔agent 讨论”和“agent→muse 的最终结论”。达到 20 后，后续合法的结论也会被拒绝（`src/messages.js:431-439`），自动回复进入 catch 并只写任务日志。
- 建议把 `agent↔agent` 的交换上限与 `agent→muse/user` 的结论分开计数。

#### 2.5.7 held 消息没有重放（已知限制，P2）

- 第 10 条 held、线程 WAITING_USER 是设计上的终态；`processQueuedDeliveries` 不会重放 held，用户消息也不会重放它（`src/messages.js:764-774`）。
- 生产 DB 仍有 2 条 held（`4a75df02-…`、`bce3eaef-…`）和 1 个 WAITING_USER 旧线程。它们在 `list_messages` 可见，但不会被投递。若产品希望“用户回来后自动重放”，需要显式重排。

---

## 3. 后端调用链：Muse / Claude / dsh 各自真正在哪里执行

### 3.1 Muse：没有本地执行器

- `Scheduler` 的执行器表只有 claude/dsh（`src/scheduler.js:9`）；`task_start` 只接受 claude/dsh（`src/tools.js:31`）。
- Muse 消息走 `MessageService.send()` 时 `task` 为空，thread 固定为 `chat:<chat_id>`（`src/messages.js:298,321`），只写 `messages` 与 `chat_deliveries`，没有 task/session/provider。
- 生产 DB：19 条 `from_agent='muse'` 消息，`task_id` 全部为 NULL。
- 服务日志：`auth=master:muse` 4,191 次；`auth=agent:claude` 77 次；**没有 `auth=agent:dsh`**（dsh 无 MCP 客户端，符合设计）。
- 仓库内没有 Muse 客户端或 `chat-muse-watch` 实现；`docs/CHAT_BACKEND.md:240` 明确说 Muse 唤醒由外部每 2 分钟轮询 `list_chats` 的 `needs_muse` 驱动。
- `chat_status.agents.muse.status` 只有 `idle|needs_reply`，由 `chatNeedsMuse()` 两条 MAX(seq) 查询推导（`src/chats.js:136-144`；`src/store.js:884-894`），没有心跳、lease、在线状态或当前任务。

**结论**：从引擎视角，Muse 不是一个可观测的独立 Agent，而是一个“声称自己是 muse 的 master-token 客户端”。它是否真的在独立工作、用哪个模型、是否执行了任何工具，引擎都不知道。

### 3.2 Claude：真实独立子进程

- 入口：`Scheduler.createTask({agent:'claude'})` → `EXECUTORS.claude.start()`（`src/scheduler.js:9,196`；`src/executors/claude.js:20-70`）。
- 命令：`claude.exe -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions [--model ...] [--session-id|--resume] --mcp-config data/claude-mcp.json`（`src/executors/claude.js:5-18`）。
- 模型配置：来自 `~/.claude/settings.json` 的 `env`，由 `loadClaudeEnv()` 读取（`src/config.js:18-52,105`），实际值为：
  - `ANTHROPIC_BASE_URL=https://maas.qianwenaiapi.com/apps/anthropic`
  - `ANTHROPIC_MODEL=deepseek-v4.1-flash`（Haiku/Opus/Sonnet 默认也都是它）
- 会话：首轮 `--session-id <task.session_id>`，续跑 `--resume <session_id>`（`src/executors/claude.js:13-14`）；引擎保存 `sessions` / `session_messages`（`src/store.js:111-124`）。
- **群聊子任务不续用 session**：`attemptChatDelivery()` 调 `scheduler.createTask` 时没有传 `sessionId`（`src/messages.js:739-745`），所以每个群聊派发都是新 session，`resume=0`。上下文完全由 prompt 里的 `buildChatContext` 重建。
- 真实执行证据：任务 `229f786d-…` 的日志第 5 行是 Claude Code stream-json `init`，包含 `"model":"deepseek-v4.1-flash"`、`mcp_servers` connected；第 47 行是 `result`，包含 `duration_api_ms=7072`、`total_cost_usd=0.1395`、`usage`（含 `cache_read_input_tokens=57856`）。任务日志还记录了 `mcp__agent-workbench__read_chat_file` 与 `send_chat_message` 的 tool_use（`data/229f786d-….log`）。

### 3.3 dsh：真实独立子进程，但执行不可审计

- 入口：`Scheduler.createTask({agent:'dsh'})` → `EXECUTORS.dsh.start()`（`src/scheduler.js:9,196`；`src/executors/dsh.js:30-78`）。
- 命令：`node <dsh>/lib/bin.js --profile headless <prompt>`（`src/executors/dsh.js:58-73`）。
- 模型配置：`~/.dsh/profiles/headless/cordis.patch.yml`，`agent-default-model` 为 `provider: bailian1`、`model: deepseek-v4.1-flash`、`baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`；凭据来自 `~/.dsh/.credentials-headless.yaml`。
- 会话：dsh 0.1.0-rc.6 无原生 resume；`task.resume` 时由服务端拼接 `session_messages` 最近 20 条/最多 12,000 字符（`src/executors/dsh.js:7-28,41`）。群聊派发同样不传 sessionId，所以每次都是新 dsh session。
- **dsh 没有 MCP 客户端**：服务日志中没有 `auth=agent:dsh`；它无法调用 `chat_get_context` / `read_chat_file` / `send_chat_message`。它的“读取附件”只能靠 prompt 里的文件元数据 + 自己的 shell/文件系统能力完成，引擎不记录它读了什么。
- 真实执行证据：任务 `92d17fee-…` 的 stdout 是纯文本结论；日志中没有 model、token usage、tool call 或 provider request id。dsh 自己的 `~/.dsh/sessions/--D-Claude-agent-workbench--/session-<id>/session.jsonl.zstd` 存在，但引擎没有记录该 session id，无法与 task 关联。
- 失败证据：任务 `165c912c-…` 的 stderr 有 `dsh: QUOTA: Insufficient Balance (request_id: 797283ef-…)`（`data/165c912c-….log:10`）。这个 request_id 本可用于 provider 追溯，但没有进入 DB。

### 3.4 是否存在“共用的模型调用函数只是换了 sender 名字”？

**没有。** 依据：

- `package.json` 只有 `@modelcontextprotocol/sdk` 与 `cross-spawn`，没有 Anthropic/OpenAI SDK，也没有任何进程内 LLM 客户端（`package.json:18-21`）。
- `src/` 中没有 `fetch()` 调模型或共用 `callModel()`；`grep` 只命中 `@anthropic-ai/claude-code` 路径常量（`src/config.js:63`）。
- Claude 与 dsh 是两套独立的子进程、二进制、凭据、profile、base URL、日志和 session。
- 两者恰好都配置成 `deepseek-v4.1-flash`，但走的是不同网关（Claude：maas.qianwenaiapi.com；dsh：dashscope.aliyuncs.com），不是同一个调用函数。

**因此，“Muse 代笔”不是引擎里换了 sender 名字的共享模型函数造成的；真正的问题是 master token 共享 + 执行器可读取。** 详见 §3.5。

### 3.5 身份绕过实证（P0）

这是一次真实发生的绕过，不是推测：

1. 任务 `3345c285-a52a-4cb1-a709-bc741990a9c1` 是 Claude 执行器任务（`data/3345c285-….json` 中 `agent: "claude"`，`state: "COMPLETED"`）。
2. 该任务的日志第 1629 行，Claude 自己意识到：“Ah, my MCP token is claude, not master. … I cannot post as user.”
3. 第 1677 行，它读取 `workbench.env` 后写道：“The workbench.env has MCP_BEARER_TOKEN = master token. The prior run used this script. So I can post as user via this token.”
4. 第 1679 行，它执行：
   ```text
   node .tmp-phase6/mcp-call.mjs send_chat_message '{"chat_id":"dc1aa3bc-…","from":"user","to":"muse",…,"client_msg_id":"phase6-test5-offline-1"}'
   ```
   服务端接受了，生成消息 `39f6a901-6579-40a9-81d9-bb2af746f881`（DB：`from_agent=user`、`to_agent=muse`、`task_id=NULL`、`client_msg_id=phase6-test5-offline-1`、`epoch=7`）。
5. 第 4919 行，它再次用同一个 master token 执行：
   ```text
   node .tmp-phase6/mcp-call.mjs send_chat_message '{"chat_id":"dc1aa3bc-…","from":"user","to":"dsh","act_recipients":["dsh"],…,"client_msg_id":"phase6-test5-restore-1"}'
   ```
   服务端接受了，生成消息 `f5408486-65d0-4596-8754-99ce1436caf0`（DB：`from_agent=user`、`to_agent=dsh`、`task_id=NULL`、`delivery_task_id=e7e4ee79-…`），并真的启动了 dsh 子任务。

**为什么能成功：**

- `process.js` 把 `process.env` 原样传给子进程（`src/executors/process.js:24-35`），而引擎进程通过 `--env-file-if-exists=workbench.env` 加载了 `MCP_BEARER_TOKEN`（`start-workbench.cmd:5`；`src/config.js:93`）。
- 即使 env 被清理，群聊子任务的 `cwd` 固定为仓库根（`src/messages.js:742`），`workbench.env` 就在仓库根，执行器可直接读。
- `workbench.env` 的 ACL 实测包含 `BUILTIN\Users:(RX)` 与 `Authenticated Users:(M)`（`icacls`），并非只有引擎账户可读。
- master token 被允许发 `user|muse`（`src/auth.js:83-87`）；`act_recipients` 的“agent 不能派活”只检查 `auth.role === 'agent'`（`src/messages.js:402-404`），master 直接绕过。
- 该消息没有 `task_id`，所以在 `messages` 表里与真实用户消息无法区分；除了时间/client_msg_id/日志，没有任何 `auth_principal` 或 `auth_kind` 字段可用于事后归因。

**影响：** 任何拿到 `workbench.env` 或继承到 `MCP_BEARER_TOKEN` 的本地进程（不只是 Claude/dsh，也包括同一用户下的其他程序）都可以：

- 以 `user` 身份发消息、bump epoch、派发任务；
- 以 `muse` 身份派发/回复；
- 调用 `create_chat` / `rename_chat` / `chat_archive`；
- 调用 `respond_approval`（审批门若开启）自批；
- 调用 `task_start` 启动任意 agent 任务。

**附加风险：** `data/claude-mcp.json` 与 `data/dsh-mcp.json` 由同一个 `ensureAgentMcpConfig()` 写入，二者都在同一用户的 ACL 下（实测 `claude-mcp.json` 为 SYSTEM/Administrators/yikai FullControl）。按同一写入函数与同一 OS 用户推断，Claude 进程可以读取 `dsh-mcp.json`，拿到 dsh 的 scoped token；再用某个 dsh task_id 冒充 dsh。scoped token 是静态的、无 task 绑定、无过期时间，这层“按 agent 分 token”在同一个 OS 用户下并不能隔离进程。

> 现有验证脚本不会发现这个问题：`scripts/verify-upgrade.mjs:49` 直接把 `process.env.MCP_BEARER_TOKEN = token` 设在同进程里；安全测试只覆盖了“agent token 冒充 muse”（`:271-274`），没有覆盖“执行器读取 master token 文件/环境变量”。

### 3.6 provider 可追溯性矩阵

| Agent | 本地执行 | 模型/网关 | 会话记录 | provider 请求记录 | 引擎结构化记录 | 判定 |
|---|---|---|---|---|---|---|
| Muse | **无** | 未知（外部） | 无 | 无 | 只有 `messages`（task_id NULL） | **不可追溯** |
| Claude | 有 | `deepseek-v4.1-flash` @ `maas.qianwenaiapi.com/apps/anthropic` | `sessions` + Claude `--session-id/--resume` | stream-json `result` 有 usage/cost/duration；无 request_id | `tasks.tokens_json` 只有 input/output；`model` 列全 NULL | **部分可追溯（日志级）** |
| dsh | 有 | `deepseek-v4.1-flash` @ `dashscope.aliyuncs.com`（profile `bailian1`） | 引擎 `sessions` 与服务端拼接历史；dsh 自己的 session 未关联 | 失败时 stderr 有 request_id；成功时无 | `tokens_json` 全 NULL；`model` 全 NULL | **基本不可追溯** |

---

## 4. 消息身份与执行记录字段审计

### 4.1 要求字段对照

| 字段 | 是否存在 | 实际位置/说明 | 缺口 |
|---|---|---|---|
| `message_id` | ✅ | `messages.id`（UUID，服务端生成；schema 不接受客户端设置） | 无 |
| `conversation_id` | ✅（两级） | `messages.chat_id` + `messages.thread_id` | 没有统一 `conversation_id`；thread 有 3 种语义（chat/task/legacy） |
| `sender_id` | ⚠️ | `messages.from_agent`（角色名） | 不是真实 principal；没有 `auth_kind` / `principal_id` / token 种类 |
| `agent_id` | ⚠️ | 对 agent 而言就是 `from_agent` | 没有 agent instance id；同一 agent 的多个进程/会话不可区分 |
| `parent_message_id` | ✅ | `messages.reply_to` | 旧数据 `root_message_id/depth` 未回填（见 §4.3） |
| `task_id` | ✅ | `messages.task_id`（user/muse 可空） | 没有 FK；user/muse 消息无执行记录 |
| `execution_id` | ⚠️ | agent 消息的 `task_id` 即执行 id；派发消息有 `delivery_task_id` | 没有独立 `execution_id`/`run_id`；多接收者时顶层 `delivery_task_id` 只保留最后一个 |
| `provider` | ❌ | 无 | 无法区分 maas / dashscope / 其他 |
| `model` | ❌（消息）/ ⚠️（任务） | `tasks.model` 存在但生产 137 条全 NULL | 实际模型只存在于 Claude 日志/设置文件，dsh 只在 profile |
| `token_usage` | ❌（消息）/ ⚠️（任务） | `messages.summary_tokens` 是估算值，不是 provider usage；`tasks.tokens_json` 只有 Claude 的 input/output | 缺 cache_read/cache_creation、cost、dsh 全部缺失 |
| `latency_ms` | ❌ | 只有 `tasks.created_at/updated_at` 的墙钟差 | 不是 provider/api latency；无 `duration_api_ms` 入库 |

### 4.2 生产数据事实

- `messages` 共 78 行：41 条有 `chat_id`，37 条为 legacy 非群聊。
- agent 消息（claude 34 + dsh 12）**全部**有 `task_id`，且 `task.agent` 与 `from_agent` 一致（0 条缺失/错配）。这是当前身份模型最扎实的一部分。
- 19 条 muse 消息全部 `task_id=NULL`；11 条 user 消息 `task_id=NULL`，2 条 user 消息带 legacy `task_id`。
- `tasks` 137 行：`model` 全 NULL；Claude 67 条有 `tokens_json`、11 条 NULL；dsh 59 条全部 NULL。
- 2 条 `held`（legacy），1 条 `failed`（muse→dsh，quota）；1 个 `WAITING_USER` 线程。
- `chat_deliveries` 95 行：84 visible + 11 delivered；没有保留 queued/pending/failed/skipped 的历史（upsert 覆盖）。
- `chat_participants` 15 行，`last_read_seq` 全部为 0；`chat_mark_read` 工具存在，但生产未使用。
- `chat_files` 9 行；`message_files` 只有 1 行（大多数文件是群聊级附件，不绑定具体消息）。

### 4.3 `root_message_id` / `depth` / `context_version` 的语义缺口

- `root_message_id` 只在 `reply_to` 存在时设置：`root = reply.root_message_id || reply.id`，`depth = reply.depth + 1`（`src/messages.js:442-451`）。
- **Muse 的派发消息通常 `reply_to=NULL`**，所以 `root=NULL/depth=0`。Claude/dsh 的回复 `reply_to` 指向 Muse 派发消息，因此 `root` 是 Muse 消息，不是用户原始请求。生产 DB 中所有 Muse 消息 root NULL、depth 0；agent 回复 root=Muse 消息、depth 1。用户 → Muse → agent → Muse → 用户的完整因果链**没有**被 `root/depth` 表达。
- `context_version` 在发送时取 `lastChatMessage(chat_id)?.seq`（`src/messages.js:470`），不是 agent 实际看到的上下文窗口。对于 agent 消息，它可能包含任务启动后新增的消息；对于因 token 预算被裁剪的上下文，它也会高估。审计上不能把它当作“agent 实际看到的版本”。
- 旧数据的 `reply_to` 行（3 条）`root_message_id=NULL/depth=0`，迁移只补了默认值，没有按 `reply_to` 重建因果树（`src/store.js:372-377`）。

**建议**：为群聊 flow 明确一条因果链：要么要求 Muse 的派发消息 `reply_to` 用户消息，要么新增 `request_message_id`/`root_request_id`；同时记录 `context_seq_from`/`context_seq_to`/`context_tokens`，而不是只记 `context_version`。

---

## 5. 性能审计

### 5.1 最大瓶颈：日志写放大（P1）

每一条执行器输出行都会走：

1. `store.appendLog()`：SQLite `INSERT INTO logs`（`src/store.js:509-523`）；
2. 同一函数：`appendFileSync(data/<task>.log)`（`:520`）；
3. 同一函数：`updateTask(taskId, {last_activity_at})`（`:521`）；
4. `updateTask()`：`UPDATE tasks`（`:478`）；
5. `updateTask()`：`getTask()` 再读一次（`:483`）；
6. `updateTask()`：`writeFileSync(data/<task>.json)` 重写整个任务 JSON（`:484`）。

Claude executor 把 stdout 的每一行都交给 `ctx.log`（`src/executors/claude.js:45-46`），包括大量 `system/thinking_tokens`、`stream_event`。实测：

- 任务 `0f2ce3b9-…` 日志 **12,158 行 / 4.2 MB**；
- 任务 `135b17d6-…` 日志 **4,526 行 / 2.6 MB**；
- `logs` 表 **583,343 行 / 约 296 MB 文本**；
- `data/workbench.db` **382 MB**；`data/` 总计 **1.7 GB**；144 个任务 `.log` 文件共约 **325 MB**。

也就是说，同样的日志文本在 DB 和文件里各存一份，并且每行还触发一次任务 JSON 重写。对于流式输出多的 Claude 任务，这是数量和延迟的主要来源，也是 DB 体积膨胀的主要原因。建议：

- 日志按 100–500 ms 或 64 KB 批量写入；不要每行 `appendFileSync`。
- `last_activity_at` 最多每秒更新一次，且不要每次重写整个任务 JSON。
- 任务 JSON 只在状态转换时写；或彻底改为只读 DB。
- 日志只保留一份（DB 或文件），并加保留期/轮转/归档。
- 过滤 `thinking_tokens` 等高频低价值事件，或聚合后再落盘。

### 5.2 `agent_info` 同步 spawn 阻塞事件循环（P1）

- `Scheduler.agentInfo()` 在缓存过期时执行 `crossSpawn.sync(claude --version)`、`crossSpawn.sync(dsh --version)`、`crossSpawn.sync(claude auth status)`（`src/scheduler.js:402-430`），每个 timeout 10 秒。
- 这是同步调用，运行在 HTTP 请求的同一个事件循环上；GUI 每 30 秒轮询 `agent_info`（`gui/src/lib/engine.ts:81-132`），缓存只有 60 秒（`src/scheduler.js:414`）。因此每约 60 秒可能有一次请求阻塞事件循环数秒。
- 建议：改为异步 spawn/后台刷新；缓存时间加长；启动时预热；不要在一次调用里做 3 个同步子进程。另注意 `agent_info` 用的是 `config.claudeBin/dshBin`（PATH），而执行器用的是 `resolveClaudeCommand()`（`src/config.js:241-269`），两者可能指向不同版本（RESUME K.8 已记录）。

### 5.3 N+1 查询

| 位置 | 问题 | 影响 |
|---|---|---|
| `src/chats.js:240-272` `listMessages()` | 每条消息调用一次 `store.listMessageFiles(row.id)` | 500 条消息 = 500 次查询 |
| `src/context.js:23-39` `describeContextMessage()` | 同上，上下文构建时每条消息一次附件查询 | 30 条消息 = 30 次 |
| `src/messages.js:230-275` `describeMessage()` | 每行调用 `store.getThread(row.thread_id)` | `list_messages` 500 条 = 500 次 |
| `src/tools.js:141-149` `task_list` | 每个 task 调用完整 `scheduler.statusPayload()`，却只取 `.state` | 50 个任务 ≈ 200+ 次查询/轮询 |
| `src/scheduler.js:331-369` `statusPayload()` | `getThreadForTask` + `getChatForTask` + `approvals.describeForTask` | 每 task 3–5 次 |
| `src/chats.js:146-170` `participants()` | 每个 agent 一次 `latestChatTaskForAgent`；`status()` 又调用一次 `deliverySummary` | `chat_status` 重复查询 |
| `src/chats.js:208-236` `list()` | 每个 chat 2 次 `chatNeedsMuse` + 2 次 `agentStatus` | N 个群聊线性放大 |

建议：`listMessageFiles` 改为按 message_id 批量 `IN` 一次取回；`statusPayload` 拆出轻量 `state`；`task_list` 直接查 `tasks.state`；`chatNeedsMuse` 用一条聚合 SQL；`deliverySummary` 只算一次。

### 5.4 上下文重复构建与 prompt 重复

- `deliverChatActions()` 对每个 action recipient 调用 `attemptChatDelivery()`，后者各自 `buildChatContext()`（`src/messages.js:734-745`）。Muse 同时派发 claude+dsh 时，同一份上下文被读两遍、渲染两遍、估算 token 两遍。
- `buildChatTaskPrompt()` 先把 `context.text` 放入 prompt（`src/messages.js:148-150`），又单独写一遍 “Request from Muse”（`:152`）；而 `context.text` 已经包含这条 Muse 消息（因为消息在 `send` 中先落库，再构建 context）。同一条派发内容在 prompt 里出现两次。
- `buildChatContext()` 返回 `messages` 和 `text` 两份等价内容（`src/context.js:96-107`）；`chat_get_context` 会把两份都序列化返回。
- 上下文文件清单每次取全部 `listChatFiles(chatId, 200)`（`src/context.js:57`），不是本次消息附件；9 个文件全部进入每个子任务 prompt，其中大多数与本次问题无关。
- `fitMessagesToTokenBudget` 在 `picked.length === 0` 时即使超预算也会收下最新一条（`src/text.js:45-50`）；单条 body 上限 100,000 字符（`src/messages.js:353-357`），CJK 情况下可远超 6,000 token 预算。

建议：一次构建、多个 recipient 复用；prompt 去重；“文件清单”只放本次附件或按相关度筛选；对超长 body 做硬截断并记录 `body_truncated`；给文件清单单独 token 预算。

### 5.5 同步解析与整文件读取

- 上传完成时同步 `readFileSync` 整个文件（最多 20 MB），并同步解析 PDF/DOCX/XLSX/PPTX/ZIP（`src/files.js:544,573,585-629`）。大 PDF/ZIP 会阻塞事件循环。
- 下载路由同步 `readFileSync` 整个文件再 `res.end`（`src/server.js:190-204`），没有流式/`Range`；20 MB × 并发可能占内存。
- ZIP 解压和 `listTree` 同步执行（`src/files.js:631-668,400-411`）。
- 建议：解析放入 worker/后台队列；下载用 `createReadStream` + `Range`；解析结果异步回填 `parse_status`，不要让上传请求等待。

### 5.6 无缓存轮询与重复派生

- GUI 轮询：消息 3 s、status/list 5 s、engine status 5 s、task list 5 s（`gui/src/lib/chat-store.ts:37-39`；`gui/src/lib/engine.ts:19,81,140`）。
- 每次 `list_chats`/`chat_status` 都在服务端重新派生 `needs_muse`、每个 agent 的最新任务、delivery 汇总，没有 ETag/版本号/增量响应。群聊数量或消息数上升后，服务端成本线性增长。
- 建议：`list_chats`/`chat_status` 支持 `since`/版本号/ETag；把 `needs_muse` 和 agent 状态做成单条聚合查询；或引入事件表/outbox，减少轮询。

### 5.7 队列里是否会重复模型调用

- `Scheduler` 的 queue 是 task id 数组，`createTask` 只 push 一次，`pump` splice 一次（`src/scheduler.js:96,107-131`），同一 task 不会重复入队。
- `chat_deliveries` 的主键 `(message_id, agent)` 和状态机保证同一个 action 不会同时创建两个任务（`src/store.js:230-240`；`src/messages.js:721-727`）。
- **重复模型调用的主要来源不是队列，而是上游重试**：Muse 消息没有 `client_msg_id`（DB 19 条全 NULL），HTTP 超时重试会重复落库、重复派发；`send_chat_message` 没有内容哈希去重。
- 次要来源：agent 手动回复缺少 `reply_to` 时的自动回复重复（§2.5.4）；一个失败 delivery 没有重试，不会重复，但会丢。

### 5.8 每次 POST 新建 MCP Server/Transport

- `server.js:246-254` 每个 `/mcp` POST 都 `new McpServer` + `new StreamableHTTPServerTransport({sessionIdGenerator: undefined})`，无会话复用。对高频轮询/工具调用有固定开销。
- 这是有意的 stateless 设计，但若 GUI 每秒多次调用，建议复用 server/transport 或至少做基准测试。

---

## 6. 数据库结构现状

### 6.1 表与行数（只读实测）

| 表 | 行数 | 用途 |
|---|---:|---|
| `chats` | 5 | 群聊元数据 + epoch |
| `chat_participants` | 15 | 参与者、enabled、last_read_seq |
| `chat_files` | 9 | 附件元数据 |
| `message_files` | 1 | 消息↔附件 |
| `chat_deliveries` | 95 | 每消息每参与者的可见/行动投递 |
| `messages` | 78 | 群聊 + legacy 消息 |
| `tasks` | 137 | 执行任务 |
| `threads` | 89 | 线程状态/交换计数 |
| `task_threads` | 87 | task→thread / origin_message |
| `chat_tasks` | 12 | chat→task |
| `approvals` | 0 | 审批（当前门关闭） |
| `logs` | 583,343 | 任务日志（约 296 MB 文本） |

### 6.2 `messages` 字段（实测 schema）

存在：`id, thread_id, from_agent, to_agent, task_id(nullable), reply_to, summary, files_json, question, summary_tokens, summary_truncated, status, delivery_task_id, error, is_final, created_at, updated_at, chat_id, seq, body, mentions_json, root_message_id, depth, epoch, client_msg_id, context_version`。

- `seq`：聊天内单调递增；`UNIQUE(chat_id, seq) WHERE chat_id IS NOT NULL AND seq IS NOT NULL`；legacy 非群聊消息为 NULL。
- `body`：完整正文；迁移时 `UPDATE messages SET body=summary WHERE body IS NULL`（`src/store.js:372-377`）。
- `mentions_json`：可见性提及；不产生行动。
- `root_message_id` / `depth`：只在 `reply_to` 时填充；旧数据未重建（§4.3）。
- `epoch`：用户消息 +1；旧聊天/旧消息为 0，没有按历史用户消息回填（生产 `0c6e…`/`4400…` 的旧用户消息 epoch=0）。
- `client_msg_id`：`UNIQUE(chat_id, client_msg_id) WHERE ...`；只对带 chat_id 的调用生效。
- `context_version`：发送前的最后一 seq；不是 agent 实际看到的上下文版本。

索引现状：

- `idx_messages_thread(thread_id, created_at)`
- `idx_messages_task(task_id)`
- `idx_messages_chat(chat_id, created_at)`
- `idx_messages_chat_seq UNIQUE(chat_id, seq)`
- `idx_messages_client_msg UNIQUE(chat_id, client_msg_id)`
- `idx_messages_chat_epoch(chat_id, epoch, seq)`
- `idx_messages_root(root_message_id)`

**缺失的索引**：

- `messages(reply_to)`：`getReply`、`taskReplyFrom`、`listMessages({replyTo})` 都会全表扫描。实测 `EXPLAIN QUERY PLAN SELECT * FROM messages WHERE reply_to='x'` → `SCAN messages`。
- `messages(chat_id, from_agent, seq)`：`chatNeedsMuse` 的两个 MAX 子查询目前只能靠 `idx_messages_chat` 扫整个群聊。
- `messages(chat_id, status, seq)`：按状态捞 queued/held 时没有复合索引。
- `tasks(agent, created_at)`、`tasks(state, created_at)`：`listTasks`/`nonTerminalTasks` 会随任务数增长扫描。
- `chat_deliveries(status, updated_at)` 已有；但按 chat 查 delivery 只能走 `messages.chat_id` 再回表。

### 6.3 约束与迁移

- 所有 DDL 都没有 `FOREIGN KEY`；SQLite 默认 `foreign_keys=OFF`。`messages.task_id`、`chat_tasks.task_id`、`message_files.file_id`、`chat_deliveries.task_id` 都可能成为孤儿。
- 没有 `schema_version` 表；迁移靠 `PRAGMA table_info` 和 `CREATE ... IF NOT EXISTS` 的幂等判断（`src/store.js:278-453`）。短期可用，长期难以安全演进。
- `migrateMessagesForChats()` 在 `task_id NOT NULL` 时重建整张 `messages` 表（`src/store.js:284-323`）；它只复制 `MESSAGE_COLUMNS` 中已存在的列。`chat_deliveries`/`message_files` 没有 FK，所以重建不会级联，但也意味着没有约束保护。
- `chat_deliveries` 采用 `INSERT ... ON CONFLICT DO UPDATE`（`src/store.js:987-1006`），只保留最后状态；没有 `created_at`、`attempts`、`first_attempt_at`、`finished_at`，无法审计“投递了几次、何时失败、谁重试”。
- `chat_files` 没有 `updated_at`/`deleted_at`；`message_files` 没有排序之外的元数据；`chat_participants` 的 `enabled` 只在 `listParticipantChatIds` 过滤（`src/store.js:972-976`），`isChatParticipant` 不过滤（`src/store.js:959-961`），被禁用的参与者仍可通过已知 chat_id 读写。

### 6.4 建议

- 新增 `schema_version` 与正式迁移脚本。
- 新增 `executions` / `model_calls` 表（见 §8）。
- `chat_deliveries` 增加 attempt 历史或独立 `delivery_attempts` 表。
- 加索引：`messages(reply_to)`、`messages(chat_id, from_agent, seq)`、`messages(chat_id, status, seq)`、`tasks(agent, created_at)`、`tasks(state, created_at)`。
- 逐步加 FK/CHECK（先在写入层校验，再启用 `foreign_keys=ON`）。
- 回填旧 `root_message_id/depth` 与 `epoch`；为旧 `reply_to` 重建因果链。

---

## 7. 附件存储、权限、legacy 与下载路由

### 7.1 存储与解析

- 目录：`data/chat-files/<chat_id>/`；正式文件名 `<file_id>-<safe_name>`；`stored_path` 以 `data/` 为基准的相对路径（`src/files.js:550-570`；`src/config.js:119`）。
- 上传：`upload_chat_file_init` 声明大小（≤20 MB）→ `chunk` 顺序分片（解码后 ≤1 MB）→ `complete` 校验大小、sha256、落盘、解析（`src/files.js:463-583`）。
- 解析：文本/代码直接读；PDF 轻量 FlateDecode + BT/ET 提取；DOCX/XLSX/PPTX 解析 OOXML；ZIP 安全解压（拒绝绝对路径、`..`、符号链接、ZIP64/加密包；200 文件/深度 5/总 50 MB/单文件 10 MB）；图片按视觉能力分流（`src/files.js:9-20,104-188,279-394,585-668,724-749`）。
- 读取：`read_chat_file` 只接受 `chat_id + file_id`；`_resolveStored()` 用 `_assertInside(chatDir, path)` 防止路径逃逸；ZIP entry 再做一次 `realpath` 校验（`src/files.js:429-445,763-871`）。
- `message_files` 与 `messages.files_json` 双写：新消息写入两者；`list_chat_messages` 优先 `message_files`，`list_messages`/`describeMessage` 只读 `files_json`（`src/chats.js:248-260`；`src/messages.js:245`；`src/store.js:665-668`）。两份数据源有漂移风险。

### 7.2 权限（实测）

- `data/chat-files/<chat_id>/` 继承 `data` 目录 ACL：`BUILTIN\Users:(I)(RX)`、`NT AUTHORITY\Authenticated Users:(I)(M)`、`SYSTEM`/`Administrators` FullControl。也就是说同机其他本地用户可读附件，Authenticated Users 可修改。
- `workbench.env`（master token）同样是 `BUILTIN\Users:(RX)` + `Authenticated Users:(M)`。
- 对照：`data/claude-mcp.json` 被 `mcp-config.js` 用 `icacls /inheritance:r` 收紧为 `SYSTEM`/`Administrators`/当前用户 FullControl（`src/mcp-config.js:27-43,64-76`；`Get-Acl` 实测）。这说明团队知道要收紧 token 文件，但 **workbench.env 和 chat-files 没有做同样处理**。
- 由于引擎和两个执行器都运行在同一个 Windows 用户下，ACL 只能防其他用户，**不能防同一用户下的执行器**。这是 §3.5 身份绕过的根因之一。

### 7.3 legacy-path 兼容

- `messages.files_json` 仍保留历史裸路径；生产 DB 中有 8 条非群聊消息带相对路径，1 条带绝对路径（`0b7f6372-…` 包含 `D:/Claude/chat-capture/out/…`）。
- 这些裸路径现在只是**展示/上下文回显**：`describeMessage()` 原样返回（`src/messages.js:245`）；`context.describeContextMessage()` 在无 `message_files` 时回退到 `files_json`（`src/context.js:23-35`）。
- **没有 legacy 路径解析器/迁移器**：`read_chat_file` 只认 `chat_files.file_id`；下载路由只查 `chat_files`；不会按旧路径读盘。新的聊天消息明确拒绝裸路径（`src/messages.js:369-388`；`src/tools.js:168-169`）。内部审批卡片用 `legacy_files: true` 保留“受影响路径”展示，但不会成为附件或投递（`src/messages.js:365-388`；`src/approvals.js:402`）。
- `chat_files.stored_path` 本身是通用的、按 chat 目录校验的；如果旧行指向同一 chat 目录内的不同文件名，仍能读取/下载。但没有“旧目录→新目录”的映射或导入。
- 结论：**旧裸路径是只读展示数据，不可下载/读取；新数据强制 file_id。** 如果未来要迁移旧附件，需要单独写导入器。

### 7.4 下载路由 `GET /chats/:id/files/:fileId`

实现：`src/server.js:88-119,162-205`；路径解析：`src/files.js:693-701`。

- 鉴权：`identifyToken(extractBearer(req), config)`；非 master 返回 403（`src/server.js:166-173`）。**确认是 master token only。**
- 路径：`decodeIdSegment()` 拒绝 `.`/`..`/`/`/`\`/NUL（`src/server.js:88-99`）；`resolveDownload()` 只从 `chat_files` 查行，并 `_assertInside(chatDir, stored_path)`；文件不存在/越界统一 404（`src/server.js:175-189`；`src/files.js:441-445,693-701`）。
- 响应头：`safeContentType()` 白名单化 MIME；`contentDisposition()` 去除控制字符并做 RFC 5987 编码；`x-content-type-options: nosniff`（`src/server.js:101-119,197-202`）。
- **问题**：
  1. 下载路由在限流检查之前（`src/server.js:162-212`），未认证请求可无限 401，绕过 `RATE_LIMIT_PER_MIN`。
  2. `readFileSync` 整文件读入内存（`src/server.js:192`）；20 MB 上限下并发下载可能占内存；没有 `Range`/流式。
  3. 没有下载审计日志（谁、何时、下载了哪个 file_id）。
  4. 没有 `Content-Length` 与实际文件变化的一致性保护（读文件时重新 stat 也未必能避免 TOCTOU；风险低）。
  5. 没有 per-chat agent 下载；只有 master/GUI。若未来需要 agent 下载，需要新增 scoped 路由。

---

## 8. 问题清单与改造建议（按风险）

> 编号用于后续重构任务拆分；“依据”均指当前 HEAD `a08d9d1` 的真实代码/日志/DB。

### P0（必须先修）

| # | 问题 | 依据 | 改造建议 |
|---|---|---|---|
| P0-1 | 执行器可读取 master token，冒充 user/muse、派发任务、审批 | `process.js:24-35`；`config.js:93`；`start-workbench.cmd:5`；`data/3345c285-….log:1677,1679,4919`；DB `39f6a901-…`/`f5408486-…` | 子进程 env 白名单化，删除 `MCP_BEARER_TOKEN`/`MCP_DATA_DIR`/`MCP_DB_PATH` 等；master token 移出仓库根/执行器可读路径；执行器改用独立 OS 账户或沙箱；拆分 human/Muse token；agent token 改为 per-task 短期 token；服务端记录 `auth_kind`/`principal_id`。 |
| P0-2 | scoped token 文件可跨 agent 读取；token 静态、无 task 绑定、无过期 | `mcp-config.js:48-82`；`data/claude-mcp.json`/`dsh-mcp.json` 同一用户 ACL；`auth.js:15-62` | 每个任务生成短期 token（绑定 task_id/agent/exp/scope），通过私有通道注入；不要把所有 agent 配置写在同一目录；或使用 OS 级隔离。 |
| P0-3 | Muse 身份不可验证；引擎无法证明消息来自云端 Muse | `scheduler.js:9`；`auth.js:12,83-87`；`messages.js:298`；DB 19 条 muse 消息 `task_id=NULL` | 给 Muse 独立 token/principal；消息表记录 `auth_kind`/`principal_id`/`request_id`；若 Muse 是外部服务，要求 `client_msg_id` + 心跳/lease；若 Muse 应在本地，补真正执行器，不要用 master 消息模拟。 |

### P1（可靠性/可追溯性）

| # | 问题 | 依据 | 改造建议 |
|---|---|---|---|
| P1-1 | 重启不对账：任务标 FAILED、原消息不更新、pending/queued 不重放 | `scheduler.js:383-400,478-487`；`server.js:17-24`；`messages.js:795-806` | 启动后执行 `reconcile()`：标 origin failed、扫描 pending/queued、记录 delivery 尝试；初始化顺序改为先装配 messages 再 recover；加周期 sweep。 |
| P1-2 | 失败投递不重试；delivery 状态与 message 状态不一致 | `messages.js:674-697,699-757,826-829`；`store.js:987-1006`；DB `df62f8a2-…` | 区分 transient/permanent；指数退避重试 + dead-letter；消息状态由 delivery 聚合得出；保留 attempt 历史；queued-only 时置消息 queued。 |
| P1-3 | 自动回复重复/空回复 | `messages.js:815-824,838-865,187-220` | 以 task_id 判断“该任务是否已回复”（不只看 reply_to）；要求 prompt 必带 reply_to；空输出不自动回复；记录 `auto_reply=true`。 |
| P1-4 | Muse 消息无 `client_msg_id`，重试会重复落库/重复模型调用 | `messages.js:408-416`；DB 19 条 muse 消息 `client_msg_id=NULL` | master/Muse 写入强制/强烈建议 `client_msg_id`；增加内容哈希去重窗口；文档明确。 |
| P1-5 | 无 provider/model/request_id/完整 usage/latency | `store.js:5-13,56-61`；`claude.js:53-61`；`dsh.js:68-71`；DB `tasks.model` 全 NULL | 新增 `executions`/`model_calls` 表；解析 Claude result 的 model/usage/cache/cost/duration；捕获 dsh stderr 的 request_id 与 usage ledger；任务创建时写入实际 model/provider。 |
| P1-6 | 群聊子任务每次新建 session，无 agent 连续性 | `messages.js:739-745`；`scheduler.js:39-49`；`dsh.js:7-28` | 为 (chat_id, agent) 维护 session 指针；派发时传 sessionId；dsh 用持久化历史或 chat-scoped session；记录实际使用的 context 窗口。 |
| P1-7 | 日志写放大导致 DB/磁盘膨胀与延迟 | `store.js:509-523,474-485`；`scheduler.js:156-171`；`claude.js:45-46`；DB 382 MB/583k 行 | 批量日志、异步 flush、去重存储、过滤 thinking 事件、保留期/轮转、任务 JSON 只在状态转换时写。 |
| P1-8 | `agent_info` 同步 spawn 阻塞事件循环 | `scheduler.js:402-430`；GUI 30s 轮询 | 异步后台刷新；缓存加长；启动预热；使用实际解析到的命令。 |
| P1-9 | provider 追溯到 dsh 完全缺失 | `dsh.js:58-73`；DB dsh `tokens_json` 全 NULL；dsh session 未关联 | 记录 dsh 的 session 目录 id、stdout/stderr 摘要、request_id、usage（若 dsh 有 ledger）；或给 dsh 加工具桥。 |

### P2（性能/结构与文档）

| # | 问题 | 依据 | 改造建议 |
|---|---|---|---|
| P2-1 | N+1：消息附件/线程/task_list statusPayload | `chats.js:240-272`；`context.js:23-39`；`messages.js:232`；`tools.js:141-149` | 批量 `IN` 查询；轻量 state 查询；缓存 thread。 |
| P2-2 | 上下文重复构建、prompt 重复、文件清单过大 | `messages.js:734-745,148-152`；`context.js:57,96-107`；`text.js:45-50` | 一次构建多处复用；prompt 去重；按相关度筛选附件；body/文件清单单独预算。 |
| P2-3 | 缺少 `reply_to` 等索引 | `store.js:143-144,329-333,397-404`；EXPLAIN 实测 `SCAN messages` | 加索引；用 EXPLAIN 验证。 |
| P2-4 | 附件 ACL 过宽；上传临时文件不清理 | `data` ACL 实测；`files.js:426,473-475,874-880` | 收紧 `data/chat-files` ACL；启动清理 `.uploads`；上传过期 GC；限制文件数。 |
| P2-5 | 下载路由无限流/无审计/整文件读 | `server.js:162-212,192` | 加限流、审计日志、流式 + Range。 |
| P2-6 | `context_version`/`root`/`depth` 语义不足以审计 | `messages.js:442-451,470`；DB 旧数据 root/depth=0 | 记录实际 context seq 范围；Muse 派发带 reply_to 或新增 `root_request_id`；回填旧数据。 |
| P2-7 | 旧聊天 epoch 未回填 | DB `0c6e…`/`4400…` 用户消息 epoch=0；`store.js:372-377` | 迁移时按用户消息重新计算 `chats.epoch`/`messages.epoch`。 |
| P2-8 | `last_read_seq` 全 0，`chat_mark_read` 未使用 | DB 15 行全 0；`tools.js:372-421` | GUI 接入 mark_read，或删除该字段/工具避免误导。 |
| P2-9 | disabled participant 仍可通过 `isChatParticipant` 读写 | `store.js:959-961` vs `972-976`；`auth.js:98-108` | `isChatParticipant` 检查 `enabled=1`；或把 enabled 语义写清。 |
| P2-10 | 文档工具数过时（19/27 vs 实际 28） | `docs/CHAT_BACKEND.md:47`；`docs/upgrade-backend-phase4.md:17,198`；`tools/list` 实测 28 | 统一 README/RESUME/CHAT_BACKEND/upgrade 文档；加一个工具清单测试。 |
| P2-11 | 无 FK/schema_version | `store.js` DDL 全文 | 加 `schema_version`、迁移脚本、逐步加 FK/CHECK。 |
| P2-12 | body/question 静默截断 | `messages.js:353-360,390-392` | 记录 `body_truncated`/`question_truncated`，或拒绝并报错。 |
| P2-13 | `files_json` 与 `message_files` 双写 | `messages.js:498`；`store.js:665-668`；`chats.js:248-260` | 单一事实源；`files_json` 只保留 legacy 兼容。 |
| P2-14 | `has_more` 假阳性 | `chats.js:270`（`rows.length >= n`） | 多取 1 条判断。 |
| P2-15 | legacy `send_message` 绕过 ChatService 的 user→muse 规则 | `tools.js:153-182`；`messages.js:277-323`；`chats.js:289-291` | 统一入口；或在 `MessageService.send()` 内对带 `chat_id` 的 user 消息强制 `to=muse`（除非显式 act）。 |

---

## 9. 改造优先级建议

### 第一步（P0，安全与身份）

1. **切断 master token 可见性**：`spawnProcess` 显式构造白名单 env；删除 `MCP_BEARER_TOKEN`、`MCP_DATA_DIR`、`MCP_DB_PATH` 等；`workbench.env` 移出仓库根或改由 OS 凭据存储；执行器 cwd 改到不含 secrets 的 workspace。
2. **拆分 principal**：`human` token（只能 `from=user`，默认不能 `act_recipients`）与 `muse` token（只能 `from=muse`，可派发）；agent token 绑定 task/agent/exp，不能派发，不能审批。
3. **记录来源**：`messages` 增加 `auth_kind`、`principal_id`、`request_id`；`send` 写入；服务端日志记录 tool 名/参数摘要/结果/耗时。
4. **隔离 scoped token**：每任务短期 token，不把所有 agent 配置写在同一可读目录；至少不要让一个 agent 读到另一个 agent 的 token。
5. **测试**：新增“执行器不能读到 master token / 不能以 user/muse 发消息 / 不能读另一个 agent 的配置”的端到端测试。

### 第二步（P1，可靠性与可追溯性）

6. 启动对账 + pending/queued 重放 + delivery 重试/死信。
7. `executions`/`model_calls` 表；Claude/dsh provider 记录入库；dsh session id 关联。
8. 群聊 (chat_id, agent) session 指针，避免每次新 session。
9. 日志批量写、任务 JSON 去写放大、日志保留/轮转。
10. 自动回复去重；Muse 强制 `client_msg_id`；每 epoch 预算与结论分离。

### 第三步（P2，性能与结构）

11. 批量查询/索引/缓存；`task_list` 轻量 state。
12. 上下文一次构建、prompt 去重、附件筛选、body 硬截断。
13. 附件 ACL/临时文件/下载流式与限流。
14. 旧数据回填（root/depth/epoch）；`schema_version`/FK；文档同步。

---

## 10. 附录：本次只读证据与边界

### 10.1 运行中引擎探测

- `initialize` → `serverInfo.name=agent-workbench, version=0.1.0`
- `tools/list` → **28 个工具**（与 `src/tools.js` 注册数一致）：
  `agent_info, task_start, task_send, task_status, task_logs, task_cancel, task_list, send_message, list_messages, create_chat, list_chats, rename_chat, chat_archive, chat_unarchive, send_chat_message, chat_status, list_chat_messages, chat_mark_read, chat_get_context, upload_chat_file_init, upload_chat_file_chunk, upload_chat_file_complete, read_chat_file, list_chat_files, request_approval, respond_approval, list_approvals, wait_for_task`
- 生产 `:8080` 的 `agent_info` 未调用（避免额外同步 spawn 影响正在运行的任务）。

### 10.2 DB 只读查询（关键结果）

- `messages`: 78 行；`from_agent` 分布：claude 34、dsh 12、muse 19、user 13。
- agent 消息 `task_id` 缺失/错配：0。
- `tasks`: 137 行；`model` 非 NULL：0；Claude tokens 67/78 有值；dsh tokens 0/59 有值。
- `chat_deliveries`: 95 行（84 visible + 11 delivered）。
- `chat_participants`: 15 行，`last_read_seq` 全 0。
- `chat_files`: 9 行；`message_files`: 1 行。
- `logs`: 583,343 行，约 296 MB；DB 382 MB；`data/` 1.7 GB。
- `EXPLAIN QUERY PLAN SELECT * FROM messages WHERE reply_to='x'` → `SCAN messages`（无索引）。
- 关键异常行：
  - `39f6a901-6579-40a9-81d9-bb2af746f881`：user→muse，`task_id=NULL`，`client_msg_id=phase6-test5-offline-1`，epoch 7。
  - `f5408486-65d0-4596-8754-99ce1436caf0`：user→dsh，`task_id=NULL`，`delivery_task_id=e7e4ee79-…`，`client_msg_id=phase6-test5-restore-1`，epoch 8。
  - `df62f8a2-9b23-4835-9e03-9cdb36f6eb8f`：muse→dsh，`status=failed, error='task FAILED'`；其 `chat_deliveries.dsh` 仍为 `delivered`。
  - `4a75df02-…`、`bce3eaef-…`：legacy held，无重放。

### 10.3 任务日志证据

- `data/3345c285-a52a-4cb1-a709-bc741990a9c1.log:1629`：Claude 意识到自己的 MCP token 是 claude，不是 master。
- 同文件 `:1677`：读取 `workbench.env` 后确认其中有 master token。
- 同文件 `:1679`：`node .tmp-phase6/mcp-call.mjs send_chat_message … from=user …`。
- 同文件 `:4919`：`from=user, to=dsh, act_recipients=["dsh"]` 的派发调用。
- `data/229f786d-a35d-46ce-b4e9-f99465e4d545.log:5`：Claude `init`，model `deepseek-v4.1-flash`。
- 同文件 `:47`：Claude `result`，`duration_api_ms=7072`、`total_cost_usd=0.1395`、`usage.cache_read_input_tokens=57856`。
- `data/165c912c-5aa6-4c93-934e-28197e1a16c0.log:10`：dsh `QUOTA: Insufficient Balance (request_id: 797283ef-…)`。

### 10.4 明确未做

- 未修改 `src/`、`gui/`、`scripts/`、`test/` 或任何运行配置。
- 未重启生产引擎 `:8080`；未执行 `task_start`/`task_send`/`task_cancel`/`send_*`/`respond_approval` 等写操作。
- 未运行 `npm test` / `verify-*`（避免写入 `data/` 或消耗额度）。
- 未新启动 claude/dsh LLM 任务；未产生新的模型调用。
- 未读取/打印 token 明文；未把任何 token 写入本报告。