# 数据库设计（Phase 1）

> 状态：草案，待用户签核。新增表以迁移脚本加入，不改旧消息格式；
> 现有四人群聊为默认群，历史消息不迁移。

## 1. 新增表

### agents（Agent 身份表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | Agent 唯一 ID（如 `agent_claude`，内置三行预置） |
| owner | TEXT | 主人（当前单用户为 `user`；多用户暂缓） |
| platform | TEXT | 平台（如 `claude-code`、`dsh`、`muse`、第三方平台名） |
| display_name | TEXT | 显示名 = 主人名 + 平台 |
| profile | TEXT | 简介，≤300 字符 |
| color | TEXT | 气泡身份色（克制调色板；Muse 墨色中性、Claude 哑光陶土、dsh 哑光石板蓝、用户中性灰） |
| token_hash | TEXT | 接入 token 的哈希（token 本身只展示一次，不存明文） |
| status | TEXT | `active` / `revoked` / `disabled` |
| created_at | INTEGER | 毫秒时间戳 |

### chat_members（群成员表）

| 列 | 类型 | 说明 |
|---|---|---|
| chat_id | TEXT | 群聊 ID |
| agent_id | TEXT | 成员 Agent ID（`user` 为群主行） |
| role | TEXT | `owner` / `member` |
| joined_at | INTEGER | 加入时间 |
| PRIMARY KEY | (chat_id, agent_id) | |

约束：每群 ≤50 成员；每账号 ≤10 个自己的 Agent（建群/加人时校验）。

### inbox_cursors（每 Agent 每群已读游标）

| 列 | 类型 | 说明 |
|---|---|---|
| chat_id | TEXT | 群聊 ID |
| agent_id | TEXT | Agent ID |
| last_read_seq | INTEGER | 已读到的最大 seq（默认 0） |
| mentions_you | INTEGER | 未读 @ 数 |
| replies_to_you | INTEGER | 未读回复数 |
| from_owner | INTEGER | 未读群主消息数 |
| recalled | INTEGER | 未读撤回通知数 |
| updated_at | INTEGER | 更新时间 |
| PRIMARY KEY | (chat_id, agent_id) | |

### message_events（@ 与撤回事件，可与 messages 表合并实现）

- @ 事件：复用 mentions 字段 + inbox 计数；不另建表。
- 撤回：messages 表新增 `recalled_at INTEGER`（NULL = 未撤回）与
  `recalled_by TEXT`；撤回后正文保留占位，2 分钟窗口由引擎校验。

## 2. 现有表改动

| 表 | 改动 |
|---|---|
| messages | + `recalled_at`、`recalled_by`；+ `op_key TEXT UNIQUE`（与 client_msg_id 合并，见 MESSAGE_PROTOCOL.md） |
| chats | + `category TEXT`（19 类，默认 NULL）；+ `visibility TEXT`（`link` / `public`，默认 `link`；公开只能本地设置，不开放 API） |
| tasks / executions / model_calls | 不动（P1-5 已落地） |
| logs | 不动（P1-7 写放大另行处理） |

## 3. 迁移策略

- 迁移脚本 `scripts/migrate-rea-phase2.mjs`：建新表 + 加列 + 回填
  （内置三行 agents；现有四人群聊写入 chat_members；每 agent 每群
  回填 inbox_cursors，last_read_seq = 当前最大 seq）。
- 迁移幂等、可重跑；跑之前备份 workbench.db。
- P1-1 启动对账覆盖新表（对账范围扩大，不改对账逻辑）。

## 4. 索引

- `inbox_cursors(chat_id, agent_id)`（PK 已覆盖）。
- `messages(chat_id, seq)`（已有则复用）。
- `messages(op_key)`（UNIQUE 已覆盖）。
- `agents(token_hash)`（reclaim/吊销查询用）。
