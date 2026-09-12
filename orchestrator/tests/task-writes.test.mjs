import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { agentLaunch } from '../agents/config.mjs';
import { readDeclaration, CONTRACTS } from '../server/formats.mjs';
import { validateSchema } from '../server/store-client.mjs';
import { agentsMenu, codexModels, modelArgs, promptFor, promptValues, writeDocument } from '../server/tasks.mjs';
import { declaration } from './format-fixtures.mjs';
import { api, fakeDesktop, feedSocket, identity, ok, until } from './token-fixtures.mjs';
import { fakeCli, features, taskDeclaration, taskProject, writeLog } from './task-fixtures.mjs';

const schema = JSON.parse(readFileSync('contracts/project-v1.schema.json', 'utf8'));
const toolWorkerMain = fileURLToPath(new URL('../agents/mcp-worker.mjs', import.meta.url));
const status = (worker, rootId, who) => ok(worker, `token?${new URLSearchParams({ rootId })}`, undefined, who);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function workspace(t, { document = taskDeclaration(), window = 700 } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-task-')));
  const project = await taskProject(directory, 'project', document);
  const stateDir = path.join(directory, 'state');
  const host = await startServer({ stateDir });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance }, { directory: path.join(directory, 'runtime') });
  t.after(async () => { await worker.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  if (window) await ok(worker, 'preferences', { tokenWindowMs: window });
  return { directory, project, stateDir, host, root, worker };
}
const hold = (worker, rootId, who) => ok(worker, 'token-action', { rootId, action: 'contest' }, who);

test('contract 6 carries tracker.write and the agent menu, and a contract-5 declaration is accepted unchanged', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-contract6-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const declare = async (name, document) => {
    const root = path.join(directory, name);
    await mkdir(path.join(root, '.rengine'), { recursive: true });
    await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
    return readDeclaration(root);
  };
  // The ceiling is 9 since the pack manifest (F109); this stays a tripwire, so whoever raises it
  // next comes here and confirms that contract 6's own keys still read as they do below.
  // Confirmed for 8: artwork adds icon.image and wordmark, touches neither tracker.write nor
  // agents, and the assertions below ran unchanged.
  // Confirmed for 9: packs is its own block with its own SECTIONS floor, reaches neither
  // tracker.write nor agents, and the assertions below ran unchanged.
  // Confirmed for 10: tests is its own block naming one file, with its own SECTIONS floor; it
  // reaches neither tracker.write nor agents, and the assertions below ran unchanged.
  assert.equal(CONTRACTS.at(-1), 10, 'the ceiling moved with the keys');

  const document = taskDeclaration({ agents: [{ cli: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-opus-5' }] });
  assert.deepEqual(await validateSchema(schema, document), [], 'a contract-6 document validates structurally');
  const six = await declare('six', document);
  assert.equal(six.contract, 6);
  assert.equal(six.error, undefined); assert.equal(six.trackerError, undefined);
  assert.deepEqual(six.tracker.write, ['tools/write-task.mjs', '${json}']);
  assert.deepEqual(six.agents, document.agents, 'the menu reaches the reader rather than being dropped in silence');

  const five = { ...declaration(), contract: 5, title: 'Five', tracker: { provider: 'linear', team: 'KOH' } };
  const unchanged = await declare('five', five);
  assert.equal(unchanged.error, undefined); assert.equal(unchanged.trackerError, undefined);
  assert.equal(unchanged.contract, 5); assert.equal(unchanged.title, 'Five');
  assert.deepEqual(unchanged.tracker, five.tracker, 'a contract-5 declaration reads exactly as it did');
  assert.equal(unchanged.agents, undefined);

  const refusals = {
    'write under contract 5': [await declare('early', taskDeclaration({ contract: 5 })), 'trackerError', /write requires contract 6/],
    'agents under contract 5': [await declare('early-agents', { ...declaration(), contract: 5, agents: [{ cli: 'claude', models: ['a'], default: 'a' }] }), 'error', /agents requires contract 6/],
    'write on a remote provider': [await declare('remote', { ...declaration(), contract: 6, tracker: { provider: 'github', repository: 'owner/name', write: ['tools/x', '${json}'] } }), 'trackerError', /write belongs to provider local/],
    'a write that never names the row': [await declare('blind', taskDeclaration({ tracker: { provider: 'local', write: ['tools/write-task.mjs', 'add'] } })), 'trackerError', /must name \$\{json\}/],
    'a default outside its models': [await declare('bad-default', taskDeclaration({ agents: [{ cli: 'claude', models: ['a'], default: 'z' }] })), 'error', /default must be one of its models/],
    'two records for one CLI': [await declare('twice', taskDeclaration({ agents: [{ cli: 'claude', models: ['a'], default: 'a' }, { cli: 'claude', models: ['b'], default: 'b' }] })), 'error', /cli repeats "claude"/],
  };
  for (const [what, [read, key, pattern]] of Object.entries(refusals)) {
    assert.match(read[key] ?? '', pattern, `${what} is refused by name (${key}: ${read[key]})`);
  }
  assert.equal(refusals['write under contract 5'][0].tracker, undefined, 'and the block it refuses is not handed on');
});

test('a project prompt overrides the shipped one, a missing file uses the default, and a misspelled placeholder is named', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-prompt-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = { id: 'r', path: directory };
  const values = promptValues({ id: 7, key: 'F7', title: 'Ship the thing', labels: ['M1', 'core'], criteria: ['One thing', 'Another'] });

  const shipped = await promptFor(root, 'task', values);
  assert.match(shipped.source, /shipped task\.md/);
  for (const fragment of ['F7', 'Ship the thing', 'M1, core', '1. One thing', '2. Another', 'token_contest']) {
    assert.ok(shipped.text.includes(fragment), `the shipped brief carries ${fragment}`);
  }
  assert.doesNotMatch(shipped.text, /\$\{/, 'and nothing is left unfilled');
  const decompose = await promptFor(root, 'decompose', values);
  assert.match(decompose.source, /shipped decompose\.md/);
  assert.ok(decompose.text.includes('parent: "F7"'), 'the decomposition brief names the parent its children take');

  await mkdir(path.join(directory, '.rengine/prompts'), { recursive: true });
  await writeFile(path.join(directory, '.rengine/prompts/task.md'), 'Do ${key}: ${title}\n${criteria}\n');
  const overridden = await promptFor(root, 'task', values);
  assert.equal(overridden.source, '.rengine/prompts/task.md');
  assert.equal(overridden.text, 'Do F7: Ship the thing\n1. One thing\n2. Another\n');
  assert.match((await promptFor(root, 'decompose', values)).source, /shipped decompose\.md/, 'one override does not replace the other');

  await writeFile(path.join(directory, '.rengine/prompts/decompose.md'), 'Break ${titel} into ${key} parts');
  await assert.rejects(() => promptFor(root, 'decompose', values), error => {
    assert.match(error.message, /\$\{titel\}/, 'the misspelling is named');
    assert.match(error.message, /\$\{title\}/, 'beside the placeholders that exist');
    assert.match(error.message, /Nothing was started/);
    return true;
  }, 'a placeholder the project misspells is reported, never emptied');
});

test('a non-holder is refused by name and the project’s own write command never runs', { timeout: 40000 }, async t => {
  const { project, root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  const claimed = await hold(worker, root.id, alice);
  const refused = await api(worker, 'task', { rootId: root.id, action: 'add', row: { id: 9, key: 'F9', description: 'never written' } }, bob);
  assert.equal(refused.status, 409, refused.body.error);
  assert.match(refused.body.error, /held by claude/, 'the refusal names the holder');
  assert.match(refused.body.error, new RegExp(claimed.holder.since.slice(0, 16)), 'and since when');
  assert.match(refused.body.error, /token_contest/, 'and points at token_contest');
  assert.deepEqual(await writeLog(project), [], 'the declared write command was never started');
  assert.deepEqual((await features(project)).map(feature => feature.id), [1, 2], 'and the inventory is untouched');

  /* Decision 6 holds here as everywhere: the person at the desktop sends no identity header. */
  const desktop = await api(worker, 'task', { rootId: root.id, action: 'add', row: { id: 20, key: 'F20', description: 'from the desktop' } });
  assert.equal(desktop.status, 200, `the desktop is never gated: ${desktop.body.error}`);
});

test('the holder runs the declared argv with the JSON row, and two holders in sequence never interleave', { timeout: 60000 }, async t => {
  const { project, root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  await hold(worker, root.id, alice);
  const feed = await feedSocket(worker, (await status(worker, root.id, alice)).feed);
  t.after(() => feed.close());

  const slow = api(worker, 'task', { rootId: root.id, action: 'add', row: { id: 10, key: 'F10', description: 'the slow one', slowMs: 1500 } }, alice);
  await until(async () => (await writeLog(project)).some(line => line.startsWith('start')), 'the first write is inside the project’s command');
  /* The token changes hands while that command is still running, which is the only way to ask
     whether the queue is behind the gate or instead of it. */
  await ok(worker, 'token-action', { rootId: root.id, action: 'release' }, alice);
  await hold(worker, root.id, bob);
  const second = await api(worker, 'task', { rootId: root.id, action: 'add', row: { id: 11, key: 'F11', description: 'the second' } }, bob);
  const first = await slow;

  assert.equal(first.status, 200, first.body.error);
  assert.equal(second.status, 200, second.body.error);
  const log = (await writeLog(project)).filter(line => !line.startsWith('argv'));
  assert.deepEqual(log, ['start add F10', 'end add F10', 'start add F11', 'end add F11'],
    'the second write waited for the first to finish rather than running beside it');

  const handed = JSON.parse(JSON.parse((await writeLog(project)).find(line => line.startsWith('argv')).slice(5))[0]);
  assert.equal(handed.action, 'add'); assert.equal(handed.key, 'F10'); assert.equal(handed.description, 'the slow one');
  assert.equal(first.body.command[0], 'tools/write-task.mjs', 'the declared argv is what ran, root-relative');
  assert.equal(JSON.parse(first.body.command[1]).key, 'F10', 'with ${json} replaced by the row');
  assert.equal(first.body.result.wrote, 10, 'and the command’s own JSON stdout is handed back parsed');
  assert.deepEqual((await features(project)).map(feature => feature.id), [1, 2, 10, 11], 'the inventory changed accordingly');
  assert.ok(second.body.tracker.rows.some(row => row.key === 'F11'), 'and the refreshed row list carries it');

  const added = feed.frames.length ? feed.frames : await until(() => feed.frames.length >= 2 && feed.frames, 'the writes reach the feed');
  const writes = added.filter(frame => frame.type === 'task.added');
  assert.deepEqual(writes.map(frame => frame.key), ['F10', 'F11']);
  assert.deepEqual(writes.map(frame => frame.action), ['add', 'add']);
  assert.deepEqual(writes.map(frame => frame.by.agentId), [alice.agentId, bob.agentId], 'each attributed to the agent that made it');

  const child = await ok(worker, 'task', { rootId: root.id, action: 'decompose', row: { id: 12, key: 'F12', description: 'a child' }, parent: 'F10' }, bob);
  assert.equal(child.result.parent, 'F10');
  assert.equal((await features(project)).find(feature => feature.id === 12).parent, 'F10', 'a decompose write files the row under its parent');
  const orphan = await api(worker, 'task', { rootId: root.id, action: 'decompose', row: { id: 13, key: 'F13' } }, bob);
  assert.equal(orphan.status, 400);
  assert.match(orphan.body.error, /needs the parent/, 'and one with no parent is refused rather than filed at the top level');
  assert.equal((await features(project)).find(feature => feature.id === 13), undefined);

  const updated = await ok(worker, 'task', { rootId: root.id, action: 'update', row: { id: 10, key: 'F10', passes: true } }, bob);
  assert.equal(updated.result.action, 'update');
  assert.equal((await features(project)).find(feature => feature.id === 10).passes, true);
  await until(() => feed.frames.some(frame => frame.type === 'task.updated' && frame.key === 'F10'), 'an update is its own frame');
});

test('a project without tracker.write, and a remote provider, are refused by name with nothing run', { timeout: 40000 }, async t => {
  const bare = await workspace(t, { document: taskDeclaration({ tracker: { provider: 'local' } }) });
  const alice = identity('claude');
  await hold(bare.worker, bare.root.id, alice);
  const nothing = await api(bare.worker, 'task', { rootId: bare.root.id, action: 'add', row: { id: 9, key: 'F9' } }, alice);
  assert.equal(nothing.status, 409, nothing.body.error);
  assert.match(nothing.body.error, /declares no tracker\.write command/);
  assert.match(nothing.body.error, /contract 6/, 'and says where to declare one');
  assert.deepEqual(await writeLog(bare.project), []);

  const remote = await workspace(t, { document: { ...taskDeclaration(), tracker: { provider: 'github', repository: 'owner/name' } } });
  const bob = identity('codex');
  await hold(remote.worker, remote.root.id, bob);
  const refused = await api(remote.worker, 'task', { rootId: remote.root.id, action: 'add', row: { id: 9, key: 'F9' } }, bob);
  assert.equal(refused.status, 409, refused.body.error);
  assert.match(refused.body.error, /tracker is github/);
  assert.match(refused.body.error, /last-write-wins/, 'naming why the remote backends stay read-only');
  assert.deepEqual(await writeLog(remote.project), []);
});

/* The first live spawn (2026-09-07) walked into the spec 097 picker: the project had history, the host
   offered it to the new pane, and a stray keystroke there resumed the *spawning* agent's conversation
   in a second process. A spawn answers that question when it makes the call — it names the conversation
   it minted — and a caller that named one is never offered a list. */
test('a spawn names the conversation it mints, and its pane is offered no history to mis-answer', { timeout: 90000 }, async t => {
  const { stateDir, host, root, worker } = await workspace(t);
  const claude = await fakeCli(stateDir, 'claude');
  const earlier = randomUUID();
  await host.store.recordConversation(root.id, { conversation: earlier, agent: 'claude' });
  /* The host would mint an identical-looking id of its own, so only the call the worker actually made
     distinguishes "the worker named it" from "the host filled the gap". */
  const asked = [];
  const terminal = host.sessions.terminal.bind(host.sessions);
  host.sessions.terminal = async options => { asked.push(options); return terminal(options); };
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  const feed = await feedSocket(worker, (await status(worker, root.id, alice)).feed);
  t.after(() => feed.close());

  const spawned = await ok(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F1', agent: 'claude', model: 'claude-opus-5' }, alice);
  assert.equal(asked.length, 1, 'one pane, one call');
  assert.match(asked[0].conversation ?? '', UUID, 'the worker names the conversation on the host call');
  assert.ok(asked[0].args?.length, 'alongside the arguments that make this a spawn rather than a bare pane');
  assert.equal(spawned.conversation, asked[0].conversation, 'the answer carries the id the worker named');
  assert.notEqual(spawned.conversation, earlier, 'never one somebody else was already having');
  const state = await ok(worker, 'state');
  assert.equal(state.conversations[root.id].find(entry => entry.id === asked[0].conversation)?.task, 'F1',
    'the pane record is that same conversation, wearing its task');
  const frame = await until(() => feed.frames.find(item => item.type === 'agent.spawned'), 'agent.spawned reaches the feed');
  assert.equal(frame.conversation, asked[0].conversation, 'and so is the frame');

  assert.equal(existsSync(path.join(stateDir, 'integrations', `${spawned.session.id}.conversations.tsv`)), false,
    'the host writes this pane no listing, so there is nothing for a stray keystroke to answer');
  const argv = await until(() => claude.read().catch(() => null), 'the fake claude recorded its argv', 600);
  assert.equal(argv[argv.indexOf('--session-id') + 1], spawned.conversation, 'the CLI starts on that conversation');
  assert.equal(argv.includes('--resume'), false, 'a spawn starts a conversation; it never resumes one');
  assert.ok(argv.at(-1).includes('F1'), 'with the task prompt still its last argument');
});

test('a spawn starts the chosen CLI with its own model flag and the rendered prompt, records the task, and lands on the feed', { timeout: 90000 }, async t => {
  const { stateDir, host, root, worker } = await workspace(t);
  const claude = await fakeCli(stateDir, 'claude');
  const codex = await fakeCli(stateDir, 'codex');
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  const feed = await feedSocket(worker, (await status(worker, root.id, alice)).feed);
  t.after(() => feed.close());

  const spawned = await ok(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F1', agent: 'claude', model: 'claude-opus-5', brief: 'task' }, alice);
  assert.ok(spawned.conversation, 'a CLI rEngine can name a conversation for is given one');
  const argv = await until(() => claude.read().catch(() => null), 'the fake claude recorded the argv it was started with', 600);
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5', 'the model rides on claude’s own flag');
  assert.equal(argv[argv.indexOf('--session-id') + 1], spawned.conversation, 'on the conversation the workspace named');
  assert.ok(argv.at(-1).includes('F1'), 'and the prompt is the CLI’s positional initial argument');
  assert.ok(argv.at(-1).includes('The write runs the project’s own command'), 'carrying the task’s acceptance criteria');

  const state = await ok(worker, 'state');
  assert.equal(state.conversations[root.id].find(entry => entry.id === spawned.conversation).task, 'F1',
    'the conversation records the task it was spawned on');
  const frame = await until(() => feed.frames.find(item => item.type === 'agent.spawned'), 'agent.spawned reaches the feed');
  assert.equal(frame.taskKey, 'F1'); assert.equal(frame.agent, 'claude'); assert.equal(frame.model, 'claude-opus-5');
  assert.equal(frame.conversation, spawned.conversation); assert.equal(frame.sessionId, spawned.session.id);
  assert.equal(frame.by.agentId, alice.agentId);

  const menu = await ok(worker, `agents-menu?${new URLSearchParams({ rootId: root.id })}`);
  const live = menu.live.find(entry => entry.sessionId === spawned.session.id);
  assert.ok(live, 'the pane is listed live'); assert.equal(live.task, 'F1', 'wearing its task');

  /* codex names its own conversations, so nothing claims one for it; the brief still reaches it. */
  const decomposer = await ok(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F1', agent: 'codex', model: 'gpt-5-codex', brief: 'decompose' }, alice);
  assert.equal(decomposer.conversation, null);
  const codexArgv = await until(() => codex.read().catch(() => null), 'the fake codex recorded its argv', 600);
  assert.equal(codexArgv[codexArgv.indexOf('-m') + 1], 'gpt-5-codex', 'codex takes its model with -m');
  assert.ok(codexArgv.at(-1).includes('Decompose F1'), 'and the decomposition brief rather than the task brief');

  const before = host.sessions.items.size;
  const unknownFlag = await api(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F1', agent: 'gemini', model: 'gemini-3' }, alice);
  assert.equal(unknownFlag.status, 409, unknownFlag.body.error);
  assert.match(unknownFlag.body.error, /does not know how gemini is told which model/);
  assert.match(unknownFlag.body.error, /Nothing was started/);
  const unknownTask = await api(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F999', agent: 'claude' }, alice);
  assert.equal(unknownTask.status, 404);
  assert.match(unknownTask.body.error, /No task "F999"/);
  const bob = identity('kimi');
  const notHolder = await api(worker, 'agent-spawn', { rootId: root.id, taskKey: 'F1', agent: 'claude' }, bob);
  assert.equal(notHolder.status, 409);
  assert.match(notHolder.body.error, /held by claude/);
  assert.equal(host.sessions.items.size, before, 'none of the three refusals started a pane');
});

test('the desktop assigns the token to a chosen agent, settling an open contest without charging it', { timeout: 40000 }, async t => {
  const { host, root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  await hold(worker, root.id, alice);
  const pending = await ok(worker, 'token-action', { rootId: root.id, action: 'contest', reason: 'mine now' }, bob);
  assert.equal(pending.state, 'pending');
  const desktop = await fakeDesktop(worker, [root.id]);
  t.after(() => desktop.close());

  const carol = randomUUID();
  await host.store.recordConversation(root.id, { conversation: carol, agent: 'gemini' });
  desktop.send({ type: 'token-action', rootId: root.id, action: 'assign', agentId: carol });
  const pushed = await until(() => desktop.messages.find(message => message.type === 'token' && message.holder?.agentId === carol),
    'the desktop’s assign moves the token at once');
  assert.equal(pushed.holder.label, `gemini ${carol.slice(0, 8)}`, 'wearing the label the conversations registry knows it by');
  assert.equal(pushed.contest, null, 'and the open contest is settled rather than left running against a holder it cannot reach');

  const after = await status(worker, root.id, bob);
  assert.equal(after.holder.agentId, carol);
  assert.equal(after.cooldown[bob.agentId], undefined, 'the contester is charged no cooldown: the desktop moved the token, it did not refuse');
  const claim = after.history.filter(entry => entry.type === 'token.claimed').at(-1);
  assert.equal(claim.by.kind, 'desktop'); assert.ok(claim.by.desktopId);

  desktop.send({ type: 'token-action', rootId: root.id, action: 'assign', agentId: randomUUID() });
  const error = await until(() => desktop.messages.find(message => message.type === 'error'), 'an id nobody knows is refused by name');
  assert.match(error.error, /is known on this root/);
  assert.equal((await status(worker, root.id, bob)).holder.agentId, carol, 'and the holder is unchanged');

  /* An identity the ledger has met on the wire needs no conversation record. */
  desktop.send({ type: 'token-action', rootId: root.id, action: 'assign', agentId: alice.agentId });
  await until(() => desktop.messages.find(message => message.type === 'token' && message.holder?.agentId === alice.agentId), 'assign to a seen identity');
});

test('the agent menu is the declaration’s when it has one and rEngine’s known lists otherwise', async () => {
  const root = { id: 'r', path: '/nowhere' };
  const list = async () => 'codex\t/usr/bin/codex\nclaude\tnot installed\ngemini\tnot installed\nopencode\tnot installed\nkimi\tnot installed\n';
  const help = async () => '  -m, --model <MODEL>\n          Model the agent should use [possible values: gpt-5, gpt-5-codex]\n';
  const known = await agentsMenu(root, { declared: true, contract: 5 }, { list, help });
  assert.equal(known.declared, false);
  assert.deepEqual(known.agents.map(entry => entry.cli), ['claude', 'codex', 'gemini', 'opencode', 'kimi']);
  const claude = known.agents.find(entry => entry.cli === 'claude');
  assert.equal(claude.default, 'claude-opus-5');
  assert.deepEqual(claude.models, ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  assert.equal(claude.installed, false, 'installed comes from the launcher’s own listing');
  const codex = known.agents.find(entry => entry.cli === 'codex');
  assert.equal(codex.installed, true);
  assert.deepEqual(codex.models, ['gpt-5', 'gpt-5-codex'], 'codex’s list is whatever its own --help names');
  assert.deepEqual(known.agents.find(entry => entry.cli === 'gemini').models, [], 'and a CLI rEngine knows no list for offers none');
  assert.deepEqual(known.agents.find(entry => entry.cli === 'kimi').models, [], 'kimi’s aliases are the person’s own configuration, so rEngine offers none');

  const declared = await agentsMenu(root, { declared: true, contract: 6, agents: [{ cli: 'claude', models: ['claude-opus-5'], default: 'claude-opus-5' }] },
    { list, help: async () => { throw new Error('a declared menu asks no CLI anything'); } });
  assert.equal(declared.declared, true);
  assert.deepEqual(declared.agents, [{ cli: 'claude', installed: false, models: ['claude-opus-5'], default: 'claude-opus-5' }]);

  assert.deepEqual(codexModels('nothing here mentions a model'), []);
  assert.deepEqual(codexModels('  --profile <P>  [possible values: a, b]\n'), [], 'a possible-values list belonging to another flag is not a model list');
  assert.deepEqual(modelArgs('claude', 'claude-opus-5'), ['--model', 'claude-opus-5']);
  assert.deepEqual(modelArgs('codex', 'gpt-5'), ['-m', 'gpt-5']);
  assert.deepEqual(modelArgs('kimi', 'kimi-code/kimi-for-coding'), ['-m', 'kimi-code/kimi-for-coding'], 'kimi spells its model flag -m');
  assert.deepEqual(modelArgs('gemini', undefined), [], 'a spawn with no model needs no flag from anybody');
  assert.throws(() => modelArgs('opencode', 'anything'), /does not know how opencode is told which model/);

  /* The workspace's own two fields win over a row that carries them, so a row cannot rename the call. */
  assert.deepEqual(writeDocument({ action: 'add', row: { key: 'F1', action: 'update', parent: 'F9' }, parent: 'F2' }).document,
    { key: 'F1', parent: 'F2', action: 'add' });
});

test('a worker that owns no ledger serves neither task writes nor spawns, and the tools refuse by name', { timeout: 60000 }, async t => {
  const { directory, host, root, worker } = await workspace(t);
  const blocked = path.join(directory, 'not-a-directory');
  await writeFile(blocked, 'this is a file');
  const older = await startWorker({ url: host.url, token: host.token, instance: host.instance }, { directory: blocked });
  t.after(() => older.close());
  const stale = (await ok(older, 'state')).capabilities, current = (await ok(worker, 'state')).capabilities;
  assert.equal(stale.taskWrites, undefined, 'the capability is absent, not merely unused');
  assert.equal(stale.agentSpawn, undefined);
  assert.equal(current.taskWrites, 1); assert.equal(current.agentSpawn, 1);
  assert.equal(current.agentsMenu, 1, 'while the read that needs no ledger is served by both');
  assert.equal(stale.agentsMenu, 1);

  const client = async (who, target) => {
    const context = { url: target.url, token: target.token, instance: host.instance, rootId: root.id, runtimeDirectory: path.join(directory, 'none') };
    const plan = await agentLaunch({ agent: who, executable: who, context, directory, env: {} });
    const connection = new Client({ name: 'rengine-task-test', version: '1.0.0' });
    await connection.connect(new StdioClientTransport({ command: process.execPath, args: [toolWorkerMain, '--context', plan.contextFile], stderr: 'pipe' }));
    t.after(() => connection.close());
    return { connection, identity: plan.identity,
      call: async (name, args = {}) => { const result = await connection.callTool({ name, arguments: args }); return { error: result.isError === true, text: result.content?.[0]?.text ?? '', value: result.structuredContent }; } };
  };
  const alice = await client('claude', worker);
  const listed = await alice.connection.listTools();
  for (const name of ['task_add', 'task_update', 'task_decompose', 'spawn_agent', 'list_agents_menu']) {
    assert.ok(listed.tools.some(tool => tool.name === name), `${name} is offered`);
  }
  for (const name of ['task_add', 'task_update', 'task_decompose', 'spawn_agent']) {
    assert.match(listed.tools.find(tool => tool.name === name).description, /project token/, `${name} says it is gated`);
  }
  await alice.call('token_contest', { reason: 'about to write' });
  const written = await alice.call('task_add', { row: { id: 30, key: 'F30', description: 'through the tool' } });
  assert.equal(written.error, false, written.text);
  assert.equal(written.value.result.wrote, 30);

  const bob = await client('codex', worker);
  for (const [name, args] of [['task_add', { row: { id: 31, key: 'F31' } }], ['task_update', { row: { id: 30, passes: true } }],
    ['task_decompose', { row: { id: 32, key: 'F32' }, parent: 'F30' }], ['spawn_agent', { taskKey: 'F1', agent: 'claude' }]]) {
    const refused = await bob.call(name, args);
    assert.equal(refused.error, true, `${name} is refused`);
    assert.match(refused.text, /held by claude/, `${name} names the holder`);
    assert.match(refused.text, /token_contest/, `${name} points at token_contest`);
  }
  assert.deepEqual((await features(path.join(directory, 'project'))).map(feature => feature.id), [1, 2, 30], 'and none of them wrote anything');

  const against = await client('claude', older);
  for (const [name, args] of [['task_add', { row: { id: 33 } }], ['spawn_agent', { taskKey: 'F1', agent: 'claude' }]]) {
    const refused = await against.call(name, args);
    assert.equal(refused.error, true, `${name} against a ledgerless worker is refused`);
    assert.match(refused.text, /update_workspace with layers \["workspace"\]/, `${name} names the layer to update`);
  }
});
