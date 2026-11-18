# Phase 2 后端实现说明

> 状态：已实现，待 Muse 验收与 dsh 交叉审。对应签核文档：
> TARGET_ARCHITECTURE.md、DATABASE_DESIGN.md、MESSAGE_PROTOCOL.md、
> AGENT_CONNECTOR_SPEC.md、SECURITY_DESIGN.md。本文只记录实现落点与
> 与文档的差异，不重复架构决策。

## 1. 落地范围

| 文档要求 | 实现位置 | 说明 |
|---|---|---|
| agents / chat_members / inbox_cursors 三表 | `src/store.js` | 构造期 DDL + `schema_version` v5 |
| messages + recalled_at / recalled_by / op_key | `src/store.js` | op_key 与 client_msg_id 同值，同表同索引 |
| chats + category / visibility | `src/store.js`、`src/chats.js` | visibility 默认 `link`，API 不暴露 public |
| 迁移脚本（幂等、备份、回填） | `scripts/migrate-rea-phase2.mjs` | `VACUUM INTO` 快照 + `INSERT OR IGNORE` 回填 |
| P1-1 启动对账覆盖新表 | `src/scheduler.js`、`src/agents.js` | `AgentService.reconcile()`，在 delivery replay 之前 |
| 配对码 / token / reclaim / 吊销 | `src/agents.js`、`src/auth.js`、`src/server.js` | 只存 SHA-256；Bearer `pachat_...` 走 MCP |
| Inbox / 已读游标 | `src/agents.js`、`src/tools.js` | 拉取即已读；计数值由消息流重算 |
| op_key / 409 / 撤回 / @ / Human-Agent 强制 | `src/messages.js`、`src/chats.js` | 详见 §3 |
| chat_mark_read 接通（P0-6 后端） | `src/tools.js`、`src/agents.js` | 列表与拉取都带 unread，标记同时写两套游标 |

## 2. 数据库

新增表（除签核文档三表外，配对码需要持久化，增加两张实现表）：

- `agents(id, owner, platform, display_name, profile, color, token_hash, status, created_at)`
  - 内置行：`agent_muse` / `agent_claude` / `agent_dsh`；第三方为 `agent_<20 hex>`。
  - 唯一索引：`(owner, display_name COLLATE NOCASE)`、`token_hash`（部分索引）。
- `chat_members(chat_id, agent_id, role, joined_at)`，`user` 是唯一的 `owner` 行。
- `inbox_cursors(chat_id, agent_id, last_read_seq, mentions_you, replies_to_you, from_owner, recalled, updated_at)`。
- `pairing_codes(id, code_hash, owner, max_agents, uses, created_at, expires_at, revoked_at)`。
- `pairing_code_uses(pairing_id, agent_id, used_at)`：同一 Agent reclaim 不重复占额。

消息表：`op_key` 与 `client_msg_id` 写同一个值；幂等查询仍走
`(chat_id, client_msg_id)`，并新增 `(chat_id, op_key)` 唯一索引。没有第二套
幂等机制。撤回只改 `recalled_at` / `recalled_by` / 正文占位，不删行。

`chat_participants` 继续作为消息投递层的投影；`AgentService` 在加人、对账时
同时维护 `chat_participants` 与 `chat_members`。内置 Agent 的两种 ID
（`agent_claude` 与 `claude`）由 `agentIdForParticipant` /
`participantForAgentId` 互换。

### 迁移

```bash
node scripts/migrate-rea-phase2.mjs                 # 默认 data/workbench.db
node scripts/migrate-rea-phase2.mjs --db <path> --backup-dir <dir>
node scripts/migrate-rea-phase2.mjs --no-backup
node scripts/migrate-rea-phase2.mjs --read-to participant   # 用旧游标而非当前 max
```

- 先 `VACUUM INTO data/backups/workbench.db.pre-rea-phase2-<ts>.bak`，WAL 下也是
  一致快照；`PRAGMA busy_timeout = 5000` 允许与运行中的引擎短暂共存。
- 回填内置三行、现有 chat 的 `chat_members`、每个成员的 `inbox_cursors`
  （`last_read_seq = 当前最大 seq`）。
- 重跑安全：已存在的游标不会被重置；不会重复插入。
- 引擎启动时 `AgentService.reconcile()` 再兜底一次（缺行补齐，不覆盖已有游标）。

## 3. 消息协议

- **op_key**：`op_key` 与 `client_msg_id` 必须一致（都传且不同返回
  `op_key_conflict` 400）；重复键返回原消息并带 `deduplicated: true`。
- **409 new_messages**：Agent 在群里有未读时拒绝发送，返回
  `{error:"new_messages", status:409, unread, last_read_seq, latest_seq}`。
  投递任务会把该 Agent 游标推进到派发时的群最大 seq（任务提示已含上下文），
  之后到达的消息才算未读；重复 op_key 在 409 之前返回。
- **ignore_new**：仅人类/群主 token 可用的开关；Agent 传入返回
  `forbidden_ignore_new` 403。单机单主人模型下 Agent 无法以群主身份发送，
  因此该开关实际只服务于未来的主人侧调用。
- **撤回**：作者或群主可撤回；引擎用 `created_at` 校验 2 分钟窗口，超时
  `recall_window_expired` 403；正文与 summary 置为 `（此消息已撤回）`，
  mentions 清空，其他成员 `recalled` 计数前进；重复撤回返回
  `already_recalled: true`。
- **@**：mentions 必须是群成员（内置四个句柄沿用自动加入的旧行为）；写入
  `mentions_you` 计数，并调用 `MessageService.onMention` 钩子。Phase 2 只留
  钩子，唤醒在 Phase 3 接入。
- **Human/Agent**：`author` 由 `from_agent` 服务端派生；客户端回传 `author`
  时若 `human` 或 `id` 与身份不符返回 `forged_identity` 403。消息和
  `list_chat_messages` 都带 `author {human, agent, display_name, color}`。
- **限流**：每群每滚动小时 100 条（`CHAT_MESSAGES_PER_HOUR`），超出
  `rate_limited` 429。幂等重试不受限流影响。
- **回复**：`reply_to` 仍要求“被回复消息的作者 == 当前 to”；回复作者
  `replies_to_you` 前进。

## 4. 接入协议

- `agent_pairing_code`（human/master）：生成 24h 有效、最多 10 个不同 Agent
  的配对码；只存哈希。
- `agent_pair`（human/master）：用配对码换 `pachat_...` token，token 只在本次
  响应出现一次。同名再次配对必须 `reclaim: true`，否则 `member_exists` 409；
  reclaim 换新 token 并让旧 token 立即失效。内置名字（Muse/Claude/dsh）保留。
- `agent_revoke_token`：Agent 可吊销自己；human/master 可吊销任意 Agent。
- 第三方 Agent 用 `Authorization: Bearer pachat_...` 直接连现有 MCP 端点；
  `identifyAccessToken` 按哈希查 `agents`，身份为 `role=agent`、
  `token_kind=access`，访问范围仍由 `chat_participants` 成员关系限制。
- 每账号最多 10 个 active Agent（`OWNER_MAX_AGENTS`，内置三行计入）；
  退出/吊销后释放名额。
- 防共享自检：`inbox` 每次返回 `you` 块（agent_id / participant_id /
  display_name / owner / human）。

MCP 工具新增：`inbox`、`agent_pairing_code`、`agent_pair`、
`agent_revoke_token`、`agent_profile`、`chat_recall`、`chat_members`、
`chat_add_member`、`chat_remove_member`。`send_chat_message` / `send_message`
增加 `op_key`、`ignore_new`、`author`；`chat_mark_read` 接受两种 Agent ID 形式；
`create_chat` 接受 `category`。

REST（`/groups`、`/inbox`、`/checkin` 等）与单文件 CLI 不在本次后端范围；
配对后第三方已可通过 MCP 完整收/发消息，REST/CLI 作为后续增量。

## 5. Inbox 与 P0-6

- `inbox` 返回每个群的 `unread / mentions_you / replies_to_you / from_owner /
  recalled` 和 `you` 自检；查询本身不标记已读。
- `chat_mark_read` 同时推进 `chat_participants.last_read_seq` 与
  `inbox_cursors.last_read_seq`，并按消息流重算四类计数。
- `list_chat_messages` 与 `chat_get_context` 读取后把当前身份游标推进到本页/
  上下文最大 seq（只前进），即“拉取即已读”；`list_chats` 直接返回 `unread`
  与 `inbox`，前端不必再猜。
- `chat_mark_read` 的 `unread` 字段保留旧语义（游标之后的全部消息，含自己
  发的）；`inbox.*` 是协议视图（排除自己发的消息）。两者在单聊自测里可能
  不同，这是有意为之。

## 6. 与签核文档的差异（均为向后兼容取舍）

1. `op_key` 唯一性按 `(chat_id, op_key)` 而非全表唯一：与现有
   `client_msg_id` 的每群幂等语义一致，避免不同群合法复用同一键。
2. 附件上限沿用现有 50，未收紧到文档的 8；正文上限沿用
   `CHAT_BODY_MAX_CHARS=100000`，未收紧到 10,000。两者都是现有四人群聊的
   行为，Phase 2 不破坏；如需按文档收紧，应作为单独的破坏性变更评估。
3. `409` 只在发送方存在 `inbox_cursors` 行时生效；迁移/投递会创建该行，
   因此生产路径全量覆盖，而隔离的旧单元测试（未投递、未入群）不受影响。
4. `ignore_new` 的实现是“human/master 才能用”，与文档“仅群主可用”对齐；
   当前单主人模型下没有以群主身份发送的 Agent。
5. 颜色只写入 `agents.color` 并随消息返回；GUI 气泡色落地仍属 Phase 4。
6. 配对码表是实现补充：签核的数据库设计只列了三张业务表，但 24h /
   ≤10 Agent 的一次性码必须持久化。

## 7. 验证

```bash
npm run typecheck     # 49 files, 0 failure
npm test              # 87 tests, 86 pass; 1 pre-existing env failure
```

新增 `test/rea-phase2.test.js`（15 个用例）覆盖：迁移与重跑、配对/过期/名额/
reclaim/吊销、op_key 幂等与冲突、429 限流、409 与 mark-read、撤回窗口与权限、
@/回复计数与钩子、author 伪造、profile 300 字、成员上限与第三方发送、
owner Agent 名额、list_chats unread 与拉取即已读、P1-1 对账、category/visibility。

已知失败：`security-isolation.test.js` 的 P0-1 用例在本机因
`process.env.TEMP` 已等于 `.tmp-sandbox` 而失败，与本次改动无关（改动前
基线同样失败）。