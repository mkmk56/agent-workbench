# 验收记录（2026-11-12）

## 环境

- Windows 11 Home China，Node v22.20.0，npm 10.9.3
- Claude Code 2.1.270（独立 CLI 未登录）
- DeepSeek Harness 0.1.0-rc.6
- Tailscale 1.104.6（当前后端状态 Stopped）
- 项目目录：`D:\Claude\agent-workbench`

## 已通过

| # | 项目 | 命令/方式 | 实际结果 |
|---|---|---|---|
| 1 | 服务启动 | `npm start` | `http://127.0.0.1:8080` 监听成功，`/health` 返回 `ok:true` |
| 2 | 无 token 鉴权 | `POST /mcp` 无 Authorization | 401 |
| 3 | 错 token 鉴权 | `POST /mcp` + `Bearer wrong` | 401 |
| 4 | 工具列表 | MCP `tools/list` | 8 个：`agent_info, task_cancel, task_list, task_logs, task_send, task_start, task_status, wait_for_task` |
| 5 | agent_info | MCP 调用 | claude 2.1.270 available=true, logged_in=false；dsh 0.1.0-rc.6 available=true, resume_supported=false |
| 6 | dsh 单次任务 | `task_start` + `wait_for_task` | COMPLETED，summary `"OK"`，exit 0 |
| 7 | dsh 续聊（历史拼接） | `task_send` + 轮询 | COMPLETED，summary `"DONE"`；直接 CLI 实测耗时 39s |
| 8 | 任务列表 | `task_list` | 返回最近任务及状态 |
| 9 | 取消 | `task_cancel` | CANCELLED，进程树被清理，无残留 node.exe |
| 10 | 并发限制 | 同时启动 3 个 dsh 任务 | 立即状态为 2×WORKING + 1×PENDING，随后全部 COMPLETED |
| 11 | 崩溃恢复 | 杀掉服务进程后重启 | 未完成任务标为 FAILED，无孤儿 node.exe；服务重启成功 |
| 12 | token 泄露扫描 | 扫描 data/logs/脚本 | 未发现 token 明文 |
| 13 | Claude 任务（内部 DeepSeek 网关） | `task_start` agent=claude | COMPLETED，summary `"4"` |
| 14 | Claude 续聊 | `task_send` | COMPLETED，summary `"7"`；`--resume` 正常 |
| 15 | tailnet HTTP 入口 | `tailscale serve --bg --http=80` + `curl` | health 正常；`http://niumoi.tail117bda.ts.net/mcp` 可列工具、调用 agent_info |
| 16 | tailnet 端到端任务 | 经 tailnet URL `task_start` claude | COMPLETED，summary `"12"` |
| 17 | 看门狗重启 | 杀掉服务 PID | 约 1 秒内自动重启，新 PID 生效 |
| 18 | Cloudflare HTTPS health | `curl https://…trycloudflare.com/health` | 200，返回 `ok:true` |
| 19 | HTTPS MCP 无 token | `POST /mcp` | 401 |
| 20 | HTTPS MCP 带 token | `remote-check` | 8 个工具 + agent_info 正常 |
| 21 | token 轮换 | 替换 `workbench.env` 后重启 | 新 token 验证通过；旧 token 已从配置移除 |

## 未通过 / 未验证

| 项目 | 原因 | 后续 |
|---|---|---|
| Tailscale HTTPS（Serve 443 / Funnel） | 本机访问 Let's Encrypt ACME 超时（`acme-v02.api.letsencrypt.org` 20s 无响应），无法签发证书 | 已改用 tailnet HTTP Serve；若必须 HTTPS 443，改用 Cloudflare Tunnel |
| 服务级自启（Task Scheduler/NSSM） | `Register-ScheduledTask` 返回 PermissionDenied（需要管理员） | 当前用用户 Startup + VBS 看门狗；需要时提权配置 NSSM |
| Cloudflare Tunnel | 未安装 cloudflared，未创建公网入口 | 仅当 Muse 客户端拒绝 HTTP/80 时启用 |

## 与任务书不一致的实现（均已实测）

1. **dsh 凭据**：桌面端新版 `.credentials.yaml` 是 `version/refs/records` 结构，CLI 0.1.0-rc.6 只接受扁平的“凭据名→字符串”。已为 headless profile 单独指定 `C:\Users\yikai\.dsh\.credentials-headless.yaml`（通过 `~/.dsh/profiles/headless/cordis.patch.yml` 的 credentials patch），桌面端文件未改动。`refs` 中的 5 个 key 已平铺写入新文件。
2. **dsh 多轮**：`dsh --profile headless --resume` 报 `unknown option '--resume'`；`dsh --profile web` 的 `/api` 是 RPC 通道不是 REST 路由；`acp` profile 不存在。因此多轮采用服务端历史拼接，`agent_info` 如实标注 `resume_supported:false`。
3. **Claude 执行方式**：`claude --bg` 与 `--print` 冲突，且 bypass 需交互式接受免责声明；改用 `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`，自管进程、日志和取消。执行器注入 `~/.claude/settings.json` 的 `env`（本机是内部 DeepSeek 网关 `https://maas.qianwenaiapi.com/apps/anthropic`，模型 `deepseek-v4.1-flash`），无需 Anthropic 登录；单次与续聊均已实测通过。
4. **`--max-turns`**：Claude Code 2.1.270 的 `--help` 中没有该参数；工具 schema 接受但忽略。
5. **恢复策略**：重启后未完成任务直接标 FAILED（并清理进程树），而不是 STALE；原因：stdout 管道无法重新接管，标记 STALE 没有可操作性。
6. **环境文件**：配置放 `workbench.env` 而不是 `.env`；dsh 会把任务 cwd 下的 `.env` 当环境层读取，并拒绝 `DSH_*` 等保留变量。
7. **执行器 PID**：直接 spawn `node dsh/lib/bin.js` 和 `claude.exe`，避免 cross-spawn 记录到 `cmd.exe` 垫片 PID 导致孤儿进程；`logs/server.pid` 记录服务自身 Windows PID。
8. **外部入口**：Muse 官方客户端强制 HTTPS/443；Tailscale HTTPS 因 ACME 被挡无法签发，故用 Cloudflare quick tunnel 暴露 `https://…trycloudflare.com/mcp`（临时 URL），同时保留 tailnet HTTP 入口。quick tunnel URL 随进程重启变化。
9. **自启与看门狗**：Task Scheduler 注册被拒（需管理员）；改用用户 Startup 文件夹中的 `AgentWorkbench.vbs`，隐藏运行 `start-workbench.cmd`，并在非零退出时每 5 秒重启。

## 复现命令

```powershell
cd D:\Claude\agent-workbench
npm start
# 另开终端（需要 workbench.env 里的 token）：
node --env-file-if-exists=workbench.env scripts/test-client.mjs
node --env-file-if-exists=workbench.env scripts/test-flows.mjs
node --env-file-if-exists=workbench.env scripts/test-concurrency.mjs
# tailnet 入口（PowerShell）：
$env:MCP_URL="http://niumoi.tail117bda.ts.net/mcp"; node --env-file-if-exists=workbench.env scripts/remote-check.mjs
```