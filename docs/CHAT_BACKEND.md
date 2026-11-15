# 群聊后端实施说明（CHAT_BACKEND）

> 负责人：dsh · 分支：`gui/redesign-chat-backend`（基底 `gui/v0.1` dcb803a）· 日期：2026-11-15
> 对应方案：`docs/CHAT_REDESIGN_PLAN.md` 第 3 节（数据模型）与第 4 节（工具契约）
> 范围：仅 `src/` 后端。`gui/` 未改动（只读）。前端按本文档调用，无需读源码。

## 1. 落地内容一览

| 方案条目 | 状态 | 文件 |
|---|---|---|
| `chats` / `chat_tasks` 表 + `messages.chat_id` 列（迁移安全） | 已实现 | `src/store.js` |
| `SENDERS` 增加 `muse`；`from=muse` 可不带 `task_id`；agent 任务仍不能冒充 muse | 已实现 | `src/messages.js` |
| 6 个新 MCP 工具 | 已实现 | `src/tools.js` |
| `send_message` / `list_messages` 按 4.2 节改造 | 已实现 | `src/tools.js`、`src/messages.js` |
| 群聊 CRUD、状态推导、`needs_muse` | 已实现 | `src/chats.js`（新） |
| Muse→agent 自动投递子任务、结论回流同一群聊 | 已实现 | `src/messages.js`、`src/scheduler.js` |
| 交换上限仍按**子任务 thread** 计 10 条，群聊消息流不设上限 | 已实现 | `src/messages.js` |
| 验证脚本 | 已实现并跑通 | `scripts/verify-chat-backend.mjs` |

## 2. 数据模型

```sql
chats(chat_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT,
      status TEXT DEFAULT 'active',          -- active | archived
      last_message_at TEXT, last_message_preview TEXT)
chat_tasks(chat_id TEXT, task_id TEXT, created_at TEXT, PRIMARY KEY(chat_id, task_id))
messages.chat_id TEXT                        -- 新增列
```

实现细节与方案差异（均为兼容性所必需，已实测）：

1. **`messages.task_id` 改为可空**。Muse 协调消息不属于任何子任务，旧表的
   `NOT NULL` 无法用 `ALTER TABLE` 放宽，因此 `Store.migrateMessagesForChats()`
   在检测到旧 schema 时**重建一次 messages 表**（先复制全部行，再重建索引）。
   - 幂等：已迁移/全新库直接跳过（判据 `PRAGMA table_info(messages)` 的 `task_id.notnull`）。
   - 实测：合成旧库 25 行、真实 `data/workbench.db` 副本 33 行，迁移后行数不变、
     `task_id` 可空、`chat_id` 可读写。
2. **`messages.chat_id` 回填**：`UPDATE messages SET chat_id = (chat_tasks 对应值)`
   在启动时执行一次；`linkChatTask()` 也会即时回填该任务已有的消息，无需等重启。
   历史消息没有 `chat_tasks` 映射时保持 `NULL`（不会伪造归属）。
3. `chat-tasks` 是 task→chat 的唯一映射；一个群聊可累计多个子任务。
4. 群聊协调消息的 thread：`chat:<chat_id>`（`chatThreadId()`）。子任务各有自己的
   thread（= 子任务 task_id），因此 10 条上限按子任务 thread 计，与群聊无关。

## 3. 工具契约（MCP）

工具总数 19（原 13 + 6）。除既有 `send_message` / `list_messages` 的扩展外，新增 6 个。

### 3.1 `create_chat`
- 入参：`{ name?: string }`（空白或缺省 → 名称 `新群聊`，由 Muse 首条回复后 `rename_chat`）
- 返回：`{ chat_id, name, created_at }`

### 3.2 `list_chats`
- 入参：`{ status?: 'active'|'archived'|'all', limit?: number }`
  - 省略 `status` 默认只返回 `active`；`'all'` 为调试用的显式扩展；非法值报错。
- 返回：`{ chats: [ { chat_id, name, status, created_at, updated_at,
  last_message_at, last_message_preview, needs_muse, agents: { claude, dsh } } ] }`
  - `agents.claude` / `agents.dsh` 是**状态字符串**（见 §4），不是对象。
  - 排序：`COALESCE(last_message_at, created_at) DESC`（最新活动在前）。
  - `last_message_at` / `last_message_preview` 与最新一条真实消息行一致（验证脚本已断言）。

### 3.3 `rename_chat`
- 入参：`{ chat_id, name }`（名称 1–200 字符，去除首尾空白）
- 返回：更新后的群聊对象（字段同 §3.2 单个元素）。

### 3.4 `send_chat_message`
- 入参：`{ chat_id, from: 'user'|'muse', to: 'muse'|'user'|'claude'|'dsh',
  summary, files?: string[], question?, task_id?, reply_to? }`
- 返回：`{ message_id, chat_id, created_at, to, status, delivery_task_id }`
  （`delivery_task_id` 是 Muse→agent 分配时启动的子任务 id，便于前端“查看执行记录”）
- 规则：
  - `from='user'` 时 `to` 必须为 `'muse'`，否则报错
    `a user message in a chat must be addressed to 'muse'`。
  - `from='muse'` 且 `to` 为 `claude|dsh` → 走自动投递：为该 agent 启动子任务
    （新 thread + `chat_tasks` 关联），prompt 带群聊名与已渲染的 `chat_id`。
  - `from='muse'` 且 `to='user'` → 仅存消息（清 `needs_muse`）。
  - 同一群聊内该 agent 仍有活动子任务时，分配消息状态为 `queued`，等该 agent 的
    群聊子任务结束后自动重试（`processQueuedChatDeliveries`），不会并发跑两份。

### 3.5 `chat_status`
- 入参：`{ chat_id }`
- 返回：
  ```json
  { "chat_id": "...", "name": "...", "status": "active", "needs_muse": false,
    "last_message_at": "...",
    "agents": {
      "muse":   { "status": "idle|needs_reply", "state": null, "task_id": null, "updated_at": "..." },
      "claude": { "status": "idle|...", "state": "COMPLETED|...", "task_id": "...", "updated_at": "..." },
      "dsh":    { "status": "...", "state": "...", "task_id": "...", "updated_at": "..." }
    },
    "tasks": [ { "task_id", "agent", "state", "status", "thread_id",
                 "created_at", "updated_at", "summary" } ] }
  ```
- 全部字段实时由真实行推导，无快照、无假状态。

### 3.6 `list_chat_messages`
- 入参：`{ chat_id, limit?: number, before?: string }`
  - `limit` 1–500，默认 50。
  - `before` 可为 `message_id` 或 ISO 时间戳，用于**向前翻页**（不含游标本身）。
- 返回：`{ chat_id, messages: [...], count, has_more }`，`messages` 按时间**升序**：
  ```json
  { "message_id": "...", "from": "user|muse|claude|dsh", "to": "...",
    "summary": "...", "files": [], "question": null,
    "status": "stored|queued|delivered|answered|held|failed",
    "created_at": "...", "task_id": "..." }
  ```
  `task_id` 仅在消息属于某子任务时出现（自然语言流不含 thread 状态、日志、报错堆栈）。

### 3.7 既有工具改造
- `send_message`
  - `from` / `to` 枚举增加 `'muse'`。
  - `task_id` 改为可选：`from='muse'`（无子任务）或带 `chat_id` 的群聊消息可不传；
    其它情况仍然必填。**agent 任务传自己的 `task_id` 冒充 muse 仍被拒绝**
    （`task <id> belongs to claude, not muse`），验证脚本已断言。
  - 新增可选 `chat_id`：写入消息行并把结论放进该群聊；agent 回复时若省略，
    服务端按 `task → chat_tasks` 自动补齐（prompt 里已给出 `{{chat_id}}`）。
- `list_messages`
  - 新增 `chat_id` 过滤；`from` / `to` 枚举增加 `'muse'`；
  - 返回的每条消息新增 `chat_id` 字段（未归属群聊为 `null`）。

## 4. 状态规则（真实推导）

`chat_status.agents.<agent>.status` 取值：
`idle | pending | working | waiting | blocked | completed | failed | cancelled`

推导方式：取该 agent 在**该群聊**的最新子任务（`chat_tasks JOIN tasks`，
按 `created_at DESC`），再用引擎既有 `deriveState()` 得到状态并映射：

| 引擎状态 | status | 前端中文（建议，非后端文案） |
|---|---|---|
| 无子任务 | `idle` | 待命 |
| `PENDING` / `STARTING` | `pending` | 排队 / 待命 |
| `WORKING` | `working` | 正在执行 |
| `WAITING` | `waiting` | 等待中 |
| `BLOCKED` / `STALE` | `blocked` | 遇到阻塞 |
| `COMPLETED` | `completed` | 已完成 |
| `FAILED` | `failed` | 失败 |
| `CANCELLED` | `cancelled` | 已取消 |

Muse：
- `idle`：群聊没有待回的用户消息（待命）。
- `needs_reply`：**有用户消息，且其后没有 Muse 消息** → 前端显示“等 Muse 回复”。
  这是真实标记，不是“正在输入”。

`needs_muse` 判定（`store.chatNeedsMuse`，纯 SQL，无缓存）：
`MAX(created_at where from_agent='user')` 存在且 `> MAX(created_at where from_agent='muse')`
（或从未有 Muse 消息）。

## 5. 自动投递与结论回流（关键链路）

```
user ──send_chat_message(from=user,to=muse)──▶ messages(from=user,to=muse,thread=chat:<id>)
                                                    │ needs_muse = true
Muse ──send_chat_message(from=muse,to=claude)───────┘
        │ 1) 存消息（thread=chat:<id>）
        │ 2) attemptDelivery → deliverChatAssignment
        ▼
scheduler.createTask({ agent: claude, chatId, originMessageId })
        │  新 thread（= 子任务 id）+ chat_tasks 关联
        │  prompt 由 buildChatTaskPrompt 生成：群聊名、chat_id、结论上报命令
        │  {{chat_id}} / {{task_id}} 在 launch 时渲染
        ▼
claude 子任务运行完毕
        ├─ 若 agent 按 prompt 调用了 send_message(from=claude,to=muse,chat_id,reply_to)
        │     → 消息落库（thread=子任务 thread，chat_id=该群聊）→ 群聊可见
        └─ 若未调用 → onTaskFinished 解析 <agent_reply> 自动回复，
             并把 assignment 的 chat_id 赋给结论消息
```

要点：
- 结论消息的 `chat_id` 一定与分配消息一致（`origin.chat_id` 优先，其次任务所属群聊）。
- 跨 thread 回复的校验：`reply_to` 指向群聊 thread 中的分配消息，而结论在子任务
  thread 中——服务端以**同 `chat_id`** 作为放行条件，不放松其他情况。
- agent 任务只能以自己身份发消息：`from` 与 `task.agent` 不一致即拒绝。

## 6. 交换上限

- 每个**子任务 thread** 仍是 10 条 agent 消息上限（`AGENT_MESSAGE_LIMIT`），第 10 条
  `status='held'` 且 thread 进入 `WAITING_USER`，第 11 条被拒绝。
- 计入上限的只有 `claude↔dsh` 之间的 agent 对 agent 消息。
  给 `user` 的最终汇报、给 `muse` 的结论、Muse 的分配消息都**不计数**，
  因此群聊消息流本身不设上限。
- 一个子任务线程进入 `WAITING_USER` 只影响它自己，群聊里其他子任务与后续分配不受影响
  （验证脚本在同一时刻向群聊继续发消息成功）。

## 7. 前端调用建议（Claude 按此接入）

IPC 白名单（Muse 负责桥）：`listChats` / `createChat` / `renameChat` /
`listChatMessages` / `sendChatMessage` / `chatStatus`，一一对应 §3.2–§3.6。

轮询（与 `useTaskList` 同模式，2–5 秒）：
- `useChatList` → `list_chats`（默认 active，显示名称、`last_message_preview`、
  `last_message_at`、`needs_muse` 红点、`agents.*` 状态点）。
- `useChatMessages(chatId)` → `list_chat_messages`（升序直接用；向上翻页传最后一条
  之前未加载消息的 `message_id` 作为 `before`，`has_more=false` 即到头）。
- `useChatStatus(chatId)` → `chat_status`（参与者头像旁状态与“等 Muse 回复”）。

发送：`send_chat_message({ chat_id, from:'user', to:'muse', summary })`；
以返回的 `message_id` 为准（服务端落库后再渲染，禁止乐观伪造）。
失败时展示后端 `Error:` 文案并允许重试；空消息不发。

消息渲染映射：
- `from`: `user` 右置；`muse` / `claude` / `dsh` 左置，各用 `sidebar/` 已有头像。
- `status`：`queued`（已排队待投递）、`delivered`（子任务已启动）、`answered`、
  `held`（该子任务线程达上限）、`failed`（投递失败，展示原因入口）。
- 结论卡片用 `files` / `question` / `task_id`；`task_id` 点击进旧任务详情
  （调试路由 `#/tasks/:id`），即方案里的“查看执行记录”。
- `summary` 是唯一进入聊天的自然语言文本；技术日志请走 `task_logs`，不要渲染进聊天流。

状态文案建议：`idle→待命`、`pending→排队`、`working→正在执行`、`waiting→等待中`、
`blocked→遇到阻塞`、`completed→已完成`、`failed→失败`、`cancelled→已取消`、
Muse `needs_reply→等 Muse 回复`。

## 8. 验证

```bash
# 独立引擎（本机 18092 端口、独立 data 目录与 token），全程不调用 LLM
node scripts/verify-chat-backend.mjs
# 自定义端口
VERIFY_PORT=18093 node scripts/verify-chat-backend.mjs
```

脚本覆盖：工具存在性、建群/改名/列表、用户消息与 `needs_muse` 双向状态、
Muse→agent 真实子任务（独立 thread、prompt 含群聊名与已渲染 `chat_id`）、
结论回流同一 `chat_id` 且归属子任务、状态推导矩阵、两个群聊消息/状态/子任务零泄漏、
10 条上限按子任务线程且群聊不受限、agent 任务冒充 muse 被拒、重连后数据不变。
输出 `{ ok: true, ... }` 并写 `data/chat-backend-verify-<stamp>/verify-result.json`；
失败时 `ok:false` + `errors` 并以非 0 退出码结束。

> 环境说明：本机验证环境禁止带管道 stdio 派生子进程（`spawn EPERM`），
> 因此脚本在**同进程**内启动独立引擎（仍是真实 HTTP MCP 端口 + 独立库），
> 并用一个**记录 prompt、随后通过真实 scheduler 收尾**的 claude 执行器替身
> 代替 CLI；子任务行、thread、chat 关联、prompt 渲染、`<agent_reply>` 解析、
> 结论落库全部走生产代码。真实 CLI 未被调用（`llm_calls: 0`）。

## 9. 未做 / 边界（诚实记录）

- 无“归档群聊”工具（方案 4.1 未列）；`chats.status` 列与 `list_chats status`
  过滤器已就绪，归档动作留给后续或直接改库。
- Muse 唤醒仍按方案由 `chat-muse-watch`（每 2 分钟轮询 `list_chats` 的
  `needs_muse`）驱动，后端只提供真实标记，不做推送。
- 群聊消息未做全文检索/分页总数统计（`before` 游标翻页已够当前 UI）。
- 子任务 cwd 固定为 workbench 根目录（`config.root`）；若后续需要“每群聊一个工作
  目录”，在 `chats` 增列并在 `deliverChatAssignment` 传入即可。
- GUI 侧 IPC、页面、样式不在本次范围内（Claude / Muse 负责）。
