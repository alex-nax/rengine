import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readDeclaration, CONTRACTS } from '../server/formats.mjs';
import { deviceStatus, declaredDevices, deviceFor, forgetProbes, projectDevices, PROBE_TTL_MS } from '../server/devices.mjs';
import { inspectGame } from '../server/games.mjs';
import { dashboardActions } from '../server/dashboard.mjs';
import { declaration } from './format-fixtures.mjs';
import { gameDeclaration } from './game-fixtures.mjs';
import {
  HOST, SERIAL, answering, counted, deviceProject, devicesDeclaration, gated, headset,
  localGame, remoteGame, remoteHost, silent, stalling, thisMachine,
} from './device-fixtures.mjs';

const declare = async (directory, name, document) => {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root);
};
const scratch = async name => realpath(await mkdtemp(path.join(tmpdir(), `rengine-${name}-`)));
const asRoot = (id, root) => ({ id, path: root, name: path.basename(root) });
const reasons = status => status.issues.join(' | ');
const missing = async (root, path_) => { try { await stat(path.join(root, path_)); return false; } catch { return true; } };

test('contract 4 devices validate, contracts 1-3 stay accepted, and a device key is rejected by version', async () => {
  const directory = await scratch('device-decl');
  try {
    for (const contract of [1, 2, 3]) {
      const plain = await declare(directory, `plain-${contract}`, { ...declaration(), contract });
      assert.equal(plain.contract, contract); assert.equal(plain.error, undefined);
      assert.equal(plain.devices, undefined); assert.equal(plain.devicesError, undefined, `contract ${contract} is untouched`);
    }
    const full = await declare(directory, 'full', devicesDeclaration([thisMachine(), answering(), headset()]));
    assert.equal(full.error, undefined); assert.equal(full.devicesError, undefined);
    assert.deepEqual(full.devices.map(x => x.id), ['local', 'answering-box', 'headset']);
    assert.equal(full.formats[0].id, 'fixture-pack');

    /* The bump is the point: an older reader answers "unknown contract 4"; this one names the
       contract that devices needs, for the array and for the key alike. */
    for (const contract of [1, 2, 3]) {
      const stale = await declare(directory, `stale-${contract}`, { ...devicesDeclaration([answering()]), contract });
      assert.match(stale.devicesError, /devices requires contract 4/, `contract ${contract}`);
      assert.match(stale.devicesError, new RegExp(`declared contract ${contract}`));
      assert.equal(stale.devices, undefined);
      assert.equal(stale.formats[0].id, 'fixture-pack', 'formats survive a devices problem');
    }
    const staleGameKey = await declare(directory, 'stale-game-key', gameDeclaration({ device: 'answering-box' }));
    assert.match(staleGameKey.gamesError, /device requires contract 4 \(declared contract 3\)/);
    const staleActionKey = await declare(directory, 'stale-action-key', {
      ...declaration(), contract: 3,
      dashboard: { title: 'Board', groups: [{ id: 'g', title: 'G', actions: [{ id: 'a', title: 'A', kind: 'script', script: 'tools/x.sh', device: 'headset' }] }] },
    });
    assert.match(staleActionKey.dashboardError, /device requires contract 4 \(declared contract 3\)/);
    assert.equal(staleActionKey.dashboard, undefined);

// One above the ceiling, derived rather than written down: this assertion is about the gate,
    // and hard-coding the number made it silently stop testing it the day the ceiling rose.
    const beyond = CONTRACTS.at(-1) + 1;
    const unknownContract = await declare(directory, 'unknown-contract', { ...declaration(), contract: beyond });
    assert.match(unknownContract.error, new RegExp(`unknown contract ${beyond}.*this rEngine supports contracts`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('device cross-field rules are named, and an unknown device reference lists the ids on offer', async () => {
  const directory = await scratch('device-rules');
  try {
    const cases = {
      'repeated id': [[answering(), answering()], /devices\[1\]\.id repeats "answering-box"/],
      'two local devices': [[thisMachine(), thisMachine({ id: 'other', title: 'Other' })], /only one device may declare kind "local"/],
      'local kind under another id': [[thisMachine({ id: 'workstation' })], /must use the reserved id "local"/],
      'local id under another kind': [[answering({ id: 'local' })], /the id "local" is reserved for a device of kind "local"/],
      'probe on local': [[thisMachine({ probe: ['tools/probe-ok.sh'] })], /probe is not permitted on the local device/],
      'host on local': [[thisMachine({ host: { value: 'somewhere' } })], /host is not permitted on the local device/],
      'remote without a probe': [[{ id: 'bare', kind: 'ssh', title: 'Bare' }], /probe is required for a ssh device/],
      'placeholder without a source': [[answering({ probe: ['tools/probe-echo.sh', '${host}'] })], /probe names \$\{host\} but the record declares no host/],
      'selector without a source': [[answering({ probe: ['tools/probe-echo.sh', '${selector}'] })], /probe names \$\{selector\} but the record declares no selector/],
      'host with both sources': [[remoteHost({ host: { value: 'a', env: 'B' } })], /host needs exactly one of value or env, not both/],
      'host with neither source': [[remoteHost({ host: {} })], /host needs exactly one of value or env/],
      'escaping requires': [[answering({ requires: ['../secret.env'] })], /requires\[0\] must be root-relative/],
      'unknown kind': [[answering({ kind: 'serial' })], /kind must be one of "local", "ssh", "adb"/],
      'unknown key': [[answering({ shell: true })], /unknown key shell/],
      'long title': [[answering({ title: 'x'.repeat(33) })], /title is longer than 32/],
      'bad id': [[answering({ id: 'Answering Box' })], /id does not match/],
      'shell in a probe argv0': [[answering({ probe: ['tools/probe.sh | tee'] })], /probe\[0\]/],
      'a probe placeholder rEngine does not offer': [[answering({ probe: ['tools/probe-echo.sh', '${file}'] })], /probe\[1\] does not match/],
      'nine devices': [[...Array.from({ length: 9 }, (_, i) => answering({ id: `box-${i}` }))], /devices allows at most 8/],
    };
    for (const [name, [devices, pattern]] of Object.entries(cases)) {
      const result = await declare(directory, name.replaceAll(' ', '-'), devicesDeclaration(devices));
      assert.match(result.devicesError ?? '', pattern, name);
      assert.equal(result.devices, undefined, name);
    }
    const badGame = await declare(directory, 'bad-game-ref', {
      ...devicesDeclaration([answering()]), games: [{ ...localGame(), device: 'no-such-box' }],
    });
    assert.match(badGame.gamesError, /references undeclared device id "no-such-box"; this declaration offers local, answering-box/);
    const badAction = await declare(directory, 'bad-action-ref', {
      ...devicesDeclaration([answering()]),
      dashboard: { title: 'Board', groups: [{ id: 'g', title: 'G', actions: [{ id: 'a', title: 'A', kind: 'script', script: 'tools/x.sh', device: 'no-such-box' }] }] },
    });
    assert.match(badAction.dashboardError, /references undeclared device id "no-such-box"; this declaration offers local, answering-box/);
    const localOk = await declare(directory, 'implicit-local-ref', {
      ...devicesDeclaration([answering()]), games: [{ ...localGame(), device: 'local' }],
    });
    assert.equal(localOk.gamesError, undefined, 'the implicit local device may be named without being declared');
    /* A cooperative game (spec 078, F77) streams into a local pane over loopback exactly as an
       embedded one does, so it is bound to the local device by the same rule and the same message. */
    for (const surface of ['embedded', 'cooperative']) {
      const remote = await declare(directory, `${surface}-remote`, {
        ...devicesDeclaration([answering()]), games: [{ ...remoteGame(), surface }],
      });
      assert.match(remote.gamesError, new RegExp(`"${surface}" needs the local device; "answering-box" is a ssh device`), surface);
      assert.equal(remote.games, undefined, surface);
    }
    const localSurface = await declare(directory, 'cooperative-local', {
      ...devicesDeclaration([answering()]), games: [{ ...localGame(), surface: 'cooperative', device: 'local' }],
    });
    assert.equal(localSurface.gamesError, undefined, 'a cooperative game on the local device is accepted');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('probes answer under the declared-command boundary: exit 0, a named failure, a group-killed timeout and an unset selector', async () => {
  const directory = await scratch('device-probe');
  try {
    forgetProbes();
    const project = await deviceProject(directory, 'project', devicesDeclaration([thisMachine(), answering(), silent(), stalling(), headset(), remoteHost()]));
    const root = asRoot('probe-root', project);
    const declared = await readDeclaration(project);
    const of = id => deviceFor(declared, id);

    const local = await deviceStatus(root, of('local'));
    assert.equal(local.reachable, true); assert.deepEqual(local.issues, []);
    assert.ok(Date.parse(local.checkedAt) > 0, 'checkedAt is a timestamp');

    const ok = await deviceStatus(root, of('answering-box'));
    assert.equal(ok.reachable, true); assert.equal(ok.title, 'Answering box');

    const bad = await deviceStatus(root, of('silent-box'));
    assert.equal(bad.reachable, false);
    assert.match(reasons(bad), /^Silent box \(silent-box\) is not reachable: the probe failed \(exit 7\): fixture: the box is not answering\.$/,
      'the first stderr line is the reason, and only the first');
    assert.doesNotMatch(reasons(bad), /second line/);

    /* The backgrounded writer proves the whole process group went, not just the direct child. */
    const started = Date.now();
    const timedOut = await deviceStatus(root, of('stalling-box'));
    assert.equal(timedOut.reachable, false);
    assert.match(reasons(timedOut), /Stalling box \(stalling-box\) is not reachable: the probe timed out after 400 ms/);
    assert.ok(Date.now() - started < 3000, 'the timeout bounded the wait');
    await delay(2500);
    assert.ok(await missing(project, 'probe-survivor.txt'), 'the timeout killed the probe as a process group');

    /* Absent or empty at probe time is an unreachable device naming the variable, never a spawn. */
    delete process.env[SERIAL];
    const unset = await deviceStatus(root, of('headset'));
    assert.equal(unset.reachable, false);
    assert.match(reasons(unset), new RegExp(`Fixture headset \\(headset\\) is not reachable: ${SERIAL} is not set in the workspace environment\\.`));
    assert.ok(await missing(project, 'probe-argv.txt'), 'nothing was spawned for an unresolved selector');

    process.env[SERIAL] = '';
    forgetProbes();
    const empty = await deviceStatus(root, of('headset'));
    assert.equal(empty.reachable, false);
    assert.match(reasons(empty), new RegExp(`${SERIAL} is empty in the workspace environment`));
    assert.ok(await missing(project, 'probe-argv.txt'), 'an empty selector is not spawned with an empty argument either');

    /* A declared selector reaches the probe argv rather than being left to ambient state. */
    process.env[SERIAL] = '1WMHH815K9000X';
    process.env[HOST] = 'fixture-host';
    forgetProbes();
    assert.equal((await deviceStatus(root, of('headset'))).reachable, true);
    assert.equal((await deviceStatus(root, of('remote-box'))).reachable, true);
    const argv = await readFile(path.join(project, 'probe-argv.txt'), 'utf8');
    assert.match(argv, /^-s 1WMHH815K9000X get-state$/m, 'the selector was substituted for ${selector}');
    assert.match(argv, /^fixture-host true$/m, 'the host was substituted for ${host}');
  } finally { delete process.env[SERIAL]; delete process.env[HOST]; await rm(directory, { recursive: true, force: true }); }
});

test('a device requires/tools gate short-circuits before the probe, and names which', async () => {
  const directory = await scratch('device-gate');
  try {
    forgetProbes();
    const project = await deviceProject(directory, 'project', devicesDeclaration([gated()]));
    const root = asRoot('gate-root', project);
    const device = deviceFor(await readDeclaration(project), 'gated-box');

    const blocked = await deviceStatus(root, device);
    assert.equal(blocked.reachable, false);
    assert.match(reasons(blocked), /Gated box \(gated-box\) needs config\/host\.env, which is missing here\./);
    assert.match(reasons(blocked), /Gated box \(gated-box\) needs definitely-missing-tool-9f on this machine's PATH\./);
    assert.ok(await missing(project, 'probe-count.txt'), 'no point probing an ssh device whose prerequisites are absent');

    await writeFile(path.join(project, 'config/host.env'), 'HOST=x\n');
    forgetProbes();
    const stillBlocked = await deviceStatus(root, device);
    assert.equal(stillBlocked.reachable, false);
    assert.equal(stillBlocked.issues.length, 1, 'only the failing half is named once the file exists');
    assert.match(reasons(stillBlocked), /definitely-missing-tool-9f/);
    assert.ok(await missing(project, 'probe-count.txt'), 'the tools gate still short-circuits the probe');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('probe results are cached for the TTL, coalesced while in flight, and bypassed by an explicit refresh', async () => {
  const directory = await scratch('device-cache');
  try {
    forgetProbes();
    const project = await deviceProject(directory, 'project', devicesDeclaration([counted()]));
    const root = asRoot('cache-root', project);
    const device = deviceFor(await readDeclaration(project), 'counted-box');
    const runs = async () => { try { return (await readFile(path.join(project, 'probe-count.txt'), 'utf8')).length; } catch { return 0; } };

    assert.equal(PROBE_TTL_MS >= 10000 && PROBE_TTL_MS <= 30000, true, 'the chosen TTL stays inside the agreed band');
    const first = await deviceStatus(root, device);
    assert.equal(first.reachable, true); assert.equal(await runs(), 1);
    const second = await deviceStatus(root, device);
    assert.equal(await runs(), 1, 'a second check inside the TTL is served from the cache');
    assert.equal(second.checkedAt, first.checkedAt, 'and reports when it was actually checked');

    /* A TTL alone would not help a dashboard: its actions resolve concurrently, so the first checks
       all start before any result exists. */
    forgetProbes();
    const together = await Promise.all(Array.from({ length: 6 }, () => deviceStatus(root, device)));
    assert.equal(await runs(), 2, 'six concurrent checks coalesced into one probe');
    assert.equal(new Set(together.map(x => x.checkedAt)).size, 1);

    const refreshed = await deviceStatus(root, device, { refresh: true });
    assert.equal(await runs(), 3, 'an explicit refresh bypasses the cache');
    assert.notEqual(refreshed.checkedAt, together[0].checkedAt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a non-local target is never stat-ed locally: the misleading "executable not found" is replaced by the device', async () => {
  const directory = await scratch('device-preflight');
  try {
    forgetProbes();
    const document = { ...devicesDeclaration([answering(), silent()]), games: [localGame(), remoteGame(), remoteGame({ id: 'offline-target', title: 'Offline target', device: 'silent-box' })] };
    const project = await deviceProject(directory, 'project', document);
    const root = asRoot('preflight-root', project);

    /* Unchanged for a local record: the message that is right when the target really is local. */
    const local = await inspectGame(root, 'local-target');
    assert.equal(local.ready, false);
    assert.match(local.issues.join(' '), /Game executable not found; expected build\/never-built/);
    assert.equal(local.device.id, 'local'); assert.equal(local.device.reachable, true);

    /* The rule: build/present-locally EXISTS on this disk. A local stat would resolve it, so an
       unresolved executable proves the stat did not happen rather than merely that it failed. */
    assert.equal(await missing(project, 'build/present-locally'), false, 'the fixture executable is on this disk');
    const remote = await inspectGame(root, 'remote-target');
    assert.equal(remote.executable, null, 'a non-local target is not resolved against the local filesystem');
    assert.deepEqual(remote.candidates, ['build/present-locally']);
    assert.equal(remote.cwd, null);
    assert.equal(remote.device.id, 'answering-box');
    assert.equal(remote.device.reachable, true);
    assert.equal(remote.ready, true, 'a reachable device with no unmet local requires is ready');
    assert.deepEqual(remote.issues, []);
    assert.match(remote.location, /build\/present-locally on Answering box \(answering-box\), not on this machine/);

    const offline = await inspectGame(root, 'offline-target');
    assert.equal(offline.ready, false);
    assert.equal(offline.executable, null);
    assert.doesNotMatch(offline.issues.join(' '), /executable not found/i, 'the misleading message is gone');
    assert.doesNotMatch(offline.issues.join(' '), /expected build/, 'and so is the instruction to build it here');
    assert.match(offline.issues.join(' '), /Silent box \(silent-box\) is not reachable: the probe failed \(exit 7\): fixture: the box is not answering\./);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('availability composes the device with the target’s own requires, which stay local on a remote device', async () => {
  const directory = await scratch('device-compose');
  try {
    forgetProbes();
    const document = {
      ...devicesDeclaration([answering(), silent()]),
      games: [remoteGame({ requires: ['data/pushed.tar'] }), remoteGame({ id: 'both-wrong', title: 'Both wrong', device: 'silent-box', requires: ['data/pushed.tar'] })],
    };
    const project = await deviceProject(directory, 'project', document);
    const root = asRoot('compose-root', project);

    const half = await inspectGame(root, 'remote-target');
    assert.equal(half.ready, false);
    assert.equal(half.device.reachable, true, 'the device answered');
    assert.deepEqual(half.issues, ['Required file is missing: data/pushed.tar.'], 'a device requires stays LOCAL even when the device is remote');

    const both = await inspectGame(root, 'both-wrong');
    assert.equal(both.issues.length, 2, 'each failing half is named');
    assert.match(both.issues[0], /Silent box \(silent-box\) is not reachable/);
    assert.match(both.issues[1], /Required file is missing: data\/pushed\.tar/);

    await writeFile(path.join(project, 'data/pushed.tar'), 'payload');
    forgetProbes();
    const ready = await inspectGame(root, 'remote-target');
    assert.equal(ready.ready, true); assert.deepEqual(ready.issues, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a dashboard reports device-derived availability and probes each device once, not once per action', async () => {
  const directory = await scratch('device-dashboard');
  try {
    forgetProbes();
    const actions = Array.from({ length: 6 }, (_, i) => ({ id: `probe-me-${i}`, title: `Counted ${i}`, kind: 'script', script: 'tools/probe-ok.sh', device: 'counted-box' }));
    const document = {
      ...devicesDeclaration([counted(), silent()]),
      dashboard: { title: 'Board', groups: [
        { id: 'counted', title: 'Counted', actions },
        { id: 'offline', title: 'Offline', actions: [
          { id: 'offline-action', title: 'Offline action', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
          { id: 'offline-and-missing', title: 'Offline and missing', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box', requires: ['data/absent.bin'] },
          { id: 'here', title: 'Runs here', kind: 'script', script: 'tools/probe-ok.sh' },
        ] },
      ] },
    };
    const project = await deviceProject(directory, 'project', document);
    const root = asRoot('dash-root', project);
    const board = await dashboardActions(root, undefined);
    const all = board.groups.flatMap(group => group.actions), find = id => all.find(action => action.id === id);

    const counts = (await readFile(path.join(project, 'probe-count.txt'), 'utf8')).length;
    assert.equal(counts, 1, 'six actions on one device probed it once');
    assert.equal(all.filter(action => action.available).length, 7, 'the counted six plus the local one');
    assert.equal(find('here').device.id, 'local', 'an action with no device binds to the implicit local one');

    const offline = find('offline-action');
    assert.equal(offline.available, false);
    assert.deepEqual(offline.missing.map(x => x.type), ['device']);
    assert.match(offline.missing[0].name, /Silent box \(silent-box\) is not reachable/);
    assert.equal(offline.device.reachable, false);

    const both = find('offline-and-missing');
    assert.deepEqual(both.missing.map(x => x.type), ['requires', 'device'], 'both halves are reported, each named');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the devices listing offers the implicit local device and the targets bound to each', async () => {
  const directory = await scratch('device-listing');
  try {
    forgetProbes();
    const document = {
      ...devicesDeclaration([answering(), silent()]),
      games: [localGame(), remoteGame()],
      dashboard: { title: 'Board', groups: [{ id: 'g', title: 'G', actions: [
        { id: 'on-silent', title: 'On silent', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
        { id: 'on-local', title: 'On local', kind: 'script', script: 'tools/probe-ok.sh' },
      ] }] },
    };
    const project = await deviceProject(directory, 'project', document);
    const root = asRoot('list-root', project);
    const listing = await projectDevices(root, await readDeclaration(project));
    const of = id => listing.devices.find(device => device.id === id);

    assert.equal(listing.contract, 4);
    assert.deepEqual(listing.devices.map(x => x.id), ['local', 'answering-box', 'silent-box']);
    assert.equal(of('local').declared, false, 'the implicit local device is listed without being declared');
    assert.equal(of('local').reachable, true); assert.equal(of('local').probed, false);
    assert.deepEqual(of('local').games, ['local-target']);
    assert.deepEqual(of('local').actions, ['on-local']);
    assert.deepEqual(of('answering-box').games, ['remote-target']);
    assert.deepEqual(of('silent-box').actions, ['on-silent']);
    assert.equal(of('silent-box').reachable, false);
    assert.equal(of('silent-box').issues.length, 1, 'an unreachable device carries one reason, not one per bound action');
    assert.equal(of('answering-box').probed, true);

    const declaredLocal = await deviceProject(directory, 'titled', { ...devicesDeclaration([thisMachine({ title: 'The MacBook' })]) });
    const titled = await projectDevices(asRoot('titled-root', declaredLocal), await readDeclaration(declaredLocal));
    assert.equal(titled.devices[0].title, 'The MacBook', 'a declared local device supplies its own title');
    assert.equal(titled.devices[0].declared, true);
    assert.equal(declaredDevices(await readDeclaration(declaredLocal)).length, 1, 'and is not duplicated by the implicit one');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('launch_game refuses a non-local device by name and points at the project’s own script action', async () => {
  const directory = await scratch('device-launch');
  try {
    forgetProbes();
    const document = {
      ...devicesDeclaration([answering()]),
      games: [remoteGame(), remoteGame({ id: 'orphan-target', title: 'Orphan target' })],
      dashboard: { title: 'Board', groups: [{ id: 'g', title: 'G', actions: [
        { id: 'fast-start-remote', title: 'Fast start on the box', kind: 'script', script: 'tools/probe-ok.sh', device: 'answering-box' },
      ] }] },
    };
    const project = await deviceProject(directory, 'project', document);
    const config = await inspectGame(asRoot('launch-root', project), 'remote-target');
    assert.equal(config.ready, true, 'the device is reachable, so nothing is wrong with the target');
    assert.match(config.refusal, /Remote target runs on Answering box \(answering-box\), not on this machine, and rEngine does not launch on a remote device\./);
    assert.match(config.refusal, /Use this project's own dashboard script action: fast-start-remote\./,
      'the refusal is derived from the declaration; rEngine names no specific script of its own');

    const local = await inspectGame(asRoot('launch-root', project), 'local-target').catch(() => null);
    assert.equal(local, null, 'the fixture declares no local record here');

    const bare = await deviceProject(directory, 'bare', { ...devicesDeclaration([answering()]), games: [remoteGame()] });
    const noScript = await inspectGame(asRoot('bare-root', bare), 'remote-target');
    assert.match(noScript.refusal, /Declare a dashboard script action bound to that device; the remote launch stays with the project's own script\./);

    const plain = await deviceProject(directory, 'plain', { ...devicesDeclaration([answering()]), games: [localGame()] });
    const localConfig = await inspectGame(asRoot('plain-root', plain), 'local-target');
    assert.equal(localConfig.refusal, undefined, 'a local record is launched, never refused');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/* Spec 082, "Controls on the device". The listing that draws the Devices tab carries the actions
   bound to each device with the availability dashboardActions already computed, so the tab renders
   controls rather than a comma-separated list of ids — and resolving them costs no probe of its
   own, because the statuses above filled the cache they read. */
test('a device listing carries the controls bound to it, with the dashboard’s own availability and no second probe', async () => {
  const directory = await scratch('device-controls');
  try {
    forgetProbes();
    const document = {
      ...devicesDeclaration([counted(), silent(), answering()]),
      games: [localGame(), remoteGame({ device: 'counted-box' })],
      dashboard: { title: 'Board', groups: [
        { id: 'boot', title: 'Boot', actions: [
          /* An action whose whole purpose is to make the silent box usable. */
          { id: 'install-silent', title: 'Install rEngine on the silent box', kind: 'script', script: 'tools/probe-ok.sh', device: 'silent-box' },
          { id: 'on-counted', title: 'On counted', kind: 'script', script: 'tools/probe-ok.sh', device: 'counted-box' },
          { id: 'needs-file', title: 'Needs a local file', kind: 'script', script: 'tools/probe-ok.sh', device: 'counted-box', requires: ['data/absent.bin'] },
          { id: 'here', title: 'Runs here', kind: 'script', script: 'tools/probe-ok.sh' },
        ] },
      ] },
    };
    const project = await deviceProject(directory, 'project', document);
    const root = asRoot('controls-root', project);
    const declared = await readDeclaration(project);
    const preflight = (rootId, gameId) => inspectGame(root, gameId);
    const listing = await projectDevices(root, declared, { resolve: () => dashboardActions(root, preflight), preflight });
    const of = id => listing.devices.find(device => device.id === id);
    const control = (device, id) => of(device).controls.find(item => item.id === id);

    assert.equal((await readFile(path.join(project, 'probe-count.txt'), 'utf8')).length, 1,
      'the listing and every control on it cost one probe of the counted device');

    /* Availability is not recomputed here: every control carries the dashboard's own verdict. */
    const board = await dashboardActions(root, preflight);
    const declaredAction = id => board.groups.flatMap(group => group.actions).find(action => action.id === id);
    for (const [device, id] of [['silent-box', 'install-silent'], ['counted-box', 'on-counted'], ['counted-box', 'needs-file'], ['local', 'here']]) {
      assert.equal(control(device, id).available, declaredAction(id).available, `${id} carries the dashboard's availability`);
      assert.deepEqual(control(device, id).missing, declaredAction(id).missing, `${id} carries the dashboard's reasons`);
      assert.equal(control(device, id).title, declaredAction(id).title);
      assert.equal(control(device, id).kind, declaredAction(id).kind);
    }
    assert.deepEqual(of('counted-box').controls.map(item => item.id), ['on-counted', 'needs-file'],
      'a device carries its own controls in declaration order and no other device’s');
    assert.deepEqual(of('local').controls.map(item => item.id), ['here']);

    /* Bootstrap versus gated: the action that exists to make the silent box usable is gated on that
       box exactly like every other action bound to it, and says so with the device's own reason. */
    assert.equal(control('silent-box', 'install-silent').available, false);
    assert.deepEqual(control('silent-box', 'install-silent').missing.map(item => item.type), ['device']);
    /* An action blocked by its OWN prerequisite names that first, ahead of the device. */
    assert.deepEqual(control('counted-box', 'needs-file').missing.map(item => item.type), ['requires']);

    /* A bound game carries its preflight state, and a reason only when it is the game's own: the
       device's single reason stays on the device row rather than being restated per target. */
    assert.deepEqual(of('local').targets.map(item => item.id), ['local-target']);
    assert.equal(of('local').targets[0].ready, false);
    assert.match(of('local').targets[0].issue, /Game executable not found/);
    assert.equal(of('local').targets[0].remote, false);
    const remote = of('counted-box').targets[0];
    assert.equal(remote.id, 'remote-target');
    assert.equal(remote.remote, true, 'rEngine does not launch on a remote device, so the row never reads ready');
    assert.match(remote.location, /on Counted box \(counted-box\), not on this machine/);

    /* A device with nothing bound says so, in the payload as well as on the row. */
    assert.deepEqual(of('answering-box').controls, []);
    assert.deepEqual(of('answering-box').targets, []);

    /* A caller that asks for no controls still gets the contract-4 listing exactly as before. */
    const plain = await projectDevices(root, declared);
    assert.equal(plain.devices[0].controls, undefined);
    assert.deepEqual(plain.devices.map(item => item.id), listing.devices.map(item => item.id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
