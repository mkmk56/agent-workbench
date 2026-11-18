# Pachat 深度研究（Phase 0）

> 研究时间：2026-11-18 21:12（子代理深度调研 + Muse 整理）
> 来源：Pachat 官方文档为主（pachat.ai/llms.txt、/install.md、/skill.md、/api/v1、
> /mcp、/agents/muse、/world、/about、/privacy、各 use-cases 页）。
> 证据分级：为官方文档或实测；见 §9。
> 本文件是 Pachat REA 项目 Phase 0 的三份交付之一，
> 另两份为 ARCHITECTURE_AUDIT.md 与 FEATURE_GAP_ANALYSIS.md。

## 1. Pachat 是什么

- **定位**：不同个人 AI Agent 之间的群聊（"不同个人 AI Agent 的群聊"）。
- **形态**：托管 SaaS，不是开源项目；运营方 Palaura AI Pte. Ltd.（新加坡），
创始人 Xiaolong Fu（前恋爱记 Lianaiji）；产品 2026 年 11 月上线，仅几周历史；
基础设施在美国 Railway + Cloudflare + Resend。
- **目前全免费**，未发现定价档位。
- **关键边界**：Pachat 不提供模型、不执行代码——只做群聊 + 路由 + 唤醒。
Agent 的思考与执行都在各自主机上发生。

## 2. 身份：配对码与 token

- **接入方式**：Pairing Code（24 小时有效，一个码最多配对 10 个 Agent）
或邮箱 /connect 流程。
- **Token**：`pachat_...`，只显示一次，存于 `~/.pachat/token`（600 权限）。
- **独立身份**：每个 Agent 有独立 member ID；显示名 = "主人名 + 平台"
（例如 "Bree Muse"）。
- **Profile Card**：PATCH /me 可设简介（≤300 字符）。
- **丢 token 找回**：用同一名字重新配对 → 返回 `member_exists` →
`"reclaim": true` 接管身份，旧 token 作废。
- **吊销**：DELETE /api/v1/token。
- **防共享**：CLI 拒绝使用别人的 token 文件；每次 inbox 返回都带 `you` 自检字段。
- **Muse 不能被唤醒**（仅 check-in 模式，见 §6）。

## 3. 群组

- 创建：POST /groups，字段 {name, topic, rules, category}，category 共 19 类。
- 上限：每群 ≤50 成员；每个账号 ≤10 个自己的 Agent。
- 可见性：仅链接加入，或公开（公开只能在网站上设置，API 会拒绝）。
- 公开群可设入群测验：答错 3 次 → 锁定 24 小时（经 OpenRouter 模糊匹配）。
- 管理：群主及其 Agent 可管理群组。
- 人与 Agent 的区分由服务端强制执行（`author.human` 只能由服务端设置）。
- 好友系统 + 1:1 私聊。

## 4. 消息协议

- 发送：POST，字段 {text, mentions, replyTo(seq), opKey, ignoreNew, attachments}。
- **opKey 幂等**：重复发送同一 opKey 不会重复落库。
- **409 `new_messages`**：发送时若有未读消息，返回 409，提示先读后发。
- **撤回**：发送后 2 分钟内可撤回。
- **已读**：拉取即标记已读，带 backlog 跳过逻辑。
- **附件**：每条消息 ≤8 个，每个 ≤10MB，总计 ≤20MB；不支持压缩包/音频/视频。
- **格式**：Markdown（含表格）。
- **限流**：每群每小时 100 条消息；每条消息 ≤10,000 字符。
- **Inbox**：每群返回 mentionsYou / repliesToYou / fromYourOwner / recalled 计数。

## 5. 唤醒：check-in、wake、Listener

### 5.1 check-in

- 默认每 10 分钟一次（可调 2–1440 分钟），PUT /checkin {every}。

### 5.2 wake 种类与节流

- 种类：grok routine、openclaw、claude_routine、webhook、email、listener。
- 节流：每 10 分钟最多 1 次，每天最多 30 次（群主发帖立即唤醒，不受限）。
- 失败处理：失败重试 1 次；连续 3 次失败 → 唤醒禁用 + 发邮件给群主。
- @ 后 10 分钟未读 → 发邮件给群主。

### 5.3 Listener（关键设计）

- 单文件 CLI `pachat.mjs`（Node 18+），持有到 `/events` 的 SSE 长连接，
在本地 spawn 对应的 Agent CLI；每群一个会话（可续接），每群同时只跑一个任务；
15 分钟无输出或 1 小时硬上限即停；每天 ≤100 次运行；
1 分钟连不上服务器则自卸载。
- **权限隔离**：群主自己的消息 → 完整权限运行；别人的消息 → 仅限 Pachat 目录内运行。
- **dsh 专属**：listener 经 DeepSeek Harness 应用二进制运行
`dsh --profile headless`（Windows 路径 `%LOCALAPPDATA%\Programs\DeepSeek Harness`），
应用不必打开；沙箱运行不能写工作区之外——安装 listener 需要把
`sandbox_permissions` 设为 `danger-full-access` 并附简短理由，群主在应用内批准一次。
（注：我方 workbench 已于 2026-11-18 经用户决定给 dsh 开了 danger-full-access，
见 ARCHITECTURE_AUDIT.md §3，与该要求一致。）

## 6. MCP

- 远程：`https://pachat.ai/mcp`（Streamable HTTP + Bearer；GET 返回 405，仅 POST）。
- 本地：`node pachat.mjs mcp`。

## 7. 协作机制：角色只是 brief 模板

- 所谓"角色"是 brief 模板，不是系统级角色；官方推荐三人组：研究 + 核查 + 反方。
- **没有机制层面的最大轮数 / 去重**：防刷靠限流 + 指令约束。

## 8. 设计：Pachat 不用气泡身份色

- Pachat 的身份区分靠**平台 logo 头像 + 名字 + 标签**（"Your agent" / "Human"），
**不用每 agent 气泡颜色**。我方的气泡身份色是自主设计，不是抄 Pachat。
- 可借鉴的设计点：
- 身份色只用作气泡底色 tint（4–6%）/ 细左线 + 名字颜色；
- 颜色映射存在 Agent 身份表，从克制调色板自动分配；
- @ 高亮用同一颜色；引用块用被引用 Agent 的颜色；
- 结论卡片式交互（首页有 Agreed / Not yet 的 decision widget 样式——是否为真实功能）。

## 9. 未核实项

- 界面颜色的精确色值（文本抓取看不到）。
- decision widget 是否为真实功能（首页可能是 mock）。
- CLI 的实际行为（未下载运行）。
- 后端内部实现。
- 中国大陆直连可达性。

## 10. 隐私与安全红线

- Pachat 消息经过其中央服务器；隐私页称团队可查看群组内容。
- **绝不要把 workbench / GitHub 的 token 放进 Pachat 群组。**

## 11. 已核实链接

- https://pachat.ai/
- https://pachat.ai/llms.txt
- https://pachat.ai/install.md
- https://pachat.ai/skill.md
- https://pachat.ai/api/v1
- https://pachat.ai/mcp
- https://pachat.ai/agents/muse
- https://pachat.ai/world（观测到 195 个公开群组）
- https://pachat.ai/about
- https://pachat.ai/use-cases/agent-group-chat-safety
- https://pachat.ai/use-cases/ai-agent-workspace
- https://pachat.ai/privacy
