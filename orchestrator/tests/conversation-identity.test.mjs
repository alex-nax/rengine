import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentLaunch, describeSession } from '../agents/config.mjs';
import { bind } from '../agents/bind.mjs';
import { startServer } from '../server/main.mjs';
import { WorkspaceStore } from '../server/store.mjs';
import { Sessions, agentTitle } from '../server/sessions.mjs';
import { Ledger, readIdentity } from '../runtime/token.mjs';

/* Two lanes taught the launcher to pass --session-id: the per-launch identity (spec 095) and the
   pane's conversation (spec 096). Merged as-is a pane would carry both, with two different UUIDs.
   These pin the reconciliation: the conversation IS the identity, and exactly one id is ever named.
   See docs/evidence/conversation-is-identity-2026-09-07.md. */
const HOST = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';   // what the session host minted for the pane
const MINE = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';   // what a person's own flags name
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';

async function context(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ rootId: ROOT_ID }));
  return { directory, contextFile };
}
const launch = (contextFile, options) => agentLaunch({ agent: 'claude', executable: '/installed/claude', contextFile, env: {}, ...options });
const count = (args, flag) => args.filter(value => value === flag).length;

test('a pane launch carries exactly one conversation, and that conversation is the identity', async t => {
  const { contextFile } = await context(t, 'rengine-one-uuid-');

  const fresh = await launch(contextFile, { conversation: HOST });
  assert.equal(fresh.identity.agentId, HOST, 'the host’s conversation IS the agentId, not a second uuid beside it');
  assert.deepEqual(fresh.args, ['--mcp-config', fresh.generic, '--session-id', HOST],
    'and the CLI is told it once, from the conversations table');
  assert.equal(count(fresh.args, '--session-id') + count(fresh.args, '--resume'), 1, 'exactly one identifier is named');
  assert.deepEqual(fresh.identity.session, { provider: 'claude', id: HOST, known: true, source: 'workspace',
    resume: `claude --resume ${HOST}` }, 'the identity says where the id came from and how to resume it');
  assert.equal(fresh.identity.label, `claude ${HOST.slice(0, 8)}`);
  assert.equal(fresh.conversation, HOST, 'and the plan reports it, so the host record follows the launch');

  const resumed = await launch(contextFile, { conversation: HOST, resume: true });
  assert.deepEqual(resumed.args, ['--mcp-config', resumed.generic, '--resume', HOST],
    'a resume names the same conversation with --resume, and still only once');
  assert.equal(resumed.identity.agentId, HOST, 'the identity is the same across the resume, so the token holder is too');
  assert.equal(resumed.identity.label, fresh.identity.label);
  assert.equal(resumed.conversation, HOST);
});

// Refinement from the author of specs 096-098: the launcher's identity is the single source, so a
// contradiction is resolved in the person's favour and reported back, never refused.
test('a person’s own --resume wins over the host’s conversation, and the record follows the launch', async t => {
  const { contextFile } = await context(t, 'rengine-flags-win-');
  for (const flag of ['--session-id', '--resume', '-r']) {
    const plan = await launch(contextFile, { args: [flag, MINE], conversation: HOST });
    assert.equal(plan.identity.agentId, MINE, `${flag} names the conversation this launch will be`);
    assert.deepEqual(plan.args, ['--mcp-config', plan.generic, flag, MINE],
      'the args pass through untouched, with no second identifier injected beside them');
    assert.equal(plan.args.includes(HOST), false, 'and the conversation the host minted is nowhere on the argv');
    assert.equal(plan.conversation, MINE, 'the pane reports what actually launched, so the record cannot lie');
    assert.equal(plan.identity.session.known, true);
  }
  const inline = await launch(contextFile, { args: [`--resume=${MINE.toUpperCase()}`], conversation: HOST });
  assert.equal(inline.identity.agentId, MINE, 'in either spelling, lowercased');
});

test('a launch that continues or forks reports no conversation rather than claiming a minted one', async t => {
  const { contextFile } = await context(t, 'rengine-opaque-');
  for (const args of [['-c'], ['--continue'], ['--resume', 'some search term'], ['--resume', MINE, '--fork-session']]) {
    const plan = await launch(contextFile, { args, conversation: HOST });
    assert.equal(plan.identity.session.known, false, `${args.join(' ')} continues or forks a conversation the CLI names itself`);
    assert.notEqual(plan.identity.agentId, HOST, 'so the identity is rEngine’s own');
    assert.deepEqual(plan.args, ['--mcp-config', plan.generic, ...args], 'and nothing is injected that would claim otherwise');
    assert.equal(plan.conversation, null, 'null, not undefined: the host is told to claim nothing for this pane');
    assert.match(describeSession(plan.identity), /unknown/);
  }
  const codex = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile, env: {}, conversation: HOST });
  assert.equal(codex.conversation, undefined, 'an agent that names its own conversations is recorded with nothing at all');
  assert.equal(codex.args.includes(HOST), false);
});

// The pane's own record must follow the pane. `null` clears it, so restart_agent refuses by name
// rather than resuming a conversation this pane never held.
test('the host record follows the launch, including when the launch claims nothing', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-record-'));
  const store = await WorkspaceStore.open(path.join(directory, 'state'));
  const root = await store.addRoot(directory);
  const sessions = new Sessions(store);
  t.after(async () => { await sessions.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const pane = { id: 'pane', rootId: root.id, type: 'agent', agent: 'claude', conversation: HOST, titleAuto: true,
    title: agentTitle('claude', HOST, root.name), state: 'running', cols: 100, rows: 30, output: '', sequence: 0, createdAt: Date.now() };
  sessions.items.set(pane.id, pane);

  const swapped = await sessions.recordConversation(pane.id, MINE, 'claude');
  assert.equal(swapped.conversation, MINE, 'the pane reported another conversation, and the record took it');
  assert.equal(swapped.title, `claude ${MINE.slice(0, 8)} · ${root.name}`, 'the pane title shows the same eight characters');
  assert.deepEqual(store.listConversations(root.id).map(entry => entry.id), [MINE], 'and it is what the project persists');

  const cleared = await sessions.recordConversation(pane.id, null, 'claude');
  assert.equal(cleared.conversation, undefined, 'a launch that claims nothing leaves the pane holding nothing');
  assert.deepEqual(store.listConversations(root.id).map(entry => entry.id), [MINE], 'and persists nothing new');
  await assert.rejects(sessions.restartAgent(pane.id), /no conversation/i,
    'so a restart refuses by name instead of resuming a conversation this pane never had');
});

test('a restart puts the pane back on the same conversation, so the identity survives it', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-restart-plan-'));
  const store = await WorkspaceStore.open(path.join(directory, 'state'));
  const root = await store.addRoot(directory);
  const sessions = new Sessions(store);
  t.after(async () => { await sessions.shutdown(); await rm(directory, { recursive: true, force: true }); });
  sessions.items.set('pane', { id: 'pane', rootId: root.id, type: 'agent', agent: 'claude', conversation: HOST,
    titleAuto: true, title: agentTitle('claude', HOST, root.name), state: 'running', cols: 111, rows: 33, output: '', sequence: 0, createdAt: Date.now() });
  const spawned = [];
  sessions.stop = async () => {};
  sessions.spawnTerminal = async options => { spawned.push(options); return { id: 'replacement' }; };
  await sessions.restartAgent('pane');
  assert.deepEqual(spawned, [{ rootId: root.id, type: 'agent', agent: 'claude', conversation: HOST, resume: true, cols: 111, rows: 33 }],
    'the replacement pane is spawned on the same conversation, as a resume');

  const { contextFile } = await context(t, 'rengine-restart-launch-');
  const before = await launch(contextFile, { conversation: HOST });
  const after = await launch(contextFile, { conversation: spawned[0].conversation, resume: spawned[0].resume });
  assert.equal(after.identity.agentId, before.identity.agentId,
    'and the plan it produces is the same identity, so the token ledger keeps the holder across a restart');
  assert.equal(after.identity.label, before.identity.label);
});

test('binding outside the workspace mints and injects, and the eight characters are the same everywhere', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-bind-mint-'));
  const stateDir = path.join(directory, 'state');
  const project = path.join(directory, 'project');
  await mkdir(project, { recursive: true });
  const server = await startServer({ stateDir });
  await writeFile(path.join(stateDir, 'sidecar.json'),
    JSON.stringify({ url: server.url, token: server.token, instance: server.instance, pid: process.pid }), { mode: 0o600 });
  const root = await server.store.addRoot(project);
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });

  const bound = await bind(['--project', project, '--state', stateDir, '--agent', 'claude']);
  const id = bound.identity.agentId;
  assert.equal(bound.plan.conversation, id, 'a bind with no host conversation mints one, and it is the identity');
  assert.deepEqual(bound.plan.args.slice(-2), ['--session-id', id], 'and injects it exactly once');
  assert.equal(count(bound.plan.args, '--session-id'), 1);
  const prefix = id.slice(0, 8);
  assert.equal(bound.identity.label, `claude ${prefix}`, 'the label carries the prefix');
  assert.equal(agentTitle('claude', id, root.name), `claude ${prefix} · ${root.name}`, 'so does the pane title');
  assert.equal(JSON.parse(await readFile(bound.plan.contextFile, 'utf8')).agent.session.id, id,
    'and the tool worker sends that same id as this agent');
});

/* Spec 097 persists a bounded per-root list of conversations. With one uuid those entries ARE
   identities: the same id the ledger keys on, with the same label, on both sides of a host restart. */
test('a conversation the workspace persisted is a known identity to the token ledger after a restart', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-conversation-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await WorkspaceStore.open(path.join(directory, 'state'));
  const root = await store.addRoot(directory);
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ rootId: root.id }));

  const plan = await launch(contextFile, { conversation: HOST });
  await store.recordConversation(root.id, { conversation: plan.conversation, agent: 'claude' });

  const runtime = path.join(directory, 'runtime');
  const ledger = await Ledger.open(runtime, root.id, { alive: () => true });
  // The headers the tool worker puts on the wire for this launch (mcp-worker.mjs).
  ledger.seen(readIdentity({ 'x-rengine-agent': plan.identity.agentId, 'x-rengine-agent-label': plan.identity.label,
    'x-rengine-agent-pid': String(plan.identity.pid) }));
  await ledger.persist();

  const reopenedStore = await WorkspaceStore.open(path.join(directory, 'state'));
  const remembered = reopenedStore.listConversations(root.id);
  assert.deepEqual(remembered.map(entry => entry.id), [HOST], 'the conversation outlives the host that recorded it');
  const reopened = await Ledger.open(runtime, root.id, { alive: () => true });
  const identities = reopened.status().identities;
  assert.deepEqual(identities.map(entry => entry.agentId), [HOST],
    'and the ledger knows it by the very same id — there is nothing to migrate, because there is only one uuid');
  assert.equal(identities[0].label, `claude ${HOST.slice(0, 8)}`, 'under the label derived from that id and the agent');
  assert.equal(remembered[0].agent, 'claude');
});
