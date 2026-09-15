import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, access, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { cooperativeGame, game, gameProject, gamesDeclaration } from './game-fixtures.mjs';

/* Spec 078, F77. `cooperative` is `embedded` minus the injection: a game whose own engine speaks the
   surface protocol connects itself, and rEngine must never also inject the SDL2 adapter into it —
   two producers would greet the same token on the same channel, `Surfaces` destroys whichever
   arrives second, and both sides reconnect, so the survivor is a restart race. The fixture producer
   stands in for such a consumer, so nothing here needs a real game binary. */
const waitOutput = async (server, id, text) => {
  for (let i = 0; i < 200; i++) { if (server.sessions.snapshot(id, true).output.includes(text)) return server.sessions.snapshot(id, true).output; await delay(50); }
  throw new Error(`session never printed ${text}: ${server.sessions.snapshot(id, true).output}`);
};
const waitExit = async (server, id) => { for (let i = 0; i < 200 && server.sessions.snapshot(id).state !== 'exited'; i++) await delay(20); return server.sessions.snapshot(id).state; };
/* The environment rEngine composes is composed in red-host now (F155, spec 142), so it cannot be
   captured by wrapping a method in this process. THE injection-race claim moved with it, to
   `games::surface_environment`'s own test where the composition is — which is also the only place
   it can be made: macOS purges DYLD_* before a protected interpreter can report its own
   environment, so a cooperative game reporting "no injection" cannot be told apart from one that
   was injected and purged. What this spec asserts is the OBSERVABLE half, end to end. */

/* Whether a surface is reserved for a pane, asked the way a person's desktop asks: by attaching a
   viewer. A pane with no reservation is closed with the door's own sentence, which is better
   evidence than counting an internal map — it is the consequence the reservation exists for. */
async function attaches(server, id) {
  const viewer = new WebSocket(`${server.url.replace('http', 'ws')}/surface?${new URLSearchParams({ token: server.token, id })}`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the viewer neither opened nor closed')), 10000);
      viewer.on('error', () => { clearTimeout(timer); resolve(null); });
      viewer.on('close', () => { clearTimeout(timer); resolve(null); });
      /* The status is TEXT. A running game's latest frame can arrive first and is binary, so a
         handler that parsed whatever came would parse a picture. */
      viewer.on('message', (bytes, binary) => {
        if (binary) return;
        clearTimeout(timer); resolve(JSON.parse(bytes));
      });
    });
  } finally { viewer.removeAllListeners(); viewer.close(); }
}
const scratch = async name => realpath(await mkdtemp(path.join(tmpdir(), `rengine-cooperative-${name}-`)));

/* THE injection-race regression, deliberately alone in its own test with its own launch: held
   inside the larger test below, an earlier assertion failing for another reason would mask it, and
   a regression that never fails for its own reason is an assertion with no evidence behind it. The
   sabotage it is written against is a FUTURE edit that injects into the cooperative path while
   leaving everything else intact — so the first thing asserted, before anything easier, is that the
   composed environment carries no injection variable at all. */
test('a cooperative game is handed a usable token, its own env, and no injection it can see', { timeout: 40000 }, async t => {
  const directory = await scratch('injection');
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const root = await server.store.addRoot(await gameProject(directory, 'coop', gamesDeclaration([cooperativeGame()])));

  const session = await request(server, 'game', { rootId: root.id, gameId: 'fixture-cooperative' });
  /* What the game itself was handed, said by the game itself. `inject=none` is corroboration on
     macOS — dyld purges DYLD_* before this fixture sees them — and the load-bearing half of the
     claim is asserted where the environment is COMPOSED, in
     `red-host/src/games.rs::a_cooperative_game_is_handed_no_injection_and_an_embedded_one_is`.
     What this proves is the consequence: the game received a usable token and connected with it,
     which an injected second producer would have raced for. */
  const started = await waitOutput(server, session.id, 'COOPERATIVE_STARTED');
  assert.match(started, /token=64 inject=none/, 'the game sees a 64-character token and no injection it can observe');
  assert.match(started, /flavour=violet/, "the record's own env survives beside the surface variables");
  const status = await attaches(server, session.id);
  assert.ok(status, 'a surface was reserved for it, or no viewer could attach');
  assert.equal(status.type, 'surface');
  await server.sessions.stop(session.id); assert.equal(await waitExit(server, session.id), 'exited');
});

test('a cooperative game preflights with no adapter and no platform gate, connects itself and streams to a viewer', { timeout: 40000 }, async t => {
  const directory = await scratch('stream');
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await gameProject(directory, 'coop', gamesDeclaration([cooperativeGame(), game()]));
  const root = await server.store.addRoot(rootPath);

  /* Portable by construction, so no adapter and no platform issue on any platform. */
  const config = await request(server, `game-config?${new URLSearchParams({ rootId: root.id, gameId: 'fixture-cooperative' })}`);
  assert.equal(config.surface, 'cooperative');
  assert.equal(config.adapter, undefined, 'a cooperative game reports no adapter');
  assert.deepEqual(config.issues, [], `ready on ${process.platform}: ${config.issues.join(' ')}`);
  assert.equal(config.ready, true);
  const listed = await request(server, `formats?${new URLSearchParams({ rootId: root.id })}`);
  assert.deepEqual(listed.games.map(x => x.surface), ['cooperative', 'external']);

  const session = await request(server, 'game', { rootId: root.id, gameId: 'fixture-cooperative' });
  assert.equal(session.type, 'game'); assert.equal(session.surface, 'cooperative'); assert.equal(session.game, 'fixture-cooperative');
  assert.equal(session.title, 'Fixture co-op · coop');
  const started = await waitOutput(server, session.id, 'COOPERATIVE_STARTED');
  assert.match(started, /token=64 inject=none/, 'the game itself sees the token and no injection');
  assert.match(started, /flavour=violet/);

  /* Its own connection carries frames to the door and on to a viewer of the live pane. The door's
     own account of the surface is what a viewer is told on attaching — the status and the count —
     so that is what this reads, rather than an internal map it no longer has. */
  let status = null;
  for (let i = 0; i < 200 && !(status?.status === 'Live' && status.frameCount >= 2); i++) {
    status = await attaches(server, session.id);
    if (status?.status === 'Live' && status.frameCount >= 2) break;
    await delay(50);
  }
  assert.ok(status, 'a cooperative game reserves a surface, exactly as embedded does');
  assert.equal(status.status, 'Live', 'both halves of its own connection arrived');
  assert.ok(status.frameCount >= 2, `frames reached the door: ${status.frameCount}`);

  /* Two frames with different sequence numbers, not one: attaching replays the latest frame the
     server already holds, so a single frame would pass with the live fan-out to viewers removed. */
  const viewer = new WebSocket(`${server.url.replace('http', 'ws')}/surface?${new URLSearchParams({ token: server.token, id: session.id })}`);
  const received = [];
  const frames = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the viewer received ${received.length} frame(s) while the server holds ${item.frameCount}`)), 15000);
    viewer.on('error', reject);
    viewer.on('close', (code, reason) => reject(new Error(`the viewer was closed before its frames: ${code} ${reason}`)));
    viewer.on('message', (bytes, binary) => {
      if (!binary) return;
      received.push(Buffer.from(bytes));
      if (received.length === 2) { clearTimeout(timer); resolve(received); }
    });
  });
  viewer.removeAllListeners('close'); viewer.close();
  for (const frame of frames) {
    assert.equal(frame.readUInt32LE(0), 0x31464752, 'the viewer receives the framed protocol');
    /* The dimensions the fixture draws at, read off the frame the viewer got: with the surface's
       own record gone from this process, the frame IS where the size is stated. */
    assert.equal(frame.readUInt32LE(4), 8); assert.equal(frame.readUInt32LE(8), 4);
    assert.equal(frame.length, 24 + 8 * 4 * 4);
  }
  assert.notEqual(frames[0].readUInt32LE(12), frames[1].readUInt32LE(12), 'the pane keeps receiving new frames, not one replayed on attach');

  await server.sessions.stop(session.id);
  assert.equal(await waitExit(server, session.id), 'exited');
  /* And the reservation goes with the pane: a viewer attaching to an exited game is closed rather
     than left watching a picture that will never change again. */
  let after = await attaches(server, session.id);
  for (let i = 0; i < 100 && after; i++) { await delay(20); after = await attaches(server, session.id); }
  assert.equal(after, null, 'the reservation is released when the session exits');
});

test('embedded still injects the adapter on macOS, external still reserves nothing', { timeout: 40000 }, async t => {
  const directory = await scratch('peers');
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  const adapter = path.resolve('.cache/native/librengine_surface.dylib');
  let placeholder = false;
  t.after(async () => {
    if (placeholder) await rm(adapter, { force: true });
    await server.close(); await rm(directory, { recursive: true, force: true });
  });
  const rootPath = await gameProject(directory, 'peers', gamesDeclaration([game(), cooperativeGame({ id: 'fixture-embedded', title: 'Fixture embed', surface: 'embedded' })]));
  const root = await server.store.addRoot(rootPath);

  const external = await request(server, 'game', { rootId: root.id, gameId: 'fixture-game' });
  const externalStarted = await waitOutput(server, external.id, 'FIXTURE_GAME_STARTED');
  assert.equal(await attaches(server, external.id), null, 'external reserves no surface, so no viewer can attach');
  /* Said by the game: an external one is handed no surface variables at all, which is what leaves
     it nothing to connect with. The composition itself is asserted in
     `red-host/src/games.rs::a_cooperative_game_is_handed_no_injection_and_an_embedded_one_is`. */
  assert.match(externalStarted, /surface=$|surface=\s/m, 'external is handed no surface reservation at all');
  await server.sessions.stop(external.id); assert.equal(await waitExit(server, external.id), 'exited');

  if (process.platform !== 'darwin') {
    const config = await request(server, `game-config?${new URLSearchParams({ rootId: root.id, gameId: 'fixture-embedded' })}`);
    assert.ok(config.issues.some(issue => /qualification on this platform/.test(issue)), 'embedded keeps the platform gate a cooperative game never inherits');
    return;
  }
  /* The adapter is an artifact of `npm run build:surface`, not of `npm test`. The assertion is about
     the environment rEngine composes, not about loading the library, so a placeholder is enough when
     the real one has not been built; a real one is never touched. */
  try { await access(adapter); } catch { await mkdir(path.dirname(adapter), { recursive: true }); await writeFile(adapter, ''); placeholder = true; }
  const embedded = await request(server, 'game', { rootId: root.id, gameId: 'fixture-embedded' });
  assert.equal(embedded.surface, 'embedded');
  assert.ok(await attaches(server, embedded.id), 'embedded reserves a surface too');
  /* That the adapter is INJECTED cannot be asserted from here: dyld purges DYLD_* before a
     protected interpreter sees them, so the child cannot report it and this process no longer
     composes it. The claim lives where the composition does — see the Rust test named above, which
     is sabotage-verified against a cooperative game being injected and against an inherited
     injection being dropped. */
  await server.sessions.stop(embedded.id); assert.equal(await waitExit(server, embedded.id), 'exited');
});
