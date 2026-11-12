import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) process.exit(1);
const url = process.env.MCP_URL || `http://127.0.0.1:${process.env.MCP_PORT || '8080'}/mcp`;
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
const client = new Client({ name: 'aw-tailnet-smoke', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
const call = async (name, args) => JSON.parse(textOf(await client.callTool({ name, arguments: args })));

const started = await call('task_start', {
  agent: 'claude',
  prompt: 'What is 5+7? Answer with just the number.'
});
console.log('START:', JSON.stringify(started));
const deadline = Date.now() + 120000;
let status;
for (;;) {
  status = await call('task_status', { task_id: started.task_id });
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.state)) break;
  if (Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('STATUS:', status.state, JSON.stringify(status.summary));
await client.close();