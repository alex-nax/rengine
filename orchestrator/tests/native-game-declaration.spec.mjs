import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { gameProject, launcherDeclaration } from './game-fixtures.mjs';

/* The toolbar carries no game control at all (owner decision 2026-09-06, spec 078): games are
   launched from dashboard game actions, so this fixture drives that path end to end. */
test('a dashboard game action launches the declared game in its own window while the toolbar carries no game control', { timeout: 90000 }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-native-game-action-')));
  let server, gui;
  try {
    const plainPath = path.join(dir, 'plain'); await mkdir(plainPath); await writeFile(path.join(plainPath, 'note.txt'), 'plain\n');
    server = await startServer({ stateDir: path.join(dir, 'state') });
    const plain = await server.store.addRoot(plainPath);
    const declared = await server.store.addRoot(await gameProject(dir, 'declared', launcherDeclaration()));
    gui = await nativeClient(server, { root: plain.id });
    let state = await gui.until(s => s.connected && s.controls?.some(c => c.role === 'toolbar' && c.key === 'Root'), 'connected toolbar');
    const toolbarKeys = s => s.controls.filter(c => c.role === 'toolbar' && c.tab === -1).map(c => c.key);
    assert.deepEqual(toolbarKeys(state).filter(k => k !== 'Root'),
      ['Tree', 'Dashboard', 'Shell', 'Agent', 'Manage', 'Sessions', 'Split vertical', 'Split horizontal', 'Merge pane', 'Add project'],
      'row one is a fixed set of columns with no game control');
    assert.equal(state.games, undefined, 'the desktop no longer publishes a toolbar game list');

    await gui.control('toolbar', 'Root');
    state = await gui.until(s => s.root === declared.id && s.tabs.some(t => t?.type === 6 && t.root === declared.id && t.dashboard?.groups?.length === 1),
      'the declared root opens its dashboard');
    const board = state.tabs.findIndex(t => t?.type === 6 && t.root === declared.id);
    for (let i = 0; i < 5; i++) {
      state = await gui.command({ op: 'state' });
      assert.equal(state.controls.find(c => c.role === 'toolbar' && ['Games', 'Fixture game'].includes(c.key)), undefined, 'no game button for a root that declares games');
      assert.equal(state.controls.find(c => c.role === 'game' || c.role === 'game-unavailable'), undefined, 'no games menu exists');
      await delay(100);
    }
    const actions = () => Object.fromEntries(state.tabs[board].dashboard.groups.flatMap(g => g.actions).map(a => [a.id, a]));
    assert.equal(actions().play.available, true);
    assert.equal(actions()['play-absent'].available, false);
    assert.deepEqual(actions()['play-absent'].missing, [{ type: 'game', name: 'Game executable not found; expected build/absent-game in the selected project.' }]);
    assert.ok(state.controls.some(c => c.tab === board && c.role === 'dashboard-action' && c.key === 'play'));
    assert.ok(state.controls.some(c => c.tab === board && c.role === 'dashboard-unavailable' && c.key === 'play-absent'), 'an unbuilt record is a label, not a button');
    assert.ok(!state.controls.some(c => c.tab === board && c.role === 'dashboard-action' && c.key === 'play-absent'));

    await gui.control('dashboard-action', 'play', board);
    state = await gui.until(s => s.state.sessions.some(x => x.type === 'game' && x.state === 'running'), 'game session launched from the dashboard action');
    const session = state.state.sessions.find(x => x.type === 'game');
    assert.equal(session.surface, 'external'); assert.equal(session.game, 'fixture-game');
    assert.equal(session.title, 'Fixture game · declared'); assert.equal(session.rootId, declared.id);
    state = await gui.until(s => s.tabs.some(t => t?.session === session.id && t.text?.includes('flavour=blue')), 'external game output in its tab');
    const tab = state.tabs.find(t => t?.session === session.id), index = state.tabs.indexOf(tab);
    assert.equal(tab.type, 5); assert.equal(tab.title, 'Fixture game · declared'); assert.match(tab.text, /FIXTURE_GAME_STARTED args=--flat --width 640/);
    assert.ok(state.controls.some(c => c.role === 'game-status' && c.key === 'running' && c.tab === index), 'running status row');
    assert.equal(server.games.surfaces.items.size, 0, 'no surface reservation for an external game');
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-game-action.bmp') }), true);

    await gui.control('tab', '', board);
    await gui.control('dashboard-action', 'play', board); await delay(600);
    state = await gui.command({ op: 'state' });
    assert.equal(state.state.sessions.filter(x => x.type === 'game').length, 1, 'a second click on the same action reuses the running session');
    await gui.control('dashboard-action', 'play-newgame', board);
    state = await gui.until(s => /already running with different arguments/.test(s.status), 'a different-argv action is refused, not silently attached');
    assert.equal(state.state.sessions.filter(x => x.type === 'game').length, 1);
    await gui.control('dashboard-action', 'play-second', board);
    state = await gui.until(s => s.state.sessions.filter(x => x.type === 'game' && x.state === 'running').length === 2, 'a second declared game runs beside the first');

    await gui.control('toolbar', 'Sessions'); await gui.control('stop', session.id);
    state = await gui.until(s => s.state.sessions.find(x => x.id === session.id)?.state === 'exited', 'explicit Stop from Sessions');
    await gui.control('tab', '', index);
    await gui.until(s => s.controls.some(c => c.role === 'game-status' && c.key === 'exited' && c.tab === index), 'exited status row');
    assert.equal(server.sessions.snapshot(session.id).state, 'exited');
    for (const item of state.state.sessions.filter(x => x.type === 'game' && x.state === 'running')) await server.sessions.stop(item.id);
    await gui.close(); gui = null;
  } finally { await gui?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
});
