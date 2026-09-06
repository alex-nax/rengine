import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('native game texture streams real SDL frames and releases controls on native Escape', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-game-'));
  let server, gui;
  try {
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const root = await server.store.addRoot(dir);
    const { item, env } = server.games.surfaces.reserve();
    // The fixture links the surface adapter directly on Windows (multi-config build under Release); macOS interposes the dylib.
    const fixture = path.resolve(process.platform === 'win32' ? '.cache/native/Release/rengine_surface_fixture.exe' : '.cache/native/rengine_surface_fixture');
    const game = await server.sessions.terminal({ rootId: root.id, type: 'game', command: fixture, args: ['interactive'],
      env: { ...env, DYLD_INSERT_LIBRARIES: path.resolve('.cache/native/librengine_surface.dylib') } });
    item.id = game.id; server.games.items.set(game.id, item);
    gui = await nativeClient(server, { root: root.id, game: game.id });
    let state = await gui.until(s => s.tabs.some(t => t?.session === game.id && t.sequence > 2), 'native game frame');
    let tab = state.tabs.find(t => t?.session === game.id);
    await gui.click(tab.rect[0] + 50, tab.rect[1] - 17);
    await gui.until(s => s.tabs.some(t => t?.session === game.id && t.captured), 'native relative mouse capture');
    await gui.command({ op: 'key', key: 'W' });
    for (let i = 0; i < 100 && !server.sessions.snapshot(game.id, true).output.includes('key 26 1'); i++) await delay(20);
    assert.match(server.sessions.snapshot(game.id, true).output, /key 26 1/);
    // Escape opens the menu in most games and a menu needs a cursor, so one press has to do both:
    // free the pointer and reach the game. The pane used to consume it, and the owner was pressing
    // twice. Asserting only that capture was released passes with that defect present, so the
    // assertion that matters is the delivered scancode: 41 is Escape.
    const output = () => server.sessions.snapshot(game.id, true).output;
    const settle = async token => { for (let i = 0; i < 100 && !output().includes(token); i++) await delay(20); };
    assert.doesNotMatch(output(), /key 41 1/, 'Escape has not reached the game yet');
    await gui.key('Escape');
    await gui.until(s => s.tabs.some(t => t?.session === game.id && !t.captured), 'Escape releases native capture');
    await settle('key 41 1');
    assert.match(output(), /key 41 1/, 'the same press reaches the game');
    // The player is still holding W, so the workspace does not forge a release for it. The game
    // hears about that key when it actually comes up.
    assert.doesNotMatch(output(), /key 26 0/, 'no forged release while the key is still held');
    await gui.command({ op: 'key', key: 'W', down: false });
    await settle('key 26 0');
    assert.match(output(), /key 26 0/, 'the real release reaches the game');

    // The way out of a game that swallows Escape: the platform modifier with period. It does the
    // full release, which drops held keys, and is never forwarded. Period scancode is 55.
    await gui.click(tab.rect[0] + 50, tab.rect[1] - 17);
    await gui.until(s => s.tabs.some(t => t?.session === game.id && t.captured), 'captured again');
    await gui.command({ op: 'key', key: 'Q' });
    await settle('key 20 1');
    assert.match(output(), /key 20 1/, 'the game is taking keys again');
    await gui.key('.', 1024);   // KMOD_LGUI; the handler accepts Ctrl too, so this drives both platforms
    await gui.until(s => s.tabs.some(t => t?.session === game.id && !t.captured), 'the chord releases capture');
    await settle('key 20 0');
    assert.match(output(), /key 20 0/, 'the full release tells the game to drop held keys');
    assert.doesNotMatch(output(), /key 55 1/, 'the chord itself is not forwarded to the game');
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-game.bmp') });
    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(game.id).state, 'running');
    await server.sessions.stop(game.id);
    for (let i = 0; i < 150 && server.sessions.snapshot(game.id).state !== 'exited'; i++) await delay(20);
    assert.equal(server.sessions.snapshot(game.id).state, 'exited');
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
