import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.MCP_BEARER_TOKEN;
if (!token) process.exit(1);
const port = process.env.MCP_PORT || '8080';
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);
const client = new Client({ name: 'aw-concurrency-test', version: '0.0.1' });
await client.connect(transport);
const textOf = (r) => r?.content?.map((c) => c.text).join('\n') ?? '{}';
const call = async (name, args) => JSON.parse(textOf(await client.callTool({ name, arguments: args })));
const states = async () => (await call('task_list', { limit: 6 })).tasks;

const starts = [];
for (const word of ['ONE', 'TWO', 'THREE']) {
  starts.push(await call('task_start', {
    agent: 'dsh',
    prompt: `Reply with exactly the word ${word} and nothing else.`
  }));
}

await new Promise((r) => setTimeout(r, 1500));
const now = await states();
const mine = starts.map((s) => now.find((t) => t.task_id === s.task_id));
console.log('IMMEDIATE:', mine.map((t) => `${t.task_id.slice(0, 8)}:${t.state}`).join(','));

for (const s of starts) {
  const deadline = Date.now() + 180000;
  for (;;) {
    const st = await call('task_status', { task_id: s.task_id });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(st.state)) {
      console.log('DONE:', s.task_id.slice(0, 8), st.state, JSON.stringify(st.summary));
      break;
    }
    if (Date.now() > deadline) { console.log('TIMEOUT:', s.task_id.slice(0, 8), st.state); break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
await client.close();