import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { built } from './cargo.mjs';

test('MCP inspection preserves the native layout numbers in both result representations', { timeout: 120000 }, async t => {
  await built('-p', 'red-mcp', '--bin', 'red-mcp');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-mcp-numbers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootId = randomUUID(), instance = randomUUID();
  const ratios = [Math.fround(0.23), Math.fround(0.65), Math.fround(0.1), Math.fround(0.9)];
  const response = JSON.stringify({ state: { layout: { panes: ratios.map(ratio => ({ axis: 1, ratio })) } } });
  const requested = [];
  const server = createServer((request, reply) => {
    request.resume();
    requested.push(`${request.method} ${request.url}`);
    reply.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/state') {
      reply.end(JSON.stringify({ instance, roots: [{ id: rootId, path: directory }], capabilities: { projectWindows: 1 } }));
    } else if (request.method === 'POST' && request.url === '/api/project-window-action') {
      reply.end(response);
    } else {
      reply.writeHead(404); reply.end(JSON.stringify({ error: 'Unexpected fixture route' }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = path.join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: 'a'.repeat(64), instance, rootId,
    runtimeDirectory: path.join(directory, 'no-supervisor') }));
  const client = new Client({ name: 'number-preservation', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: path.resolve('red/target/debug/red-mcp'), args: ['--context', context], stderr: 'pipe' }));
  const result = await client.callTool({ name: 'project_window_action', arguments: { windowId: randomUUID(), action: 'inspect' } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(requested.includes('POST /api/project-window-action'), 'the inspection crossed the actual HTTP tool route');
  const expected = JSON.parse(response);
  assert.deepEqual({ structured: result.structuredContent, text: JSON.parse(result.content[0].text) },
    { structured: expected, text: expected }, 'both MCP representations preserve every native ratio');
});
