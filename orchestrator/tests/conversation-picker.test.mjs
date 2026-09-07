import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/agent.sh');
const OLDER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NEWER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-picker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  const bin = path.join(dir, 'bin');
  await mkdir(project); await mkdir(bin);
  // The fake CLI reports what the launcher decided, which is the only thing these tests assert on.
  await writeFile(path.join(bin, 'codex'),
    '#!/bin/bash\nprintf "conversation=%s\\n" "${RENGINE_AGENT_CONVERSATION:-none}"\nprintf "resume=%s\\n" "${RENGINE_AGENT_RESUME:-none}"\n', { mode: 0o755 });
  const listing = path.join(dir, 'conversations.tsv');
  await writeFile(listing, `${NEWER}\tcodex\t2 hours ago\n${OLDER}\tcodex\tyesterday\n`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RENGINE_AGENT_HOME: path.join(dir, 'managed') };
  const run = (input, overrides = {}) => spawnSync('bash', [script, '--project', project, '--agent', 'codex', '--action', 'launch'],
    { env: { ...env, ...overrides }, input, encoding: 'utf8', timeout: 10000 });
  return { dir, project, env, listing, run };
}

test('a pane offers the conversations this project already has', async t => {
  const { run, listing } = await fixture(t);
  const result = run('1\n', { RENGINE_AGENT_CONVERSATIONS: listing });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 hours ago/, 'the choices are shown with when they were last seen');
  assert.match(result.stdout, /yesterday/);
  assert.match(result.stdout, new RegExp(`conversation=${NEWER}`), 'choosing 1 resumes the most recent');
  assert.match(result.stdout, /resume=1/, 'and it resumes rather than starting a new one');
});

test('Enter starts a new conversation, and an out-of-range choice does not resume a wrong one', async t => {
  const { run, listing } = await fixture(t);
  const fresh = run('\n', { RENGINE_AGENT_CONVERSATIONS: listing });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /conversation=none/, 'Enter leaves the conversation for the workspace to mint');
  assert.match(fresh.stdout, /resume=none/);
  const bogus = run('9\n', { RENGINE_AGENT_CONVERSATIONS: listing });
  assert.equal(bogus.status, 0, bogus.stderr);
  assert.match(bogus.stdout, /conversation=none/, 'an out-of-range choice starts a new conversation rather than guessing');
});

test('the picker stays out of the way when there is nothing to offer', async t => {
  const { run, dir, listing } = await fixture(t);
  const none = run('', {});
  assert.equal(none.status, 0, none.stderr);
  assert.equal(/Resume/.test(none.stdout), false, 'no listing, no prompt');
  assert.match(none.stdout, /conversation=none/);

  const empty = path.join(dir, 'empty.tsv');
  await writeFile(empty, '');
  assert.equal(/Resume/.test(run('', { RENGINE_AGENT_CONVERSATIONS: empty }).stdout), false, 'an empty listing is not a prompt');

  const other = path.join(dir, 'other.tsv');
  await writeFile(other, `${NEWER}\tclaude\t2 hours ago\n`);
  assert.equal(/Resume/.test(run('', { RENGINE_AGENT_CONVERSATIONS: other }).stdout), false, 'another agent’s conversations are not offered');

  const already = run('', { RENGINE_AGENT_CONVERSATIONS: listing, RENGINE_AGENT_CONVERSATION: OLDER, RENGINE_AGENT_RESUME: '1' });
  assert.equal(/Resume/.test(already.stdout), false, 'a restart that already named its conversation is not asked again');
  assert.match(already.stdout, new RegExp(`conversation=${OLDER}`));
});

// The workspace mints an id for a fresh pane before the pane runs, so "already has a conversation"
// cannot be what suppresses the offer — only an explicit resume can.
test('a workspace-minted conversation is still offered the history, and Enter keeps the new one', async t => {
  const { run, listing } = await fixture(t);
  const MINTED = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const keep = run('\n', { RENGINE_AGENT_CONVERSATIONS: listing, RENGINE_AGENT_CONVERSATION: MINTED });
  assert.equal(keep.status, 0, keep.stderr);
  assert.match(keep.stdout, /Resume which/, 'a freshly minted pane still sees what it could resume instead');
  assert.match(keep.stdout, new RegExp(`conversation=${MINTED}`), 'Enter keeps the conversation the workspace minted');
  assert.match(keep.stdout, /resume=none/, 'and does not turn a new conversation into a resume');
  const swap = run('2\n', { RENGINE_AGENT_CONVERSATIONS: listing, RENGINE_AGENT_CONVERSATION: MINTED });
  assert.match(swap.stdout, new RegExp(`conversation=${OLDER}`), 'choosing one replaces the minted id');
  assert.match(swap.stdout, /resume=1/);
});
