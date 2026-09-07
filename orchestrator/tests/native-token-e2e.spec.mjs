import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { nativeBridge } from './native-client.mjs';
import { tokenProject, identity, api, ok, until, feedSocket } from './token-fixtures.mjs';

/* The two halves of the project token, meeting (spec 095). Stage 2 proved the ledger against a
   stand-in desktop; stage 3 proved the desktop against a stand-in worker. Nothing asserted that the
   real worker's ledger reaches the real segment, or that the real popover reaches the real ledger.
   This is that check: a real session host, a real runtime supervisor with a real workspace worker
   under it, and the real native desktop the supervisor launches — nothing here is a fixture except
   the project the agents are arguing about. */

const RE_OVERLAY_TOKEN = 4;
const WINDOW = 45000;
const surfaceFixture = () => path.resolve(process.platform === 'win32'
  ? '.cache/native/Release/rengine_surface_fixture.exe' : '.cache/native/rengine_surface_fixture');

/* One workspace, opened the way the supervisor opens one: the desktop is the binary the runtime
   snapshots and launches, and it reaches the ledger through the supervisor's own tunnel. */
async function workspace(t, { game } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-token-e2e-')));
  const project = await tokenProject(directory);
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  const root = await host.store.addRoot(project);
  const session = game ? await game(host, root) : null;
  const views = [];
  const runtime = await startRuntime({ host, directory: path.join(directory, 'runtime'), inspectUI: true,
    initial: { root: root.id, ...(session ? { game: session.id } : {}) },
    onDesktop: child => child.once('spawn', () => views.push(nativeBridge(child))) });
  t.after(async () => {
    for (const view of views) await view.close();
    await runtime.close(); await host.close(); await rm(directory, { recursive: true, force: true });
  });
  const supervisor = { url: runtime.url, token: runtime.token };
  const gui = views.at(-1);
  await gui.until(s => s.connected, 'the desktop the supervisor launched reaches the workspace worker');
  return { directory, project, host, root, runtime, supervisor, views, gui, session };
}
/* The segment's press toggles, so a popover that is already open would be closed by a second one.
   Every gesture below opens it this way rather than assuming which state the last one left. */
async function popover(gui) {
  const state = await gui.command({ op: 'state' });
  if (state.overlay !== RE_OVERLAY_TOKEN) await gui.control('token', 'segment');
  return gui.until(s => s.overlay === RE_OVERLAY_TOKEN, 'the segment opens the token popover');
}
const tokenState = (supervisor, rootId, who) => ok(supervisor, `token?${new URLSearchParams({ rootId })}`, undefined, who);
const contest = (supervisor, rootId, who, reason = '') =>
  ok(supervisor, 'token-action', { rootId, action: 'contest', reason }, who);
const workspacePid = async (supervisor, rootId) =>
  (await ok(supervisor, `update-status?${new URLSearchParams({ rootId })}`)).workspace.pid;

test('the real ledger drives the real segment, and the real popover drives the real ledger', { timeout: 180000 }, async t => {
  const { host, root, runtime, supervisor, gui } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex'), gemini = identity('gemini'), opencode = identity('opencode');
  await ok(supervisor, 'preferences', { tokenWindowMs: WINDOW });

  /* Before any agent has spoken the ledger is free, and the desktop is told so the moment it
     registers rather than on the first transition. */
  let state = await gui.until(s => s.token?.known === true, 'the desktop is pushed the ledger it registered against');
  assert.equal(state.token.segment, 'Token · free');
  assert.equal(state.token.rootId, root.id);

  /* 1. An identified agent claims a free token, and the segment wears its label. */
  const claimed = await contest(supervisor, root.id, alice);
  assert.equal(claimed.state, 'claimed');
  state = await gui.until(s => s.token.segment === 'Token · claude', 'the segment wears the holder the real ledger recorded');
  assert.equal(state.token.holder.agentId, alice.agentId);
  assert.equal(state.token.holder.label, 'claude');
  assert.equal(state.token.holder.pid, process.pid, "the identity's live pid reached the chrome");
  assert.equal(state.token.holder.since, claimed.holder.since);
  assert.equal(state.token.windowMs, WINDOW, 'the configured window, not the compiled-in default');

  const desktops = (await ok(supervisor, `desktops?${new URLSearchParams({ rootId: root.id })}`)).desktops;
  assert.equal(desktops.length, 1, 'one managed desktop is attached to this root');
  const desktopId = desktops[0].id;
  const feed = await feedSocket(supervisor, (await tokenState(supervisor, root.id)).feed);
  t.after(() => feed.close());

  /* 2. A second identity contests, and the person at the desktop rejects it. */
  const pending = await contest(supervisor, root.id, bob, 'about to deploy');
  assert.equal(pending.state, 'pending');
  state = await gui.until(s => /^Contest · codex · \d+s$/.test(s.token.segment), 'the contest counts down in the segment');
  assert.equal(state.token.contest.id, pending.contestId, "the segment names the ledger's own contest");
  assert.equal(state.token.contest.deadline, pending.deadline);
  assert.ok(state.token.contest.secondsLeft > WINDOW / 1000 - 5, `the countdown started at the window: ${state.token.contest.secondsLeft}`);

  await popover(gui);
  await gui.control('token', 'reject');
  const rejected = await until(() => feed.frames.find(frame => frame.type === 'token.rejected'), 'the rejection reaches the feed');
  assert.equal(rejected.by.kind, 'desktop', 'and is attributed to the person, not to the holder');
  assert.equal(rejected.by.desktopId, desktopId, 'naming the desktop the supervisor listed');
  assert.equal(rejected.contestId, pending.contestId);
  const kept = await tokenState(supervisor, root.id);
  assert.equal(kept.holder.agentId, alice.agentId, 'a rejected contest leaves the holder where it was');
  assert.equal(kept.contest, null);
  state = await gui.until(s => s.token.segment === 'Token · claude', 'and the segment goes back to the holder');
  assert.equal(state.token.contest, null);
  const blocked = await api(supervisor, 'token-action', { rootId: root.id, action: 'contest' }, bob);
  assert.equal(blocked.status, 409, "the desktop's rejection cost the contester a cooldown on the real ledger");

  /* 3. A fresh contest, granted at the desktop, then revoked there. */
  const second = await contest(supervisor, root.id, gemini);
  assert.equal(second.state, 'pending');
  await gui.until(s => s.token.contest?.id === second.contestId, 'the second contest reaches the segment');
  await popover(gui);
  await gui.control('token', 'grant');
  const granted = await until(() => feed.frames.filter(frame => frame.type === 'token.claimed')
    .find(frame => frame.by.kind === 'desktop'), 'the grant reaches the feed');
  assert.equal(granted.by.desktopId, desktopId);
  assert.equal(granted.holder.agentId, gemini.agentId);
  state = await gui.until(s => s.token.segment === 'Token · gemini', 'the segment shows the holder the person chose');
  assert.equal(state.token.holder.agentId, gemini.agentId);
  assert.equal((await tokenState(supervisor, root.id)).holder.agentId, gemini.agentId);

  await popover(gui);
  await gui.control('token', 'revoke');
  const revoked = await until(() => feed.frames.find(frame => frame.type === 'token.revoked'), 'the revoke reaches the feed');
  assert.equal(revoked.by.kind, 'desktop');
  assert.equal(revoked.holder.agentId, gemini.agentId, 'the frame names whose token was taken');
  state = await gui.until(s => s.token.segment === 'Token · free', 'and the segment says nobody holds it');
  assert.equal(state.token.holder, null);
  assert.equal((await tokenState(supervisor, root.id)).holder, null);

  /* 5. The workspace layer is replaced while a contest is open, with the desktop attached. Stage 2
     proved the ledger survives the worker that recorded it; what this adds is the supervisor under
     it — a real replacement rather than a close-and-reopen — and the boundary the two specs meet at.
     Spec 065 is explicit that existing streams finish through the previous worker, so the attached
     desktop keeps reading the worker it registered on; spec 095's Retirement then hands the ledger,
     the feed and the host subscription to the replacement, so the desktop's own half of criterion 7
     is asserted below rather than deferred to KI-061. */
  const held = await contest(supervisor, root.id, alice);
  assert.equal(held.state, 'claimed');
  const open = await contest(supervisor, root.id, opencode, 'replacing the layer');
  assert.equal(open.state, 'pending');
  await gui.until(s => s.token.contest?.id === open.contestId, 'the contest is on the segment before the layer moves');
  const before = await workspacePid(supervisor, root.id);
  const cursor = (await tokenState(supervisor, root.id)).feedCursor;
  const replacement = await api(supervisor, 'update-workspace', { rootId: root.id, layers: ['workspace'] });
  assert.equal(replacement.status, 202, JSON.stringify(replacement.body));
  const job = await until(async () => {
    const status = await ok(supervisor, `update-status?${new URLSearchParams({ rootId: root.id })}`);
    const found = status.jobs.find(item => item.id === replacement.body.jobId);
    return ['succeeded', 'failed'].includes(found?.status) && found;
  }, 'the workspace layer is replaced', 400);
  assert.equal(job.status, 'succeeded', job.error);
  const status = await ok(supervisor, `update-status?${new URLSearchParams({ rootId: root.id })}`);
  assert.notEqual(status.workspace.pid, before, 'a different workspace worker process now serves this root');
  assert.equal(status.workspace.retiring.length, 1,
    "the replaced worker is still there because the desktop's stream finishes through it (spec 065)");

  const resumed = await tokenState(supervisor, root.id);
  assert.equal(resumed.holder?.agentId, alice.agentId, 'the worker that replaced it serves the same holder');
  assert.equal(resumed.contest?.id, open.contestId, 'and the same open contest');
  assert.equal(resumed.contest?.deadline, open.deadline, 'at the same absolute deadline, not a restarted countdown');
  assert.equal(resumed.window, WINDOW, 'reading the window preference from beside the ledger it loaded');
  assert.ok(resumed.feedCursor >= cursor, 'and its feed continues rather than rewinding');
  const replayed = await ok(supervisor, `feed?${new URLSearchParams({ rootId: root.id, after: String(cursor) })}`, undefined, alice);
  assert.deepEqual(replayed.frames.map(frame => frame.type), ['workspace.updated'],
    'the replacement announced its own generation on the feed the ledger carried across');
  assert.equal(replayed.frames[0].by.kind, 'workspace');

  /* 6. The desktop's half of criterion 7, which KI-061 made impossible to assert: the stream stays
     where spec 065 put it and the ledger moves. The monitor opened on the worker that was replaced
     is closed with a reason naming retirement; the person's Reject on the real popover, sent on the
     socket that still drains through that worker, lands on the ledger the agents read; and the
     segment follows the ledger the replacement serves. */
  const closed = await Promise.race([feed.closed,
    new Promise((_, reject) => { setTimeout(() => reject(new Error('Timed out: the retired worker closes its feed clients')), 20000).unref?.(); })]);
  assert.match(closed.reason, /retired/i, `the monitor is told why it has to reattach: ${closed.reason}`);
  const served = await feedSocket(supervisor, `${(await tokenState(supervisor, root.id)).feed}&after=${cursor}`);
  t.after(() => served.close());

  await popover(gui);
  await gui.control('token', 'reject');
  const answered = await until(() => served.frames.find(frame => frame.type === 'token.rejected'),
    "the popover's Reject reaches the ledger the replacement serves");
  assert.equal(answered.by.kind, 'desktop', 'still the person, through a worker that no longer owns the ledger');
  assert.equal(answered.by.desktopId, desktopId, 'still naming the desktop the supervisor listed');
  assert.equal(answered.contestId, open.contestId, 'answering the contest that was open across the replacement');
  const settled = await tokenState(supervisor, root.id);
  assert.equal(settled.holder.agentId, alice.agentId, 'the holder the person kept is the one the agents read');
  assert.equal(settled.contest, null, 'and the contest is closed there, not on a ledger nobody reads');
  state = await gui.until(s => s.token.segment === 'Token · claude' && s.token.contest === null,
    'and the segment follows the current ledger through the socket it still drains through');
  assert.equal(state.token.holder.agentId, alice.agentId);
  const cooled = await api(supervisor, 'token-action', { rootId: root.id, action: 'contest' }, opencode);
  assert.equal(cooled.status, 409, "the desktop's rejection cost the contester a cooldown on the current ledger");

  /* Nothing on the feed is a byte a process printed, and the sequence never rewound across the
     replacement — the whole conversation above is one monotonic run. */
  const sequences = feed.frames.map(frame => frame.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'the feed the desktop shares is monotonic');
  assert.equal(host.sessions.items.size, 0, 'no session was started by any of this');
  assert.ok(runtime.url.startsWith('http://127.0.0.1:'));
});

test('the recorder in the real desktop commits a segment the real feed announces', { timeout: 180000 }, async t => {
  const { root, supervisor, gui, session } = await workspace(t, { game: async (host, root) => {
    await host.store.preferences({ recording: { seconds: 30, fps: 20, width: 320, bytes: 4 * 1024 * 1024 } });
    const { item, env } = host.games.surfaces.reserve();
    const game = await host.sessions.terminal({ rootId: root.id, type: 'game', game: 'fixture-game', surface: 'embedded',
      title: 'Fixture game · token feed', command: surfaceFixture(), args: ['interactive'],
      env: { ...env, DYLD_INSERT_LIBRARIES: path.resolve('.cache/native/librengine_surface.dylib') } });
    item.id = game.id; host.games.items.set(game.id, item);
    return game;
  } });
  const feed = await feedSocket(supervisor, (await tokenState(supervisor, root.id)).feed);
  t.after(() => feed.close());

  const recording = state => state.tabs.find(tab => tab?.session === session.id)?.recording;
  const index = state => state.tabs.findIndex(tab => tab?.session === session.id);
  /* The supervisor opens the project's dashboard beside the game, and the dashboard takes the pane;
     the recorder's controls belong to the visible game view, so select it first. */
  const opened = await gui.until(s => recording(s)?.frames > 2, "the game pane's rolling buffer fills");
  await gui.control('tab', '', index(opened));
  await gui.until(s => s.controls.some(c => c.role === 'recording' && c.key === 'toggle'), 'the game view carries the recorder');
  await gui.control('recording', 'toggle');
  await gui.until(s => recording(s)?.state === 'recording', 'the toggle starts an explicit segment');
  const started = await until(() => feed.frames.find(frame => frame.type === 'capture.started'), 'the start reaches the feed');
  assert.equal(started.by.kind, 'desktop', 'the recorder is the desktop, so the frame is the desktop\'s');
  assert.equal(started.kind, 'explicit');
  assert.equal(started.sessionId, session.id);
  assert.equal(started.gameId, 'fixture-game');
  assert.match(started.recordingId, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);

  await delay(700);   /* frames to commit: an empty window commits nothing and announces nothing */
  await gui.control('recording', 'toggle');
  const state = await gui.until(s => recording(s)?.segments === 1 && recording(s)?.state === 'ring', 'the toggle commits it');
  const committed = await until(() => feed.frames.find(frame => frame.type === 'capture.committed'), 'the commit reaches the feed');
  assert.equal(committed.by.kind, 'desktop');
  assert.equal(committed.by.desktopId, started.by.desktopId);
  assert.equal(committed.kind, 'explicit');
  assert.equal(committed.recordingId, started.recordingId, 'the start and the commit name one directory');
  assert.equal(committed.recordingId, recording(state).lastSegment,
    'and it is the segment directory the desktop actually wrote, read back from the desktop');
  assert.ok(committed.sequence > started.sequence, 'two frames, in order, on the one feed');
  assert.doesNotMatch(JSON.stringify(feed.frames), /FIXTURE|\bframes\b.*\bbytes\b/,
    'the feed carries the lifecycle of the capture, never its contents');
});
