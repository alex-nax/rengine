import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { listRecordings, readRecording } from '../server/recordings.mjs';
import { nativeClient } from './native-client.mjs';

const fixture = () => path.resolve(process.platform === 'win32'
  ? '.cache/native/Release/rengine_surface_fixture.exe' : '.cache/native/rengine_surface_fixture');

test('the game tab records a rolling buffer and its toggle commits segments an agent can read', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-recording-'));
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(dir);
    // A ring that fills quickly, through the same validated preference an operator would set.
    await server.store.preferences({ recording: { seconds: 30, fps: 20, width: 320, bytes: 4 * 1024 * 1024 } });
    const { item, env } = server.games.surfaces.reserve();
    const game = await server.sessions.terminal({ rootId: root.id, type: 'game', game: 'fixture-game', surface: 'embedded',
      title: 'Fixture game · recording', command: fixture(), args: ['interactive'],
      env: { ...env, DYLD_INSERT_LIBRARIES: path.resolve('.cache/native/librengine_surface.dylib') } });
    item.id = game.id; server.games.items.set(game.id, item);
    gui = await nativeClient(server, { root: root.id, game: game.id });

    const recording = state => state.tabs.find(tab => tab?.session === game.id)?.recording;
    let state = await gui.until(s => recording(s)?.frames > 2, "the pane's rolling buffer");
    assert.equal(recording(state).state, 'ring', 'the buffer rolls by default while the pane is live');
    assert.equal(recording(state).ringSeconds, 30, 'the declared bound, not a compiled-in one');
    assert.equal(recording(state).fps, 20);
    assert.ok(recording(state).bytes > 0, 'the ring holds encoded keyframes, not raw frames');
    assert.equal(recording(state).segments, 0);

    await gui.control('recording', 'toggle');
    state = await gui.until(s => recording(s)?.state === 'recording', 'the toggle starts an explicit segment');
    await delay(700);
    await gui.control('recording', 'toggle');
    state = await gui.until(s => recording(s)?.segments === 1 && recording(s)?.state === 'ring', 'the toggle stops and commits');
    const explicit = recording(state).lastSegment;
    assert.match(explicit, /^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    assert.equal(recording(state).lastPath, `.cache/recordings/${explicit}`);

    await gui.control('recording', 'commit');
    state = await gui.until(s => recording(s)?.segments === 2, 'the ring commit writes a second segment');
    const fromRing = recording(state).lastSegment;
    assert.notEqual(fromRing, explicit);

    const listed = await listRecordings(root);
    assert.deepEqual(listed.recordings.map(entry => entry.id).sort(), [explicit, fromRing].sort());
    const segment = listed.recordings.find(entry => entry.id === explicit);
    assert.equal(segment.kind, 'segment', 'start/stop is recorded as what it was');
    assert.equal(listed.recordings.find(entry => entry.id === fromRing).kind, 'ring');
    assert.equal(segment.game, 'fixture-game');
    assert.equal(segment.sessionId, game.id);
    assert.equal(segment.artifacts.keyframes.present, true);
    assert.ok(segment.artifacts.keyframes.count > 0, 'the committed window carries real keyframes');
    assert.equal(segment.artifacts.audio.present, false);
    assert.equal(segment.artifacts.audio.issue, 'KI-044');

    const read = await readRecording(root, explicit);
    assert.equal(read.manifest.video.codec, 'jpeg');
    assert.ok(read.manifest.video.width > 0 && read.manifest.video.width <= 320,
      'the encoded width is the surface itself when it is smaller, and never above the declared bound');
    assert.ok(read.manifest.video.height > 0);
    assert.equal(read.keyframes.length, read.manifest.video.frames);
    assert.equal(read.keyframes[0].atMs, 0);
    assert.ok(read.keyframes.at(-1).atMs >= read.keyframes[0].atMs);
    assert.ok(read.keyframes[0].sequence > 0, 'the game frame sequence rides on the same clock');
    const first = await readFile(path.join(dir, read.keyframes[0].path));
    assert.equal(first.subarray(0, 3).toString('hex'), 'ffd8ff', 'a keyframe is a real JPEG');
    assert.ok(first.length > 200);

    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(game.id).state, 'running', 'closing the desktop never stops the game');
    await server.sessions.stop(game.id);
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
