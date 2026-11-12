import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) {
  console.error('MCP_BEARER_TOKEN is required');
  process.exit(1);
}
const port = process.env.MCP_PORT || '8080';

const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: 'aw-test-client', version: '0.0.1' });
await client.connect(transport);

const textOf = (result) => result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(result);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).sort().join(','));
console.log('AGENT_INFO:', textOf(await client.callTool({ name: 'agent_info', arguments: {} })));

const start = await client.callTool({
  name: 'task_start',
  arguments: { agent: 'dsh', prompt: 'Reply with exactly the word OK and nothing else.' }
});
console.log('TASK_START:', textOf(start));
const started = JSON.parse(textOf(start));

const waited = await client.callTool({
  name: 'wait_for_task',
  arguments: { task_id: started.task_id, timeout_s: 40 }
});
console.log('WAIT:', textOf(waited));

const logs = await client.callTool({ name: 'task_logs', arguments: { task_id: started.task_id } });
console.log('LOGS:', textOf(logs).slice(0, 1500));

const send = await client.callTool({
  name: 'task_send',
  arguments: { session_id: started.session_id, prompt: 'Repeat your previous answer exactly.' }
});
console.log('TASK_SEND:', textOf(send));
const sent = JSON.parse(textOf(send));
console.log('SEND_WAIT:', textOf(await client.callTool({
  name: 'wait_for_task', arguments: { task_id: sent.task_id, timeout_s: 40 }
})));

await client.close();