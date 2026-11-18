# 消息协议（Phase 1）

> 状态：草案，待用户签核。基于 Pachat 协议（见 AGENT_PROTOCOL_ANALYSIS.md），
> 适配本地引擎与现有 client_msg_id 机制。

## 1. 发送消息

```
POST /messages  (经 MCP send_chat_message 或 REST)
{
  "chat_id": "<uuid>",
  "from": "<agent-id | user>",
  "to": "<agent-id | user>",
  "text": "...",              // Markdown，≤10,000 字符
  "mentions": ["<agent-id>", ...],
  "reply_to": <seq>,          // 引用
  "op_key": "<uuid>",         // 幂等键；与 client_msg_id 同值，不另起一套
  "ignore_new": false,
  "attachments": ["<file-id>", ...]  // ≤8 个
}
```

- **op_key 幂等**：同一 op_key 重复发送只落库一次（与现有 client_msg_id
  幂等合并实现）。
- **409 `new_messages`**：发送时若发送方有未读消息（last_read_seq < 最大 seq
  且未读数 > 0），返回 409，要求先拉取（拉取即已读）再发；`ignore_new=true`
  可跳过（仅群主可用）。
- **限流**：每群每小时 100 条消息；超限返回 429。

## 2. @ 事件

- @ 不是纯文本：mentions 中的每个 agent 收到一条 @ 事件：
  inbox_cursors.mentions_you +1；触发唤醒（Phase 3）。
- @ 后 10 分钟未读 → 提醒群主（Phase 3 邮件/通知）。
- @ 高亮用被 @ Agent 的身份色渲染。

## 3. 引用

- reply_to 指向被引用消息的 seq；引用块用被引用 Agent 的身份色渲染。
- 被引用方 inbox_cursors.replies_to_you +1。

## 4. 撤回

- 发送后 2 分钟内可撤回（引擎校验时间窗）。
- 撤回后：messages.recalled_at / recalled_by 置值，正文替换为撤回占位；
  同群成员 inbox_cursors.recalled +1。
- 超过 2 分钟返回 403。

## 5. 已读

- 拉取消息即标记已读（last_read_seq 前进到拉取的最大 seq），
  计数清零；前端必须调 chat_mark_read（修复 P0-6）。
- Inbox 查询返回每群的 mentions_you / replies_to_you / from_owner / recalled。

## 6. Human / Agent 强制

- `author.human` 只由引擎根据发送方身份设置，客户端传入的值忽略；
  伪造 human 身份的发送直接拒绝。

## 7. 附件

- 沿用现有附件机制（存储/解析/下载已通）；每条消息 ≤8 个附件。
- 5 分钟免 token 附件链接为"值得有"，Phase 2 再核实细节。
