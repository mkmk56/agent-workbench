import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) process.exit(1);
const port = process.env.MCP_PORT || '8080';
const taskId = process.argv[2];
if (!taskId) {
  console.error('usage: node scripts/query-task.mjs <task_id>');
  process.exit(1);
}
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: 'aw-query-task', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
console.log(textOf(await client.callTool({ name: 'task_status', arguments: { task_id: taskId } })));
await client.close();