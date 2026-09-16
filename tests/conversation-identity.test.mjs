import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentLaunch, describeSession } from './agents-client.mjs';
import { bind } from './agents-client.mjs';
import { startServer } from './red-host-fixture.mjs';
import { agentTitle } from './sessions-client.mjs';
import { endStateServices } from './state-services.mjs';
import { fakeCli } from './task-fixtures.mjs';
import { Tokens, readIdentity } from './token-client.mjs';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through the service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (tests/cargo.mjs). */
before(() => built('--bins'));


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
  assert.deepEqual(fresh.args, ['--mcp-config', fresh.generic, '--settings', fresh.settings, '--session-id', HOST],
    'and the CLI is told it once, from the conversations table, beside the settings that ask it to report back');
  assert.equal(count(fresh.args, '--session-id') + count(fresh.args, '--resume'), 1, 'exactly one identifier is named');
  assert.deepEqual(fresh.identity.session, { provider: 'claude', id: HOST, known: true, source: 'workspace',
    resume: `claude --resume ${HOST}` }, 'the identity says where the id came from and how to resume it');
  assert.equal(fresh.identity.label, `claude ${HOST.slice(0, 8)}`);
  assert.equal(fresh.conversation, HOST, 'and the plan reports it, so the host record follows the launch');

  const resumed = await launch(contextFile, { conversation: HOST, resume: true });
  assert.deepEqual(resumed.args, ['--mcp-config', resumed.generic, '--settings', resumed.settings, '--resume', HOST],
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
    assert.deepEqual(plan.args, ['--mcp-config', plan.generic, '--settings', plan.settings, flag, MINE],
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
    assert.deepEqual(plan.args, ['--mcp-config', plan.generic, '--settings', plan.settings, ...args],
      'and no identifier is injected that would claim otherwise');
    assert.equal(plan.conversation, null, 'null, not undefined: the host is told to claim nothing for this pane');
    assert.match(await describeSession(plan.identity), /unknown/);
  }
  const codex = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile, env: {}, conversation: HOST });
  assert.equal(codex.conversation, null, 'codex cannot be told a conversation to start (F113: resume-only), so the record is actively cleared too');
  assert.equal(codex.args.includes(HOST), false);
  const gemini = await agentLaunch({ agent: 'gemini', executable: '/installed/gemini', contextFile, env: {}, conversation: HOST });
  assert.equal(gemini.conversation, undefined, 'an agent that names its own conversations is recorded with nothing at all');
  assert.equal(gemini.args.includes(HOST), false);
});

// The pane's own record must follow the pane. `null` clears it, so restart_agent refuses by name
// rather than resuming a conversation this pane never held.
test('the host record follows the launch, including when the launch claims nothing', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-record-'));
  const stateDir = path.join(directory, 'state');
  const host = await startServer({ stateDir });
  t.after(async () => { await host.close({ retain: false }); await endStateServices(stateDir); await rm(directory, { recursive: true, force: true }); });
  const root = await host.store.addRoot(directory);
  await fakeCli(stateDir, 'claude');
  /* A REAL agent pane, because the record belongs to the state directory's service (charter D62)
     and a fabricated one would be this spec's idea of a pane rather than the workspace's. */
  const pane = await host.sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude', conversation: HOST, resume: true });
  assert.equal(pane.conversation, HOST, 'the pane starts on the conversation it was told');

  const reported = async conversation => {
    const answer = await fetch(`${host.url}/api/agent-conversation`, {
      method: 'POST', headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: pane.id, conversation, agent: 'claude' }),
    });
    return answer.json();
  };
  const took = await reported(MINE);
  assert.equal(took.conversation, MINE, 'the pane reported another conversation, and the record took it');
  assert.equal(took.title, `claude ${MINE.slice(0, 8)} · ${root.name}`, 'the pane title shows the same eight characters');
  const persisted = (await host.store.listConversations(root.id)).map(entry => entry.id);
  assert.ok(persisted.includes(MINE), `and it is what the project persists: ${persisted}`);

  const cleared = await reported(null);
  assert.equal(cleared.conversation, undefined, 'a launch that claims nothing leaves the pane holding nothing');
  assert.deepEqual((await host.store.listConversations(root.id)).map(entry => entry.id), persisted,
    'and persists nothing new');
  await assert.rejects(host.sessions.restartAgent(pane.id), /no conversation/i,
    'so a restart refuses by name instead of resuming a conversation this pane never had');
});

test('a restart puts the pane back on the same conversation, so the identity survives it', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-restart-plan-'));
  const stateDir = path.join(directory, 'state');
  const host = await startServer({ stateDir });
  t.after(async () => { await host.close({ retain: false }); await endStateServices(stateDir); await rm(directory, { recursive: true, force: true }); });
  const root = await host.store.addRoot(directory);
  await fakeCli(stateDir, 'claude');
  /* A real pane, restarted through the route: the host that owns the record is the one that
     composes the replacement, and what it composes is the same conversation as a resume. */
  const pane = await host.sessions.terminal({ rootId: root.id, type: 'agent', agent: 'claude', conversation: HOST, resume: true });
  assert.equal(pane.conversation, HOST);
  const replacement = await host.sessions.restartAgent(pane.id);
  assert.equal(replacement.conversation, HOST, 'the replacement pane is on the same conversation');
  assert.notEqual(replacement.id, pane.id, 'and it is a new pane');
  assert.equal(host.sessions.snapshot(pane.id).state, 'exited', 'the one it replaced is stopped');
  const spawned = [{ conversation: HOST, resume: true }];

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
  const stateDir = path.join(directory, 'state');
  const host = await startServer({ stateDir });
  let open = true;
  t.after(async () => { if (open) await host.close({ retain: false }); await endStateServices(stateDir); });
  const root = await host.store.addRoot(directory);
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ rootId: root.id }));

  const plan = await launch(contextFile, { conversation: HOST });
  await host.store.recordConversation(root.id, { conversation: plan.conversation, agent: 'claude' });

  const runtime = path.join(directory, 'runtime');
  const tokens = await Tokens.open(runtime);
  t.after(() => tokens.close());
  const ledger = await tokens.ledger(root.id);
  // The headers the tool server puts on the wire for this launch (red-mcp).
  await ledger.seen(readIdentity({ 'x-rengine-agent': plan.identity.agentId, 'x-rengine-agent-label': plan.identity.label,
    'x-rengine-agent-pid': String(plan.identity.pid) }));
  await ledger.persist();

  /* A second host on the same state directory: the conversation the first one persisted is the
     directory's, not that host's. */
  await host.close({ retain: false });
  open = false;
  const reopened = await startServer({ stateDir });
  t.after(() => reopened.close({ retain: false }));
  const remembered = await reopened.store.listConversations(root.id);
  assert.deepEqual(remembered.map(entry => entry.id), [HOST], 'the conversation outlives the host that recorded it');
  /* The ledger ON DISK, which is what a replacement reads: the service holds this one in memory, so
     asking it again would prove only that it remembered, not that it wrote it down. */
  const stored = JSON.parse(await readFile(path.join(runtime, 'tokens', root.id, 'token.json'), 'utf8'));
  const identities = Object.values(stored.identities);
  assert.deepEqual(identities.map(entry => entry.agentId), [HOST],
    'and the ledger knows it by the very same id — there is nothing to migrate, because there is only one uuid');
  assert.equal(identities[0].label, `claude ${HOST.slice(0, 8)}`, 'under the label derived from that id and the agent');
  assert.equal(remembered[0].agent, 'claude');
});
