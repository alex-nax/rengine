import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { request } from '../launcher/sidecar.mjs';
import { readDeclaration, listFormats } from '../server/formats.mjs';
import { validateSchema } from '../server/schema.mjs';
import { hash } from '../server/store.mjs';
import { redImage } from './image-fixtures.mjs';
import { declaration } from './format-fixtures.mjs';
import { contract2, dashboard, dashboardProject } from './dashboard-fixtures.mjs';

const schema = JSON.parse(readFileSync('contracts/project-v1.schema.json', 'utf8'));
const nolf = JSON.parse(readFileSync('orchestrator/tests/fixtures/nolf-merged-project.json', 'utf8'));
const withActions = (edit, base = contract2()) => { const doc = structuredClone(base); edit(doc.dashboard); return doc; };
const waitOutput = async (server, id, text) => { for (let i = 0; i < 100; i++) { if (server.sessions.snapshot(id, true).output.includes(text)) return; await delay(50); } throw new Error(`session never printed ${text}`); };

test('contract 2 declarations validate, contract 1 stays accepted and dashboard errors are precise and isolated', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-dashboard-decl-')));
  try {
    const declare = async (name, document) => { const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true }); await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root); };
    assert.deepEqual(validateSchema(schema, nolf), [], 'the nolf-improved merged document validates with zero errors');
    const real = await declare('nolf', nolf);
    assert.equal(real.error, undefined); assert.equal(real.dashboardError, undefined); assert.equal(real.contract, 2); assert.equal(real.formats[0].id, 'lithtech-rez');
    assert.deepEqual(real.dashboard.groups.map(g => g.id), ['quick-start', 'distribution', 'device']);
    assert.equal(real.dashboard.groups.flatMap(g => g.actions).length, 12); assert.equal(real.dashboard.title, 'reLith');
    const one = await declare('one', declaration()); assert.equal(one.contract, 1); assert.equal(one.dashboard, undefined); assert.equal(one.error, undefined);
    const two = await declare('two', contract2()); assert.equal(two.contract, 2); assert.equal(two.dashboard.groups.length, 2); assert.equal(two.dashboardError, undefined);
    const stale = await declare('stale', { ...declaration(), dashboard: dashboard() });
    assert.match(stale.dashboardError, /contract 2/); assert.equal(stale.dashboard, undefined); assert.equal(stale.formats[0].id, 'fixture-pack', 'formats survive a dashboard problem');
    const cases = {
      'unknown kind': [withActions(d => { d.groups[0].actions[0].kind = 'stream'; }), /kind must be one of "script", "log", "capture"/],
      'unknown key': [withActions(d => { d.groups[0].actions[0].shell = true; }), /unknown key shell/],
      'mixed kind fields': [withActions(d => { d.groups[0].actions[0].command = ['x']; }), /command is not a script field/],
      'log without command': [withActions(d => { delete d.groups[1].actions[0].command; }), /log requires command/],
      'capture format': [withActions(d => { d.groups[1].actions[1].format = 'jpg'; }), /format must equal "png"/],
      'bad env key': [withActions(d => { d.groups[0].actions[0].env = { build_type: 'x' }; }), /env key build_type/],
      'duplicate action id': [withActions(d => { d.groups[1].actions[0].id = 'hello'; }), /repeats "hello"/],
      'duplicate group id': [withActions(d => { d.groups[1].id = 'build'; }), /repeats "build"/],
      'escaping requires': [withActions(d => { d.groups[0].actions[1].requires = ['../secret.env']; }), /root-relative/],
      'absolute into': [withActions(d => { d.groups[1].actions[1].into = '/tmp/captures'; }), /root-relative/],
      'script outside': [withActions(d => { d.groups[0].actions[0].script = '../hello.sh'; }), /root-relative/],
      'script not sh': [withActions(d => { d.groups[0].actions[0].script = 'hello.py'; }), /\.sh/],
      'shell argv': [withActions(d => { d.groups[1].actions[0].command = ['adb | tee', 'x']; }), /command\[0\]/],
      'tool with path': [withActions(d => { d.groups[0].actions[0].tools = ['/usr/bin/adb']; }), /tools\[0\]/],
      'empty filter': [withActions(d => { d.groups[1].actions[0].filters = ['']; }), /filters\[0\]/],
      'no groups': [withActions(d => { d.groups = []; }), /groups/],
    };
    for (const [label, [document, pattern]] of Object.entries(cases)) {
      const result = await declare(label.replaceAll(/[^a-z0-9]/g, '-'), document);
      assert.equal(result.error, undefined, `${label}: formats stay valid`); assert.match(result.dashboardError ?? '', pattern, label); assert.equal(result.dashboard, undefined, label);
    }
    const three = await declare('three', { ...contract2(), contract: 3 }); assert.match(three.error, /unknown contract 3/); assert.deepEqual(three.formats, []);
    const listed = await listFormats({ id: 'r', path: path.join(directory, 'unknown-kind') });
    assert.equal(listed.formats[0].id, 'fixture-pack'); assert.match(listed.dashboardError, /kind/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('availability, script and log sessions and captures run through the host', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-dashboard-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await dashboardProject(directory, 'game');
  const outside = path.join(directory, 'outside'); await mkdir(outside); await symlink(outside, path.join(rootPath, 'captures-link'), 'dir');
  const root = await server.store.addRoot(rootPath), other = await server.store.addRoot(outside);
  assert.equal((await request(server, 'state')).capabilities.dashboard, 1);
  const board = await request(server, `dashboard?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(board.declared, true); assert.equal(board.contract, 2); assert.equal(board.title, 'Fixture'); assert.equal(board.error, undefined);
  const action = id => board.groups.flatMap(g => g.actions).find(a => a.id === id);
  assert.deepEqual(board.groups.map(g => [g.id, g.title, g.actions.length]), [['build', 'Build', 4], ['device', 'Device', 5]]);
  assert.equal(action('hello').available, true); assert.deepEqual(action('hello').missing, []); assert.deepEqual(action('hello').env, { BUILD_TYPE: 'RELEASE' }); assert.deepEqual(action('hello').artifacts, ['dist/out.txt']);
  assert.deepEqual(action('needs-file').missing, [{ type: 'requires', name: 'missing.env' }]); assert.equal(action('needs-file').available, false);
  assert.deepEqual(action('needs-tool').missing, [{ type: 'tools', name: 'definitely-missing-tool-9f' }]);
  assert.equal(action('has-tool').available, true); assert.equal(action('logger').available, true); assert.equal(action('shot').kind, 'capture');
  assert.deepEqual(await request(server, `dashboard?${new URLSearchParams({ rootId: other.id })}`), { rootId: other.id, declared: false, groups: [] });
  const hello = await request(server, 'dashboard-run', { rootId: root.id, actionId: 'hello' });
  assert.equal(hello.rootId, root.id); assert.equal(hello.state, 'running'); assert.equal(hello.title, 'Script · hello.sh'); assert.ok(hello.pid > 0);
  await waitOutput(server, hello.id, 'HELLO ARG=--fast ENV=RELEASE PWD_OK=yes');
  await assert.rejects(request(server, 'dashboard-run', { rootId: root.id, actionId: 'needs-file' }), /requires missing\.env/);
  await assert.rejects(request(server, 'dashboard-run', { rootId: root.id, actionId: 'needs-tool' }), /definitely-missing-tool-9f/);
  await assert.rejects(request(server, 'dashboard-run', { rootId: root.id, actionId: 'nope' }), /Unknown dashboard action/);
  await assert.rejects(request(server, 'dashboard-run', { rootId: root.id, actionId: 'shot' }), /dashboard-capture/);
  await assert.rejects(request(server, 'dashboard-run', { rootId: other.id, actionId: 'hello' }), /declare/);
  const logger = await request(server, 'dashboard-run', { rootId: root.id, actionId: 'logger' });
  assert.equal(logger.title, 'Log · Log stream'); await waitOutput(server, logger.id, 'LOG_LINE');
  const before = Date.now();
  const entry = await request(server, 'dashboard-capture', { rootId: root.id, actionId: 'shot' });
  assert.match(entry.file, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.png$/); assert.equal(entry.size, redImage.length); assert.equal(entry.sha256, hash(redImage)); assert.equal(entry.action, 'shot');
  assert.ok(Date.parse(entry.time) >= before - 1000); assert.equal(entry.path, `.cache/captures/${entry.file}`); assert.equal(entry.manifest, '.cache/captures/manifest.json');
  assert.deepEqual(await readFile(path.join(rootPath, entry.path)), redImage);
  let manifest = JSON.parse(await readFile(path.join(rootPath, '.cache/captures/manifest.json'), 'utf8'));
  assert.deepEqual(manifest, [{ file: entry.file, time: entry.time, size: entry.size, sha256: entry.sha256, action: 'shot' }]);
  await delay(5); const second = await request(server, 'dashboard-capture', { rootId: root.id, actionId: 'shot' });
  manifest = JSON.parse(await readFile(path.join(rootPath, '.cache/captures/manifest.json'), 'utf8'));
  assert.equal(manifest.length, 2); assert.equal(manifest[1].file, second.file); assert.notEqual(second.file, entry.file);
  await assert.rejects(request(server, 'dashboard-capture', { rootId: root.id, actionId: 'bad-shot' }), /PNG/);
  await assert.rejects(request(server, 'dashboard-capture', { rootId: root.id, actionId: 'failing-shot' }), /exit 2.*device offline/);
  await assert.rejects(request(server, 'dashboard-capture', { rootId: root.id, actionId: 'escape-shot' }), /outside/);
  await assert.rejects(request(server, 'dashboard-capture', { rootId: root.id, actionId: 'hello' }), /capture action/);
  assert.equal(JSON.parse(await readFile(path.join(rootPath, '.cache/captures/manifest.json'), 'utf8')).length, 2, 'failed captures write nothing');
  await assert.rejects(stat(path.join(outside, 'manifest.json')), /ENOENT/);
  const broken = await dashboardProject(directory, 'broken', withActions(d => { d.groups[0].actions[0].kind = 'operator'; }));
  const brokenRoot = await server.store.addRoot(broken);
  const shown = await request(server, `dashboard?${new URLSearchParams({ rootId: brokenRoot.id })}`);
  assert.equal(shown.declared, true); assert.match(shown.error, /kind/); assert.deepEqual(shown.groups, []);
  assert.equal((await request(server, `formats?${new URLSearchParams({ rootId: brokenRoot.id })}`)).formats[0].id, 'fixture-pack', 'formats keep working');
  assert.deepEqual(server.store.state.drafts, {});
});

test('the replaceable worker and the MCP tools expose the dashboard', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-dashboard-runtime-')));
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  let runtime, client;
  t.after(async () => { await client?.close(); await runtime?.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await dashboardProject(directory, 'game'); const root = await host.store.addRoot(rootPath);
  runtime = await startRuntime({ host, directory: path.join(directory, 'runtime') });
  assert.equal((await request(runtime, 'state')).capabilities.dashboard, 1);
  assert.equal((await request(runtime, `dashboard?${new URLSearchParams({ rootId: root.id })}`)).groups.length, 2);
  const run = await request(runtime, 'dashboard-run', { rootId: root.id, actionId: 'hello' }); await waitOutput(host, run.id, 'ENV=RELEASE');
  assert.equal((await request(runtime, 'dashboard-capture', { rootId: root.id, actionId: 'shot' })).size, redImage.length);
  const context = path.join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: path.join(directory, 'runtime') }), { mode: 0o600 });
  client = new Client({ name: 'dashboard-proof', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', context], stderr: 'pipe' }));
  const tools = (await client.listTools()).tools, byName = name => tools.find(x => x.name === name);
  assert.equal(byName('dashboard_actions')?.annotations.readOnlyHint, true); assert.equal(byName('dashboard_capture')?.annotations.readOnlyHint, false); assert.equal(byName('dashboard_capture')?.annotations.openWorldHint, true);
  assert.match(byName('dashboard_actions').description, /open_script/); assert.ok(byName('open_script').inputSchema.properties.env, 'open_script accepts env');
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content[0].text, value: r.isError ? null : r.structuredContent ?? JSON.parse(r.content[0].text) }; };
  const listed = await call('dashboard_actions');
  assert.equal(listed.isError, false); assert.equal(listed.value.title, 'Fixture'); assert.equal(listed.value.groups[0].actions[1].available, false); assert.deepEqual(listed.value.groups[0].actions[0].args, ['--fast']);
  const shot = await call('dashboard_capture', { actionId: 'shot' }); assert.equal(shot.isError, false); assert.equal(shot.value.action, 'shot'); assert.equal(shot.value.sha256, hash(redImage));
  assert.equal(JSON.parse(await readFile(path.join(rootPath, '.cache/captures/manifest.json'), 'utf8')).length, 2);
  assert.match((await call('dashboard_capture', { actionId: 'hello' })).text, /capture action/);
  const badEnv = await call('open_script', { path: 'hello.sh', desktopId: 'none', env: { 'bad-key': 'x' } }); assert.equal(badEnv.isError, true); assert.match(badEnv.text, /env/);
});
