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
    await gui.key('Escape');
    await gui.until(s => s.tabs.some(t => t?.session === game.id && !t.captured), 'Escape releases native capture');
    for (let i = 0; i < 100 && !server.sessions.snapshot(game.id, true).output.includes('key 26 0'); i++) await delay(20);
    assert.match(server.sessions.snapshot(game.id, true).output, /key 26 0/);
    assert.doesNotMatch(server.sessions.snapshot(game.id, true).output, /key 41 1/);
    await gui.key('Escape');
    for (let i = 0; i < 100 && !server.sessions.snapshot(game.id, true).output.includes('key 41 1'); i++) await delay(20);
    assert.match(server.sessions.snapshot(game.id, true).output, /key 41 1/);
    await mkdir('.cache/evidence', { recursive: true });
    await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-game.bmp') });
    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(game.id).state, 'running');
    await server.sessions.stop(game.id);
    for (let i = 0; i < 150 && server.sessions.snapshot(game.id).state !== 'exited'; i++) await delay(20);
    assert.equal(server.sessions.snapshot(game.id).state, 'exited');
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
