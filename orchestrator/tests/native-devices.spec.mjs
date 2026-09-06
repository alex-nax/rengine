import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { answering, counted, deviceProject, devicesDeclaration, localGame, remoteGame, silent, slow, thisMachine } from './device-fixtures.mjs';

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

/* Spec 080's overlay fix and this section overlap here: the section is a scrolling pane that is
   busy whenever a probe is outstanding, and the popover hangs over it. Both halves are asserted
   while a probe is genuinely in flight — the probe records its own start and end, so "in flight"
   is measured rather than assumed. */
test('the devices section answers a click while a probe is in flight, and the popover takes precedence over it', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-devices-busy-')));
  let server, gui;
  try {
    const project = await deviceProject(directory, 'project', devicesDeclaration([thisMachine(), slow(), answering()]));
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    const count = async name => {
      try { return (await readFile(path.join(project, name), 'utf8')).length; } catch { return 0; }
    };
    const inFlight = async () => await count('probe-started.txt') > await count('probe-ended.txt');

    await gui.until(s => s.connected, 'the desktop connects');
    await gui.control('toolbar', 'Devices');
    let state = await gui.until(s => {
      const i = s.tabs.findIndex(t => t?.type === RE_DEVICES && t.devices?.devices?.length === 3);
      return i >= 0 && s.controls.some(c => c.tab === i && c.role === 'devices-refresh');
    }, 'the devices tab draws its rows');
    const view = state.tabs.findIndex(t => t?.type === RE_DEVICES);
    assert.equal(await count('probe-started.txt'), 1, 'opening the section probed the slow device once');

    // Refresh puts a probe back in flight; everything below happens inside that window.
    await gui.control('devices-refresh', '', view);
    while (await count('probe-started.txt') < 2) await delay(50);
    assert.equal(await inFlight(), true, 'the second probe is outstanding');

    // A press on a device row while the probe runs: the click lands, and it brings this pane to the
    // front of microui's container order. The popover has to be opened once first, because a surface
    // opened for the first time is already in front — the defect only appears on the second opening,
    // over a pane that was clicked in between.
    state = await gui.command({ op: 'state' });
    const rowOf = s => s.controls.find(c => c.tab === view && c.role.startsWith('devices-') && c.role !== 'devices-refresh');
    assert.ok(rowOf(state), 'a device row is addressable while the probe runs');
    const press = async () => { const r = rowOf(await gui.command({ op: 'state' }));
      await gui.click(r.rect[0] + Math.round(r.rect[2] / 2), r.rect[1] + Math.round(r.rect[3] / 2)); };
    await gui.control('toolbar', 'Settings', -1);
    await gui.until(s => s.controls?.some(c => c.role === 'settings' && c.key === 'vim'), 'the popover opens over the busy section');
    await press();
    await gui.until(s => !s.controls?.some(c => c.role === 'settings'), 'the row press reached the busy pane and closed the popover');
    assert.ok(rowOf(await gui.command({ op: 'state' })), 'the section still draws its rows after the press');

    // Reopened over the pane that press brought forward: without spec 080's fix the surface stays
    // visible and deaf, because microui routes the mouse to the frontmost container.
    const vimBefore = (await gui.command({ op: 'state' })).vim;
    await gui.control('toolbar', 'Settings', -1);
    await gui.until(s => s.controls?.some(c => c.role === 'settings' && c.key === 'vim'), 'the popover reopens');
    assert.equal(await inFlight(), true, 'still in flight while the popover is open');
    await gui.control('settings', 'vim', -1);
    await gui.until(s => s.vim !== vimBefore, 'the popover answers over a pane with a probe outstanding');

    // A press back on a device row closes it again and continues to the section beneath it.
    await press();
    await gui.until(s => !s.controls?.some(c => c.role === 'settings'), 'the row press closed the popover');
    assert.equal(await inFlight(), true, 'the row press happened while the probe was still outstanding');

    // And the section's own control still answers: a third probe starts before the second ends.
    await gui.control('devices-refresh', '', view);
    while (await count('probe-started.txt') < 3) await delay(50);
    assert.equal(await count('probe-ended.txt') < 3, true, 'the third probe started before the earlier ones ended');

    // The section settles and still lists every device, so nothing above was left half-drawn.
    state = await gui.until(s => s.tabs[view]?.devices?.devices?.length === 3 && s.tabs[view].devices.refreshed === true,
      'the section settles after the overlapping refreshes');
    assert.deepEqual(state.tabs[view].devices.devices.map(x => x.id), ['local', 'slow-box', 'answering-box']);
    assert.equal(state.tabs[view].devices.devices.find(x => x.id === 'slow-box').reachable, true);
    assert.ok(state.controls.some(c => c.tab === view && c.role === 'devices-refresh'), 'the refresh control survives');
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});

/* Spec 082, "Controls on the device". The tab listed each device's bound targets as a line of ids
   with nothing to press. They are controls now, and they run through the dashboard's own route. */
test('a device’s bound actions are controls that run from the tab, gated by the availability the dashboard computed', { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-device-controls-')));
  let server, gui;
  try {
    const document = {
      /* The counted device is listed with nothing bound to it, so the empty case and the
         probes-only-on-open rule are both exercised by the same row. */
      ...devicesDeclaration([thisMachine(), counted(), silent(), answering()]),
      games: [remoteGame()],
      dashboard: { title: 'Fixture', groups: [{ id: 'device', title: 'Device', actions: [
        { id: 'here', title: 'Runs here', kind: 'script', script: 'tools/say.sh', args: ['now'] },
        /* An action whose whole purpose is to make the silent box usable, beside one that needs it. */
        { id: 'install-silent', title: 'Install on the silent box', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'offline-log', title: 'Offline log', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'on-answering', title: 'On the answering box', kind: 'script', script: 'tools/probe-ok.sh', device: 'answering-box' },
        { id: 'needs-file', title: 'Needs a local file', kind: 'script', script: 'tools/probe-ok.sh', device: 'answering-box', requires: ['data/absent.bin'] },
      ] }] },
    };
    const project = await deviceProject(directory, 'project', document);
    await writeFile(path.join(project, 'tools/say.sh'), '#!/bin/bash\necho "RAN FROM DEVICES arg=$1"\n');
    await chmod(path.join(project, 'tools/say.sh'), 0o755);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });

    await gui.until(s => s.connected, 'the desktop connects');
    await gui.until(s => s.tabs.some(t => t?.type === 6 && t.dashboard?.groups?.length), 'the dashboard auto-opens first');
    /* The whole section has to be drawn for these assertions: a row scrolled out records nothing. */
    await gui.command({ op: 'resize', width: 1280, height: 1400 });
    await gui.control('toolbar', 'Devices');
    let state = await gui.until(s => {
      const i = s.tabs.findIndex(t => t?.type === RE_DEVICES && t.devices?.devices?.length === 4);
      return i >= 0 && s.controls.some(c => c.tab === i && c.role === 'devices-game' && c.key === 'remote-target');
    }, 'the devices tab draws every bound target as a control');
    const view = state.tabs.findIndex(t => t?.type === RE_DEVICES), tab = state.tabs[view];
    const of = id => tab.devices.devices.find(device => device.id === id);
    const drawn = (role, key) => state.controls.some(c => c.tab === view && c.role === role && c.key === key);

    /* Availability is the dashboard's, and the tab renders it: runnable ones are buttons. */
    assert.ok(drawn('devices-action', 'here'), 'an action bound to this machine is runnable here');
    assert.ok(drawn('devices-action', 'on-answering'), 'an action on a reachable device is runnable here');
    assert.ok(drawn('devices-unavailable', 'needs-file') && !drawn('devices-action', 'needs-file'),
      'an action missing its own local prerequisite is drawn disabled');
    /* Bootstrap versus gated, decided in spec 082: an action that exists to make a device usable is
       gated on that device exactly like every other one bound to it, rather than exempted. */
    for (const id of ['install-silent', 'offline-log']) {
      assert.ok(drawn('devices-unavailable', id), `${id} is drawn disabled while its device is unreachable`);
      assert.ok(!drawn('devices-action', id), `${id} is not runnable while its device is unreachable`);
    }

    /* The surface argument for the whole feature: two actions bound to one unreachable device show
       ONE reason, on the device row, and neither control restates it. */
    const reasons = state.controls.filter(c => c.tab === view && c.role === 'devices-reason').map(c => c.key);
    const boxReason = of('silent-box').issues[0];
    assert.match(boxReason, /Silent box \(silent-box\) is not reachable/);
    assert.equal(reasons.filter(text => text === boxReason).length, 1, 'the device row draws its reason, once');
    /* The load-bearing half: a control that restated the reason would wrap it rather than repeat it
       verbatim, so this counts the device by name across every reason the section drew. */
    assert.equal(reasons.filter(text => text.includes('silent-box')).length, 1,
      `no bound control restates or paraphrases it; drew ${JSON.stringify(reasons)}`);
    /* A control blocked by its OWN prerequisite still names it, as the dashboard tab does. */
    assert.ok(reasons.includes('Unavailable: missing requires data/absent.bin'), `own reason named; drew ${JSON.stringify(reasons)}`);
    /* A device with nothing bound says so. */
    assert.deepEqual(of('counted-box').controls, []); assert.deepEqual(of('counted-box').targets, []);
    assert.equal(reasons.filter(text => text === 'No target is bound to this device.').length, 1,
      `the empty device says so; drew ${JSON.stringify(reasons)}`);

    /* A bound game reports the preflight the launch uses, and a remote one never reads ready. */
    assert.ok(drawn('devices-game', 'remote-target'), 'a bound game draws its own preflight row');
    assert.ok(reasons.some(text => /on Answering box \(answering-box\), not on this machine/.test(text)),
      'a game bound elsewhere says where it runs instead of claiming to be ready');

    /* Geometry: every trailing pill ends where the device row's own status pill ends. A leading
       column that failed to reserve the pill's width would push it past the pane (5a0bc38). */
    const edges = state.controls.filter(c => c.tab === view && ['devices-status', 'devices-meta'].includes(c.role))
      .map(c => ({ key: `${c.role}:${c.key}`, role: c.role, right: c.rect[0] + c.rect[2], width: c.rect[2] }));
    assert.ok(edges.length >= 10, `every device and target row carries a trailing pill; got ${edges.length}`);
    const right = edges[0].right;
    assert.deepEqual(edges.filter(e => e.right !== right).map(e => e.key), [],
      `every trailing pill ends where the device row's own does, at x=${right}`);
    for (const role of ['devices-status', 'devices-meta']) {
      const column = edges.filter(e => e.role === role);
      assert.deepEqual(column.filter(e => e.width !== column[0].width).map(e => e.key), [],
        `${role} keeps one column width; a pill pushed past the pane would be clipped narrower`);
    }
    assert.ok(right <= state.width, `the trailing column stays inside the pane (${right} <= ${state.width})`);

    /* Drawing controls probes nothing: the counted device is probed on open and never again while
       the section renders. Probes stay on open and Refresh, which is what spec 082 protects. */
    const runs = async () => (await readFile(path.join(project, 'probe-count.txt'), 'utf8')).length;
    assert.equal(await runs(), 1, 'opening the section probed the counted device once');
    for (let i = 0; i < 30; i++) await gui.command({ op: 'state' });
    assert.equal(await runs(), 1, 'thirty more frames of the same section probed nothing');

    /* And the control runs, through the route the dashboard uses: a script lands in a script tab. */
    await gui.control('devices-action', 'here', view);
    state = await gui.until(s => s.tabs.some(t => t?.type === 3 && t.title === 'Script · say.sh' && t.text?.includes('RAN FROM DEVICES arg=now')),
      'the action opened its retained script session with the declared arguments');
    assert.equal(server.sessions.snapshot(state.tabs.find(t => t?.type === 3 && t.title === 'Script · say.sh').session).rootId, root.id);
  } finally {
    await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
  }
});
