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
/* The environment rEngine composes, captured where it is composed. macOS purges DYLD_* before a
   protected interpreter can report its own environment, so the child's view cannot carry this. */
function watchLaunches(server) {
  const seen = [];
  const original = server.sessions.terminal.bind(server.sessions);
  server.sessions.terminal = options => { seen.push(options); return original(options); };
  return seen;
}
const injectionKeys = env => Object.keys(env ?? {}).filter(key => /^(?:DYLD_|LD_)/.test(key));
const scratch = async name => realpath(await mkdtemp(path.join(tmpdir(), `rengine-cooperative-${name}-`)));

/* THE injection-race regression, deliberately alone in its own test with its own launch: held
   inside the larger test below, an earlier assertion failing for another reason would mask it, and
   a regression that never fails for its own reason is an assertion with no evidence behind it. The
   sabotage it is written against is a FUTURE edit that injects into the cooperative path while
   leaving everything else intact — so the first thing asserted, before anything easier, is that the
   composed environment carries no injection variable at all. */
test('the launch environment of a cooperative game carries no injection variable at all', { timeout: 40000 }, async t => {
  const directory = await scratch('injection');
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const launches = watchLaunches(server);
  const root = await server.store.addRoot(await gameProject(directory, 'coop', gamesDeclaration([cooperativeGame()])));

  const session = await request(server, 'game', { rootId: root.id, gameId: 'fixture-cooperative' });
  const composed = launches.find(options => options.game === 'fixture-cooperative');
  assert.ok(composed, 'the cooperative launch was seen');
  assert.deepEqual(injectionKeys(composed.env), [],
    `no injection variable may reach a cooperative game, or its own connection races an injected one: ${JSON.stringify(composed.env)}`);
  assert.equal('DYLD_INSERT_LIBRARIES' in composed.env, false);
  /* The other half of the same environment, asserted after it so it can never stand in for it. */
  assert.match(composed.env.RENGINE_SURFACE_PORT, /^\d+$/);
  assert.match(composed.env.RENGINE_SURFACE_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(composed.env.FIXTURE_FLAVOUR, 'violet', "the record's own env survives beside the surface variables");
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
  assert.equal(server.games.surfaces.items.size, 1, 'a cooperative game reserves a surface, exactly as embedded does');
  assert.equal(server.games.items.size, 1, 'and the session is bound to that item, or no viewer can attach');

  const started = await waitOutput(server, session.id, 'COOPERATIVE_STARTED');
  assert.match(started, /token=64 inject=none/, 'the game itself sees the token and no injection');
  assert.match(started, /flavour=violet/);

  /* Its own connection carries frames to the server and on to a viewer of the live pane. */
  const item = [...server.games.surfaces.items.values()][0];
  for (let i = 0; i < 200 && item.frameCount < 2; i++) await delay(50);
  assert.ok(item.frameCount >= 2, `frames reached the server: ${item.frameCount}`);
  assert.equal(item.width, 8); assert.equal(item.height, 4); assert.equal(item.status, 'Live');

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
    assert.equal(frame.readUInt32LE(4), 8); assert.equal(frame.readUInt32LE(8), 4);
    assert.equal(frame.length, 24 + 8 * 4 * 4);
  }
  assert.notEqual(frames[0].readUInt32LE(12), frames[1].readUInt32LE(12), 'the pane keeps receiving new frames, not one replayed on attach');

  await server.sessions.stop(session.id);
  assert.equal(await waitExit(server, session.id), 'exited');
  for (let i = 0; i < 100 && server.games.surfaces.items.size; i++) await delay(20);
  assert.equal(server.games.surfaces.items.size, 0, 'the reservation is released when the session exits');
  assert.equal(server.games.items.size, 0);
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
  const launches = watchLaunches(server);
  const rootPath = await gameProject(directory, 'peers', gamesDeclaration([game(), cooperativeGame({ id: 'fixture-embedded', title: 'Fixture embed', surface: 'embedded' })]));
  const root = await server.store.addRoot(rootPath);

  const external = await request(server, 'game', { rootId: root.id, gameId: 'fixture-game' });
  await waitOutput(server, external.id, 'FIXTURE_GAME_STARTED');
  assert.equal(server.games.surfaces.items.size, 0, 'external reserves no surface');
  const externalEnv = launches.find(options => options.game === 'fixture-game').env;
  assert.equal(externalEnv.RENGINE_SURFACE_TOKEN, undefined, 'external is passed no surface variables');
  assert.deepEqual(injectionKeys(externalEnv), []);
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
  assert.equal(server.games.surfaces.items.size, 1, 'embedded reserves a surface too');
  const embeddedEnv = launches.find(options => options.game === 'fixture-embedded').env;
  assert.match(embeddedEnv.RENGINE_SURFACE_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(embeddedEnv.DYLD_INSERT_LIBRARIES, /librengine_surface\.dylib(?::|$)/, 'embedded is still injected');
  await server.sessions.stop(embedded.id); assert.equal(await waitExit(server, embedded.id), 'exited');
});
