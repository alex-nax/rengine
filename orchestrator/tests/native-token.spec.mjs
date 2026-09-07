import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { contestFrame, startTokenSidecar, tokenFrame } from './token-fixtures.mjs';

/* The desktop's half of the project token (spec 095, stage 3): one status-bar segment reading the
   ledger's `token` frames, a popover carrying the gestures the person is never gated on, and the
   recorder announcing its segments on the same socket. The ledger itself is stage 2; the fixture
   here is the worker's interception and nothing more. */

const RE_OVERLAY_TOKEN = 4;
const HOLDER = { agentId: '22222222-2222-4222-8222-222222222222', label: 'claude', pid: 4321, since: '2026-09-07T09:15:00.000Z' };
const surfaceFixture = () => path.resolve(process.platform === 'win32'
  ? '.cache/native/Release/rengine_surface_fixture.exe' : '.cache/native/rengine_surface_fixture');

test('the status segment reads the ledger, and the popover sends the four desktop gestures', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-token-'));
  let server, sidecar, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    sidecar = await startTokenSidecar(server);
    const root = await server.store.addRoot(dir);
    gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
    await gui.until(s => s.connected, 'the desktop connects through the worker stand-in');
    assert.ok(await sidecar.settled(), 'the desktop holds an /events socket through the stand-in');

    /* Before the ledger speaks the segment claims nothing: "free" would be an assertion about a
       ledger this window has not heard from. */
    let state = await gui.until(s => s.token !== undefined, 'the inspect op reports the token');
    assert.equal(state.token.known, false);
    assert.equal(state.token.segment, '');
    assert.equal(state.token.holder, null);
    assert.equal(state.token.contest, null);

    sidecar.push(tokenFrame({ rootId: root.id }));
    state = await gui.until(s => s.token.segment === 'Token · free', 'a free token');
    assert.equal(state.token.known, true);
    assert.equal(state.token.windowMs, 60000);
    assert.equal(state.token.rootId, root.id);

    sidecar.push(tokenFrame({ rootId: root.id, holder: HOLDER, sequence: 2 }));
    state = await gui.until(s => s.token.segment === 'Token · claude', 'a held token wears the holder label');
    assert.equal(state.token.holder.pid, 4321);
    assert.equal(state.token.holder.agentId, HOLDER.agentId);
    assert.equal(state.token.holder.since, HOLDER.since);

    /* Identity is the window's primary root (spec 084 decision 3): another root's ledger is not
       this window's business, however loudly it speaks. */
    sidecar.push(tokenFrame({ rootId: '00000000-0000-4000-8000-000000000000', sequence: 9,
      holder: { ...HOLDER, label: 'gemini' } }));
    await delay(400);
    state = await gui.command({ op: 'state' });
    assert.equal(state.token.segment, 'Token · claude', "another root's ledger never renames this segment");

    const contest = contestFrame({ id: 'contest-1', label: 'codex', seconds: 45 });
    sidecar.push(tokenFrame({ rootId: root.id, holder: HOLDER, contest, sequence: 3 }));
    state = await gui.until(s => /^Contest · codex · \d+s$/.test(s.token.segment), 'the contest counts down');
    assert.ok(state.token.contest.secondsLeft >= 43 && state.token.contest.secondsLeft <= 45,
      `the countdown runs against the desktop's own clock: ${state.token.contest.secondsLeft}`);
    assert.equal(state.token.contest.id, 'contest-1');
    assert.equal(state.token.contest.contester.label, 'codex');
    assert.equal(state.token.segment, `Contest · codex · ${state.token.contest.secondsLeft}s`);

    await gui.control('token', 'segment');
    state = await gui.until(s => s.overlay === RE_OVERLAY_TOKEN, 'the segment opens the popover');
    for (const key of ['reject', 'grant', 'revoke', 'free']) {
      assert.ok(state.controls.some(c => c.role === 'token' && c.key === key), `the popover offers ${key}`);
    }

    const sent = async (key, expected) => {
      await gui.control('token', key);
      const frame = await sidecar.waitFor(f => f.type === 'token-action' && f.action === expected.action, `a ${key} frame`);
      assert.deepEqual(frame, { type: 'token-action', rootId: root.id, ...expected });
    };
    await sent('reject', { action: 'reject', contestId: 'contest-1' });
    await sent('grant', { action: 'grant', contestId: 'contest-1' });
    /* Revoke and Free are about a held token, not a contest, so they carry no contestId at all. */
    await sent('revoke', { action: 'revoke' });
    await sent('free', { action: 'free' });
    assert.equal(sidecar.of('token-action').length, 4, 'four gestures, four frames');

    /* The ledger's word does not outlive the socket that carried it. */
    sidecar.drop();
    state = await gui.until(s => s.token.known === false, 'a lost connection clears the token state');
    assert.equal(state.token.segment, '');
    assert.equal(state.token.holder, null);
    assert.equal(state.token.contest, null);
    assert.equal(state.token.rootId, '');

    await gui.until(s => s.connected, 'the desktop reconnects through the stand-in');
    assert.ok(await sidecar.settled());
    sidecar.push(tokenFrame({ rootId: root.id, holder: HOLDER, sequence: 1 }));
    await gui.until(s => s.token.segment === 'Token · claude', 'the ledger speaks again after the reconnection');
  } finally { await gui?.close(); await sidecar?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the recorder announces an explicit start and every commit on the live channel', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-token-recording-'));
  let server, sidecar, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    sidecar = await startTokenSidecar(server);
    const root = await server.store.addRoot(dir);
    await server.store.preferences({ recording: { seconds: 30, fps: 20, width: 320, bytes: 4 * 1024 * 1024 } });
    const { item, env } = server.games.surfaces.reserve();
    const game = await server.sessions.terminal({ rootId: root.id, type: 'game', game: 'fixture-game', surface: 'embedded',
      title: 'Fixture game · token feed', command: surfaceFixture(), args: ['interactive'],
      env: { ...env, DYLD_INSERT_LIBRARIES: path.resolve('.cache/native/librengine_surface.dylib') } });
    item.id = game.id; server.games.items.set(game.id, item);
    gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id, game: game.id });

    const recording = state => state.tabs.find(tab => tab?.session === game.id)?.recording;
    await gui.until(s => recording(s)?.frames > 2, "the pane's rolling buffer");

    await gui.control('recording', 'toggle');
    let state = await gui.until(s => recording(s)?.state === 'recording', 'the toggle starts an explicit segment');
    const started = await sidecar.waitFor(f => f.type === 'recording' && f.event === 'started', 'a started frame');
    assert.equal(started.kind, 'explicit', 'the feed names the gesture, not the manifest shape');
    assert.equal(started.rootId, root.id);
    assert.equal(started.sessionId, game.id);
    assert.equal(started.gameId, 'fixture-game');
    assert.match(started.recordingId, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.match(started.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    await delay(700);   /* frames to commit: an empty window commits nothing and announces nothing */
    await gui.control('recording', 'toggle');
    state = await gui.until(s => recording(s)?.segments === 1 && recording(s)?.state === 'ring', 'the toggle stops and commits');
    const committed = await sidecar.waitFor(f => f.type === 'recording' && f.event === 'committed', 'a committed frame');
    assert.equal(committed.kind, 'explicit');
    assert.equal(committed.recordingId, started.recordingId,
      'the start and the commit name one directory, so a reader can pair them');
    assert.equal(committed.recordingId, recording(state).lastSegment,
      'the announced id is the segment directory the desktop actually wrote');

    await gui.control('recording', 'commit');
    state = await gui.until(s => recording(s)?.segments === 2, 'the ring commit writes a second segment');
    const ring = await sidecar.waitFor(f => f.type === 'recording' && f.kind === 'ring', 'a ring commit frame');
    assert.equal(ring.event, 'committed', 'a ring commit has no start to announce');
    assert.equal(ring.recordingId, recording(state).lastSegment);
    assert.notEqual(ring.recordingId, started.recordingId);
    assert.equal(sidecar.of('recording').filter(f => f.kind === 'ring' && f.event === 'started').length, 0,
      'nothing announces a start for a gesture that has none');

    await gui.close(); gui = null;
    await server.sessions.stop(game.id);
  } finally { await gui?.close(); await sidecar?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
