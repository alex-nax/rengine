/* A tool worker from before a capability existed, for hot-update.test.mjs. It carries the three names
   the supervisor's probe insists on and one tool the real worker does not have, so a facade that
   switches generations can be seen to drop `old_tool` and gain what the checkout serves. */
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const index = process.argv.indexOf('--context');
const context = JSON.parse(process.env.RENGINE_MCP_CONTEXT_SNAPSHOT ?? await readFile(process.argv[index + 1], 'utf8'));
const server = new McpServer({ name: 'stale-tool-worker', version: '0.0.0' });
const answer = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
server.registerTool('workspace_info', { description: 'The old worker’s view of the bound project.', inputSchema: {} },
  async () => answer({ root: { id: context.rootId }, worker: 'stale' }));
server.registerTool('update_status', { description: 'The old worker’s status.', inputSchema: {} },
  async () => answer({ toolWorkerPid: process.pid, worker: 'stale' }));
server.registerTool('update_workspace', { description: 'Present so the probe accepts this worker; never used here.', inputSchema: {} },
  async () => answer({ refused: 'the stale worker starts no update' }));
server.registerTool('old_tool', { description: 'A tool the next worker does not have.', inputSchema: {} },
  async () => answer({ old: true }));
await server.connect(new StdioServerTransport());
