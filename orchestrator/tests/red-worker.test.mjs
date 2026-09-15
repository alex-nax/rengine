/* F158 (spec 129): the worker owns a root's port and hands the rest to the host.
 *
 * The same shape the door has, one layer up — `red-host` owns a state directory's port and forwards
 * what it does not own to the JS backend; this owns a ROOT's worker port and forwards to the host.
 * A pane's MCP reaches the worker when one is alive and the host otherwise (`red-mcp`'s `runtime()`),
 * so the two must answer alike for everything the worker does not own.
 *
 * What is asserted here is the FRONT: that it authenticates, that it refuses a path it has no
 * opinion about rather than proxying it, and that what it forwards arrives whole with the host's
 * credential rather than the client's. The routes themselves land one at a time behind this.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { gameProject } from './game-fixtures.mjs';
import { PRODUCT_NAME } from '../runtime/product.mjs';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-worker');
const HOST_TOKEN = 'b'.repeat(64);

before(() => built('--bins'));

/* A stand-in session host that records what reached it. The worker's job is to pass a request on
   unchanged except for the credential, so what this saw IS the assertion.
 *
 * `answers` scripts it by path: a value, or a function of the parsed body. That is what lets a route
 * the worker COMPOSES be driven — the ladder of refusals a spawn walks down is a ladder of answers
 * from here, and what the worker did with each is the assertion. */
async function host(t, answers = {}) {
  const seen = [], ignore = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!ignore.some(prefix => request.url.startsWith(prefix))) {
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    }
    const route = request.url.split('?')[0];
    const scripted = answers[route];
    const value = typeof scripted === 'function' ? scripted(body ? JSON.parse(body) : null, request.url) : scripted;
    const answer = value ?? { reached: 'the host' };
    response.writeHead(answer.__status ?? 200, { 'Content-Type': 'application/json' });
    const { __status, ...rest } = answer;
    response.end(JSON.stringify(rest));
  });
  /* Held so they can be let go of: an upgraded socket is not a request, and `close()` waits for one
     forever — which is how a tunnel test hangs after it has already passed. */
  const live = new Set();
  server.on('connection', socket => { live.add(socket); socket.once('close', () => live.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = await mkdtemp(path.join(tmpdir(), 'rengine-worker-'));
  t.after(async () => {
    for (const socket of live) socket.destroy();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(state, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, ignore, state, server };
}

/* `--no-ide` by default, and it matters: a published bridge writes a lock into the person's own
   `/ide` menu, so a suite that started one would have a side effect on whoever ran it. The test
   that wants a bridge asks for one, into a directory of its own. */
async function worker(t, upstream, stateDir, options = {}) {
  const child = spawn(BIN, ['--state', stateDir ?? upstream.state, '--host', upstream.url, '--host-token', HOST_TOKEN,
    ...(options.ide ? [] : ['--no-ide'])],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      /* No ledger unless a test asks for one, and by the PRODUCTION means: a worker whose
         `red-token-serve` is missing starts none and says so, which is the condition every
         "this workspace worker does not serve the project token ledger" assertion is about. A
         suite that started a real ledger everywhere would have no way to reach those. */
      ...(options.ledger ? {} : { RENGINE_RED_TOKEN_SERVE: '/nonexistent/red-token-serve' }),
      ...(options.env ?? {}) } });
  let noise = '';
  child.stderr.on('data', bytes => { noise += bytes; });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const line = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('exit', code => reject(new Error(`red-worker exited (${code}): ${noise}`)));
  });
  /* A worker reads the roots and opens the host's stream as it comes up — it inherits the games its
     predecessor left open. That is the WORKER's traffic, not the test's, so the record starts once
     it has been seen: every assertion below about "what reached the host" is about what the test
     caused, and would otherwise be counting a startup. */
  /* Waited out rather than counted: a worker reads the roots more than once on the way up, and a
     helper that cleared after the first would leave the second in the record. */
  for (let quiet = 0, seen = -1; quiet < 200; quiet += 25) {
    if (upstream.seen.length !== seen) { seen = upstream.seen.length; quiet = 0; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  upstream.seen.length = 0;
  /* The worker keeps trying to open the host's session stream, and a stand-in host with no socket
     server refuses each attempt. Those are the WORKER's, whenever they land. */
  upstream.ignore.push('/events');
  return JSON.parse(line);
}

const ask = (started, route, options = {}) => fetch(`${started.url}${route}`, {
  ...options,
  headers: { Authorization: `Bearer ${started.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
});

test('the worker announces itself, authenticates, and answers for its own health', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'it says where it is');
  assert.match(started.token, /^[0-9a-f]{64}$/, 'and mints its own credential');
  assert.notEqual(started.token, HOST_TOKEN, "which is not the host's");

  const healthy = await ask(started, '/health');
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).protocol, 'worker/1');

  /* No token, and the host is never reached: a worker that forwarded an unauthenticated request
     would be a way around the host's own door. */
  const bare = await fetch(`${started.url}/api/state`);
  assert.equal(bare.status, 401);
  const wrong = await ask({ ...started, token: 'c'.repeat(64) }, '/api/state');
  assert.equal(wrong.status, 401);
  assert.deepEqual(upstream.seen, [], 'nothing unauthenticated reached the host');
});

test('a route the worker does not own reaches the host whole, with the host’s credential', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);

  const answered = await ask(started, '/api/state');
  assert.equal((await answered.json()).reached, 'the host', "the host's answer is the client's");
  assert.equal(upstream.seen.at(-1).url, '/api/state');
  /* The client's credential never goes upstream and the host's never comes down. */
  assert.equal(upstream.seen.at(-1).authorization, `Bearer ${HOST_TOKEN}`);
  assert.notEqual(upstream.seen.at(-1).authorization, `Bearer ${started.token}`);

  /* A POST arrives with its body, which is the half a forwarder gets wrong: framing the request
     from the wrong length sends a body that is short, long, or somebody else's. */
  /* A route that is purely the door's, deliberately: a gated one would be asked about first and
     what arrived would be the gate's question, and a PROJECT route the worker answers itself. */
  const body = JSON.stringify({ id: 'pane-1', conversation: 'c', agent: 'claude' });
  await ask(started, '/api/agent-conversation', { method: 'POST', body });
  assert.equal(upstream.seen.at(-1).method, 'POST');
  assert.equal(upstream.seen.at(-1).body, body, 'the body arrived whole');
});

test('a path the worker has no opinion about is refused, not proxied', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);
  for (const route of ['/', '/index.html', '/etc/passwd']) {
    const answered = await ask(started, route);
    assert.equal(answered.status, 404, route);
    assert.equal((await answered.json()).error, 'Unknown workspace endpoint.');
  }
  assert.deepEqual(upstream.seen, [], 'a worker is not a proxy for its host');
});

/* The feed is the one route the worker answers itself, and the reason it exists as a process: one
   writer, one sequence, and a watcher that resumes from a cursor. With no ledger service running it
   says so rather than answering from nothing — and it says it HERE, never by forwarding, because a
   host asked for a feed would answer about a different one. */
test('the feed is the worker\'s own, and says so when it has no ledger to read', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);

  const missing = await ask(started, '/api/feed');
  assert.equal(missing.status, 400, 'a feed is a root\'s feed');
  assert.match((await missing.json()).error, /project root is required/);

  const answered = await ask(started, '/api/feed?rootId=r');
  assert.equal(answered.status, 409);
  assert.match((await answered.json()).error, /does not serve the project token ledger/);
  assert.deepEqual(upstream.seen, [], 'and it never asked the host about a feed of its own');
});

/* The token is the other half of what the worker owns. It is arbitration among cooperating agents,
   never an access boundary — every participant already holds the workspace capability — so what
   these headers decide is whose NAME appears in a refusal and on a feed frame. */
test('the token is the worker\'s own, and an unidentified caller cannot act on it', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);

  const rootless = await ask(started, '/api/token');
  assert.equal(rootless.status, 400, 'a token is a root\'s token');
  assert.match((await rootless.json()).error, /project root is required/);

  /* A worker with NO LEDGER says so whoever is asking — the fault is the workspace's, not the
     caller's — which is the refusal order the JS worker has and `serve::token_refusal` states.
     The rest of that order is unit-tested there, because reaching it needs a live ledger. */
  for (const headers of [{}, { 'X-Rengine-Agent': '12345678-1234-1234-1234-123456789abc' }]) {
    const acted = await ask(started, '/api/token-action',
      { method: 'POST', body: JSON.stringify({ rootId: 'r', action: 'contest' }), headers });
    assert.equal(acted.status, 409);
    assert.match((await acted.json()).error, /does not serve the project token ledger/);
  }

  assert.deepEqual(upstream.seen, [], 'the worker never asked the host about a token of its own');
});

/* The menu is built HERE and the live panes come from the host: this worker knows how to run a CLI
   and ask what it offers; the host knows which roots there are and what is running in them. */
test('the agents menu is the worker\'s, and a root the host does not have is refused', async t => {
  const upstream = await host(t);
  const started = await worker(t, upstream);

  const rootless = await ask(started, '/api/agents-menu');
  assert.equal(rootless.status, 400);
  assert.match((await rootless.json()).error, /project root is required/);

  /* The stand-in host answers `{ reached }` with no roots, so any root is unknown — and the worker
     says which question it could not answer rather than passing the request on. */
  const unknown = await ask(started, '/api/agents-menu?rootId=nope');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown project root.');
  assert.deepEqual(upstream.seen.map(request => request.url), ['/api/state'],
    'it asked the host for the roots and nothing else');
});

/* --- the routes that CHANGE something (spec 103, spec 143) ------------------------------------- */
/* Each of the four below is the same shape: resolve the project, ask the gate, do the work, tell the
 * feed. They are driven against a scripted host because what is being asserted is the COMPOSITION —
 * which questions the worker asks, in which order, and what it does with each answer. The decisions
 * inside them (`spawn`, `scripts`, `tasks`) are unit-tested where they live.
 */
const ROOTS = { '/api/state': { roots: [{ id: 'r', path: ROOT }], capabilities: { taskConversations: 1 } } };
/* A root id the LEDGER will accept: it refuses anything that is not a UUID, so a feed test cannot
   use the one-letter id the forwarding tests use. */
const FEED_ROOT = randomUUID();
const withRoot = (at, extra = {}) => ({ '/api/state': { roots: [{ id: 'r', path: at }], capabilities: { taskConversations: 1 }, ...extra } });

test('updating the workspace is gated here and done there', async t => {
  const upstream = await host(t, ROOTS);
  const started = await worker(t, upstream);

  /* A project the workspace does not have is refused HERE: the gate is about a root, so there is
     nothing to gate and nothing to forward. */
  const unknown = await ask(started, '/api/update-workspace',
    { method: 'POST', body: JSON.stringify({ rootId: 'nope', layers: ['workspace'] }) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown project root.');
  assert.deepEqual(upstream.seen.map(request => request.url), ['/api/state'], 'and never forwarded');

  /* One this workspace does have passes the gate — no ledger is running, so there is nothing to be
     refused BY — and the work is the host's, reached with the host's own credential. */
  const body = JSON.stringify({ rootId: 'r', layers: ['workspace'] });
  const accepted = await ask(started, '/api/update-workspace', { method: 'POST', body });
  assert.equal(accepted.status, 200);
  const forwarded = upstream.seen.at(-1);
  assert.equal(forwarded.url, '/api/update-workspace');
  assert.equal(forwarded.body, body, 'the body the caller sent, whole');
  assert.equal(forwarded.authorization, `Bearer ${HOST_TOKEN}`);
});

/* A spawn is the one route that starts a CLI on somebody's behalf, so the ladder of refusals in
 * front of it is the contract: each one names something the caller can act on, and each one leaves
 * the host with nothing started. */
test('a spawn refuses in order, and nothing is started until every refusal has passed', async t => {
  const upstream = await host(t, {
    '/api/state': { roots: [{ id: 'r', path: ROOT }] },  /* a host with no taskConversations */
  });
  const started = await worker(t, upstream);
  const spawn_ = body => ask(started, '/api/agent-spawn', { method: 'POST', body: JSON.stringify(body) });

  const unknown = await spawn_({ rootId: 'nope', agent: 'claude', taskKey: 'F158' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown project root.');

  /* The host that predates task-driven panes: refused by NAME, with nothing started, because a
     spawn against it starts an agent with no prompt — which looks like a working pane and is not. */
  const old = await spawn_({ rootId: 'r', agent: 'claude', taskKey: 'F158' });
  assert.equal(old.status, 409);
  const sentence = (await old.json()).error;
  assert.match(sentence, /predates task-driven agent panes/);
  assert.ok(sentence.endsWith('Nothing was started.'), sentence);
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/terminal'), [], 'and nothing was');
});

test('a spawn composes the pane a task asked for, and names its conversation only when it may', async t => {
  const rows = { rows: [{ key: 'F158', id: 412, title: 'red-worker', labels: ['O1'], criteria: ['it answers'] }] };
  const asked = [];
  const upstream = await host(t, {
    ...ROOTS,
    '/api/tracker': rows,
    '/api/terminal': body => { asked.push(body); return { id: 'pane-1', rootId: 'r', type: 'agent',
      ...(body.conversation ? { conversation: body.conversation } : {}) }; },
    '/api/agent-conversation': body => { asked.push(body); return { ok: true }; },
  });
  const started = await worker(t, upstream);

  const answered = await ask(started, '/api/agent-spawn',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', agent: 'claude', taskKey: 'F158', model: 'opus', brief: 'task' }) });
  assert.equal(answered.status, 200, JSON.stringify(await answered.clone().json()));
  const result = await answered.json();
  assert.equal(result.taskKey, 'F158');
  assert.equal(result.agent, 'claude');
  assert.equal(result.session.id, 'pane-1');

  const launch = asked[0];
  assert.equal(launch.type, 'agent');
  assert.equal(launch.action, 'launch');
  /* The model flag the recipe declares, then the brief as a positional argument — which is how the
     CLIs that take an initial prompt take one. */
  assert.ok(launch.args.length >= 2, JSON.stringify(launch.args));
  assert.equal(launch.args.at(-1).includes('F158'), true, 'the brief names the task it is about');
  assert.equal(launch.args.at(-1).includes('red-worker'), true, 'and what the row says it is');
  assert.ok(launch.args.slice(0, -1).some(argument => argument.includes('opus')), 'the model the caller chose');

  /* claude accepts being TOLD which conversation to start, so rEngine names one and records it. */
  assert.match(launch.conversation, /^[0-9a-f-]{36}$/);
  assert.equal(result.conversation, launch.conversation);
  const recorded = asked.find(entry => entry.task !== undefined);
  assert.equal(recorded.conversation, launch.conversation, 'and the pane is told which task it holds');
  assert.equal(recorded.task, 'F158');
});

test('a CLI that can only resume a conversation is started unnamed rather than refused', async t => {
  const asked = [];
  const upstream = await host(t, {
    ...ROOTS,
    '/api/tracker': { rows: [{ key: 'F158', id: 412, title: 'red-worker' }] },
    '/api/terminal': body => { asked.push(body); return { id: 'pane-2', rootId: 'r' }; },
  });
  const started = await worker(t, upstream);
  const answered = await ask(started, '/api/agent-spawn',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', agent: 'codex', taskKey: 'F158' }) });
  assert.equal(answered.status, 200, JSON.stringify(await answered.clone().json()));
  assert.equal(asked[0].conversation, undefined, 'codex names its own, so rEngine names none');
  assert.equal((await answered.json()).conversation, null, 'and the answer says so rather than inventing an id');
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/agent-conversation'), [],
    'there is no conversation to record');
});

test('a task nobody has is refused with the words a caller recovers from', async t => {
  const upstream = await host(t, { ...ROOTS, '/api/tracker': { rows: [{ key: 'F158', id: 412 }] } });
  const started = await worker(t, upstream);
  const missing = await ask(started, '/api/agent-spawn',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', agent: 'claude', taskKey: 'F999' }) });
  assert.equal(missing.status, 404);
  const error = (await missing.json()).error;
  assert.match(error, /list_tasks names the keys it has/);
  assert.ok(error.endsWith('Nothing was started.'), error);
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/terminal'), []);

  /* And a CLI name that is not one never reaches a process launch. */
  const bad = await ask(started, '/api/agent-spawn',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', agent: '../escape', taskKey: 'F158' }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Choose an agent CLI to spawn.');
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/terminal'), []);
});

/* A script tab is a first-class workflow surface here, and the thing it runs is named by whoever
 * asked — so the route is the rules, the pane, and the desktop that shows it. */
test('a project script opens as a pane, titled by the file the person named', async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-scripts-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  await writeFile(path.join(at, 'deploy.sh'), '#!/bin/bash\necho deployed\n', { mode: 0o755 });
  const asked = [];
  const upstream = await host(t, {
    ...withRoot(at),
    '/api/terminal': body => { asked.push(body); return { id: 'pane-3', rootId: 'r' }; },
  });
  const started = await worker(t, upstream);

  const opened = await ask(started, '/api/script-open',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: 'deploy.sh', args: ['--dry-run'] }) });
  assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
  const { session } = await opened.json();
  assert.equal(session.title, 'Script · deploy.sh', 'named by the file, because that is what a person recognises');
  assert.match(asked[0].args[0], /deploy\.sh$/);
  assert.deepEqual(asked[0].args.slice(1), ['--dry-run']);
  assert.ok(asked[0].command.endsWith('bash') || asked[0].command.endsWith('bash.exe'), asked[0].command);

  /* A path that leaves the project is refused on the RESOLVED path, and never reaches a pane. */
  const escaping = await ask(started, '/api/script-open',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: '../outside.sh' }) });
  assert.equal(escaping.status, 403);
  assert.equal((await escaping.json()).error, 'Script escapes the bound project.');
  assert.equal(asked.length, 1, 'nothing was started for it');
});

/* Showing the pane is the DOOR's (spec 143): desktops register on its socket. A failure to show is
 * REPORTED rather than retried — the pane is already running and retained, so a caller that tried
 * again would start a second one. */
test('a pane that cannot be shown is reported, never started twice', async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-scripts-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  await writeFile(path.join(at, 'deploy.sh'), '#!/bin/bash\necho deployed\n', { mode: 0o755 });
  const upstream = await host(t, {
    ...withRoot(at),
    '/api/terminal': { id: 'pane-4', rootId: 'r' },
    '/api/session-view': { __status: 404, error: 'Desktop is not attached to this project.' },
  });
  const started = await worker(t, upstream);

  const opened = await ask(started, '/api/script-open',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: 'deploy.sh', desktopId: 'gone' }) });
  assert.equal(opened.status, 200, 'the script RAN; only showing it failed');
  const answer = await opened.json();
  assert.equal(answer.view.status, 'not_attached');
  assert.equal(answer.view.error, 'Desktop is not attached to this project.');
  assert.match(answer.detail, /do not launch it again/);
  const view = upstream.seen.find(request => request.url === '/api/session-view');
  assert.deepEqual(JSON.parse(view.body), { rootId: 'r', desktopId: 'gone', id: 'pane-4' });

  /* And a caller that named no desktop is never asked about one. */
  const alone = await ask(started, '/api/script-open',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: 'deploy.sh' }) });
  assert.equal((await alone.json()).view, undefined);
  assert.equal(upstream.seen.filter(request => request.url === '/api/session-view').length, 1);
});

/* A task write is token-gated and serialised, and the frame is minted AFTER the project's own
 * command returned — a feed that announced a write that then failed would be a feed a reader could
 * not trust. Here the project declares no way to write one, so the refusal is the project's and it
 * arrives with the project's status. */
test('a task write is the project\'s own command, and its refusal is the project\'s', async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-tasks-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  const upstream = await host(t, withRoot(at));
  const started = await worker(t, upstream);

  const written = await ask(started, '/api/task',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', action: 'add', title: 'a row' }) });
  assert.notEqual(written.status, 200);
  assert.match((await written.json()).error, /tracker|task/i, 'the project said why');
  /* The tracker is never read back for a write that did not happen, and no pane was involved. */
  assert.deepEqual(upstream.seen.map(request => request.url.split('?')[0]), ['/api/state']);
});

/* --- the feed socket (spec 095, 101, 103) ------------------------------------------------------ */
/* The one thing nothing else can serve, and the reason this is a process at all: one writer, one
 * sequence, and a watcher that resumes from a cursor.
 *
 * Driven against the REAL ledger service, with the frames minted through the JavaScript client that
 * every other writer in this workspace uses — so what this asserts is that a watcher on the Rust
 * worker's socket sees what the workspace actually wrote, not what a fixture says it did.
 */
test('the feed socket replays from a cursor and then carries what happens next', { timeout: 120000 }, async t => {
  const upstream = await host(t, { '/api/state': { roots: [{ id: FEED_ROOT, path: ROOT }] } });
  const { Tokens } = await import('../runtime/token-client.mjs');
  const tokens = await Tokens.open(upstream.state, { alive: () => true });
  t.after(async () => {
    await tokens.close();
    for (const name of ['token.json']) {
      try {
        const descriptor = JSON.parse(await readFile(path.join(upstream.state, name), 'utf8'));
        if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
      } catch { /* never started, or already gone */ }
    }
  });
  const mint = async (rootId, type, fields) => {
    const ledger = await tokens.ledger(rootId);
    const frame = await ledger.frame(type, { kind: 'workspace' }, fields);
    await ledger.persist();
    return frame;
  };
  /* Three frames on this root, and one on another, before the worker is even started. */
  const before = [];
  for (const key of ['F1', 'F2', 'F3']) before.push(await mint(FEED_ROOT, 'task.added', { key }));
  /* Another project, deliberately AHEAD of this one. A sequence is per-ledger and both start at 1,
     so a stranger's frame carries a number this watcher has already passed — and the watcher's own
     de-duplication drops it whether the fan-out filtered it or not. That is the control masking the
     thing under test (`docs/evidence/blind-regressions-2026-09-06.md`), and it is why this project
     is run up past the one being watched before anything crosses. */
  const other = randomUUID();
  for (let n = 0; n < 12; n += 1) await mint(other, 'task.added', { key: `not-ours-${n}` });

  const started = await worker(t, upstream);
  const watch = (query, collected = []) => {
    const socket = new WebSocket(`${started.url.replace('http', 'ws')}/feed?token=${started.token}&${query}`);
    t.after(() => { try { socket.close(); } catch { /* gone */ } });
    socket.on('message', bytes => { try { collected.push(JSON.parse(bytes.toString())); } catch { /* not ours */ } });
    const ended = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    return { socket, collected, ended, open: once(socket, 'open') };
  };
  const settle = async (check, what) => {
    for (let waited = 0; waited < 10000; waited += 25) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(what);
  };

  /* Everything, from the beginning — and only this project's. */
  const all = watch(`rootId=${FEED_ROOT}`);
  await all.open;
  await settle(() => all.collected.length >= 3, 'the feed replayed what was already written');
  assert.deepEqual(all.collected.map(frame => frame.key), ['F1', 'F2', 'F3']);
  assert.ok(all.collected.every(frame => frame.rootId === FEED_ROOT));

  /* A cursor: everything AFTER the sequence a watcher last read, which is how a monitor that went
     away and came back does not see the same event twice. */
  const resumed = watch(`rootId=${FEED_ROOT}&after=${before[1].sequence}`);
  await resumed.open;
  await settle(() => resumed.collected.length >= 1, 'the feed resumed from the cursor');
  assert.deepEqual(resumed.collected.map(frame => frame.key), ['F3'], 'and nothing it had already read');

  /* And then what happens next, live, to both — the replay and the subscription overlap and a frame
     that arrives both ways is still sent once. */
  await mint(FEED_ROOT, 'task.updated', { key: 'F4' });
  await settle(() => all.collected.length >= 4 && resumed.collected.length >= 2, 'the live frame reached both watchers');
  assert.deepEqual(all.collected.map(frame => frame.key), ['F1', 'F2', 'F3', 'F4']);
  assert.deepEqual(resumed.collected.map(frame => frame.key), ['F3', 'F4']);

  /* Another project's frame reaches neither: a monitor shown one is showing a workspace nobody is
     looking at. */
  await mint(other, 'task.added', { key: 'still-not-ours' });
  await mint(FEED_ROOT, 'task.added', { key: 'F5' });
  await settle(() => all.collected.some(frame => frame.key === 'F5'), 'the next frame on this root arrived');
  /* Asserted HERE, after another project has written, rather than on the replay: the replay is
     per-root at the service and cannot carry a stranger, so a check before this one is a check the
     fan-out's filter could never fail. */
  assert.ok(all.collected.every(frame => frame.rootId === FEED_ROOT),
    `another project's frames are not this watcher's: ${JSON.stringify(all.collected.map(frame => frame.key))}`);
  assert.deepEqual(all.collected.map(frame => frame.key), ['F1', 'F2', 'F3', 'F4', 'F5']);

  /* THE ordering contract, and the only case that can tell the two orders apart: a frame minted in
     the instant between the socket opening and the worker having read the history. The subscription
     is taken FIRST, so that frame is either replayed or delivered live — it cannot be neither. A
     worker that replayed and then subscribed would drop exactly this one, and would look correct in
     every test that waits for the replay to settle before writing anything. */
  const racing = watch(`rootId=${FEED_ROOT}`);
  await racing.open;
  const raced = await mint(FEED_ROOT, 'task.added', { key: 'F6' });
  await settle(() => racing.collected.some(frame => frame.sequence === raced.sequence),
    'a frame minted while the feed was still opening reached the watcher');

  /* A feed is a ROOT's feed, and a watcher that named none is told so in the close rather than
     handed the workspace's. */
  const rootless = watch('');
  const ended = await rootless.ended;
  assert.equal(ended.code, 1011);
  assert.equal(ended.reason, 'A project root is required to read its feed.');

  /* The host is never asked about a feed of its own. */
  assert.deepEqual(upstream.seen.filter(request => request.url.startsWith('/feed')), []);
});

/* `/events` and `/surface` belong to whoever answers the session routes, so a client that reached
 * the worker for a pane's bytes gets the HOST's — carried through byte for byte, never decoded and
 * re-encoded, because a worker that parsed them would be a second opinion about a stream it has no
 * view of. */
test('a socket the host owns is tunnelled, not answered', { timeout: 60000 }, async t => {
  const upstream = await host(t);
  const sockets = new WebSocketServer({ server: upstream.server });
  const said = [];
  sockets.on('connection', (socket, request) => {
    socket.send(JSON.stringify({ type: 'hello', at: request.url }));
    socket.on('message', bytes => { said.push(bytes.toString()); socket.send(JSON.stringify({ type: 'echo', of: bytes.toString() })); });
  });
  const started = await worker(t, upstream);

  for (const route of ['/events', '/surface?id=pane-1']) {
    const socket = new WebSocket(`${started.url.replace('http', 'ws')}${route}${route.includes('?') ? '&' : '?'}token=${started.token}`);
    t.after(() => { try { socket.close(); } catch { /* gone */ } });
    const frames = [];
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    await once(socket, 'open');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(frames[0].type, 'hello', `${route} reached the host`);
    assert.ok(frames[0].at.startsWith(route.split('?')[0]), `${route} arrived as itself: ${frames[0].at}`);

    /* And the client's own bytes reach the host unchanged. */
    socket.send('{"type":"attach","id":"pane-1"}');
    /* Waited for the ANSWER, not for the host to have recorded the question: the two directions are
       independent, and asserting the echo the moment the host saw the send is a race. */
    await settleFor(() => frames.some(frame => frame.type === 'echo'));
    assert.ok(said.includes('{"type":"attach","id":"pane-1"}'), 'the client\'s own bytes arrived unchanged');
    assert.equal(frames.find(frame => frame.type === 'echo').of, '{"type":"attach","id":"pane-1"}');
    socket.close();
  }
});

const settleFor = async (check, timeout = 5000) => {
  for (let waited = 0; waited < timeout; waited += 25) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('the tunnelled bytes never arrived');
};

/* --- what the editor pane and a connected CLI both read (spec 133, spec 102) -------------------- */
/* The three routes over the two children the worker starts: `red-lsp-serve`, which holds the
 * language servers a project declares, and `red-ide serve`, the bridge a CLI connects to. The
 * relationship between them is the point — when a CLI asks the bridge for diagnostics the bridge
 * asks back here, because the editor pane and `getDiagnostics` read ONE store (D3).
 */
test('diagnostics answer a version a poller can skip on, and never one it never held', { timeout: 120000 }, async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-lsp-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  await writeFile(path.join(at, 'main.rs'), 'fn main() {}\n');
  const upstream = await host(t, withRoot(at));
  const started = await worker(t, upstream);

  /* This project declares no language server, so there is nothing to have an opinion — and that is
     an ANSWER rather than a refusal: rEngine runs a server a project declares and never installs
     one, so a machine without it gets a named absence and not a broken pane. */
  const first = await ask(started, `/api/diagnostics?rootId=r&path=main.rs`);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const answer = await first.json();
  assert.deepEqual(answer.items, []);
  assert.equal(typeof answer.version, 'number');
  assert.equal(answer.unchanged, undefined, 'a caller that asked for no version is told the items');

  /* `since` is asked for by PRESENCE, not by value. `Number(null)` is 0 and a version starts at 0,
     so a caller that omitted it was being told nothing had changed since a version it never held —
     which is a pane that never draws its first diagnostic. */
  const skipped = await ask(started, `/api/diagnostics?rootId=r&path=main.rs&since=${answer.version}`);
  assert.deepEqual(await skipped.json(), { version: answer.version, unchanged: true });
  const different = await ask(started, `/api/diagnostics?rootId=r&path=main.rs&since=${answer.version + 1}`);
  assert.equal((await different.json()).unchanged, undefined, 'a version it does not hold is not a skip');

  /* And a project the workspace does not have is refused before any toolchain is started. */
  const unknown = await ask(started, '/api/diagnostics?rootId=nope&path=main.rs');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown project root.');
});

test('the bridge publishes an editor for this worker, and the routes over it deliver a count', { timeout: 120000 }, async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-ide-'));
  const ideDir = path.join(at, 'ide');
  await mkdir(ideDir, { recursive: true });
  t.after(() => rm(at, { recursive: true, force: true }));
  await writeFile(path.join(at, 'main.rs'), 'fn main() {}\n');
  const upstream = await host(t, withRoot(at, { pid: process.pid }));
  const started = await worker(t, upstream, undefined, { ide: true, env: { RENGINE_IDE_DIRECTORY: ideDir } });

  /* Published into a directory of this test's own: the lock is what a CLI reads to find an editor,
     and it names the worker that owns it so a dead one's lock can be swept. */
  const locks = await settleFiles(ideDir);
  assert.equal(locks.length, 1, `one editor published: ${locks.join(', ')}`);
  assert.match(locks[0], /^\d+\.lock$/, 'named by the port a CLI connects to');
  const lock = JSON.parse(await readFile(path.join(ideDir, locks[0]), 'utf8'));
  assert.equal(lock.ideName, PRODUCT_NAME, 'and it is this product, by the one declaration of its name');
  assert.deepEqual(lock.workspaceFolders, [at], 'bound to the project this worker serves');

  /* Nobody is connected, so both routes deliver to nobody — a COUNT, not a refusal. The desktop
     reports a selection on every cursor move, and a refusal there is one a person sees constantly. */
  const selected = await ask(started, '/api/ide-selection', { method: 'POST', body: JSON.stringify({
    rootId: 'r', path: 'main.rs', text: 'fn main', selection: { start: { line: 0 }, end: { line: 0 } }, buffer: 'fn main() {}\n' }) });
  assert.equal(selected.status, 200);
  const reported = await selected.json();
  assert.equal(reported.delivered, 0);
  assert.deepEqual(reported.servers, [], 'this project declares no language server, so the buffer reached none');

  const mentioned = await ask(started, '/api/ide-mention',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: 'main.rs', lineStart: 1, lineEnd: 2 }) });
  assert.equal(mentioned.status, 200);
  assert.equal((await mentioned.json()).delivered, 0);

  /* And a root the workspace does not have is refused, because a file is named by a root and a path
     within it — there is no file to mention without one. */
  const unknown = await ask(started, '/api/ide-mention', { method: 'POST', body: JSON.stringify({ rootId: 'nope' }) });
  assert.equal(unknown.status, 404);
});

test('a worker with no published editor still answers, and delivers to nobody', { timeout: 60000 }, async t => {
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-ide-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  const upstream = await host(t, withRoot(at));
  const started = await worker(t, upstream);
  const selected = await ask(started, '/api/ide-selection',
    { method: 'POST', body: JSON.stringify({ rootId: 'r', path: 'main.rs', text: '' }) });
  assert.equal(selected.status, 200, 'the workspace opens whether or not a CLI can find an editor');
  assert.equal((await selected.json()).delivered, 0);
});

async function settleFiles(directory, timeout = 20000) {
  for (let waited = 0; waited < timeout; waited += 50) {
    const found = await readdir(directory).catch(() => []);
    if (found.length) return found;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('no editor was published');
}

/* --- the third category: routes the DOOR answers and the worker must not simply hand on --------- */
/* A table of "ours" and "theirs" misses these by construction. Stopping a pane, launching a game,
 * reloading a desktop: the door answers all of them and has no token gate of its own, and must not
 * grow one (spec 065). A worker that forwarded them unchanged would be a workspace with no
 * arbitration at all, and nothing about it would look broken.
 */
test('a route the door answers is gated here before it is handed on', async t => {
  const upstream = await host(t, { ...ROOTS, '/api/session': { id: 'pane-1', rootId: 'r', type: 'agent' } });
  const started = await worker(t, upstream);

  /* With no ledger there is nothing to be refused BY, so each goes through — and what this asserts
     is that it went through the gate on its way, not around it. The refusal order itself is
     `serve::token_refusal`'s, and the gate's own answers are the ledger's. */
  /* `/api/game` is gated too and is not here: it is COMPOSED, because it has to run the project's
     own preflight and queue the asker before it calls. Its own test is below. */
  for (const [route, body] of [['/api/dashboard-run', { rootId: 'r', actionId: 'x' }],
                               ['/api/desktop-action', { rootId: 'r', desktopId: 'd', action: 'reload' }]]) {
    const answered = await ask(started, route, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(answered.status, 200, route);
    assert.equal(upstream.seen.at(-1).url, route, `${route} reached the door after the gate`);
    assert.equal(upstream.seen.at(-1).body, JSON.stringify(body), 'with its body whole');
    assert.equal(upstream.seen.at(-1).authorization, `Bearer ${HOST_TOKEN}`);
  }

  /* A project the workspace does not have is refused before the door is touched. */
  const before = upstream.seen.length;
  const unknown = await ask(started, '/api/game', { method: 'POST', body: JSON.stringify({ rootId: 'nope' }) });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'Unknown project root.');
  assert.deepEqual(upstream.seen.slice(before).map(request => request.url), ['/api/state'], 'and never forwarded');
});

/* Stopping a pane is about the project the PANE is in, and only the pane's own record says which.
 * A caller's claim about it would let an agent gate itself against a project it is not in. */
test('a pane route is gated on the pane\'s own project, never on the caller\'s claim', async t => {
  const upstream = await host(t, { ...ROOTS, '/api/session': { id: 'pane-1', rootId: 'r', type: 'agent' } });
  const started = await worker(t, upstream);

  const stopped = await ask(started, '/api/stop', { method: 'POST', body: JSON.stringify({ id: 'pane-1' }) });
  assert.equal(stopped.status, 200);
  /* The pane was asked about — by id, with no root in the body at all — and then the stop went on. */
  const asked = upstream.seen.map(request => request.url.split('?')[0]);
  assert.ok(asked.includes('/api/session'), `the pane's own record was read: ${asked.join(', ')}`);
  assert.equal(upstream.seen.at(-1).url, '/api/stop');

  /* And a pane nobody has is refused here rather than at the door. */
  const missing = await host(t, { '/api/session': { __status: 404, error: 'Unknown session.' } });
  const other = await worker(t, missing);
  const refused = await ask(other, '/api/agent-restart', { method: 'POST', body: JSON.stringify({ id: 'gone' }) });
  assert.equal(refused.status, 404);
  assert.deepEqual(missing.seen.map(request => request.url.split('?')[0]), ['/api/session'], 'nothing was restarted');
});

/* A capability is a promise a caller reads BEFORE it calls: `red-mcp` refuses a tool by name when
 * the workspace does not advertise it, rather than calling a worker that would pass every gate
 * because it has none. So a state read is composed here rather than forwarded. */
test('a state read carries what having a worker in front of the door adds', async t => {
  const upstream = await host(t, { '/api/state': { roots: [], preferences: { theme: 'dark' },
    capabilities: { handoff: 1, projectGameLaunch: 1 } } });
  const started = await worker(t, upstream);

  const read = await ask(started, '/api/state');
  const state = await read.json();
  assert.equal(state.capabilities.handoff, 1, "the host's own answer is kept");
  assert.equal(state.capabilities.agentsMenu, 1, 'and what the worker adds is added');
  assert.equal(state.preferences.theme, 'dark', 'the preferences the host holds are untouched');

  /* This worker serves no ledger, so it promises none of the three that ride with it — a worker
     that said `agentToken` here would have every tool call it and every gate pass. */
  for (const promise of ['agentToken', 'taskWrites', 'agentSpawn']) {
    assert.equal(state.capabilities[promise], undefined, promise);
  }
  assert.equal(state.preferences.tokenWindowMs, undefined, 'and no window, because there is no ledger to hold one');

  /* Launching a game is the HOST's promise: this host declared no game half, so the worker does not
     repeat it however loudly the host claimed it. */
  assert.equal(state.capabilities.projectGameLaunch, undefined);
  assert.equal(state.capabilities.projectGame, 1, 'the preflight is the worker\'s own and answers regardless');
});

/* The host's preference store allowlists its keys and drops what it does not know, so the token
 * window is kept beside the LEDGER. A worker that passed the whole body on would have the window
 * silently dropped and the person's setting never take. */
test('a preferences write is split, and the window never reaches the store that would drop it', async t => {
  const upstream = await host(t, { ...ROOTS, '/api/preferences': body => ({ ...body, saved: true }) });
  const started = await worker(t, upstream);

  const written = await ask(started, '/api/preferences',
    { method: 'POST', body: JSON.stringify({ theme: 'dark', tokenWindowMs: 60000 }) });
  /* No ledger here, so the window half is refused by name rather than dropped in silence. */
  assert.equal(written.status, 409);
  assert.match((await written.json()).error, /does not serve the project token ledger/);
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/preferences'), [],
    'and nothing was half-written');

  const rest = await ask(started, '/api/preferences', { method: 'POST', body: JSON.stringify({ theme: 'dark' }) });
  assert.equal(rest.status, 200);
  assert.deepEqual(JSON.parse(upstream.seen.at(-1).body), { theme: 'dark' }, 'the rest goes to the store that holds it');
});

/* The same write against a REAL ledger, because the half that matters is invisible without one:
 * with nothing to keep the window, the route refuses before it forwards anything and a worker that
 * passed the whole body on would look identical. */
test('the window is kept beside the ledger and never sent to the store', { timeout: 120000 }, async t => {
  const upstream = await host(t, { '/api/state': { roots: [], preferences: { theme: 'dark' }, capabilities: {} },
    '/api/preferences': body => ({ ...body, saved: true }) });
  const { Tokens } = await import('../runtime/token-client.mjs');
  const tokens = await Tokens.open(upstream.state, { alive: () => true });
  t.after(async () => {
    await tokens.close();
    try {
      const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
    } catch { /* never started, or already gone */ }
  });
  const started = await worker(t, upstream);

  const written = await ask(started, '/api/preferences',
    { method: 'POST', body: JSON.stringify({ theme: 'light', tokenWindowMs: 45000 }) });
  assert.equal(written.status, 200, JSON.stringify(await written.clone().json()));
  const answer = await written.json();
  assert.equal(answer.tokenWindowMs, 45000, 'the caller is told the window that took');
  assert.equal(answer.theme, 'light', "and the store's own answer");
  /* The store allowlists its keys and drops what it does not know, so the window must never be
     among them: a worker that forwarded it whole would have the setting silently never take. */
  const forwarded = JSON.parse(upstream.seen.filter(request => request.url === '/api/preferences').at(-1).body);
  assert.equal(forwarded.tokenWindowMs, undefined, `the window never reached the store: ${JSON.stringify(forwarded)}`);
  assert.equal(forwarded.theme, 'light');

  /* And a state read carries it back, from beside the ledger rather than from the store. */
  const state = await ask(started, '/api/state').then(read => read.json());
  assert.equal(state.preferences.tokenWindowMs, 45000);
  assert.equal(state.capabilities.agentToken, 1, 'this worker serves a ledger, so it says so');
});

/* The recorder lives in the desktop (spec 081), so a commit is announced BY the desktop — and a
 * recording frame is a FEED frame, which makes it the feed owner's however it arrives. */
test('a recording frame is the desktop\'s, and is refused when it is anyone else\'s', async t => {
  const upstream = await host(t, ROOTS);
  const started = await worker(t, upstream);
  const send = (body, headers) => ask(started, '/api/recording', { method: 'POST', body: JSON.stringify(body), headers });

  const anonymous = await send({ rootId: 'r', event: 'committed' });
  assert.equal(anonymous.status, 403);
  assert.match((await anonymous.json()).error, /carried no X-Rengine-Desktop header/);

  /* An agent that sent one would be claiming to be the recorder, and the recorder is the thing in
     front of the person: its header is honoured only in the ABSENCE of an agent's. */
  const impostor = await send({ rootId: 'r', event: 'committed' },
    { 'X-Rengine-Agent': '12345678-1234-1234-1234-123456789abc', 'X-Rengine-Desktop': 'desk-1' });
  assert.equal(impostor.status, 403);

  /* A desktop's own frame gets as far as the ledger, which this worker does not serve. */
  const desktop = await send({ rootId: 'r', event: 'committed' }, { 'X-Rengine-Desktop': 'desk-1' });
  assert.equal(desktop.status, 409);
  assert.match((await desktop.json()).error, /does not serve the project token ledger/);
  assert.deepEqual(upstream.seen.filter(request => request.url === '/api/recording'), [],
    'and it was never forwarded to a host that has no feed');
});

/* --- the ledger the worker owns the routes to, which it also has to make sure exists ------------ */
/* `attaching` only attaches, deliberately: two in-memory owners of one set of files is stale reads
 * and lost writes (KI-103, D60/D61). So starting one is a separate act, and it is the WORKER's —
 * it is the layer that owns the token's routes, so it is the layer that makes sure there is a
 * ledger to own. Until now the JavaScript worker did this and everything else attached to what it
 * left running; after the cutover nobody would.
 */
test('a worker starts the ledger it serves, and a second one attaches to the same', { timeout: 120000 }, async t => {
  const upstream = await host(t, ROOTS);
  t.after(async () => {
    try {
      const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
    } catch { /* never started, or already gone */ }
  });
  /* Nothing is running: no descriptor, and nobody has started one. */
  assert.equal(await readFile(path.join(upstream.state, 'token.json'), 'utf8').catch(() => null), null);

  const started = await worker(t, upstream, undefined, { ledger: true });
  const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
  assert.match(descriptor.url, /^tcp:\/\/127\.0\.0\.1:\d+$/, 'the service says where it is');
  assert.equal(descriptor.protocol, 1);
  assert.notEqual(descriptor.pid, undefined);

  /* And the worker is attached to it: the feed answers from the ledger rather than saying it has
     none, which is the whole difference this makes. */
  const root = randomUUID();
  const feed = await ask(started, `/api/feed?rootId=${root}`);
  assert.equal(feed.status, 200, JSON.stringify(await feed.clone().json()));
  assert.deepEqual((await feed.json()).frames, []);

  /* A second worker on the same directory ATTACHES rather than starting a second: one ledger per
     directory is the rule, and two would be two sequences on one feed. */
  const second = await worker(t, upstream, undefined, { ledger: true });
  const again = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
  assert.equal(again.pid, descriptor.pid, 'the same service, not a second one');
  const theirs = await ask(second, `/api/feed?rootId=${root}`);
  assert.equal(theirs.status, 200);

  /* The service outlives the worker that started it, which is the whole of D60/D61: a replaced
     worker finds the ledger where it left it, with its sequence unbroken. */
  const window = await ask(started, '/api/state').then(read => read.json());
  assert.equal(typeof window.preferences.tokenWindowMs, 'number', 'and the worker can read it');
});

/* --- what a caller reads to follow this workspace (spec 095, spec 097) ------------------------- */
test('the token and the feed answer in the shapes a caller follows them by', { timeout: 120000 }, async t => {
  const root = randomUUID();
  const agentId = randomUUID();
  const agent = { id: agentId, label: `claude ${agentId.slice(0, 8)}` };
  const upstream = await host(t, { '/api/state': {
    roots: [{ id: root, path: ROOT }],
    /* The workspace's own record of this project's conversations (spec 097). */
    conversations: { [root]: [{ id: agent.id, agent: 'claude', startedAt: 1700000000000, lastSeenAt: 1700000060000 }] },
  } });
  const { Tokens } = await import('../runtime/token-client.mjs');
  const tokens = await Tokens.open(upstream.state, { alive: () => true });
  t.after(async () => {
    await tokens.close();
    try {
      const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
    } catch { /* never started, or already gone */ }
  });
  const started = await worker(t, upstream);

  /* `feed_url` composes its monitor URL out of `socket`, so a feed answered without one is a feed
     nothing can follow. */
  const feed = await ask(started, `/api/feed?rootId=${root}`).then(read => read.json());
  assert.equal(feed.rootId, root);
  assert.ok(feed.socket.startsWith(started.url.replace('http', 'ws')), feed.socket);
  assert.ok(feed.socket.includes(`rootId=${root}`) && feed.socket.includes(started.token), 'and it carries the way in');
  assert.ok(Array.isArray(feed.frames));

  /* The token answer is the STATUS itself, with the caller and the refusal beside it — not a status
     nested inside one, which is the service's shape and not the route's. */
  const status = await ask(started, `/api/token?rootId=${root}&tool=task_add`).then(read => read.json());
  assert.equal(status.status, undefined, 'the status is the answer, not a field in it');
  assert.ok(Array.isArray(status.identities), JSON.stringify(status));
  assert.equal(status.holder, null);
  assert.ok(status.feed.startsWith(started.url.replace('http', 'ws')), 'and it names the feed to follow');

  /* The ledger learns an agentId only from a header on the wire, so a lane that has not called
     anything is invisible and un-nameable. The conversations this project remembers are identities
     it already has: folded in, marked, and never minted. */
  const remembered = status.identities.find(entry => entry.agentId === agent.id);
  assert.ok(remembered, `the remembered conversation is nameable: ${JSON.stringify(status.identities)}`);
  assert.equal(remembered.conversation, true);
  assert.equal(remembered.label, agent.label);

  /* And one the ledger HAS met is its own record, never overridden by what is remembered. */
  const ledger = await tokens.ledger(root);
  await ledger.callerStatus({ agentId: agent.id, label: 'the one on the wire' }, null);
  const again = await ask(started, `/api/token?rootId=${root}`).then(read => read.json());
  const met = again.identities.filter(entry => entry.agentId === agent.id);
  assert.equal(met.length, 1, 'one identity, not two');
  assert.equal(met[0].label, 'the one on the wire');
  assert.equal(met[0].conversation, undefined);
});

/* A candidate the supervisor prepares and then discards only ever answers /health and /api/state.
 * A worker that claimed a generation on either would have the layer above watching a workspace get
 * replaced over and over by workers that never served a single caller. */
test('a worker announces itself once, and never for a probe', { timeout: 120000 }, async t => {
  const root = randomUUID();
  const upstream = await host(t, { '/api/state': { roots: [{ id: root, path: ROOT }] } });
  const { Tokens } = await import('../runtime/token-client.mjs');
  const tokens = await Tokens.open(upstream.state, { alive: () => true });
  t.after(async () => {
    await tokens.close();
    try {
      const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
    } catch { /* never started, or already gone */ }
  });
  const started = await worker(t, upstream);
  const updates = async () => ((await (await tokens.ledger(root)).feed.after(0)).frames)
    .filter(frame => frame.type === 'workspace.updated');

  await ask(started, '/health');
  await ask(started, '/api/state');
  assert.deepEqual(await updates(), [], 'a probe is not a caller');

  await ask(started, `/api/token?rootId=${root}`);
  const announced = await updates();
  assert.equal(announced.length, 1, 'and the first real request claims a generation');
  assert.equal(announced[0].by.kind, 'workspace');
  assert.deepEqual(announced[0].layers, ['workspace']);
  assert.equal(typeof announced[0].generation, 'number');

  /* Once per worker process: every request after it is not another workspace update. */
  for (const route of [`/api/token?rootId=${root}`, `/api/feed?rootId=${root}`, `/api/agents-menu?rootId=${root}`]) {
    await ask(started, route);
  }
  assert.equal((await updates()).length, 1, 'one announcement per worker, not one per request');
});

/* --- the pair a game leaves on the feed (spec 078, spec 095) ----------------------------------- */
/* A game pane is the one thing here a person starts and then watches for minutes, so the feed
 * carries a PAIR for it and a monitor draws a session from the two. What makes the pair trustworthy
 * is attribution across a gap: the host announces the new session BEFORE the launch call returns,
 * so who asked cannot be looked up by session id at that moment.
 */
test('a game launched through the worker leaves an attributed pair on the feed', { timeout: 120000 }, async t => {
  const root = randomUUID();
  const sessionId = 'game-1';
  /* A project that declares a game the preflight passes: the worker runs that preflight itself,
     before anything reaches the host, which is spec 078's rule and KI-043's lesson. */
  const at = await mkdtemp(path.join(tmpdir(), 'rengine-game-'));
  t.after(() => rm(at, { recursive: true, force: true }));
  const projectPath = await gameProject(at, 'declared');
  let announced = null;
  const upstream = await host(t, {
    '/api/state': () => ({ roots: [{ id: root, path: projectPath }], sessions: announced ? [announced] : [],
      capabilities: { projectGame: 1 } }),
    '/api/game': body => {
      /* Announced on the stream before the call returns, which is the gap the queue exists for. */
      announced = { id: sessionId, rootId: root, type: 'game', state: 'running', game: body.gameId ?? 'fixture-game',
        surface: 'sdl', args: body.args ?? [] };
      sockets.clients.forEach(client => client.send(JSON.stringify({ type: 'session', session: announced })));
      return announced;
    },
  });
  const sockets = new WebSocketServer({ server: upstream.server });
  const { Tokens } = await import('../runtime/token-client.mjs');
  const tokens = await Tokens.open(upstream.state, { alive: () => true });
  t.after(async () => {
    await tokens.close();
    try {
      const descriptor = JSON.parse(await readFile(path.join(upstream.state, 'token.json'), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) process.kill(descriptor.pid, 'SIGKILL');
    } catch { /* never started, or already gone */ }
  });
  const started = await worker(t, upstream);
  const frames = async () => (await (await tokens.ledger(root)).feed.after(0)).frames;
  const settle = async (check, what) => {
    for (let waited = 0; waited < 15000; waited += 50) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(what);
  };
  /* The worker must be listening before the launch, or the announcement lands in nobody's ear. */
  await settle(async () => sockets.clients.size > 0, 'the worker subscribed to the host stream');

  /* The token first, because launching a game is one of the exclusive things it arbitrates — which
     this needed to be told once, and is the gate working. */
  const agent = '12345678-1234-1234-1234-123456789abc';
  await (await tokens.ledger(root)).contest({ agentId: agent, label: 'claude 12345678' }, 'launching');
  const launched = await ask(started, '/api/game', { method: 'POST', body: JSON.stringify({ rootId: root, gameId: 'fixture-game', args: ['-w'] }),
    headers: { 'X-Rengine-Agent': agent, 'X-Rengine-Agent-Label': 'claude 12345678' } });
  assert.equal(launched.status, 200, JSON.stringify(await launched.clone().json()));

  await settle(async () => (await frames()).some(frame => frame.type === 'game.started'), 'the launch reached the feed');
  const start = (await frames()).find(frame => frame.type === 'game.started');
  assert.equal(start.sessionId, sessionId);
  assert.equal(start.gameId, 'fixture-game');
  assert.deepEqual(start.args, ['-w']);
  /* Attributed to whoever asked — the whole reason the asker is queued before the call is made. */
  assert.equal(start.by.kind, 'agent');
  assert.equal(start.by.agentId, agent);
  assert.equal(start.by.label, 'claude 12345678');

  /* And the ending, which carries the same asker and what the game was: read back from the open
     pair, because the session record that arrives at the end no longer says. */
  sockets.clients.forEach(client => client.send(JSON.stringify({ type: 'session',
    session: { id: sessionId, rootId: root, type: 'game', state: 'exited', exitCode: 0 } })));
  await settle(async () => (await frames()).some(frame => frame.type === 'game.ended'), 'the ending reached the feed');
  const end = (await frames()).find(frame => frame.type === 'game.ended');
  assert.equal(end.by.agentId, agent, 'the ending is the starter\'s, not the workspace\'s');
  assert.equal(end.gameId, 'fixture-game');
  assert.equal(end.exitCode, 0);

  /* A pane that is not a game is nothing to do with the feed: that is what makes "no PTY output on
     the feed" structural rather than a filter somebody can forget. */
  const before = (await frames()).length;
  sockets.clients.forEach(client => client.send(JSON.stringify({ type: 'session',
    session: { id: 'term-1', rootId: root, type: 'terminal', state: 'running' } })));
  /* And an `output` frame carrying everything a session frame would. The rule is the EVENT TYPE,
     not the shape: a worker that fell back to reading whatever a frame happened to contain would
     turn a pane's bytes into feed frames the moment one of them looked like a session. */
  sockets.clients.forEach(client => client.send(JSON.stringify({ type: 'output', id: 'game-2', data: 'hello',
    session: { id: 'game-2', rootId: root, type: 'game', state: 'running', game: 'fixture-game', args: [] } })));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await frames()).length, before, 'a terminal and a pane\'s bytes are not feed frames');
});
