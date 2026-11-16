# 群聊升级后端交付报告（Phase 4）

> 分支：`gui/group-chat-upgrade`（基线 `origin/gui/redesign-chat` @ `275ddc3`）
> 日期：2026-11-16
> 范围：仅后端 `src/`、`test/`、`scripts/`、`docs/`、`package.json`。未改动 `gui/`，未重启生产引擎。
> 对应任务书：A 消息模型迁移 / B P0 安全 / C 广播与防循环 / D 文件服务 / E 状态 / 归档补充需求。

## 0. 结论

四项主线和归档补充均已落地：

- 群聊消息从“单收件人卡片”升级为 **消息 + 每参与者投递** 两层模型，带 `seq/body/mentions/root/depth/epoch/client_msg_id/context_version`。
- 身份改为 **服务端按 bearer token 推导**：master（User+Muse 协调员）与 claude / dsh 各自独立 token，执行器只拿到自己的 token。
- 群聊共享上下文、可见性/行动分离、epoch 闸门、幂等、每 epoch 代理预算全部生效；原子任务 10 条上限保留。
- 文件服务支持 1 MB 分片上传、20 MB 单文件上限、PDF/DOCX/XLSX/PPTX/TXT/MD/代码解析、图片视觉能力分流、ZIP 安全解压与目录树读取；一切引用只接受 `file_id`。
- 新增归档工具，归档不删除消息/文件，`list_chats` 默认隐藏，`include_archived=true` 时 **active 在前、archived 在后**。
- 工具从 19 个扩展到 **27 个**；旧 master-token 调用方式保持兼容（身份/裸路径两处是有意的安全收紧）。

## 1. 改动文件

| 文件 | 内容 |
|---|---|
| `src/store.js` | 新列/新表、幂等迁移、`seq` 回填、消息+投递+附件单事务、参与者/投递/文件/授权 scope 存取、`listMessages`/`listChats` 作用域过滤、`taskReplyFrom` 等旧接口补齐 |
| `src/auth.js`（新） | HMAC 派生执行器 token、token→身份映射、`from` 一致性、chat/task 访问断言 |
| `src/text.js`（新） | token 估算、摘要截断、上下文预算裁剪（从 messages.js 抽出避免循环依赖） |
| `src/context.js`（新） | `buildChatContext`：按 seq 升序取最近 N 条 + token 预算 + 本群附件清单 |
| `src/files.js`（新） | 分片上传、20 MB/1 MB 限制、sha256、PDF/DOCX/XLSX/PPTX/ZIP 解析、ZIP 安全解压、per-chat 路径校验、图片视觉分流 |
| `src/messages.js` | 身份/任务归属强制、body 全文与 summary 预览、mentions/act、epoch、幂等、投递事务、群聊上下文 prompt、可见性/行动分离 |
| `src/chats.js` | 参与者初始化、状态 TTL、`chat_status` 扩展、`include_archived`、`chat_archive`/`chat_unarchive`、消息流返回 seq/body/epoch |
| `src/tools.js` | 27 个 MCP 工具、按 token 裁剪/过滤、新文件与归档工具、master-only 校验 |
| `src/server.js` | 按 token 识别身份、401、传入 auth、启动时为两个执行器写 scoped MCP 配置、导出验证句柄 |
| `src/config.js` | 执行器 token 派生、聊天/文件/上下文/状态 TTL 配置 |
| `src/mcp-config.js` | 每个执行器独立 MCP 配置文件与 token，master token 不再写入执行器配置 |
| `src/executors/claude.js` / `dsh.js` | Claude 使用自己的 scoped MCP 配置；dsh 注入 scoped 配置路径/URL/token 环境变量 |
| `src/scheduler.js` | 群聊任务创建时确保执行器成为参与者 |
| `src/approvals.js` | 授权按 `(chat_id, agent, category)`；`respond_approval` 服务层二次拒绝 agent token；审批卡片路径不再当作聊天附件 |
| `scripts/verify-upgrade.mjs`（新） | 独立端口 + 临时库的端到端验证 |
| `scripts/check-syntax.mjs`（新） | 全仓库后端 JS 语法检查（`npm run typecheck`） |
| `scripts/verify-chat-backend.mjs` | 旧验证脚本改用 scoped claude/dsh token，继续覆盖 10 条上限与持久化 |
| `test/*.test.js`（新） | `node:test` 数据模型/迁移/安全/文件/归档/消息流测试 |
| `package.json` | `test` / `typecheck` / `verify:upgrade` 脚本 |
| `docs/upgrade-backend-phase4.md` | 本报告 |

## 2. 数据模型与迁移（A）

### 2.1 `messages` 新列

| 列 | 含义 |
|---|---|
| `seq` | 群内单调递增序号；按 `(chat_id, seq)` 唯一，排序/翻页不再依赖毫秒时间戳 |
| `body` | 完整正文，不再受 500 token 摘要上限约束 |
| `summary` | 仍保留，作为截断预览（聊天列表/卡片用） |
| `mentions_json` | `["claude","dsh"]` 等可见性提及 |
| `root_message_id` | 因果根；根消息为 `NULL`，深度 0 |
| `depth` | 因果深度，默认上限 16（保证 10 条线程链不被误杀） |
| `epoch` | 群聊轮次；每次真实 user 发言 +1 |
| `client_msg_id` | `(chat_id, client_msg_id)` 幂等键 |
| `context_version` | 生成消息时群聊最新 seq |

索引：`UNIQUE(chat_id, seq)`、`UNIQUE(chat_id, client_msg_id)`、`(chat_id, epoch, seq)`、`root_message_id`。
**删除** `idx_messages_reply_unique`：一条广播现在可以被 Muse/Claude/dsh 多方回复。

### 2.2 新表

- `chat_participants(chat_id, participant_id, kind, role, display_name, enabled, auto_participate, joined_at, last_read_seq)`
  - 每个群聊创建时写入 `user`、`muse`；执行器在被 `to`/mention/act/派发时加入，这也是 agent token 的访问范围边界。
- `chat_deliveries(message_id, agent, status, task_id, error, epoch, updated_at)`
  - `visible`：仅可见；`pending/queued/delivered/failed/skipped`：行动投递状态。
- `chat_files(file_id, chat_id, uploader_id, original_name, stored_path, mime, size, sha256, parse_status, parse_error, extracted_path, created_at)`
- `message_files(message_id, file_id, sort_order)`

### 2.3 迁移

- 旧库 `messages.task_id NOT NULL`：仍沿用一次性重建（保留全部行），再 `ALTER TABLE ADD COLUMN` 补齐新列。
- `chats` 补 `epoch/status/last_message_at/last_message_preview` 等列后再建索引，支持极老的 pre-chat 库。
- `seq` 回填：按 `chat_id, created_at, id` 升序生成；已有 seq 保留并从最大值继续。
- `body` 回填为旧 `summary`；`epoch/depth/context_version` 默认 0。
- `approval_grants` 从 `(thread_id, category)` 重建为 `(scope, agent, category)`：
  - 群聊任务 `scope=chat_id, agent=<agent>`；
  - 非群聊旧任务 `scope=thread:<thread_id>, agent=''`（保留旧行为）。
- 参与者回填：所有 chat 补 `user`/`muse`；已有 `chat_tasks` 的 agent 补对应参与者。
- 迁移幂等，每次启动可重复执行；测试覆盖 pre-chat 库与 chat 期旧库，行数/正文/seq/授权均不丢。

## 3. P0 安全（B）

### 3.1 分 scope token

- master token：`MCP_BEARER_TOKEN`，代表 User + Muse 协调员。
- 执行器 token：`HMAC-SHA256(master, "agent-token:<agent>")`，claude / dsh 各一个，无需持久化明文。
- 启动时写 `data/claude-mcp.json` 与 `data/dsh-mcp.json`，各自只含自己的 token；**master token 不再进入执行器配置**。
- 每个 HTTP 请求按 bearer 映射身份；日志只记录 `master:muse` / `agent:claude` 等身份，不记录 token。

### 3.2 身份与任务归属

- `from` 只做一致性校验：master 只能发 `user|muse`，执行器只能发自己。
- claude/dsh 消息 **必须**带自己的 `task_id`，且 `task.agent === from`；无 task 一律拒绝。
- agent token 只能读写自己参与的 chat；发送到未加入的 chat 直接拒绝。

### 3.3 审批

- `respond_approval` 仅 master token；tools 层与服务层双重校验，执行器不能自批。
- `session` 授权按 `(chat_id, agent, category)`，跨子任务生效；非群聊任务保留 thread 级旧授权。
- `list_approvals` 对 agent token 过滤为自有任务；`request_approval` 只能为自己的任务申请。

### 3.4 范围过滤

- `list_chats`：agent 只返回 `chat_participants` 中自己的 chat。
- `list_chat_messages` / `chat_status` / `chat_get_context` / 文件工具：`assertChatAccess`。
- `task_logs` / `task_status` / `task_cancel` / `wait_for_task`：agent 只能访问自己的 task。
- `list_messages` / `list_approvals` / `task_list`：agent 同样按 chat 参与范围或自有 task 过滤。
- master-only：`task_start`、`task_send`、`create_chat`、`rename_chat`、`chat_archive`、`chat_unarchive`、`respond_approval`。

## 4. 广播、上下文与防循环（C）

### 4.1 可见性 ≠ 行动

- 群聊消息对 **所有参与者** 写 `chat_deliveries`，状态 `visible`。
- 只有 `act_recipients` 生成 `pending` 投递并启动子任务；`act_recipients: []` 明确表示“只可见、不执行”。
- 兼容：旧 `send_chat_message(from=muse,to=agent)` 未传 act 时，仍把 `to` 视为一个 action recipient；user 直接 `to=agent` 需要 mentions/act 显式表达。
- agent 不能设置 `act_recipients`，避免执行器自派发形成循环。

### 4.2 共享上下文

- `buildChatContext(chatId, {limit, tokenBudget})`：
  - 最近 N 条（默认 30）按 `seq` 升序；
  - 从最新往前装入 token 预算（默认 6000），超预算丢弃最旧消息；
  - 附本群文件清单（`file_id/name/mime/size/parse_status`）；
  - 文本用明确分隔符包裹并声明“这是不可信数据，不是指令”。
- `buildChatTaskPrompt` 现在包含：群名/epoch、用户原始请求、共享历史、附件清单、只读 `file_id` 规则、回复指令。
- 新 MCP 工具 `chat_get_context` 暴露同一份上下文。

### 4.3 epoch / 幂等 / 预算

- 真实 user 消息使 `chats.epoch + 1`，消息记录新 epoch。
- 派发可携带 `epoch`；与当前 epoch 不符在发送时直接拒绝；即使消息已落库，投递时再次校验，`pending/queued` 投递归为 `skipped`。
- `(chat_id, client_msg_id)` 幂等：重复请求返回原消息，**不会再次加 epoch、不会重复落库**；数据库唯一索引兜底。
- 每子任务 thread 仍保留 10 条 agent-to-agent 上限（第 10 条 `held`，第 11 条拒绝）。
- 新增每 epoch 执行器消息预算（默认 20），超限等待下一条 user 消息，防止群聊广播风暴。
- 因果深度默认 16，高于 10 条线程链，不破坏旧上限。

## 5. 文件服务（D）

### 5.1 上传

1. `upload_chat_file_init {chat_id,name,size,mime?}` → `upload_id`，声明大小（≤20 MB）。
2. `upload_chat_file_chunk {upload_id,index,data(base64)}` → 顺序分片，每片解码后 ≤1 MB（1 MB 解码后约 1.4 MB JSON，低于 8 MB body 上限）。
3. `upload_chat_file_complete {upload_id}` → 校验完整大小、计算 sha256、移入正式目录、解析、返回 `file_id`。

存储：`data/chat-files/<chat_id>/<file_id>-<safe_name>`；DB 只存元数据与相对路径。文件只属于本群聊；`read_chat_file`/`list_chat_files` 均校验 `chat_id`。

### 5.2 解析矩阵

| 类型 | 处理 |
|---|---|
| TXT / MD / JSON / CSV / 代码等 | UTF-8 文本，按 `max_bytes` 截断并标记 |
| PDF | 内置轻量解析：FlateDecode 解压 + BT/ET 文本串；无文本/扫描件返回明确 failed 或 unsupported |
| DOCX | OOXML `word/document.xml` 段落/换行/制表符提取 |
| XLSX | `sharedStrings.xml` + 工作表单元格提取，按 TSV 输出 |
| PPTX | `ppt/slides/slideN.xml` 文本提取 |
| 图片 | 按执行器视觉能力：claude 返回 MCP image 内容；dsh/无视觉返回明确“无法接收图片内容”说明；>5 MB 明确拒绝 |
| ZIP | 安全解压后返回文件树；`entry=<相对路径>` 读取成员 |
| 其他二进制 | `parse_status=unsupported`，`read_chat_file` 返回明确错误 |

ZIP 安全限制：拒绝绝对路径、`..`、符号链接、ZIP64/加密包；最多 200 个文件、嵌套深度 5、解压总量 50 MB、单文件 10 MB；inflate 使用 `maxOutputLength`，即使中央目录伪造 uncompressedSize 也不会被 ZIP 炸弹撑爆。超限导致 `parse_status=failed`，读取时返回原始错误原因。

### 5.3 裸路径政策

- 聊天消息的 `files` 只接受 `file_id`；`C:\...`、`/etc/...`、`../x` 一律显式拒绝。
- `read_chat_file` 只接受 `chat_id + file_id`，服务端只在 per-chat 目录内解析；ZIP entry 再做目录逃逸校验。
- 非聊天消息也不再接受裸路径（非聊天没有群文件服务）；内部审批卡片通过 `legacy_files: true` 保留“受影响路径”展示，但不会作为聊天附件或投递。
- 执行器 `<agent_reply>.files` 中的裸路径会被丢弃并写日志，不会进入消息附件。

## 6. 状态与归档（E + 补充需求）

### 6.1 状态 TTL 规则

- agent 的 `status` 仍由该 chat 内最新子任务推导。
- 终态（`COMPLETED/FAILED/CANCELLED`）展示 `chatTerminalStatusTtlMs`（默认 **60 秒**），从 `task.updated_at` 起算；超过后回 `idle`，并保留 `last_terminal_state` 便于排查。
- 非终态（pending/working/waiting/blocked）不套用 TTL。

### 6.2 `chat_status` 扩展

返回新增：`epoch`、`context_version`、`participants[]`（role/kind/enabled/auto_participate/last_read_seq/status/current_task_id/pending_deliveries/delivery_status）、`deliveries` 汇总、`paused: false`。原有 `agents`/`tasks`/`needs_muse` 字段保留。

### 6.3 归档

- `chat_archive {chat_id}` → `status='archived'`；`chat_unarchive {chat_id}` → `status='active'`。
- 只改列表可见性，不删除消息、文件、投递、epoch 或任务。
- `list_chats` 新增 `include_archived`：
  - 默认 `false`：只返回 active（与旧行为一致）；
  - `true`：返回全部，**active 分组在前、archived 分组在后**；组内仍按最近活动排序。
  - 旧的 `status: active|archived|all` 参数继续可用。
- `chat_archive`/`chat_unarchive` 仅 master token。

## 7. MCP 工具清单（27）

原有 19 个：`agent_info`、`task_start`、`task_send`、`task_status`、`task_logs`、`task_cancel`、`task_list`、`send_message`、`list_messages`、`create_chat`、`list_chats`、`rename_chat`、`send_chat_message`、`chat_status`、`list_chat_messages`、`request_approval`、`respond_approval`、`list_approvals`、`wait_for_task`。

新增 8 个：

1. `chat_get_context`
2. `upload_chat_file_init`
3. `upload_chat_file_chunk`
4. `upload_chat_file_complete`
5. `read_chat_file`
6. `list_chat_files`
7. `chat_archive`
8. `chat_unarchive`

## 8. 兼容性与有意收紧

保留兼容：

- 旧工具名与主要参数仍可用；`summary` 仍是预览字段，新增 `body` 承载全文。
- 旧 `send_chat_message(from=muse,to=agent)` 仍会自动派发一个子任务。
- 旧 `list_chats` 默认仍只列 active；`status` 参数仍有效。
- 旧审批 thread 级 session 授权迁移为 `thread:<id>` scope 继续生效。
- 旧验证脚本 `scripts/verify-chat-backend.mjs` 已改用 scoped token，并继续通过。

有意收紧（P0 要求）：

- 用 master token 伪造 `from=claude|dsh` 会被拒绝；必须使用对应执行器 token。
- agent 无 `task_id` 发消息会被拒绝（旧实现可只带 `chat_id` 冒充）。
- 聊天消息/非聊天消息中的裸路径被拒绝，必须使用 `file_id`。
- `respond_approval` 不接受 agent token。

## 9. 验证证据（2026-11-16）

### 9.1 单元/接口测试

```bash
npm test
# 39 tests / 39 pass / 0 fail
```

覆盖：

- 旧库迁移（pre-chat 与 chat 期两类）、seq 回填、reply 唯一索引删除、授权 scope 迁移、参与者回填；
- seq 每群单调、client_msg_id 幂等且不重复加 epoch；
- 消息 + 投递单事务与失败回滚；
- agent 无 task / 冒充 / 跨 chat 被拒；
- epoch 不符派发被拒且不落消息；
- 可见性/行动分离、每 epoch 预算、10 条线程上限；
- 分片上传、20 MB/1 MB 限制、sha256；
- TXT/DOCX/XLSX/PPTX/PDF 解析、图片视觉分流、ZIP 树/entry/路径穿越拒绝、ZIP 解压上限；
- 裸路径拒绝、跨群文件拒绝、message_files 关联；
- 归档默认隐藏、include_archived 顺序、消息/文件保留、恢复。

### 9.2 独立端口 + 临时库端到端

```bash
node scripts/verify-upgrade.mjs
# ok: true
```

实测环境：随机 loopback 端口（本次 14681）、临时目录 `data/upgrade-verify-*`、独立 SQLite、`AGENT_AUTO_DELIVER=0`（未调用任何 LLM），未使用 8080。

逐项结果：

| 验证项 | 结果 |
|---|---|
| 工具数量/必备工具 | 27 个，全部存在 |
| 建群/列表 | 通过 |
| 归档默认隐藏 / include_archived active-first / 恢复 | 通过 |
| user 消息 epoch=1 | 通过 |
| client_msg_id 重试同 message_id 且 epoch 不增 | 通过 |
| chat_get_context 含用户消息与 epoch | 通过 |
| 过期 epoch 派发拒绝且消息数不变 | 通过 |
| act_recipients 产生 `pending`，非行动者仅 `visible` | 通过 |
| 冒充 muse / 无 task / 自批 | 均拒绝 |
| agent list_chats 只看到参与群 | 1 个 |
| agent 读他人 task_logs | 拒绝；自己 task_logs 通过 |
| 1 MB 分片上限 / 20 MB 文件上限 | 明确拒绝 |
| 裸路径 / 跨群 file_id | 明确拒绝 |
| 分片上传 + 文本读取 + list_chat_files | 通过 |
| ZIP 文件树 + entry 读取 | 通过 |
| ZIP 路径穿越 | parse failed + 读取明确错误 |
| 归档后文件/消息仍可读 | 通过 |
| DB：reply 索引删除、幂等唯一、投递、message_files | 通过 |

### 9.3 旧链路回归

```bash
VERIFY_PORT=18094 node scripts/verify-chat-backend.mjs
# mcp_tool_calls: 47, errors: []
```

保留通过的关键点：10 条 agent-to-agent 上限（第 10 条 held、第 11 条拒绝）、群聊消息流不受线程上限影响、agent 任务不能冒充 muse、重启后消息与状态不变。

### 9.4 语法/构建检查

```bash
npm run typecheck
# checked 42 JavaScript files; 0 failure(s)
```

仓库没有 TypeScript 后端工程；该脚本用 `node --check` 对所有 `src/`、`src/executors/`、`scripts/` 的 JS/MJS 做解析检查。

### 9.5 生产环境安全

- 未向 8080 端口发送任何写请求，未重启生产引擎。
- 所有验证引擎使用独立端口与临时数据库；验证结束后进程已关闭。
- 引擎换版/重启留作最后独立步骤。

## 10. 遗留问题 / 后续建议

1. **dsh 仍不是实时 MCP 参与者**：dsh 是 headless one-shot，无 MCP 客户端。本次已给它注入 scoped 配置路径/URL/token 环境变量，但它仍不能主动调用 `chat_get_context`/`read_chat_file`；上下文通过 prompt 注入，结论通过 `<agent_reply>` 回流。若要实时参与，需要给 dsh 加工具桥。
2. **PDF 解析是轻量实现**：扫描件、加密 PDF、CID 字体可能无文本，会返回 `failed`/`unsupported` 明确错误；没有 OCR，也未引入第三方解析依赖。需要更强解析时可换 `pdfjs-dist` 等可选依赖。
3. **XLSX/PPTX 解析按 XML 文本提取**：保留单元格/段落文本，不保留样式、合并单元格、图表、公式语义。
4. **上传会话在内存中**：引擎重启会丢失未完成上传（`.uploads/*.part` 可能残留），建议后续加启动清理/定期 GC。
5. **没有 HTTP multipart/下载接口**：当前只提供 MCP 分片上传；GUI 需要在 IPC 层自行分片。二进制文件没有下载端点，`read_chat_file` 只返回文本/图片。
6. **没有事件推送/已读工具**：`last_read_seq` 已入库但未暴露 `chat_mark_read`；实时刷新继续靠 `list_chat_messages(after_seq=...)` 轮询。
7. **审批门仍是 agent-honored**：引擎不能检查执行器内部命令；Claude 仍以 `--dangerously-skip-permissions` 运行。本次通过“禁止裸路径 + 按 agent 授权”降低了风险，但没有改变执行器权限模型。
8. **归档列表 limit 先于 active-first 排序**：`limit` 在 SQL 层应用，再在内存中把 active 排前；极大数量群聊时 archived 可能被 limit 截断。当前规模可接受，后续可改为分组查询。
9. **给已归档群发消息不会自动恢复**：消息仍可写入，但默认列表继续隐藏；需要显式 `chat_unarchive` 或 `include_archived=true` 查看。若产品希望“发言即恢复”，可加一条自动 unarchive 规则。
10. **旧调用方迁移**：使用 master token 且 `from=claude|dsh` 的外部脚本必须改用执行器 scoped token；`scripts/verify-chat-backend.mjs` 已作为参考实现更新。`docs/CHAT_BACKEND.md` 的“19 个工具”描述已被本报告取代。

## 11. 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MESSAGE_LIMIT` | 10 | 每子任务 thread 的 agent-to-agent 上限 |
| `AGENT_SUMMARY_MAX_TOKENS` | 500 | summary 预览 token 上限（body 不受限） |
| `CHAT_CONTEXT_TOKEN_BUDGET` | 6000 | 共享上下文 token 预算 |
| `CHAT_CONTEXT_MESSAGE_LIMIT` | 30 | 共享上下文最多消息数 |
| `CHAT_EPOCH_AGENT_BUDGET` | 20 | 每 epoch 执行器消息预算 |
| `CHAT_MAX_CAUSAL_DEPTH` | 16 | 因果深度上限（高于 10 条线程链） |
| `CHAT_BODY_MAX_CHARS` | 100000 | 单条 body 字符上限 |
| `CHAT_MAX_FILE_BYTES` | 20971520 | 单文件 20 MB |
| `CHAT_UPLOAD_CHUNK_BYTES` | 1048576 | 单分片 ≤1 MB |
| `CHAT_READ_MAX_BYTES` | 200000 | `read_chat_file` 默认文本返回上限 |
| `CHAT_TERMINAL_STATUS_TTL_MS` | 60000 | 终态状态展示 60 秒后回 idle |
| `WORKBENCH_CLAUDE_VISION` | true | Claude 可接收图片内容 |
| `WORKBENCH_DSH_VISION` | false | dsh 无视觉输入，返回明确说明 |

> 注意：`CHAT_MAX_CAUSAL_DEPTH` 必须 ≥ 10，否则会与“每子任务 10 条上限”冲突。当前默认 16。