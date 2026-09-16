import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from './store-client.mjs';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through a service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (tests/cargo.mjs). */
before(() => built('--bins'));


// A conversation that lives only in the session host's memory dies with the host, which is the one
// event a restart into it has to survive. See docs/specs/097-agent-conversation-persistence.md.
test('conversations outlive the session host that recorded them', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-conversations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');

  const first = await WorkspaceStore.open(state);
  const root = await first.addRoot(dir);
  assert.deepEqual(first.listConversations(root.id), [], 'a project starts with none');
  await first.recordConversation(root.id, { conversation: '11111111-1111-1111-1111-111111111111', agent: 'claude' });
  await first.recordConversation(root.id, { conversation: '22222222-2222-2222-2222-222222222222', agent: 'claude' });

  // The host dies here. A new one opens the same state directory.
  const second = await WorkspaceStore.open(state);
  const listed = second.listConversations(root.id);
  assert.equal(listed.length, 2, 'both survived the restart');
  assert.equal(listed[0].id, '22222222-2222-2222-2222-222222222222', 'most recently seen first');
  assert.equal(listed[0].agent, 'claude');
  assert.ok(Number.isInteger(listed[0].lastSeenAt), 'each carries when it was last seen');
  assert.deepEqual(second.listConversations('00000000-0000-0000-0000-000000000000'), [], 'another project sees none of them');

  // Re-recording an existing conversation touches it rather than duplicating it.
  await second.recordConversation(root.id, { conversation: '11111111-1111-1111-1111-111111111111', agent: 'claude' });
  const touched = second.listConversations(root.id);
  assert.equal(touched.length, 2, 'no duplicate row');
  assert.equal(touched[0].id, '11111111-1111-1111-1111-111111111111', 'and it moves to the front');

  await assert.rejects(second.recordConversation(root.id, { conversation: 'not-a-uuid', agent: 'claude' }), /conversation/i);
  await assert.rejects(second.recordConversation('00000000-0000-0000-0000-000000000000', { conversation: '33333333-3333-3333-3333-333333333333', agent: 'claude' }), /root/i);
});

/* kimi names its own conversations, so the shapes kimi resumes by are recorded under kimi's own
   name (spec 127); everything else keeps the UUID-only rule it always had. */
test('a conversation id is accepted in the shape the named CLI resumes by, and no other', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-conversations-kimi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);

  const session = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
  await store.recordConversation(root.id, { conversation: session, agent: 'kimi' });
  assert.equal(store.listConversations(root.id)[0].id, session);
  await store.recordConversation(root.id, { conversation: '01HZYJ8K3M4N5P6Q7R8S9T0V1W', agent: 'kimi' });
  assert.equal(store.listConversations(root.id).length, 2, 'the documented ULID shape is one too');
  await assert.rejects(store.recordConversation(root.id, { conversation: session, agent: 'claude' }), /conversation/i,
    'a kimi-shaped id under another name is not a conversation rEngine can vouch for');
  await assert.rejects(store.recordConversation(root.id, { conversation: 'not-a-session', agent: 'kimi' }), /conversation/i);
});

test('the remembered list is bounded, so a long-lived project cannot grow it without limit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-conversations-bound-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  for (let index = 0; index < 40; index++) {
    await store.recordConversation(root.id, { conversation: `${String(index).padStart(8, '0')}-0000-0000-0000-000000000000`, agent: 'claude' });
  }
  const listed = store.listConversations(root.id);
  assert.ok(listed.length <= 20, `kept ${listed.length}, expected at most 20`);
  assert.equal(listed[0].id, '00000039-0000-0000-0000-000000000000', 'the newest is kept');
  assert.equal(listed.some(entry => entry.id === '00000000-0000-0000-0000-000000000000'), false, 'the oldest is dropped');
});

/* F215, spec 141: the store does not know what any CLI's ids look like — the shape arrives from
   that CLI's own recipe. A recipe added as data, for a CLI with no code anywhere in the tree, gets
   its ids accepted and everything else refused, with no edit to the store. */
test('the id shape a conversation must satisfy comes from the recipe, not from the store', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-conversations-declared-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extra = path.join(dir, 'extra.toml');
  await writeFile(extra, `[recipes.shoutycli]
package = "@test/shoutycli"

[recipes.shoutycli.update]
kind = "reinstall"

[recipes.shoutycli.models]
kind = "none"

[recipes.shoutycli.mcp]
kind = "flag"
flag = "--servers"

[recipes.shoutycli.conversation]
ids = '^CONV-[0-9]{6}$'
parser = "claude-flags"
normalize = "none"
provider = "shoutycli"
resumeLine = "shoutycli --resume {id}"
`);
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  process.env.RENGINE_AGENT_REGISTRY = path.resolve('orchestrator/agents/registry.toml');
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; delete process.env.RENGINE_AGENT_REGISTRY; });

  const store = await WorkspaceStore.open(path.join(dir, 'state'));
  const root = await store.addRoot(dir);
  await store.recordConversation(root.id, { conversation: 'CONV-004217', agent: 'shoutycli' });
  assert.equal(store.listConversations(root.id)[0].id, 'CONV-004217', 'the declared shape is accepted');
  await assert.rejects(store.recordConversation(root.id, { conversation: 'CONV-42', agent: 'shoutycli' }), /conversation/i,
    'and an id its own recipe refuses is refused, with the message unchanged');
  /* The declaration belongs to the CLI that made it: the same id under another name is not one. */
  await assert.rejects(store.recordConversation(root.id, { conversation: 'CONV-004217', agent: 'claude' }), /conversation/i);
});
