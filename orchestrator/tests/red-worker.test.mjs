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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const route = request.url.split('?')[0];
    const scripted = answers[route];
    const value = typeof scripted === 'function' ? scripted(body ? JSON.parse(body) : null, request.url) : scripted;
    const answer = value ?? { reached: 'the host' };
    response.writeHead(answer.__status ?? 200, { 'Content-Type': 'application/json' });
    const { __status, ...rest } = answer;
    response.end(JSON.stringify(rest));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = await mkdtemp(path.join(tmpdir(), 'rengine-worker-'));
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(state, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, state };
}

async function worker(t, upstream, stateDir) {
  const child = spawn(BIN, ['--state', stateDir ?? upstream.state, '--host', upstream.url, '--host-token', HOST_TOKEN],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let noise = '';
  child.stderr.on('data', bytes => { noise += bytes; });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const line = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('exit', code => reject(new Error(`red-worker exited (${code}): ${noise}`)));
  });
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
  const body = JSON.stringify({ rootId: 'r', actionId: 'press' });
  await ask(started, '/api/dashboard-run', { method: 'POST', body });
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
