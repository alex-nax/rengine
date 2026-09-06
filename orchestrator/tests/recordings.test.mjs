import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { forward, json } from '../runtime/protocol.mjs';
import { request } from '../launcher/sidecar.mjs';
import { listRecordings, readRecording } from '../server/recordings.mjs';
import { manifest, segment } from './recording-fixtures.mjs';

const call = (target, route) => request(target, route);

/* A proxy host that advertises only what a service predating spec 081 would: the recording routes
   must be served by the worker itself, never forwarded, or the capability is undeliverable by a
   layered update (spec 078's asymmetry, KI-043). */
async function agedHost(server, keep = ['handoff']) {
  const proxy = http.createServer(async (req, res) => {
    if (req.url === '/api/state') {
      const state = await request(server, 'state');
      state.capabilities = Object.fromEntries(Object.entries(state.capabilities).filter(([name]) => keep.includes(name)));
      json(res, 200, state);
    } else if (req.url.startsWith('/api/recording')) json(res, 404, { error: 'Unknown workspace endpoint.' });
    else forward(req, res, server);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${proxy.address().port}`, token: server.token, instance: server.instance, pid: process.pid,
    close: () => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }) };
}

test('the recording store lists committed segments newest first and reports incomplete ones instead of dropping them', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-recordings-')));
  try {
    const root = { id: 'r1', path: directory, name: 'fixture' };
    assert.deepEqual((await listRecordings(root)).recordings, [], 'a project with no recordings lists none');

    await segment(directory, '20260906T204512Z-aaaaaa', { frames: 3, lines: 2 });
    await segment(directory, '20260906T204900Z-bbbbbb', { frames: 5, lines: 4, kind: 'segment' });
    await segment(directory, '20260906T205100Z-cccccc', { frames: 2, incomplete: true });
    await segment(directory, '20260906T205200Z-dddddd', { frames: 1, malformed: true });
    await segment(directory, '20260906T205300Z-eeeeee', { frames: 1, manifest: { ...manifest('x'), version: 9 } });

    const listed = await listRecordings(root);
    assert.equal(listed.rootId, 'r1');
    assert.equal(listed.path, '.cache/recordings');
    assert.deepEqual(listed.recordings.map(entry => entry.id),
      ['20260906T205300Z-eeeeee', '20260906T205200Z-dddddd', '20260906T205100Z-cccccc', '20260906T204900Z-bbbbbb', '20260906T204512Z-aaaaaa'],
      'newest first, by the sortable id the recorder mints');
    const complete = listed.recordings.find(entry => entry.id === '20260906T204900Z-bbbbbb');
    assert.equal(complete.kind, 'segment');
    assert.equal(complete.game, 'fixture-game');
    assert.equal(complete.sessionId, 'fixture-session');
    assert.equal(complete.durationMs, 400);
    assert.equal(complete.path, '.cache/recordings/20260906T204900Z-bbbbbb');
    assert.equal(complete.artifacts.keyframes.count, 5);
    assert.equal(complete.artifacts.keyframes.present, true);
    assert.equal(complete.artifacts.log.lines, 4);
    assert.equal(complete.artifacts.log.present, true);
    assert.equal(complete.artifacts.audio.present, false, 'audio is a declared slot, never silently absent');
    assert.equal(complete.artifacts.audio.issue, 'KI-044');
    assert.ok(complete.bytes > 0);

    const incomplete = listed.recordings.find(entry => entry.id === '20260906T205100Z-cccccc');
    assert.match(incomplete.error, /no manifest\.json/, 'a commit that did not finish is a fact about the store');
    assert.equal(incomplete.artifacts, undefined);
    assert.match(listed.recordings.find(entry => entry.id === '20260906T205200Z-dddddd').error, /not valid JSON/);
    assert.match(listed.recordings.find(entry => entry.id === '20260906T205300Z-eeeeee').error, /version 9/);

    for (let i = 0; i < 6; i++) await segment(directory, `20260907T00000${i}Z-ffffff`, { frames: 1, lines: 1 });
    assert.equal((await listRecordings(root, { limit: 4 })).recordings.length, 4, 'the listing is bounded');
    assert.equal((await listRecordings(root, { limit: 4 })).truncated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reading one recording returns its manifest, a bounded log tail and a paged keyframe index of root-relative paths', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-recording-read-')));
  try {
    const root = { id: 'r1', path: directory, name: 'fixture' };
    await segment(directory, '20260906T204512Z-aaaaaa', { frames: 12, lines: 40 });

    const all = await readRecording(root, '20260906T204512Z-aaaaaa');
    assert.equal(all.manifest.version, 1);
    assert.equal(all.manifest.clock.field, 'atMs');
    assert.equal(all.path, '.cache/recordings/20260906T204512Z-aaaaaa');
    assert.equal(all.keyframes.length, 12);
    assert.equal(all.keyframes[0].path, '.cache/recordings/20260906T204512Z-aaaaaa/keyframes/000001.jpg',
      'a keyframe is fetched by root-relative path, like every other asset here');
    assert.equal(all.keyframes[0].atMs, 0);
    assert.equal(all.keyframes[1].atMs, 100);
    assert.equal(all.keyframes[0].sequence, 41233);
    assert.ok(all.keyframes[0].wall.endsWith('Z'));
    assert.equal(all.log.lines.length, 40);
    assert.equal(all.log.lines[0].atMs, 0);
    assert.equal(all.log.truncated, false);

    const page = await readRecording(root, '20260906T204512Z-aaaaaa', { artifact: 'keyframes', offset: 4, limit: 3 });
    assert.deepEqual(page.keyframes.map(entry => entry.sequence), [41237, 41238, 41239]);
    assert.equal(page.nextOffset, 7);
    assert.equal(page.log, undefined, 'an artifact selector returns only what was asked for');

    const tail = await readRecording(root, '20260906T204512Z-aaaaaa', { artifact: 'log', maxCharacters: 200 });
    assert.ok(tail.log.lines.length < 40 && tail.log.lines.length > 0);
    assert.equal(tail.log.truncated, true);
    assert.equal(tail.keyframes, undefined);
    assert.match(tail.log.lines.at(-1).text, /fixture log line 39/, 'the tail keeps the newest lines');

    await assert.rejects(readRecording(root, 'no-such-recording'), /Unknown recording/);
    for (const bad of ['../..', 'a/b', '/etc', '.']) await assert.rejects(readRecording(root, bad), /recording id/i, bad);
    await segment(directory, '20260906T205100Z-cccccc', { frames: 1, incomplete: true });
    await assert.rejects(readRecording(root, '20260906T205100Z-cccccc'), /no manifest\.json/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the session host serves the recording routes and the replaceable worker serves them itself above an aged host', { timeout: 40000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-recording-routes-')));
  let host, aged, worker, mcp;
  try {
    const project = path.join(directory, 'project');
    await mkdir(project, { recursive: true });
    await segment(project, '20260906T204512Z-aaaaaa', { frames: 4, lines: 3 });
    host = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await host.store.addRoot(project);

    const hostState = await call(host, 'state');
    assert.equal(hostState.capabilities.recordings, 1, 'the host answers from the same module');
    const hostList = await call(host, `recordings?rootId=${root.id}`);
    assert.deepEqual(hostList.recordings.map(entry => entry.id), ['20260906T204512Z-aaaaaa']);
    const hostRead = await call(host, `recording?rootId=${root.id}&id=20260906T204512Z-aaaaaa&artifact=manifest`);
    assert.equal(hostRead.manifest.video.frames, 4);

    aged = await agedHost(host);
    assert.equal((await call(aged, 'state')).capabilities.recordings, undefined, 'the aged host advertises nothing');
    worker = await startWorker(aged);
    const workerState = await call(worker, 'state');
    assert.equal(workerState.capabilities.recordings, 1, 'a layered workspace update alone delivers this capability');
    const workerList = await call(worker, `recordings?rootId=${root.id}`);
    assert.deepEqual(workerList.recordings.map(entry => entry.id), ['20260906T204512Z-aaaaaa'],
      'served from the worker checkout, not forwarded into a service that would answer 404');
    const workerRead = await call(worker, `recording?rootId=${root.id}&id=20260906T204512Z-aaaaaa&artifact=keyframes&limit=2`);
    assert.equal(workerRead.keyframes.length, 2);
    assert.equal(workerRead.keyframes[0].path, '.cache/recordings/20260906T204512Z-aaaaaa/keyframes/000001.jpg');

    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ ...worker, rootId: root.id }), { mode: 0o600 });
    mcp = new Client({ name: 'recording-test', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp-worker.mjs'), '--context', contextFile], stderr: 'pipe' }));
    const tools = (await mcp.listTools()).tools;
    const list = tools.find(tool => tool.name === 'recordings_list'), read = tools.find(tool => tool.name === 'recording_read');
    assert.ok(list && read, 'both recording tools are discoverable');
    assert.equal(list.annotations.readOnlyHint, true);
    assert.equal(read.annotations.readOnlyHint, true);
    const invoke = async (name, args = {}) => {
      const result = await mcp.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent ?? JSON.parse(result.content[0].text);
    };
    assert.deepEqual((await invoke('recordings_list')).recordings.map(entry => entry.id), ['20260906T204512Z-aaaaaa']);
    const readTool = await invoke('recording_read', { id: '20260906T204512Z-aaaaaa' });
    assert.equal(readTool.manifest.audio.present, false);
    assert.equal(readTool.keyframes.length, 4);
    assert.equal(readTool.log.lines.length, 3);
  } finally {
    await mcp?.close(); await worker?.close(); await aged?.close(); await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a service without the capability refuses the recording tools by name with the remedy that actually works', { timeout: 40000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-recording-guard-')));
  let host, aged, mcp;
  try {
    const project = path.join(directory, 'project');
    await mkdir(project, { recursive: true });
    host = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await host.store.addRoot(project);
    aged = await agedHost(host);
    const contextFile = path.join(directory, 'context.json');
    await writeFile(contextFile, JSON.stringify({ ...aged, rootId: root.id }), { mode: 0o600 });
    mcp = new Client({ name: 'recording-guard-test', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp-worker.mjs'), '--context', contextFile], stderr: 'pipe' }));
    for (const name of ['recordings_list', 'recording_read']) {
      const result = await mcp.callTool({ name, arguments: name === 'recording_read' ? { id: 'x' } : {} });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /predates game recording\. Update the workspace layer first\./, name);
    }
  } finally { await mcp?.close(); await aged?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('the ring bound is a validated workspace preference, so the desktop shows a bound it actually applied', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-recording-prefs-')));
  let host;
  try {
    host = await startServer({ stateDir: path.join(directory, 'state') });
    const saved = await request(host, 'preferences', { recording: { seconds: 60, bytes: 32 * 1024 * 1024, fps: 5, width: 480, quality: 60 } });
    assert.deepEqual(saved.recording, { seconds: 60, bytes: 32 * 1024 * 1024, fps: 5, width: 480, quality: 60 });
    assert.equal((await request(host, 'state')).preferences.recording.seconds, 60);
    const merged = await request(host, 'preferences', { recording: { seconds: 300 } });
    assert.equal(merged.recording.seconds, 300);
    assert.equal(merged.recording.fps, 5, 'one key at a time, like every other preference group');
    for (const bad of [{ seconds: 4 }, { seconds: 901 }, { bytes: 1024 }, { fps: 0 }, { fps: 31 }, { width: 2000 }, { quality: 96 }, { seconds: 'lots' }, { unknown: 1 }, 7]) {
      await assert.rejects(request(host, 'preferences', { recording: bad }), /recording preference/i, JSON.stringify(bad));
    }
  } finally { await host?.close(); await rm(directory, { recursive: true, force: true }); }
});
