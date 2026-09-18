/* The Plugins page's settings (spec 152 decision 11).
 *
 * A plugin declares the settings it needs; the page renders them, sends what a person typed to the
 * plugin's own `configure`, and never learns a value. What this spec pins is the part that is easy
 * to get wrong and invisible when it is: the value must reach the PLUGIN and nothing else — not the
 * page, not the published state, not a drawn string.
 *
 * The fixture is a plugin written for the test rather than a real one, because core is not allowed
 * to know any plugin's name and neither is its test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from './red-host-fixture.mjs';
import { nativeClient } from './native-client.mjs';

const RE_EXTENSIONS = 10;
const SECRET = 'sk-fixture-4f1c9a2b7e0d';
const REPLACEMENT = 'sk-fixture-replaced-9c3e';

/* Answers `status` from whether its key file is there and writes one on `configure`: the smallest
   thing that is a service. It reports `set` and never the value, which is the contract. */
const SERVICE = `#!/bin/sh
sub="$1"; shift
state=""; key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --state) state="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$sub" in
  status)
    # What it was invoked WITH, so the spec can assert the shape of the invocation itself
    # (spec 152 decision 8): its own state directory, the project root as the working directory,
    # and no inherited environment beyond PATH - HOME is in every ordinary one and must not be here.
    invoked="cwd=$(pwd) home=[$HOME]"
    if [ -f "$state/key" ]; then
      printf '{"ready":true,"config":{"key":{"set":true}},"detail":"Ready. %s"}\\n' "$invoked"
    else
      printf '{"ready":false,"config":{"key":{"set":false}},"detail":"No key yet. %s"}\\n' "$invoked"
    fi ;;
  configure)
    mkdir -p "$state" && printf '%s' "$key" > "$state/key"
    printf '{"ok":true}\\n' ;;
  *) echo "the fixture does not know $sub" >&2; exit 2 ;;
esac
`;

const MANIFEST = {
  name: 'fixture',
  title: 'Fixture',
  description: 'A plugin that exists to be configured.',
  service: {
    command: ['plugins/fixture/service.sh'],
    describe: 'status',
    configure: 'configure',
    config: [{ name: 'key', label: 'API key', kind: 'secret', detail: 'Paste the key here.' }],
  },
};

async function fixtureProject(directory) {
  const project = path.join(directory, 'project');
  await mkdir(path.join(project, 'plugins', 'fixture'), { recursive: true });
  await writeFile(path.join(project, 'plugins', 'fixture', 'plugin.json'), JSON.stringify(MANIFEST, null, 2));
  const service = path.join(project, 'plugins', 'fixture', 'service.sh');
  await writeFile(service, SERVICE);
  await chmod(service, 0o755);
  return project;
}

/* Waiting on something outside the window: the plugin's own state directory, which the page reports
   nothing about once a setting is already present. */
async function until(condition, label) {
  for (let i = 0; i < 160; i++) { if (await condition()) return; await delay(50); }
  throw new Error(`${label} not reached`);
}

const extensionsOf = state => state.tabs.find(t => t?.type === RE_EXTENSIONS)?.extensions?.extensions ?? [];
const drawn = runs => runs.map(r => r.text);

test('a declared setting is typed into the page, reaches the plugin, and is never read back',
     { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-extensions-')));
  const stateDir = path.join(directory, 'state');
  const key = path.join(stateDir, 'plugins', 'fixture', 'key');
  let server, gui;
  try {
    const project = await fixtureProject(directory);
    server = await startServer({ stateDir });
    const root = await server.store.addRoot(project);
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.connected, 'the desktop connects');

    await gui.control('toolbar', 'Plugins');
    let state = await gui.until(s => extensionsOf(s).length === 1, 'the Plugins page lists the fixture');
    let row = extensionsOf(state)[0];
    assert.equal(row.enabled, false, 'a plugin is off until it is switched on');
    assert.deepEqual(row.config.map(f => f.name), ['key'], 'and the page carries what it declared');
    // Off means unasked: the page says nothing about a setting it has not been told about.
    assert.equal(row.config[0].set, undefined);

    await gui.control('extension-toggle', 'fixture');
    state = await gui.until(s => extensionsOf(s)[0]?.enabled && extensionsOf(s)[0]?.config?.[0]?.set === false,
                            'switched on, the plugin reports it has no key');
    assert.equal(extensionsOf(state)[0].ready, false);

    /* How the service was invoked, reported by the service itself (spec 152 decision 8): the project
       root to work in, and nothing ambient. `HOME` is in every ordinary environment, so its absence
       is the observable form of "inherits nothing it was not handed". */
    const detail = extensionsOf(state)[0].detail;
    assert.match(detail, new RegExp(`cwd=${project}(\\s|$)`), `the project root is its working directory: ${detail}`);
    assert.match(detail, /home=\[\]/, `and it inherits no environment: ${detail}`);

    /* The setting is closed until it is opened: there is nothing to prefill a secret with, because
       nothing on this side ever knew one. */
    assert.ok(!state.controls.some(c => c.role === 'extension-setting-field'), 'no field until it is opened');
    await gui.control('extension-setting', 'fixture/key');
    state = await gui.until(s => s.controls.some(c => c.role === 'extension-setting-field' && c.key === 'fixture/key'),
                            'the field opens');
    const save = state.controls.find(c => c.role === 'extension-setting-save');
    assert.equal(save.disabled, true, 'and saving nothing is not offered');

    await gui.control('extension-setting-field', 'fixture/key');
    await gui.command({ op: 'text', text: SECRET });
    state = await gui.until(s => !s.controls.find(c => c.role === 'extension-setting-save')?.disabled,
                            'typing makes the save available');

    /* The mask. `text-runs` is every string the last frame actually drew, so this is the assertion
       that a screenshot — or a spec's own snapshot — cannot carry the key out of the field. */
    const runs = await gui.command({ op: 'text-runs' });
    assert.ok(!drawn(runs).some(text => text.includes(SECRET)), `nothing drawn is the key: ${JSON.stringify(drawn(runs))}`);
    assert.ok(drawn(runs).includes('*'.repeat(SECRET.length)), `the field draws its length: ${JSON.stringify(drawn(runs))}`);

    await gui.control('extension-setting-save', 'fixture/key');
    state = await gui.until(s => extensionsOf(s)[0]?.config?.[0]?.set === true, 'the plugin now reports a key');
    row = extensionsOf(state)[0];
    assert.equal(row.ready, true, 'and says it can work');
    assert.match(row.detail, /^Ready\./);
    assert.ok(!state.controls.some(c => c.role === 'extension-setting-field'), 'the field closes behind the save');

    /* Where it went, and where it did not. The plugin has the value; the page has a yes. */
    assert.equal(await readFile(key, 'utf8'), SECRET);
    assert.ok(!JSON.stringify(state).includes(SECRET), 'and the desktop publishes no part of it');

    /* Replacing one is the gesture that matters for a key already supplied: the button reads
       Replace, the field opens empty again, and the plugin ends up with the new value. */
    await gui.control('extension-setting', 'fixture/key');
    await gui.until(s => s.controls.some(c => c.role === 'extension-setting-field'), 'the field reopens');
    const reopened = await gui.command({ op: 'text-runs' });
    assert.ok(!drawn(reopened).some(text => text.startsWith('*')), 'reopening a secret shows no dots: it is empty');
    await gui.control('extension-setting-field', 'fixture/key');
    await gui.command({ op: 'text', text: REPLACEMENT });
    await gui.control('extension-setting-save', 'fixture/key');
    /* `set` was already true, so the answer cannot be waited for on the page: what changed is inside
       the plugin, and that is where this waits. */
    await until(() => readFile(key, 'utf8').then(text => text === REPLACEMENT), 'the plugin holds the replacement');
    state = await gui.until(s => extensionsOf(s)[0]?.config?.[0]?.set === true, 'and still reports a key');
    assert.ok(!JSON.stringify(state).includes(REPLACEMENT));

    /* Switching it off takes its settings off the page with it, and leaves what the plugin keeps
       exactly where the plugin put it. */
    await gui.control('extension-toggle', 'fixture');
    state = await gui.until(s => extensionsOf(s)[0]?.enabled === false, 'switched off again');
    assert.equal(extensionsOf(state)[0].config[0].set, undefined, 'and stops reporting what it has');
    assert.equal(await readFile(key, 'utf8'), REPLACEMENT);
  } finally {
    if (gui) await gui.close();
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
