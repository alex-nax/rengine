/* F192 (spec 134 D1/D2/D3/D4): the Projects modal.
 *
 * Thirty worktrees accumulated in this repository unseen because nothing in the product knew they
 * existed. This is where they become visible — and it is also the one place a project is chosen or
 * added, because the toolbar's switcher and its path field were two halves of one gesture and the
 * old menu had to apologise for the split ("Type a project path in the toolbar, then choose Add
 * project").
 *
 * A worktree is a distinct ROOT (charter D20), so the modal offers to ADD one rather than to
 * switch checkouts, and the repository is a heading in the view rather than a record in the store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './red-host-fixture.mjs';
import { nativeClient } from './native-client.mjs';

const run = promisify(execFile);
const RE_OVERLAY_PROJECTS = 5;
const keys = (state, role) => state.controls.filter(c => c.role === role).map(c => c.key);

test('the Projects modal opens from the status bar and offers the repository\'s worktrees', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-projects-modal-'));
  const repo = path.join(directory, 'repo');
  await mkdir(repo, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'f@example.invalid'], ['config', 'user.name', 'F']]) {
    await run('git', args, { cwd: repo });
  }
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await run('git', ['add', 'a.txt'], { cwd: repo });
  await run('git', ['commit', '-qm', 'first'], { cwd: repo });
  await run('git', ['branch', 'side'], { cwd: repo });
  await run('git', ['worktree', 'add', '-q', path.join(directory, 'side'), 'side'], { cwd: repo });
  await run('git', ['branch', 'vanished'], { cwd: repo });
  await run('git', ['worktree', 'add', '-q', path.join(directory, 'vanished'), 'vanished'], { cwd: repo });
  await rm(path.join(directory, 'vanished'), { recursive: true, force: true });

  const server = await startServer({ stateDir: path.join(directory, 'state') });
  const root = await server.store.addRoot(repo);
  const gui = await nativeClient(server, { root: root.id });
  t.after(async () => { await gui.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects');

  /* The toolbar no longer carries either half of the old gesture. */
  const start = await gui.until(s => s.controls.length > 0, 'the toolbar drew');
  assert.ok(!keys(start, 'toolbar').includes('Root'), 'no project switcher in the toolbar');
  assert.ok(!keys(start, 'toolbar').includes('Add project'), 'and no Add project button');
  assert.ok(!start.controls.some(c => c.role === 'textbox' && c.key === 'project'),
    'and no project path field');
  assert.ok(start.controls.some(c => c.role === 'project' && c.key === 'segment'),
    'the status bar names the project instead');

  /* Pressing the status bar's project segment opens the modal. */
  await gui.control('project', 'segment', -1);
  const open = await gui.until(s => s.overlay === RE_OVERLAY_PROJECTS, 'the Projects modal opened');
  assert.ok(keys(open, 'menu-root').includes('repo'), 'it lists the workspace\'s projects');
  assert.ok(keys(open, 'menu-root').includes('Add project'), 'and carries Add project with its own field');
  assert.ok(open.controls.some(c => c.role === 'textbox' && c.key === 'project'),
    'the path field is in the modal now, beside the button that uses it');

  /* The repository's other worktree is offered — it is not a root yet. */
  const surveyed = await gui.until(s => keys(s, 'menu-worktree').includes('side'),
    'the repository\'s other worktree is offered');
  assert.ok(!keys(surveyed, 'menu-root').includes('side'), 'and it is not already a project');

  /* A worktree git still lists but whose directory is gone is SHOWN with the reason and cannot be
     added: spec 002's rule for a checkout that is not there — report it, never guess. */
  assert.ok(keys(surveyed, 'menu-worktree').includes('vanished'), 'the missing worktree is listed too');
  const missing = surveyed.worktrees.rows.find(r => r.branch === 'vanished');
  assert.equal(missing.present, false, 'and the survey says its directory is gone');
  await gui.control('menu-worktree', 'vanished', -1);
  const still = await gui.until(s => s.overlay === RE_OVERLAY_PROJECTS, 'the modal stays open');
  assert.equal(still.state.roots.length, 1, 'pressing a worktree that is not there adds nothing');

  /* Adding it makes it a root of its own, which is what charter D20 says a worktree is. */
  await gui.control('menu-worktree', 'side', -1);
  await gui.until(s => s.state.roots.some(r => r.path.endsWith('/side')), 'the worktree became a project');
  const after = await gui.until(s => s.overlay !== RE_OVERLAY_PROJECTS, 'and the modal closed behind it');
  assert.equal(after.state.roots.length, 2, 'two roots, one repository');

  /* Re-opened, it is a project rather than an offer: two worktrees of one repository are two
     distinct roots (spec 002), and the modal stops offering what the workspace already holds. */
  await gui.control('project', 'segment', -1);
  /* Waited on the ANSWER, not on a frame: an offer list that has not arrived reads exactly like an
     empty one, and asserting on the difference is how this spec earns its keep. */
  const again = await gui.until(s => s.overlay === RE_OVERLAY_PROJECTS && s.worktrees.rows.length > 0
    && s.worktrees.rows.some(r => r.branch === 'side' && r.isRoot), 'the survey came back with side as a project');
  assert.ok(!keys(again, 'menu-worktree').includes('side'), 'the added worktree is no longer offered');
  assert.ok(keys(again, 'menu-worktree').includes('vanished'), 'and the one that is still not a project is');
});
