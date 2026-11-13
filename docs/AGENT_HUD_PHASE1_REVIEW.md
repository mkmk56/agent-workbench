# Agent HUD 第一期（引擎内 agent 互发消息）独立评审

> 评审方：独立评审会话（非实现方）
> 评审日期：2026-11-14
> 评审对象：分支 `gui/v0.1`，引擎提交 `f121f0b`，文档提交 `b06b01b`
> 远程 HEAD 核对：`b06b01b0dee52fba7d32bb06095afd0b68143713`（经代理 `git ls-remote`）
> 评审方式：逐项读代码、读验证产物、在隔离实例上独立复跑；未修改任何实现文件。

---

## 一、结论

**有条件通过（CONDITIONAL PASS）**

- 核心功能（消息协议、服务端 UUID、`reply_to` 链、持久化、10 条上限、`WAITING_USER`、用户重置、MCP 接入、评审回路、推送）均已实现，历史证据与文件内容基本一致，独立复跑也通过。
- 但有 **2 个必须修的问题**（见第三节）：其中一个是功能正确性缺陷，另一个是验收项「mode 0600」在本机（Windows）实际上未成立。
- 另有若干非阻塞建议（第四节），不影响本次功能验收，但建议在 GUI 侧接入前处理。

---

## 二、验收项逐条核实

| # | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | `send_message` / `list_messages` 存在；`message_id` 服务端 UUID；`reply_to` 链；结论体 `{summary, files, question}`；SQLite `threads`/`task_threads`/`messages` 持久化可查 | **通过** | `src/tools.js:133,158`；`src/messages.js:227`（`randomUUID()`）；`src/store.js:69,79,86,107`（三表 + `reply_to` 唯一部分索引）；独立复跑 `reply_to_correct=true`、重启前后 13/13 条 |
| 2 | 10 条上限：第 10 条 `held`、线程 `WAITING_USER`、`task_status`/`list_messages` 返回 `waiting_for_user: true`、第 11 条被拒、用户消息重置为 0 并恢复 `ACTIVE`、发给 user 的最终报告不占上限 | **通过（附带 B1 缺陷）** | `src/messages.js:196,212-216,226,242,252`；独立复跑：`tenth_status=held`、`WAITING_USER`、`list_waiting_for_user=true`、`task_status.waiting_for_user=true`、第 11 条报错、`user_reset={0,ACTIVE}`、`after_reset_exchange_count=1`、`user_report.exchange_count=10` |
| 3 | claude 接入本机 MCP：`--mcp-config`、`data/claude-mcp.json` 原子写入 / mode 0600 / gitignored、Bearer 正确、`process.js` 不再剥离 `MCP_*`/`WORKBENCH_*` | **部分通过（B2）** | `src/executors/claude.js:14`；`src/mcp-config.js:19-22`；`.gitignore:11`（`data/`，`git check-ignore` 命中）；`src/executors/process.js:24-28`；独立实例生成的配置 `type=http`、`url=http://127.0.0.1:18095/mcp`、`bearer_matches_run_token=true`。**但 mode 实测为 666，ACL 允许 `BUILTIN\Users` 读取** |
| 4 | 评审回路真实跑通（claude 请求 dsh 评审 → dsh `reply_to` 回复 → claude 继续，无用户介入） | **通过（有证据口径说明）** | `data/agent-hud-verify-20261113193005/`：dsh 任务 `00607ace…` 日志第 24 行 `auto-reply to bd32c451… done=false`，消息 `50f4c445…`（`reply_to=bd32c451…`）投递到 claude revision `a04547df…`；revision 日志第 1204 行再 `auto-reply to 50f4c445…`。消息链无 `from:user` |
| 5 | 验证证据存在、`ok:true`、断言与文件一致；独立隔离实例复跑 | **通过（独立复跑无 LLM 调用，见下）** | 两份 `verify-result.json` 均 `ok:true`；独立实例 `127.0.0.1:18095` 的 `review-result.json` `ok:true` |
| 6 | 文档如实记录；held-at-cap 不自动重排已记入文档；`data/mcp-probe/config.json` 与 `data/claude-mcp.json` 已 gitignored、未提交、未打印 | **基本通过（B2 涉及口径）** | `RESUME.md` I.3/I.5、`DAILY_LOG.md`「未采纳」均记录 held-at-cap 不自动重排；两文件均在 `data/`（gitignored）、未被 `git ls-files` 跟踪；用当前 token 扫描全部已跟踪文件 = **0 命中**；数据日志扫描仅命中历史文件 `data/c68b9d69…log`（E-4 既有风险，非本次引入） |
| 7 | 远程 `gui/v0.1` HEAD = `b06b01b`；命令与文档无 token；推送用代理 recipe | **通过** | `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 ls-remote origin refs/heads/gui/v0.1` 返回 `b06b01b0dee5…`；全局/本地 git config 无 proxy/sslBackend 残留；已跟踪文件 token 扫描 0 命中 |

---

## 三、必须修的阻塞问题

### B1. 发给 `user` 的最终报告，在默认 `deliver` 下会被标成 `failed`（与文档/不变式矛盾）

**现象**：线程已 `WAITING_USER` 时，agent 调用 `send_message` 向 `user` 发最终报告且**不显式传 `deliver:false`**（即工具默认 `deliver:true`），消息行虽然写入，但 `status` 为 `failed`，`error` 为 `thread state is WAITING_USER`。

**根因**：`attemptDelivery()` 先判断线程状态、后判断收件人是否为 `user`：

- `src/messages.js:276-287`：`if (!thread || thread.state !== 'ACTIVE') { status: 'failed'; … return }`
- `src/messages.js:288-291`：`if (!AGENTS.has(message.to_agent)) { status: 'stored'; … return }`

`user` 不在 `AGENTS` 中，本应走第 288 行的 `stored`，但第 277 行的线程状态检查先命中，导致报告被标 `failed`。这与 `src/messages.js:193-196` 注释「A final report to the user is always accepted, including while the thread is waiting for the user」及 `RESUME.md` I.2「在 `WAITING_USER` 下仍可写入」不一致。

**为什么现有验证没发现**：协议回归脚本对 user 报告显式传了 `deliver:false`，绕过了 `attemptDelivery`：

- `scripts/verify-agent-messages.mjs:415`：`deliver: false`

因此 `verify-result.json` 里的 `user_report.status="stored"` 只在 `deliver:false` 下成立，不代表默认工具调用的行为。

**独立复跑证据**（隔离实例 `127.0.0.1:18096`，结果文件 `data/review-phase1/user-report-20261113195114/probe-result.json`）：

```json
{
  "thread_state_after_cap": "WAITING_USER",
  "user_report_default": { "status": "failed", "error": "thread state is WAITING_USER",
                            "exchange_count": 10, "waiting_for_user": true },
  "user_report_deliver_false": { "status": "stored", "error": null },
  "user_report_deliver_true":  { "status": "failed", "error": "thread state is WAITING_USER" }
}
```

**影响**：计数确实没有被移动（`exchange_count` 仍为 10），所以「不占上限」这点成立；但「最终报告始终被接受」的状态语义不成立，任何按 `status` 驱动 UI/自动化的消费方会把用户最终报告当成投递失败。

**建议修法**：把 `to_agent === 'user'`（以及非 `AGENTS` 收件人）的短路判断提到线程状态检查之前，或在 `send()` 中对 `toUser` 直接置 `stored` 且跳过 `attemptDelivery`。修完后请把回归脚本的 user 报告改为**默认 `deliver`**（不传或传 `true`）以覆盖该路径。

---

### B2. `data/claude-mcp.json` 的「mode 0600」在本机 Windows 上未成立，token 文件可被本机其他用户读取

**声明位置**：`RESUME.md` I.2「配置由 `src/mcp-config.js` 原子写入（临时文件 + rename，mode `0600`）」、I.5「代码以 mode `0600` 写入」；`DAILY_LOG.md` 同日区块同样表述。

**代码**：`src/mcp-config.js:19-22`

```js
mkdirSync(dirname(path), { recursive: true });
const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
renameSync(tmp, path);
```

原子写入（临时文件 + rename）确实成立，但 Node 在 Windows 上不按 POSIX 语义执行 `mode`。隔离实例实测：

- `data/review-phase1/run-20261113195031/review-result.json` → `mcp_config_file.mode_octal = "666"`
- 同一文件与普通源码文件（`src/messages.js`）的 `statSync().mode` 均为 `666`，说明 `mode: 0o600` 在 Windows 上未产生任何效果。
- `Get-Acl` 结果（省略 SID 前缀）：

```
BUILTIN\Administrators          :: FullControl          :: Allow
NT AUTHORITY\SYSTEM             :: FullControl          :: Allow
NT AUTHORITY\Authenticated Users:: Modify, Synchronize  :: Allow
BUILTIN\Users                   :: ReadAndExecute, Synchronize :: Allow
```

即该文件继承目录 ACL，`BUILTIN\Users` 可读，任何本机已认证用户都能读取其中的 Bearer token（token 等于 `workbench.env` 的完整 MCP 凭据，可完全调用本机 MCP 接口）。

**影响**：多用户机器或任意本机进程可读取 token。单用户家用机上实际风险较低，但验收项「mode 0600」在本平台不成立，文档口径已失真。

**建议修法（二选一）**：
1. 写入后调用 `icacls <path> /inheritance:r /grant:r "%USERNAME%":F`（或等价 Win32 ACL API）只授权当前用户；或在 `renameSync` 后用 `fs.chmodSync(path, 0o600)` 并额外校验 ACL。
2. 若决定接受平台限制，则把 `RESUME.md`/`DAILY_LOG.md` 的表述改为「Windows 上 Node `mode` 不生效，文件位于 gitignored 的 `data/`，依赖目录 ACL；多用户环境需自行收紧」，并在验收项里明确「mode 0600 仅在 POSIX 生效」。

另：生产路径 `D:\Claude\agent-workbench\data\claude-mcp.json` 目前**不存在**（`Get-Content` 报 `Cannot find path`），因为生产 `:8080` 仍跑旧代码、尚未重启；本项结论来自隔离实例生成的文件。这与 `RESUME.md` I.1「生产 [PENDING]」一致，不是缺陷，但意味着 token 文件的实际权限在生产上要等重启后才会出现。

---

## 四、非阻塞建议

### N1. `from: 'user'` 可被任意调用方伪造，10 条上限可被 agent 自行重置

`src/tools.js:140` 的 `from` 枚举包含 `user`，`src/messages.js:198-205` 只要 `from === 'user'` 就 `exchange_count=0`、线程恢复 `ACTIVE`。服务端不区分「用户本人」与「执行器任务」——本评审的独立复跑也正是用 `from:'user'` 完成重置。理论上一个跑飞的 agent 只要改传 `from:'user'` 就能绕过 10 条上限。

`docs/AGENT_HUD_SPEC.md:199` 已把「以我的身份发送」定义为 GUI 开关（默认关，打开须带 ⚠️ 文案），说明产品上知道这个风险；但引擎侧目前没有约束。建议在 GUI 接入前给「用户消息」单独入口或加角色/来源校验，不要让执行器任务能直接写 `from:'user'`。

### N2. 真实 agent 往返证据产生于修复前的代码版本，未在 `f121f0b` 上复跑

`data/agent-hud-verify-20261113193005` 的 dsh 任务日志第 14 行引用的是 `taskHasReplyFrom()`（`src/messages.js` 旧版本），而 HEAD 已改为状态感知的 `taskReplyFrom()`（`src/messages.js:359`）；`taskHasReplyFrom` 在 HEAD 中出现 0 次。结合提交时间（`f121f0b` 为 2026-11-13T19:33:53Z，该真实流 `finished_at` 为 19:31:43Z），可判断真实 claude↔dsh 往返跑在修复前版本上，最终提交只做了协议级回归（`20261113193307`，`real_flow` 为空）。

修复只影响 held/answered 与 user 报告路径，而真实流没触发上限，因此行为上不受影响；但严格来说，「最终提交上的真实 agent 往返」尚无证据。建议上线前在隔离实例上用 `f121f0b` 补跑一次真实流。

### N3. `process.js` 让执行器子进程继承 `MCP_BEARER_TOKEN`

`src/executors/process.js:24-28` 不再剥离 `MCP_*`/`WORKBENCH_*`（这是本次要求的行为），副作用是 claude/dsh 子进程的环境中直接带有本机 MCP 的 Bearer token。建议保留 `WORKBENCH_*` 与其他 `MCP_*`，但单独剔除 `MCP_BEARER_TOKEN`（claude 已通过 `--mcp-config` 拿到鉴权，不需要该环境变量）。

### N4. 文档里的 `tools/call 56 次` 是真实流阶段快照，不是 `server.log` 最终总数

`verify-result.json` 的 `mcp_evidence.server_tools_call_requests=56` 在真实流结束后、上限测试开始前采样；`data/agent-hud-verify-20261113193005/server.log` 最终共 78 次 `MCP tools/call`（`tools/list` 3 次与断言一致）。`RESUME.md` I.4 写作「服务端记录 … 56 次」容易被理解为最终总数，建议改为「真实流阶段记录 56 次」。

### N5. 「claude 按评审继续改」这一步没有以真实改代码的形式跑通

真实流中的 revision 任务 `a04547df…` 是只读协议测试，其最终 summary 明确写了「Do not prepare or apply a patch now: this session is a read-only protocol test」。实际修复由实现方（主会话）在评审后完成（`RESUME.md` I.3 已如实说明）。消息层面的评审回路已跑通，但「agent 在回路内改代码」未被实际执行，建议在后续版本用一次真实的「dsh 评审 → claude 改文件 → 再回传」验证。

### N6. `estimateTokens` 对非 CJK/非拉丁文字不是上界

`src/messages.js:7-22` 以「CJK 每字 1 token、其他每 4 字符 1 token」估算；对西里尔/阿拉伯等文字会低估，因此「保守上界」的注释不完全成立（dsh 评审已提出，`RESUME.md` I.5 已记录）。非阻塞，属文档口径问题。

### N7. 既有 token 暴露风险仍在（历史遗留，非本次引入）

用当前 `workbench.env` 的 token 扫描 `data/`，命中历史文件 `data/c68b9d69-b138-42a7-88e1-401156e50e38.log`（2026-11-13 01:25 的首次派单日志）。这就是 `RESUME.md` E-4 记录的历史风险，本次改动没有新增泄露点（新验证目录的所有 `server.log` 与 `claude-mcp.json` 均未打印 token）。建议在分享/迁移前轮换 token 并清理历史数据。

### N8. 生产入口暂未上线新工具（预期内）

`RESUME.md` I.1 已注明生产 `:8080` 仍运行旧代码（本次只读 `/health` 返回 200，未改动）。`send_message`/`list_messages` 要在任务外重启引擎后才在生产可用；本评审没有重启生产。属预期状态，列出以免误判。

---

## 五、独立复跑证据

### 5.1 环境与限制

- 隔离实例端口 **18095 / 18096**，独立 `MCP_DATA_DIR` / `MCP_DB_PATH` / `MCP_LOG_DIR`，每次随机 48 字符 token；未使用 18091，未写入生产 `:8080`。
- 本评审会话运行在文件沙箱中，**禁止以管道 stdio 启动子进程**（`spawn EPERM`），而 `src/executors/process.js` 正是以 `stdio: ['ignore','pipe','pipe']` 启动 claude/dsh。因此无法在本环境复跑真实 executor 的自动投递；尝试用 `danger-full-access` 重试被拒（无审批通道）。这是一条必须如实记录的限制，不是实现缺陷。
- 改为在真实的隔离引擎进程上复跑**协议级结论往返 + 上限**（消息收发、`reply_to`、唯一回复、持久化、上限/等待用户/重置）。全程使用占位任务，**未调用任何 LLM，未消耗 agent 额度**。

### 5.2 结论往返（`data/review-phase1/run-20261113195031/review-result.json`）

```json
"round_trip": {
  "message_1": { "id": "63d70853-14ab-463e-9050-6e48bbacbd38", "uuid_format": true,
                 "from": "claude", "to": "dsh", "reply_to": null,
                 "status_before_reply": "stored", "status_after_reply": "answered",
                 "summary_tokens": 39 },
  "message_2": { "id": "5b57d9c2-10fd-4d70-9a8c-8f578f183277", "uuid_format": true,
                 "from": "dsh", "to": "claude",
                 "reply_to": "63d70853-14ab-463e-9050-6e48bbacbd38",
                 "status": "stored", "summary_tokens": 21 },
  "reply_to_correct": true,
  "origin_marked_answered": true,
  "duplicate_reply_rejected": true,
  "duplicate_reply_error": "Error: message 63d70853-14ab-463e-9050-6e48bbacbd38 already has a reply",
  "thread": { "state": "ACTIVE", "exchange_count": 2, "waiting_for_user": false }
}
```

### 5.3 上限到 10 停下等用户（同一 `review-result.json`）

```json
"cap": {
  "messages_sent": 10,
  "tenth_status": "held",
  "thread_state": "WAITING_USER",
  "waiting_for_user": true,
  "reply_chain_ok": true,
  "list_waiting_for_user": true,
  "ninth_status": "stored",
  "task_status": { "thread_state": "WAITING_USER", "waiting_for_user": true,
                   "exchange_count": 10, "exchange_limit": 10 },
  "user_report": { "status": "stored", "exchange_count": 10, "waiting_for_user": true },
  "eleventh_rejected": true,
  "eleventh_error": "Error: thread e9291431-… is waiting for user input; send a message from \"user\" to resume",
  "user_reset": { "exchange_count": 0, "thread_state": "ACTIVE", "waiting_for_user": false },
  "after_reset_exchange_count": 1
},
"summary_limit": { "summary_tokens": 500, "summary_truncated": true, "stored_chars": 2000 },
"persistence": { "before_restart_count": 13, "after_restart_count": 13,
                 "reply_chain_ok": true, "thread_state": "ACTIVE" },
"mcp_config_file": { "type": "http", "url": "http://127.0.0.1:18095/mcp",
                     "bearer_matches_run_token": true, "mode_octal": "666" }
```

> 说明：`cap.user_report.status="stored"` 是因为该断言使用了 `deliver:false`；默认 `deliver` 的行为见 B1（实测 `failed`）。

### 5.4 其余工具与状态

- `tools/list` 返回 10 个工具（含 `send_message`、`list_messages`）；`agent_info.message_protocol={enabled:true, exchange_limit:10, summary_max_tokens:500, auto_deliver:true}`。
- 两份历史 `verify-result.json` 均 `ok:true`，其关键断言与文件内容一致（消息 ID、`reply_to`、token 数、`held`、`WAITING_USER`、13/13 持久化、截断 500 tokens）。唯一口径瑕疵见 N4。

---

## 六、文档与安全核对结论

- `RESUME.md` / `DAILY_LOG.md` 对本期的功能、验证、held-at-cap 不自动重排、生产未重启等记录总体如实；需修正两处口径：**B2 的「mode 0600」** 与 **B1 对应的「对 user 报告写入成功（stored）」**（默认路径实为 `failed`）。
- `data/` 已 gitignored；`data/mcp-probe/config.json`、`data/claude-mcp.json`（隔离实例生成）均未被跟踪、未被提交。
- 用当前 token 扫描全部已跟踪文件：0 命中；扫描 `data/**/*.log`：仅命中既有历史文件 `data/c68b9d69…log`（E-4）。
- 远程 `gui/v0.1` HEAD 确认为 `b06b01b0dee52fba7d32bb06095afd0b68143713`；推送使用 `git -c http.sslBackend=openssl -c http.proxy=http://127.0.0.1:7897 push`，未改全局 git 配置，命令与文档中无 token。
- 额度消耗无法直接观测；本次评审的独立复跑未调用任何 agent LLM，不产生 agent 额度消耗，日志按实际情况记录。

---

## 七、放行条件

1. 修 B1：`to:'user'` 的最终报告在默认 `deliver` 下也必须成功（`stored`），并补一条覆盖默认路径的回归。
2. 修 B2：对 `data/claude-mcp.json` 做 Windows ACL 收紧（或明确接受平台限制并同步修正文档口径）。
3. 两项修完后，建议在隔离实例上补跑一次 `f121f0b` 上的真实 claude↔dsh 往返（N2）并更新 `RESUME.md` 的验证汇总。

完成上述 1、2 后，本期功能可判为通过。
