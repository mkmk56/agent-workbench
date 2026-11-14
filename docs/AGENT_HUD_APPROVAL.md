# Agent HUD 第二期：引擎聊天式审批（默认关）

> 版本：v1 · 2026-11-14
> 范围：只做引擎机制；不做 GUI、侧栏、纸飞机、结论卡片界面、设置页（设置页 UI 属第五期）。
> 默认关闭。关闭时行为与第一期完全相同：全自动、不停、不问。

---

## 1. 一句话

打开 `AGENT_APPROVAL_GATE=1` 后，agent 在执行**合并代码、删文件、装依赖**这三类关键操作前，必须先在聊天里问用户；线程进入 `WAITING_USER`，用户用「允许一次 / 这个会话内允许 / 拒绝」回答后，agent 自动继续或停下。审批提问走第一期的 `send_message` / `list_messages` / `reply_to` 消息协议。

---

## 2. 关键操作清单（代码与文档同源）

清单定义在 `src/approvals.js` 的 `APPROVAL_CATEGORIES`，文档与提示词都引用同一份定义。只有三类：

### 2.1 `merge` — 合并代码 / 集成或发布代码

**需要审批**

- `git merge`、`git rebase`、`git cherry-pick`
- `git push`（包括 `--force`、`--force-with-lease`、`--tags`）
- `git pull` 且会产生 merge / rebase（推荐用 `git pull --ff-only`）
- `gh pr merge`，或通过 API 合并 Pull Request

**不需要审批**

- `git fetch`、`git pull --ff-only`、`git status/diff/log/show`
- `git add`、`git commit`、创建/切换分支、`git stash push/pop`
- 分支已经 push 过之后 `gh pr create`
- `git revert` 单个本地提交

### 2.2 `delete` — 删文件 / 丢弃已有内容

**需要审批**

- `rm`、`rm -rf`、`rmdir`、`del`、`erase`、`rd`、`Remove-Item`，以及脚本里的 `unlink` / `rmtree`
- `git rm`、`git clean -fd/-fdx`、`git reset --hard`、`git checkout -- <path>`、`git restore <path>`
- `git stash drop/clear`、`git branch -d/-D`、`git tag -d`、`git push --delete`
- 用 shell 重定向整文件截断/覆盖（`> file`、`Set-Content`、`Out-File -Force`）
- `DROP TABLE`、`TRUNCATE TABLE`、没有 `WHERE` 的 `DELETE FROM`

**不需要审批（边界）**

- `node_modules/`、`dist/`、`build/`、`out/`、`coverage/`、`.cache/`、`tmp/`、`temp/`、系统临时目录下的路径
- 当前任务自己创建的临时文件；清空当前任务刚创建的文件
- 通过编辑器 / apply-patch 做的正常修改（不是删除）
- `git stash push/pop`、带 `WHERE` 的普通行删除

### 2.3 `dependencies` — 装依赖 / 改依赖声明

**需要审批**

- `npm install <pkg>`、`npm uninstall`、`npm update`、`npm audit fix`
- `pnpm add/remove/update`、`yarn add/remove/upgrade`、`bun add/remove`
- `pip install/uninstall`、`poetry add/remove/update`、`uv add/remove`
- `cargo add/remove/update`、`go get`、`dotnet add package`、`composer require/remove`
- `gem install`、`winget/choco/scoop install`（含全局安装）
- 修改依赖声明或 lockfile：`package.json` 的 deps/devDeps/optionalDeps/peerDeps/overrides/resolutions、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`requirements.txt`、`poetry.lock`、`Cargo.toml` 依赖段 / `Cargo.lock`、`go.mod` / `go.sum`、`*.csproj` 的 `PackageReference`

**不需要审批**

- `npm ci`、`pnpm install --frozen-lockfile`、`yarn install --frozen-lockfile`（按 lockfile 精确还原）
- `npm test`、`npm run <script>`、`npx <tool>`（不改项目 manifest）
- `npm ls`、`npm outdated`、`pip list`、读取 manifest/lockfile
- 修改 `package.json` 里的非依赖字段（例如 `scripts`、`version`）

> 边界有争议时按更严格的一侧处理：不确定是否属于关键操作，就问。

---

## 3. 提问格式

审批提问是一条普通线程消息：`from = agent`、`to = user`、`reply_to = null`、`status = stored`。消息的 `summary` 以卡片前缀开头：

```
[Agent HUD · 来自 <agent> · <task> <message-id>] 关键操作需要你的批准
类别：<category>（<中文类别>）
想做什么：<action>
命令：<command，若提供>
涉及文件：
- <file 1>
- <file 2>
为什么：<reason>
请三选一回复：允许一次 / 这个会话内允许 / 拒绝（approval_id=<uuid>）
```

- `<task>`：调用方可用 `task` 字段传入短标签；未传时取任务 prompt 第一行（最多 80 字符）。
- `<message-id>`：消息协议生成的服务端 UUID；先预生成再写入，因此卡片前缀里的 id 与 `messages.id` 一致。
- 完整文件清单同时写入消息的 `files` 数组（最多 100 项）；卡片正文只列前 8 项，超出会写“另有 N 个文件”。
- `question` 字段独立保存三选一说明，不依赖 summary 是否被 500 token 上限截断。
- summary 仍受第一期的 `AGENT_SUMMARY_MAX_TOKENS`（默认 500）约束；超长会截断并记录 `summary_truncated`。关键信息（谁、类别、做什么、为什么、approval_id）放在前面，文件全量在 `files`。

---

## 4. 用户回复与状态机

### 4.1 三种回复

| 回复 | `respond_approval` 参数 | 行为 |
|---|---|---|
| 允许一次 | `decision: "once"` | 只允许本次请求；同一会话同类别下次还要问 |
| 这个会话内允许 | `decision: "session"` | 允许本次，并在当前 `thread_id` 内对该类别后续操作不再提问 |
| 拒绝 | `decision: "deny"` | 不执行该操作；agent 收到 `allowed:false, stop:true` 后停止 |

用户也可以直接在聊天里回复 `send_message`（`from:"user"`，`reply_to` 指向审批消息）。引擎解析中文/英文关键字：

- 允许一次：`允许一次`、`这次允许`、`同意一次`、`allow once`、`once`
- 这个会话内允许：`这个会话内允许`、`本会话允许`、`总是允许`、`allow session`、`session`
- 拒绝：`拒绝`、`不允许`、`不要`、`停止`、`deny`、`reject`、`no`
- 也接受 JSON：`{"decision":"once"|"session"|"deny"}`
- 无法识别时不猜测，继续等待；超时按拒绝处理。

### 4.2 状态机

```
门 OFF:
  request_approval -> allowed=true, decision="disabled", asked=false
  不发消息、不等待、不改线程状态

门 ON:
  request_approval
    -> 已有 thread+category 的 session 授权: allowed=true, asked=false
    -> 否则: 写审批消息 -> thread.state=WAITING_USER
             task_status.waiting_for_user=true
             task_status.approval.pending 可查
             request_approval 阻塞等待
       -> once    : status=allowed, allowed=true,  stop=false
       -> session : status=allowed, allowed=true,  stop=false, 写入 approval_grants
       -> deny    : status=denied,  allowed=false, stop=true
       -> timeout : status=timed_out, allowed=false, stop=true（默认 10 分钟）
```

- 等待期间任务线程挂起为 `WAITING_USER`；`task_status` / `list_messages` / `list_approvals` 都能看到。
- 用户回复后，线程按第一期语义恢复为 `ACTIVE`（用户消息重置 `exchange_count`）。
- 拒绝/超时后，agent 的 `request_approval` 返回 `allowed:false, stop:true`，并附带“不要执行，报告后停止”的指令。引擎不替 agent 执行或回滚操作；是否真的停下由 agent 遵守工具结果与提示词决定。
- 同一线程同时只允许一个 pending 审批；并发请求会报错。一个请求只能被回答一次（条件更新，先到先得）。
- 任务在审批等待中被取消/结束时，pending 审批标记 `abandoned`，线程释放；引擎重启时所有 pending 审批同样标记 `abandoned`。

### 4.3 “这个会话内”的边界

session 授权以 `thread_id + category` 为键：

- 同一 thread 内，后续同类操作不再问；
- 不同类别仍要问；
- 新任务如果开启了新 thread（`task_start` 不带 `thread_id`），属于新会话，会重新问；
- 授权持久化在 SQLite `approval_grants`，引擎重启后仍有效（验证已覆盖）。

---

## 5. 与第一期消息协议的衔接

- 审批提问就是一条 `messages` 行，使用第一期的 `reply_to` 线程；用户回复也是一条 `messages` 行（`from:"user"`，`reply_to` 指向提问）。
- 发给 `user` 的消息在 `WAITING_USER` 下仍为 `stored`，不会因为线程等待而被标 `failed`（第一期 B1 修复保持不变，回归已覆盖）。
- 审批提问是 agent→user，不计入 agent-to-agent 的 10 条交换上限；用户回复按第一期规则把 `exchange_count` 重置为 0。上限 10 与第 11 条拒绝行为未改动。
- `send_message` 的工具 schema 未新增字段；`message_id` 只作为内部参数，由审批服务预生成，不暴露给 agent。

---

## 6. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_APPROVAL_GATE` | `0`（关） | 设为 `1` / `true` / `on` / `yes` 打开聊天审批门 |
| `APPROVAL_TIMEOUT_MS` | `600000`（10 分钟） | 审批等待超时；超时按拒绝处理 |

示例（`workbench.env`）：

```ini
# 默认关闭，保持全自动；需要时再打开
# AGENT_APPROVAL_GATE=1
# APPROVAL_TIMEOUT_MS=600000
```

打开后：

- claude 任务的启动提示词前会追加审批契约（`request_approval` 工具名、三类清单、允许/拒绝后的行为）；
- claude 的 MCP 工具超时 `MCP_TOOL_TIMEOUT` 提升到 `max(120000, APPROVAL_TIMEOUT_MS + 60000)`，避免用户还没回答客户端就先超时；
- dsh 没有 MCP 客户端，提示词会明确告知 `request_approval` 不可用，并要求不要执行三类关键操作；
- `agent_info.approval_gate`、`task_status.approval` 暴露门状态与 pending/最近一次审批。

关闭时：不追加提示词、不改执行器环境、`request_approval` 立即返回 `disabled` 且不写消息。

---

## 7. 新增 MCP 工具

| 工具 | 用途 |
|---|---|
| `request_approval` | agent 在关键操作前提问；门关时立即放行；门开时写聊天消息并阻塞等待 |
| `respond_approval` | 用户回答 pending 审批：`once` / `session` / `deny` |
| `list_approvals` | 查询审批记录（`thread_id`、`task_id`、`status`） |

工具总数从 10 个变为 13 个。

---

## 8. 已知限制（如实记录）

1. **这是 agent 自觉遵守的闸门，不是沙箱。** 引擎无法检查执行器进程内部执行的命令；claude 以完整权限运行。提示词要求 agent 在关键操作前调用 `request_approval`，工具结果决定继续或停止，但无法从操作系统层面阻止一个不遵守约定的 agent。要做强制拦截，需要在 Claude Code 侧接 `--permission-prompt-tool` 或 hook，并另做 dsh 适配；本期未做。
2. **dsh 不能调用该工具。** dsh headless 没有 MCP 客户端，提示词只要求它不要做三类关键操作；它无法发起审批。真正执行合并/删除/安装的通常是 claude。
3. **阻塞式工具调用依赖客户端超时。** 已尽力把 `MCP_TOOL_TIMEOUT` 提高到审批超时之上；若某个 Claude Code 版本不识别该变量、或客户端另有更短超时，用户回答过晚时工具调用可能先在客户端侧失败。默认审批超时 10 分钟，任务总超时 30 分钟。
4. **审批卡片受 500 token summary 上限。** 完整文件清单在 `files` 字段，三选一说明在 `question` 字段；summary 可能被截断。
5. **没有 GUI。** 提问与回复走 MCP / 聊天消息；设置页开关与卡片 UI 属第五期。
6. **生产 `:8080` 未重启。** 新工具与门逻辑需在任务外重启引擎后才会在生产入口可用。

---

## 9. 验证

### 9.1 审批门回归（隔离实例，未调用任何 agent LLM）

脚本：`scripts/verify-approval-gate.mjs`

- 门 OFF：`127.0.0.1:18101`，独立 data/db/log。`request_approval` 在 6 ms 内返回 `allowed:true, decision:"disabled", asked:false`；线程无消息、保持 `ACTIVE`、`waiting_for_user:false`；`respond_approval` 返回“gate is disabled”。
- 门 ON：`127.0.0.1:18102`，`APPROVAL_TIMEOUT_MS=5000`。
  - 允许一次：claude 发起 merge 审批 → 消息 `from:claude, to:user, status:stored`，卡片前缀含 `[Agent HUD · 来自 claude · 合并登录分支 <message-id>]`，`files` 两条；线程 `WAITING_USER`、`waiting_for_user:true`、`exchange_count:0`；用户 `respond_approval(once)` 后阻塞调用返回 `allowed:true, decision:"once"`，线程恢复 `ACTIVE`，用户回复 `reply_to` 指向审批消息。
  - 拒绝：同类别再次提问 → `respond_approval(deny)` → `allowed:false, stop:true`，证明 deny 不产生 session 授权。
  - 会话内允许：`respond_approval(session)` 后，同线程同类别下一次 `request_approval` 在 3 ms 内直接 `allowed:true, asked:false, decision:"session"`，`grant_source` 指向创建授权的审批；不同类别仍会提问。
  - 聊天自由回复：用户用 `send_message` 回复“这个会话内允许” → 解析为 session，后续同类操作不再问。
  - 歧义回复：用户回复“晚点再说” → 不猜测，线程保持 `WAITING_USER`；随后 `respond_approval(deny)` 用显式 decision 解析该回复，且不重复写第二条 `reply_to`。
  - 超时：5,138 ms 后返回 `allowed:false, decision:"timeout", stop:true`，线程释放为 `ACTIVE`，审批记录为 `timed_out`。
  - 上限：审批问答后 agent→agent 消息的 `exchange_count` 从 1 开始，10 条上限语义未变。
  - 持久化：引擎重启后 session 授权仍生效（`request_approval` 直接 `allowed:true, asked:false`）。
  - 恢复：pending 审批在引擎重启后标记 `abandoned`，线程从 `WAITING_USER` 恢复 `ACTIVE`。

结果文件：`data/approval-verify-20261114054507/verify-result.json`，`ok: true`，`errors: []`。

### 9.2 第一期回归（仍然通过）

- 门 OFF：`VERIFY_SKIP_AGENTS=1 VERIFY_PORT=18105 node scripts/verify-agent-messages.mjs` → `ok: true`；`data/agent-hud-verify-20261114054525/verify-result.json`。
- 门 ON：`AGENT_APPROVAL_GATE=1 VERIFY_SKIP_AGENTS=1 VERIFY_PORT=18106 node scripts/verify-agent-messages.mjs` → `ok: true`；`data/agent-hud-verify-20261114054528/verify-result.json`。
- 两次均覆盖：结论往返、`reply_to` 唯一回复、10 条上限、第 10 条 `held`、第 11 条拒绝、`WAITING_USER`、user 报告默认 `deliver` 下 `stored`（B1）、summary 500 token 截断、重启前后 13/13 条持久化。

### 9.3 未做

- 未跑真实 claude↔用户审批往返（会消耗 agent 额度）；本期验收以隔离引擎协议级回归为准。
- 未在生产 `:8080` 重启或写入；`data/`、`logs/` 仍为 gitignored。
- 未做 GUI、侧栏、纸飞机、结论卡片界面、设置页、签名；未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`、`spike/`；未删除文件。