import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const envPath = 'D:/Claude/agent-workbench/workbench.env';
const envText = readFileSync(envPath, 'utf8');
const token = envText.match(/^MCP_BEARER_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) {
  console.error('MCP_BEARER_TOKEN not found in workbench.env');
  process.exit(1);
}

const template = `你好 Muse，本机的多 agent 工作台 MCP 服务已经上线，请你确认能否接入并做一次最小验证。

【端点】
- URL: http://niumoi.tail117bda.ts.net/mcp
- 传输: MCP Streamable HTTP（stateless），端口 80，纯 HTTP（不是 HTTPS）
- 网络: 仅 tailnet 内可达。你的云端 VM 和本机在同一个 tailnet（本机节点 niumoi / 100.115.102.17，你的节点 muse / 100.117.159.1）
- 认证头: Authorization: Bearer <TOKEN>
- 健康检查（无需 token）: http://niumoi.tail117bda.ts.net/health

【请依次确认】
1. 你的 MCP 客户端是否支持连接远程 Streamable HTTP server，并允许自定义 Authorization header？
2. 是否接受 http://...:80（而不是强制 https://...:443）？
3. 是否能解析 niumoi.tail117bda.ts.net 到 100.115.102.17，并访问健康检查？
4. 如果上述都支持，请用你的 MCP 客户端执行：
   initialize → tools/list → 调用 agent_info
   预期返回两个执行器：
   - claude 2.1.270（走内部 DeepSeek 网关，模型 deepseek-v4.1-flash）
   - dsh 0.1.0-rc.6（headless 一次性，多轮由服务端拼接历史）
5. 可用工具：agent_info, task_start, task_send, task_status, task_logs, task_cancel, task_list, wait_for_task

【如果连不上】
请给出具体卡点：DNS、TCP、TLS 强制、端口、代理、客户端不支持远程 MCP、还是 Authorization header 不支持。若你的客户端强制 HTTPS/443，也请直接说明——我会改用 Cloudflare Tunnel 提供一个公网 HTTPS 地址。

【背景】
本机服务只绑 127.0.0.1，对外由 Tailscale Serve 以 HTTP/80 暴露给 tailnet；Tailscale 的 HTTPS 证书在这条网络下因 Let's Encrypt ACME 超时无法签发，所以暂时用 HTTP。WireGuard 仍然加密 tailnet 内流量。

请用简短结论回复：能否连接；能连的话 agent_info 是否正常；不能的话卡在哪一步。`;

const message = template.replaceAll('<TOKEN>', token);
const tmp = join(tmpdir(), `muse-test-message-${Date.now()}.txt`);
writeFileSync(tmp, message, 'utf8');

const quoted = tmp.replace(/'/g, "''");
const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${quoted}')`], { encoding: 'utf8' });
unlinkSync(tmp);

if (ps.status !== 0) {
  console.error('Set-Clipboard failed:', ps.stderr);
  process.exit(1);
}

const check = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Clipboard -Raw).Length'], { encoding: 'utf8' });
console.log(`clipboard ready; chars=${message.length}; clipboard_chars=${String(check.stdout).trim()}`);