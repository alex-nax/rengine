import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ensureSidecar, request } from '../launcher/sidecar.mjs';

test('simultaneous launchers share one live sidecar and reattach after launcher exit', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-launch-'));
  let instance;
  t.after(async () => {
    if (instance) {
      process.kill(instance.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(instance.pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const pair = await Promise.all([ensureSidecar(directory), ensureSidecar(directory)]);
  instance = pair[0];
  assert.equal(pair[1].pid, instance.pid);
  assert.equal(pair[1].instance, instance.instance);
  const root = await request(instance, 'roots', { path: directory });
  assert.equal((await request(instance, 'state')).roots[0].id, root.id);
  assert.equal((await ensureSidecar(directory)).pid, instance.pid);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).instance, instance.instance);
});
