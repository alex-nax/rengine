import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceStore } from '../server/store.mjs';

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
