import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { alive, ensureSidecar, request } from '../launcher/sidecar.mjs';
import { ancestorsOf, findHost, findSupervisors, hostAge, hostArguments, insideHost, listProcesses, parseProcessTable, portReleased, replaceHost, stopProcess } from '../launcher/replace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCH = path.join(ROOT, 'orchestrator/launch.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The machine this was written on, as ps printed it: one workspace's host with a pane inside it, two
// sibling projects' own instances, a supervisor with its worker and desktop, a worktree's preflight
// host, and a state directory with a space in it. Nothing here is signalled; the table is data.
const HIREBASE = '/home/x/.local/state/redit/hirebase-v2';
const VTMB = '/home/x/.local/state/rengine/vtmb-vr-2249049057';
const NOLF = '/home/x/.local/state/rengine/nolf-improved-2056293539';
const TABLE = parseProcessTable(`
    1     0 /sbin/launchd
 9599     1 /usr/bin/node /home/x/rengine/orchestrator/runtime/supervisor.mjs
 9603  9599 /usr/bin/node /home/x/rengine/orchestrator/runtime/worker.mjs
82044  9599 /home/x/rengine/.cache/runtime/d5fe12fe/versions/ccd74ad2/bin/rengine --control
68944     1 /usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state ${HIREBASE}
12336 68944 /usr/bin/node /home/x/rengine/scripts/../orchestrator/agents/launch.mjs claude /usr/bin/claude
12342 12336 /usr/bin/claude --mcp-config ${HIREBASE}/integrations/x/mcp.json
94222 12342 /bin/zsh -c source snapshot.sh
90297     1 /usr/bin/node /home/x/vtmb-vr/third_party/rengine/orchestrator/server/main.mjs --state ${VTMB}
90359     1 /usr/bin/node /home/x/vtmb-vr/third_party/rengine/orchestrator/runtime/supervisor.mjs
60124     1 /usr/bin/node /home/x/nolf-improved/third_party/rengine/orchestrator/server/main.mjs --state ${NOLF}
44686     1 /usr/bin/node /home/x/nolf-improved/third_party/rengine/orchestrator/server/main.mjs --state /home/x/.local/state/rengine
29815     1 /usr/bin/node /home/x/rengine/.cache/worktrees/agent-token-2/orchestrator/server/main.mjs --state /var/folders/T/rengine-preflight-rjyCY8
77001     1 /usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state /home/x/My Workspaces/with space
`);
const inTable = pid => TABLE.some(entry => entry.pid === pid);
const descriptor = pid => ({ pid, url: 'http://127.0.0.1:61942', token: 'f'.repeat(64), instance: 'd5fe12fe' });

test('the process table comes from ps and keeps a state directory with a space in it whole', () => {
  assert.equal(TABLE.length, 14);
  assert.deepEqual(TABLE[4], { pid: 68944, ppid: 1, command: `/usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state ${HIREBASE}` });
  assert.deepEqual(hostArguments(TABLE.at(-1).command), { script: '/home/x/rengine/orchestrator/server/main.mjs', stateDir: '/home/x/My Workspaces/with space' });
  assert.equal(hostArguments(TABLE[1].command), null, 'a supervisor is not a host');
  assert.equal(hostArguments(TABLE[5].command), null, 'an agent launcher is not a host');
});

test('the host of a state directory is the PID its descriptor names, and only if that PID serves that directory', async () => {
  const found = await findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(68944) });
  assert.equal(found.process.pid, 68944);

  // Each of these is a real neighbour on the machine. A descriptor pointing at any of them — a stale
  // file copied between directories, a reused PID — must be refused by name, not acted on.
  await assert.rejects(findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(90297) }),
    error => error.message.includes(VTMB) && error.message.includes(`not ${HIREBASE}`) && error.message.includes('Nothing was signalled'));
  await assert.rejects(findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(60124) }),
    error => error.message.includes(NOLF) && error.message.includes('Nothing was signalled'));
  await assert.rejects(findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(29815) }), /rengine-preflight-rjyCY8, not/);
  await assert.rejects(findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(9599) }), /PID 9599, but that process is not a session host: .*supervisor\.mjs/);
  await assert.rejects(findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(12336) }), /not a session host/);

  assert.deepEqual(await findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: descriptor(55555) }),
    { descriptor: descriptor(55555), process: null, stale: true }, 'a PID that is gone is stale, not a refusal');
  assert.deepEqual(await findHost(HIREBASE, { processes: TABLE, alive: inTable, descriptor: null }), { descriptor: null, process: null });
});

test('a launcher running inside the workspace is recognised by its ancestry', () => {
  assert.deepEqual(ancestorsOf(94222, TABLE), [12342, 12336, 68944, 1]);
  assert.equal(insideHost(68944, TABLE, 94222), true, 'a pane inside the hirebase-v2 workspace');
  assert.equal(insideHost(90297, TABLE, 94222), false, 'that pane is not inside vtmb-vr');
  assert.equal(insideHost(68944, TABLE, 9603), false, 'the supervisor worker is beside the host, not under it');
  assert.equal(insideHost(68944, TABLE, 424242), false, 'an unknown PID has no ancestors here');
});

test('only a supervisor bound to this host instance, alive and actually a supervisor, is selected', async t => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const put = async (name, value) => { await mkdir(path.join(runtimeRoot, name)); await writeFile(path.join(runtimeRoot, name, 'runtime.json'), typeof value === 'string' ? value : JSON.stringify(value)); };
  await put('ours', { version: 1, pid: 9599, url: 'http://127.0.0.1:54352', host: { instance: 'd5fe12fe' } });
  await put('theirs', { version: 1, pid: 90359, url: 'http://127.0.0.1:1', host: { instance: 'vtmb' } });
  await put('reused-pid', { version: 1, pid: 9603, url: 'http://127.0.0.1:2', host: { instance: 'd5fe12fe' } });
  await put('gone', { version: 1, pid: 40404, url: 'http://127.0.0.1:3', host: { instance: 'd5fe12fe' } });
  await put('broken', '{not json');
  await mkdir(path.join(runtimeRoot, 'empty'));
  const found = await findSupervisors('d5fe12fe', TABLE, { runtimeRoot });
  assert.deepEqual(found.map(({ pid, url, children }) => ({ pid, url, children: children.map(child => child.pid) })),
    [{ pid: 9599, url: 'http://127.0.0.1:54352', children: [9603, 82044] }]);
  assert.deepEqual(await findSupervisors('d5fe12fe', TABLE, { runtimeRoot: path.join(runtimeRoot, 'absent') }), []);
});

test('a process that honours SIGTERM gets nothing else; one that ignores it gets SIGKILL, in that order', async () => {
  const fake = ({ diesOn }) => {
    const sent = []; let dead = false;
    return { sent, kill: (pid, signal) => { sent.push(signal); if (signal === diesOn) dead = true; }, alive: () => !dead, sleep: async () => {}, graceMs: 0, killMs: 1000 };
  };
  const polite = fake({ diesOn: 'SIGTERM' });
  assert.deepEqual(await stopProcess(4242, polite), { pid: 4242, outcome: 'stopped on SIGTERM' });
  assert.deepEqual(polite.sent, ['SIGTERM']);

  const stubborn = fake({ diesOn: 'SIGKILL' });
  assert.deepEqual(await stopProcess(4242, stubborn), { pid: 4242, outcome: 'ignored SIGTERM, killed' });
  assert.deepEqual(stubborn.sent, ['SIGTERM', 'SIGKILL']);

  const gone = fake({ diesOn: 'SIGTERM' }); gone.alive = () => false;
  assert.deepEqual(await stopProcess(4242, gone), { pid: 4242, outcome: 'already gone' });
  assert.deepEqual(gone.sent, [], 'nothing is signalled at a PID that is already gone; it may belong to someone else by now');

  const immortal = fake({ diesOn: 'never' }); immortal.killMs = 0;
  await assert.rejects(stopProcess(4242, immortal), /still alive after SIGKILL/);
});

test('a host whose descriptor is older than the code is stale, one that is newer is not', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'rengine-age-state-'));
  const checkoutRoot = await mkdtemp(path.join(tmpdir(), 'rengine-age-checkout-'));
  t.after(async () => { await rm(stateDir, { recursive: true, force: true }); await rm(checkoutRoot, { recursive: true, force: true }); });
  assert.equal(await hostAge(stateDir, { checkoutRoot }), null, 'no descriptor, no host, no age');
  await writeFile(path.join(stateDir, 'sidecar.json'), '{}');
  await mkdir(path.join(checkoutRoot, 'orchestrator/server'), { recursive: true });
  await mkdir(path.join(checkoutRoot, 'contracts'), { recursive: true });
  await writeFile(path.join(checkoutRoot, 'orchestrator/server/main.mjs'), '');
  await writeFile(path.join(checkoutRoot, 'orchestrator/server/main.mjs._llm.json'), '');
  await writeFile(path.join(checkoutRoot, 'contracts/project-v1.schema.json'), '');
  const at = (file, when) => utimes(file, when, when);
  const hostStart = new Date('2026-09-07T09:16:13Z');
  await at(path.join(stateDir, 'sidecar.json'), hostStart);
  await at(path.join(checkoutRoot, 'orchestrator/server/main.mjs'), new Date('2026-09-07T08:00:00Z'));
  await at(path.join(checkoutRoot, 'contracts/project-v1.schema.json'), new Date('2026-09-07T11:13:56Z'));
  await at(path.join(checkoutRoot, 'orchestrator/server/main.mjs._llm.json'), new Date('2026-09-07T12:00:00Z'));
  const stale = await hostAge(stateDir, { checkoutRoot });
  assert.equal(stale.stale, true);
  assert.equal(stale.newestFile, 'contracts/project-v1.schema.json', 'the schema counts: it is frozen in the host too, and a sidecar note does not');
  assert.equal(stale.startedAt.toISOString(), hostStart.toISOString());
  await at(path.join(stateDir, 'sidecar.json'), new Date('2026-09-07T11:30:00Z'));
  assert.equal((await hostAge(stateDir, { checkoutRoot })).stale, false);
});

// From here on a real, throwaway host is started for the test and stopped by it. Stopping it and
// removing its directory is one hook, for the reason headless.test.mjs records.
async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-replace-'));
  t.after(async () => { await stopSidecar(directory); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function stopSidecar(directory) {
  let pid;
  try { pid = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).pid; } catch { return; }
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 200 && alive(pid); attempt++) await pause(20);
}

test('replacing a throwaway host: the old one exits, its port closes, a new one answers, and the report says so', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const old = await ensureSidecar(directory);
  const root = await request(old, 'roots', { path: directory });
  const session = await request(old, 'terminal', { rootId: root.id });
  assert.equal(session.state, 'running');

  const said = [];
  const report = await replaceHost(directory, { runtimeRoot, log: text => said.push(text) });

  assert.equal(report.previous.pid, old.pid);
  assert.equal(report.previous.instance, old.instance);
  assert.equal(alive(old.pid), false, 'the old host exited');
  assert.equal(await portReleased(old.url, { timeoutMs: 1 }), true, 'and its port refuses connections');
  assert.deepEqual(report.stopped.map(({ role, outcome }) => ({ role, outcome })), [{ role: 'host', outcome: 'stopped on SIGTERM' }]);
  assert.deepEqual(report.ended.map(item => [item.id, item.type]), [[session.id, 'terminal']], 'the report names the session that ended');

  assert.notEqual(report.started.pid, old.pid);
  assert.notEqual(report.started.instance, old.instance, 'a new host, not the old one found again');
  assert.ok(alive(report.started.pid));
  assert.equal(report.started.checkout, `${ROOT}/`);
  const written = JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8'));
  assert.equal(written.pid, report.started.pid, 'the descriptor now names the new host');
  const state = await request(written, 'state');
  assert.equal(state.instance, report.started.instance);
  assert.deepEqual(state.roots.map(item => item.id), [root.id], 'the root persisted across the replacement');
  assert.deepEqual(state.sessions, [], 'sessions did not: they ended with the old host');

  const text = said.join('\n');
  assert.match(text, new RegExp(`stopped host PID ${old.pid} \\(${old.url}, instance ${old.instance}, started \\d{4}-`));
  assert.match(text, /ended 1 running session\(s\):\n {4}terminal — /);
  assert.match(text, new RegExp(`Started host PID ${report.started.pid} \\(${report.started.url}, instance ${report.started.instance}\\)`));
});

test('a refusal leaves the real host untouched: another directory claimed, or a launcher inside the workspace', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const old = await ensureSidecar(directory);
  const real = await listProcesses();
  const mine = real.find(entry => entry.pid === old.pid);
  assert.ok(mine && hostArguments(mine.command), `ps shows the throwaway host: ${mine?.command}`);

  // The same PID, but ps says it serves vtmb-vr's directory: a descriptor that lies, or a PID reused.
  const claimed = real.map(entry => entry.pid === old.pid ? { ...entry, command: `${hostArguments(entry.command).script} --state ${VTMB}` } : entry);
  await assert.rejects(replaceHost(directory, { runtimeRoot, processes: claimed, log: () => {} }),
    error => error.message.includes(VTMB) && error.message.includes('Nothing was signalled'));
  assert.equal(alive(old.pid), true, 'nothing was signalled');
  assert.equal((await request(old, 'state')).instance, old.instance, 'and it still answers as itself');

  // This test process, re-parented under the host: the shape of a pane asking to end itself.
  const inside = real.map(entry => entry.pid === process.pid ? { ...entry, ppid: old.pid } : entry);
  await assert.rejects(replaceHost(directory, { runtimeRoot, processes: inside, log: () => {} }), /inside the workspace it would replace.*PID \d+ is one of its ancestors.*Nothing was signalled/);
  assert.equal(alive(old.pid), true);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'sidecar.json'), 'utf8')).pid, old.pid, 'the descriptor was not touched either');
});

test('a stale descriptor is cleared and a fresh host started, with no refusal', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'rengine-runtime-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'sidecar.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'f'.repeat(64), instance: 'gone', pid: 2147483000 }));
  const said = [];
  const report = await replaceHost(directory, { runtimeRoot, log: text => said.push(text) });
  assert.equal(report.previous.stale, true);
  assert.deepEqual(report.stopped, []);
  assert.ok(alive(report.started.pid));
  assert.match(said.join('\n'), /named PID 2147483000, which is gone; the stale descriptor was removed/);
});

test('--headless --replace-host through the launcher comes up as a different host', { timeout: 60000 }, async t => {
  const directory = await scratch(t);
  const old = await ensureSidecar(directory);
  const child = spawn(process.execPath, [LAUNCH, '--headless', '--replace-host', '--state', directory], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const seen = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { seen.stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      seen.stdout += chunk;
      const line = seen.stdout.split('\n').find(text => text.startsWith('rengine headless ready '));
      if (line) resolve(Object.fromEntries(line.slice('rengine headless ready '.length).trim().split(' ').map(pair => pair.split('='))));
    });
    child.once('exit', code => reject(new Error(`the launcher exited ${code} before it was ready.\nstdout:\n${seen.stdout}\nstderr:\n${seen.stderr}`)));
  });
  assert.notEqual(Number(ready.pid), old.pid, 'the launcher is supervising a different host');
  assert.equal(alive(old.pid), false, 'the one that was there is gone');
  assert.ok(alive(Number(ready.pid)));
  assert.match(seen.stdout, new RegExp(`Replaced the session host of .*\n {2}stopped host PID ${old.pid} `));
  assert.match(seen.stdout, new RegExp(`Started host PID ${ready.pid} `));
});
