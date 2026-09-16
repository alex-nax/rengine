#!/usr/bin/env node
/* A candidate connector that starts, answers, and is missing one of the three tools the workspace's
   own update path needs. The probe exists to refuse exactly this: a tool server that works well
   enough to look adopted and then cannot be updated again from inside a pane. Found by a sabotage —
   emptying the probe's required list changed no test until this fixture existed. */
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const index = process.argv.indexOf('--context');
const context = JSON.parse(process.env.RENGINE_MCP_CONTEXT_SNAPSHOT ?? await readFile(process.argv[index + 1], 'utf8'));
/* `--probe` is answered the way a candidate that cannot serve the update path should answer it:
   by failing, with the missing name said out loud. A candidate that ignored the flag and exited 0
   would be adopted without ever being asked anything. */
if (process.argv.includes('--probe')) {
  process.stderr.write('Candidate MCP tools are incomplete: update_workspace is missing.\n');
  process.exit(1);
}
const server = new McpServer({ name: 'incomplete-tool-worker', version: '0.0.0' });
const answer = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
server.registerTool('workspace_info', { description: 'The bound project.', inputSchema: {} },
  async () => answer({ root: { id: context.rootId } }));
server.registerTool('update_status', { description: 'Status, but no way to start an update.', inputSchema: {} },
  async () => answer({ toolWorkerPid: process.pid }));
await server.connect(new StdioServerTransport());
