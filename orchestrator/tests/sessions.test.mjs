import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../server/store.mjs';
import { Sessions } from '../server/sessions.mjs';
import { fakeCli } from './task-fixtures.mjs';

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

// The picker exists for a person opening a bare pane (spec 097 decision 4). A caller that names the
// conversation — a Sessions-tab Resume, a restart — or that passes arguments — a spawn on a task,
// spec 103 — has already answered the question it asks. Offering the list anyway is how the first
// live spawn ended up resuming the conversation of the agent that spawned it.
test('the project’s conversations are offered to a bare pane only', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-offer-'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  const sessions = new Sessions(store);
  // The listing is composed here, before the pane is spawned, so a context the launcher cannot reach
  // is enough: what is under test is which launches get one written for them.
  sessions.workspaceContext = { url: 'http://127.0.0.1:1', token: 'unreachable', instance: 'test' };
  t.after(async () => { await sessions.shutdown(); await rm(dir, { recursive: true, force: true }); });
  await fakeCli(store.directory, 'claude');
  const earlier = randomUUID();
  await store.recordConversation(root.id, { conversation: earlier, agent: 'claude' });
  const listingOf = id => path.join(store.directory, 'integrations', `${id}.conversations.tsv`);

  const bare = await sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude' });
  assert.equal(existsSync(listingOf(bare.id)), true, 'a bare pane with history is offered it');
  assert.match(await readFile(listingOf(bare.id), 'utf8'), new RegExp(earlier), 'and the offer is what the project remembers');

  const spawned = await sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude',
    args: ['--model', 'claude-opus-5', 'Work F1: the rendered task prompt'] });
  assert.equal(existsSync(listingOf(spawned.id)), false, 'a pane launched on a task is offered nothing');
  assert.notEqual(spawned.conversation, earlier, 'and starts on its own conversation');

  const resumed = await sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude', conversation: earlier, resume: true });
  assert.equal(existsSync(listingOf(resumed.id)), false, 'a launch told which conversation to resume is offered nothing');
  assert.equal(resumed.conversation, earlier, 'and is put back into the one it was told');
});

// kimi names its own conversations and has no start-with-id spelling (spec 127 decisions 3–4), so
// the host mints it nothing, refuses a named conversation without resume by name, and still puts a
// restart back into the recorded one.
test('kimi is never minted a conversation: naming one without resume is refused by name', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-kimi-mint-'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  const sessions = new Sessions(store);
  sessions.workspaceContext = { url: 'http://127.0.0.1:1', token: 'unreachable', instance: 'test' };
  t.after(async () => { await sessions.shutdown(); await rm(dir, { recursive: true, force: true }); });
  await fakeCli(store.directory, 'kimi');
  const kimiSession = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
  await store.recordConversation(root.id, { conversation: kimiSession, agent: 'kimi' });

  const bare = await sessions.terminal({ rootId: root.id, type: 'agent', agent: 'kimi' });
  assert.equal(bare.conversation, undefined, 'a bare kimi pane is minted nothing: the CLI names its own');

  await assert.rejects(sessions.terminal({ rootId: root.id, type: 'agent', agent: 'kimi', conversation: kimiSession }),
    /names its own conversations/, 'and being told one without resume is refused rather than silently claimed');

  const resumed = await sessions.terminal({ rootId: root.id, type: 'agent', agent: 'kimi', conversation: kimiSession, resume: true });
  assert.equal(resumed.conversation, kimiSession, 'but a restart is put back into the recorded one');
});

// The host composes a pane's environment from its own, and a host started from inside an agent pane
// inherits that pane's listing. Nothing but this launch may decide what this pane is offered.
test('a listing inherited from the host’s own environment never reaches a pane', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-inherit-'));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  const sessions = new Sessions(store);
  const before = process.env.RENGINE_AGENT_CONVERSATIONS;
  process.env.RENGINE_AGENT_CONVERSATIONS = path.join(dir, 'somebody-elses.tsv');
  t.after(async () => {
    if (before === undefined) delete process.env.RENGINE_AGENT_CONVERSATIONS; else process.env.RENGINE_AGENT_CONVERSATIONS = before;
    await sessions.shutdown(); await rm(dir, { recursive: true, force: true });
  });
  const shell = process.platform === 'win32'
    ? { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', 'Write-Output ("listing=" + $(if ($env:RENGINE_AGENT_CONVERSATIONS) { $env:RENGINE_AGENT_CONVERSATIONS } else { "none" }))'] }
    : { command: '/bin/bash', args: ['--noprofile', '--norc', '-c', 'printf "listing=%s\\n" "${RENGINE_AGENT_CONVERSATIONS:-none}"'] };
  const pane = await sessions.terminal({ rootId: root.id, ...shell });
  await until(() => sessions.get(pane.id).output.includes('listing='));
  assert.match(sessions.get(pane.id).output, /listing=none/, 'the inherited listing is cleared with the rest of its family');
});
