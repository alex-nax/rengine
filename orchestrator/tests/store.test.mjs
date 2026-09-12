import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../server/store-client.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = [path.join(dir, 'a'), path.join(dir, 'b')];
  for (const root of roots) { await mkdir(root); await writeFile(path.join(root, 'same.txt'), 'original\r\n'); }
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  return { dir, roots, store, a: await store.addRoot(roots[0]), b: await store.addRoot(roots[1]) };
}

test('root identity and drafts survive restart without writing either working file', async t => {
  const { dir, roots, store, a, b } = await fixture(t);
  const file = await store.readText(a.id, 'same.txt');
  await store.putDraft({ rootId: a.id, path: 'same.txt', text: 'draft\n', baseVersion: file.version });
  const restored = await WorkspaceStore.open(path.join(dir, 'state'));
  assert.equal((await restored.addRoot(roots[0])).id, a.id);
  assert.equal(restored.getDraft(a.id, 'same.txt').text, 'draft\n');
  assert.equal(restored.getDraft(b.id, 'same.txt'), null);
  for (const root of roots) assert.equal(await readFile(path.join(root, 'same.txt'), 'utf8'), 'original\r\n');
  await restored.saveText({ rootId: a.id, path: 'same.txt', text: 'saved\n', version: file.version });
  assert.equal(await readFile(path.join(roots[0], 'same.txt'), 'utf8'), 'saved\r\n');
  assert.equal(await readFile(path.join(roots[1], 'same.txt'), 'utf8'), 'original\r\n');
  assert.equal(restored.getDraft(a.id, 'same.txt'), null);
});

test('an external edit rejects stale Save and preserves the recovery draft', async t => {
  const { roots, store, a } = await fixture(t);
  const file = await store.readText(a.id, 'same.txt');
  await store.putDraft({ rootId: a.id, path: 'same.txt', text: 'my edits', baseVersion: file.version });
  await writeFile(path.join(roots[0], 'same.txt'), 'agent edits');
  await assert.rejects(store.saveText({ rootId: a.id, path: 'same.txt', text: 'my edits', version: file.version }), /changed on disk/);
  assert.equal(await readFile(path.join(roots[0], 'same.txt'), 'utf8'), 'agent edits');
  assert.equal(store.getDraft(a.id, 'same.txt').text, 'my edits');
});

test('tree and file access reject traversal and external symlinks', async t => {
  const { roots, store, a } = await fixture(t);
  assert.equal((await store.list(a.id, '')).entries[0].name, 'same.txt');
  await assert.rejects(store.readText(a.id, '../b/same.txt'), /outside/);
  await symlink(path.join(roots[1], 'same.txt'), path.join(roots[0], 'outside.txt'));
  await assert.rejects(store.readText(a.id, 'outside.txt'), /outside/);
  await writeFile(path.join(roots[0], 'binary.dat'), Buffer.from([0, 255, 1]));
  await assert.rejects(store.readText(a.id, 'binary.dat'), /text|binary/);
});
