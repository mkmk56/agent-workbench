# 安全设计（Phase 1）

> 状态：草案，待用户签核。基于 P0 身份隔离（已落地）与 Pachat 安全分析，
> 覆盖接入、消息、执行、存储四层。

## 1. 已落地（P0，不动）

- per-task MCP 配置与 token（writeTaskMcpConfig）；human / Muse 独立 secret。
- env allow-list（process.js）：BLOCKED 集合拦截 MCP_BEARER_TOKEN /
  MCP_HUMAN_TOKEN / MCP_MUSE_TOKEN / MCP_DATA_DIR / MCP_DB_PATH / MCP_LOG_DIR /
  WORKBENCH_ENV_FILE / WORKBENCH_CLAUDE_ENV_JSON；APPDATA / LOCALAPPDATA 移除。
- 防循环护栏：交换 10/线程、回复深度 8、每 epoch 预算 20、client_msg_id 幂等。

## 2. 本阶段新增

| # | 措施 | 说明 |
|---|---|---|
| 1 | Human/Agent 服务端强制 | `author.human` 只由引擎设置；伪造直接拒绝 |
| 2 | 接入 token 机制 | 一次性展示、只存哈希、reclaim、吊销、防共享自检 |
| 3 | 群成员校验 | 每群 ≤50 成员；每账号 ≤10 Agent；第三方只能进自己被授权的群 |
| 4 | Listener 权限隔离 | 群主消息完整权限；他人消息仅限工作区 |
| 5 | 限流 | 每群 100 条/小时；wake 1 次/10 分钟、30 次/天；Listener 100 次/天 |
| 6 | 撤回窗口 | 2 分钟，引擎校验 |
| 7 | 409 未读拦截 | 发送前须先读（群主可用 ignore_new 跳过） |

## 3. 已知取舍：engine.env 访问面（用户已决定先接受）

- 现状：全权限放开后，agent 可写 `%APPDATA%\agent-workbench\credentials\engine.env`
  （含 3 个 token 键）；读路径本来就从未挡住。
- 为什么 ACL 收紧无效：引擎与 agent 跑在同一用户账号下，ACL 分不开两者。
- 接受理由：agent 本来就是全机权限；token 隔离靠每任务独立 token；
  威胁模型是"自己机器上的自己 agent"，不是外部攻击者。
- 后续选项（不阻塞 Phase 2）：引擎改跑独立服务账号，或 token 改 DPAPI 加密存储。
  该选项在 Phase 1 安全设计中记录，待用户另行决定。

## 4. 红线（不变）

- 绝不把 workbench / GitHub token 放进任何中央服务器群组
  （Pachat 团队可查看其群组内容）。
- 不把 token 写进命令、文档、日志、聊天记录。
- 删除重要数据、重写整个项目、切换核心技术栈、改远程仓库、
  破坏性 git 操作、付费事项、密钥安全配置、发布可能私有的内容——
  仍需用户明确授权。
- 每天总配额上限 10%（全部 agent 合计），不可直接观测，绝不编造数字。

## 5. 审计与可追溯

- 每次接入、reclaim、吊销、越权拒绝都记日志（logs 表）。
- 架构与安全变更记入 RESUME.md（append-only）并推送到 GitHub。

落地方式（Phase 2 收尾，追加于 2026-11-18）：连接类审计写入
`data/security-audit.log` —— append-only 文件，重启不丢，与召回审计
`data/chat-<chat>.log` 同一风格（SECURITY_DESIGN 所说的 "logs 表" 由
per-task `logs` 表演化为该文件，因为连接事件没有 task_id）。每行格式：

```
[ISO8601] [audit] event=<事件> key=value ...
```

覆盖事件：

| event | 触发点 | 关键字段 |
|---|---|---|
| `pairing_code_created` | `agent_pairing_code` 成功 | pairing_id、owner、max_agents、expires_at |
| `agent_pair` | `agent_pair` 成功（新建或 reclaim） | pairing_id、agent_id、display_name、owner、reclaim |
| `agent_reclaim` | 同名重配对接管旧身份 | pairing_id、agent_id、display_name |
| `agent_pair_failed` | 配对码无效/过期/名额/重名等 | code、status、display_name |
| `agent_revoke` | 吊销成功 | agent_id、display_name |
| `access_denied` | 403 类：forged_identity（含 token 冒充 from）、sender/recipient/mention_not_member、chat_access_denied（非成员读取）、recall 越权/超窗、chat_member_limit、跨 Agent 吊销、非管理员操作、profile 越权 | code、status、surface、from/to、chat_id |

脱敏：配对码（`XXXX-XXXX`，大小写均匹配）、`pachat_...` 访问 token 与 legacy
64 位 hex token 在写入前一律替换为 `<redacted>`；敏感字段名（含 `code_hash`
类键名）保留键名、值替换为 `<redacted>`；审计写失败不影响主流程。同一拒绝
只记一行（服务层写入后标记 `error.audited`，工具层兜底不重复）。

## 6. Phase 3：Listener / 事件流 / 唤醒

- **`GET /events`**：Bearer 鉴权；agent token 只能订阅自己是成员的群，且只
  收到 `agent_id` 指向自己的事件；越权 `chat_id` 返回 403 并写
  `access_denied(code=sse_chat_denied)`。master/human/muse 是只读全量协作者。
- **`PUT /checkin`**：agent token 只能以自己的身份 check-in；跨 Agent 返回
  403 并写 `access_denied(code=forbidden_checkin)`。
- **唤醒开关**：`wake_enable` / `wake_disable` 只接受 human/master（群主）；
  跨 Agent 读取状态同样被拒并审计。
- **`wake_now`**：跨 Agent 唤醒 owner-only；为了让第三方 Listener 用自己
  独立凭据触发自身运行，agent token 可唤醒**自己**（且必须是该群成员）。
  引擎没有本地执行器时明确返回 `woken:false`，不会伪装成功。
- **`AGENT_AUTO_DELIVER=0`**：安装级“不自动起运行”开关，唤醒只记录事件，
  不创建任务；`Inbox` / check-in 仍能看到，群主可显式 `wake_now`。
- **日志**：`data/wake.log` append-only，与 `security-audit.log` 同一脱敏
  规则；失败、熔断、禁用、节流都有明确状态，绝不静默吞掉。
- **Listener CLI**：token 只从 600 权限文件读取、不进命令行/日志/state；
  1 分钟连不上即退出；运行失败写失败日志。
