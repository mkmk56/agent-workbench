# P0 身份隔离实施说明（P0_IDENTITY_ISOLATION.md）

> 范围：`src/**` 后端、测试、启动/凭据脚本、文档。前端 `gui/src/**` 未改动。
> 依据：`docs/REFACTOR_PLAN.md` §3.1（P0-1…P0-5 后端部分）、§5.2；`docs/ARCHITECTURE_AUDIT.md` §1.3/§4.2。
> 日期：2026-11-17。分支：`gui/group-chat-upgrade`。

## 1. 根因与修复边界

审计实证：Claude 执行器任务 `3345c285-…` 读取了仓库根 `workbench.env` 中的 `MCP_BEARER_TOKEN`，以 `from=user` 写入群聊（消息 `39f6a901-…`）并设置 `act_recipients=["dsh"]` 启动子任务（消息 `f5408486-…`）。两个渠道同时存在：

1. 执行器进程继承了引擎的 `process.env`（`MCP_BEARER_TOKEN`、`MCP_DATA_DIR`、`MCP_DB_PATH`）；
2. 执行器 `cwd` 固定为仓库根，`workbench.env` 就在那里。

修复同时堵住两个渠道，并把“身份”从单一 master token 拆成四类 principal。

## 2. 四类 principal

| token | 来源 | 可发送身份 | 可派发 | 可 `task_start`/`task_send` | 可 `respond_approval` | 备注 |
|---|---|---|---|---|---|---|
| `human` | `MCP_HUMAN_TOKEN`（独立随机值，存于 engine.env） | 仅 `user` | 否 | 默认否（`WORKBENCH_HUMAN_OPERATE=1` 可开） | 否 | GUI/人类客户端的目标 token |
| `muse` | `MCP_MUSE_TOKEN`（独立随机值，存于 engine.env） | 仅 `muse` | 是 | 否 | 否 | 强制 `client_msg_id` + 心跳 lease |
| `agent-task` | 引擎按任务签发，HMAC 签名 | 仅绑定 agent | 否 | 否 | 否 | 绑定 task/agent/chat/exp/scope；过期即失效 |
| `master`（过渡） | `MCP_BEARER_TOKEN` | 仅 `user` | 否 | 是 | 是 | 兼容一个版本；每次使用记 `deprecated-master-token` |

旧静态 agent token（`HMAC(master, "agent-token:<agent>")`）默认**拒绝**（`WORKBENCH_LEGACY_AGENT_TOKENS` 默认 `0`）；只有显式设为 `1` 才在过渡期启用，日志记 `deprecated-agent-token`。

human/muse **不再默认从 master 派生**。`MCP_HUMAN_TOKEN` / `MCP_MUSE_TOKEN` 由 `scripts/install-credentials.mjs` 生成 64 位十六进制随机值并写入 engine.env；两者与 master 相互独立。派生逻辑只保留为显式回滚开关：

```
WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1   # 仅回滚用，正常安装不要开启
human = HMAC-SHA256(MCP_BEARER_TOKEN, "principal-token:human")
muse  = HMAC-SHA256(MCP_BEARER_TOKEN, "principal-token:muse")
```

原因：旧实现里只要读到 master（执行器通过 `%APPDATA%` 可确定性推导 engine.env 路径），就能算出 muse token 并派发子任务、算出 human token 冒充用户。独立随机值切断了这条链；即使 master 泄漏，也不能派发、不能冒充 human/muse。

`node scripts/show-principal-token.mjs human|muse --yes` 从 engine.env/进程环境读取**存储值**并打印（不再派生；不写盘、不打日志；缺少时提示先运行 install-credentials）。

## 3. P0-1：切断 master token 可见性

### 3.1 执行器环境白名单

`src/executors/process.js:buildExecutorEnv()` 只复制运行所需的系统变量（Windows：`PATH`、`SystemRoot`、`ComSpec`、`TEMP`、`TMP` 等；POSIX：`PATH`、`HOME`、`TMPDIR` 等），再加上调用方显式提供的执行器变量。`MCP_BEARER_TOKEN`、`MCP_HUMAN_TOKEN`、`MCP_MUSE_TOKEN`、`MCP_DATA_DIR`、`MCP_DB_PATH`、`MCP_LOG_DIR`、`WORKBENCH_ENV_FILE`、`WORKBENCH_CLAUDE_ENV_JSON` 即使被误传也会被删除。

Windows 白名单额外移除了 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`USERNAME`，并把 `TEMP`/`TMP` 重定向到 **workspace 之外**的专属目录 `.tmp-sandbox`（默认 `<repo>/.tmp-sandbox`，与 `<repo>/workspace` 平级；可用 `WORKBENCH_EXECUTOR_TMP_DIR` 覆盖），否则 `%TEMP%` 本身就会暴露 `%LOCALAPPDATA%`。实测 claude 与 dsh 在移除这些变量后仍能完成真实任务。

> 限制（诚实记录，实测结论）：
> - `APPDATA` / `LOCALAPPDATA` 确实被移除；执行器不能再从这两个变量推导 `%APPDATA%\agent-workbench\credentials\engine.env`。
> - `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH` / `USERNAME` 确实从执行器 env 中消失：按真实执行器形态（非空 env、仅省略这四个键）spawn 的子进程实测四项全为 `null`（dsh 复审 2026-11-17 实测）。**但** `os.homedir()` 不依赖这些 env：Windows 上它在 env 缺失时回退到用户目录 API（Known Folder / `GetUserProfileDirectory`），仍返回 `C:\Users\<user>`。因此执行器仍可显式拼出 engine.env 路径并读取。
> - 结论：移除白名单变量只能减少“顺手可读”，**不能**声称“执行器物理上读不到 master 文件”。真正切断权限提升的是独立 human/muse token：master 泄漏不再等于 Muse 派发权，也不再能冒充 human/muse。要物理阻断同用户读取，需要独立 Windows 用户/容器/DPAPI + 启动期解密等 OS 级隔离（本批未做）。
> - `TEMP`/`TMP` 的重定向目标必须位于 dsh 的 sandbox workspace **之外**：Windows ACL 沙箱在 spawn 之前执行 `assertTempRootOutsideWorkspace`，若 temp root 在 workspace 之下，其子目录会继承 workspace 的常驻写权限，因此校验直接 fail-closed（`Windows ACL temp root must be outside the workspace`）。默认 `<repo>/.tmp-sandbox` 与执行器 workspace 平级；**不要**用 `WORKBENCH_EXECUTOR_TMP_DIR` 把它指回 workspace 内部。该前置校验不放宽。

`spawnProcess()` 不再使用 `{ ...process.env }`。

### 3.2 凭据文件移出仓库

- 新位置：`%APPDATA%\agent-workbench\credentials\engine.env`（POSIX：`~/.config/agent-workbench/credentials/engine.env`），可用 `WORKBENCH_ENV_FILE` / `WORKBENCH_CREDENTIAL_DIR` 覆盖。
- `src/credentials.js` 在 `config.js` 读取环境变量之前加载该文件；不覆盖调用方已设置的变量。
- 迁移脚本：`node scripts/install-credentials.mjs --remove-legacy`。它把仓库 `workbench.env` 合并写入新位置、收紧 ACL，并删除仓库副本；缺少 `MCP_HUMAN_TOKEN` / `MCP_MUSE_TOKEN` 时生成独立随机值，缺少 `WORKBENCH_LEGACY_AGENT_TOKENS` 时写入 `0`。
- 本次已执行迁移：仓库根 `workbench.env` 已不存在；`engine.env` 已补入独立 human/muse token 与 `WORKBENCH_LEGACY_AGENT_TOKENS=0`；生产引擎未重启，运行中的进程不受影响（重启后生效）。
- `scripts/sync-engine-token.mjs` 改为优先读取新位置，GUI 的 `engine-token` 仍可用。

### 3.3 ACL

`src/security.js:hardenPath()` 在 Windows 上执行 `icacls /inheritance:r`，只保留 `SYSTEM`、`Administrators`、当前用户；目录额外写入 `(OI)(CI)F` 继承项，递归时逐项收紧（避免 `icacls /T` 与继承标志组合导致子文件丢失 ACE）。已收紧：

- 新凭据目录与 `engine.env`
- `data/chat-files`（递归）
- 执行器 workspace（无 secrets）
- 每个任务的私有 MCP 配置目录

> 限制（诚实记录）：引擎与执行器运行在同一 Windows 用户下，ACL 只能隔离其他 OS 用户，不能阻止同一用户下的进程读取。真正阻断靠“环境白名单 + cwd 不含 secrets + 每任务短期 token + 不写共享静态配置”。

### 3.4 执行器 cwd

默认 cwd 改为 `config.executorWorkspace`（默认 `<repo>/workspace`，可用 `WORKBENCH_WORKSPACE_DIR` 覆盖）。`Scheduler.createTask`、群聊投递、legacy 投递都使用它。master 仍可在 `task_start` 显式传 `cwd`。

### 3.5 每任务 MCP 配置

`data/claude-mcp.json` / `data/dsh-mcp.json` 不再生成；新引擎启动时删除旧文件。本次已在无任务运行时手工删除生产盘上的这两个文件。`src/mcp-config.js:writeTaskMcpConfig()` 把配置写到 `%APPDATA%\agent-workbench\credentials\task-configs\<task_id>\<agent>.json`，文件 ACL 只保留当前用户/SYSTEM/Administrators；任务结束/取消/引擎关闭时删除。Claude 通过 `--mcp-config` 读取，dsh 通过 `WORKBENCH_MCP_CONFIG`/`WORKBENCH_MCP_TOKEN` 环境变量读取。token 不写入 task 行、prompt 或日志。

旧静态 agent token 默认拒绝：`WORKBENCH_LEGACY_AGENT_TOKENS` 默认 `0`，`identifyToken` 不再接受 `HMAC(master, "agent-token:<agent>")`。旧验证脚本如需在本地调试，必须显式让引擎以 `WORKBENCH_LEGACY_AGENT_TOKENS=1` 启动，或改用 per-task token。

## 4. P0-2：principal 拆分规则

- `human`：`resolveSender` 只允许 `from=user`；`act_recipients` 非空即拒绝；`task_start`/`task_send` 需 `requireOperator`（默认拒绝）；`respond_approval` 需 master（拒绝）。聊天 CRUD（创建/改名/归档）允许 human。
- `muse`：只允许 `from=muse`；`act_recipients` 允许；每次写入必须有 `client_msg_id`，且心跳 lease 未过期；不能 `task_start`/审批。
- `agent-task`：发送身份与 token 绑定的 agent 一致；`task_id` 必须等于 token 的 `tid`；`chat_id` 必须等于 token 的 `cid`；`assertChatAccess`/`accessibleChatIds` 也强制 chat 绑定（即使该 agent 是另一个 chat 的参与者，也不能读写）；`assertTaskAccess` 只允许绑定任务；不能派发/审批。
- 过渡 master：只允许 `from=user`（`WORKBENCH_LEGACY_MASTER_ALLOW_MUSE=1` 是 §5.2 回滚开关）；每次使用输出 `deprecated-master-token` 告警；`WORKBENCH_LEGACY_MASTER=0` 吊销。

## 5. P0-3：来源记录

`messages` 新增：

- `auth_kind`：`human | muse | agent:claude | agent:dsh`（内部自动回复记 `agent:<agent>`）
- `principal_id`：`user | muse | claude | dsh`
- `request_id`：HTTP `x-request-id` 或引擎生成的 UUID；内部自动回复为 `auto-reply:<task_id>`

`list_chat_messages` 与 `list_messages` 返回这三个字段。服务端每个工具调用输出一行审计日志：

```
tool=<name> request_id=<id> auth=<token_kind>:<participant> duration_ms=<n> result=<ok|error|摘要> params=<脱敏摘要>
```

`token`/`secret`/`password`/`authorization` 参数记 `<redacted>`，base64 `data` 只记长度。

投递历史：新增 `delivery_attempts` 表（`message_id`、`agent`、`attempt`、`status`、`task_id`、`error`、`created_at`）。`chat_deliveries` 保留当前状态，每次状态变化追加一条历史；`listMessageDeliveries` 附带 `attempt_count`/`first_attempt_at`/`last_attempt_at`/`finished_count`。

## 6. P0-4：Muse 身份可验证

- Muse 独立 token/principal；消息 `auth_kind=muse`。
- 心跳：`muse_presence` 表（`last_seen_at`、`lease_expires_at`）。Muse 调用任何读工具（`list_chats`、`chat_status`、`chat_get_context` 等）都会刷新 lease；写工具（`send_chat_message`/`send_message`）不会自刷新。显式工具：`muse_heartbeat`。
- 未在 lease 内的心跳 → `send_chat_message`/`send_message` 拒绝。
- `chat_status.agents.muse` 从“`idle|needs_reply` 推导”改为真实在线状态：
  - `online`：lease 有效且没有待回用户消息
  - `needs_reply`：lease 有效且 `needs_muse=true`
  - `offline`：lease 过期或从未心跳
  - 同时返回 `online`、`last_seen_at`、`lease_expires_at`、`needs_reply`
- 设计事实：Muse 不在本地建执行器、不伪造本地 Muse 任务；`task_id=NULL` 的 Muse 协调消息是设计如此（协调者不对应执行）。写入时必须带 `client_msg_id` 以支持重试幂等。

## 7. P0-5：附件契约（后端）

`list_chat_messages` 的每条消息改为：

```json
{
  "files": [
    { "file_id": "...", "name": "...", "mime": "...", "size": 123,
      "sha256": "...", "parse_status": "parsed", "parse_error": null }
  ],
  "legacy_paths": ["old/relative/path.pdf"]
}
```

- `files` 复用 `src/context.js:fileRef()`，并新增 `parse_error`。
- `legacy_paths` 是独立字段，只包含历史裸路径；不会被当作附件下载/预览。
- 历史消息若只有 `files_json` 中的 file_id 而缺少 `message_files` 行，会按 `chat_files` 解析成对象；无法解析的才是 legacy path。
- `docs/CHAT_BACKEND.md` 已同步。前端 `gui/src/types.ts` 属于 dsh 的任务范围，本次未改。

## 8. 迁移、回滚与部署

### 迁移（本次已做）

```bash
node scripts/install-credentials.mjs            # 写入新凭据位置、生成独立 human/muse token、收紧 ACL、写入 LEGACY_AGENT_TOKENS=0
node scripts/install-credentials.mjs --remove-legacy
```

数据库迁移是幂等的：`messages.auth_kind/principal_id/request_id` 用 `ALTER TABLE ADD COLUMN`；新表 `delivery_attempts`、`muse_presence` 用 `CREATE TABLE IF NOT EXISTS`。旧行新字段为 NULL，旧代码可忽略。

### 回滚（REFACTOR_PLAN §5.2）

1. **恢复 master 发 muse**：`WORKBENCH_LEGACY_MASTER=1` + `WORKBENCH_LEGACY_MASTER_ALLOW_MUSE=1`。
2. **恢复静态 agent token**：`WORKBENCH_LEGACY_AGENT_TOKENS=1`（默认已改为 `0`，必须显式开启）。
3. **取消 Muse 心跳强制**：`MUSE_REQUIRE_HEARTBEAT=0`。
4. **恢复仓库 env 文件**：把 `%APPDATA%\agent-workbench\credentials\engine.env` 复制回 `<repo>/workbench.env`（仅回滚用；会重新暴露给执行器）。
5. **恢复派生 principal token**：`WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1`（仅回滚；会重新打开 master → muse 派发链）。
6. **per-task token 签发失败**：仅在 `WORKBENCH_LEGACY_AGENT_TOKENS=1` 时，`scheduler.launch` 才回退到静态 scoped token 并写任务日志；默认配置下直接失败。

### 部署顺序

1. 后端（本批）→ staging 安全测试通过。
2. 更新 Muse 客户端：用 `node scripts/show-principal-token.mjs muse --yes` 读取**存储的** `MCP_MUSE_TOKEN`，每次写入带 `client_msg_id`，轮询 `list_chats`/`chat_status` 或调用 `muse_heartbeat`。重启后旧的派生 muse token 不再有效。
3. 更新 GUI：读取 human token（或暂时继续用 master）；若 GUI 需要 `task_start`，设置 `WORKBENCH_HUMAN_OPERATE=1` 或保留 master 到过渡期结束。
4. 重启生产引擎（本次未做；见汇报）。重启会加载新的独立 human/muse token、启用 `WORKBENCH_LEGACY_AGENT_TOKENS=0`、删除旧 `data/*-mcp.json`、收紧 ACL。
5. 过渡期结束：`WORKBENCH_LEGACY_MASTER=0`。

## 9. 验收测试

`test/security-isolation.test.js`（端到端，真实 HTTP MCP + 临时端口/数据目录）：

1. 执行器子进程 `MCP_BEARER_TOKEN`/`MCP_HUMAN_TOKEN`/`MCP_MUSE_TOKEN`/`MCP_DATA_DIR`/`MCP_DB_PATH` 为空；cwd 为 workspace；仓库 `workbench.env`、仓库真实 `data/claude-mcp.json`/`data/dsh-mcp.json` 读取返回 ENOENT；Windows 上 `APPDATA`/`LOCALAPPDATA` 为空，执行器无法用 `%APPDATA%\agent-workbench\credentials\engine.env` 推导真实 master 路径；`TEMP`/`TMP` 被重定向到 **executor workspace 之外**的专属目录（默认 `<repo>/.tmp-sandbox`，不再是继承的 `%LOCALAPPDATA%\Temp`），启动时创建，且测试断言重定向目标不在 executor workspace 之内（Windows ACL 沙箱的前置条件）。`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`/`USERNAME` 不在执行器 env 中（实测为 `null`）；测试只记录 `realMasterViaHome`——`os.homedir()` 会回退到 Windows 用户目录 API，仍能解析真实路径——不声称执行器物理读不到 master（见 §3.1 限制）。
2. 知道 master 也不能用 `HMAC(master, "principal-token:human|muse")` 登录；默认不派生，只有 `WORKBENCH_DERIVE_PRINCIPAL_TOKENS=1` 才启用。
3. 静态 agent token（`HMAC(master, "agent-token:<agent>")`）默认被拒绝（401）。
4. legacy master 只能 `from=user`；不能设置 `act_recipients`。
5. human 只能 `from=user`；不能派发；`task_start`/`respond_approval` 被拒；写入行 `auth_kind=human`、`principal_id=user`、`request_id` 等于请求头。
6. Muse 无心跳 → 写入被拒；无 `client_msg_id` → 被拒；心跳后可写；可派发；lease 过期后 `chat_status.agents.muse.status=offline`。
7. per-task agent token：只能以绑定 agent 身份发送；跨 task 被拒；**即使 agent 已是第二个 chat 的参与者，跨 chat 的读/写仍被 token 的 `cid` 绑定拒绝，`list_chats` 也不返回第二个 chat**；`respond_approval` 被拒；过期 token 在 initialize 阶段 401。
8. 消息来源字段齐全；`delivery_attempts` 记录 `pending → skipped`。

**未覆盖/不能声称的项：** 同一 Windows 用户下，执行器仍可通过 `os.homedir()` 或 Windows Known Folder API 得到用户目录并显式读取 `engine.env`（ACL 对同用户无效）。因此本批**不声称**“执行器物理上读不到 master 文件”；只声称“即使读到 master，也不能冒充 human/muse 或获得 Muse 派发权”，以及“执行器 token 无法调用 `respond_approval`”。要消除前者需要 OS 级隔离（独立用户/容器/DPAPI + 启动期解密）。

`npm test` 结果见本次提交的汇报（2026-11-17）。