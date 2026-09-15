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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-worker');
const HOST_TOKEN = 'b'.repeat(64);

before(() => built('--bins'));

/* A stand-in session host that records what reached it. The worker's job is to pass a request on
   unchanged except for the credential, so what this saw IS the assertion. */
async function host(t) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ reached: 'the host' }));
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
    { stdio: ['ignore', 'pipe', 'pipe'] });
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
