# 发布流水线与自动更新验证

> 状态：已落地并通过真实 CI + 本机端到端验证
> 日期：2026-11-13
> 工作流：`.github/workflows/release.yml`
> 校验脚本：`gui/scripts/verify-release.mjs`
> 适用范围：Windows x64，NSIS 安装包，未签名（v0.1 决策）

---

## 1. 流水线目标

正式发布必须满足三个条件，任一不满足工作流直接失败：

1. 产出 NSIS 安装包、对应的 `.exe.blockmap` 与 `latest.yml`；
2. `latest.yml` 中的版本、文件名、大小、sha512 与安装包字节完全一致；
3. 上传到 GitHub Release 后，重新下载三项资产并再次通过同一校验。

流水线不从工作区直接发布，构建来源固定为触发 tag 的提交。这一点用于修正 spike 中 `v0.0.2` 由未提交工作区构建、资产不可追溯的问题。

## 2. 工作流结构

| 阶段 | 内容 |
|---|---|
| 触发 | 推送 `v*` tag；或手动 `workflow_dispatch`（输入 version / tag / prerelease） |
| 环境 | `windows-latest`，Node.js 22，npm 缓存 |
| 版本 | tag 去掉前缀 `v` 后必须是 SemVer；tag 必须等于 `v${version}` |
| 构建 | `npm ci` → `npm version <version> --no-git-tag-version` → `npm run build` |
| 打包 | `electron-builder --win nsis --publish never` |
| 本地校验 | `verify-release.mjs --dir release --version <version>` |
| 工作流产物 | 上传安装包、blockmap、`latest.yml` 到 Actions Artifacts（保留 14 天） |
| 发布 | `gh release create` 或 `gh release upload --clobber`，同时上传三项资产 |
| 远端校验 | `gh release download` 重新下载三项资产，再次运行 `verify-release.mjs`，并检查 `isPrerelease` 与资产名单 |

发布阶段刻意不使用 electron-builder 的 `--publish always`。spike 实测该路径曾返回 `422 Published releases must have a valid tag` 且漏传 `latest.yml`/blockmap；改为“本地构建 + `gh release` 显式上传”后，资产完整性由脚本和远程复核双重保证。

## 3. 版本与 Release 规则

| tag 示例 | 版本 | Release 类型 | 用途 |
|---|---|---|---|
| `v0.1.0-rc.1` | `0.1.0-rc.1` | prerelease | 更新流程验证、候选版本 |
| `v0.1.0` | `0.1.0` | 正式发布 | v0.1 功能完整后再打 |

- 含 `-rc` / `-beta` 等预发布后缀的 tag 自动标记为 prerelease；手动触发时由 `prerelease` 输入控制。
- 未签名是当前既定策略；SmartScreen 首次安装提示“仍要运行”不属于流水线失败。
- v0.0.2 是历史正式 Release，仍被稳定通道视为 latest；预发布构建不会被稳定通道接收。

## 4. 如何发版

### 4.1 通过 tag 发布（已验证路径）

```bash
git checkout gui/v0.1
git pull
git tag -a v0.1.0-rc.3 -m "Agent Workbench 0.1.0-rc.3"
git push origin v0.1.0-rc.3
```

推送后：

```bash
gh run list --workflow release.yml --limit 3
gh run watch <run-id> --exit-status
gh release view v0.1.0-rc.3 --json tagName,isPrerelease,assets
```

工作流会自动完成构建、校验、上传与远端复核。不要手工补传资产；如果工作流失败，修复后重新打 tag 或使用手动触发。

### 4.2 手动触发

`workflow_dispatch` 需要工作流文件已存在于默认分支。当前 `release.yml` 位于 `gui/v0.1`，在合并到默认分支前，tag 推送是唯一已验证的触发方式。合并后可以：

```bash
gh workflow run release.yml --ref gui/v0.1 \
  -f version=0.1.0-rc.3 \
  -f tag=v0.1.0-rc.3 \
  -f prerelease=true
```

## 5. 校验清单

### 5.1 本地构建校验

```bash
cd gui
npm run typecheck
npm run release:local
```

`release:local` 会构建、打包并运行 `verify-release.mjs`。成功输出示例：

```text
[verify-release] OK {"version":"0.1.0","installer":"AgentWorkbench-Setup-0.1.0.exe","installerBytes":132880375,"installerMiB":126.72,"blockmap":"AgentWorkbench-Setup-0.1.0.exe.blockmap","blockmapBytes":138240,...}
```

校验脚本实际检查：

- 安装包存在且大于 10 MiB；
- `latest.yml` 存在、非空，`version` 等于预期版本，`path` 等于安装包文件名；
- `latest.yml` 的 `sha512` 与 `files[0].sha512` 等于安装包实际 SHA-512（Base64）；
- `files[0].size`（以及存在时的顶层 `size`）等于安装包字节数；
- blockmap 存在、非空，可 gunzip 为 JSON，格式版本为 `2`，且至少有一条带 name/checksums 的文件记录。

### 5.2 CI 校验

工作流两个校验步骤都必须为绿色：

1. `Verify local release assets`：构建目录三项资产；
2. `Verify assets downloaded from the GitHub Release`：从 Release 重新下载三项资产后再校验，并确认 `isPrerelease` 与资产名单。

Actions 页面还能下载 `agent-workbench-<version>` 产物，作为“构建产物可下载”的证据。

### 5.3 自动更新校验

1. 安装旧版本（例如 rc.1）：`AgentWorkbench-Setup-0.1.0-rc.1.exe /S`
2. 确认已安装版本：`"Agent Workbench.exe" --print-version`
3. 发布新版本（例如 rc.2），确认其 Release 三项资产通过远端校验。
4. 运行更新验证（安装目录下的 exe）：

```powershell
$env:AGENT_WORKBENCH_UPDATE_TRACE = "$env:TEMP\aw-update.jsonl"
$env:AGENT_WORKBENCH_UPDATE_PROXY = "http://127.0.0.1:7897"   # 或使用系统代理
& "$env:LOCALAPPDATA\Programs\agent-workbench-gui\Agent Workbench.exe" --update-verify --update-channel=prerelease
```

验证模式会依次执行：检查 → 下载 → 静默安装，并把带时间戳的事件写入 `${TRACE}`（JSONL）。`--print-version` 会把版本写入 `${TRACE}.result.jsonl`，用于确认安装后的版本。

可用调试环境变量：

| 变量 | 作用 |
|---|---|
| `AGENT_WORKBENCH_UPDATE_TRACE` | 写入更新事件与验证结果的路径 |
| `AGENT_WORKBENCH_UPDATE_CHANNEL` | 等价于 `--update-channel=`，`stable` 或 `prerelease` |
| `AGENT_WORKBENCH_UPDATE_PROXY` | 为 electron-updater 指定代理，例如 `http://127.0.0.1:7897` |
| `AGENT_WORKBENCH_UPDATE_DIRECT=1` | 强制直连；大文件不稳定，仅建议诊断用 |
| `AGENT_WORKBENCH_AUTO_UPDATE_CHECK=0` | 关闭打包版启动后的自动检查 |
| `AGENT_WORKBENCH_UPDATE_DEBUG=1` | 将 updater 日志写入 `userData/engine/updater.log` |

## 6. 2026-11-13 实测记录

### 6.1 流水线运行

| 版本 | 结果 | 耗时 | 安装包 | blockmap | latest.yml |
|---|---|---|---:|---:|---:|
| 0.1.0-rc.1 | 成功 | 2m14s | 128,493,300 B（122.54 MiB） | 134,677 B | 372 B |
| 0.1.0-rc.2 | 成功 | 1m59s | 128,493,382 B（122.54 MiB） | 134,531 B | 372 B |

两个 Release 均为 prerelease，三项资产均通过“上传后重新下载”校验。工作流另有一条非阻塞提示：`actions/checkout@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4` 目前被 GitHub 强制在 Node 24 上运行，属于 action 自身的 Node 20 弃用提示，不影响结果。

### 6.2 自动更新验证

由 rc.1 更新到 rc.2，两次真实运行：

| 场景 | 检查 | 下载 | 安装开始 | 进程退出 | 安装完成 |
|---|---:|---:|---:|---:|---:|
| 差分更新（缓存命中） | 2.0 s | 800,228 B / 12.4 s | 14.55 s | 17 s | 轮询确认 rc.2 |
| 完整下载（清缓存 + 代理） | 2.65 s | 128,493,382 B / 14.6 s | 17.47 s | 20.1 s | 37.5 s |

- 两次均无需手动点击安装；`quitAndInstall(true, false)` 触发静默 NSIS 安装，安装完成后 exe 文件版本与 `--print-version` 均为 `0.1.0-rc.2`。
- 完整下载走 `127.0.0.1:7897` 代理，实测约 10.5 MB/s；同一轮直连在下载到约 50% 时出现 `net::ERR_CONNECTION_RESET`（耗时 429 s），因此大文件更新建议保持系统代理或显式设置 `AGENT_WORKBENCH_UPDATE_PROXY`。
- 差分更新只下载了 800,228 B（完整包 128,493,382 B），说明 blockmap 差分路径有效。

## 7. 故障排查

| 现象 | 原因/处理 |
|---|---|
| 工作流在 `Verify local release assets` 失败 | 缺少安装包/blockmap/latest.yml，或 latest.yml 与安装包字节不一致；不要手工补传，重新构建 |
| `422 Published releases must have a valid tag` | 不复现于当前方案；流水线不再使用 `--publish always` |
| 更新检查提示 403 / 限流 | 代理共享出口可能触发 GitHub API 限流；改用直连或更换代理出口 |
| 大文件下载中途 `ERR_CONNECTION_RESET` | 直连不稳定；设置 `AGENT_WORKBENCH_UPDATE_PROXY` 或恢复系统代理后重试 |
| 预发布版本检查不到 | 当前版本/通道需要 prerelease；使用 `--update-channel=prerelease` 或在设置页切换通道 |
| 更新下载被缓存“跳过” | 删除 `%LOCALAPPDATA%\agent-workbench-gui-updater\pending` 后重试，可强制完整下载 |
| 安装后仍是旧版本 | 确认安装目录 exe 的 `FileVersion`；检查是否有旧实例未退出（单实例锁会阻止更新验证启动） |
| 本地打包下载 winCodeSign 超时（本机直连 github.com 不稳定时） | 设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 并临时走代理；CI 的 Windows runner 不需要 |

## 8. 回滚与保留

- 预发布版本回滚：停止使用对应 tag；已安装客户端可重新安装旧版本。删除 Release 会移除该版本的更新源，需先确认没有客户端依赖。
- 正式版本发布后不要删除已安装客户端可能引用的 Release；发布更高版本是首选回滚方式。
- 当前 rc.1 / rc.2 为测试发布，保留作为流水线与更新验证证据；它们不会成为稳定通道的 latest。