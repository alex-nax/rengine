import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

// Two conversations rEngine minted for a claude pane. They reach the desktop on /api/state exactly
// as spec 097 persists them; this suite proves the Sessions tab turns them into resume/attach, which
// is where the owner asked for the choice to live (spec 099).
const OLDER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const NEWER = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

async function project(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-sessions-view-'));
  const root = path.join(dir, 'project');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'x\n');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root };
}

const roleKeys = (state, role) => (state.controls ?? []).filter(c => c.role === role).map(c => c.key);

test('the Sessions tab offers a project\'s past conversations for resume, most recent first', { timeout: 90000 }, async t => {
  const { dir, root: projectPath } = await project(t);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(projectPath);
  // Recorded before the desktop connects, so its first /api/state already carries them.
  await server.store.recordConversation(root.id, { conversation: OLDER, agent: 'claude' });
  await server.store.recordConversation(root.id, { conversation: NEWER, agent: 'claude' });
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    await gui.control('toolbar', 'Sessions', -1);
    const state = await gui.until(s => roleKeys(s, 'resume').length === 2, 'both conversations offer resume');

    assert.deepEqual(roleKeys(state, 'resume'), [NEWER, OLDER], 'resume rows are listed most recently seen first');
    assert.deepEqual(roleKeys(state, 'conversation-attach'), [], 'nothing is live, so nothing is offered for attach');
    // The two conversations reached the desktop as data, not as sessions.
    assert.equal(state.state.sessions.length, 0, 'no session was started to make the offer');
    const remembered = state.state.conversations[root.id].map(c => c.id);
    assert.deepEqual(remembered, [NEWER, OLDER]);
  } finally {
    await gui.close(); await server.close();
  }
});

test('Resume starts a pane bound to that same conversation, not a fresh one', { timeout: 90000 }, async t => {
  const { dir, root: projectPath } = await project(t);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(projectPath);
  await server.store.recordConversation(root.id, { conversation: OLDER, agent: 'claude' });
  await server.store.recordConversation(root.id, { conversation: NEWER, agent: 'claude' });
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    await gui.control('toolbar', 'Sessions', -1);
    await gui.until(s => roleKeys(s, 'resume').includes(OLDER), 'the older conversation offers resume');

    // Press Resume on the OLDER one. The proof it resumed rather than started a new conversation is
    // that the created agent session carries that exact id — a fresh launch would mint a random one.
    await gui.control('resume', OLDER, -1);
    const state = await gui.until(s => s.state.sessions.some(x => x.type === 'agent' && x.conversation === OLDER),
      'an agent session bound to the resumed conversation');
    const resumed = state.state.sessions.find(x => x.type === 'agent' && x.conversation === OLDER);
    assert.equal(resumed.rootId, root.id, 'and it is a pane of this project, resumed in place');
  } finally {
    await gui.close(); await server.close();
  }
});

test('a live agent that names its own conversations is attach-only and marked not resumable', { timeout: 90000 }, async t => {
  const { dir, root: projectPath } = await project(t);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(projectPath);
  // An agent menu is a live agent pane that holds no conversation id: rEngine recorded none, so it
  // can be attached while it runs but never resumed. It blocks on its own prompt, so it stays live.
  const live = await server.sessions.terminal({ rootId: root.id, type: 'agent', agent: '', action: 'menu' });
  assert.equal(live.state, 'running');
  assert.equal(live.conversation, undefined, 'it holds no conversation to resume');
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    await gui.control('toolbar', 'Sessions', -1);
    const state = await gui.until(s => roleKeys(s, 'conversation-attach').includes(live.id), 'the live agent offers attach');

    assert.deepEqual(roleKeys(state, 'resume'), [], 'and it is never offered for resume, which would fork a second conversation');
    // The raw process list is unchanged: the live agent is still there with its Stop and Attach.
    assert.ok(roleKeys(state, 'stop').includes(live.id), 'the process list still stops it');
    assert.ok(roleKeys(state, 'attach').includes(live.id), 'and still attaches it');
  } finally {
    await gui.close(); await server.close();
  }
});
