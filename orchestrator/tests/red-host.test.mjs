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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocket } from 'ws';
import { startServer } from './red-host-fixture.mjs';
import { PtyHost } from './pty-client.mjs';
import { agentTitle } from './sessions-client.mjs';
import { runtimeDirectory } from './discovery.mjs';
import { fakeCli } from './task-fixtures.mjs';
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
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail(`${what} (not within ${timeout / 1000}s)`);
}

/* A SECOND host on the same state directory. It used to be "the door, in front of the JS backend";
   with the JS host gone it is what a state directory actually has during a host replacement — two
   processes reading one store, one PTY service and one set of pane records (charter D62). The
   assertions below are unchanged, and they mean more here: "both hosts answer the same" was a
   migration check and is now the rule the directory is built on. */
async function front(t, stateDir, _other, env = {}) {
  const child = spawn(BINARY, ['--state', stateDir],
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

/* `/api/state` as the OTHER host on this directory composes it. It used to be a hand-built copy of
   what `main.mjs` composed, because the JS host had no route to ask; now both hosts have the same
   route, and "the two agree" is the rule the directory is built on rather than a migration check. */
const composed = host => host.state();

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

  /* `/api/tracker` is NOT in the list below any more, and the reason is the migration finishing
     rather than an exemption: the backend no longer has the route to compare against. Its credential
     lives beside the workspace state, which is the door's, so F154 moved the whole thing here and
     `server/tracker.mjs` went. What the door answers is compared against the recorded JavaScript by
     `tracker-parity` and `tracker-remote-parity` instead — the same claim, one layer down, and it
     survives the module's deletion where a live comparison could not. */

  /* The descriptor a consumer reads names the door, with a token of its own. */
  const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
  assert.equal(descriptor.url, door.url, 'the descriptor names the front door');
  assert.notEqual(descriptor.token, backend.token, 'with its own token, never the backend\'s');
  assert.match(descriptor.token, /^[0-9a-f]{64}$/);
  const instance = { url: door.url, token: descriptor.token };

  /* The door and the backend AGREE about what a project says. Since F153–F156 both sides run the
     same Rust — the door links `red-project`, the JS host asks the same implementation through its
     client — so this is no longer a proxy's comparison but the migration's own: a route the door
     has taken over answers what the route it replaced answers, on the same project, at the same
     moment. The remaining forwarded routes are the ones that run a project's own commands. */
  const fold = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'checkedAt' ? '<stamp>' : item)));
  for (const route of [`/api/dashboard?rootId=${root.id}`, `/api/formats?rootId=${root.id}`,
    `/api/recordings?rootId=${root.id}`, `/api/devices?rootId=${root.id}`,
    `/api/game-config?rootId=${root.id}`]) {
    const [through, around] = await Promise.all([ask(instance, route), ask(backend, route)]);
    assert.equal(through.status, around.status, `${route} answers the same status`);
    /* `checkedAt` is a wall clock on both sides and the two calls are not the same instant. */
    assert.deepEqual(fold(await through.json()), fold(await around.json()), `${route} answers the same body`);
  }

  /* Routes the door OWNS. The JS host no longer serves these, so the comparison is against the
     implementation it served them from — `store.list`, `store.readText`, and `/api/state`'s own
     composition — which is the same answer one layer down and stays true after the route is gone. */
  assert.deepEqual(await (await ask(instance, `/api/tree?rootId=${root.id}&path=&hidden=false`)).json(),
    await backend.store.list(root.id, '', false), 'the door lists a directory as the store lists it');
  assert.deepEqual(await (await ask(instance, `/api/file?rootId=${root.id}&path=note.txt`)).json(),
    await backend.store.readText(root.id, 'note.txt'), 'and reads a file as the store reads it');
  const opening = await (await ask(instance, '/api/state')).json();
  assert.deepEqual({ ...opening, instance: null, pid: null, stateDir: null },
    { ...await composed(backend), instance: null, pid: null, stateDir: null },
    'and composes /api/state the way the host composed it');
  assert.equal(opening.instance, door.instance, 'the door says who IT is');
  assert.equal(opening.stateDir, stateDir, 'and which directory it serves');

  /* A write, with a body: the framing survives. The version is the one the read answered with,
     because a save that did not carry it is refused by the store, not by the door. */
  const before = await (await ask(instance, `/api/file?rootId=${root.id}&path=note.txt`)).json();
  const saved = await ask(instance, '/api/save', { rootId: root.id, path: 'note.txt', text: 'through the door\n', version: before.version });
  assert.equal(saved.status, 200, 'a POST with a body reaches the backend');
  assert.equal((await backend.store.readText(root.id, 'note.txt')).text, 'through the door\n');

  /* The store's own refusals, with the status a caller acts on, from the route the door answers. */
  const missing = await ask(instance, `/api/file?rootId=no-such-root&path=note.txt`);
  assert.equal(missing.status, 404, 'a root the store does not have is 404 at the door');
  assert.equal((await missing.json()).error, await backend.store.readText('no-such-root', 'note.txt').then(() => null, error => error.message),
    'in the store\'s own words, the same the backend gives');
  const stale = await ask(instance, '/api/save', { rootId: root.id, path: 'note.txt', text: 'x', version: 'not-the-version' });
  assert.equal(stale.status, 409, 'a save against a version that moved is a conflict');

  /* A draft written at the door is a draft the backend sees: one store, two readers. */
  await ask(instance, '/api/draft', { rootId: root.id, path: 'note.txt', text: 'a draft from the door' });
  const withDraft = await backend.store.readText(root.id, 'note.txt');
  assert.equal(withDraft.draft?.text, 'a draft from the door', 'the backend reads what the door wrote');
  /* And the state's draft list says a draft is there without carrying it: the text arrives with the
     file it belongs to, and a state poll that shipped every draft's contents would grow with them. */
  const drafted = await (await ask(instance, '/api/state')).json();
  assert.equal(drafted.drafts.length, 1, 'the door says which file has a draft');
  assert.deepEqual(drafted.drafts, (await composed(backend)).drafts, 'in the same words the host composed');
  assert.equal('text' in drafted.drafts[0], false, 'and not what is in it');

  const discarded = await ask(instance, '/api/discard', { rootId: root.id, path: 'note.txt' });
  assert.equal((await backend.store.readText(root.id, 'note.txt')).draft ?? null, null,
    'and the discard reaches it too');

  /* The body each route answers with is the JS host's, not the store's: `discardDraft` and
     `saveLayout` return nothing at all, and the host turns that into `{ok: true}` because a caller
     checks it. A port that passed the store's answer through would break every one of them. */
  assert.deepEqual(await discarded.json(), { ok: true }, '/api/discard answers {ok: true}');
  const layout = { panes: [{ id: 'a', kind: 'editor' }] };
  const laid = await ask(instance, '/api/layout', { layout });
  assert.deepEqual(await laid.json(), { ok: true }, '/api/layout answers the same');
  const preferred = await ask(instance, '/api/preferences', { vim: true });
  assert.deepEqual(await preferred.json(), await backend.store.preferences({ vim: true }),
    'and /api/preferences answers what the store answers');

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
  /* Started at the BACKEND on purpose: this test uses the JS host as an independent observer of
     the pane, and a host only holds the panes it started or adopted (D60/F179). The door learns of
     it from the service's announcement, which is the thing being checked. */
  const session = await backend.sessions.terminal({ rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] });
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
  const doorState = await (await ask(instance, '/api/state')).json();
  assert.equal(doorState.sessions.length, 1, 'the door lists the pane');
  assert.deepEqual(doorState.sessions, (await composed(backend)).sessions, 'exactly as the host that started it lists it');

  /* `/surface` is still the backend's, and this is what proves the splice is alive now that
     `/events` is not using it: the door performs no handshake of its own for this path, so an
     upgrade that completes was completed by the host behind it — and the backend's own words for a
     game that is not there come back on it. A door that served this path itself would greet the
     socket with `hello` instead. */
  const surface = new WebSocket(`${instance.url.replace('http', 'ws')}/surface?id=no-such-game&token=${instance.token}`);
  const said = await Promise.race([
    new Promise(resolve => {
      const frames = [];
      surface.on('message', bytes => frames.push(bytes.toString()));
      surface.once('close', (code, reason) => resolve({ code, reason: reason.toString(), frames }));
      surface.once('error', error => resolve({ error: error.message }));
    }),
    /* Bounded, because the failure this is written against is a door that ANSWERS this path and
       holds the socket open: without a bound that failure is a test that hangs rather than one
       that says what went wrong. */
    delay(10000).then(() => ({ held: 'the socket was still open after 10s' })),
  ]);
  t.after(() => surface.close());
  assert.equal(said.code, 1008, `the backend closed it in its own words: ${JSON.stringify(said)}`);
  assert.equal(said.reason, 'Game session is unavailable');
  assert.deepEqual(said.frames, [], 'and nothing greeted it on the way, because this door does not serve that path');

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
  /* The project's own routes are the door's too (F156): what a project declares and what it left
     behind are read from the root, not from the host that is gone. */
  assert.equal((await ask(instance, `/api/formats?rootId=${root.id}`)).status, 200,
    'and so is what the project declares');
  assert.equal((await (await ask(instance, `/api/recordings?rootId=${root.id}`)).json()).path, '.cache/recordings',
    'and what it left behind');
  /* F153, F155 and F156 moved the rest of the project's own questions into the door, so a workspace
     with no backend still answers what a person's Devices tab, dashboard, game chooser, Tasks tab and
     file viewer ask about the project in front of them. */
  for (const [route, what, extra = ''] of [
    ['dashboard', 'which of its actions may be pressed'],
    ['devices', 'which of the boxes it declares answer'],
    ['game-config', 'what a declared game needs before it can be launched'],
    ['tracker', 'its own task inventory'],
    ['bytes', 'a window of one of its files', '&path=note.txt'],
    /* F190/F192: a root that is not in a repository still ANSWERS — by name, 415 — which is the
       ordinary case for a project root and not a fault. Asserted below rather than here. */
  ]) {
    assert.equal((await ask(instance, `/api/${route}?rootId=${root.id}${extra}`)).status, 200, what);
  }
  /* The two POSTs among them, which name their root IN a JSON document rather than in a query
     string. This fixture declares nothing, so each earns the refusal a project without a declaration
     earns — which is the point: a refusal in the door's own words is an ANSWER, and a route the door
     only forwards has nowhere to send this at all. */
  for (const [route, body, said] of [
    ['format-preview', { rootId: root.id, path: 'note.txt' }, /This project does not declare formats in \.rengine\/project\.json\./],
    ['dashboard-capture', { rootId: root.id, actionId: 'no-such-action' }, /This project does not declare a dashboard in \.rengine\/project\.json\./],
  ]) {
    const answered = await ask(instance, `/api/${route}`, body);
    assert.match((await answered.json()).error, said, `${route} is refused by the door, not forwarded`);
  }
  /* The worktree survey (F190, spec 134). This fixture is a scratch directory rather than a
     checkout, so the door answers the refusal a project outside a repository earns — which is the
     point: it ANSWERS, from the root, with no backend behind it. */
  const surveyed = await ask(instance, `/api/worktrees?rootId=${root.id}`);
  assert.equal(surveyed.status, 415, 'the worktree survey is the door\'s too');
  assert.equal((await surveyed.json()).error, 'This project is not in a git repository.');

  assert.equal((await alone.json()).text, 'through the door\n', 'from the state directory\'s own store');
  /* Launching a game is the DOOR's now (F155, spec 142) — the last route the JS host uniquely
     served. This project declares no game, so the answer is the preflight's refusal rather than a
     forward with nowhere to go: the door reached `red_project`'s own inspection and said what it
     found. Before this row the same call could not be answered at all. */
  const launched = await ask(instance, '/api/game', { rootId: root.id, gameId: 'any' });
  assert.equal(launched.status, 409, 'the door answers the launch itself');
  assert.match((await launched.json()).error, /game/i, 'with the preflight\'s own words');
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

  /* Started at the backend, because this test asks the JS host what it thinks of the pane — and a
     host holds the panes it started or adopted, not every pane in the directory. */
  const session = await backend.sessions.terminal({ rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] });
  const typed = text => ask(instance, '/api/input', { id: session.id, data: text });
  const printed = async what => {
    for (let waited = 0; waited < 15000; waited += 50) {
      if (backend.sessions.snapshot(session.id, true).output?.includes(what)) return true;
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
  /* The OTHER host is asked over its own port, which is the point: it learned the gate from a record
     a third process wrote, and it applies that record rather than forwarding the question. */
  const refusedBehind = () => waiting(backend);
  await until(async () => (await waiting(instance))[0] === 409, 'the door sees the gate');
  assert.deepEqual(await waiting(instance), [409, 'Handoff is waiting for its native view.'],
    'the door refuses input for a pane it was never told about directly');
  assert.deepEqual(await refusedBehind(), [409, 'Handoff is waiting for its native view.'],
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
  /* The door over HTTP, the JS host through its own Sessions: the route it served this from is gone,
     and the implementation behind that route is what the door is measured against. */
  const seen = async where => where === backend
    ? JSON.parse(JSON.stringify(backend.sessions.snapshot(session.id, true)))
    : (await ask(where, `/api/session?id=${session.id}`)).json();
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
  /* The ledger service, started before the door so the door can ATTACH to it: `attaching` never
     starts one, which is deliberate — two owners of one set of files is what D60/D61 prevent. In
     production the layer above starts it; here this is that layer. */
  const { Tokens } = await import('./token-client.mjs');
  const tokens = await Tokens.open(stateDir, { alive: () => true });
  t.after(() => tokens.close());
  /* A short acknowledgement budget, so the spec can watch a desktop fail to answer without
     spending the production four seconds on it. */
  const door = await front(t, stateDir, backend, { RENGINE_DESKTOP_ACTION_MS: '700' });
  const instance = { url: door.url, token: JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')).token };
  /* A door is TOLD where the ledger is, because it is in the worker's directory rather than its own
     and the worker is the process that knows (spec 143). Here this test is that worker. */
  const attached = await ask(instance, '/api/ledger', { directory: stateDir });
  assert.equal(attached.status, 200);
  assert.equal((await attached.json()).attached, true, 'the door attached to the ledger it was told about');
  const again = await ask(instance, '/api/ledger', { directory: stateDir });
  assert.equal((await again.json()).attached, false, 'and a second telling is not a second reader');

  /* Started at the backend: both hosts are given the same registration frame below, and the JS
     host can only judge a binding for a pane it holds. */
  const session = await backend.sessions.terminal({ rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] });

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
  const ours = desktop(instance);
  await ours.open;
  ours.socket.send(JSON.stringify(registration));
  await until(() => ours.seen('desktop-registered'), 'the door registered the desktop');
  /* A pane this host never had is NOT an invalid binding: it ended with the host that owned it and
     the desktop's saved layout outlived that process. Refusing the frame would leave the desktop
     unregistered and every desktop action invisible (spec 098). */
  assert.deepEqual(ours.seen('desktop-registered').unknownSessions, ['a-pane-from-a-previous-host']);
  assert.match(ours.seen('desktop-registered').id, /^[0-9a-f-]{36}$/);

  const listed = where => ask(where, `/api/desktops?rootId=${root.id}`).then(answer => answer.json());
  const named = ({ id, ...rest }) => rest;
  const mine = await listed(instance);
  assert.equal(mine.desktops.length, 1, 'the door lists the desktop attached to it');
  assert.deepEqual(named(mine.desktops[0]),
    { rootIds: [root.id], sessionIds: [session.id], canReload: true, canAttach: true, owner: 'alex', view: 'workspace' },
    'and describes it in the shape a caller reads');
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

  /* --- the registry's other two routes (spec 143) -------------------------------------------- */
  /* Settled here rather than in the worker: a desktop says it exists on the door's socket, so the
     door is the only process that can answer a question about it. The JS worker held a SECOND
     registry over its own socket for exactly these two routes; this is that registry, asked the
     same questions, and the JS `Desktops` is still the record of what the answers are. */

  /* Every desktop on the workspace, whatever root it is bound to — the question a launcher asks
     while it is waiting for a window it just started and has no root to filter by. */
  const runtime = await ask(instance, '/api/runtime-desktops').then(answer => answer.json());
  /* One, not two: the bystander has a socket on this door and never said it was a desktop, and a
     registry of sockets would have counted it. */
  assert.equal(runtime.desktops.length, 1, 'the desktop that registered, and only that one');
  assert.equal(runtime.desktops[0].id, desktopId);
  assert.equal(runtime.registerError, null, 'nothing has been refused');
  /* The socket itself never travels: a caller reads a desktop, not a connection. */
  assert.ok(runtime.desktops.every(entry => !('socket' in entry)));

  /* A refusal is REMEMBERED, so a launcher whose window never appeared is told why rather than only
     that it did not (spec 098). */
  const wrong = desktop(instance);
  await wrong.open;
  wrong.socket.send(JSON.stringify({ type: 'desktop-register', rootIds: 'not-an-array', sessionIds: [] }));
  await until(() => wrong.seen('error'), 'the door refused the frame');
  const refused = await ask(instance, '/api/runtime-desktops').then(answer => answer.json());
  assert.equal(refused.registerError.message, 'Invalid desktop bindings.');
  assert.ok(Number.isInteger(refused.registerError.at), 'and when');
  /* And cleared by the next one that succeeds, because a stale reason is worse than none. */
  wrong.socket.send(JSON.stringify({ ...registration, sessionIds: [] }));
  await until(async () => (await ask(instance, '/api/runtime-desktops').then(answer => answer.json())).registerError === null,
    'a registration that succeeded cleared the reason the last one failed');
  wrong.socket.close();
  await until(async () => (await ask(instance, '/api/runtime-desktops').then(answer => answer.json())).desktops.length === 1,
    'and the socket that closed took its desktop with it');

  /* Showing a retained pane in a desktop's own tab. What travels is the pane RECORD, because a
     desktop that was told only an id would have to ask for it back, and the one thing it must not
     do between being asked and answering is make another round trip. */
  const view = ask(instance, '/api/session-view', { rootId: root.id, desktopId, id: session.id });
  await until(() => ours.frames.find(frame => frame.type === 'desktop-action' && frame.action === 'attach-session'),
    'the desktop was asked to show the pane');
  const attach = ours.frames.find(frame => frame.type === 'desktop-action' && frame.action === 'attach-session');
  assert.ok(attach.session, 'the frame carries the pane record, not the id alone');
  assert.equal(attach.session.id, session.id);
  assert.equal(attach.session.rootId, root.id);
  assert.equal(attach.session.state, 'running');
  ours.socket.send(JSON.stringify({ type: 'desktop-action-result', requestId: attach.requestId, accepted: true }));
  const shown = await view;
  assert.equal(shown.status, 200);
  const view_answer = await shown.json();
  assert.equal(view_answer.status, 'accepted');
  assert.equal(view_answer.detail, 'Retained session attached to a native tab.',
    'the JS sentence, because a caller reads it and decides whether to retry');

  /* A desktop bound to one project is never handed another's pane, and the PANE's own record says
     which project it is — never the caller's claim about it. */
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'red-host-other-root-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const other = await backend.store.addRoot(elsewhere);
  const stranger = await backend.sessions.terminal({ rootId: other.id, command: '/bin/bash', args: ['--noprofile', '--norc'] });
  const crossed = await ask(instance, '/api/session-view', { rootId: root.id, desktopId, id: stranger.id });
  assert.equal(crossed.status, 403);
  assert.equal((await crossed.json()).error, 'Session belongs to another root.');
  const missing = await ask(instance, '/api/session-view', { rootId: root.id, desktopId, id: 'no-such-pane' });
  assert.equal(missing.status, 404, 'a pane nobody has is not a pane this desktop can show');

  /* --- the desktop's view of the project token (spec 095, spec 143) --------------------------- */
  /* The registry is the door's, so the pinned status-bar segment is the door's too: it is pushed
     over the socket a desktop registered on, which is what lets the segment never poll. With the
     registry here rather than in a worker, a worker being replaced is not something a desktop can
     notice — which is the whole of what spec 095's retirement relay existed to paper over. */
  const segments = () => ours.frames.filter(frame => frame.type === 'token');
  await until(() => segments().length, 'the desktop was pushed its token segment on registration');
  const first = segments().at(-1);
  assert.equal(first.rootId, root.id);
  assert.equal(first.holder, null, 'nobody holds it yet');
  assert.equal(typeof first.windowMs, 'number');

  /* A second desktop, bound to a DIFFERENT project. Everything below is about this root, and none
     of it may reach this one: a status bar showing another project's token is a person about to act
     on a workspace they are not looking at. */
  const otherRoot = await backend.store.addRoot(await mkdtemp(path.join(tmpdir(), 'red-host-unbound-')));
  const unbound = desktop(instance);
  await unbound.open;
  unbound.socket.send(JSON.stringify({ type: 'desktop-register', rootIds: [otherRoot.id], sessionIds: [],
    canReload: false, canAttach: false }));
  await until(() => unbound.seen('desktop-registered'), 'the second desktop registered');
  const theirSegments = () => unbound.frames.filter(frame => frame.type === 'token');
  await until(() => theirSegments().length, 'and was pushed its own project\'s segment');
  assert.ok(theirSegments().every(frame => frame.rootId === otherRoot.id));

  /* An agent takes the token, which the desktop is not told about by asking — the ledger moved, so
     the door pushes. This is the whole reason the segment lives on this socket. */
  const agent = { agentId: '12345678-1234-1234-1234-123456789abc', label: 'an agent' };
  const ledger = await tokens.ledger(root.id);
  await ledger.contest(agent, 'working');
  await until(() => segments().at(-1)?.holder?.agentId === agent.agentId,
    `the desktop was pushed the transition it never asked for: ${JSON.stringify(segments().at(-1))}`);

  /* And the person at the desktop taking it back, over the socket it registered on. A desktop has
     more actions than an agent does, so the ledger judges which; what the DOOR judges is that the
     frame came from a registered desktop bound to the project it names. */
  ours.socket.send(JSON.stringify({ type: 'token-action', rootId: root.id, action: 'revoke' }));
  await until(() => segments().at(-1)?.holder === null, 'the revoke landed and was pushed back');
  assert.equal((await ledger.status(null)).holder, null, 'and it is the ledger that says so');

  /* Nothing about this root ever reached the desktop that is not bound to it. */
  assert.ok(theirSegments().every(frame => frame.rootId === otherRoot.id),
    `another project's segments are not this desktop's: ${JSON.stringify(theirSegments().map(frame => frame.rootId))}`);
  assert.equal(theirSegments().length, 1, 'and it was pushed nothing it did not need');

  /* A project this desktop is not bound to is refused by name. */
  ours.socket.send(JSON.stringify({ type: 'token-action', rootId: otherRoot.id, action: 'revoke' }));
  await until(() => ours.frames.some(frame => frame.type === 'error' && /not bound to this desktop/.test(frame.error)),
    'a project this desktop is not bound to is refused');

  /* A socket that never said it was a desktop is not one, however well-formed its frame. */
  const unregistered = desktop(instance);
  await unregistered.open;
  unregistered.socket.send(JSON.stringify({ type: 'token-action', rootId: root.id, action: 'settle' }));
  await until(() => unregistered.seen('error'), 'an unregistered socket cannot act on the token');
  assert.match(unregistered.seen('error').error, /Register the desktop before sending token actions/);
  unregistered.socket.close();

  /* The recorder lives in the desktop (spec 081), so a capture is announced BY the desktop on the
     same socket — and it is a feed frame, so it is the ledger's. */
  ours.socket.send(JSON.stringify({ type: 'recording', rootId: root.id, event: 'committed',
    recordingId: 'rec-1', kind: 'explicit' }));
  /* Read back through the ledger itself: the feed's ROUTE is the worker's, and what is being
     asserted here is that the door minted the frame at all. */
  const feed = async () => (await (await tokens.ledger(root.id)).feed.after(0)).frames;
  await until(async () => (await feed()).some(frame => frame.type === 'capture.committed'),
    'the capture reached the feed');
  const captured = (await feed()).find(frame => frame.type === 'capture.committed');
  assert.equal(captured.recordingId, 'rec-1');
  assert.equal(captured.kind, 'explicit');
  assert.equal(captured.by.kind, 'desktop', 'attributed to the desktop that recorded it');
  assert.equal(captured.by.desktopId, desktopId);
  ours.socket.send(JSON.stringify({ type: 'recording', rootId: root.id, event: 'exploded' }));
  await until(() => ours.frames.some(frame => frame.type === 'error' && /started or committed/.test(frame.error)),
    'an event nobody records is refused by name');

  /* And a desktop that goes away is gone from the list: the registry is the socket's, so it cannot
     outlive it. */
  ours.socket.close();
  await until(async () => (await listed(instance)).desktops.length === 0, 'the closed desktop left the list');
});

/* F189: what a pane is CALLED, and which conversation it is holding.
 *
 * `/api/agent-conversation` is the pane correcting the workspace: rEngine may have minted a
 * conversation, the person may have picked another from the offered list, and their own `--resume`
 * beats both. It is two writes that must not come apart — the workspace's record of the
 * conversation (the store's, shared since D61) and the pane's record of which one it is running
 * (the service's, shared since D62) — so this checks both, and checks the title against the JS
 * function that composes it rather than against a string typed twice.
 */
test('a pane reports its conversation to the door, and the workspace and the pane agree', { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-conversation-'));
  const stateDir = path.join(directory, 'state');
  const backend = await startServer({ stateDir, retainSessions: true });
  let client;
  t.after(async () => {
    await client?.close();
    await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(directory);
  const door = await front(t, stateDir, backend);
  const instance = { url: door.url, token: JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')).token };

  /* A pane that says it is a claude agent with no conversation yet — which is what a launch that
     offered a choice leaves behind. Written as a RECORD rather than by launching a real CLI: the
     record is what every host answers from, and this route only ever reads and writes that. */
  /* Started at the backend, because the report is read back through it below. */
  const session = await backend.sessions.terminal({ rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc'] });
  client = await PtyHost.attach(stateDir);
  await client.describe(session.id, { type: 'agent', agent: '', titleAuto: true, title: agentTitle('', undefined, root.name) });
  const reported = conversation => ask(instance, '/api/agent-conversation', { id: session.id, agent: 'claude', conversation });

  const CONVERSATION = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
  await until(async () => (await reported(CONVERSATION)).status === 200, 'the door sees the pane as an agent');
  const named = await (await reported(CONVERSATION)).json();
  assert.equal(named.conversation, CONVERSATION, 'the pane holds the conversation it reported');
  assert.equal(named.agent, 'claude', 'and the agent it reported, which it did not have before');
  assert.equal(named.title, agentTitle('claude', CONVERSATION, root.name),
    'with the title the JS host composes for it — the CLI\'s own short form, not eight characters');
  assert.equal('output' in named, false, 'answered as a plain snapshot');

  /* The workspace remembers it too: one report, two records, and the other host reads both. */
  const remembered = await backend.store.listConversations(root.id);
  assert.ok(remembered.some(entry => entry.id === CONVERSATION), `the store remembers it: ${JSON.stringify(remembered)}`);
  await until(async () => backend.sessions.snapshot(session.id).conversation === CONVERSATION,
    'and the JS host reads the same pane');

  /* A conversation is reported MORE THAN ONCE — the workspace names it when it spawns a pane on a
     task, and then the pane itself reports what it actually launched, knowing nothing about tasks.
     An absent task must leave the recorded one alone; only the caller that sends `null` forgets it.
     Sending one for an absent field wiped the task on every pane's own report, which is how this
     was found. */
  await ask(instance, '/api/agent-conversation', { id: session.id, conversation: CONVERSATION, agent: 'claude', task: 'F1' });
  await ask(instance, '/api/agent-conversation', { id: session.id, conversation: CONVERSATION, agent: 'claude' });
  assert.equal((await backend.store.listConversations(root.id)).find(entry => entry.id === CONVERSATION)?.task, 'F1',
    'a second report with no task keeps the task the first one recorded');
  await ask(instance, '/api/agent-conversation', { id: session.id, conversation: CONVERSATION, agent: 'claude', task: null });
  assert.equal((await backend.store.listConversations(root.id)).find(entry => entry.id === CONVERSATION)?.task, undefined,
    'and a report that says null forgets it');

  /* `null` is not "no change": it says this launch continues or forks a conversation the CLI names
     itself, so the record must claim nothing rather than keep an id that would resume the wrong one. */
  const cleared = await (await reported(null)).json();
  assert.equal(cleared.conversation, undefined, 'a null report clears the pane\'s conversation');
  assert.equal(cleared.title, agentTitle('claude', undefined, root.name), 'and the title stops naming one');

  /* The refusals, in the JS host's words. */
  const unknown = await ask(instance, '/api/agent-conversation', { id: 'no-such-pane', conversation: CONVERSATION });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown session.');
  const shell = await backend.sessions.terminal({ rootId: root.id, command: '/bin/bash', args: ['--noprofile', '--norc'] });
  await until(async () => (await ask(instance, '/api/agent-conversation', { id: shell.id, conversation: CONVERSATION })).status === 400,
    'the door sees the shell');
  const notAgent = await ask(instance, '/api/agent-conversation', { id: shell.id, conversation: CONVERSATION });
  assert.equal((await notAgent.json()).error, 'Only an agent session holds a conversation.');
});

/* F189: the route that STARTS a pane.
 *
 * What a pane launches, which conversation it claims and what it is offered are red-agents' (F168),
 * one implementation both hosts call. What this checks is the plumbing the door had to grow around
 * it — the paths, the environment, the record — and it checks it the only way worth checking:
 * the same request to both hosts, and the two panes compared.
 */
test('a pane started at the door is the pane the JS host would have started', { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-spawn-'));
  const project = path.join(directory, 'project');
  await mkdir(project, { recursive: true });
  const stateDir = path.join(directory, 'state');
  const backend = await startServer({ stateDir, retainSessions: true });
  t.after(async () => {
    await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(project);
  /* The door is started carrying another pane's identity and a NO_COLOR its panes must not keep:
     a workspace host is itself often launched from a pane, and KI-068 is the case where a pane
     inherited one and reported as it. */
  const door = await front(t, stateDir, backend, {
    RENGINE_ORCHESTRATOR_SESSION: 'a-pane-that-is-not-this-one',
    RENGINE_AGENT_CONVERSATION: 'somebody-elses-conversation',
    NO_COLOR: '1',
  });
  const instance = { url: door.url, token: JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8')).token };
  /* A CLI that records its arguments and stays running, installed where the workspace looks for it,
     so an agent pane is a real launch and not a download. */
  await fakeCli(stateDir, 'claude');

  /* Started through each host's own front: the door over HTTP, the JS host through the Sessions the
     route used to call. Two panes, composed by the same code, compared. */
  const started = (where, options) => where === backend
    ? backend.sessions.terminal(options).then(pane => JSON.parse(JSON.stringify(pane)))
    : ask(where, '/api/terminal', options).then(answer => answer.json());
  const comparable = ({ id, pid, createdAt, title, conversation, ...rest }) => rest;

  /* A shell, which is what the desktop's Shell button asks for. */
  const [ours, theirs] = [await started(instance, { rootId: root.id }), await started(backend, { rootId: root.id })];
  assert.deepEqual(comparable(ours), comparable(theirs), 'the same pane, described the same way');
  assert.equal(ours.title, `Terminal · ${root.name}`, 'named for its project');
  assert.equal(ours.state, 'running');
  assert.ok(Number.isInteger(ours.pid) && ours.pid !== theirs.pid, 'two panes, two processes');

  /* And the pane is real: it echoes what is typed into it, through the door that started it. */
  await ask(instance, '/api/input', { id: ours.id, data: 'printf "started here\\n"\n' });
  await until(async () => (await (await ask(instance, `/api/session?id=${ours.id}`)).json()).output.includes('started here'),
    'the pane the door started is a live terminal');

  /* An agent pane, where the composition decides what is launched. Both hosts run the same
     red-agents composition, so the argv, the conversation and the title must agree. */
  const mine = await started(instance, { rootId: root.id, type: 'agent', agent: 'claude' });
  /* KI-110: the context the pane's connector routes by, read BEFORE the JS host launches its own —
     both hosts write the same filename, and the door is the writer the live path uses. A context
     without `runtimeDirectory` leaves red-mcp's computed default as the only thing standing, and a
     reader that computed nothing served every pane from this door: eight capabilities short of the
     root-bound worker. The value is the one `ensureRuntime` would start THIS host's supervisor in. */
  const doorContext = JSON.parse(await readFile(path.join(stateDir, 'integrations', `${root.id}.json`), 'utf8'));
  const theirsAgent = await started(backend, { rootId: root.id, type: 'agent', agent: 'claude' });
  assert.deepEqual(comparable(mine), comparable(theirsAgent), 'the same agent pane');
  const theirsContext = JSON.parse(await readFile(path.join(stateDir, 'integrations', `${root.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(doorContext).sort(), Object.keys(theirsContext).sort(),
    'the door mints the shape the JS host mints');
  assert.equal(doorContext.instance, door.instance, 'the door binds a pane to itself, not to the backend');
  assert.equal(doorContext.runtimeDirectory, runtimeDirectory({ ...instance, instance: door.instance }),
    'and names the runtime directory its own supervisor uses');
  assert.equal(theirsContext.runtimeDirectory, runtimeDirectory(backend), 'each host names its own');
  assert.match(mine.title, /^claude [0-9a-f]{8} · /, 'titled with the conversation the composition minted');
  assert.equal(mine.title, agentTitle('claude', mine.conversation, root.name), 'exactly as the JS host titles it');
  assert.notEqual(mine.conversation, theirsAgent.conversation, 'each pane mints its own');
  /* The conversation the composition minted is the workspace's now, not just the pane's. */
  const remembered = (await backend.store.listConversations(root.id)).map(entry => entry.id);
  assert.ok(remembered.includes(mine.conversation), `the store remembers the door's pane too: ${JSON.stringify(remembered)}`);
  /* And the pane's own environment is composed, not inherited: the CLI records what it was given. */
  await until(async () => existsSync(path.join(stateDir, 'claude.argv')), 'the agent CLI was actually launched');

  /* The pane's environment is COMPOSED, not inherited. What this launch owns is cleared whatever
     the host was carrying, the colour defaults are declared, and a NO_COLOR that would contradict
     them is dropped — every one of those is a rule in `shellEnvironment`, and the pane is asked
     rather than the code read. */
  const reported = await started(instance, { rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'echo "S=[${RENGINE_ORCHESTRATOR_SESSION-}] C=[${RENGINE_AGENT_CONVERSATION-}] N=[${NO_COLOR-}] T=[${TERM-}] H=[${RENGINE_AGENT_HOME-}]"'] });
  const said = await until(async () => {
    const text = (await (await ask(instance, `/api/session?id=${reported.id}`)).json()).output ?? '';
    return text.includes('S=[') ? text : null;
  }, 'the pane said what it was given');
  assert.match(said, /S=\[\]/, 'the session identity this launch owns is cleared, not inherited');
  assert.match(said, /C=\[\]/, 'and so is the conversation');
  assert.match(said, /N=\[\]/, 'an inherited NO_COLOR is dropped, because TERM here declares colour');
  assert.match(said, /T=\[xterm-256color\]/, 'which it does');
  assert.ok(said.includes(`H=[${path.join(stateDir, 'agents')}]`), `the agent home is this workspace's: ${said}`);

  /* A restart is the same conversation in a new child: the old pane ends, the new one resumes what
     it was holding. The pane's id changes because the process does. */
  const restarted = await (await ask(instance, '/api/agent-restart', { id: mine.id })).json();
  assert.notEqual(restarted.id, mine.id, 'a new pane');
  assert.equal(restarted.conversation, mine.conversation, 'on the conversation the old one held');
  assert.equal(restarted.agent, 'claude');
  await until(async () => (await (await ask(instance, `/api/session?id=${mine.id}`)).json()).state === 'exited',
    'and the pane it replaced is gone');
  const noConversation = await ask(instance, '/api/agent-restart', { id: ours.id });
  assert.equal(noConversation.status, 400);
  assert.equal((await noConversation.json()).error, 'Only an agent session can be restarted into its conversation.',
    'a shell has no conversation to be restarted into');

  /* The refusals, in the JS host's words and its order: the title is judged before the root is
     looked up, and the working directory before the type. */
  const refused = (options) => ask(instance, '/api/terminal', options).then(async answer => [answer.status, (await answer.json()).error]);
  assert.deepEqual(await refused({ rootId: 'no-such-root' }), [404, 'Unknown project root.']);
  assert.deepEqual(await refused({ rootId: 'no-such-root', title: '   ' }), [400, 'Session title must be a short string.'],
    'the title is judged first, for a root that does not exist either');
  assert.deepEqual(await refused({ rootId: root.id, cwd: directory }), [400, 'The working directory must be inside the project root.']);
  /* Any type this route does not serve is the game adapter's answer, not the composition's: the JS
     route refuses the word before `spawnTerminal` ever sees it, and a game session with no game
     behind it is what that prevents. */
  assert.deepEqual(await refused({ rootId: root.id, type: 'game' }), [400, 'Use the game adapter to launch a game.']);
  assert.deepEqual(await refused({ rootId: root.id, type: 'game-adapter' }), [400, 'Use the game adapter to launch a game.']);
  assert.deepEqual(await refused({ rootId: root.id, cols: 1, rows: 1 }), [400, 'Invalid terminal dimensions.']);
  assert.deepEqual(await refused({ rootId: root.id, handoffFile: '/nowhere.json' }),
    [400, 'Handoff requires a workspace launcher for a CLI that can be handed a conversation.'],
    'a handoff for a CLI that declares no handoff is refused before the file is touched (F216: the refusal is about the capability now, not about being codex)');

  /* One directory, one set of panes, whichever host started them. The door lists what the service
     holds; the JS host lists the same, because it registers a pane the moment the service announces
     one — which is `adopt()` continued past startup and is what stops a host answering
     `Unknown session.` about a pane running in front of the person. */
  const all = (await (await ask(instance, '/api/state')).json()).sessions;
  const listed = all.map(session => session.id);
  assert.deepEqual([...listed].sort(), [ours, theirs, mine, theirsAgent, restarted, reported].map(pane => pane.id).sort(),
    'the door lists every pane in the directory, whichever host started it');
  /* Oldest first — asserted as the property rather than as a fixed sequence, because two panes
     started in the same millisecond are ordered by their ids and a spec that pinned the sequence
     would be pinning which uuid sorted first. */
  assert.deepEqual(all.map(session => session.createdAt), [...all.map(session => session.createdAt)].sort((a, b) => a - b),
    'oldest first');
  await until(async () => {
    const behind = backend.sessions.list().map(session => session.id);
    return [...behind].sort().join() === [...listed].sort().join();
  }, 'and the JS host behind it came to the same list');
});

/* F156. Pressing a dashboard action is the first route the door answers for SOME requests and
 * declines for others: a script or a log action becomes a pane, which the door can spawn, and a
 * GAME action reserves a workspace surface and joins an in-flight launch — session-host state the
 * door has not got.
 *
 * Declining after the body has been read is the hazard, and it is the reason this test exists
 * rather than a parity comparison: the body's bytes are off the socket by then, and a forwarder
 * that framed the request from `content-length` would send a body that is no longer there. So the
 * game half is not "the door refuses" — it is "the backend receives the action it was asked about,
 * whole, and launches it".
 */
test('a dashboard action the door can press is pressed there, and a game reaches the host that owns surfaces',
  { timeout: 300000 }, async t => {
  await built('-p', 'red-host', '--bin', 'red-host');
  const directory = await mkdtemp(path.join(tmpdir(), 'red-host-run-'));
  const stateDir = path.join(directory, 'state');
  const project = path.join(directory, 'project');
  await mkdir(path.join(project, '.rengine'), { recursive: true });
  await writeFile(path.join(project, 'hello.sh'), '#!/bin/bash\necho PRESSED\nsleep 2\n');
  await writeFile(path.join(project, 'play.sh'), '#!/bin/bash\necho PLAYING\nsleep 2\n');
  await run('chmod', ['755', path.join(project, 'hello.sh'), path.join(project, 'play.sh')]);
  await writeFile(path.join(project, '.rengine/project.json'), JSON.stringify({
    contract: 3, project: 'fixture',
    formats: [{ id: 'nothing', title: 'Nothing', match: ['*.nothing'], modes: ['raw'], default: 'raw' }],
    games: [{ id: 'fixture-game', title: 'Fixture game', executable: ['./play.sh'], surface: 'external' }],
    dashboard: { title: 'Fixture', groups: [{ id: 'run', title: 'Run', actions: [
      { id: 'press', title: 'Press me', kind: 'script', script: 'hello.sh', args: ['--fast'] },
      { id: 'play', title: 'Play', kind: 'game', game: 'fixture-game' },
    ] }] },
  }));
  const backend = await startServer({ stateDir, retainSessions: true });
  let stopped = false;
  t.after(async () => {
    if (!stopped) await backend.close({ retain: false });
    await endStateServices(stateDir);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await backend.store.addRoot(project);
  const door = await front(t, stateDir, backend);
  const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
  const instance = { url: door.url, token: descriptor.token };

  const pressed = await (await ask(instance, '/api/dashboard-run', { rootId: root.id, actionId: 'press' })).json();
  assert.equal(pressed.title, 'Script · hello.sh', 'the title the payload composed, not the pane\'s generic one');
  assert.equal(pressed.rootId, root.id);
  await until(() => backend.sessions.snapshot(pressed.id, true).output.includes('PRESSED'),
    'the script the door pressed actually ran');

  /* The game action: pressed BY THE DOOR (F155, spec 142). It used to be declined and forwarded,
     because the surface it reserves was the session host's state; the surfaces are the door's now,
     so the launch is too — and this is the last thing the JS host uniquely did. */
  const launched = await (await ask(instance, '/api/dashboard-run', { rootId: root.id, actionId: 'play' })).json();
  assert.equal(launched.game, 'fixture-game', 'the door launched the declared game');
  await until(() => backend.sessions.snapshot(launched.id, true).output.includes('PLAYING'),
    'and the game it named is the one running');

  /* PIPELINED, which is what makes the body handling observable. The door reads this request's
     body off the socket before it acts, so the socket has to be left positioned exactly at the next
     request — a reader that took one byte too few or too many would frame the request behind it
     from the wrong bytes. Two requests in one write, and both answers have to be right. */
  const pipelined = await new Promise((resolve, reject) => {
    const target = new URL(instance.url);
    const socket = net.connect({ host: target.hostname, port: Number(target.port) }, () => {
      const body = JSON.stringify({ rootId: root.id, actionId: 'play' });
      socket.write(
        `POST /api/dashboard-run HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${instance.token}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        + `GET /health HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${instance.token}\r\n\r\n`);
    });
    let text = '';
    socket.on('data', chunk => { text += chunk; if (text.includes('"protocol"')) { socket.destroy(); resolve(text); } });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); resolve(text); }, 10000).unref();
  });
  assert.match(pipelined, /"game":"fixture-game"/, 'the door read the body and pressed the action it named');
  assert.match(pipelined, /"protocol"/, 'and the request pipelined behind it was still framed correctly');

  /* And with the backend gone, BOTH halves keep answering: a script action and a game action are
     the door's alike now. The JS host has no route left that the door does not own, which is what
     KI-102 was waiting for. */
  await backend.close({ retain: true });
  stopped = true;
  const alone = await (await ask(instance, '/api/dashboard-run', { rootId: root.id, actionId: 'press' })).json();
  assert.equal(alone.title, 'Script · hello.sh', 'a script action is pressed with no backend behind the door');
  const played = await ask(instance, '/api/dashboard-run', { rootId: root.id, actionId: 'play' });
  assert.equal(played.status, 200, 'and so is a game action, with nothing behind the door at all');
  assert.equal((await played.json()).game, 'fixture-game');
});
