import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureSidecar, request } from '../launcher/sidecar.mjs';
import { endStateServices } from './state-services.mjs';

/* 60s, not the 15s these two were written with: each starts a REAL sidecar, which since D60/D61
   also starts the state directory's PTY and store services, and the suite runs its files
   concurrently. The budget was tight enough to time out under that load about once in three full
   runs — a flake in the report rather than in the product. */
test('game launch prerequisites fail before creating shell or agent sessions', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-preflight-'));
  let instance;
  t.after(async () => {
    if (instance) {
      process.kill(instance.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(instance.pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    /* The host is gone; the directory's own services are not, by design (D60/D61). End them
       before the directory is removed, or they hold a deleted directory for their whole idle. */
    await endStateServices(directory);
    await rm(directory, { recursive: true, force: true });
  });
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['orchestrator/launch.mjs', '--launch-game', '--state', directory]), /requires --project/);
  await assert.rejects(readFile(path.join(directory, 'sidecar.json')), { code: 'ENOENT' });
  instance = await ensureSidecar(directory);
  await assert.rejects(run(process.execPath, ['orchestrator/launch.mjs', '--project', directory, '--launch-game', '--state', directory]), /declares no games in \.rengine\/project\.json/);
  assert.deepEqual((await request(instance, 'state')).sessions, []);
});

test('simultaneous launchers share one live sidecar and reattach after launcher exit', { timeout: 60000 }, async t => {
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
    /* The host is gone; the directory's own services are not, by design (D60/D61). End them
       before the directory is removed, or they hold a deleted directory for their whole idle. */
    await endStateServices(directory);
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
