import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { request } from '../launcher/sidecar.mjs';
import { WorkspaceStore } from '../server/store.mjs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-external-')));
  const project = path.join(directory, 'project space & literal');
  const profile = path.join(directory, 'profile space');
  await mkdir(project); await mkdir(profile);
  await writeFile(path.join(project, 'sample.json'), '{"value":42}');
  const helper = path.join(profile, 'helper.mjs');
  await writeFile(helper, "import fs from 'node:fs'; console.log(process.argv[2] ? JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), null, 2) : 'BOUND_CWD=' + process.cwd());");
  const declarationFile = path.join(profile, 'project.json');
  const document = { contract: 5, project: 'external', title: 'External project', icon: { glyph: 'Ex', token: 'ok' },
    formats: [{ id: 'json', title: 'JSON', match: ['*.json'], modes: ['text', 'preview'], default: 'text',
      preview: { kind: 'text', command: [process.execPath, helper, '${file}'] } }],
    devices: [{ id: 'local', title: 'External device', kind: 'local' }],
    games: [{ id: 'fixture', title: 'External game', executable: [process.execPath], surface: 'external' }],
    dashboard: { title: 'External controls', groups: [{ id: 'inspect', title: 'Inspect', actions: [
      { id: 'status', title: 'Status', kind: 'log', command: [process.execPath, helper] },
    ] }] } };
  await writeFile(declarationFile, JSON.stringify(document));
  const host = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, project, profile, declarationFile, document, host };
}

test('external declaration registration persists on the real root and refuses rebinding', async t => {
  const f = await fixture(t);
  const root = await request(f.host, 'roots', { path: f.project, declarationFile: f.declarationFile });
  assert.equal(root.declarationFile, f.declarationFile, 'the HTTP root API retains the external declaration');
  assert.equal(root.path, f.project);
  assert.equal((await request(f.host, 'state')).capabilities.externalDeclarations, 1);
  const restored = await WorkspaceStore.open(path.join(f.directory, 'state'));
  assert.deepEqual(await restored.addRoot(f.project), root, 'reopening without an option preserves the binding');
  assert.deepEqual(await restored.addRoot(f.project, f.declarationFile), root);
  const other = path.join(f.profile, 'other.json'); await writeFile(other, JSON.stringify(f.document));
  await assert.rejects(request(f.host, 'roots', { path: f.project, declarationFile: other }), /already bound/);
  await assert.rejects(request(f.host, 'roots', { path: f.project, declarationFile: 'relative.json' }), /absolute/);
  await assert.rejects(request(f.host, 'roots', { path: f.project, declarationFile: f.profile }), /file/);
  await assert.rejects(request(f.host, 'roots', { path: f.project, declarationFile: path.join(f.profile, 'absent') }), /ENOENT|no such/);
  assert.deepEqual(await readdir(f.project), ['sample.json'], 'registration writes nothing in the project');
});

test('host and worker serve all external capabilities while execution and files keep the project binding', async t => {
  const f = await fixture(t);
  const root = await request(f.host, 'roots', { path: f.project, declarationFile: f.declarationFile });
  const worker = await startWorker(f.host); t.after(() => worker.close());
  for (const endpoint of [f.host, worker]) {
    const query = new URLSearchParams({ rootId: root.id });
    const formats = await request(endpoint, `formats?${query}`);
    assert.equal(formats.title, 'External project', 'identity comes from the external file');
    assert.equal(formats.source, f.declarationFile);
    const preview = await request(endpoint, 'format-preview', { rootId: root.id, path: 'sample.json' });
    assert.equal(preview.text.trim(), '{\n  "value": 42\n}');
    const board = await request(endpoint, `dashboard?${query}`);
    assert.equal(board.title, 'External controls');
    assert.equal(board.groups[0].actions[0].available, true);
    const devices = await request(endpoint, `devices?${query}`);
    assert.ok(devices.devices.some(d => d.title === 'External device'), JSON.stringify(devices));
    const game = await request(endpoint, `game-config?${query}`);
    assert.equal(game.title, 'External game'); assert.equal(game.ready, true);
    const session = await request(endpoint, 'dashboard-run', { rootId: root.id, actionId: 'status' });
    for (let i = 0; i < 100 && f.host.sessions.snapshot(session.id).state === 'running'; i++) await delay(20);
    const ended = f.host.sessions.snapshot(session.id, true);
    assert.equal(ended.rootId, root.id); assert.equal(ended.exitCode, 0);
    assert.ok(ended.output.includes(`BOUND_CWD=${f.project}`), ended.output);
    await assert.rejects(request(endpoint, `file?${query}&path=../profile%20space/project.json`), /outside/);
  }
  assert.deepEqual(await readdir(f.project), ['sample.json']);
  assert.equal(await readFile(path.join(f.project, 'sample.json'), 'utf8'), '{"value":42}');
});

test('an external declaration error names its source and never falls back to the project file', async t => {
  const f = await fixture(t);
  const root = await request(f.host, 'roots', { path: f.project, declarationFile: f.declarationFile });
  await mkdir(path.join(f.project, '.rengine'));
  await writeFile(path.join(f.project, '.rengine/project.json'), JSON.stringify({ ...f.document, title: 'Local fallback' }));
  const listing = () => request(f.host, `formats?rootId=${root.id}`);
  await writeFile(f.declarationFile, '{');
  let broken = await listing();
  assert.ok(broken.error?.startsWith(f.declarationFile), JSON.stringify(broken));
  assert.match(broken.error, /JSON/);
  await writeFile(f.declarationFile, JSON.stringify({ ...f.document, dashboard: { typo: true } }));
  broken = await listing();
  assert.ok(broken.dashboardError?.startsWith(f.declarationFile), JSON.stringify(broken));
  assert.equal(broken.title, 'External project');
  await rm(f.declarationFile);
  broken = await listing();
  assert.equal(broken.declared, true); assert.match(broken.error, /cannot read/);
  assert.ok(broken.error.startsWith(f.declarationFile));
  assert.equal(broken.title, undefined);
});

test('launcher refuses a legacy host before registering roots or creating sessions', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'redit-old-host-')));
  const mutations = [], instance = 'external-legacy-fixture', token = 'a'.repeat(64);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ protocol: 1, instance }));
    else if (req.url === '/api/state' && req.method === 'GET') res.end(JSON.stringify({ instance, capabilities: {}, roots: [], sessions: [] }));
    else { mutations.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end('{"error":"Legacy host cannot accept this operation"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await writeFile(path.join(directory, 'sidecar.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, instance, pid: process.pid }));
  let failure;
  try { await promisify(execFile)(process.execPath, ['orchestrator/launch.mjs', '--project', directory, '--declaration', path.join(directory, 'profile.json'), '--state', directory, '--no-agent']); }
  catch (error) { failure = error; }
  assert.deepEqual(mutations, [], 'the legacy host receives no root or session mutations');
  assert.match(failure?.stderr ?? '', /predates external declarations/);
});
