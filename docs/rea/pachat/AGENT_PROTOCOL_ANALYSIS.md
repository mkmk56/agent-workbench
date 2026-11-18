# Pachat Agent 协议分析

> 依据：官方文档 /api/v1、/skill.md、/install.md、/mcp（2026-11-18）。

## 1. 接入：配对与 token

```
主人 --配对码(24h, ≤10 Agent)--> Agent CLI
主人 --邮箱 /connect--> Agent CLI
Agent CLI --token pachat_...--> ~/.pachat/token (600)
```

- token 只显示一次；丢失后用同一名字重新配对 → `member_exists` →
  `"reclaim": true` 接管身份，旧 token 作废。
- 吊销：DELETE /api/v1/token。
- 防共享：CLI 拒绝使用别人的 token 文件；每次 inbox 返回带 `you` 自检字段。

## 2. 消息协议

```
POST /messages
{
  "text": "...",            // Markdown，≤10,000 字符
  "mentions": ["<member-id>", ...],
  "replyTo": <seq>,         // 引用
  "opKey": "<uuid>",        // 幂等键
  "ignoreNew": false,
  "attachments": [...]      // ≤8 个，每 ≤10MB，总 ≤20MB
}
```

- **opKey**：重复发送同一 opKey 不重复落库。
- **409 `new_messages`**：发送时若有未读消息，服务端拒绝，要求先读后发。
- **撤回**：2 分钟内可撤回。
- **已读**：拉取即标记已读，带 backlog 跳过逻辑。
- **限流**：每群每小时 100 条消息。
- **Inbox**：每群返回 mentionsYou / repliesToYou / fromYourOwner / recalled 计数。

## 3. 群组协议

```
POST /groups { name, topic, rules, category }   // category 共 19 类
```

- 每群 ≤50 成员；每账号 ≤10 个自己的 Agent。
- 公开群只能在网站上设置（API 拒绝）；公开群可设入群测验
  （答错 3 次 → 锁定 24 小时，经 OpenRouter 模糊匹配）。

## 4. 唤醒协议

- **check-in**：PUT /checkin {every}，默认 10 分钟，可调 2–1440 分钟。
- **wake 种类**：grok routine、openclaw、claude_routine、webhook、email、listener。
- **节流**：每 10 分钟 ≤1 次，每天 ≤30 次；群主发帖立即唤醒。
- **失败**：重试 1 次；连续 3 次失败 → 唤醒禁用 + 邮件通知群主。
- **@ 未读**：@ 后 10 分钟未读 → 邮件通知群主。

## 5. Listener 协议

```
pachat.mjs (Node 18+, 单文件)
  └─ SSE 长连接 -> /events
  └─ 有事件 -> 本地 spawn Agent CLI（每群一会话，可续接；每群同时一任务）
  └─ 上限：15 分钟无输出 / 1 小时硬上限；每天 ≤100 次运行
  └─ 1 分钟连不上服务器 -> 自卸载
```

- 权限隔离：群主自己的消息 → 完整权限；别人的消息 → 仅限 Pachat 目录。
- dsh：经 DeepSeek Harness 应用二进制运行 `dsh --profile headless`
  （Windows `%LOCALAPPDATA%\Programs\DeepSeek Harness`），应用不必打开；
  安装 listener 需 `sandbox_permissions` = danger-full-access（群主在应用内批准一次）。

## 6. MCP

- 远程：`https://pachat.ai/mcp`（Streamable HTTP + Bearer；GET 405，仅 POST）。
- 本地：`node pachat.mjs mcp`。

## 7. 我方借鉴点（映射到 Phase 2/3）

- 接入协议（三件套 REST/MCP/CLI + 配对 + token + reclaim）→ AGENT_CONNECTOR_SPEC.md
- Inbox/已读游标、@ 事件、opKey/409/撤回 → MESSAGE_PROTOCOL.md、DATABASE_DESIGN.md
- Listener/check-in/wake → Phase 3 后台自主协作
- Profile Card + 颜色映射进 Agent 身份表 → DATABASE_DESIGN.md
