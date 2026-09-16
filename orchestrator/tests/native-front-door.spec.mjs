/* F189 (F152b, spec 129): the native desktop connects to red-host unchanged.
 *
 * Every other spec in this suite points the desktop at the JS host. This one points it at the Rust
 * door, with the JS host behind it as the backend for the routes that have not moved, and drives
 * the same things a person does: open the tree, open a file, edit it, save it, type in a pane and
 * read what came back.
 *
 * Nothing in `editor/` changes for this. That is the claim — the desktop cannot tell —
 * and the way to check a claim like that is to run the real binary against the new host rather than
 * to compare route handlers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from './red-host-fixture.mjs';
import { nativeClient } from './native-client.mjs';
import { built } from './cargo.mjs';
import { endStateServices } from './state-services.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BINARY = path.join(ROOT, 'red/target/debug/red-host');

test('the native desktop connects to red-host unchanged', { timeout: 120000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-front-door-'));
  const project = path.join(dir, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'example.txt'), 'first line\nsecond line\n');
  const stateDir = path.join(dir, 'state');
  /* The backend retains its sessions, which since D61 also means both it and the door attach to
     this directory's one store and one PTY service rather than opening their own. */
  const backend = await startServer({ stateDir, retainSessions: true, frontDoor: false });
  let gui, door;
  try {
    const root = await backend.store.addRoot(project);
    door = spawn(BINARY, ['--state', stateDir, '--backend', backend.url, '--backend-token', backend.token],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let noise = '';
    door.stderr.on('data', chunk => { noise = (noise + chunk).slice(-2000); });
    const announced = JSON.parse(await new Promise((resolve, reject) => {
      let text = '';
      door.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
      door.once('exit', code => reject(new Error(`red-host exited (${code}): ${noise}`)));
    }));
    /* The descriptor is the door's, with the door's token: the desktop is pointed at it exactly as
       it would be pointed at a JS host, and never learns the backend's credential. */
    const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
    assert.equal(descriptor.url, announced.url);
    const workspace = { url: descriptor.url, token: descriptor.token, instance: announced.instance };

    const shell = await backend.sessions.terminal({ rootId: root.id });
    gui = await nativeClient(workspace, { root: root.id, terminal: shell.id });
    let state = await gui.until(s => s.connected && s.tabs.some(x => x?.type === 1 && x.tree) && s.tabs.some(x => x?.session === shell.id && x.text),
      'the tree and the pane, through the door');

    /* The socket, which the door serves itself: what the person types reaches the shell and what
       the shell printed comes back. */
    const pane = state.tabs.findIndex(x => x?.session === shell.id);
    await gui.command({ op: 'motion', x: state.tabs[pane].rect[0] + 30, y: state.tabs[pane].rect[1] + 30 });
    await gui.command({ op: 'button', x: state.tabs[pane].rect[0] + 30, y: state.tabs[pane].rect[1] + 30 });
    await gui.command({ op: 'button', x: state.tabs[pane].rect[0] + 30, y: state.tabs[pane].rect[1] + 30, down: false });
    await gui.command({ op: 'text', text: "printf 'THROUGH_THE_DOOR_%s_世界\\n' PTY" });
    await gui.key('Return');
    await gui.until(s => s.tabs.some(x => x?.session === shell.id && x.text?.includes('THROUGH_THE_DOOR_PTY_世界')),
      'the pane printed what was typed into it');

    /* The store routes, which the door answers itself: the tree lists, the file opens, the edit is
       a draft, and Save writes the working file. */
    await gui.control('tree-entry', 'example.txt', 0);
    state = await gui.until(s => s.tabs.some(x => x?.type === 2 && x.text === 'first line\nsecond line\n'), 'the file opened from the tree');
    await gui.key('A', 0xc0);
    await gui.command({ op: 'text', text: 'edited through the door 世界\n' });
    await gui.until(s => s.tabs.some(x => x?.type === 2 && x.dirty), 'the edit is a draft');
    await gui.key('S', 0xc0);
    await gui.until(s => s.tabs.some(x => x?.type === 2 && !x.dirty), 'Save cleared the draft');
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'edited through the door 世界\n',
      'and the working file on disk is what the person typed');

    /* The Shell button, which is a pane STARTED by the door: the desktop asks, red-host composes the
       launch and the service holds the child, and the new tab prints a prompt. */
    await gui.control('toolbar', 'Shell', -1);
    state = await gui.until(s => s.tabs.some(x => x?.type === 3 && x.session && x.session !== shell.id && x.text?.trim()),
      'a second pane, started through the door');
    const opened = state.tabs.find(x => x?.type === 3 && x.session && x.session !== shell.id);
    await gui.command({ op: 'motion', x: opened.rect[0] + 30, y: opened.rect[1] + 30 });
    await gui.command({ op: 'button', x: opened.rect[0] + 30, y: opened.rect[1] + 30 });
    await gui.command({ op: 'button', x: opened.rect[0] + 30, y: opened.rect[1] + 30, down: false });
    await gui.command({ op: 'text', text: "printf 'OPENED_BY_THE_DOOR\\n'" });
    await gui.key('Return');
    await gui.until(s => s.tabs.some(x => x?.session === opened.session && x.text?.includes('OPENED_BY_THE_DOOR')),
      'and it is a live terminal');

    /* And the desktop registered itself on the door's socket, which is what makes every desktop
       action and the whole runtime layer visible to the workspace (spec 098). */
    const listed = await (await fetch(`${workspace.url}/api/desktops?rootId=${root.id}`,
      { headers: { authorization: `Bearer ${workspace.token}` } })).json();
    assert.equal(listed.desktops.length, 1, `the desktop is registered with the door: ${JSON.stringify(listed)}`);
    assert.deepEqual(listed.desktops[0].rootIds, [root.id]);
    assert.ok(listed.desktops[0].sessionIds.includes(shell.id), 'with the panes it is showing');
    assert.ok(listed.desktops[0].sessionIds.includes(opened.session), 'including the one it opened itself');
  } finally {
    await gui?.close();
    try { door?.kill('SIGKILL'); } catch { /* already gone */ }
    await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(dir, { recursive: true, force: true });
  }
});
