import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';

test('root-bound MCP discovers project windows and durable integration transport', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-window-tools-')); let host, client;
  try {
    const project = path.join(directory, 'project'); await mkdir(project);
    host = await startServer({ stateDir: path.join(directory, 'host') });
    const root = await host.store.addRoot(project), context = path.join(directory, 'context.json');
    await writeFile(context, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id }));
    client = new Client({ name: 'window-tools', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', context] }));
    const names = (await client.listTools()).tools.map(x => x.name);
    for (const name of ['open_project_window', 'list_project_windows', 'project_window_action', 'report_integration', 'integration_inbox', 'open_script', 'show_session']) assert.ok(names.includes(name), name);
  } finally { await client?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});
