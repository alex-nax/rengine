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

    // The fixture prints a line per key event, so a keystroke into the pane is a real game log line
    // travelling the whole path the log slice depends on: game stdout, the session host's PTY, the
    // output event, the desktop's recorder. These are printed BEFORE the segment is marked, which is
    // where a game's interesting output is: the moment worth recording is always just past.
    const printed = text => server.sessions.snapshot(game.id, true).output.includes(text);
    const awaitPrint = async text => { for (let i = 0; i < 150 && !printed(text); i++) await delay(20); assert.ok(printed(text), `the game printed ${text}`); };
    const tab = state.tabs.find(t => t?.session === game.id);
    await gui.click(tab.rect[0] + 50, tab.rect[1] - 17);
    await gui.until(s => s.tabs.some(t => t?.session === game.id && t.captured), 'the pane takes the keyboard');
    await gui.command({ op: 'key', key: 'W' });
    await awaitPrint('key 26 1');
    await gui.key('Escape');   /* releases capture, and the release prints the held key's release */
    await awaitPrint('key 26 0');
    state = await gui.until(s => recording(s)?.logLines > 1, "the pane's rolling buffer holds the game's log lines");

    await gui.control('recording', 'toggle');
    state = await gui.until(s => recording(s)?.state === 'recording', 'the toggle starts an explicit segment');
    // Nothing is printed inside the window: a menu, a stall, a frozen frame. The lines that explain
    // what is on screen are already in the ring, which is the case this segment has to carry.
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
    assert.equal(segment.artifacts.log.present, true, 'the committed segment carries the log slice');
    assert.ok(segment.artifacts.log.lines > 0, 'a segment recorded over a talking game is not a silent one');
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

    // The point of the feature: a frame and the line printed while it was on screen, on one clock.
    // The lines the game printed before the mark are what a reader correlates the picture with, so
    // an explicit segment carries the ring's lines, stamped negative rather than dropped.
    assert.equal(read.manifest.log.lines, read.log.total, 'the manifest counts the lines the slice holds');
    assert.ok(read.log.total >= 2, 'a segment over a ring that holds log lines is not a silent one');
    assert.deepEqual(read.log.lines.map(line => line.text).filter(text => /^key 26 /.test(text)),
      ['key 26 1', 'key 26 0'], "the slice holds the game's own lines, in order, without terminal control bytes");
    for (const line of read.log.lines) {
      assert.equal(typeof line.atMs, 'number', 'every line is stamped on the keyframe clock');
      assert.match(line.wall, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    assert.ok(read.log.lines.at(-1).atMs >= read.log.lines[0].atMs, 'the slice is in clock order');
    assert.ok(read.log.lines.some(line => line.atMs < 0),
      'a line already on the way in when the segment was marked is kept with a negative atMs');
    const ringRead = await readRecording(root, fromRing);
    assert.ok(ringRead.log.total >= read.log.total, 'the ring commit carries the log the ring was holding');
    assert.ok(ringRead.log.lines.some(line => /^key 26 1$/.test(line.text)), 'both gestures produce the same artifact shape');

    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(game.id).state, 'running', 'closing the desktop never stops the game');
    await server.sessions.stop(game.id);
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
