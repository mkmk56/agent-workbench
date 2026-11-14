# Deploying agent-workbench on Cloady

> Status 2026-11-14: the container files are in the repository, but the maintainer's Windows machine has **no Docker, WSL or podman**, so the image has **not been built or run locally**. Build and smoke-test it on a Docker host before deploying. Linux findings below come from npm registry metadata and local package inspection; the "not measured" rows are explicit.

## What the image contains

- Node.js 22 (Debian slim), `git`, CA certificates.
- `@anthropic-ai/claude-code` **2.1.325** (pinned).
- `@deepseek-ai/dsh` **0.1.0-rc.6** (pinned; the same version the Windows engine runs).
- The engine (`src/server.js`): `POST /mcp` with Bearer auth, `GET /health` without auth.

## Linux feasibility findings

| Item | Finding | Evidence / limit |
|---|---|---|
| Claude Code CLI on Linux | Supported by the official npm package. 2.1.325 declares optional Linux binaries (`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`), `engines.node >=22`, and its postinstall copies the matching binary to `bin/claude.exe` (an ELF binary on Linux). | npm metadata + `install.cjs` inspection. **Not executed on Linux** here; no local Linux runtime. |
| dsh on Linux | Distributed through npm. GitHub releases (`dsh-v0.2.2-rc.*`) have **no platform assets** — npm is the install channel. The package has no `os`/`cpu` restriction and its native optional dependencies publish Linux glibc builds (`node-addon-require-builtin-linux-x64-gnu`, `@koromix/koffi-linux-x64`, `@img/sharp-linux-x64`). | npm registry + GitHub release metadata. **Not executed on Linux** here. |
| `node-pty` (dsh dependency) | The published tarball has prebuilds for `darwin-*`/`win32-*` only; on Linux npm falls back to `node-gyp rebuild`. | Inspected installed package. The Dockerfile build stage installs `python3 make g++` and reuses the Node image headers. |
| Version constraint | dsh `latest` (0.2.2-rc.1) requires `engines.node >=24.9.0`; the image is Node 22, so it pins **0.1.0-rc.6** (no engines restriction; verified on Node 22.20.0 on Windows). Moving to dsh 0.2.x needs a Node 24+ base image. | npm metadata; RESUME §K. |

## Environment variables

Set these in Cloady's environment/secret panel. Do **not** commit real values to the repository.

### Required

| Variable | Required | Purpose |
|---|---|---|
| `MCP_BEARER_TOKEN` | **yes**, at least 32 characters | Bearer token for `/mcp`. The engine refuses to start without it. Generate a random 48+ character value. |
| `MCP_BIND` | no (image default `0.0.0.0`) | Listen address. The image sets `0.0.0.0` so Cloady's proxy can reach it. Local Windows default remains `127.0.0.1`. |
| `MCP_PORT` | no (image default `8080`) | Listen port. Must match the platform port (`--port 8080`). The engine intentionally reads `MCP_PORT`, not `PORT`. |

### Claude Code gateway (choose one)

| Variable / mount | Purpose |
|---|---|
| `WORKBENCH_CLAUDE_ENV_JSON` | Inline JSON object with the same keys as the `env` block in `~/.claude/settings.json`. The image does not need a settings file. Keys observed on the maintainer's machine: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`. Use placeholders in examples, never real values. |
| `WORKBENCH_CLAUDE_SETTINGS` | Path to a mounted `settings.json`; the engine reads its `env` object. |
| Mount at `/home/node/.claude/settings.json` | Default path, read automatically when neither variable above is set. |

The inline JSON wins over a settings file. After parsing, the engine removes `WORKBENCH_CLAUDE_ENV_JSON` from its own environment so executor processes do not inherit the raw JSON; the parsed values are still injected into `claude`.

### dsh headless credentials (optional; only if you use the dsh executor)

| Variable / mount | Purpose |
|---|---|
| `DSH_CREDENTIALS_YAML` | Flat YAML content, written by the entrypoint to `/home/node/.dsh/.credentials-headless.yaml` with mode `600`. Keys observed: `DEEPSEEK_API_KEY`, `BAILIAN_API_KEY`, `BAILIAN1_API_KEY`, `BAILIAN2_API_KEY`, `BAILIAN3_API_KEY`. Multiline values must contain real newlines, not `\n` escapes. |
| Mount `/home/node/.dsh/.credentials-headless.yaml` | Use a platform secret file instead of the variable. |
| `DSH_HEADLESS_PATCH_YAML` | Optional profile patch, written to `/home/node/.dsh/profiles/headless/cordis.patch.yml`. It selects providers/models and points at the credentials file; it contains no secrets. If you copy the Windows patch, change its credential `path` to `/home/node/.dsh/.credentials-headless.yaml`. dsh's profile initializer keeps an existing patch and only fills in missing profile files. |
| Mount `/home/node/.dsh/profiles/headless/cordis.patch.yml` | Alternative to the variable. |

If dsh is not configured, the engine still runs; only `dsh` tasks fail with a clear "executable not found" or dsh credential error.

### Optional tuning

| Variable | Default | Meaning |
|---|---|---|
| `MAX_PARALLEL_TASKS` | `4` | Global concurrency limit |
| `WORKBENCH_DSH_MAX_PARALLEL_TASKS` | `2` | dsh-specific concurrency limit |
| `TASK_TIMEOUT_MS` | `1800000` | Per-task timeout (30 min) |
| `STALE_AFTER_MS` | `600000` | Silence threshold before a running task becomes STALE |
| `HEARTBEAT_MS` | `15000` | Heartbeat log interval |
| `RATE_LIMIT_PER_MIN` | `600` | Per-client requests per minute on `/mcp` |
| `AGENT_APPROVAL_GATE` | `0` | Chat approval gate for merge/delete/dependency operations |
| `APPROVAL_TIMEOUT_MS` | `600000` | Approval wait timeout (treated as deny) |
| `AGENT_MESSAGE_LIMIT` | `10` | Agent-to-agent exchange cap per thread |
| `AGENT_SUMMARY_MAX_TOKENS` | `500` | Conclusion-summary token cap |
| `AGENT_AUTO_DELIVER` | `1` | Set `0` to disable automatic agent-to-agent delivery |

### Build arguments

| Argument | Default | Meaning |
|---|---|---|
| `CLAUDE_CODE_VERSION` | `2.1.325` | Claude Code CLI version |
| `DSH_VERSION` | `0.1.0-rc.6` | dsh version |
| `INSTALL_DSH` | `1` | Set `0` to build a claude-only image |
| `NPM_REGISTRY` | `https://registry.npmjs.org` | Registry used for the CLI installs and the engine's `npm ci`. Set `https://registry.npmmirror.com` if the build network cannot reach npmjs. The lockfile's recorded host is replaced at install time. |

## Build and test on a Docker host

```sh
docker build -t agent-workbench:local .

# Health only (no credentials needed):
docker run --rm -p 8080:8080 \
  -e MCP_BEARER_TOKEN='<at-least-32-random-characters>' \
  agent-workbench:local

curl -s http://127.0.0.1:8080/health
```

With the Claude gateway and a persistent data directory:

```sh
docker run --rm -p 8080:8080 \
  -e MCP_BEARER_TOKEN='<at-least-32-random-characters>' \
  -e WORKBENCH_CLAUDE_ENV_JSON='{"ANTHROPIC_BASE_URL":"https://your-gateway.example/anthropic","ANTHROPIC_AUTH_TOKEN":"<your-token>","ANTHROPIC_MODEL":"<model>"}' \
  -v "$PWD/container-data:/app/data" \
  agent-workbench:local
```

MCP smoke test:

```sh
curl -s -X POST http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer <at-least-32-random-characters>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

Then run one small real task through `task_start` to confirm the gateway and executor work. Do not bake credentials into the image or commit them.

Claude-only fallback if dsh fails to build on Linux:

```sh
docker build --build-arg INSTALL_DSH=0 -t agent-workbench:local .
```

## Deploying on Cloady

Direction (confirm the current flag names with `cloady deploy --help`):

```sh
cloady deploy github.com/mkmk56/agent-workbench --type git --port 8080
```

Panel steps:

1. Create a new app and connect the GitHub repository `mkmk56/agent-workbench`.
2. Select branch `gui/v0.1` until it is merged into `main`.
3. Runtime: Dockerfile at `Dockerfile`; port `8080`; health check path `/health`.
4. Add the environment variables above. Mark the bearer token and any credential value as secrets.
5. Deploy and open the build logs. A healthy start prints:
   `agent-workbench MCP listening on http://0.0.0.0:8080/mcp`
6. Open `https://<cloady-domain>/health` and confirm `{"ok":true,...}`.
7. Send an MCP `initialize` with `Authorization: Bearer <MCP_BEARER_TOKEN>` to `/mcp`.
8. Point the cloud orchestrator (Muse connector) at `https://<cloady-domain>/mcp` with the same Bearer token.

If Cloady injects its own `PORT` value, set `MCP_PORT` to that same value. The engine does not read `PORT`.

## Known limitations

- **Not built or run locally.** Docker, WSL and podman are absent on the maintainer's machine. The Dockerfile is unvalidated until a Docker host builds it.
- **dsh Linux execution not measured.** The npm package and native optional dependencies indicate Linux support, but `dsh --version` and a headless task have not been run on Linux. Use `INSTALL_DSH=0` if the image build or runtime fails; Claude Code remains available.
- **dsh version pinned to 0.1.0-rc.6.** Newer dsh releases require Node >=24.9.0; the image is Node 22. Upgrading dsh means changing the base image to Node 24+ and re-running the engine tests.
- **node-pty compiles from source.** The first image build needs network access and a few minutes for `node-gyp`; the compiler stays in the build stage, not the runtime image.
- **Data is container-local.** `/app/data` and `/app/logs` are writable by the `node` user, but disappear when the container is replaced unless Cloady supports a persistent volume. Mount one if available and make sure it is writable by UID 1000 (`node`).
- **The container is not a sandbox.** Executors run with `--dangerously-skip-permissions` and can read/write files and reach the network inside the container. The Bearer token, Cloady access control and network isolation are the only guards. Keep the token secret and rotate it if exposed.
- **Non-root by design.** Claude Code refuses `--dangerously-skip-permissions` as root, so the image runs as `node`. Do not override `USER` to root; if a platform forces it, you would need `IS_SANDBOX=1`, which weakens a deliberate safety check.
- **No TLS in the container.** Cloady must terminate TLS. The engine binds plain HTTP.
- **Rate limiting uses proxy headers.** The engine reads `CF-Connecting-IP` or `X-Forwarded-For`. Behind Cloady's proxy, confirm one of them is set; otherwise every client shares one bucket. Direct exposure would let clients spoof these headers.
- **dsh cannot call MCP tools.** It has no MCP client, so it cannot use `send_message` or `request_approval`; the approval gate is an agent-honored instruction for dsh, not an enforced control.
- **Engine only.** The Electron GUI is not part of this image.

## Security checklist before exposing the URL

- [ ] `MCP_BEARER_TOKEN` is random, at least 32 characters, stored only in the platform's secret panel.
- [ ] No credential appears in the repository, image layers, build logs or task documents.
- [ ] `MCP_BIND=0.0.0.0` only inside the container; the platform proxy is the only public path.
- [ ] `/health` is the only unauthenticated endpoint.
- [ ] Rotate the token if it was ever printed or committed.
- [ ] Review who can reach the Cloady app URL: it can run commands with the executor's full permissions.