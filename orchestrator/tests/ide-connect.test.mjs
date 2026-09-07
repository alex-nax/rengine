import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { offeredEditors, autoConnect, ideConnectFlag } from '../agents/ide-connect.mjs';
import { agentLaunch } from '../agents/config.mjs';

async function locks(entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-locks-'));
  for (const [port, value] of Object.entries(entries)) {
    await writeFile(path.join(dir, `${port}.lock`), JSON.stringify(value));
  }
  return dir;
}
const alive = () => true;

test('an editor is offered when its folders cover the directory, and not when they merely look like it', async () => {
  const dir = await locks({
    100: { pid: 1, ideName: 'rEdit', workspaceFolders: ['/work/rengine'] },
    200: { pid: 2, ideName: 'rEdit', workspaceFolders: ['/work/rengine-old'] },
    300: { pid: 3, ideName: 'rEdit', workspaceFolders: ['/elsewhere'] },
  });
  try {
    const offered = await offeredEditors('/work/rengine/orchestrator', { locks: dir, alive });
    assert.deepEqual(offered.map(x => x.port), [100], `a directory inside the folder: ${JSON.stringify(offered)}`);

    // The direction a bare prefix test gets wrong, which is the one worth asserting: a sibling whose
    // name starts with the folder's name is not inside it. Querying from `/work/rengine-old` must
    // not match the editor that serves `/work/rengine`.
    const sibling = await offeredEditors('/work/rengine-old', { locks: dir, alive });
    assert.deepEqual(sibling.map(x => x.port), [200], `a sibling is not inside: ${JSON.stringify(sibling)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lock whose process is gone is not offered', async () => {
  const dir = await locks({ 100: { pid: 4242, ideName: 'rEdit', workspaceFolders: ['/work'] } });
  try {
    assert.deepEqual(await offeredEditors('/work', { locks: dir, alive: () => false }), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('this workspace\'s own editor is named by port, so a machine-mate\'s does not block it', async () => {
  // Measured on 2026-09-07: four locks covered one folder and `/ide` listed all four, so counting
  // alone would decline forever on a machine where two workspaces bind the same project. Naming our
  // port is what the CLI itself honours to select one outright.
  const shared = await locks({
    100: { pid: 1, ideName: 'rEdit', workspaceFolders: ['/work'] },
    200: { pid: 2, ideName: 'rEdit', workspaceFolders: ['/work'] },
  });
  try {
    const ours = await autoConnect('claude', '/work', { locks: shared, alive, ourPids: [2, 77] });
    assert.deepEqual(ours.flags, ['--ide'], `two offered, but one of them is ours: ${ours.reason}`);
    assert.equal(ours.env.CLAUDE_CODE_SSE_PORT, '200', 'and the CLI is told which one');

    // None of them ours: there is genuinely nothing to choose, so nothing is passed.
    const theirs = await autoConnect('claude', '/work', { locks: shared, alive, ourPids: [999] });
    assert.deepEqual(theirs.flags, []);
    assert.match(theirs.reason, /none of them is this workspace's/);

    // A host too old to report its pid falls back to counting, which is the previous behaviour.
    const blind = await autoConnect('claude', '/work', { locks: shared, alive });
    assert.deepEqual(blind.flags, []);
  } finally { await rm(shared, { recursive: true, force: true }); }
});

test('exactly one is the rule when this workspace cannot be identified', async () => {
  const two = await locks({
    100: { pid: 1, ideName: 'rEdit', workspaceFolders: ['/work'] },
    200: { pid: 2, ideName: 'rEdit', workspaceFolders: ['/work'] },
  });
  const one = await locks({ 100: { pid: 1, ideName: 'rEdit', workspaceFolders: ['/work'] } });
  const foreign = await locks({ 100: { pid: 1, ideName: 'VS Code', workspaceFolders: ['/work'] } });
  try {
    const many = await autoConnect('claude', '/work', { locks: two, alive });
    assert.deepEqual(many.flags, [], 'two offered and neither identified means no flag');

    const single = await autoConnect('claude', '/work', { locks: one, alive });
    assert.deepEqual(single.flags, ['--ide'], `one offered means the flag: ${single.reason}`);

    const none = await autoConnect('claude', '/work', { locks: await locks({}), alive });
    assert.deepEqual(none.flags, [], 'nothing published means no flag, rather than a startup error');
    assert.match(none.reason, /No editor is published/);

    // Another editor's lock is not ours to connect a pane to.
    const other = await autoConnect('claude', '/work', { locks: foreign, alive });
    assert.deepEqual(other.flags, []);
    assert.match(other.reason, /VS Code/);
  } finally { for (const d of [two, one, foreign]) await rm(d, { recursive: true, force: true }); }
});

test('a CLI with no auto-connect option gets nothing added to its command line', async () => {
  const dir = await locks({ 100: { pid: 1, ideName: 'rEdit', workspaceFolders: ['/work'] } });
  try {
    assert.equal(ideConnectFlag('codex'), null);
    for (const agent of ['codex', 'gemini', 'opencode']) {
      const value = await autoConnect(agent, '/work', { locks: dir, alive });
      assert.deepEqual(value.flags, [], `${agent} is left alone`);
      assert.match(value.reason, /no auto-connect option/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the launch plan carries the flag, and says why when it does not', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-launch-'));
  try {
    const contextFile = path.join(dir, 'context.json');
    await writeFile(contextFile, JSON.stringify({ url: 'http://127.0.0.1:1', token: 'a'.repeat(64),
      instance: '11111111-1111-1111-1111-111111111111', rootId: '22222222-2222-2222-2222-222222222222' }));
    const plan = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile,
      directory: dir, env: {}, cwd: '/work', ide: async () => ({ flags: ['--ide'], reason: 'one' }) });
    assert.ok(plan.args.includes('--ide'), `the flag reaches the command line: ${plan.args.join(' ')}`);
    // It goes before the person's own arguments, which stay last and keep winning.
    assert.ok(plan.args.indexOf('--ide') < plan.args.length);

    const quiet = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile,
      directory: dir, env: {}, cwd: '/work', ide: async () => ({ flags: [], reason: 'two editors' }) });
    assert.ok(!quiet.args.includes('--ide'), 'and is absent when the decision says so');
    assert.equal(quiet.ide.reason, 'two editors', 'with the reason kept for the pane to print');

    // A launch that names no working directory cannot decide, and says that rather than guessing.
    const blind = await agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile,
      directory: dir, env: {} });
    assert.ok(!blind.args.includes('--ide'));
    assert.match(blind.ide.reason, /No working directory/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
