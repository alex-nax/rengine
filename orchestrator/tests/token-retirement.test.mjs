import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { Feed } from '../runtime/feed.mjs';
import { tokenProject, identity, api, ok, until, fakeDesktop, feedSocket } from './token-fixtures.mjs';

/* KI-061, closed: after a workspace-only replacement the desktop's /events socket keeps draining
   through the retired worker (spec 065) while the ledger and the feed belong to the worker that
   replaced it (spec 095, Retirement). A real supervisor, two real workers and a stand-in desktop on
   the socket the real one uses — the split is between kinds of traffic, not between processes. */

const WINDOW = 60000;
const query = value => new URLSearchParams(value).toString();
const within = (promise, ms, label) => Promise.race([promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms).unref?.(); })]);

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-retirement-'));
  const project = await tokenProject(directory);
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  const root = await host.store.addRoot(project);
  const runtimeDir = path.join(directory, 'runtime');
  const runtime = await startRuntime({ host, directory: runtimeDir });
  t.after(async () => { await runtime.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  await ok(runtime, 'preferences', { tokenWindowMs: WINDOW });
  return { directory, project, host, root, runtimeDir, runtime };
}
const tokenState = (runtime, rootId, who) => ok(runtime, `token?${query({ rootId })}`, undefined, who);
async function replaceWorkspace(runtime, rootId) {
  const before = (await ok(runtime, `update-status?${query({ rootId })}`)).workspace.pid;
  const queued = await api(runtime, 'update-workspace', { rootId, layers: ['workspace'] });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const status = await until(async () => {
    const value = await ok(runtime, `update-status?${query({ rootId })}`);
    return ['succeeded', 'failed'].includes(value.jobs.find(job => job.id === queued.body.jobId)?.status) && value;
  }, 'the workspace layer is replaced', 600);
  const job = status.jobs.find(item => item.id === queued.body.jobId);
  assert.equal(job.status, 'succeeded', job.error);
  assert.notEqual(status.workspace.pid, before, 'a different workspace worker process serves this root');
  return status;
}

test('a retained desktop keeps its streams, and its token service follows the worker that replaced them', { timeout: 90000 }, async t => {
  const { directory, host, root, runtime } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex'), gemini = identity('gemini');

  /* The stream spec 065 protects, as runtime.test.mjs:91 has it: a live PTY the desktop is attached
     to, which must keep carrying input and output through the worker that was replaced. */
  const fixture = path.join(directory, 'cli.cjs');
  await writeFile(fixture, `process.stdin.setRawMode(true); console.log('CLI_READY');
process.stdin.on('data', data => console.log('INPUT_' + data.toString('hex')));`);
  const session = await host.sessions.terminal({ rootId: root.id, command: process.execPath, args: [fixture] });
  const desktop = await fakeDesktop(runtime, [root.id], [session.id]);
  t.after(() => desktop.close());
  desktop.send({ type: 'attach', id: session.id });
  await until(() => desktop.messages.some(message => message.type === 'attached'), 'the desktop attached the retained PTY');

  await ok(runtime, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  const pending = await ok(runtime, 'token-action', { rootId: root.id, action: 'contest', reason: 'about to deploy' }, bob);
  const pushed = () => desktop.messages.filter(message => message.type === 'token').at(-1);
  await until(() => pushed()?.contest?.id === pending.contestId, 'the contest is on the desktop before the layer moves');
  const monitor = await feedSocket(runtime, (await tokenState(runtime, root.id)).feed);
  await until(() => monitor.frames.length >= 2, 'the monitor has read the ledger it is about to lose');
  const cursor = monitor.frames.at(-1).sequence;

  const status = await replaceWorkspace(runtime, root.id);

  /* (a) spec 065's own invariant, unchanged: the replaced worker is still there because the
     desktop's stream finishes through it, and that stream is still a working view. */
  assert.equal(status.workspace.retiring.length, 1, 'the replaced worker is retained for its stream');
  assert.equal(desktop.socket.readyState, WebSocket.OPEN, 'and the desktop socket was never closed under it');
  desktop.send({ type: 'input', id: session.id, data: 'still-alive' });
  await until(() => host.sessions.snapshot(session.id, true).output.includes('INPUT_7374696c6c2d616c697665'),
    'input still reaches the PTY through the retired worker');
  await until(() => desktop.messages.some(message => message.type === 'output' && message.data?.includes('INPUT_7374696c6c2d616c697665')),
    'and its output still reaches the retained view');

  /* (f) the monitor is not left reading a ledger nobody writes: it is closed with a reason that
     names retirement, and the current worker has every frame after the cursor it had. */
  const gone = await within(monitor.closed, 15000, 'the retired feed client is closed');
  assert.match(gone.reason, /retired/i, `the close reason names retirement: ${gone.reason}`);
  assert.match(gone.reason, /feed_url/, 'and says what to re-read');
  const feed = await feedSocket(runtime, `${(await tokenState(runtime, root.id)).feed}&after=${cursor}`);
  t.after(() => feed.close());

  /* (b) the person's control, sent on the retained socket, lands on the ledger the agents read. */
  desktop.send({ type: 'token-action', rootId: root.id, action: 'reject', contestId: pending.contestId, reason: 'a build is running' });
  const rejected = await until(() => feed.frames.find(frame => frame.type === 'token.rejected'),
    "the retained desktop's rejection reaches the current worker's feed");
  assert.equal(rejected.by.kind, 'desktop', 'attributed to the person, not to the worker that carried it');
  assert.equal(rejected.by.desktopId, desktop.id, 'naming the desktop the retired worker registered');
  assert.equal(rejected.contestId, pending.contestId);
  assert.equal(rejected.reason, 'a build is running');
  const kept = await tokenState(runtime, root.id);
  assert.equal(kept.holder.agentId, alice.agentId, 'the holder the agents read is the one the person kept');
  assert.equal(kept.contest, null, 'and the contest is closed on that ledger, not on one nobody reads');
  const blocked = await api(runtime, 'token-action', { rootId: root.id, action: 'contest' }, bob);
  assert.equal(blocked.status, 409, "the rejection cost the contester a cooldown on the current ledger");

  /* (c) and the traffic the other way: an agent's transition against the current worker reaches the
     desktop that is still attached to the retired one, as the same pinned frame. */
  const before = pushed().sequence;
  const opened = await ok(runtime, 'token-action', { rootId: root.id, action: 'contest', reason: 'my turn' }, gemini);
  const relayed = await until(() => { const frame = pushed(); return frame?.contest?.id === opened.contestId && frame; },
    'the current ledger reaches the retained desktop as a token frame');
  assert.deepEqual(Object.keys(relayed).sort(), ['contest', 'holder', 'rootId', 'sequence', 'type', 'windowMs'],
    'the frame on the desktop socket is the pinned flat shape, unchanged by the relay');
  assert.equal(relayed.contest.contester.agentId, gemini.agentId);
  assert.equal(relayed.holder.agentId, alice.agentId);
  assert.equal(relayed.windowMs, WINDOW, 'carrying the workspace preference the current worker read');
  assert.ok(relayed.sequence > before, 'and a sequence that moved on');

  /* (f, second half) nothing between the closed monitor's cursor and the reattached one. */
  const read = await ok(runtime, `feed?${query({ rootId: root.id, after: String(cursor) })}`);
  assert.equal(read.frames[0].sequence, cursor + 1, 'the current ledger retained the frame after that cursor');
  await until(() => feed.frames.length >= read.frames.length, 'the reattached monitor catches up');
  assert.deepEqual(feed.frames.slice(0, read.frames.length).map(frame => frame.sequence), read.frames.map(frame => frame.sequence),
    'a reattach by cursor on the current worker misses nothing');

  /* The URL and capability feed_url handed out before the replacement still name this worker, so
     the four routes that read or write the ledger are answered there by forwarding to the one that
     owns it now — rather than from a ledger this process gave up. */
  const address = new URL(monitor.socket.url);
  const retiredWorker = { url: `http://127.0.0.1:${address.port}`, token: address.searchParams.get('token') };
  const forwarded = await ok(retiredWorker, `token?${query({ rootId: root.id })}`);
  assert.equal(forwarded.holder.agentId, alice.agentId, 'GET /api/token answers the current ledger');
  assert.equal(forwarded.contest?.id, opened.contestId, 'including the contest opened after the replacement');
  assert.deepEqual((await ok(retiredWorker, `feed?${query({ rootId: root.id, after: String(cursor) })}`)).frames.map(frame => frame.sequence),
    read.frames.map(frame => frame.sequence), 'GET /api/feed answers the current ring');
  await ok(retiredWorker, 'preferences', { tokenWindowMs: 45000 });
  assert.equal((await tokenState(runtime, root.id)).window, 45000, 'the tokenWindowMs half of a preferences write reaches the current worker');
  const released = await ok(retiredWorker, 'token-action', { rootId: root.id, action: 'release' }, alice);
  assert.equal(released.state, 'claimed', 'POST /api/token-action is the current ledger answering, contest and all');
  assert.equal(released.holder.agentId, gemini.agentId);
  await until(() => pushed()?.holder?.agentId === gemini.agentId, 'and the retained desktop is told who holds it now');
});

test('a retired worker mints nothing: one game.started, and the file a third worker would load agrees', { timeout: 90000 }, async t => {
  const { host, root, runtime, runtimeDir } = await workspace(t);
  const alice = identity('claude');
  const desktop = await fakeDesktop(runtime, [root.id]);
  t.after(() => desktop.close());
  await ok(runtime, 'token-action', { rootId: root.id, action: 'contest' }, alice);

  const status = await replaceWorkspace(runtime, root.id);
  assert.equal(status.workspace.retiring.length, 1, "the replaced worker is retained for the desktop's stream");
  const feed = await feedSocket(runtime, (await tokenState(runtime, root.id)).feed);
  t.after(() => feed.close());

  /* (d) the recorder is the desktop's (spec 081) and the desktop is on the retired worker; the
     frames still become captures on the ledger the agents watch. */
  const at = new Date().toISOString();
  for (const event of ['started', 'committed']) {
    desktop.send({ type: 'recording', rootId: root.id, sessionId: 'session-1', gameId: 'fixture-game', event, recordingId: 'rec-1', kind: 'explicit', at });
  }
  const committed = await until(() => feed.frames.find(frame => frame.type === 'capture.committed'),
    "the retained recorder's commit reaches the current feed");
  const started = feed.frames.find(frame => frame.type === 'capture.started');
  assert.ok(started, 'and its start did too');
  assert.equal(started.by.desktopId, desktop.id, 'both naming the desktop that sent them');
  assert.equal(committed.by.desktopId, desktop.id);
  assert.equal(committed.recordingId, 'rec-1');
  assert.equal(committed.kind, 'explicit');
  assert.ok(committed.sequence > started.sequence, 'two frames, in order, on the one feed');

  /* (e) the collision KI-061 measured: a game session announced by the host reached both workers,
     and both wrote the ring. One writer now, so the served feed and the file agree. */
  const game = await ok(runtime, 'game', { rootId: root.id, gameId: 'fixture-game' });
  await until(() => feed.frames.some(frame => frame.type === 'game.started'), 'game.started');
  await ok(runtime, 'stop', { id: game.id });
  await until(() => feed.frames.some(frame => frame.type === 'game.ended'), 'game.ended');
  assert.equal(feed.frames.filter(frame => frame.type === 'game.started').length, 1, 'one worker minted the start, not two');
  assert.equal(feed.frames.filter(frame => frame.type === 'game.ended').length, 1);
  assert.equal(host.sessions.snapshot(game.id).state, 'exited');

  const served = await ok(runtime, `feed?${query({ rootId: root.id })}`);
  const third = await until(async () => {
    const loaded = await Feed.open(path.join(runtimeDir, 'tokens', root.id), root.id);
    return loaded.frames.length === served.frames.length && loaded;
  }, 'the ring on disk finishes being written');
  assert.deepEqual(third.frames.map(frame => [frame.sequence, frame.type]), served.frames.map(frame => [frame.sequence, frame.type]),
    'the feed a third worker loads from feed.json is the feed the current worker serves');
  assert.ok(third.frames.some(frame => frame.type === 'workspace.updated'), 'including the generation the replacement announced');
});
