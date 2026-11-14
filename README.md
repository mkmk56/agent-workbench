# Agent Workbench

Local MCP server that lets a cloud orchestrator (Muse) dispatch tasks to Claude Code and DeepSeek Harness on this Windows machine.

## Quick start

1. Copy `workbench.env.example` to `workbench.env` and set `MCP_BEARER_TOKEN` (at least 32 random characters).
2. `npm install`
3. `npm start`

By default the server binds to `127.0.0.1:8080`; set `MCP_BIND=0.0.0.0` in a container. The MCP endpoint is `POST /mcp`; `GET /health` is unauthenticated.

On this machine the npm global prefix is `D:\workbuddy-tools\node\global`; executables are resolved to direct entries (`dsh/lib/bin.js` via `node`, `claude-code/bin/claude.exe`) so the recorded PID is the real process. Override with `WORKBENCH_NPM_GLOBAL`, `WORKBENCH_DSH_ENTRY`, or `WORKBENCH_CLAUDE_ENTRY` if those paths move.

## Container (Cloady)

A `Dockerfile` builds the engine for Linux (Node 22, Claude Code CLI, and dsh 0.1.0-rc.6). The image sets `MCP_BIND=0.0.0.0`; the local Windows default stays `127.0.0.1`. Credentials are supplied only through environment variables or mounted files. See [`docs/CLOADY_DEPLOY.md`](docs/CLOADY_DEPLOY.md) for the variable list, build commands, and limitations. The maintainer's Windows machine has no Docker, so the image has not been built or run locally; build it on a Docker host.

## Deployment on this machine

- Tailnet entry: `tailscale serve --bg --http=80 http://127.0.0.1:8080`
- Tailnet MCP URL: `http://niumoi.tail117bda.ts.net/mcp` (tailnet only)
- Public HTTPS entry: Cloudflare quick tunnel via `cloudflared tunnel --url http://127.0.0.1:8080`; the URL is printed in the cloudflared terminal. Quick-tunnel URLs are ephemeral and change when the process restarts; use a named tunnel + domain for a stable URL.
- Auth header: `Authorization: Bearer <MCP_BEARER_TOKEN>` (token lives in `workbench.env`; rotate by replacing it and restarting the server).
- Rate limit: `RATE_LIMIT_PER_MIN` (default 600) per client on `/mcp`.
- Auto-start: `AgentWorkbench.vbs` in the user's Startup folder runs `start-workbench.cmd` hidden; the VBS watchdog restarts the server every 5s on a nonzero exit.
- Tailscale HTTPS certificates are unavailable on this network (Let's Encrypt ACME times out), which is why the HTTPS entry goes through Cloudflare Tunnel.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MCP_BEARER_TOKEN` | required | Bearer token for `/mcp` |
| `MCP_PORT` | `8080` | Local port |
| `MAX_PARALLEL_TASKS` | `4` | Global concurrency limit |
| `WORKBENCH_DSH_MAX_PARALLEL_TASKS` | `2` | dsh-specific concurrency limit |
| `TASK_TIMEOUT_MS` | `1800000` | Per-task timeout (30 min) |
| `STALE_AFTER_MS` | `600000` | Silence threshold before a running task becomes STALE |
| `HEARTBEAT_MS` | `15000` | Heartbeat log interval |
| `RATE_LIMIT_PER_MIN` | `600` | Per-client requests per minute on `/mcp` |
| `WORKBENCH_CLAUDE_BIN` | `claude` | Claude Code executable |
| `WORKBENCH_DSH_BIN` | `dsh` | DeepSeek Harness executable |
| `AGENT_APPROVAL_GATE` | `0` | Chat approval gate for merge / delete / dependency operations; off keeps fully automatic behaviour |
| `APPROVAL_TIMEOUT_MS` | `600000` | Approval wait timeout; an unanswered request is treated as deny |

## MCP tools

- `agent_info` — executors, versions, capabilities, resume support
- `task_start` — start a task; returns immediately
- `task_send` — continue a session
- `task_status` — task state, exit code, summary
- `task_logs` — incremental logs with a cursor
- `task_cancel` — cancel and clean up the process tree
- `task_list` — recent tasks
- `send_message` — conclusion-only agent-to-agent message with `reply_to` threading
- `list_messages` — persisted messages and thread state
- `request_approval` — ask the user in chat before a critical operation (only active when the gate is on)
- `respond_approval` — answer a pending approval: `once` / `session` / `deny`
- `list_approvals` — persisted approval requests and decisions
- `wait_for_task` — long poll, max 40 seconds

## Critical-operation approval gate (default off)

Set `AGENT_APPROVAL_GATE=1` to require a chat approval before three categories of operation: merging/integrating/publishing code, deleting files or discarding existing work, and installing/removing/upgrading dependencies or changing dependency manifests/lockfiles. The agent calls `request_approval`; the engine writes a normal thread message in the form `[Agent HUD · 来自 <agent> · <task> <message-id>] <body>`, sets the thread to `WAITING_USER`, and blocks until the user answers `once`, `session` or `deny` (or `APPROVAL_TIMEOUT_MS` expires, which counts as deny). `once` covers that request; `session` also covers later operations of the same category in the thread. Users can answer with `respond_approval` or by replying to the question in chat.

The catalog and boundaries live in `src/approvals.js` and `docs/AGENT_HUD_APPROVAL.md`. This is an agent-honored gate, not an OS sandbox: the engine cannot inspect commands inside an executor process. `claude` has the local MCP client; `dsh` does not, so its prompt tells it not to perform these operations. With the gate off, `request_approval` returns immediately, sends nothing and the workbench behaves exactly as before.

## Executors

### Claude Code

Runs `claude -p <prompt> --output-format stream-json --verbose --dangerously-skip-permissions`, with `--session-id` for the first turn and `--resume` for follow-ups. The executor injects the `env` block from `~/.claude/settings.json`; on this machine that points at a DeepSeek gateway (`https://maas.qianwenaiapi.com/apps/anthropic`, model `deepseek-v4.1-flash`), so no Anthropic login is required. Without a configured gateway, run `claude auth login` once.

### DeepSeek Harness

Runs `dsh --profile headless <prompt>`. This version (0.1.0-rc.6) has no native session resume, so follow-ups are handled by server-side history stitching. `agent_info` reports `resume_supported: false` for dsh.

The headless profile uses a dedicated flat credentials file at `C:\Users\yikai\.dsh\.credentials-headless.yaml` (patched in `~/.dsh/profiles/headless/cordis.patch.yml`); the desktop app's `~/.dsh/.credentials.yaml` is untouched.

## Security

- Only binds `127.0.0.1`; expose it through Tailscale Serve (or another authenticated tunnel).
- Bearer token is required; the server refuses to start without one.
- Do not commit `workbench.env`, `data/`, or `logs/`.
- Workbench config lives in `workbench.env`, not `.env`: dsh treats a task cwd's `.env` as an environment layer and rejects reserved names such as `DSH_*`.
- Executors run with full permissions by explicit user authorization; the server itself exposes no arbitrary-command tool.

## Known limitations

- `claude` must be logged in separately from the desktop app session.
- dsh multi-turn is history stitching, not native resume.
- `dsh --profile web` serves the UI, but its `/api` is an RPC channel and is not used here.
- On restart, unfinished tasks are marked FAILED; process trees are killed.