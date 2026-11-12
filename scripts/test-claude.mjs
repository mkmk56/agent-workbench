import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) process.exit(1);
const port = process.env.MCP_PORT || '8080';
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: 'aw-claude-test', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
const call = async (name, args) => JSON.parse(textOf(await client.callTool({ name, arguments: args })));

async function waitUntil(taskId, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const status = await call('task_status', { task_id: taskId });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    if (Date.now() >= deadline) return status;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.log('INFO:', JSON.stringify(await call('agent_info', {})));

const t1 = await call('task_start', {
  agent: 'claude',
  prompt: 'What is 2+2? Answer with just the number.'
});
const s1 = await waitUntil(t1.task_id, 120);
console.log('T1:', s1.state, JSON.stringify(s1.summary));

const logs = await call('task_logs', { task_id: t1.task_id });
console.log('T1 LOG TAIL:', logs.entries.slice(-8).map((e) => `${e.stream}: ${e.line}`).join(' | ').slice(0, 1200));

const t2 = await call('task_send', {
  session_id: t1.session_id,
  prompt: 'Add 3 to the previous answer. Answer with just the number.'
});
const s2 = await waitUntil(t2.task_id, 120);
console.log('T2:', s2.state, JSON.stringify(s2.summary));

await client.close();