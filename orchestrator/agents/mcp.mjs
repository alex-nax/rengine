import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveRuntime, runtimeDirectory } from '../runtime/discovery.mjs';
import { bindingContext } from './report-session.mjs';

/* The pane's own environment names this launch's context before the argv does: kimi reads its MCP
   servers from the project-level .kimi-code/mcp.json, which is shared and last-writer-wins across
   panes, so the --context a kimi session passes can name another pane's launch. RENGINE_MCP_CONFIG
   and RENGINE_WORKSPACE_CONTEXT are this pane's own (spec 127 decision 5). A CLI started outside
   any pane has neither and falls back to argv, which is all it ever had. */
const filename = await bindingContext(process.env, process.argv.slice(2), { envFirst: true });
if (!filename) throw new Error('A workspace context file is required.');
const context = JSON.parse(await readFile(filename, 'utf8'));
const siblingWorker = fileURLToPath(new URL('./mcp-worker.mjs', import.meta.url));
const descriptor = path.join(context.runtimeDirectory ?? runtimeDirectory(context), 'runtime.json');
let worker, generation, workerFile, serial = Promise.resolve(), refreshing, closed = false;
const server = new Server({ name: 'rengine-workspace', version: '1.1.0' }, {
  capabilities: { tools: { listChanged: true } },
  instructions: 'Tools retain the original project/session-host binding. Views detach; Stop explicitly ends a process. Poll update_status after update_workspace. Native/service/tool updates retain the CLI; session-host replacement requires quiescence.',
});
async function replace(next, file) {
  const candidate = new Client({ name: 'rengine-tool-facade', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [file, '--context', filename], stderr: 'pipe',
    env: { ...process.env, RENGINE_MCP_CONTEXT_SNAPSHOT: JSON.stringify(context) } });
  let diagnostics = ''; transport.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
  try { await candidate.connect(transport); await candidate.listTools(); }
  catch (error) { await candidate.close(); throw new Error(`MCP tool worker failed to start: ${error.message} ${diagnostics}`); }
  const previous = worker; worker = candidate; generation = next; workerFile = file;
  candidate.onclose = () => { if (worker === candidate) worker = null; };
  await previous?.close();
  if (previous) await server.sendToolListChanged();
}
async function ready() {
  const runtime = await resolveRuntime(context), next = runtime.connectorGeneration ?? 0;
  /* The worker the supervisor probed is the worker that runs; a descriptor from before it was published names none, and the sibling serves. */
  const file = typeof runtime.toolWorker === 'string' && path.isAbsolute(runtime.toolWorker) ? runtime.toolWorker : siblingWorker;
  if (!worker || next !== generation || file !== workerFile) {
    refreshing ??= replace(next, file).finally(() => { refreshing = null; });
    try { await refreshing; } catch (error) { if (!worker) throw error; process.stderr.write(`${error.message}; keeping previous tool worker.\n`); }
  }
  return worker;
}
const queued = action => {
  const result = serial.then(async () => { if (closed) throw new Error('MCP facade is closing.'); return action(await ready()); });
  serial = result.catch(() => {}); return result;
};
/* A name the current worker does not have is answered with the way back — see sidecar: stale-tool-answer. */
const stale = async (client, name) => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  return { isError: true, content: [{ type: 'text', text: `${name} is not in this workspace’s current tool set (connector generation ${generation}): the tool list changed after this CLI read it. Current tools: ${names.join(', ')}. Claude Code refreshes on tools/list_changed and has the new list by its next turn; Codex does not, so a new name needs the CLI restarted (codex resume <id>) — behaviour behind an existing name is already current.` }] };
};
/* The SDK answers an unknown name as an isError result carrying exactly this text (older releases threw it). */
const missing = (result, name) => result?.isError === true && result.content?.length === 1 && result.content[0].type === 'text' &&
  [`MCP error -32602: Tool ${name} not found`, `Tool ${name} not found`].includes(result.content[0].text);
server.setRequestHandler(ListToolsRequestSchema, () => queued(client => client.listTools()));
server.setRequestHandler(CallToolRequestSchema, request => queued(async client => {
  let result;
  try { result = await client.callTool(request.params); }
  catch (error) {
    if (error.code === -32602 && /Tool .* not found/.test(error.message)) return stale(client, request.params.name);
    throw error;
  }
  return missing(result, request.params.name) ? stale(client, request.params.name) : result;
}));
await ready();
/* The descriptor is watched so an update the agent did not ask for still reaches it between requests — see sidecar: idle-refresh. */
const signature = async () => { try { const value = await stat(descriptor); return `${value.ino}:${value.mtimeMs}:${value.size}`; } catch { return 'absent'; } };
let seen = await signature();
const watch = setInterval(async () => {
  const now = await signature();
  if (now === seen) return;
  seen = now;
  await queued(() => {}).catch(() => {});
}, 1000);
watch.unref();
await server.connect(new StdioServerTransport());
server.onclose = () => { closed = true; clearInterval(watch); void serial.finally(() => worker?.close()); };
