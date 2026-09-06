import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { answering, counted, deviceProject, devicesDeclaration, localGame, remoteGame, silent, thisMachine } from './device-fixtures.mjs';

const RE_DEVICES = 7;

test('the devices section lists declared devices with one reason each, and refresh re-probes', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-devices-')));
  let server, gui;
  try {
    const document = {
      ...devicesDeclaration([thisMachine({ title: 'This machine' }), answering(), silent(), counted()]),
      games: [localGame(), remoteGame()],
      dashboard: { title: 'Fixture', groups: [{ id: 'device', title: 'Device', actions: [
        { id: 'offline-log', title: 'Offline log', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'offline-screen', title: 'Offline screenshot', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'offline-push', title: 'Offline push', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'here', title: 'Runs here', kind: 'script', script: 'tools/probe-ok.sh' },
      ] }] },
    };
    const project = await deviceProject(directory, 'project', document);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });

    await gui.until(s => s.connected, 'the desktop connects');
    /* The dashboard auto-opens once per root and selects itself; let that settle before opening
       Devices, so the assertions read the section that is actually drawn. */
    await gui.until(s => s.tabs.some(t => t?.type === 6 && t.dashboard?.groups?.length), 'the dashboard auto-opens first');
    await gui.control('toolbar', 'Devices');
    /* Wait for the frame that publishes the rows, not merely for the listing to arrive. */
    let state = await gui.until(s => {
      const i = s.tabs.findIndex(t => t?.type === RE_DEVICES && t.devices?.devices?.length === 4);
      return i >= 0 && s.controls.some(c => c.tab === i && c.role === 'devices-unreachable');
    }, 'the devices tab loads its listing and draws its rows');
    const view = state.tabs.findIndex(t => t?.type === RE_DEVICES), tab = state.tabs[view];
    assert.equal(tab.title, 'Devices'); assert.equal(tab.root, root.id);
    assert.equal(tab.devices.contract, 4);
    const of = id => tab.devices.devices.find(device => device.id === id);
    assert.deepEqual(tab.devices.devices.map(x => x.id), ['local', 'answering-box', 'silent-box', 'counted-box']);

    /* The surface argument for the whole feature: three actions bound to one unreachable device
       show ONE reason on ONE device row, not the same reason repeated per action. */
    assert.equal(of('silent-box').reachable, false);
    assert.equal(of('silent-box').issues.length, 1);
    assert.deepEqual(of('silent-box').actions, ['offline-log', 'offline-screen', 'offline-push']);
    assert.match(of('silent-box').issues[0], /Silent box \(silent-box\) is not reachable: the probe failed \(exit 7\): fixture: the box is not answering\./);
    assert.equal(of('answering-box').reachable, true);
    assert.deepEqual(of('answering-box').games, ['remote-target']);
    assert.equal(of('local').reachable, true); assert.equal(of('local').probed, false);
    assert.deepEqual(of('local').games, ['local-target']);

    const rows = state.controls.filter(c => c.tab === view && c.role.startsWith('devices-'));
    for (const id of ['local', 'answering-box', 'counted-box']) {
      assert.ok(rows.some(c => c.role === 'devices-reachable' && c.key === id), `${id} draws as reachable`);
    }
    assert.ok(rows.some(c => c.role === 'devices-unreachable' && c.key === 'silent-box'), 'the unreachable device draws as unreachable');
    assert.ok(!rows.some(c => c.role === 'devices-reachable' && c.key === 'silent-box'));
    assert.ok(state.controls.some(c => c.tab === view && c.role === 'devices-refresh'), 'the section carries a manual refresh');

    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/devices.bmp') }), true);

    /* Opening the tab probed each device once; refresh bypasses the service's brief cache. */
    const runs = async () => (await readFile(path.join(project, 'probe-count.txt'), 'utf8')).length;
    assert.equal(await runs(), 1, 'opening the section probed the counted device once');
    const first = of('counted-box').checkedAt;
    await gui.control('devices-refresh', '', view);
    state = await gui.until(s => {
      const listed = s.tabs[view]?.devices?.devices?.find(device => device.id === 'counted-box');
      return listed && listed.checkedAt !== first;
    }, 'refresh re-probes rather than serving the cache');
    assert.equal(await runs(), 2);
    assert.equal(state.tabs[view].devices.refreshed, true);

    /* A device that comes back is reported as reachable on the next explicit check, with no restart. */
    await writeFile(path.join(project, 'tools/probe-fail.sh'), '#!/bin/bash\nexit 0\n');
    await gui.control('devices-refresh', '', view);
    state = await gui.until(s => s.tabs[view]?.devices?.devices?.find(device => device.id === 'silent-box')?.reachable === true,
      'a device that answers again reports reachable');
    assert.deepEqual(state.tabs[view].devices.devices.find(device => device.id === 'silent-box').issues, []);

    /* The reason stays attached to the device, never restated per bound action. */
    const board = state.tabs.findIndex(t => t?.type === 6);
    assert.equal(state.controls.filter(c => c.tab === view && c.role === 'devices-unreachable').length, 0,
      'every device answers again, so no row draws a reason');
    assert.ok(state.controls.some(c => c.tab === board || c.tab === view), 'both sections stay addressable');
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('the devices section names a project that declares none, and survives a service that cannot answer', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-devices-none-')));
  let server, gui;
  try {
    /* A contract-3 project: the implicit local device is still offered, so the section is never blank. */
    const project = await deviceProject(directory, 'project', { ...devicesDeclaration([]), contract: 3, devices: undefined, games: [localGame()] });
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.connected, 'the desktop connects');
    await gui.control('toolbar', 'Devices');
    const state = await gui.until(s => {
      const i = s.tabs.findIndex(t => t?.type === RE_DEVICES && t.devices?.devices);
      return i >= 0 && s.controls.some(c => c.tab === i && c.role === 'devices-reachable');
    }, 'the devices tab loads for a contract-3 project');
    const tab = state.tabs.find(t => t?.type === RE_DEVICES);
    assert.equal(tab.devices.contract, 3);
    assert.deepEqual(tab.devices.devices.map(x => x.id), ['local'], 'the implicit local device is listed without being declared');
    assert.equal(tab.devices.devices[0].reachable, true);
    assert.deepEqual(tab.devices.devices[0].games, ['local-target']);
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});
