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
const client = new Client({ name: 'aw-flow-test', version: '0.0.1' });
await client.connect(transport);

const textOf = (result) => result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(result);
const call = async (name, args) => JSON.parse(textOf(await client.callTool({ name, arguments: args })));

async function waitUntil(taskId, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const status = await call('task_status', { task_id: taskId });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.state)) return status;
    if (Date.now() >= deadline) return status;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const t1 = await call('task_start', {
  agent: 'dsh',
  prompt: 'Reply with exactly the word OK and nothing else.'
});
const s1 = await waitUntil(t1.task_id, 90);
console.log('T1:', s1.state, JSON.stringify(s1.summary));

const t2 = await call('task_send', {
  session_id: t1.session_id,
  prompt: 'Reply with exactly the word DONE and nothing else.'
});
const s2 = await waitUntil(t2.task_id, 120);
console.log('T2:', s2.state, JSON.stringify(s2.summary));

const list = await call('task_list', { limit: 10 });
console.log('LIST:', list.tasks.map((t) => `${t.agent}:${t.state}`).join(','));

const t3 = await call('task_start', {
  agent: 'dsh',
  prompt: 'Write a 500-word essay about the ocean.'
});
await new Promise((r) => setTimeout(r, 1000));
const cancelled = await call('task_cancel', { task_id: t3.task_id });
console.log('CANCEL:', cancelled.status);
await new Promise((r) => setTimeout(r, 6000));
const s3 = await call('task_status', { task_id: t3.task_id });
console.log('T3:', s3.state, 'exit_code=', s3.exit_code);

const info = await call('agent_info', {});
console.log('INFO:', JSON.stringify(info));

await client.close();