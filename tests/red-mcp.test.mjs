/* F184/F187 (F150a, spec 129, KI-100): red-mcp serves the tool surface the JS worker served.
 *
 * While `agents/mcp-worker.mjs` existed this started both servers and compared them deeply. F187
 * deleted it, so what red-mcp is judged against is the declaration that worker answered with —
 * captured from it while it ran, committed, and never regenerated. The comparison is still the
 * whole surface: names in order, descriptions, JSON Schemas, annotations, server identity,
 * instructions and capabilities. That matters because `tools/list` IS the surface — an agent reads
 * those descriptions to decide what to call.
 *
 * What this catches now is the code drifting from its own declaration: a binary that serves fewer
 * tools than it ships, or answers a different identity, fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from './red-host-fixture.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

test('red-mcp answers tools/list exactly as the JS worker did', { timeout: 120000 }, async t => {
  await built('-p', 'red-mcp', '--bin', 'red-mcp');
  assert.ok(existsSync(BINARY), `red-mcp was built at ${BINARY}`);
  const directory = await mkdtemp(path.join(tmpdir(), 'red-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(() => server.close());
  const root = await server.store.addRoot(directory);
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: root.id }), { mode: 0o600 });

  const declared = JSON.parse(await readFile(path.join(ROOT, 'red/red-mcp/src/tools.json'), 'utf8'));
  const rust = await connect(t, BINARY, ['--context', contextFile]);

  const fromRust = await rust.listTools();
  assert.deepEqual(fromRust.tools.map(tool => tool.name), declared.tools.map(tool => tool.name),
    'the same tools, in the same order the worker answered them');
  assert.deepEqual(fromRust.tools, declared.tools,
    'every description, schema and annotation is the one the JS worker answered with');
  assert.deepEqual(rust.getServerVersion(), declared.server, 'the same server identity');
  assert.equal(rust.getInstructions(), declared.instructions, 'the same instructions a CLI reads on connect');
  assert.deepEqual(rust.getServerCapabilities(), declared.capabilities, 'the same capabilities');
});

test('red-mcp refuses a binding it cannot serve, in the words the worker uses', { timeout: 120000 }, async t => {
  await built('-p', 'red-mcp', '--bin', 'red-mcp');
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

/* What an agent is told when a plugin is switched on (F235, spec 152 decisions 2 and 9).
 *
 * The vendor's own quick start asks a person to install a skill, per agent CLI, so the agent knows a
 * capability exists. This is the workspace answering that question itself: a switched-on plugin's
 * instructions reach the surface at `initialize` and its tools reach `tools/list`, and both leave
 * the moment it is switched off. The captured declaration is what "off" has to look like — exactly
 * the surface red-mcp is judged against above, with nothing added. */
test('a switched-on plugin reaches an agent at initialize, and a switched-off one does not',
     { timeout: 120000 }, async t => {
  await built('-p', 'red-mcp', '--bin', 'red-mcp');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-mcp-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, 'state');
  const server = await startServer({ stateDir });
  t.after(() => server.close());
  const root = await server.store.addRoot(directory);
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: root.id }), { mode: 0o600 });

  await mkdir(path.join(directory, 'plugins', 'fixture'), { recursive: true });
  await writeFile(path.join(directory, 'plugins', 'fixture', 'plugin.json'), JSON.stringify({
    name: 'fixture',
    service: {
      command: ['plugins/fixture/service.sh'],
      // Named from the project root, the same way `command` is: a project that PINS a plugin
      // points at the prose in the pinned checkout rather than keeping a second copy of it.
      instructions: 'plugins/fixture/say.md',
      tools: [{ name: 'ask', command: 'ask', description: 'A fixture tool.', inputSchema: { type: 'object' } }],
    },
  }));
  await writeFile(path.join(directory, 'plugins', 'fixture', 'say.md'),
                  'The fixture capability is available here. You do not need to install anything to use it.');

  const declared = JSON.parse(await readFile(path.join(ROOT, 'red/red-mcp/src/tools.json'), 'utf8'));

  /* Off: the surface is the captured one, to the character. A plugin nobody switched on is a
     workspace that behaves exactly as it did before the plugin was there. */
  const off = await connect(t, BINARY, ['--context', contextFile]);
  assert.equal(off.getInstructions(), declared.instructions, 'a switched-off plugin teaches nothing');
  assert.deepEqual((await off.listTools()).tools.map(tool => tool.name), declared.tools.map(tool => tool.name));
  await off.close();

  /* On. The marker file IS the switch — core reads exactly one file in a plugin's state directory
     (spec 152 decision 5) — so this is the same gesture the Plugins page makes. */
  await mkdir(path.join(stateDir, 'plugins', 'fixture'), { recursive: true });
  await writeFile(path.join(stateDir, 'plugins', 'fixture', 'enabled'), 'on\n');

  const on = await connect(t, BINARY, ['--context', contextFile]);
  const taught = on.getInstructions();
  assert.ok(taught.startsWith(declared.instructions), 'the workspace still says everything it said before');
  assert.match(taught, /do not need to install anything/, 'and the plugin has added what it wants an agent to know');
  const tools = (await on.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'fixture.ask'),
            `its tool is offered, namespaced: ${JSON.stringify(tools.map(t => t.name).slice(-3))}`);
  assert.deepEqual(tools.slice(0, declared.tools.length).map(tool => tool.name), declared.tools.map(tool => tool.name),
                   'ahead of it, the captured surface is unchanged');
  await on.close();

  /* And off again: switching it off is what makes the toggle mean something to an AGENT rather than
     only to a page. */
  await rm(path.join(stateDir, 'plugins', 'fixture', 'enabled'));
  const again = await connect(t, BINARY, ['--context', contextFile]);
  assert.equal(again.getInstructions(), declared.instructions, 'and stops being told the moment it is off');
  assert.deepEqual((await again.listTools()).tools.map(tool => tool.name), declared.tools.map(tool => tool.name));
});
