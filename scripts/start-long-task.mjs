import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) process.exit(1);
const port = process.env.MCP_PORT || '8080';
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: 'aw-start-long', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
const result = JSON.parse(textOf(await client.callTool({
  name: 'task_start',
  arguments: {
    agent: 'dsh',
    prompt: 'Write a 5000-word essay about the history of the ocean. Do not stop early.'
  }
})));
console.log(JSON.stringify(result));
await client.close();