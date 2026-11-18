# 性能基线（PERF_BASELINE.md）

> 依据：`docs/REFACTOR_PLAN.md` §4（6 个维度）与 §5.4 第 2 批（后端 P1）。
> 测量时间：2026-11-18 03:19–03:24 UTC（本机时间 11:19–11:24），MOG，`C:\Claude\agent-workbench`，分支 `gui/group-chat-upgrade`，HEAD `94d75db`。
> 采集脚本：`scripts/bench-perf-baseline.mjs`（只读；未重启、未写入生产引擎）。
> 数据来源：生产 `data/workbench.db`（只读连接）+ `logs/server.log` + `logs` 表内真实 stream-json 结果事件 + 临时目录内的附件解析夹具。
> 规则：下表中的数字全部为实测；没有样本的格子明确写「未测到」，不估算、不编造。所有耗时单位为毫秒（ms），除非另注。

---

## 1. 测量方法摘要

| 维度 | 实测方法 | 样本 |
|---|---|---|
| 发送/接收 | 从 `logs/server.log` 的真实 MCP 工具调用审计行解析 `duration_ms`（`tool=send_chat_message`、`list_messages`、`list_chats`、`task_list`、`task_status`） | 见 §2 表 |
| 队列/派发 | ① 消息 `created_at` → 对应子任务 `tasks.created_at`（经 `task_threads.origin_message_id`）；② `delivery_attempts` 中同一 `(message_id, agent)` 的 `queued` → `delivered/failed` 时间差 | 35 条派发、3 条排队完成 |
| 模型 | 解析 `logs` 表中 Claude Code `stream-json` 的 `result` 事件：`ttft_ms`、`duration_ms`、`duration_api_ms`、`total_cost_usd` | 104 次结果事件 |
| DB | 文件体积、`data/` 递归体积、`logs` 行数、查询耗时（只读 200 次）与完整 handler 耗时（临时副本上 100 次） | 见 §4 |
| 附件 | 在临时 `Store`+`FileService` 中对生成的 PDF/DOCX/XLSX/ZIP/PNG/TXT 夹具执行完整 `completeUpload`（含落盘与解析），每种 5 次 | 每种 5 次 |
| 聚合（IPC/React） | — | **未测到**（原因见 §6） |

---

## 2. 发送/接收与常用接口耗时（生产真实调用）

`logs/server.log` 中记录的 MCP 工具处理耗时（服务端 `register()` 包装层的 `duration_ms`）：

| 工具 | n | 均值 | P50 | P95 |
|---|---:|---:|---:|---:|
| `send_chat_message` | 7 | 142.00 | 22 | 425 |
| `list_messages` | 59 | 9.34 | 7 | 17 |
| `list_chats` | 25 | 10.44 | 7 | 22 |
| `task_list` | 49 | 75.94 | 65 | 95 |
| `task_status` | 55 | 3.05 | 1 | 5 |
| `task_start` | 13 | 217.77 | 173 | 749 |
| `agent_info` | 13 | 556.38 | 559 | 3444 |

说明：

- `send_chat_message` 的 P50 22 ms 包含落库与同事务内的 delivery 行写入；P95 425 ms 出现在一次派发（同时创建子任务）的调用上。
- `task_list` 明显高于单表查询（见 §4：`tasks` 原始查询 P50 3.81 ms），因为 `task_list` 对每条任务都调用 `statusPayload()`，其中包含线程与 chat 关联查询（N+1）。
- 本轮没有生产 `list_chat_messages` 调用记录，因此该工具的线上耗时**未测到**；同 SQL 与完整 handler 的受控测量见 §4。

---

## 3. 队列/派发与模型耗时

### 3.1 消息落库 → 子任务启动

| n | 均值 | P50 | P95 | 最小 | 最大 |
|---:|---:|---:|---:|---:|---:|
| 35 | 99,764.11 | 7 | 1,009,585 | 1 | 2,193,638 |

分布是双峰的：P50 只有 7 ms（立即派发），均值与 P95 被「消息落库很久之后才启动子任务」的样本拉高（排队等待、上一任务占用、重启后重放等）。这正是 P1-1/P1-2 要治理的部分。

### 3.2 `queued` 停留时长

| n | 均值 | P50 | P95 | 最小 | 最大 |
|---:|---:|---:|---:|---:|---:|
| 3 | 392,529 | 164,277 | 1,009,808 | 3,502 | 1,009,808 |

样本少（现有库只记录了 39 条 delivery attempt，其中 3 条完整经历 `queued → delivered`），只作现状快照。

### 3.3 模型 TTFT 与全生成耗时

数据来源：`logs` 表中 104 条 `type=result` 事件；模型集中为 `deepseek-v4.1-flash`（经本机网关），其中 101 条带 `ttft_ms`。

| 指标 | n | 均值 | P50 | P95 | 最小 | 最大 |
|---|---:|---:|---:|---:|---:|---:|
| TTFT（`ttft_ms`，首 token） | 101 | 3,624.25 | 1,874 | 16,456 | 1,011 | 36,317 |
| 全生成（`duration_ms`，任务墙钟） | 104 | 493,329.83 | 177,469 | 1,550,465 | 223 | 4,750,337 |
| API 时长（`duration_api_ms`） | 104 | 366,572.91 | 118,116 | 1,132,891 | 0 | 3,813,025 |
| 单次成本（`total_cost_usd`） | 104 | 7.62 | 1.49 | 24.08 | 0 | 101.36 |

说明：

- `duration_ms` 是 Claude Code 整个任务的墙钟，包含多轮工具调用；它与 `duration_api_ms` 的差额就是工具执行与本地开销。P95 超过 25 分钟，与 §3.1 的长尾一致。
- 104 条事件在库内均标记 `is_error=false`；同一时期日志文件中可见网关 500 的失败样本，但它们没有进入 `logs` 表的结果解析（任务在失败路径结束）。因此上表是「成功结果事件」的分布，不是全部尝试。
- dsh 没有 usage ledger，无法给出 TTFT/usage；这就是 P1-5 要显式记录 `usage=unknown` 的原因。

---

## 4. DB 体积与查询耗时

### 4.1 体积与行数（测量时刻）

| 指标 | 实测值 |
|---|---:|
| `data/workbench.db` 文件体积 | 497,283,072 B（474.2 MiB） |
| `data/` 递归总体积 | 510,769,078 B（487.1 MiB），44 个文件 |
| SQLite `page_count × page_size` | 121,431 × 4,096 B |
| `logs` 表行数 | 749,303 |
| `logs` 近似有效载荷（行文本+时间戳等） | 404,279,460 B（约 385.6 MiB） |
| `messages` 行数 | 121 |
| `tasks` 行数 | 189 |

结论：**约 78% 的数据库体积来自 `logs` 表**（404 MB / 497 MB），而业务消息只有 121 条。这是 P1-7（日志写放大）最直接的证据。

### 4.2 查询耗时（生产库只读、200 次采样）

| 查询 | 均值 | P50 | P95 |
|---|---:|---:|---:|
| `list_chat_messages` 原始 SQL（最大聊天，LIMIT 200） | 0.95 | 0.90 | 1.13 |
| `task_list` 原始 SQL（LIMIT 50） | 3.89 | 3.81 | 4.17 |
| `chatNeedsMuse` 单条聚合 | 0.03 | 0.03 | 0.03 |

### 4.3 完整 handler 耗时（生产库临时副本、100 次采样）

| Handler | 均值 | P50 | P95 |
|---|---:|---:|---:|
| `ChatService.listMessages`（最大聊天，200 条，含逐条附件查询） | 5.14 | 4.92 | 5.73 |
| `ChatService.status` | 6.71 | 6.52 | 8.27 |
| `task_list` 等价路径（50 条 + 每任务线程/chat 查询） | 12.05 | 11.54 | 18.38 |

说明：当前 7 个聊天、121 条消息的规模下，绝对耗时都不高（P95 均在 20 ms 内）；`task_list` 的 N+1 在数据量增长后才会放大，已列入 P2 的索引/聚合改造。

### 4.4 本批改动后的复测（同一脚本、同一生产库副本）

P1-5 让 `statusPayload()` 多查一次 `executions`（按 `task_id` 索引），因此只复测完整 handler：

| Handler | 实施前 P50/P95 | 实施后 P50/P95 | 变化 |
|---|---:|---:|---:|
| `list_chat_messages`（200 条） | 4.92 / 5.73 | 4.13 / 4.93 | 噪声范围内 |
| `chat_status` | 6.52 / 8.27 | 6.22 / 7.99 | 噪声范围内 |
| `task_list` 等价路径（50 条） | 11.54 / 18.38 | 13.59 / 19.32 | +2.25 ms 均值（约 0.045 ms/任务） |

`task_list` 的增量来自每条任务一次索引查询，符合预期；P1-7/P2 的聚合改造是消除它的地方，
本批不处理。

---

## 5. 附件解析耗时

夹具由脚本生成（方法 0 存储 ZIP，无压缩），每种执行完整 `initUpload → appendChunk → completeUpload` 5 次，耗时只统计 `completeUpload`（落盘 + 解析）：

| 类型 | 夹具大小 | 解析状态 | n | 均值 | P50 | P95 |
|---|---:|---|---:|---:|---:|---:|
| PDF（200 段文本，未压缩流） | 13,771 B | parsed | 5 | 13.01 | 11.47 | 19.09 |
| DOCX（2,000 段） | 143,228 B | parsed | 5 | 18.93 | 18.93 | 19.68 |
| XLSX（5,000 行 × 8 列，共享字符串） | 959,651 B | parsed | 5 | 59.22 | 59.64 | 61.70 |
| ZIP（100 个文件，解包落盘） | 168,602 B | parsed | 5 | 89.39 | 88.56 | 111.42 |
| PNG（256 KiB 图像，不读像素） | 262,152 B | parsed | 5 | 11.88 | 9.40 | 20.99 |
| TXT（480,000 B） | 480,000 B | parsed | 5 | 11.39 | 11.46 | 12.07 |

说明：这是解析器本机的 CPU/IO 成本，不包含 1 MB 分片上传的网络与 base64 编解码。真实聊天库当前没有已上传文件，无法用生产文件复测（`data/chat-files/` 为空），所以夹具尺寸已在上表标明。

---

## 6. 聚合维度：聊天页空闲 30 s IPC 调用数 / React 提交次数

**未测到。**

- 测量时 GUI 未运行；要在不写入生产聊天已读游标的前提下测「空闲 30 s」，需要单独启动一个指向隔离引擎的 GUI 实例并驱动到聊天页，本轮未搭建该环境。
- 作为设计参考（不是实测值）：`gui/src/lib/chat-store.ts` 当前配置 `MESSAGE_POLL_MS=3000`、`STATUS_POLL_MS=5000`、`LIST_POLL_MS=5000`。若三者都活跃，30 s 内期望约 10 + 6 + 6 = 22 次轮询调用，高于 §4 的目标（<20）。
- React 提交次数（DevTools Profiler）同样**未测到**。

后续测量建议：用隔离引擎 + 独立 `user-data-dir` 启动 GUI，经 CDP 包装 `window.workbench` 计数；或在 P1-10 落地时加一个只读的 `ipc-call-counter` 开发开关。

---

## 7. 本轮基线的用途与局限

- 本文件是实施前快照。P1-7（日志写放大）、P1-10（轮询分层）落地后用同一脚本复测，对比 `logs` 增速、DB 体积、`task_list` 与 `list_chat_messages` 耗时。
- 本轮 P1-1/P1-2/P1-5 不改变日志写入路径，因此不预期这些数字显著变化；它们的验收在功能与数据完整性（重放、重试、执行记录），不在性能。
- 所有数字可复现：`node scripts/bench-perf-baseline.mjs --json <out.json>`。脚本对生产库只读，附件夹具写在系统临时目录并在结束时删除。