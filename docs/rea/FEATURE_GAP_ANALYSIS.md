# 功能差距分析（Phase 0）

> 分析时间：2026-11-18 22:30
> 依据：ARCHITECTURE_AUDIT.md（我方现状）× PACHAT_RESEARCH.md（Pachat 能力）。
> 分级：**必须有**（Phase 2/3）、**值得有**、**暂缓**。
> 本文件是 Pachat REA 项目 Phase 0 的三份交付之一，
> 另两份为 ARCHITECTURE_AUDIT.md 与 PACHAT_RESEARCH.md。

## 1. 必须有（Phase 2/3）

| # | 能力 | Pachat 做法 | 我方现状 | 缺口 |
|---|---|---|---|---|
| 1 | 异构 Agent 接入协议 | 配对码（24h，≤10 Agent）或邮箱 /connect；token `pachat_...` 一次性展示；REST + MCP + CLI 三件套 | 只有 Claude/dsh 两个写死在代码里的本地执行器；Muse 无本地执行器 | 无通用接入协议：第三方 Agent 无法接入 |
| 2 | 每 Agent 独立 Inbox + 已读游标 | 每群返回 mentionsYou / repliesToYou / fromYourOwner / recalled 计数；拉取即已读 | P0-6 未读链断裂：`list_chats` 不返回 `unread`，前端从不调 `chat_mark_read`，`last_read_seq` 全为 0 | 正是 Pachat 有、我方缺的核心件；与深重构前端批合并做 |
| 3 | @ 作为真实事件投递 + 唤醒 | @ 是事件：投递 + 唤醒被 @ 的 Agent；@ 后 10 分钟未读发邮件给群主 | @ 只是文本提及，无事件、无唤醒 | @ 需升级为事件机制 |
| 4 | opKey + 409 + 2 分钟撤回 | opKey 幂等；发送时有未读返回 409 `new_messages`；2 分钟内可撤回 | client_msg_id 幂等已有；无 409 机制；无撤回 | 补 409 与撤回 |
| 5 | 群聊安全规则显性化 | Human 与 Agent 由服务端强制区分（`author.human` 只能服务端设置）；群主及其 Agent 可管理 | P0 身份隔离已做（per-task token、env allow-list），但群聊层的安全规则未显性化为产品规则 | 把已有隔离写成显性规则 + 群管理能力 |
| 6 | 多群聊 | 多群并存，每群 ≤50 成员 | 已有群聊升级（四人群聊），但多群聊的产品形态未完整 | 补多群管理、切换、每群独立 Inbox |
| 7 | Agent Profile Card | PATCH /me，简介 ≤300 字符；显示名 = 主人名 + 平台 | Agent 只有名字，无简介卡片 | 补 Profile Card（身份表 + 颜色映射见 §3） |

## 2. 值得有

| # | 能力 | 说明 |
|---|---|---|
| 1 | Listener + SSE + check-in 组合 | 单文件 CLI 持 SSE 长连接，本地 spawn Agent CLI；check-in 默认 10 分钟；每群一会话、可续接；15 分钟无输出 / 1 小时硬上限；每天 ≤100 次。对应我方 Phase 3 后台自主协作（Inbox / Check-in / Wake-up / Listener） |
| 2 | 好友 / 1:1 私聊 | Pachat 有好友系统与 1:1 聊天；我方只有群聊 |
| 3 | 角色 brief 模板库 | Pachat 的"角色"是 brief 模板（推荐三人组：研究 + 核查 + 反方）；我方可做成模板库，不做系统级角色 |
| 4 | 唤醒失败熔断 + 邮件提醒 | 失败重试 1 次；连续 3 次失败 → 唤醒禁用 + 邮件通知群主 |
| 5 | 结论卡片（decision widget） | 首页 Agreed / Not yet 样式；是否为真实功能未核实——按"结论卡片式交互"借鉴，不照抄 |
| 6 | 5 分钟免 token 附件链接 | 附件分享的轻量形态（待核实细节） |

## 3. 暂缓

| # | 能力 | 原因 |
|---|---|---|
| 1 | 公开社区 / 群组发现 | Phase 5 社区已定暂缓；且涉及中央服务器与内容可见性 |
| 2 | 多用户 / 多群主 | 单用户产品；多群主改变信任模型 |
| 3 | 跨账号好友 Agent | 依赖公开社区与跨账号信任 |
| 4 | 邮件唤醒 | 唤醒种类之一，优先级低于 Listener 与 check-in |

## 4. 我方已领先（不要丢）

| # | 能力 | 说明 |
|---|---|---|
| 1 | 真实执行 | Claude / dsh 在本地真实写代码、跑测试；Pachat 不执行代码 |
| 2 | 本地部署 + 数据主权 | 数据在自家机器；Pachat 消息过其中央服务器，团队可查看群组内容 |
| 3 | HUD / 审批门 / 结论卡片 / 任务状态机 | 产品级协作机制，Pachat 只有群聊 + 限流 + 指令 |
| 4 | 机制级安全 | P0 身份隔离、per-task token、env allow-list、防循环护栏；Pachat 的防刷主要靠限流与指令 |

## 5. 与深重构的合并点

- P0-6 未读链（本文件 §1 #2）= 深重构前端批的核心项，二者合并做，不跑两条线。
- P1-7 日志写放大、P1-3/4/6/8、前端 P1-9~P1-13、P2 与 REA Phase 2 范围
  高度重叠，在 Phase 1 目标架构中统一排期。
- 气泡身份色（用户已定方向：仅气泡用克制低饱和色）与 Pachat 的设计
  方向一致（身份色只作 tint / 细线 / 名字色），颜色映射应存入
  Agent 身份表（与 Profile Card 一起做）。

## 6. 下一步（Phase 1）

按用户 Q5 的决定：Phase 0 交付本文件 + 审计 + 研究 + 口头汇报后，
出目标架构（TARGET_ARCHITECTURE.md、DATABASE_DESIGN.md、MESSAGE_PROTOCOL.md、
AGENT_CONNECTOR_SPEC.md、SECURITY_DESIGN.md）待用户签核，签核后才写 Phase 2 代码；
重大取舍再 grill 一次。
