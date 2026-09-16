import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stateDirectories } from './agents-client.mjs';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through the service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (orchestrator/tests/cargo.mjs). */
before(() => built('--bins'));


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

/* Binding an agent to a workspace ends with a process that answers on a loopback port. So the
 * question the descriptor's health check exists for is: is the thing answering there THIS workspace?
 *
 * It is not hypothetical. A descriptor can outlive the host it named while another workspace takes
 * the port, and a check that asked `/health` and ignored the answer — which is what this module's
 * own copy of discovery did — would hand an agent a token for somebody else's sessions.
 */
test('a port answering for another workspace is not this one, and binding refuses it', { timeout: 60000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { startServer } = await import('./red-host-fixture.mjs');
  const { endStateServices } = await import('./state-services.mjs');
  const run = promisify(execFile);
  const home = await mkdtemp(path.join(tmpdir(), 'rengine-bind-foreign-'));
  const project = path.join(home, 'project');
  await mkdir(project, { recursive: true });
  const hostState = path.join(home, 'host');
  const host = await startServer({ stateDir: hostState });
  try {
    await host.store.addRoot(project);
    /* A state directory whose descriptor points at that live host but CLAIMS another instance —
       exactly the shape a stale descriptor takes when a port is reused. Its pid is this test, so
       there is no question of the process being gone: it is alive, it answers, and it is not ours. */
    const stale = path.join(home, 'rengine', 'stale');
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'sidecar.json'), JSON.stringify({
      url: host.url, token: host.token, instance: '99999999-9999-4999-8999-999999999999', pid: process.pid,
    }));
    const refused = await run(path.join(process.cwd(), 'red/target/debug/red-agents'),
      ['bind', '--project', project, '--state', stale, '--agent', 'claude'],
      { encoding: 'utf8', timeout: 30000 }).then(() => null, error => error);
    assert.ok(refused, 'binding to a workspace that is not this one must fail');
    const said = `${refused.stdout ?? ''}${refused.stderr ?? ''}`;
    assert.match(said, /No live workspace instance serves/, said);
    assert.match(said, /alive but unavailable: Sidecar identity mismatch/,
      `the health answer is CHECKED, not merely asked for: ${said}`);
    assert.match(said, /No second sidecar was started/, said);
  } finally {
    await host.close({ retain: false });
    await endStateServices(hostState);
    await rm(home, { recursive: true, force: true });
  }
});
