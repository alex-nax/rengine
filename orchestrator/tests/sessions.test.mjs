import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../server/store.mjs';
import { Sessions } from '../server/sessions.mjs';

const until = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Session condition timed out'); await new Promise(r => setTimeout(r, 25)); }
};

test('real terminals retain identity/output without views and Stop affects only its session', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-sessions-'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  const sessions = new Sessions(store);
  t.after(async () => { await sessions.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const shell = process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
    : { command: '/bin/bash', args: ['--noprofile', '--norc'] };
  const a = await sessions.terminal({ rootId: root.id, ...shell });
  const b = await sessions.terminal({ rootId: root.id, ...shell });
  const command = process.platform === 'win32' ? 'Write-Output ("first-" + "terminal")\r' : "printf 'first-%s\\n' terminal\r";
  sessions.input(a.id, command);
  await until(() => sessions.get(a.id).output.includes('first-terminal'));
  const pid = sessions.get(a.id).pid;
  sessions.resize(a.id, 110, 35);
  assert.equal(sessions.snapshot(a.id).cols, 110);
  assert.equal(sessions.snapshot(a.id).rootId, root.id);
  assert.equal(sessions.snapshot(a.id).pid, pid);
  await sessions.stop(a.id);
  await until(() => sessions.get(a.id).state === 'exited');
  assert.equal(sessions.get(b.id).state, 'running');
  sessions.input(b.id, process.platform === 'win32' ? 'Write-Output ("second-" + "alive")\r' : "printf 'second-%s\\n' alive\r");
  await until(() => sessions.get(b.id).output.includes('second-alive'));
  assert.throws(() => sessions.input(a.id, 'anything'), /not running/);
  assert.throws(() => sessions.resize(b.id, 0, 1), /dimensions/);
});

// A restart is only meaningful when rEngine knows which conversation to resume into. Refusing by
// name beats silently starting a second conversation. See docs/specs/096-agent-session-resume.md.
test('restarting refuses anything it cannot put back into its own conversation', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-restart-'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  const sessions = new Sessions(store);
  t.after(async () => { await sessions.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const shell = process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
    : { command: '/bin/bash', args: ['--noprofile', '--norc'] };
  const plain = await sessions.terminal({ rootId: root.id, ...shell });
  assert.equal(sessions.snapshot(plain.id).conversation, undefined, 'a plain terminal holds no conversation');
  await assert.rejects(sessions.restartAgent(plain.id), /agent session/i, 'a terminal is not an agent pane');
  await assert.rejects(sessions.restartAgent('00000000-0000-0000-0000-000000000000'), /not found|unknown/i);
});
