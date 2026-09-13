/* F184 (F150a, spec 129, KI-100): red-mcp serves the same tool surface as the JS worker.
 *
 * Both servers are started for real and driven by the same MCP client, and the comparison is
 * deep: names, descriptions, JSON Schemas and annotations. That matters because `tools/list` IS
 * the surface — an agent reads those descriptions to decide what to call — so "identical" has to
 * mean identical prose, not a matching set of names.
 *
 * The declaration red-mcp serves was captured from the JS worker while it was running. This test
 * is what keeps that honest while both exist: a tool added, renamed or reworded on the JS side
 * without a recapture fails here rather than silently leaving the Rust side a version behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BINARY = path.join(ROOT, 'red/target/debug/red-mcp');

async function connect(t, command, args, env) {
  const client = new Client({ name: 'rengine-parity', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe', env: { ...process.env, ...env } });
  let diagnostics = '';
  transport.stderr?.on('data', data => { diagnostics = (diagnostics + data).slice(-2000); });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${path.basename(command)} did not start: ${error.message} ${diagnostics}`); }
  t.after(() => client.close().catch(() => {}));
  return client;
}

test('red-mcp answers tools/list exactly as the JS worker does', { timeout: 120000 }, async t => {
  await run('cargo', ['build', '-p', 'red-mcp', '--bin', 'red-mcp'], { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  assert.ok(existsSync(BINARY), `red-mcp was built at ${BINARY}`);
  const directory = await mkdtemp(path.join(tmpdir(), 'red-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(() => server.close());
  const root = await server.store.addRoot(directory);
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: root.id }), { mode: 0o600 });

  const js = await connect(t, process.execPath, [path.join(ROOT, 'orchestrator/agents/mcp-worker.mjs'), '--context', contextFile]);
  const rust = await connect(t, BINARY, ['--context', contextFile]);

  const fromJs = await js.listTools();
  const fromRust = await rust.listTools();
  assert.deepEqual(fromRust.tools.map(tool => tool.name), fromJs.tools.map(tool => tool.name),
    'the same tools, in the same order');
  assert.deepEqual(fromRust.tools, fromJs.tools,
    'every description, schema and annotation is the one the JS worker answers');
  assert.deepEqual(rust.getServerVersion(), js.getServerVersion(), 'the same server identity');
  assert.equal(rust.getInstructions(), js.getInstructions(), 'the same instructions a CLI reads on connect');
  assert.deepEqual(rust.getServerCapabilities(), js.getServerCapabilities(), 'the same capabilities');
});

test('red-mcp refuses a binding it cannot serve, in the words the worker uses', { timeout: 120000 }, async t => {
  await run('cargo', ['build', '-p', 'red-mcp', '--bin', 'red-mcp'], { cwd: path.join(ROOT, 'red'), maxBuffer: 1 << 24 });
  const directory = await mkdtemp(path.join(tmpdir(), 'red-mcp-refuse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(() => server.close());
  const root = await server.store.addRoot(directory);

  /* A context naming a root this host does not have: the pane is told at startup rather than on
     its first tool call, which is what the JS worker does. */
  const strayRoot = path.join(directory, 'stray.json');
  await writeFile(strayRoot, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: 'no-such-root' }));
  const missing = await run(BINARY, ['--context', strayRoot]).then(() => null, error => error);
  assert.ok(missing, 'a context naming an unknown root is refused');
  assert.match(String(missing.stderr), /The bound project is no longer available/);

  /* And one naming another host's instance. */
  const strayInstance = path.join(directory, 'instance.json');
  await writeFile(strayInstance, JSON.stringify({ url: server.url, token: server.token, instance: 'a-different-workspace', rootId: root.id }));
  const moved = await run(BINARY, ['--context', strayInstance]).then(() => null, error => error);
  assert.ok(moved, 'a context naming another instance is refused');
  assert.match(String(moved.stderr), /original sidecar instance is no longer available/);

  /* And a context that is not a loopback binding at all. */
  const bad = path.join(directory, 'bad.json');
  await writeFile(bad, JSON.stringify({ url: 'http://example.com', token: 'x', instance: server.instance, rootId: root.id }));
  const refused = await run(BINARY, ['--context', bad]).then(() => null, error => error);
  assert.ok(refused, 'a context that is not a local workspace is refused');
  assert.match(String(refused.stderr), /Invalid local workspace context/);
});
