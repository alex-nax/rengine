import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { startTokenSidecar, tokenFrame } from './token-desktop-fixtures.mjs';

/* Spec 103 decision 1 and criterion 1: the Sessions tab marks which live agent session holds the
   project token and offers Revoke beside it, Free when the holder's process is gone. The ledger is
   stage 2 of spec 095 and is not re-invented here — the fixture pushes the ledger's own `token`
   frames and keeps the `token-action` frames the desktop sends back, exactly as native-token
   asserts for the status-bar popover. What is asserted here is that the row is keyed on the
   holder's agentId, that it sends the popover's frame and no other, and that it follows the next
   frame rather than remembering the last one. */

/* Larger than pid_max on every platform this desktop builds for (99998 on macOS, 2^22 on Linux),
   so the ledger's holder is a process that provably cannot be running. */
const GONE_PID = 2147483647;
const STRANGER = '33333333-3333-4333-8333-333333333333';

const roleKeys = (state, role) => (state.controls ?? []).filter(c => c.role === role).map(c => c.key);
const row = (state, conversation) => (state.conversations ?? []).find(c => c.conversation === conversation);

/* One live claude pane on a fresh root, seen through the worker stand-in. `--action menu` blocks on
   its own prompt, so the pane stays running for the length of the test, and claude is a CLI rEngine
   names the conversation of — which is the identity the ledger's holder is keyed on (spec 095). */
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-sessions-token-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const sidecar = await startTokenSidecar(server);
  const root = await server.store.addRoot(dir);
  const live = await server.sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude', action: 'menu' });
  assert.equal(live.state, 'running');
  assert.ok(live.conversation, 'the pane holds the conversation the ledger identifies it by');
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  t.after(async () => { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects through the worker stand-in');
  assert.ok(await sidecar.settled(), 'the desktop holds an /events socket through the stand-in');
  await gui.control('toolbar', 'Sessions', -1);
  await gui.until(s => roleKeys(s, 'conversation-attach').includes(live.id), 'the live agent is listed');
  return { server, sidecar, gui, root, live, conversation: live.conversation };
}

const holder = (agentId, pid) => ({ agentId, label: 'claude', pid, since: '2026-09-07T09:15:00.000Z' });

test('the Sessions tab marks the token holder, revokes it there, and follows the next frame', { timeout: 90000 }, async t => {
  const { sidecar, gui, root, conversation } = await workspace(t);

  /* Before the ledger speaks no row claims the token: "free" and "held" are both claims about a
     ledger this window has not heard from. */
  let state = await gui.until(s => row(s, conversation), 'the live conversation is reported as a row');
  assert.equal(row(state, conversation).holdsToken, false);
  assert.equal(row(state, conversation).live, true);
  assert.deepEqual(roleKeys(state, 'conversation-revoke'), []);
  assert.deepEqual(roleKeys(state, 'conversation-free'), []);

  sidecar.push(tokenFrame({ rootId: root.id, holder: holder(conversation, process.pid) }));
  state = await gui.until(s => row(s, conversation)?.holdsToken === true, 'the holder\'s own row is marked');
  assert.equal(row(state, conversation).tokenAction, 'revoke', 'a holder that is still running is revoked, not freed');
  assert.deepEqual(roleKeys(state, 'conversation-revoke'), [conversation], 'Revoke sits beside the agent it concerns');
  assert.deepEqual(roleKeys(state, 'conversation-free'), [], 'and Free is not also offered for a live holder');

  /* The same frame the popover sends (spec 095, "Desktop → worker"), through the same sender:
     no contestId, because a revoke is about a held token and not about a contest. */
  await gui.control('conversation-revoke', conversation, -1);
  const frame = await sidecar.waitFor(f => f.type === 'token-action', 'a token-action frame from the Sessions tab');
  assert.deepEqual(frame, { type: 'token-action', rootId: root.id, action: 'revoke' });
  assert.equal(sidecar.of('token-action').length, 1, 'one press, one frame');

  /* The ledger answers with the next `token` frame and the row follows it rather than remembering
     what it drew last. */
  sidecar.push(tokenFrame({ rootId: root.id, holder: null, sequence: 2 }));
  state = await gui.until(s => row(s, conversation)?.holdsToken === false, 'a freed token clears the mark');
  assert.equal(row(state, conversation).tokenAction, '');
  assert.deepEqual(roleKeys(state, 'conversation-revoke'), []);
  assert.deepEqual(roleKeys(state, 'conversation-free'), []);
});

test('a holder whose process is gone offers Free, and a row that holds nothing offers neither', { timeout: 90000 }, async t => {
  const { sidecar, gui, root, conversation } = await workspace(t);

  /* Decision 11: a holder whose process is gone holds nothing, so the gesture the row offers is
     the one that takes a dead hold off the ledger. */
  sidecar.push(tokenFrame({ rootId: root.id, holder: holder(conversation, GONE_PID) }));
  let state = await gui.until(s => row(s, conversation)?.holdsToken === true, 'the gone holder is still marked on its own row');
  assert.equal(row(state, conversation).tokenAction, 'free', 'a holder whose process is gone is freed, not revoked');
  assert.deepEqual(roleKeys(state, 'conversation-free'), [conversation]);
  assert.deepEqual(roleKeys(state, 'conversation-revoke'), [], 'and Revoke is not offered for a hold nobody is keeping');

  await gui.control('conversation-free', conversation, -1);
  const frame = await sidecar.waitFor(f => f.type === 'token-action', 'a token-action frame from the Sessions tab');
  assert.deepEqual(frame, { type: 'token-action', rootId: root.id, action: 'free' });

  /* Another agent's hold is another agent's business: this row is keyed on the holder's agentId,
     not on "some token is held". */
  sidecar.push(tokenFrame({ rootId: root.id, holder: holder(STRANGER, process.pid), sequence: 2 }));
  state = await gui.until(s => s.token.holder?.agentId === STRANGER, 'the ledger names a holder this pane is not');
  await delay(200);
  state = await gui.command({ op: 'state' });
  assert.equal(row(state, conversation).holdsToken, false, 'a row for a non-holder carries no mark');
  assert.equal(row(state, conversation).tokenAction, '');
  assert.deepEqual(roleKeys(state, 'conversation-revoke'), []);
  assert.deepEqual(roleKeys(state, 'conversation-free'), []);
});
