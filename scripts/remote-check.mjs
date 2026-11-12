import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) {
  console.error('MCP_BEARER_TOKEN is required');
  process.exit(1);
}
const url = process.env.MCP_URL || `http://127.0.0.1:${process.env.MCP_PORT || '8080'}/mcp`;
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
const client = new Client({ name: 'aw-remote-check', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
console.log('URL:', url);
console.log('TOOLS:', (await client.listTools()).tools.map((t) => t.name).sort().join(','));
console.log('INFO:', textOf(await client.callTool({ name: 'agent_info', arguments: {} })));
await client.close();