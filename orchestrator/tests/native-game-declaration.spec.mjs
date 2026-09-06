import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { gameProject } from './game-fixtures.mjs';

test('the toolbar shows the declared game only, launches it in its own window and stops it from Sessions', { timeout: 60000 }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-game-decl-')));
  let server, gui;
  try {
    const plainPath = path.join(dir, 'plain'); await mkdir(plainPath); await writeFile(path.join(plainPath, 'note.txt'), 'plain\n');
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const plain = await server.store.addRoot(plainPath), declared = await server.store.addRoot(await gameProject(dir, 'declared'));
    gui = await nativeClient(server, { root: plain.id });
    const gameButton = s => s.controls?.find(c => c.role === 'toolbar' && c.key === 'Fixture game');
    let state = await gui.until(s => s.connected && s.controls?.some(c => c.role === 'toolbar' && c.key === 'Root'), 'connected toolbar');
    for (let i = 0; i < 5; i++) { state = await gui.command({ op: 'state' }); assert.equal(gameButton(state), undefined, 'no game button for an undeclared root'); await delay(100); }
    await gui.control('toolbar', 'Root');
    state = await gui.until(s => s.root === declared.id && gameButton(s), 'declared title on the toolbar after switching roots');
    const vim = state.controls.find(c => c.role === 'toolbar' && c.key === 'Merge pane');
    assert.ok(gameButton(state).rect[0] > vim.rect[0], 'the game button follows Merge pane');
    await gui.control('toolbar', 'Fixture game');
    state = await gui.until(s => s.state.sessions.some(x => x.type === 'game' && x.state === 'running'), 'game session launched from the toolbar');
    const session = state.state.sessions.find(x => x.type === 'game');
    assert.equal(session.surface, 'external'); assert.equal(session.game, 'fixture-game'); assert.equal(session.title, 'Fixture game · declared'); assert.equal(session.rootId, declared.id);
    state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('flavour=blue')), 'external game output in its tab');
    const tab = state.tabs.find(t => t?.session === session.id), index = state.tabs.indexOf(tab);
    assert.equal(tab.type, 5); assert.equal(tab.title, 'Fixture game · declared'); assert.match(tab.text, /FIXTURE_GAME_STARTED args=--flat --width 640/);
    assert.ok(state.controls.some(c => c.role === 'game-status' && c.key === 'running' && c.tab === index), 'running status row');
    assert.equal(server.games.surfaces.items.size, 0, 'no surface reservation for an external game');
    await gui.control('toolbar', 'Fixture game'); await delay(500);
    state = await gui.command({ op: 'state' });
    assert.equal(state.state.sessions.filter(x => x.type === 'game').length, 1, 'a second click reuses the running session');
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-game-declaration.bmp') }), true);
    await gui.control('toolbar', 'Sessions'); await gui.control('stop', session.id);
    state = await gui.until(s => s.state.sessions.find(x => x.id === session.id)?.state === 'exited', 'explicit Stop from Sessions');
    await gui.control('tab', '', index);
    await gui.until(s => s.controls.some(c => c.role === 'game-status' && c.key === 'exited' && c.tab === index), 'exited status row');
    assert.equal(server.sessions.snapshot(session.id).state, 'exited');
    await gui.close(); gui = null;
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
