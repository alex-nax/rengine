import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function probeTools(host, directory, rootId, workerFile = fileURLToPath(new URL('../agents/mcp-worker.mjs', import.meta.url))) {
  const filename = path.join(directory, `tool-probe-${randomUUID()}.json`);
  const context = { url: host.url, token: host.token, instance: host.instance, rootId, runtimeDirectory: directory };
  await writeFile(filename, JSON.stringify(context), { mode: 0o600 });
  const client = new Client({ name: 'rengine-update-probe', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [workerFile, '--context', filename], stderr: 'pipe',
    env: { ...process.env, RENGINE_MCP_CONTEXT_SNAPSHOT: JSON.stringify(context) } });
  let diagnostics = ''; transport.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-4000); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!['workspace_info', 'update_status', 'update_workspace'].every(name => tools.tools.some(tool => tool.name === name))) throw new Error('Candidate MCP tools are incomplete.');
    const info = await client.callTool({ name: 'workspace_info', arguments: {} });
    if (info.isError || info.structuredContent?.root?.id !== rootId) throw new Error('Candidate MCP worker failed the project binding check.');
  } catch (error) { throw new Error(`Candidate MCP worker failed: ${error.message} ${diagnostics}`); }
  finally { await client.close(); await rm(filename, { force: true }); }
}
