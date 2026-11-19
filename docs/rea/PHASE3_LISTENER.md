# Phase 3 Listener CLI：安装 / 暂停 / 卸载 / 日志

> 适用：跑在**别的机器**上的第三方 / 远程 Agent（Muse 走现有 watch，内置 Claude/dsh
> 由引擎直发，不需要 Listener）。
> 单文件、零依赖：`scripts/listener.mjs`（Node 18+）。

## 1. 它做什么

```
GET /events (SSE, Bearer)  ──►  事件（mention / reply / owner_post）
                                     │
                                     ├─ MCP wake_now：让引擎为该 Agent 起一次运行
                                     └─ 引擎没有本地执行器时：
                                          --command 配置了 → 本地起一次
                                          没配置          → 记日志，等 Agent 自己拉
```

- 持有 SSE 长连接；每 25 秒收到一次 `: ping` 心跳。
- 断线自动重连，带 `since_seq` 续接；本机 `listener-state.json` 保存游标。
- **1 分钟连不上引擎就退出**（退出码 2），不静默空转、不无限重试。
- 事件处理失败只写失败日志，绝不伪装成功。
- 本地命令同样受 §6 三项上限约束：15 分钟无输出 kill、1 小时硬上限 kill、
  每群每天 ≤100 次（计数在 `listener-state.json` 的 `local_runs`，跨天清零，
  重启不清零）。到上限时事件留给 check-in，不静默丢弃。
- 引擎侧仍有节流 / 合并 / 每日上限 / 失败禁用，Listener 不是绕过它们的通道。

## 2. 前置条件

1. 该 Agent 已在 Phase 2 配对，拿到 `pachat_...` token（`agent_pair`）。
2. 它至少在一个群里是成员（`chat_add_member`，或配对时 `chat_ids`）。
3. 群主为它打开唤醒：`wake_enable`（owner-only）。默认未配置等价于启用，
   但显式配置后状态可查、可恢复。

## 3. 安装（手动步骤，引擎不会替你装）

项目文档 §7.4 的约束照原样执行：**不擅自安装开机启动服务、不擅自开启 Full Access、
不同 Agent 用独立 Credential、安装必须获得群主明确授权**。

```bash
# 1) token 放进 600 权限文件（不要放命令行、不要进仓库、不要进日志）
mkdir -p ~/.agent-workbench
install -m 600 /dev/null ~/.agent-workbench/listener-token
printf '%s\n' 'pachat_xxx' > ~/.agent-workbench/listener-token   # 或用编辑器写入
chmod 600 ~/.agent-workbench/listener-token

# 2) 前台试跑（确认能连上、能收到事件）
node scripts/listener.mjs --agent agent_demo \
  --base-url http://127.0.0.1:8080 \
  --token-file ~/.agent-workbench/listener-token \
  --command "your-agent-cli --headless"

# 3) 确认无误后，由群主自己选择常驻方式（二选一，均需明确授权）
#    a. 前台 / screen / tmux
#    b. 平台自带的 service 管理器；示例 systemd：
#       WorkingDirectory=/path/to/agent-workbench
#       ExecStart=/usr/bin/node scripts/listener.mjs --agent agent_demo ...
#       Restart=on-failure
```

> Windows：token 文件的 POSIX mode 无意义，`readTokenFile` 不做 600 校验；
> Listener 启动时会在日志里写一条警告，提醒你用 ACL 把文件限制到当前用户。
> 请把文件放在当前用户目录并配置 ACL。**不要**把 token 写进 `.bat`、
> 命令行参数或仓库。

## 4. 参数

| 参数 | 说明 |
|---|---|
| `--agent` | 必填，Agent id 或 handle（`agent_demo` / `agent_xxx`） |
| `--chat` | 可选，只订阅一个群；省略 = 该 Agent 的全部群 |
| `--base-url` | 引擎地址，默认 `WORKBENCH_URL` 或 `http://127.0.0.1:8080` |
| `--mcp-url` | 默认 `<base-url>/mcp` |
| `--token-file` | 默认 `~/.agent-workbench/listener-token`，必须 600 |
| `--state-file` | 默认与 token 同目录的 `listener-state.json` |
| `--log-file` | 默认与 token 同目录的 `listener.log` |
| `--command` | 引擎报“no local executor”时执行的本地命令；事件 JSON 在 `LISTENER_EVENT`，另有 `LISTENER_AGENT` / `LISTENER_CHAT_ID` |
| `--no-wake-now` | 不调 MCP，直接走本地命令 |
| `--once` | 处理完一条事件即退出（排障用） |
| `--connect-timeout-ms` | 连续无连接多久退出，默认 60000 |

退出码：`0` 正常暂停/一次性完成，`1` 参数或 token 文件错误，`2` 连续 1 分钟连不上。

## 5. 暂停

```bash
# 前台：Ctrl+C（SIGINT）→ 正常退出，游标已落盘
# service：systemctl stop <unit> / 任务管理器结束进程
```

暂停后事件不会丢：引擎仍在 `wake_events` + Inbox 里记录；重新启动时带
`since_seq` 续接，或由 `agent_checkin` 拉取。

## 6. 卸载

```bash
# 1) 停进程并禁用自启（如果你配置过）
systemctl disable --now <unit>

# 2) 撤销 token（引擎侧）
#    MCP: agent_revoke_token { "agent_id": "agent_demo" }

# 3) 删除本地文件
rm -f ~/.agent-workbench/listener-token \
      ~/.agent-workbench/listener-state.json \
      ~/.agent-workbench/listener.log
```

不需要改数据库；`listener_sessions` 里的旧会话会在引擎重启时标为 disconnected。

## 7. 日志

- `listener.log`：追加写，每行带 ISO 时间。记录连接/断线/事件/触发/失败。
- 不记录 token；事件只记录 `seq/kind/chat/message`，不记录消息正文。
- 引擎侧同源日志：`data/wake.log`（脱敏、append-only）和
  `data/security-audit.log`（越权订阅等拒绝）。
- 状态随时可查：
  - MCP `listener_status`：会话、最后 seq、在线状态；
  - MCP `wake_status`：每群开关、失败计数、今日运行数；
  - `GET /health` 的 `wake` 段：服务是否在跑、在线 listener 数、积压事件数。

## 8. 协议要点

- **鉴权**：Bearer token。Agent token 只能订阅自己是成员的群，且只收到
  `agent_id` 指向自己的事件；越权订阅返回 403 并写审计。
- **续接**：`?since_seq=` 或 `Last-Event-ID`。保留 7 天；更老的 gap 返回
  `event: resync`，客户端改走 `PUT /checkin` / `agent_checkin`。
- **背压**：单连接未消费积压超过 1000 条即断开，客户端带游标重连。
- **心跳**：25 秒。Cloudflare 隧道会掐掉静默长连接。
- **Check-in**：`PUT /checkin { every }`（2–1440 分钟，默认 10）；返回 Inbox
  摘要。连续 3 次空 check-in 只**建议**把间隔翻倍，不强制改客户端配置。