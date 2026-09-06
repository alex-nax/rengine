import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { nativeClient } from './native-client.mjs';
import { cooperativeGame, gameProject, gamesDeclaration } from './game-fixtures.mjs';

/* Spec 078, F77: a cooperative session is still `type: "game"` carrying its surface, so the native
   game tab must be the live view — the same one an embedded session gets — and must not fall into
   the external tab's stdout-only path. Verified through the real launch route rather than a
   hand-made session, so the whole chain is the one a dashboard game action uses. */
test('the native game tab renders a cooperative session as a live surface, not as retained output', { timeout: 60000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-cooperative-')));
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const rootPath = await gameProject(directory, 'coop', gamesDeclaration([cooperativeGame({ args: ['--width', '64', '--height', '32'] })]));
    const root = await server.store.addRoot(rootPath);
    const session = await request(server, 'game', { rootId: root.id, gameId: 'fixture-cooperative' });
    assert.equal(session.surface, 'cooperative');
    gui = await nativeClient(server, { root: root.id, game: session.id });

    const state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.sequence > 2), 'the cooperative pane receives frames');
    const tab = state.tabs.find(t => t?.session === session.id), index = state.tabs.indexOf(tab);
    assert.equal(tab.type, 5, 'a game tab');
    assert.equal(tab.surface, 'cooperative', 'the snapshot reports the session surface, not a guessed one');
    assert.ok(tab.sequence > 2, `frames arrive: ${tab.sequence}`);
    assert.equal(tab.text, undefined, 'a cooperative tab holds no terminal text');
    assert.equal(state.controls.find(c => c.role === 'game-status' && c.tab === index), undefined, "no external tab's status row");
    assert.equal(server.games.surfaces.items.size, 1);

    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-cooperative.bmp') }), true);
    const advanced = await gui.until(s => s.tabs.find(t => t?.session === session.id)?.sequence > tab.sequence, 'the surface keeps streaming');
    assert.ok(advanced.tabs.find(t => t?.session === session.id).sequence > tab.sequence);

    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(session.id).state, 'running', 'closing the desktop detaches, it does not stop the game');
    await server.sessions.stop(session.id);
    for (let i = 0; i < 200 && server.sessions.snapshot(session.id).state !== 'exited'; i++) await delay(20);
    assert.equal(server.sessions.snapshot(session.id).state, 'exited');
    assert.equal(server.games.surfaces.items.size, 0, 'the reservation is released with the session');
  } finally { await gui?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
});
