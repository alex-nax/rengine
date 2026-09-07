import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { installExternalProject } from '../external-project.mjs';
import { nativeClient } from './native-client.mjs';

test('native external project shows its identity, source tree and working external dashboard', { timeout: 90000 }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'redit-native-external-')));
  const project = path.join(dir, 'project'); await mkdir(project);
  await writeFile(path.join(project, 'package.json'), '{"name":"external-native-fixture","scripts":{}}');
  let host, gui;
  try {
    const installed = await installExternalProject({ project, profile: path.join(dir, 'profile'), state: path.join(dir, 'runtime'), launcher: path.join(dir, 'open.command'), title: 'External native' });
    host = await startServer({ stateDir: installed.state });
    const root = await request(host, 'roots', { path: project, declarationFile: installed.declarationFile });
    gui = await nativeClient(host, { root: root.id });
    let state = await gui.until(s => s.connected && s.title === 'External native' && s.tabs.some(t => t?.type === 6 && t.dashboard?.groups?.length), 'external project loaded');
    assert.equal(state.primaryRoot, root.id);
    assert.match(state.windowTitle, /^External native/);
    assert.ok(state.tabs.some(t => t?.type === 1 && t.root === root.id && t.tree?.entries?.some(e => e.name === 'package.json')));
    const board = state.tabs.findIndex(t => t?.type === 6);
    await gui.control('dashboard-action', 'scripts', board);
    state = await gui.until(s => s.tabs.some(t => t?.text?.includes('external-native-fixture')), 'external helper output in a native terminal');
    const output = state.tabs.find(t => t?.text?.includes('external-native-fixture'));
    assert.equal(host.sessions.snapshot(output.session).rootId, root.id);
    assert.deepEqual(await readdir(project), ['package.json']);
  } finally { await gui?.close(); await host?.close(); await rm(dir, { recursive: true, force: true }); }
});
