import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from './red-host-fixture.mjs';
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
  /* Seeded on disk rather than through recordConversation, because that stamps lastSeenAt from the
     store's own clock and every conversation would read "just now" — a short string that fits a
     column even when the column is starved. The row that actually failed carried a LONG age, so
     the fixture has to carry one too, or the layout assertion below has nothing to catch. */
  const stateDir = path.join(dir, 'state');
  const ROOT_ID = 'cccccccc-3333-3333-3333-cccccccccccc';
  const minutesAgo = n => Date.now() - n * 60000;
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'workspace.json'), JSON.stringify({
    version: 1,
    /* The REAL path: macOS resolves /var to /private/var and the tree compares canonicalised
       paths, so a seeded root that skips this refuses its own project as outside itself. */
    roots: [{ id: ROOT_ID, path: await realpath(projectPath), name: path.basename(projectPath) }],
    drafts: {}, layout: null, preferences: {},
    conversations: {
      /* Most recently seen first, which is the order recordConversation maintains and the order
         the view is asserted to preserve below. */
      [ROOT_ID]: [
        { id: NEWER, agent: 'claude', startedAt: minutesAgo(90), lastSeenAt: minutesAgo(26) },
        { id: OLDER, agent: 'claude', startedAt: minutesAgo(180), lastSeenAt: minutesAgo(64) },
      ],
    },
  }));
  const server = await startServer({ stateDir });
  const root = { id: ROOT_ID };
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

    /* A row a person cannot read is a row that failed. The first column used to reserve
       actions-width where the button column is attach-width, which spent the difference on a gap
       in the middle and left the trailing column short of the age it had to write, so the row read
       "26 minutes ag…" beside a hole. Text runs carry the drawn box AND the box after clipping, so
       a truncated label is `visible.w !== w` — which a control rectangle could never show. */
    const runs = await gui.command({ op: 'text-runs' });
    const clipped = runs.filter(r => r.visible.w !== r.w || r.visible.h !== r.h);
    assert.deepEqual(clipped, [], `every string in the Sessions tab is drawn whole: ${JSON.stringify(clipped)}`);

    /* And the row says WHICH conversation it is. Every row here is "claude · rengine"; without the
       id there is nothing to tell two of them apart, and the id is also what the CLI resumes by. */
    const shown = runs.map(r => r.text);
    for (const id of [NEWER, OLDER]) {
      const head = id.split('-')[0];
      assert.ok(shown.some(t => t.includes(head)),
        `the row names the conversation ${head}: ${JSON.stringify(shown)}`);
    }
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

/* F210/F211 (spec 140): the conversations the CLI itself holds, which rEngine never minted.
 *
 * This is the owner's actual ask — /resume's list — and it is a different set from rEngine's own
 * records: a conversation begun in a terminal, or before this workspace existed, is in the CLI's
 * store and in no session record. The store is the authority on what EXISTS; rEngine's record only
 * says whether this workspace has a pane for it.
 */
test('the Sessions tab lists conversations the CLI holds that rEngine never minted', { timeout: 90000 }, async t => {
  const { dir, root: projectPath } = await project(t);
  const real = await realpath(projectPath);
  /* A claude store for THIS root, keyed the way claude keys it: the checkout path with every
     separator turned into a dash. The home directory is redirected at the host, so the fixture
     never touches the real ~/.claude. */
  const home = path.join(dir, 'home');
  const store = path.join(home, '.claude', 'projects', real.replaceAll('/', '-'));
  await mkdir(store, { recursive: true });
  const ONLY_ON_DISK = 'dddddddd-4444-4444-4444-dddddddddddd';
  await writeFile(path.join(store, `${ONLY_ON_DISK}.jsonl`),
    '{"type":"user","message":{"content":"the thing I asked in a terminal"}}\n' +
    '{"type":"ai-title","aiTitle":"Work begun outside the editor"}\n');

  const stateDir = path.join(dir, 'state');
  const ROOT_ID = 'eeeeeeee-5555-5555-5555-eeeeeeeeeeee';
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'workspace.json'), JSON.stringify({
    version: 1,
    roots: [{ id: ROOT_ID, path: real, name: path.basename(real) }],
    drafts: {}, layout: null, preferences: {}, conversations: {},
  }));
  /* HOME is read by the route from the environment the front door was SPAWNED with, so it is set
     around startServer and restored after — startServer takes no env of its own, and a fixture that
     forgot this would quietly list the real ~/.claude and pass for the wrong reason. */
  const realHome = process.env.HOME;
  process.env.HOME = home;
  let server;
  try { server = await startServer({ stateDir }); } finally { process.env.HOME = realHome; }
  const gui = await nativeClient(server, { root: ROOT_ID });
  try {
    await gui.until(s => s.connected && s.tabs.some(x => x?.type === 1 && x.tree), 'the workspace');
    await gui.control('toolbar', 'Sessions', -1);
    /* Offered for resume even though no session record names it: the CLI's store is what says it
       exists. rEngine minted nothing here — state.conversations is empty. */
    const shown = await gui.until(s => (s.controls ?? []).some(c => c.role === 'resume-store' && c.key === ONLY_ON_DISK),
      "the conversation held only by the CLI is offered");
    assert.deepEqual(shown.state.conversations, {}, 'rEngine recorded none of it; the store is the source');

    /* And it is named by its own title rather than by a bare id, which is the whole point. */
    const runs = await gui.command({ op: 'text-runs' });
    const text = runs.map(r => r.text).join(' | ');
    assert.ok(text.includes('Work begun outside the editor'),
      `the row wears the transcript's own title: ${text.slice(0, 400)}`);

    /* Collapsed by default: the excerpt is not on screen until the row is opened. */
    assert.ok(!text.includes('the thing I asked in a terminal'),
      'a collapsed row shows no message text');

    /* Opening the row shows what was said first and last, the way a task row opens. */
    await gui.control('conversation-open', ONLY_ON_DISK, -1);
    const opened = await gui.until(s => (s.controls ?? []).some(c => c.role === 'conversation-excerpt' && c.key === ONLY_ON_DISK),
      'the row expands');
    const inside = (await gui.command({ op: 'text-runs' })).map(r => r.text).join(' ');
    assert.ok(inside.includes('the thing I asked in a terminal'),
      `the expanded row shows the opening message: ${inside.slice(0, 300)}`);
    assert.ok(inside.includes('opened with') && inside.includes('last said'),
      'both halves are labelled');
    assert.ok(opened.controls.some(c => c.role === 'resume-store' && c.key === ONLY_ON_DISK),
      'and the row keeps its Resume while open');

    /* Closing it again puts the text away: one open block at a time, like the task chooser. */
    await gui.control('conversation-open', ONLY_ON_DISK, -1);
    await gui.until(s => !(s.controls ?? []).some(c => c.role === 'conversation-excerpt'), 'the row closes');

    /* Nothing under the store was written by listing or expanding it. */
    const after = await readFile(path.join(store, `${ONLY_ON_DISK}.jsonl`), 'utf8');
    assert.ok(after.includes('the thing I asked in a terminal'), 'the transcript is untouched');
  } finally {
    await gui.close(); await server.close();
  }
});
