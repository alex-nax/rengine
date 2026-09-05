import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('actual NOLF renders and accepts menu input in the C/microui workspace', { timeout: 60000 }, async () => {
  assert.equal(process.platform, 'darwin', 'This check currently qualifies the macOS game adapter.');
  assert.ok(process.env.RENGINE_NOLF_ROOT, 'Set RENGINE_NOLF_ROOT to an actual built NOLF checkout.');
  const source = path.resolve(process.env.RENGINE_NOLF_ROOT);
  const directory = await mkdtemp(path.resolve('.cache/native-nolf-'));
  for (const sub of ['build', 'nolf/Custom', 'assets']) await mkdir(path.join(directory, sub), { recursive: true });
  await copyFile(path.join(source, 'build/relith-nolf'), path.join(directory, 'build/relith-nolf'), constants.COPYFILE_FICLONE);
  for (const sub of ['nolf', 'nolf/Custom', 'assets']) for (const entry of await readdir(path.join(source, sub), { withFileTypes: true })) {
    if (entry.isFile() && /\.rez$/i.test(entry.name)) await symlink(path.join(source, sub, entry.name), path.join(directory, sub, entry.name));
  }
  let server, gui, game;
  try {
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const root = await server.store.addRoot(directory);
    game = await server.games.launch(root.id);
    gui = await nativeClient(server, { root: root.id, game: game.id });
    let state = await gui.until(s => s.tabs.some(t => t?.session === game.id && t.sequence > 5), 'actual NOLF texture');
    let tab = state.tabs.find(t => t?.session === game.id);
    await gui.command({ op: 'snapshot', path: path.join(directory, 'menu.bmp') });
    const before = Buffer.from(server.games.items.get(game.id).latest);
    await gui.click(tab.rect[0] + tab.rect[2] / 2, tab.rect[1] + tab.rect[3] / 2);
    await gui.key('Return'); await delay(500);
    const after = server.games.items.get(game.id).latest;
    assert.ok(!before.subarray(24).equals(after.subarray(24)), 'NOLF menu image changes after native Enter input.');
    await gui.command({ op: 'snapshot', path: path.join(directory, 'after-enter.bmp') });
    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(game.id).pid, game.pid);
    assert.equal(server.sessions.snapshot(game.id).state, 'running');
    gui = await nativeClient(server, { root: root.id });
    await gui.until(s => s.tabs.some(t => t?.session === game.id && t.sequence > tab.sequence), 'same NOLF process after GUI restart');
    await server.sessions.stop(game.id);
    for (let i = 0; i < 200 && server.sessions.snapshot(game.id).state !== 'exited'; i++) await delay(20);
    assert.equal(server.sessions.snapshot(game.id).state, 'exited');
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ source, pid: game.pid, session: game.id, nativeGui: true, frames: tab.sequence, scope: 'menu/input/restart/Stop' }, null, 2));
    console.log(`Native NOLF evidence: ${directory}`);
  } finally {
    if (game) await writeFile(path.join(directory, 'game.log'), server.sessions.snapshot(game.id, true).output);
    await gui?.close(); await server?.close();
  }
});
