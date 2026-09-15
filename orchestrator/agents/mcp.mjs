import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveRuntime, runtimeDirectory } from '../runtime/discovery.mjs';
/* Where this launch's context is, in the order that finds it: RENGINE_MCP_CONFIG names the
   per-launch mcp.json whose server is started on that same file; RENGINE_WORKSPACE_CONTEXT is the
   root file a pane inherits, which carries the host connection but no identity; and --context on
   the command line. envFirst reverses the order for the MCP facade (the pane's own environment
   names this launch before the argv does — kimi's mcp.json is shared per project and
   last-writer-wins, so the argv it passes can name another pane's launch; spec 127 decision 5).
   None of the three means this process is not running under rEngine at all.
   (Moved verbatim from report-session.mjs when the reporter became the red-agents binary, F172.) */
async function bindingContext(env = process.env, argv = process.argv.slice(2), { envFirst = false } = {}) {
  const fromArgv = () => {
    const named = argv.indexOf('--context');
    return named >= 0 && argv[named + 1] ? argv[named + 1] : null;
  };
  const fromEnv = async () => {
    if (env.RENGINE_MCP_CONFIG) {
      const servers = JSON.parse(await readFile(env.RENGINE_MCP_CONFIG, 'utf8')).mcpServers;
      for (const server of Object.values(servers ?? {})) {
        const args = Array.isArray(server?.args) ? server.args : [];
        const at = args.indexOf('--context');
        if (at >= 0 && typeof args[at + 1] === 'string') return args[at + 1];
      }
    }
    return env.RENGINE_WORKSPACE_CONTEXT || null;
  };
  const [first, second] = envFirst ? [fromEnv, fromArgv] : [fromArgv, fromEnv];
  return await first() ?? await second();
}

/* The pane's own environment names this launch's context before the argv does: kimi reads its MCP
   servers from the project-level .kimi-code/mcp.json, which is shared and last-writer-wins across
   panes, so the --context a kimi session passes can name another pane's launch. RENGINE_MCP_CONFIG
   and RENGINE_WORKSPACE_CONTEXT are this pane's own (spec 127 decision 5). A CLI started outside
   any pane has neither and falls back to argv, which is all it ever had. */
const filename = await bindingContext(process.env, process.argv.slice(2), { envFirst: true });
if (!filename) throw new Error('A workspace context file is required.');
const context = JSON.parse(await readFile(filename, 'utf8'));
/* The tool worker is an executable (F187): red-mcp, built from this checkout. The descriptor names
   the one the supervisor probed; without a descriptor this facade resolves the same way every
   other Rust client here does. A test fixture standing in for a worker is executable too — it is
   spawned as a command, never as an argument to node. */
const project = fileURLToPath(new URL('../../', import.meta.url));
const siblingWorker = () => {
  const declared = process.env.RENGINE_RED_MCP;
  if (declared) return declared;
  for (const profile of ['release', 'debug']) {
    const candidate = path.join(project, 'red/target', profile, 'red-mcp');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('The red-mcp binary is required (run: cargo build -p red-mcp, or set RENGINE_RED_MCP).');
};
const descriptor = path.join(context.runtimeDirectory ?? runtimeDirectory(context), 'runtime.json');
let worker, generation, workerFile, serial = Promise.resolve(), refreshing, closed = false;
const server = new Server({ name: 'rengine-workspace', version: '1.1.0' }, {
  capabilities: { tools: { listChanged: true } },
  instructions: 'Tools retain the original project/session-host binding. Views detach; Stop explicitly ends a process. Poll update_status after update_workspace. Native/service/tool updates retain the CLI; session-host replacement requires quiescence.',
});
async function replace(next, file) {
  const candidate = new Client({ name: 'rengine-tool-facade', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: file,
    args: ['--context', filename], stderr: 'pipe',
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
  const file = typeof runtime.toolWorker === 'string' && path.isAbsolute(runtime.toolWorker) ? runtime.toolWorker : siblingWorker();
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
  /* What to do about it, said once for every CLI: whether a particular one refreshes was written
     out here per agent, which meant the sentence was wrong for the next CLI to arrive and right for
     nobody who had not been named (F220, spec 141). */
  return { isError: true, content: [{ type: 'text', text: `${name} is not in this workspace’s current tool set (connector generation ${generation}): the tool list changed after this CLI read it. Current tools: ${names.join(', ')}. A CLI that refreshes on tools/list_changed has the new list by its next turn; one that does not needs restarting before a NEW name is reachable — behaviour behind an existing name is already current either way.` }] };
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
