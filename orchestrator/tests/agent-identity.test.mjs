import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { request } from '../launcher/sidecar.mjs';
import { agentLaunch } from '../agents/config.mjs';
import { bind } from '../agents/bind.mjs';

const workerMain = fileURLToPath(new URL('../agents/mcp-worker.mjs', import.meta.url));

/* A recording reverse proxy: every request the tool worker makes is seen here before it reaches the
   thing it is talking to, so the header is observed on the wire rather than inferred from the code. */
async function recorder(target) {
  const seen = [];
  const upstreamHost = new URL(target.url).host;
  const server = http.createServer((incoming, response) => {
    seen.push({ url: incoming.url, agent: incoming.headers['x-rengine-agent'] });
    const proxied = http.request(new URL(incoming.url, target.url),
      { method: incoming.method, headers: { ...incoming.headers, host: upstreamHost } },
      answer => { response.writeHead(answer.statusCode, answer.headers); answer.pipe(response); });
    proxied.on('error', () => response.destroy());
    incoming.pipe(proxied);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
async function toolWorker(t, contextFile, snapshot) {
  const client = new Client({ name: 'rengine-identity-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [workerMain, '--context', contextFile], stderr: 'pipe',
    ...(snapshot ? { env: { ...process.env, RENGINE_MCP_CONTEXT_SNAPSHOT: JSON.stringify(snapshot) } } : {}) }));
  t.after(() => client.close());
  return client;
}
const structured = result => { assert.equal(result.isError, undefined, result.content?.[0]?.text); return result.structuredContent; };

test('two launches on one root are told apart, and neither reads the file the root shares', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shared = path.join(directory, 'root-context.json');
  const context = { url: 'http://127.0.0.1:1/', token: 'f'.repeat(64), instance: '12345678-1234-1234-1234-1234567890ab', rootId: '12345678-1234-1234-1234-123456789abc' };
  await writeFile(shared, JSON.stringify(context));

  const first = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile: shared, env: {} });
  const second = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile: shared, env: {} });
  assert.notEqual(first.identity.agentId, second.identity.agentId, 'each launch mints its own agentId');
  assert.notEqual(first.contextFile, second.contextFile, 'and its own context file');
  for (const [plan, label] of [[first, 'claude'], [second, 'codex']]) {
    const written = JSON.parse(await readFile(plan.contextFile, 'utf8'));
    assert.equal(written.rootId, context.rootId, 'the per-launch context still carries the root binding');
    assert.equal(written.token, context.token);
    assert.equal(written.agent.agentId, plan.identity.agentId);
    assert.equal(written.agent.label, label, 'the label is the CLI name');
    assert.equal(written.agent.pid, process.pid);
    assert.ok(Date.parse(written.agent.startedAt) > 0, 'startedAt is a wall time');
    assert.equal(path.dirname(plan.contextFile), plan.directory, 'the context lives in the per-launch directory');
    const server = JSON.parse(await readFile(plan.generic, 'utf8')).mcpServers[plan.name];
    assert.deepEqual(server.args.slice(-2), ['--context', plan.contextFile], `${label}\u2019s facade is started on its own context file`);
    const referenced = [...plan.args, ...Object.values(plan.consumes.env), JSON.stringify(server)].join(' ');
    assert.ok(referenced.includes(plan.contextFile), `${label} is handed that file`);
    assert.ok(!referenced.includes(shared), `${label} is nowhere pointed at the context the whole root shares`);
  }
  const executable = await agentLaunch({ agent: 'weird-cli', executable: '/opt/bin/weird-cli.exe', contextFile: shared, env: {} });
  assert.equal(executable.identity.label, 'weird-cli', 'an unnamed CLI is labelled by its executable basename');
});

test('the identity travels on every tool call and on nothing else', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-identity-wire-'));
  await mkdir(path.join(directory, 'project'));
  await writeFile(path.join(directory, 'project/only.txt'), 'one line\n');
  const host = await startServer({ stateDir: path.join(directory, 'state') });
  const root = await host.store.addRoot(path.join(directory, 'project'));
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance });
  const proxy = await recorder(worker);
  t.after(async () => { await proxy.close(); await worker.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });

  const context = { url: proxy.url, token: worker.token, instance: host.instance, rootId: root.id };
  const plan = await agentLaunch({ agent: 'claude', executable: 'claude', context, directory, env: {} });
  assert.deepEqual([...new Set(proxy.seen.map(entry => entry.agent))], [undefined],
    'the launcher\u2019s own session lookup runs before the identity exists and claims none');
  const mark = proxy.seen.length;
  const client = await toolWorker(t, plan.contextFile);

  const info = structured(await client.callTool({ name: 'workspace_info', arguments: {} }));
  assert.equal(info.root.id, root.id);
  assert.equal(info.agent?.agentId, plan.identity.agentId, 'an agent can read its own identity back');
  assert.equal(info.agent?.label, 'claude');

  /* list_files is not a worker route: it falls through forward() to the retained host, so this is
     the header crossing both hops. */
  const listed = structured(await client.callTool({ name: 'list_files', arguments: { path: '' } }));
  assert.ok(listed.entries.some(entry => entry.name === 'only.txt'), 'the forwarded call still works with the header on it');

  const calls = proxy.seen.slice(mark).filter(entry => entry.url.startsWith('/api/'));
  assert.ok(calls.length >= 2, `the proxy saw the calls: ${calls.length}`);
  assert.deepEqual([...new Set(calls.map(entry => entry.agent))], [plan.identity.agentId],
    'every request the tool worker made carried this launch’s agentId');
  assert.ok(calls.some(entry => entry.url.startsWith('/api/tree')), 'including the one that is forwarded to the host');

  const before = proxy.seen.length;
  await request({ url: proxy.url, token: worker.token, instance: host.instance }, 'state');
  assert.deepEqual(proxy.seen.slice(before).map(entry => entry.agent), [undefined],
    'a request made the way the desktop makes them carries no identity');

  /* A replaced tool worker is started from the snapshot the facade holds, not from the file; the
     identity has to survive that hop too. */
  const snapshot = JSON.parse(await readFile(plan.contextFile, 'utf8'));
  await rm(plan.contextFile);
  const replaced = await toolWorker(t, plan.contextFile, snapshot);
  const after = proxy.seen.length;
  const second = structured(await replaced.callTool({ name: 'workspace_info', arguments: {} }));
  assert.equal(second.agent?.agentId, plan.identity.agentId, 'a replacement worker keeps the identity');
  assert.deepEqual([...new Set(proxy.seen.slice(after).map(entry => entry.agent))], [plan.identity.agentId]);

  /* probeTools writes a context with no identity, and update_workspace depends on it working. */
  const anonymousFile = path.join(directory, 'probe-context.json');
  await writeFile(anonymousFile, JSON.stringify(context), { mode: 0o600 });
  const anonymous = await toolWorker(t, anonymousFile);
  const third = proxy.seen.length;
  const plain = structured(await anonymous.callTool({ name: 'workspace_info', arguments: {} }));
  assert.equal(plain.root.id, root.id, 'a context with no identity still works');
  assert.equal(plain.agent, undefined, 'and claims none');
  assert.deepEqual([...new Set(proxy.seen.slice(third).map(entry => entry.agent))], [undefined]);
});

test('binding by discovery finds the one instance serving the directory, and refuses when it cannot', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-identity-bind-'));
  await mkdir(path.join(directory, 'project'));
  await mkdir(path.join(directory, 'elsewhere'));
  const home = path.join(directory, 'state-home');
  const servers = [];
  for (const name of ['alpha', 'beta']) {
    const stateDir = path.join(home, 'rengine', name);
    await mkdir(stateDir, { recursive: true });
    const server = await startServer({ stateDir });
    await writeFile(path.join(stateDir, 'sidecar.json'),
      JSON.stringify({ url: server.url, token: server.token, instance: server.instance, pid: process.pid }), { mode: 0o600 });
    servers.push({ name, stateDir, server });
  }
  t.after(async () => { for (const entry of servers) await entry.server.close(); await rm(directory, { recursive: true, force: true }); });

  await assert.rejects(withStateHome(home, () => bind(['--project', path.join(directory, 'project'), '--agent', 'claude'])),
    error => { assert.match(error.message, /No live workspace instance serves/); assert.match(error.message, /rengine\/alpha/);
      assert.match(error.message, /rengine\/beta/); return true; },
    'with nobody serving it, the refusal names the directories that were scanned');

  /* The project is served by the SECOND instance found, so picking the first live one is wrong
     rather than accidentally right. */
  const owned = await servers[1].server.store.addRoot(path.join(directory, 'project'));
  await servers[0].server.store.addRoot(path.join(directory, 'elsewhere'));
  const bound = await withStateHome(home, () => bind(['--project', path.join(directory, 'project'), '--agent', 'claude']));
  assert.equal(bound.instance.instance, servers[1].server.instance, 'the instance that serves the directory is the one chosen');
  assert.equal(bound.root.id, owned.id);
  assert.equal(bound.identity.label, 'claude');
  assert.match(bound.report, /claude --mcp-config /, 'the report prints the flag that consumes the configuration');
  assert.ok(bound.report.includes(bound.plan.generic), 'and the configuration path');
  const written = JSON.parse(await readFile(bound.plan.contextFile, 'utf8'));
  assert.equal(written.rootId, owned.id);
  assert.equal(written.instance, servers[1].server.instance);
  assert.equal(written.agent.agentId, bound.identity.agentId, 'a bound agent gets the same identity shape a launched one gets');
  assert.ok(Date.parse(written.agent.startedAt) > 0);
  assert.equal(bound.plan.directory.startsWith(path.join(servers[1].stateDir, 'bindings')), true);

  await servers[0].server.store.addRoot(path.join(directory, 'project'));
  await assert.rejects(withStateHome(home, () => bind(['--project', path.join(directory, 'project'), '--agent', 'claude'])),
    error => { assert.match(error.message, /Two workspace instances claim/);
      for (const entry of servers) assert.ok(error.message.includes(entry.server.instance), `the refusal names ${entry.name}`);
      return true; },
    'two instances claiming one directory is a refusal that names both');

  const explicit = await bind(['--project', path.join(directory, 'project'), '--state', servers[0].stateDir]);
  assert.equal(explicit.instance.instance, servers[0].server.instance, '--state names the instance when discovery cannot');
  assert.match(explicit.report, /codex -c /, 'without --agent every consuming flag is printed');
});

async function withStateHome(home, action) {
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  try { return await action(); } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; }
}
