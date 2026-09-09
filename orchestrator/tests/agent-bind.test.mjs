import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stateDirectories } from '../agents/bind.mjs';

/* Binding a hand-started CLI has to find the instance that already serves the project. Which
   directory the launcher chose for its state is the launcher's business: an owner's own launcher
   names its own (.../state/redit/<project>), and one named anything but `rengine` used to be
   invisible even though its sidecar descriptor sat in plain sight. So the descriptor is what
   discovery looks for, not the directory's name. */
test('state discovery finds a live instance wherever its launcher put the directory', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'rengine-state-'));
  try {
    const sidecar = async directory => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'sidecar.json'), '{}');
      return directory;
    };
    const base = path.join(home, 'rengine');
    const child = await sidecar(path.join(base, 'project-123'));
    const nested = await sidecar(path.join(home, 'redit', 'hirebase-v2'));
    const beside = await sidecar(path.join(home, 'another-launcher'));
    // Noise: no descriptor at either depth, so neither is a candidate.
    await mkdir(path.join(home, 'unrelated', 'deep'), { recursive: true });

    const found = await stateDirectories(undefined, home);
    assert.ok(found.includes(base), 'the rengine base is still a candidate');
    assert.ok(found.includes(child), 'so are its children');
    assert.ok(found.includes(nested), 'a descriptor two levels down is found');
    assert.ok(found.includes(beside), 'so is one beside the base');
    assert.ok(!found.some(entry => entry.includes('unrelated')),
      'a directory with no descriptor is not scanned');
    assert.equal(new Set(found).size, found.length, 'no directory is offered twice');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an explicit state directory is used alone', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'rengine-state-'));
  try {
    await mkdir(path.join(home, 'rengine'), { recursive: true });
    assert.deepEqual(await stateDirectories(path.join(home, 'named'), home), [path.join(home, 'named')]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a home with nothing in it scans the base and stops', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'rengine-state-'));
  try {
    assert.deepEqual(await stateDirectories(undefined, home), [path.join(home, 'rengine')]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
