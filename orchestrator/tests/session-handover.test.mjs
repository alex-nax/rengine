/* F179 (charter D60): a host is replaced and its panes are still there.
 *
 * This is the row D60 was decided for. F177 proved the PTYs outlive a host; F178 put the host on a
 * per-host service anyway, because a session the next host cannot NAME is an orphan rather than a
 * retained pane. So the pane's own record travels with its PTY, and a new host adopts what the
 * state directory's service is holding.
 *
 * The hosts here are separate processes, killed rather than closed: a host that is asked politely
 * to go away is not the case anybody worries about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = path.join(ROOT, 'orchestrator/server/main.mjs');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/* A host as a person starts one: its own process, on a state directory it owns. */
async function host(t, stateDir) {
  const child = spawn(process.execPath, [MAIN, '--state', stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let noise = '';
  child.stderr.on('data', data => { noise = (noise + data).slice(-2000); });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  const descriptor = path.join(stateDir, 'sidecar.json');
  for (let waited = 0; waited < 20000; waited += 50) {
    try {
      const value = JSON.parse(await readFile(descriptor, 'utf8'));
      if (value.pid === child.pid) return { child, ...value };
    } catch { /* not written yet */ }
    if (child.exitCode !== null) throw new Error(`the host exited (${child.exitCode}): ${noise}`);
    await delay(50);
  }
  throw new Error(`the host never published ${descriptor}: ${noise}`);
}

const api = async (instance, route, body) => {
  const response = await fetch(`${instance.url}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `${route} answered ${response.status}`);
  return value;
};

test('a replaced host adopts the panes the state directory still holds', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-handover-'));
  const stateDir = path.join(directory, 'state');
  t.after(async () => {
    /* Whatever is still holding PTYs when this test ends is this test's to clean up. */
    try {
      const pty = JSON.parse(await readFile(path.join(stateDir, 'pty.json'), 'utf8'));
      if (Number.isSafeInteger(pty.pid)) { try { process.kill(pty.pid, 'SIGKILL'); } catch { /* gone */ } }
    } catch { /* no service */ }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, 'note.txt'), 'a project\n');

  const first = await host(t, stateDir);
  const root = await api(first, 'roots', { path: directory });
  const pane = await api(first, 'terminal', { rootId: root.id, command: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'printf "before the handover\\n"; cat'], title: 'The pane that survives' });
  await api(first, 'input', { id: pane.id, data: 'printf "still here\\n"\n' });
  const shell = pane.pid;
  assert.ok(alive(shell), 'the pane has a shell');

  /* The host dies the way a crash kills it. */
  first.child.kill('SIGKILL');
  for (let waited = 0; waited < 5000 && alive(first.child.pid); waited += 50) await delay(50);
  assert.ok(!alive(first.child.pid), 'the first host is gone');
  assert.ok(alive(shell), 'and the shell it started is not');

  const second = await host(t, stateDir);
  assert.notEqual(second.pid, first.pid, 'a different host');
  const state = await api(second, 'state');
  const adopted = state.sessions.find(session => session.id === pane.id);
  assert.ok(adopted, `the new host lists the pane it did not start: ${JSON.stringify(state.sessions)}`);
  assert.equal(adopted.pid, shell, 'the same shell process, not a fresh one');
  assert.equal(adopted.title, 'The pane that survives', 'with the title the first host gave it');
  assert.equal(adopted.rootId, root.id, 'bound to the project it was started in');
  assert.equal(adopted.state, 'running');

  /* And it is a live terminal under the new host, not a record of one. */
  await api(second, 'input', { id: pane.id, data: 'printf "after the handover\\n"\n' });
  const seen = await (async () => {
    for (let waited = 0; waited < 15000; waited += 100) {
      const session = await api(second, `session?id=${pane.id}`);
      if (session.output.includes('after the handover')) return session.output;
      await delay(100);
    }
    throw new Error('the adopted pane never echoed what the new host typed');
  })();
  assert.match(seen, /before the handover[\s\S]*after the handover/,
    'the scrollback from before the handover is there, and so is what came after');
});
