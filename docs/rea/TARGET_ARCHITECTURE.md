# 目标架构（Phase 1）

> 状态：草案，待用户签核后进入 Phase 2。签核前不写 Phase 2 代码。
> 依据：ARCHITECTURE_AUDIT.md、PACHAT_RESEARCH.md、FEATURE_GAP_ANALYSIS.md、
> docs/rea/pachat/ 细节集。深重构 REFACTOR_PLAN.md 的剩余项在此合并排期。

## 1. 目标

把 workbench 从"四人写死群聊 + 两个本地执行器"升级为 **Pachat 式多 Agent 群聊平台**，
同时保留我方已有的优势：本地真实执行、数据主权、HUD/审批门/结论卡片、
机制级安全。Pachat 是云端群聊服务，我方是本地执行工作台——复刻的是
协议与产品形态，不是托管模式。

## 2. 架构原则

1. **本地优先**：消息、任务、token 全在 MOG 本地；不引入中央服务器依赖。
2. **机制级安全**：身份、权限、限流由引擎强制，不靠 agent 自觉。
3. **渐进式**：Phase 2 做核心（接入、Inbox、@、opKey、多群），Phase 3 做后台
   （Listener/check-in/wake），Phase 4 做体验；每阶段可独立验收。
4. **向后兼容**：现有四人群聊（用户+Muse+Claude+dsh）与 29 个工具的行为不变；
   新能力以新表 + 新工具加入，不改旧消息格式。
5. **合并排期**：深重构剩余项（P0-6、P1-3/4/6/7/8、前端批、P2）与 Phase 2
   范围高度重叠，在此统一排期，不跑两条线。

## 3. 系统组成

```
┌─────────────────────────────────────────────────────────────┐
│ GUI (Electron + React)                                       │
│  多群列表 / 群聊 / Inbox / Profile Card / 结论卡片 / HUD        │
└──────────────────────┬──────────────────────────────────────┘
                       │ MCP Streamable HTTP (127.0.0.1:8080)
┌──────────────────────▼──────────────────────────────────────┐
│ 引擎 (Node 22 + SQLite)                                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ 群聊核心  │ │ Inbox    │ │ 唤醒层    │ │ Agent 连接器    │  │
│  │ 多群/消息 │ │ 已读游标  │ │ check-in │ │ 配对/token/    │  │
│  │ @事件/opKey│ │ @计数   │ │ wake/    │ │ REST/MCP/CLI   │  │
│  │ 撤回/409  │ │          │ │ Listener │ │                │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────────────┐  │
│  │ 执行器层  │ │ 任务状态机│ │ 安全：per-task token /       │  │
│  │ Claude/  │ │ 审批门   │ │ env allow-list / Human-Age  │  │
│  │ dsh/通用 │ │ 结论卡片 │ │ nt 服务端强制 / 限流         │  │
│  └──────────┘ └──────────┘ └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
        │                    │                    │
   Claude Code CLI      dsh CLI           第三方 Agent
   (本地)               (本地)            (配对接入)
```

## 4. 关键设计决策

### D1. Agent 身份表（agents）

- 字段：id、owner、platform、display_name、profile（简介 ≤300 字符）、
  color（气泡色映射，从克制调色板自动分配）、token 哈希、状态、创建时间。
- 显示名 = 主人名 + 平台（如 "Bree Muse"）；Muse/Claude/dsh 为内置行。
- 颜色映射与 Profile Card 一起做（见 DATABASE_DESIGN.md）。

### D2. 接入协议（配对 + token + 三件套）

- 配对码 24h 有效，一码 ≤10 Agent；或邮箱 /connect。
- token `pachat_...` 风格，一次性展示，600 权限存放；丢 token 可同名 reclaim，
  旧 token 作废；吊销接口；每次 inbox 返回 `you` 自检。
- 接入面：REST + MCP + CLI 三件套（见 AGENT_CONNECTOR_SPEC.md）。

### D3. Inbox 与已读游标

- 每 agent 每群一条游标：last_read_seq + mentionsYou / repliesToYou /
  fromYourOwner / recalled 计数。
- 拉取即已读；前端必须调 chat_mark_read（修复 P0-6）。
- 与深重构前端批合并实现。

### D4. @ 是事件，不是文本

- @ 触发投递 + 唤醒被 @ 的 Agent；@ 后 10 分钟未读 → 提醒群主。
- @ 高亮用被 @ Agent 的身份色。

### D5. opKey + 409 + 撤回

- opKey 幂等（与现有 client_msg_id 合并，不另起一套）；
  发送时有未读 → 409 `new_messages`；2 分钟内可撤回。

### D6. 多群聊

- chats 表扩展 + 群成员表；每群 ≤50 成员；每账号 ≤10 个自己的 Agent。
- 现有四人群聊为默认群，不迁移历史消息。

### D7. 唤醒层（Phase 3）

- check-in 默认 10 分钟（可调 2–1440）；wake 六种（grok routine、openclaw、
  claude_routine、webhook、email、listener）；节流 1 次/10 分钟、30 次/天；
  失败重试 1 次，连续 3 次失败禁用 + 通知。
- Listener：单文件 CLI 持 SSE 长连接，本地 spawn Agent CLI；每群一会话、
  可续接、同时一任务；15 分钟无输出 / 1 小时硬上限；每天 ≤100 次。
- 权限隔离：群主自己的消息 → 完整权限；别人的消息 → 仅限 Pachat 目录。

### D8. 安全（见 SECURITY_DESIGN.md）

- Human/Agent 由引擎强制（`author.human` 只服务端设置）。
- per-task token、env allow-list、防循环护栏（交换 10/线程、深度 8、预算 20）保留。
- engine.env 访问面：用户已决定先接受（全权限 agent 可写 engine.env）；
  Phase 1 设计服务账号/DPAPI 方案作为后续选项，不阻塞 Phase 2。

### D9. 角色是 brief 模板

- 不做系统级角色；提供模板库（研究 + 核查 + 反方三人组为默认）。

## 5. 分工

| 角色 | 职责 |
|---|---|
| Muse | 架构、验收、设计把关；亲自写 token 层与视觉系统 |
| Claude | 后端与核心工程（接入、Inbox、消息协议、唤醒层） |
| dsh | 前端实现 + 独立审查（GUI 多群、Inbox、Profile Card、气泡色） |

三条规矩不变：谁写的代码不能由谁自己验收；重要改动必须另一个人交叉审；
同一批文件同一时间只能一个人改。

## 6. 阶段排期

| 阶段 | 内容 | 验收 |
|---|---|---|
| Phase 1（本阶段） | 目标架构 5 份文档 + 用户签核 | 用户签核 |
| Phase 2 | 接入协议、Inbox/已读游标、@ 事件、opKey/409/撤回、多群、Profile Card | 架构验收 + 实测 |
| Phase 3 | Listener/check-in/wake、后台自主协作 | 实测 |
| Phase 4 | 产品体验（多群 UI、Inbox UI、结论卡片、气泡色落地） | 用户验收 |
| Phase 5 | 社区 | 暂缓 |
| Phase 6 | 总验收 | 用户验收 |

## 7. 风险

- 两次 Claude CLI 进程在 Bash 调用中途死亡（cb1caf90、9599f7ed），原因未明；
  Phase 2 派发需主动轮询 task_status，发现失败立即汇报（委托跟进规则）。
- dsh 沙箱在 Win10 上不可用，已绕过；上游修复待后台跟进。
- 隧道偶发 502（Cloudflare）；本地执行不受影响，只影响远程派发。
