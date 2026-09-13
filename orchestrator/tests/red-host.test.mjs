/* F188 (F152a, spec 129, KI-101): red-host is the workspace's front door.
 *
 * `server/main.mjs` is a dispatcher whose routes mostly belong to modules F153–F156 have not
 * moved, so a Rust host that owned the port and answered nothing else would have to reach back
 * into JavaScript for most of a workspace. This is the shape the workspace already runs one layer
 * up — the root-bound worker fronts the session host and forwards `/api/*` to it: red-host owns
 * the port and the door, and forwards what it does not own yet.
 *
 * What has to be true of a front door is that nothing behind it can tell: the same answers, the
 * same statuses, the same refusals, the same bytes on a socket. So this drives BOTH the JS host
 * directly and the same host through red-host, and compares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { PtyHost } from '../server/pty-client.mjs';
import { endStateServices } from './state-services.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const BINARY = path.join(ROOT, 'red/target/debug/red-host');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
/* A record reaches another process on its own schedule: one host writes, the service broadcasts,
   the next host applies. Waiting for that is the honest shape; asserting immediately after a write
   would be asserting that two processes share memory. */
async function until(check, what, timeout = 15000) {
  for (let waited = 0; waited < timeout; waited += 50) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`${what} (not within ${timeout / 1000}s)`);
}

async function front(t, stateDir, backend, env = {}) {
  const child = spawn(BINARY, ['--state', stateDir, '--backend', backend.url, '--backend-token', backend.token],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let noise = '';
  child.stderr.on('data', data => { noise = (noise + data).slice(-2000); });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const line = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('exit', code => reject(new Error(`red-host exited (${code}): ${noise}`)));
  });
  return JSON.parse(line);
}

const ask = (instance, route, body, extra = {}) => fetch(`${instance.url}${route}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('nothing behind the front door can tell it is there', { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  assert.ok(existsSync(BINARY), `red-host was built at ${BINARY}`);
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-'));
  await writeFile(path.join(directory, 'note.txt'), 'first line\nsecond line\n');
  const stateDir = path.join(directory, 'state');
  /* The backend owns the state directory, which since D61 means it ATTACHES to that directory's
     store service rather than starting one of its own — and so does the door. One owner, two
     readers: that is what makes a route safe to move. */
  const backend = await startServer({ stateDir, retainSessions: true });
  let stopped = false;
  /* Ending the services and removing the directory is ONE hook, in that order, for the reason
     headless.test.mjs records: after-hooks run in registration order, and a descriptor that has
     already been deleted names nothing to end. This test retains its sessions at the end — a
     retained PTY service never reaps while it holds one, by design (D60) — so a cleanup that read
     a deleted descriptor would leave a shell running for a directory that is gone. */
  t.after(async () => {
    if (!stopped) await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(directory);
  const door = await front(t, stateDir, backend);

  /* The descriptor a consumer reads names the door, with a token of its own. */
  const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.url, door.url, 'the descriptor names the front door');
  assert.notEqual(descriptor.token, backend.token, 'with its own token, never the backend\'s');
  assert.match(descriptor.token, /^[0-9a-f]{64}$/);
  const instance = { url: door.url, token: descriptor.token };

  /* Reads: the same answers, through the door and around it. `tree` and `file` are answered by the
     door itself now, from the same store the backend is attached to — so this comparison is the
     port's parity check rather than a proxy's. */
  for (const route of [`/api/state`, `/api/tree?rootId=${root.id}&path=&hidden=false`,
    `/api/file?rootId=${root.id}&path=note.txt`, `/api/dashboard?rootId=${root.id}`,
    `/api/formats?rootId=${root.id}`, `/api/recordings?rootId=${root.id}`]) {
    const [through, around] = await Promise.all([ask(instance, route), ask(backend, route)]);
    assert.equal(through.status, around.status, `${route} answers the same status`);
    const [a, b] = await Promise.all([through.json(), around.json()]);
    /* `/api/state` is the door's own answer now, from the store it shares with the backend and the
       panes the service is holding. What it may differ in is exactly this host's identity: its
       instance, its pid, and the state directory it says it serves. */
    if (route === '/api/state') {
      assert.deepEqual({ ...a, instance: null, pid: null, sessions: null }, { ...b, instance: null, pid: null, sessions: null },
        'everything but this host\'s own identity is the same answer');
      assert.equal(a.instance, door.instance, 'the door says who IT is');
      assert.notEqual(a.pid, b.pid, 'and names its own process, which is the one a client is talking to');
      assert.deepEqual(a.sessions, b.sessions, 'with the same panes');
    } else {
      assert.deepEqual(a, b, `${route} answers the same body`);
    }
  }

  /* A write, with a body: the framing survives. The version is the one the read answered with,
     because a save that did not carry it is refused by the store, not by the door. */
  const before = await (await ask(instance, `/api/file?rootId=${root.id}&path=note.txt`)).json();
  const saved = await ask(instance, '/api/save', { rootId: root.id, path: 'note.txt', text: 'through the door\n', version: before.version });
  assert.equal(saved.status, 200, 'a POST with a body reaches the backend');
  assert.equal((await (await ask(backend, `/api/file?rootId=${root.id}&path=note.txt`)).json()).text, 'through the door\n');

  /* The store's own refusals, with the status a caller acts on, from the route the door answers. */
  const missing = await ask(instance, `/api/file?rootId=no-such-root&path=note.txt`);
  assert.equal(missing.status, 404, 'a root the store does not have is 404 at the door');
  assert.equal((await missing.json()).error, (await (await ask(backend, `/api/file?rootId=no-such-root&path=note.txt`)).json()).error,
    'in the store\'s own words, the same the backend gives');
  const stale = await ask(instance, '/api/save', { rootId: root.id, path: 'note.txt', text: 'x', version: 'not-the-version' });
  assert.equal(stale.status, 409, 'a save against a version that moved is a conflict');

  /* A draft written at the door is a draft the backend sees: one store, two readers. */
  await ask(instance, '/api/draft', { rootId: root.id, path: 'note.txt', text: 'a draft from the door' });
  const withDraft = await (await ask(backend, `/api/file?rootId=${root.id}&path=note.txt`)).json();
  assert.equal(withDraft.draft?.text, 'a draft from the door', 'the backend reads what the door wrote');
  /* And the state's draft list says a draft is there without carrying it: the text arrives with the
     file it belongs to, and a state poll that shipped every draft's contents would grow with them. */
  const [drafted, draftedBehind] = await Promise.all([ask(instance, '/api/state'), ask(backend, '/api/state')].map(p => p.then(r => r.json())));
  assert.equal(drafted.drafts.length, 1, 'the door says which file has a draft');
  assert.deepEqual(drafted.drafts, draftedBehind.drafts, 'in the same words the host uses');
  assert.equal('text' in drafted.drafts[0], false, 'and not what is in it');

  const discarded = await ask(instance, '/api/discard', { rootId: root.id, path: 'note.txt' });
  assert.equal((await (await ask(backend, `/api/file?rootId=${root.id}&path=note.txt`)).json()).draft ?? null, null,
    'and the discard reaches it too');

  /* The body each route answers with is the JS host's, not the store's: `discardDraft` and
     `saveLayout` return nothing at all, and the host turns that into `{ok: true}` because a caller
     checks it. A port that passed the store's answer through would break every one of them. */
  assert.deepEqual(await discarded.json(), { ok: true }, '/api/discard answers {ok: true}');
  const layout = { panes: [{ id: 'a', kind: 'editor' }] };
  const [laid, laidBehind] = await Promise.all([ask(instance, '/api/layout', { layout }), ask(backend, '/api/layout', { layout })]);
  assert.deepEqual(await laid.json(), await laidBehind.json(), '/api/layout answers what the backend answers');
  const [preferred, preferredBehind] = await Promise.all([
    ask(instance, '/api/preferences', { vim: true }), ask(backend, '/api/preferences', { vim: true })]);
  assert.deepEqual(await preferred.json(), await preferredBehind.json(), 'and so does /api/preferences');

  /* A refusal is the door's own, in the JS host's words. */
  const anonymous = await fetch(`${instance.url}/api/state`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error, 'Workspace authentication required.');
  const wrongOrigin = await ask(instance, '/api/state', undefined, { origin: 'http://example.com' });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error, 'Origin is not this workspace.');
  const health = await (await fetch(`${instance.url}/health`)).json();
  assert.equal(health.protocol, 1, 'the door answers /health itself');
  assert.equal(health.instance, door.instance, 'with its own instance');

  /* And the socket, which the door serves itself: a session attached through it, with its output
     arriving. `/surface` is still forwarded — it carries a game's frames, and games have not
     moved — so this connection proves the door's own WebSocket, not a splice. */
  const session = await (await ask(instance, '/api/terminal', { rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] })).json();
  const socket = new WebSocket(`${instance.url.replace('http', 'ws')}/events?token=${instance.token}`);
  t.after(() => socket.close());
  const frames = [];
  socket.on('message', bytes => { try { frames.push(JSON.parse(bytes.toString())); } catch { /* not ours */ } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'attach', id: session.id }));
  for (let waited = 0; waited < 15000 && !frames.some(frame => frame.type === 'attached'); waited += 50) await delay(50);
  const attached = frames.find(frame => frame.type === 'attached');
  assert.ok(attached, `the attach was answered on the door's own socket: ${JSON.stringify(frames)}`);
  /* The same pane the route answers, composed once and reached two ways. The scrollback and its
     sequence are deliberately left out of the comparison: the attach frame is a photograph taken
     when the socket asked, and a shell that printed a prompt in between has moved on. */
  const route = await (await ask(instance, `/api/session?id=${session.id}`)).json();
  const stable = ({ output, sequence, ...rest }) => rest;
  assert.deepEqual(stable(attached.session), stable(route),
    'and the attached snapshot is the pane the route answers with');
  assert.ok(route.output.startsWith(attached.session.output),
    'with a scrollback the route can only have added to');
  assert.equal(attached.session.id, session.id);
  assert.ok(frames.some(frame => frame.type === 'hello'), 'and the hello the host sends on connect came back');

  /* The refusals on this socket are the JS host's, and they arrive as messages rather than as
     closed connections: a desktop that sent one bad frame keeps its pane. */
  socket.send(JSON.stringify({ type: 'nonsense' }));
  await until(() => frames.some(frame => frame.type === 'error' && frame.error === 'Unknown session message.'),
    'an unknown message is refused by name');
  socket.send(JSON.stringify({ type: 'presented', id: 'never-attached' }));
  await until(() => frames.some(frame => frame.error === 'Attach the session before presenting it.'),
    'and presenting a pane this socket never attached is refused');

  /* Both directions on one socket: what this client sends reaches the pane, and what the pane
     prints comes back — a proxy that only carried one way would pass every check above. */
  socket.send(JSON.stringify({ type: 'input', id: session.id, data: 'printf "through the socket\\n"\n' }));
  const arrived = frame => frame.type === 'output' && frame.data.includes('through the socket');
  for (let waited = 0; waited < 15000 && !frames.some(arrived); waited += 50) await delay(50);
  assert.ok(frames.some(arrived),
    `what the pane printed came back on the same socket: ${JSON.stringify(frames.map(frame => frame.type))}`);

  /* And `/api/state` with a pane in it: the list is the panes the service is holding, composed the
     way the JS host composes them, which is the whole of what a desktop draws its Sessions tab from. */
  const [doorState, hostState] = await Promise.all([ask(instance, '/api/state'), ask(backend, '/api/state')].map(p => p.then(r => r.json())));
  assert.equal(doorState.sessions.length, 1, 'the door lists the pane');
  assert.deepEqual(doorState.sessions, hostState.sessions, 'exactly as the host lists it');

  /* A socket with the wrong token is refused at the door, before the backend is dialled. */
  const refused = new WebSocket(`${instance.url.replace('http', 'ws')}/events?token=${'f'.repeat(64)}`);
  const outcome = await new Promise(resolve => { refused.once('open', () => resolve('opened')); refused.once('error', () => resolve('refused')); });
  assert.equal(outcome, 'refused', 'a socket without this workspace\'s token never reaches the backend');

  /* Every check above would also pass if the door forwarded the store routes, because the backend
     reads the same store and gives the same answers — which is the point of D61 and also the reason
     a parity test alone cannot show where a route is answered. Taking the backend away shows it: the
     store is the state directory's own service and outlives the host attached to it, so what the
     door OWNS keeps answering and what it FORWARDS has nowhere to go. */
  socket.close();
  await backend.close({ retain: true });
  stopped = true;
  const alone = await ask(instance, `/api/file?rootId=${root.id}&path=note.txt`);
  assert.equal(alone.status, 200, 'a route the door owns is answered with no backend behind it');
  assert.equal((await alone.json()).text, 'through the door\n', 'from the state directory\'s own store');
  await assert.rejects(async () => {
    const forwarded = await ask(instance, `/api/dashboard?rootId=${root.id}`);
    await forwarded.text();
  }, 'while a route it only forwards has nowhere left to go');
});

/* Charter D62. The pane's PROCESS has had one owner since D60; its RECORD — the title, the
 * conversation, the handoff gate and whether it has been released — lived in whichever host
 * spawned it, and the service's `meta` was written once at spawn and never again. Two hosts read
 * one directory now, so a record only one of them can change is a record the other answers from
 * wrongly: a door letting input into a pane that is still waiting for its native view, or refusing
 * one the person is already typing into.
 *
 * So this drives THREE processes at one directory — the JS host, the door, and a plain client
 * standing in for whatever host learns something next — and asks each of them what the pane is.
 */
test('a pane record changed by one host is the record every host answers from', { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-record-'));
  const stateDir = path.join(directory, 'state');
  const backend = await startServer({ stateDir, retainSessions: true });
  let stopped = false, client;
  t.after(async () => {
    await client?.close();
    if (!stopped) await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(directory);
  const door = await front(t, stateDir, backend);
  const instance = { url: door.url, token: JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')).token };

  const session = await (await ask(instance, '/api/terminal', { rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] })).json();
  const typed = text => ask(instance, '/api/input', { id: session.id, data: text });
  const printed = async what => {
    for (let waited = 0; waited < 15000; waited += 50) {
      if ((await (await ask(backend, `/api/session?id=${session.id}`)).json()).output?.includes(what)) return true;
      await delay(50);
    }
    return false;
  };
  assert.equal((await typed('printf "door input\\n"\n')).status, 200, 'the door answers input for a pane it did not spawn');
  assert.ok(await printed('door input'), 'and the keystrokes reached the shell the backend is watching');

  /* A third attached client — the next host, in miniature — puts this pane behind a handoff gate,
     which is a thing only the launching host could know before D62. */
  client = await PtyHost.attach(stateDir);
  await client.describe(session.id, { gate: path.join(directory, 'ready'), released: false });
  const waiting = async instance => {
    const answer = await ask(instance, '/api/input', { id: session.id, data: 'ignored' });
    return [answer.status, (await answer.json()).error];
  };
  await until(async () => (await waiting(instance))[0] === 409, 'the door sees the gate');
  assert.deepEqual(await waiting(instance), [409, 'Handoff is waiting for its native view.'],
    'the door refuses input for a pane it was never told about directly');
  assert.deepEqual(await waiting(backend), [409, 'Handoff is waiting for its native view.'],
    'and so does the host that spawned it, which learned the same way');

  /* And released by the HOST, through its own API, the way the native view releases a handoff pane
     it has presented: `presented` writes the gate file and says so in the record. Both directions
     are load-bearing — this host learned the gate from another process and is now telling every
     process about the release. */
  await backend.sessions.presented(session.id);
  assert.ok(existsSync(path.join(directory, 'ready')), 'the gate file the pane is waiting on was written');
  await until(async () => (await waiting(instance))[0] === 200, 'the door sees the release');
  assert.equal((await typed('printf "after the gate\\n"\n')).status, 200);
  assert.ok(await printed('after the gate'), 'the pane received what was typed after it was released');

  /* The refusals this door owns, in the JS host's own order: `resize` judges the dimensions before
     it looks the session up, `input` names an unknown session first. Swap them and a caller sees a
     different status for the same mistake. */
  const resize = (body) => ask(instance, '/api/resize', body);
  assert.equal((await resize({ id: 'no-such-pane', cols: 1, rows: 1 })).status, 400, 'bad dimensions are refused before the id is looked up');
  assert.equal((await resize({ id: 'no-such-pane', cols: 80, rows: 24 })).status, 404, 'and a good resize for a pane that is not there is 404');
  assert.equal((await resize({ id: session.id, cols: 90, rows: 25 })).status, 200);
  const unknown = await ask(instance, '/api/input', { id: 'no-such-pane', data: 'x' });
  assert.equal(unknown.status, 404, 'input for a pane that is not there names it, rather than judging the data first');
  assert.equal((await unknown.json()).error, 'Unknown session.');

  /* The pane as each of them says it. `/api/session` is the answer a native client reads to draw a
     pane — its title, its dimensions, its scrollback — so the door's version of it and the JS
     host's are compared field by field rather than trusted. */
  const seen = async instance => (await ask(instance, `/api/session?id=${session.id}`)).json();
  await until(async () => (await seen(instance)).sequence === (await seen(backend)).sequence, 'both hosts are level');
  const [ours, theirs] = await Promise.all([seen(instance), seen(backend)]);
  assert.deepEqual(ours, theirs, 'the door answers the pane exactly as the host does');
  assert.match(ours.output, /after the gate/, 'scrollback and all');
  assert.equal(ours.waitingForView, undefined, 'a pane with no handoff says nothing about waiting');
  assert.equal('exitCode' in ours, false, 'and a running pane has no ending to report');
  const missing = await ask(instance, '/api/session?id=no-such-pane');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Unknown session.');

  /* The scrollback is UTF-16 because a pane's history can end mid-character: the limit in spec 060
     counts JS string characters, and a chunk boundary can leave one half of an astral pair in the
     history. A Rust string cannot hold that half, so the door writes the field's JSON itself —
     which this checks by printing an emoji and comparing what comes back on both sides. */
  await ask(instance, '/api/input', { id: session.id, data: 'printf "\\xf0\\x9f\\x94\\xa5 fire\\n"\n' });
  await until(async () => (await seen(backend)).output.includes('\u{1f525} fire'), 'the pane printed it');
  await until(async () => (await seen(instance)).sequence === (await seen(backend)).sequence, 'both hosts are level');
  assert.deepEqual(await seen(instance), await seen(backend), 'a pane that printed an astral character reads the same from both');

  /* A pane this door heard about from nobody. The client spawns it and says nothing else about it:
     no host writes a record, no exit arrives, and the door still has to know it exists — which is
     the service's job, announcing a session the moment there is one. Without that, a second host
     answers `Unknown session.` about a pane that is running in front of the person. */
  const unannounced = await client.spawn({ command: '/bin/bash', args: ['--noprofile', '--norc'], cols: 80, rows: 24 });
  await until(async () => (await ask(instance, '/api/input', { id: unannounced.id, data: '' })).status === 200,
    'the door learned of a pane nothing described to it');
  await ask(instance, '/api/input', { id: unannounced.id, data: 'printf "announced\\n"\n' });
  await until(async () => (await client.snapshot(unannounced.id)).output.includes('announced'),
    'and the door\'s input reached it');
  await client.stop(unannounced.id);

  /* The whole point of answering these at the door: with the backend gone, the pane is still there
     and still typeable, because the session and its record both belong to the directory. */
  await backend.close({ retain: true });
  stopped = true;
  assert.equal((await typed('printf "no backend\\n"\n')).status, 200, 'the door answers input with no host behind it');
  const held = await client.snapshot(session.id);
  assert.match(held.output, /no backend/, 'and the shell received it');
  assert.equal(held.meta.released, true, 'the record is still the one the last host wrote');

  /* And the door ends it, with no host behind it at all: the answer is the pane's ending in the JS
     host's shape — the scrollback is not in it, because `stop` answers a plain snapshot. */
  const ended = await (await ask(instance, '/api/stop', { id: session.id })).json();
  assert.equal(ended.state, 'exited', 'the door stopped the pane');
  assert.equal('output' in ended, false, 'and answered without the history, the way stop does');
  assert.ok(Number.isInteger(ended.endedAt), 'with the ending timed by the service that watched it');
  assert.equal((await client.snapshot(session.id)).state, 'exited', 'the service agrees the child is gone');

  /* A pane that has ended refuses input in the JS host's words, from the state the service keeps. */
  await until(async () => (await waiting(instance))[0] === 409, 'the door sees the exit');
  assert.deepEqual(await waiting(instance), [409, 'Session is not running.']);
});

/* F189: the desktop registry moved with the socket it lives on. A desktop says it exists by sending
 * a frame on `/events`, so whoever serves that socket is the only process that can know about it —
 * and spec 098's reload is the workspace asking a named desktop to rebuild and answer.
 *
 * Both hosts are driven with the same frames here, because "the native desktop connects unchanged"
 * is a claim about shapes, and the JS host is the record of what those shapes are.
 */
test('a desktop registers on the door and answers what the workspace asks it', { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-desktop-'));
  const stateDir = path.join(directory, 'state');
  const backend = await startServer({ stateDir, retainSessions: true });
  t.after(async () => {
    await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(directory);
  /* A short acknowledgement budget, so the spec can watch a desktop fail to answer without
     spending the production four seconds on it. */
  const door = await front(t, stateDir, backend, { RENGINE_DESKTOP_ACTION_MS: '700' });
  const instance = { url: door.url, token: JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')).token };

  const session = await (await ask(instance, '/api/terminal', { rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] })).json();

  /* One desktop on each host, registered with the same frame. */
  const desktop = where => {
    const socket = new WebSocket(`${where.url.replace('http', 'ws')}/events?token=${where.token}`);
    const frames = [];
    socket.on('message', bytes => { try { frames.push(JSON.parse(bytes.toString())); } catch { /* not ours */ } });
    t.after(() => socket.close());
    const seen = kind => frames.find(frame => frame.type === kind);
    return { socket, frames, seen, open: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }) };
  };
  const registration = { type: 'desktop-register', rootIds: [root.id], sessionIds: [session.id, 'a-pane-from-a-previous-host'],
    canReload: true, canAttach: true, owner: 'alex', view: 'workspace' };
  const ours = desktop(instance), theirs = desktop(backend);
  await Promise.all([ours.open, theirs.open]);
  ours.socket.send(JSON.stringify(registration));
  theirs.socket.send(JSON.stringify(registration));
  await until(() => ours.seen('desktop-registered') && theirs.seen('desktop-registered'), 'both hosts registered the desktop');

  /* A pane this host never had is NOT an invalid binding: it ended with the host that owned it and
     the desktop's saved layout outlived that process. Refusing the frame would leave the desktop
     unregistered and every desktop action invisible (spec 098). */
  assert.deepEqual(ours.seen('desktop-registered').unknownSessions, ['a-pane-from-a-previous-host']);
  assert.deepEqual(ours.seen('desktop-registered').unknownSessions, theirs.seen('desktop-registered').unknownSessions);
  assert.match(ours.seen('desktop-registered').id, /^[0-9a-f-]{36}$/);

  const listed = where => ask(where, `/api/desktops?rootId=${root.id}`).then(answer => answer.json());
  const named = ({ id, ...rest }) => rest;
  const [mine, theirsListed] = await Promise.all([listed(instance), listed(backend)]);
  assert.equal(mine.desktops.length, 1, 'the door lists the desktop attached to it');
  assert.deepEqual(named(mine.desktops[0]), named(theirsListed.desktops[0]),
    'and describes it exactly as the JS host describes its own');
  assert.deepEqual(mine.desktops[0].sessionIds, [session.id], 'with the pane that is actually here');
  assert.equal(mine.desktops[0].owner, 'alex');
  const unknownRoot = await ask(instance, '/api/desktops?rootId=no-such-root');
  assert.equal(unknownRoot.status, 404, 'a root the store does not have is 404 here too');

  /* The reload: the workspace asks, the desktop answers, and the caller is told that accepted is
     not the same as done. */
  const desktopId = mine.desktops[0].id;
  const asked = ask(instance, '/api/desktop-action', { rootId: root.id, desktopId, action: 'reload' });
  await until(() => ours.seen('desktop-action'), 'the desktop was asked to reload');
  const request = ours.seen('desktop-action');
  assert.equal(request.action, 'reload');
  assert.equal(request.desktopId, desktopId);

  /* While that one is outstanding, a second is refused rather than queued. */
  const second = await ask(instance, '/api/desktop-action', { rootId: root.id, desktopId, action: 'reload' });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'A desktop action is already pending.');

  /* And nobody else may answer for it. A second socket on this door knows the request id — it was
     never a secret — and is still not the desktop that was asked. */
  const bystander = desktop(instance);
  await bystander.open;
  bystander.socket.send(JSON.stringify({ type: 'desktop-action-result', requestId: request.requestId, accepted: true }));
  await until(() => bystander.seen('error'), 'a socket that was not asked cannot answer');
  assert.equal(bystander.seen('error').error, 'Unknown desktop action acknowledgement.');

  ours.socket.send(JSON.stringify({ type: 'desktop-action-result', requestId: request.requestId, accepted: true }));
  const accepted = await asked;
  assert.equal(accepted.status, 200);
  const answer = await accepted.json();
  assert.equal(answer.status, 'accepted');
  assert.equal(answer.desktopId, desktopId);
  assert.match(answer.detail, /accepted does not mean the build succeeded/);

  /* A desktop that says nothing is not a desktop that agreed. */
  const ignored = await ask(instance, '/api/desktop-action', { rootId: root.id, desktopId, action: 'reload' });
  assert.equal((await ignored.json()).error, 'Desktop did not acknowledge the action.');
  const unknownAction = await ask(instance, '/api/desktop-action', { rootId: root.id, desktopId, action: 'explode' });
  assert.equal(unknownAction.status, 400);
  assert.equal((await unknownAction.json()).error, 'Unknown desktop action.');

  /* And a desktop that goes away is gone from the list: the registry is the socket's, so it cannot
     outlive it. */
  ours.socket.close();
  await until(async () => (await listed(instance)).desktops.length === 0, 'the closed desktop left the list');
});
