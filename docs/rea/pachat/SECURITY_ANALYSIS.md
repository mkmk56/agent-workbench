# Pachat 安全分析

> 依据：官方文档 /privacy、/use-cases/agent-group-chat-safety、/api/v1、/skill.md（2026-11-18）。

## 1. 身份与 token

| 机制 | 内容 | 评价 |
|---|---|---|
| 配对码 | 24h 有效，一码 ≤10 Agent | 短期有效，合理 |
| token 存储 | `~/.pachat/token`，600 权限，只显示一次 | 合理 |
| token 丢失找回 | 同名重配对 → `member_exists` → `"reclaim": true` 接管，旧 token 作废 | 合理；接管需同名，防冒名有限 |
| 吊销 | DELETE /api/v1/token | 有 |
| 防共享 | CLI 拒绝别人的 token 文件；inbox 带 `you` 自检 | 客户端防线，可绕过（非服务端强制） |

## 2. Human 与 Agent 的区分

- **服务端强制**：`author.human` 只能由服务端设置，客户端无法伪造身份。
- 这是 Pachat 安全设计中最硬的一条：群聊里"谁是人"由服务器说了算。

## 3. Listener 权限隔离

- 群主自己的消息 → 完整权限运行。
- 别人的消息 → 仅限 Pachat 目录内运行。
- dsh 上安装 listener 需 `sandbox_permissions` = danger-full-access，
  群主在应用内批准一次（显式授权点）。

## 4. 群组管理

- 群主及其 Agent 可管理群组。
- 公开群入群测验：答错 3 次 → 锁定 24 小时（OpenRouter 模糊匹配）。

## 5. 隐私红线（最重要）

- **消息经过 Pachat 中央服务器；隐私页称团队可查看群组内容。**
- 因此：**绝不要把 workbench / GitHub token、密钥、敏感文件放进 Pachat 群组。**
- 我方 workbench 的数据主权（本地 SQLite、本地执行）是相对优势，
  Phase 2/3 借鉴 Pachat 协议时不得引入中央服务器依赖。

## 6. 与我方 P0 身份隔离的对照

| 维度 | Pachat | 我方 workbench |
|---|---|---|
| 身份伪造防护 | 服务端设 `author.human` | per-task token + env allow-list（P0） |
| token 隔离 | 每 Agent 独立 token | 每任务独立 MCP 配置与 token |
| 执行隔离 | Listener 按消息来源分权限 | dsh 曾用受限令牌沙箱（Win10 上不可用，已改 danger-full-access）；Claude 全权限 |
| 防刷 | 限流（100 条/群/小时）+ 指令 | 交换上限 10/线程、回复深度 8、每 epoch 预算 20（机制级） |
| 数据可见性 | 中央服务器可见群组内容 | 本地；仅群主可见 |

## 7. 我方 Phase 1 安全设计要点（预告）

- 接入协议必须包含：配对、token 一次性展示、reclaim、吊销、防共享自检。
- Human/Agent 区分必须服务端（引擎）强制，不依赖客户端自报。
- Listener 式唤醒必须按消息来源分权限（群主消息 vs 他人消息）。
- 不得把任何 token 或密钥放进可被中央服务看到的通道。
