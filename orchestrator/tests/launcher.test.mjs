import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureSidecar, request } from '../launcher/sidecar.mjs';
import { LAUNCH, launch } from './red-launch.mjs';
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
  await assert.rejects(run(LAUNCH(), ['--launch-game', '--state', directory]), /requires --project/);
  await assert.rejects(readFile(path.join(directory, 'sidecar.json')), { code: 'ENOENT' });
  instance = await ensureSidecar(directory);
  await assert.rejects(run(LAUNCH(), ['--project', directory, '--launch-game', '--state', directory]), /declares no games in \.rengine\/project\.json/);
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

/* A handoff manifest NAMES its project, and `--project` is a cross-check rather than a requirement:
 * `npm run resume` has never passed one. The JavaScript said so — `if (project && ...)` — and the
 * port made the comparison unconditional against an empty path, so the whole resume command died
 * on `canonicalize("")` with the bare sentence `No such file or directory (os error 2)`: no flag
 * named, no manifest named, nothing a person could act on (spec 145).
 *
 * Both halves are asserted here because the interesting failure is over-correcting: a fix that
 * simply deleted the comparison would move a paused conversation into whatever project the caller
 * happened to name, which is the thing the check exists to prevent. */
test('a handoff with no --project adopts the manifest\'s own project, and one that disagrees is still refused', async t => {
  const project = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-project-'));
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-elsewhere-'));
  const conversations = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-store-'));
  const state = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-state-'));
  t.after(() => Promise.all([project, elsewhere, conversations, state].map(directory => rm(directory, { recursive: true, force: true }))));

  const sessionId = '00000000-0000-0000-0000-0000000000f5';
  await writeFile(path.join(project, 'checkpoint.md'), 'Paused goal checkpoint.');
  const manifest = path.join(project, 'handoff.json');
  await writeFile(manifest, JSON.stringify({ version: 1, project: '.', sessionId, checkpoint: 'checkpoint.md' }));
  const run = args => launch(args, { env: { ...process.env, CODEX_HOME: conversations } });

  /* No --project: the manifest's own project is the answer, and the run gets as far as asking
     whether the conversation is on this machine — the check after the one that was failing. */
  const adopted = await run(['--handoff', manifest, '--state', state]);
  assert.doesNotMatch(adopted.stderr, /No such file or directory/, adopted.stderr);
  assert.match(adopted.stderr, /No substitute session was launched/, adopted.stderr);

  /* A --project that is not the manifest's is still refused, by name. */
  const refused = await run(['--handoff', manifest, '--project', elsewhere, '--state', state]);
  assert.match(refused.stderr, /Handoff belongs to a different project/, refused.stderr);
});
