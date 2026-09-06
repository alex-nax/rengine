import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveRuntime } from '../runtime/discovery.mjs';

const index = process.argv.indexOf('--context');
if (index < 0 || !process.argv[index + 1]) throw new Error('A workspace context file is required.');
const filename = process.argv[index + 1], context = JSON.parse(await readFile(filename, 'utf8'));
let worker, generation, serial = Promise.resolve(), refreshing, closed = false;
const server = new Server({ name: 'rengine-workspace', version: '1.1.0' }, {
  capabilities: { tools: { listChanged: true } },
  instructions: 'Tools retain the original project/session-host binding. Views detach; Stop explicitly ends a process. Poll update_status after update_workspace. Native/service/tool updates retain the CLI; session-host replacement requires quiescence.',
});
async function replace(next) {
  const candidate = new Client({ name: 'rengine-tool-facade', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-worker.mjs', import.meta.url)), '--context', filename], stderr: 'pipe',
    env: { ...process.env, RENGINE_MCP_CONTEXT_SNAPSHOT: JSON.stringify(context) } });
  let diagnostics = ''; transport.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
  try { await candidate.connect(transport); await candidate.listTools(); }
  catch (error) { await candidate.close(); throw new Error(`MCP tool worker failed to start: ${error.message} ${diagnostics}`); }
  const previous = worker; worker = candidate; generation = next;
  candidate.onclose = () => { if (worker === candidate) worker = null; };
  await previous?.close();
  if (previous) await server.sendToolListChanged();
}
async function ready() {
  const runtime = await resolveRuntime(context), next = runtime.connectorGeneration ?? 0;
  if (!worker || next !== generation) {
    refreshing ??= replace(next).finally(() => { refreshing = null; });
    try { await refreshing; } catch (error) { if (!worker) throw error; process.stderr.write(`${error.message}; keeping previous tool worker.\n`); }
  }
  return worker;
}
const queued = action => {
  const result = serial.then(async () => { if (closed) throw new Error('MCP facade is closing.'); return action(await ready()); });
  serial = result.catch(() => {}); return result;
};
server.setRequestHandler(ListToolsRequestSchema, () => queued(client => client.listTools()));
server.setRequestHandler(CallToolRequestSchema, request => queued(client => client.callTool(request.params)));
await ready();
await server.connect(new StdioServerTransport());
server.onclose = () => { closed = true; void serial.finally(() => worker?.close()); };
