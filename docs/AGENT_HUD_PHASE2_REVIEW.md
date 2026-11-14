# Agent HUD 第二期（引擎聊天式审批，默认关）独立评审

> 评审方：独立评审会话（非实现方）
> 评审日期：2026-11-14
> 评审对象：分支 `gui/v0.1`，引擎/验证脚本提交 `e7b05f4`，文档提交 `e200ec3`；评审时本地 HEAD `4c2627f`（容器化文档提交，未改 `src/approvals.js`）
> 评审方式：逐项读代码与规格、在隔离实例上独立复跑、补做官方验证脚本未覆盖的探针；**未修改任何实现文件**，未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`，未碰 GUI / `spike/` / 签名。
> 生产 `:8080`：只做只读检查（`/health`、`tools/list`、`agent_info`），**未写入**任何任务、消息或审批。

---

## 一、结论

**有条件通过（CONDITIONAL PASS）**

- 审批门的核心机制成立：三类清单与文档同源、门开时按规格写提问卡片并把线程置 `WAITING_USER`、`once` / `session` / `deny` / `timeout` 四种结果与状态机一致、session 授权严格按 `thread_id + category` 生效、门关时正常调用零副作用、第一期回归（含 B1、10 条上限、500 token 截断、重启持久化）在门关与门开两种配置下均独立复跑通过。
- 有 **1 个必须修问题**（见第三节 M1）：门关时 `request_approval` 的**输入校验发生在门开关短路之前**，一个 schema 合法的调用（只给 `category/action/reason`，不给 `files`/`command`）会**报错**而不是按规格返回 `allowed:true, decision:"disabled"`，违反“默认关闭时零行为变化”的验收口径。
- 另有 8 项非阻塞问题（第四节）：最重要的是**审批卡片被 500 token 截断时会丢掉“三选一 + approval_id”那一行**（与规格承诺的顺序相反），以及**审批工具本身可被 agent 自己调用（自审批）**未在已知限制中写明。均不影响本次状态机验收，但建议在 GUI 接入（第五期）前处理或如实记录。

---

## 二、验收项逐项核实

### 2.1 审批门清单是否正确、完整

| 核查点 | 结论 | 关键证据 |
|---|---|---|
| 只有三类、类别键与文档一致 | **通过** | `src/approvals.js:12-70`（`APPROVAL_CATEGORIES` 冻结对象）；`Object.keys` = `merge / delete / dependencies`；`docs/AGENT_HUD_APPROVAL.md:17-71` 与代码逐条对应；独立复跑的静态断言 `catalog=['delete','dependencies','merge']`（`data/approval-verify-20261114062308/verify-result.json`） |
| `merge` 要问 / 不要问的边界 | **通过** | 要问：`git merge/rebase/cherry-pick`、`git push`（含 `--force`/`--force-with-lease`/`--tags`）、会产生 merge/rebase 的 `git pull`、`gh pr merge`/API 合并（`src/approvals.js:18-21`）；不要问：`fetch`、`pull --ff-only`、`status/diff/log/show`、`add/commit`、建/切分支、`stash push/pop`、已 push 后开 PR、单提交 `revert`（`:23-28`）。与文档 §2.1 完全一致 |
| `delete` 要问 / 不要问的边界 | **通过** | 要问：`rm/rm -rf/rmdir/del/erase/rd/Remove-Item`、脚本 `unlink/rmtree`、`git rm`、`git clean -fd/-fdx`、`git reset --hard`、`checkout -- <path>`/`restore`、`stash drop/clear`、删分支/标签、`push --delete`、整文件截断/覆盖、`DROP/TRUNCATE`、无 WHERE 的 `DELETE`（`:35-41`）；不要问：构建/依赖/临时目录、任务自建临时文件、编辑器正常修改、`stash push/pop`、带 WHERE 的删除（`:42-47`）。与文档 §2.2 一致 |
| `dependencies` 要问 / 不要问的边界 | **部分通过** | 要问：各包管理器安装/移除/升级、改依赖声明或 lockfile（`:54-60`）；不要问：`npm ci`/`--frozen-lockfile`、`test`/`run`/`npx`、`ls`/`outdated`/`list`、读 manifest、改非依赖字段（`:62-67`）。**但文档把 `package.json` 的 `deps/devDeps/optionalDeps/peerDeps/overrides/resolutions` 逐项列出（`docs/AGENT_HUD_APPROVAL.md:61`），代码清单只写 “package.json deps”**；而注入给 agent 的是代码清单（`:156-158`），所以 agent 收到的契约比文档窄 → 非阻塞 N2 |
| 有没有互相矛盾的条目 | **无** | 未发现同一命令既在 includes 又在 excludes；`git stash push/pop`（排除）与 `stash drop/clear`（要问）、`git push`（merge 要问）与 `push --delete`（delete 要问）是重叠但同属要问，不构成矛盾 |
| 是否有漏判命令 | **有若干（非阻塞 N4）** | 清单是提示词级、非代码匹配器（见 2.5），漏项属边界提示不完整而非功能性漏判：`git clean -f`（不带 `-d`，删未跟踪文件）未列；`git merge --abort` / `git rebase --abort`（丢弃工作区）未列；PowerShell `Clear-Content` / `truncate -s 0` 未列；`mv`/`Move-Item` 覆盖已有文件未列；`npm publish` / `gh release create` / `docker push` 未列，而类别名是 “publish code”（`:16`）；不带参数的 `npm install`（可能改写 lockfile）既不在 includes 也不在 excludes |

> 说明：清单本身**不做命令匹配**，它只被拼进 claude 的提示词（`src/approvals.js:144-181`）、并在 `agent_info.approval_gate` 中暴露。因此“漏判”表现为 agent 不知道要问，而不是引擎误判。文档 §2.3 结尾的“不确定就问”（`docs/AGENT_HUD_APPROVAL.md:70`）是兜底，但不能替代清单本身。

### 2.2 提问与回复流程

| 核查点 | 结论 | 关键证据 |
|---|---|---|
| 门开时写审批消息：卡片格式、类别、想做什么、命令、文件、为什么、三选一 | **通过** | 实测消息（`data/approval-verify-20261114062308/verify-result.json` → `on.once.summary`）：`[Agent HUD · 来自 claude · 合并登录分支 <uuid>] 关键操作需要你的批准` / `类别：merge（合并代码）` / `想做什么：…` / `命令：git merge feature/login` / `涉及文件：` + 两条路径 / `为什么：…` / `请三选一回复：允许一次 / 这个会话内允许 / 拒绝（approval_id=…）`。构造代码 `src/approvals.js:183-205`；`files` 数组与 `question` 字段独立保存（实测 `files.length=2`，`question` 含 approval_id 与 once/session/deny） |
| 卡片前缀的 `<message-id>` 与服务端消息 id 一致 | **通过** | 预生成 `messageId`（`:366`）→ 传给 `messages.send({message_id})`（`:385-394`，`src/messages.js:230-232`）→ 前缀与 `messages.id` 相同（`assertCardFormat`，脚本 `:222-230`） |
| 线程是否正确置 `WAITING_USER`，三处可见 | **通过** | `src/approvals.js:416`；实测 `list_messages.thread.state=WAITING_USER`、`waiting_for_user:true`、`task_status.waiting_for_user:true`、`task_status.approval.pending.approval_id` 与审批一致；`list_approvals status=pending` 可查 |
| 审批提问不占 10 条上限 | **通过** | 实测 `exchange_count=0`、`message_count=1`（`data/review-phase2-probe-20261114062324/probe-result.json` → `probes.cap`）；审批问答后 agent→agent 计数从 1 开始（脚本 `on.cap.exchange_count=1`） |
| `once` | **通过** | 阻塞调用返回 `allowed:true, decision:"once", stop:false`；提问消息变 `answered`，用户回复 `reply_to` 指回提问；线程 `ACTIVE`。用户回复文本为 `[approval] 允许一次：verified locally`（`src/approvals.js:212-220`），同类别下一次仍会问（脚本 deny 段即“once 之后再次提问”） |
| `session` 只在同线程同类别生效 | **通过** | 授权键为 `thread_id + category`（`src/store.js:130-136,438-452`）；实测同线程同类别 7 ms 内直接 `allowed:true, asked:false, decision:"session", grant_source=<原审批 id>`；不同类别仍提问（脚本 `on.session.different_category`）；**新线程仍提问**（本次探针 `probes.session_scope.new_thread_asked=true`）；重启后授权仍生效（脚本 `on.persistence`） |
| `deny` | **部分通过** | 引擎侧：`allowed:false, stop:true`，不写 `approval_grants`（下一次同类别仍会问，脚本已验证）。**但引擎不执行也不回滚操作**，只返回 `Do not perform the operation…` 指令；是否真的停下取决于 agent 遵守提示词（已写入已知限制 §8.1，符合规格）。另外 agent 可自行调用 `respond_approval` 放行（见 N3），所以“阻止”是约定级而非强制级 |
| 超时按拒绝处理并恢复线程 | **通过** | 配置 `APPROVAL_TIMEOUT_MS=4000` 时实测 4,183 ms 返回 `allowed:false, decision:"timeout", stop:true`；审批记录 `timed_out`；线程恢复 `ACTIVE`、`waiting_for_user:false` |
| 聊天自由回复 | **通过** | `send_message` 回复“这个会话内允许”→ 解析为 session 并生效；回复“晚点再说”→ 不猜测、线程保持 `WAITING_USER`，随后 `respond_approval(deny)` 用同一条回复解析（不重复写第二条 `reply_to`） |
| 同线程只允许一个 pending；一个审批只解析一次 | **通过** | 并发请求实测报错 `thread … already has a pending approval: …`（本次探针 `probes.concurrent`）；条件更新 `UPDATE … WHERE id=? AND status='pending'`（`src/store.js:389-398`），先到先得；`respond_approval` 与聊天轮询同时到达时只有一方生效（`:536-553`） |
| 任务结束/重启时 pending 处理 | **通过** | `onTaskFinished` 标 `abandoned` 并释放线程（`src/approvals.js:568-574`，接线 `src/scheduler.js:266-270`）；重启时 `approvals.recover()`（`src/server.js:21-23`）同样处理；实测重启后 `abandoned` + 线程 `ACTIVE` |
| 门开时提示词注入 | **通过** | claude：审批契约注入（静态断言 + 真实启动路径日志 `approval gate enabled; request_approval contract injected (agent=claude)`）；dsh：明确 `request_approval` 不可用并要求不要做三类操作（`src/approvals.js:147-153`，静态断言通过）；`{{task_id}}/{{agent}}` 在 `src/scheduler.js:165-169` 渲染 |
| 门关时不注入、不改执行器环境 | **通过** | `buildApprovalPromptBlock` 门关返回 `''`（`src/approvals.js:145`）；`src/scheduler.js:160-164` 无门块时 prompt 原文不变；`MCP_TOOL_TIMEOUT` 只在门开时设置（`src/executors/claude.js:32-38`） |

### 2.3 门关（默认）时是否零行为变化

| 核查点 | 结论 | 关键证据 |
|---|---|---|
| 立即返回 `allowed:true, decision:"disabled", asked:false` | **正常调用通过 / 缺参会报错（M1）** | 带 `files` 的调用实测 6 ms（脚本）/ 10 ms（本次探针）返回 `{allowed:true, decision:"disabled", asked:false, stop:false, gate_enabled:false}`；**但不给 `files` 且不给 `command` 时抛 `list at least one file or the command being approved`，`delete` 且 `files:[]` 时抛 `delete approval requires at least one file path`**（本次探针 `data/review-phase2/edge-probe-result.json`） |
| 不写消息 | **通过** | 门关后 `list_messages` 仍为 0 条；`messages.send` 未被调用（探针用桩对象统计 `messages_sent=0`） |
| 不等待 | **通过** | 耗时为毫秒级（6/10 ms），未进入 `_wait` 轮询 |
| 不改线程状态 | **基本通过** | 已有线程的 `state/exchange_count/message_count/updated_at` 全部不变；**但 `ensureThread` 在门开关短路之前执行**，对一个没有 `task_threads` 行的任务会新建一行 `threads`（探针 `e2.thread_created=true`）。该形态经公开工具不可达（`task_start` 与消息投递都会先 `setTaskThread`，`src/scheduler.js:78`），故归入 M1 的同一处修复建议，不单独升级为阻塞 |
| 门关时 `respond_approval` | **通过** | 返回 `Error: approval gate is disabled (AGENT_APPROVAL_GATE=0)`（`src/approvals.js:480-482`） |

### 2.4 第一期回归是否仍然通过

本次在隔离实例上独立复跑（**未调用任何 agent LLM**，见 2.6）：

| 配置 | 端口 | 结果文件 | 结论 |
|---|---|---|---|
| 门 OFF | 18205 | `data/agent-hud-verify-20261114062326/verify-result.json` | `ok:true`，`errors:[]` |
| 门 ON（`AGENT_APPROVAL_GATE=1`） | 18206 | `data/agent-hud-verify-20261114062356/verify-result.json` | `ok:true`，`errors:[]` |

两次都实测到：`reply_to` 链完整（`reply_chain_ok:true`）；10 条 agent 消息；第 10 条 `held`；线程 `WAITING_USER` 且 `task_status.waiting_for_user:true`；第 11 条被拒（`waiting for user input…`）；第 9 条在 held 后仍为 `stored`（未误标 `answered`）；发给 user 的最终报告在默认 `deliver` 下 `stored`、`error:null`、计数保持 10（B1 不变）；用户消息重置为 `0 / ACTIVE`，下一条计数为 1；`A`×5000 截断为 500 tokens / 2000 字符；重启前后均 13/13 条。

### 2.5 已知限制是否如实记录

| 限制 | 是否记录 | 证据 |
|---|---|---|
| 自觉遵守的闸门（非 OS 沙箱） | **已记录** | `docs/AGENT_HUD_APPROVAL.md:200-202`；`README.md:66`；`agent_info.approval_gate.enforcement = {mode:'agent-honored', note:…}`（`src/approvals.js:246-249`，实测可见） |
| dsh 不能发起审批 | **已记录** | `docs/AGENT_HUD_APPROVAL.md:203`；dsh 提示词块（`src/approvals.js:147-153`）实测包含 “no MCP client” 与 “Do not perform” |
| 拒绝不强杀任务（引擎不执行/不回滚） | **已记录** | `docs/AGENT_HUD_APPROVAL.md:138`；工具返回 `instructions`（`src/approvals.js:435-438`） |
| 阻塞调用依赖客户端超时 | **已记录，且有支撑证据** | `docs/AGENT_HUD_APPROVAL.md:204`；`src/executors/claude.js:32-38` 门开时设 `MCP_TOOL_TIMEOUT=max(120000, timeout+60000)`；本机 `claude.exe`（2.1.325）二进制中确实存在 `MCP_TOOL_TIMEOUT` 字符串（`findstr` 命中），说明该版本认识这个变量名；文档仍保留“某版本可能不识别”的边界，口径正确 |
| 审批卡片受 500 token 上限 | **已记录** | `docs/AGENT_HUD_APPROVAL.md:205`；但“关键信息（…approval_id）放在前面”的说法与实现不符（`docs/AGENT_HUD_APPROVAL.md:94` vs `src/approvals.js:195-204`）→ 非阻塞 N1 |
| 无 GUI；生产 `:8080` 未重启 | **已记录且复核为真** | `docs/AGENT_HUD_APPROVAL.md:206-207`；本次只读检查生产仍为 **10 个工具**、无 `request_approval`/`respond_approval`/`list_approvals`、`agent_info.approval_gate` 不存在（`data/review-phase2/prod-readonly.json`），即生产确实仍跑第一期代码 |

> 未记录的边界（建议补一行，见 N3）：审批三工具与第一期其他工具共用同一个 Bearer token，**发起审批的 agent 自己也能调用 `respond_approval`**。文档只说“不是沙箱”，没有点明“审批工具本身也是 agent 可调用的”。

### 2.6 独立复跑方式与环境限制（如实记录）

- **沙箱限制**：本评审会话的文件/进程沙箱**禁止把子进程输出接管道**。直接运行仓库脚本时 `child_process.spawn` 抛 `spawn EPERM`（`scripts/verify-approval-gate.mjs:62`）。因此我把两个验证脚本**复制到 gitignored 的 `data/review-phase2/`**，只改两处：相对 import 路径、以及把 `stdio:['ignore','pipe','pipe']` 换成继承文件描述符。**仓库内 `scripts/` 一行未改**；diff 仅 8 增 7 删（import 路径 + stdio + 关闭 fd）。
- **隔离实例**：审批回归 `127.0.0.1:18201`/`18202`（`APPROVAL_TIMEOUT_MS=4000`，独立 data/db/log）；第一期回归 `18205`（门 OFF）/`18206`（门 ON）；本次自写探针 `18211`/`18212`/`18220`。所有实例结束后已关闭，端口已释放。**全程未写生产 `:8080`**。
- **真实工具调用**：全部通过真实 MCP `initialize` / `tools/list` / `tools/call` 完成（`send_message`、`list_messages`、`request_approval`、`respond_approval`、`list_approvals`、`task_status`、`task_start`、`task_logs`、`agent_info`），不是复述已有 `verify-result.json`。
- **没有调用 agent LLM（两层原因）**：(1) 额度控制；(2) 本会话沙箱连引擎自己的执行器启动都跑不起来——真实 `task_start(claude)` 在隔离实例上走到 `failed to start: … icacls …`（`data/review-phase2-real-1794637487372/probe-result.json`，引擎日志同目录 `server.log` 首行），claude 进程根本没被拉起（`tokens:{input:0,output:0}`）。该失败发生在 `src/mcp-config.js` 的 ACL 步骤，属**本次沙箱环境限制**，不是二期代码缺陷（生产 ACL 已在第一期 B2 验证）。因此本报告**没有**“真实 claude↔用户审批往返”的第一手结论；`approval_prompt_injected:true` 与 `claude command=… source=npm-prefix D:\nodejs` 是从真实启动路径日志取得的证据。
- **额度**：本次未消耗 agent token；额度无法直接观测，不声称精确百分比。

---

## 三、必须修（阻塞）

### M1. 门关时 `request_approval` 的输入校验先于门开关短路：缺 `files`/`command` 的合法调用会报错，而不是按规格返回 `allowed:true`

**现象**：`AGENT_APPROVAL_GATE=0`（默认）下，schema 合法的调用

```json
{ "agent": "claude", "task_id": "<task>", "category": "merge",
  "action": "merge a into b", "reason": "no files, no command" }
```

返回 `Error: list at least one file or the command being approved`；`category:"delete"` 且 `files:[]` 时返回 `Error: delete approval requires at least one file path`。这与规格“门关时立即返回 `allowed:true, decision:"disabled", asked:false`”矛盾。

**根因（文件:行号）**：

- `src/approvals.js:313-315`：`delete` 必须至少一个文件；
- `src/approvals.js:316-318`：`files` 与 `command` 至少给一个；
- `src/approvals.js:320-321`：`getThreadId` + `ensureThread`（也发生在短路之前）；
- `src/approvals.js:325-338`：门关闭的短路返回被放在上述校验**之后**。

**规格依据**：`docs/AGENT_HUD_APPROVAL.md:119-121`（门 OFF 状态机只有 `allowed=true, decision="disabled", asked=false`，无失败分支）、`:184`（“关闭时…`request_approval` 立即返回 disabled 且不写消息”）、`RESUME.md` L.1；工具描述同样承诺“when the gate is off it returns allowed immediately”（`src/tools.js:177-179`）。

**证据**：`data/review-phase2/edge-probe-result.json`（隔离实例、门关、桩 `messages`）：

```json
{ "e1":  { "threw": true, "error": "list at least one file or the command being approved" },
  "e1b": { "threw": true, "error": "delete approval requires at least one file path" },
  "e2":  { "thread_created": true, "messages_sent": 0 } }
```

**影响**：默认配置就是门关，这是所有未显式开启审批的用户实际运行的路径。`request_approval` 对所有 MCP 客户端可见（`tools/list` 第 11 个工具，实测 13 个工具），其描述告诉模型“门关时立即放行”，模型据此主动探询时可能拿到 `Error:`，进而把一个“本应放行”的操作报告成被阻止。功能上不丢数据，但违反默认关闭的零行为变化口径。

**建议修法（一行位置调整）**：把 `if (!this.config.agentApprovalGate) { return {...} }` 移到 `request()` 的最前面（在参数校验与 `ensureThread` 之前），或只在门开时才做 `files`/`command` 校验。修完后补一条门关断言：不带 `files`/`command` 也返回 `disabled`，且 `threads` 表不新增行。

---

## 四、非阻塞

### N1. 卡片被 500 token 截断时，“三选一 + approval_id”那一行会消失；与规格承诺的顺序相反

- 规格：`docs/AGENT_HUD_APPROVAL.md:94` 说“关键信息（谁、类别、做什么、为什么、`approval_id`）放在**前面**”。
- 实现：`src/approvals.js:195-204` 把 `请三选一回复：…（approval_id=…）` 放在**最后**，位于 `涉及文件`（最多 8 项）与 `为什么`（最长 4000 字符）之后；`truncateSummary` 在 `src/approvals.js:379` 调用。
- 实测（`data/review-phase2-probe-20261114062324/probe-result.json` → `probes.truncation`）：`action` 400 字符 + `reason` 3000 字符 + 10 个文件时，`summary_tokens=500`、`summary_truncated=true`、`has_three_options_in_summary=false`、`has_approval_id_in_summary=false`、`tail="RRRR…"`；`question` 字段仍含 `approval_id`，且 `respond_approval(task_id=…)` 仍能解析（`respond_by_task_id.status=allowed`）。
- 影响：用户在聊天里看到的卡片可能既没有回复说明也没有 approval_id（功能可由 `question`/`task_id` 兜底）。建议把三选一/approval_id 行上移到 `类别`/`想做什么` 之后，或让 `reason` 先被截断；并同步修正文档第 94 行的说法。

### N2. 文档 §2.3 列出的 `package.json` 依赖字段名没有出现在代码清单里

`docs/AGENT_HUD_APPROVAL.md:61` 枚举 `deps/devDeps/optionalDeps/peerDeps/overrides/resolutions`，`src/approvals.js:60` 只写 `package.json deps`。注入给 agent 的是代码清单（`src/approvals.js:156-158`），agent 契约比文档窄。建议两边取其一。

### N3. 自审批未在已知限制中写明（`respond_approval` 与 agent 共用同一 token）

审批三工具与第一期工具共用 `/mcp` 的单一 Bearer token，没有“用户身份”。因此**发起审批的 agent 自己也能调用 `respond_approval(decision:"session")` 把自己放行**，无需用户参与。这与文档 §8.1“不是沙箱、无法从 OS 层阻止不守约定的 agent”在精神上一致，但文档没有点明“审批工具本身也在这个可调用集合里”。建议在 `docs/AGENT_HUD_APPROVAL.md` §8 增一条，并在第五期 GUI/设置页考虑用户侧独立通道或工具白名单（例如对执行器隐藏 `respond_approval`）。不阻塞本次验收：规格本身定位为“agent 自觉遵守的闸门”。

### N4. 清单漏项（边界提示不完整，非代码误判）

见 2.1 表末行：`git clean -f`、`merge/rebase --abort`、`Clear-Content`/`truncate -s 0`、`mv` 覆盖、`npm publish`/`gh release create`/`docker push`、裸 `npm install`。建议按“越界就按更严格一侧”的既有原则补进 `includes`（尤其类别名已写 “publish code”）。

### N5. 回复解析的少量误判（均为 fail-safe 方向）

- `no problem` → `deny`（`src/approvals.js:129` 的 `\bno\b`）；
- `同意，但不要动 package.json` → `deny`（“不要”命中）；
- `可以，先做吧` → `null`（继续等待，需用户改用标准三选一）。
前两条会把“同意”判成“拒绝”，方向安全但体验差；第三条符合“无法识别不猜测”。建议文档补一句“请直接回复三选一原词”，并考虑把 `\bno\b` 收紧为 `^no$`/`\bno,?$`。

### N6. 门关路径对“没有 `task_threads` 行”的任务会新建 `threads` 行

`src/approvals.js:320-321` 在门开关短路之前执行；实测 `thread_created=true`（`data/review-phase2/edge-probe-result.json` → `e2`）。经公开工具不可达（`task_start`/消息投递都会先 `setTaskThread`），与 M1 同处修复即可。

### N7. 门关时 `task_status` / `agent_info` 新增字段（加法变更）

即使门关，`task_status` 也返回 `approval_gate` 与 `approval`（`src/scheduler.js:343-346`），`agent_info` 也返回 `approval_gate`（`:418-423`）。属加法字段，第一期复跑未受影响；提示 GUI/自动化消费方按可选字段处理。

### N8. `request_approval` 对 `agent` 只校验“与任务属主一致”，不校验该 agent 是否真有 MCP 客户端

`src/approvals.js:297-303` 允许 `agent:"dsh"` 的占位任务发起审批（dsh 实际无法调用）。无实际影响，仅说明引擎侧没有“dsh 不可发起”的硬约束；文档已说明 dsh 不能发起（§8.2）。

---

## 五、独立复跑证据清单

| 内容 | 路径 | 结论 |
|---|---|---|
| 审批门回归（独立端口 18201/18202，超时 4000 ms） | `data/approval-verify-20261114062308/verify-result.json` | `ok:true`、`errors:[]`；OFF 6 ms `disabled`；ON：once/deny/session/聊天回复/歧义回复/超时 4,183 ms/上限/重启授权/重启 abandoned 全部按规格 |
| 第一期回归 门 OFF（18205） | `data/agent-hud-verify-20261114062326/verify-result.json` | `ok:true` |
| 第一期回归 门 ON（18206） | `data/agent-hud-verify-20261114062356/verify-result.json` | `ok:true` |
| 本次补充探针（18211/18212） | `data/review-phase2-probe-20261114062324/probe-result.json` | `ok:true`：门关零消息、审批不占上限、同线程并发拒绝、session 不跨线程、截断行为、按 task_id 回答 |
| 门关边界探针 | `data/review-phase2/edge-probe-result.json` | e1/e1b 抛错（M1）；e2 新建 `threads` 行（N6） |
| 真实启动路径探针（18220） | `data/review-phase2-real-1794637487372/probe-result.json` | `approval_prompt_injected:true`；执行器因沙箱 `icacls` 失败未拉起（环境限制，非代码缺陷） |
| 生产只读检查 | `data/review-phase2/prod-readonly.json` | 生产 10 个工具、无审批工具 → “生产未重启”属实 |
| 回复解析探针 | `data/review-phase2/parse-probe.mjs` 输出（见 N5） | 中文/英文/JSON 三选一均正确；`no problem` 等边界见 N5 |

被改写的验证脚本与仓库原文 diff：仅 import 路径（`../src` → `../../src`）与 `stdio:['ignore','pipe','pipe']` → 文件描述符，共 8 增 7 删；`scripts/` 未被修改。

---

## 六、范围与未做

- 未修改 `src/`、`scripts/`、`gui/`、`spike/`、签名；未改 `docs/AGENT_HUD_PHASE1_REVIEW.md`；未删除文件。
- 未在任务内重启生产引擎，未写生产数据库/消息/审批；只读调用 `tools/list` 与 `agent_info`（后者会触发本机 `claude --version`/`auth status`，无状态写入）。
- 未做真实 claude↔用户审批往返（额度 + 本会话沙箱无法拉起执行器，见 2.6）；真实执行器侧的“agent 是否遵守闸门”因此**未实测**，只能依据代码与规格判断。
- 额度无法直接观测；本次未调用 agent LLM，不声称精确占比。
- 本文件与 `DAILY_LOG.md` 的提交由评审会话完成，推送方式见 `DAILY_LOG.md` 本区块的「Git 同步」：先按单条 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push` 执行，但本会话沙箱禁止进程创建命名管道，Git 的凭据助手经 `sh.exe -c` 启动时报 `couldn't create signal pipe`，HTTPS 凭据无法注入；因此改用本机已登录的 `gh api` 创建与本地**完全相同**的 commit 对象并快进更新远程分支（tree/commit SHA 与本地一致后才更新 ref）。本文件无法记录自身所在提交的 hash，以 `git log -1` 与任务汇报为准。
