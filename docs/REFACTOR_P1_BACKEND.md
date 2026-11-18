# Phase 3 第一批（后端 P1-1 / P1-2 / P1-5）实施记录

> 分支 `gui/group-chat-upgrade`，基线 HEAD `94d75db`。
> 范围：只改后端（`src/`、`test/`、`scripts/`、`docs/`）。未动前端、HUD、隧道、引擎 token 配置。
> 本文件是 REFACTOR_PLAN §5.4 第 2 批的交付说明与回滚依据。

---

## 1. 交付一览

| 项 | 状态 | 主要文件 |
|---|---|---|
| §4 性能基线 | 已建（实施前快照） | `docs/PERF_BASELINE.md`、`scripts/bench-perf-baseline.mjs` |
| P1-1 启动对账 | 已实现 | `src/scheduler.js`、`src/server.js`、`src/messages.js` |
| P1-2 投递重试与状态一致 | 已实现 | `src/store.js`、`src/messages.js`、`src/config.js`、`src/chats.js` |
| P1-5 执行记录表 | 已实现 | `src/store.js`、`src/scheduler.js`、`src/executors/claude.js`、`src/executors/dsh.js`、`src/messages.js` |
| 迁移版本登记 + 逆操作 | 已实现 | `src/store.js`（`schema_version`） |
| 测试 | 72/72（干净检出） | `test/refactor-p1.test.js`（新增 10 条） |

---

## 2. 数据库迁移（schema_version）

新表 `schema_version(version PK, name, applied_at, inverse)`；`Store.migrateVersioned()` 按版本登记，
只跳过已登记的版本，DDL 本身仍然幂等（`CREATE IF NOT EXISTS` / `PRAGMA table_info` 判重），
所以半途中断的库能继续完成同一步。

| 版本 | 名称 | 内容 | 逆操作（记录在 `schema_version.inverse`） |
|---:|---|---|---|
| 1 | `legacy-baseline` | 版本化之前的既有 schema（群聊、provenance、delivery_attempts） | 无需操作 |
| 2 | `executions-and-model-calls` | 新增 `executions`、`model_calls` 两张表及索引 | `DROP TABLE IF EXISTS model_calls; DROP TABLE IF EXISTS executions;` |
| 3 | `delivery-retry-state` | `chat_deliveries` 新增 `error_kind`、`next_attempt_at`、`dead_lettered_at` + 重试索引 | `ALTER TABLE chat_deliveries DROP COLUMN ...`（三列） |
| 4 | `message-execution-metrics` | `messages` 新增 `provider`、`model`、`token_usage_json`、`latency_ms` | `ALTER TABLE messages DROP COLUMN ...`（四列） |

新增字段全部可空，旧代码忽略它们即可运行；旧数据不回填、不猜测。

查看当前版本：

```sql
SELECT * FROM schema_version ORDER BY version;
```

---

## 3. P1-1 启动对账（D-4）

### 行为

`Scheduler.recover()` 已替换为 `Scheduler.reconcile({ replay = true, reason })`：

1. 遍历所有非终态任务（`PENDING/STARTING/WORKING/WAITING/BLOCKED/STALE`）：
   - 若仍有 pid，`killTree`；
   - 任务置 `FAILED`、`process_state=exited_failure`、`turn_state=failed`、`blocker=tooling`；
   - 通过 `task_threads.origin_message_id` 找到来源消息，置 `failed`（`answered` 不降级），
     错误文案 `task <id> did not finish: <reason>`；
   - 该任务名下的 `chat_deliveries` 行置 `failed`、`error_kind=task_failed`，
     `updateDelivery()` 同时写一条 attempt 历史。
2. 扫描并重放：
   - 非 chat：`messages.status IN ('pending','queued')`；
   - chat：`chat_deliveries.status IN ('pending','retry'(到期))`，以及闲置超过
     `DELIVERY_STALE_QUEUED_MS`（默认 120 s）的 `queued` 行。
   - 重放仍走正常闸门（epoch、活跃任务、`agentAutoDeliver`），不会绕过业务规则。
3. 启动周期 sweep（默认 30 s，`unref()`，不阻止进程退出）作为兜底；
   某个任务结束时的 `onTaskFinished` 钩子丢失时，下一次 sweep 会补投。

### 初始化顺序

`src/server.js` 中先装配 `messages`/`chats`/`approvals` 并赋给 scheduler；随后完成
执行器目录创建、`setExecutorTempDir()` 与 ACL 收紧；再调用 `scheduler.reconcile()`；
最后才 `server.listen()`。Scheduler 构造函数不再自行 recover。把 reconcile 放在
目录/ACL 之后是必须的：重放会启动子任务，子进程必须落在已加固的路径上。

### shutdown

`scheduler.shutdown({ reason })` 先对账再清空：running 与 queue 中的任务逐个置 `FAILED`
（同样写来源消息与 delivery 失败与 attempt），随后清空 `running`/`queue` 并停止 sweep。
shutdown 期间不重放（`replay=false` 语义），避免退出过程又启动新任务。

---

## 4. P1-2 投递重试与状态一致（D-4/P1-2）

### 状态机（`chat_deliveries.status`）

```
pending ──成功──> delivered
   │                 
   ├──排队──> queued ──任务结束后重试──> delivered / retry / dead_letter
   ├──epoch 失配/自动投递关闭──> skipped (error_kind=permanent)
   └──失败──> retry (transient, next_attempt_at) ──到期再试──> ...
                    └──次数用尽/永久错误──> dead_letter
```

- `error_kind`: `transient` | `permanent` | `task_failed`（对账时任务死于重启）。
- 指数退避：`DELIVERY_RETRY_BASE_MS × 2^(n-1)`，封顶 `DELIVERY_RETRY_MAX_MS`，默认 2 s / 60 s。
- 最大投递次数 `DELIVERY_MAX_ATTEMPTS`（默认 3，即初次 + 2 次重试）。
- 每次状态变化（pending → retry → dead_letter / delivered）都会追加
  `delivery_attempts` 一行，历史只增不改；`deliveryAttemptSummary` 继续可用。

### 失败分类

`classifyDeliveryError()`（`src/messages.js`）：

- `transient`：SQLITE_BUSY/IOERR、ECONNREFUSED/RESET、ETIMEDOUT、EAGAIN、EPIPE、ENOMEM、
  socket hang up、temporarily、rate limit/429、502/503/504。
- `permanent`：not found / does not exist / no such file、is not a directory、invalid、
  belongs to、mismatch、is not a participant、exchange limit、auto-delivery disabled、
  unknown agent。
- 其余默认 `transient`（有界重试，最终仍会进 dead-letter，不会无限循环）。

### 消息状态聚合

`MessageService.aggregateMessageStatus(messageId)` 只看**动作投递**（`status <> 'visible'`）：

| 投递集合 | 消息状态 |
|---|---|
| 任一 `delivered` | `delivered` |
| 只剩 `queued` / `pending` / `retry` | `queued` |
| 无成功且有 `dead_letter` / `failed` | `failed` |
| 全部 `held` | `held` |
| 全部 `skipped` 或无动作投递 | `stored` |

`answered` 由回复路径设置，聚合永不降级。`deliverChatActions` 不再用最后一个投递的结果覆盖整行。

### 配置（`workbench.env` 可选，均有默认值）

| 变量 | 默认 | 含义 |
|---|---:|---|
| `DELIVERY_SWEEP_MS` | 30000 | 周期对账/重放间隔 |
| `DELIVERY_MAX_ATTEMPTS` | 3 | 单条投递最大尝试次数 |
| `DELIVERY_RETRY_BASE_MS` | 2000 | 指数退避基数 |
| `DELIVERY_RETRY_MAX_MS` | 60000 | 退避上限 |
| `DELIVERY_STALE_QUEUED_MS` | 120000 | queued 判定为“钩子丢失”的闲置阈值 |

---

## 5. P1-5 执行记录（D-3）

### 表

```sql
executions(execution_id PK, task_id, agent, provider, model, provider_request_id,
           token_usage_json, cost_usd, latency_ms, session_id, usage_source,
           created_at, updated_at)
model_calls(call_id PK, execution_id, task_id, agent, provider, model,
            provider_request_id, token_usage_json, cost_usd, latency_ms,
            duration_api_ms, ttft_ms, usage_source, request_summary,
            response_summary, session_id, created_at)
```

- 每个任务在 `createTask()` 时写 1 行 `executions`（`execution_id = task_id`），
  provider/model 立即落库，不再是全 NULL：
  - Claude：`provider = gateway`（存在 `ANTHROPIC_BASE_URL`）或 `anthropic`；
    `model = --model 参数 || ANTHROPIC_MODEL`。
  - dsh：`provider = WORKBENCH_DSH_PROVIDER || 'deepseek'`；`model = WORKBENCH_DSH_MODEL || null`，
    任务结束时由 ledger 补上实际模型。
- 任务结束时 `Scheduler._recordExecutionMetrics()`：
  - 更新 `executions` 的 usage/cost/latency/session/usage_source；
  - 写 1 行 `model_calls`（dsh 即使没有 usage 也写，`usage_source='unknown'`）；
  - `backfillMessageMetrics(taskId, …)` 把指标补到该任务产出的消息行（`COALESCE`，不覆盖已有值）。

### Claude 映射（stream-json `result`）

| 字段 | 来源 |
|---|---|
| model | `modelUsage` 第一个键（缺失时 `event.model`） |
| provider | `modelUsage[*].provider`（如 `firstParty`） |
| token_usage | `sum(modelUsage[*].inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens)`；无 `modelUsage` 时用 `usage.*`；多模型时附 `by_model` |
| cost_usd | `total_cost_usd` |
| latency_ms | `duration_api_ms`（缺失时 `duration_ms`；执行行在缺失时用引擎墙钟） |
| duration_api_ms / ttft_ms | 同名事件字段（`ttft_ms` 缺失时 `ttft_stream_ms`） |
| provider_request_id | `event.request_id`；stream-json 不提供时退回 `event.uuid`（CLI 结果 UUID，是该请求唯一稳定标识） |
| usage_source | 有 usage 数据 → `stream`，否则 `unknown` |
| response_summary | 结果文本前 300 字 |

### dsh 映射

- `provider_request_id`：stderr 中 `request_id: <uuid>`（例如 QUOTA 错误行）。
- `session_id`：任务结束后从 `$DSH_HOME/sessions/<转义 cwd>/session-<uuid>/` 中按 mtime
  选择任务时间窗内最新的目录 id（`dshSessionIdFor()`）。
- `request_summary` / `response_summary`：stderr / stdout 摘要（各前 300 字）。
- usage：读取 `$DSH_HOME/.dshw-usage.json`，取任务开始/结束之间新增的 events，
  汇总 `tokens` 与 `cost`，模型取最后一条 event 的 `model`，`usage_source='dsh-ledger'`。
  - ledger 只给总量，**不给 input/output 拆分**：`token_usage = {input:null, output:null,
    total_tokens:n, source:'dsh-ledger'}`，不伪造拆分。
  - 没有新增事件 / 文件不存在：`token_usage_json=null`、`cost_usd=null`、
    `usage_source='unknown'`。
  - ledger 是全局的；并发 dsh 任务可能串账，因此 `usage_source` 只声明来源，不声明逐调用精确。

### 消息行方案选择（二选一）

选择 **消息行冗余关键字段**（REFACTOR_PLAN 推荐项）：`messages.provider`、`model`、
`token_usage_json`、`latency_ms`，同时保留 `task_id` 关联。理由：聊天列表与
`list_chat_messages` 直接取用，避免每条消息再查 `executions`（N+1）。

`list_chat_messages`、`list_messages`、`task_status` 均已返回这些字段（`task_status` 在
`execution` 对象内）。

---

## 6. 改动文件

| 文件 | 改动 |
|---|---|
| `src/store.js` | schema 版本登记、执行表、重试列、消息指标列、delivery/execution/model_call 查询与回填 |
| `src/scheduler.js` | reconcile/周期 sweep/shutdown 对账、execution 创建与收尾、`statusPayload.execution` |
| `src/messages.js` | 失败分类、指数退避、dead-letter、消息状态聚合、启动重放、消息指标写入 |
| `src/executors/claude.js` | `result` 事件解析为 model/usage/cache/cost/duration/TTFT/request id |
| `src/executors/dsh.js` | ledger 增量、stderr request_id、session 目录 id、stdout/stderr 摘要 |
| `src/config.js` | 重试/sweep/dsh provider&model 配置 |
| `src/chats.js` | `list_chat_messages` 返回执行指标；待投递数包含 `retry` |
| `src/server.js` | 先装配 messages 再 `reconcile()` |
| `docs/PERF_BASELINE.md` | §4 六维基线（实测，含未测到项） |
| `docs/CHAT_BACKEND.md` | P1 契约增量 |
| `scripts/bench-perf-baseline.mjs` | 可复现的只读基线脚本 |
| `test/refactor-p1.test.js` | 9 条新测试（schema/重试/聚合/reconcile/解析/dsh session） |

未改：`gui/`、HUD、隧道、`workbench.env`、`engine.env`、本机 token 文件。

---

## 7. 测试与验证

- `npm run typecheck`：47 个文件，0 failure。
- 干净检出（`git archive HEAD` + 本批改动，不含机器本地的 legacy `workbench.env`，
  `TEMP/TMP` 也不是引擎重定向后的目录）：`node --test "test/*.test.js"` → **72/72 pass**。
- 工作区原地运行：71/72，失败项全部来自本机既有环境状态，不是本批改动：
  1. `security-isolation.test.js` 断言执行器 `TEMP` 不等于测试进程继承的 `TEMP`。本会话由
     执行器启动，继承到的 `TEMP` 已经是引擎重定向的 `<repo>\.tmp-sandbox`，所以该断言失败；
     用 `TEMP=C:\Windows\Temp` 重跑即可越过此项。
  2. 越过上一项后，同一测试会断言“仓库根不应存在 `workbench.env`”。本机该历史文件仍在
     （P0-1 迁移遗留，位于 `data/`/token 之外，未删），属已知环境状态。
     干净检出已证明两条断言对应的代码路径全部通过。
- 新测试覆盖：schema 版本幂等、执行指标落消息、Claude 解析不造假、dsh session id、
  transient→retry→dead-letter、permanent 直接 dead-letter、聚合状态、reconcile 失败/
  重放/shutdown、重放只碰可执行行。

---

## 8. 部署与验收（需 Muse 协调）

1. **本任务未重启生产引擎**，因此新代码与迁移尚未在生产库执行。下一次引擎重启时：
   - 自动执行 v1–v4 迁移（幂等，新增列全空）；
   - `reconcile()` 会把重启瞬间仍在跑的任务标 `FAILED`（已知行为）。当前库里除本任务外
     无在跑任务；重启应安排在无任务时。
2. 验收建议：
   - `SELECT * FROM schema_version ORDER BY version;` → 1,2,3,4；
   - 跑一次 Claude 任务后查 `executions`/`model_calls`：`provider/model/token_usage/cost_usd/
     latency_ms/ttft_ms/usage_source` 有值；消息行同步有指标；
   - 跑一次 dsh 任务：有 ledger 时为 `dsh-ledger`，无则 `unknown`，`token_usage` 不出现伪造的 0；
   - 制造一次可恢复的投递失败，观察 `chat_deliveries.status=retry` → `next_attempt_at` →
     到期重试；把次数耗尽后为 `dead_letter`，消息状态为 `failed`。
3. 回滚：新增字段全部可空；按 `schema_version.inverse` 执行删列/删表即可回到 94d75db 的
   schema（旧代码可直接运行）。回滚前建议先确认没有未投递的 `retry` 行。

---

## 9. 已知限制（如实记录）

- 非 chat 的 legacy `thread` 投递没有 `chat_deliveries` 行，仍是一次尝试；P1-2 的
  重试/dead-letter/attempt 历史作用于群聊投递模型（当前唯一在用的投递路径）。
- dsh 的 usage ledger 是全局的，只能按时间窗归属；并发 dsh 任务时可能串账。
- Claude stream-json 没有 provider 级 request id，使用 CLI result UUID 作为最佳可用标识。
- 周期 sweep 对 `pending` 的检查有 30 s 粒度；正常路径仍由发送与任务结束钩子即时投递。
- 性能基线中的 IPC/React 维度标注为「未测到」，原因见 `docs/PERF_BASELINE.md` §6。