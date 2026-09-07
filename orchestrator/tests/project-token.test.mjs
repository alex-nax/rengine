import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { agentLaunch } from '../agents/config.mjs';
import { tokenProject, identity, api, ok, until, fakeDesktop, feedSocket } from './token-fixtures.mjs';

const WINDOW = 700;
const toolWorkerMain = fileURLToPath(new URL('../agents/mcp-worker.mjs', import.meta.url));

async function workspace(t, { directory: given, window = WINDOW } = {}) {
  const directory = given ?? await mkdtemp(path.join(tmpdir(), 'rengine-token-'));
  const project = await tokenProject(directory);
  const host = await startServer({ stateDir: path.join(directory, 'state') });
  const root = await host.store.addRoot(project);
  const runtime = path.join(directory, 'runtime');
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance }, { directory: runtime });
  t.after(async () => { await worker.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  if (window) await ok(worker, 'preferences', { tokenWindowMs: window });
  return { directory, project, host, root, runtime, worker };
}
const status = (worker, rootId, who) => ok(worker, `token?${new URLSearchParams({ rootId })}`, undefined, who);
const contest = (worker, rootId, who, reason = '') => api(worker, 'token-action', { rootId, action: 'contest', reason }, who);
const captures = async project => { try { return await readdir(path.join(project, '.cache/captures')); } catch { return []; } };

test('the extended routes refuse an agent that does not hold the token, and never refuse the desktop', { timeout: 40000 }, async t => {
  const { project, host, root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  const claimed = await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  assert.equal(claimed.state, 'claimed', 'a free token is claimed at once rather than opening a window');

  const idle = await api(worker, 'dashboard-run', { rootId: root.id, actionId: 'here' });
  assert.equal(idle.status, 200, `the desktop sends no identity header and is never gated: ${idle.body.error}`);
  const sessionsBefore = host.sessions.items.size;
  const refusals = {
    game: await api(worker, 'game', { rootId: root.id, gameId: 'fixture-game' }, bob),
    'script-open': await api(worker, 'script-open', { rootId: root.id, path: 'tools/deploy.sh', desktopId: 'nobody' }, bob),
    'dashboard-run': await api(worker, 'dashboard-run', { rootId: root.id, actionId: 'here' }, bob),
    'dashboard-capture': await api(worker, 'dashboard-capture', { rootId: root.id, actionId: 'shot' }, bob),
    'desktop-action': await api(worker, 'desktop-action', { rootId: root.id, desktopId: 'nobody', action: 'reload' }, bob),
    'update-workspace': await api(worker, 'update-workspace', { rootId: root.id, layers: ['workspace'] }, bob),
    stop: await api(worker, 'stop', { id: idle.body.id }, bob),
  };
  for (const [route, result] of Object.entries(refusals)) {
    assert.equal(result.status, 409, `${route} is refused with 409, not ${result.status}`);
    assert.match(result.body.error, /held by claude/, `${route} names the holder's label`);
    assert.match(result.body.error, new RegExp(claimed.holder.since.slice(0, 16)), `${route} names since when`);
    assert.match(result.body.error, /token_contest/, `${route} points at token_contest`);
  }
  assert.equal(host.sessions.items.size, sessionsBefore, 'nothing was launched, run or stopped while refusing');
  assert.equal(host.sessions.snapshot(idle.body.id).state, 'running', 'the session the refused stop named is still running');
  assert.deepEqual(await captures(project), [], 'the refused capture wrote no PNG');

  /* Decision 6: the person at the desktop is never gated, whoever holds the token. */
  const shot = await ok(worker, 'dashboard-capture', { rootId: root.id, actionId: 'shot' });
  assert.ok(shot.file.endsWith('.png'));
  const game = await ok(worker, 'game', { rootId: root.id, gameId: 'fixture-game' });
  assert.equal(host.sessions.snapshot(game.id).state, 'running', 'the desktop launched the game the agent could not');
  await ok(worker, 'stop', { id: game.id });
  const desktopUpdate = await api(worker, 'update-workspace', { rootId: root.id, layers: ['workspace'] });
  assert.doesNotMatch(desktopUpdate.body.error ?? '', /held by/, 'the desktop is answered by the route, never by the gate');

  const held = await status(worker, root.id, alice);
  assert.equal(held.holdsToken, true, 'the holder is told it holds it');
  assert.deepEqual(held.identities.map(entry => entry.label).sort(), ['claude', 'codex'],
    'every identity the header carried is remembered as a candidate, refused or not');
});

test('a contest opens a window, a rejection costs a cooldown, and silence transfers at the deadline', { timeout: 40000 }, async t => {
  const { root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  const feed = await feedSocket(worker, (await status(worker, root.id, alice)).feed);
  t.after(() => feed.close());

  const opened = await ok(worker, 'token-action', { rootId: root.id, action: 'contest', reason: 'about to deploy' }, bob);
  assert.equal(opened.state, 'pending');
  const window = Date.parse(opened.deadline) - Date.now();
  assert.ok(window > WINDOW / 2 && window <= WINDOW + 250, `the window is the configured length, not ${window}ms`);
  const second = await contest(worker, root.id, identity('gemini'));
  assert.equal(second.status, 409); assert.match(second.body.error, /codex .*already has a contest open/);

  const rejected = await ok(worker, 'token-action', { rootId: root.id, action: 'reject', reason: 'a build is running' }, alice);
  assert.equal(rejected.holder.agentId, alice.agentId, 'rejecting keeps the token where it was');
  const blocked = await contest(worker, root.id, bob);
  assert.equal(blocked.status, 409, 'a rejected contester cannot contest again until its cooldown ends');
  assert.match(blocked.body.error, new RegExp(rejected.cooldownUntil.slice(0, 16)), 'the cooldown refusal names when it ends');
  const seenByBob = await status(worker, root.id, bob);
  assert.equal(seenByBob.history.some(entry => entry.type === 'token.rejected'), true, 'the contester can read that it was rejected');
  assert.match(JSON.stringify(feed.frames), /a build is running/, 'and the reason is on the feed');

  await until(async () => (await contest(worker, root.id, bob)).status === 200, 'the cooldown expires');
  const transferred = await until(async () => {
    const value = await status(worker, root.id, bob);
    return value.holder?.agentId === bob.agentId && value;
  }, 'the token transfers at the deadline');
  assert.equal(transferred.contest, null, 'and the contest is closed');
  const claim = feed.frames.filter(frame => frame.type === 'token.claimed').at(-1);
  assert.equal(claim.by.kind, 'deadline', 'the transfer is attributed to the deadline, not to either agent');
  assert.equal(claim.holder.agentId, bob.agentId);
  const kinds = feed.frames.map(frame => frame.type);
  assert.deepEqual(kinds.filter(kind => kind.startsWith('token.')),
    ['token.claimed', 'token.contested', 'token.rejected', 'token.contested', 'token.claimed'],
    'every transition is one frame, in order, and a monitor opened later is replayed all of them');
});

test('a contest against a holder whose process is gone resolves at once', { timeout: 20000 }, async t => {
  const { root, worker } = await workspace(t);
  const dead = spawn(process.execPath, ['-e', '']);
  await once(dead, 'exit');
  const ghost = identity('claude', dead.pid);
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, ghost);
  const before = Date.now();
  const taken = await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, identity('codex'));
  assert.equal(taken.state, 'claimed', 'no window is opened against a holder that is gone');
  assert.ok(Date.now() - before < WINDOW, 'and nothing waited for one');
  assert.equal(taken.by, 'holder-gone');
  const frames = (await ok(worker, `feed?${new URLSearchParams({ rootId: root.id })}`)).frames;
  assert.equal(frames.at(-1).by.kind, 'holder-gone');
});

test('the desktop can reject, grant, revoke and free, and its recording frames reach the feed', { timeout: 30000 }, async t => {
  const { root, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  const desktop = await fakeDesktop(worker, [root.id]);
  t.after(() => desktop.close());
  /* Asserted before anything has happened on this root: a push that only arrives with the first
     transition would leave a freshly opened window with an empty segment. */
  const registered = await until(() => desktop.messages.find(message => message.type === 'token'),
    'the desktop is pushed the ledger the moment it registers, with nothing yet to report');
  assert.equal(registered.holder, null);
  assert.deepEqual(Object.keys(registered).sort(), ['contest', 'holder', 'rootId', 'sequence', 'type', 'windowMs'],
    'and the frame is the pinned flat shape, not the agent-facing status object');
  const feed = await feedSocket(worker, (await status(worker, root.id)).feed);
  t.after(() => feed.close());

  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  const pending = await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, bob);
  const pushed = () => desktop.messages.filter(message => message.type === 'token').at(-1);
  await until(() => pushed().contest?.id === pending.contestId, 'the contest is pushed without polling');
  assert.equal(pushed().windowMs, WINDOW, 'the push carries the configured window');

  const named = desktop.messages.length;
  desktop.send({ type: 'token-action', rootId: root.id, action: 'reject' });
  await until(() => desktop.messages.slice(named).find(message => message.type === 'error'), 'reject without a contest id is refused');
  assert.match(desktop.messages.at(-1).error, /Name the contest to reject/);

  desktop.send({ type: 'token-action', rootId: root.id, action: 'reject', contestId: pending.contestId, reason: 'not now' });
  await until(() => pushed().contest === null, 'the reject is answered by the next token frame');
  assert.equal((await status(worker, root.id)).holder.agentId, alice.agentId);

  await until(async () => (await contest(worker, root.id, bob)).status === 200, 'bob contests again after the cooldown');
  const open = (await status(worker, root.id)).contest;
  desktop.send({ type: 'token-action', rootId: root.id, action: 'grant', contestId: open.id });
  await until(() => pushed().holder?.agentId === bob.agentId, 'granting hands the token over without waiting out the window');
  desktop.send({ type: 'token-action', rootId: root.id, action: 'revoke' });
  await until(() => pushed().holder === null, 'revoke frees it');
  assert.equal((await status(worker, root.id)).holder, null);
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  desktop.send({ type: 'token-action', rootId: root.id, action: 'free' });
  await until(() => pushed().holder === null, 'and so does free');
  assert.equal(pushed().sequence, (await status(worker, root.id)).tokenSequence,
    'the pushed sequence is the last token frame, so a desktop can tell a stale push from a new one');

  /* The recorder is the desktop's (spec 081); stage 3 sends these two frames on this socket. */
  const at = new Date().toISOString();
  desktop.send({ type: 'recording', rootId: root.id, sessionId: 'session-1', gameId: 'fixture-game', event: 'started', recordingId: 'rec-1', kind: 'explicit', at });
  desktop.send({ type: 'recording', rootId: root.id, sessionId: 'session-1', gameId: 'fixture-game', event: 'committed', recordingId: 'rec-1', kind: 'explicit', at });
  await until(() => feed.frames.some(frame => frame.type === 'capture.committed'), 'the commit reaches the feed');

  const desktopFrames = feed.frames.filter(frame => frame.by.kind === 'desktop');
  assert.deepEqual(desktopFrames.map(frame => frame.type),
    ['token.rejected', 'token.claimed', 'token.revoked', 'token.released', 'capture.started', 'capture.committed'],
    'each desktop act is one frame attributed to the desktop');
  for (const frame of desktopFrames) assert.equal(frame.by.desktopId, desktop.id, 'and names which desktop');
  const capture = feed.frames.find(frame => frame.type === 'capture.started');
  assert.deepEqual([capture.recordingId, capture.gameId, capture.kind, capture.sessionId], ['rec-1', 'fixture-game', 'explicit', 'session-1']);
});

test('the feed carries lifecycle only, resumes from a cursor, and never carries a byte a process printed', { timeout: 60000 }, async t => {
  const { project, host, root, worker } = await workspace(t);
  const alice = identity('claude');
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  const opened = await status(worker, root.id, alice);
  const feed = await feedSocket(worker, opened.feed);
  t.after(() => feed.close());
  /* The desktop's stream is open at the same time, so "no output on the feed" is measured against a
     socket that IS carrying that output rather than against a quiet machine. */
  const events = new WebSocket(`${worker.url.replace('http', 'ws')}/events?token=${worker.token}`);
  const eventFrames = []; events.on('message', bytes => eventFrames.push(JSON.parse(bytes)));
  await once(events, 'open'); t.after(() => events.terminate());

  const chatty = await ok(worker, 'terminal', { rootId: root.id, command: '/bin/bash', args: [path.join(project, 'tools/chatty.sh')] });
  const game = await ok(worker, 'game', { rootId: root.id, gameId: 'fixture-game' }, alice);
  const deployed = await ok(worker, 'dashboard-run', { rootId: root.id, actionId: 'deploy' }, alice);
  await until(() => feed.frames.some(frame => frame.type === 'game.started'), 'game.started');
  await until(() => feed.frames.some(frame => frame.type === 'device-action.ended'), 'device-action.ended');
  await ok(worker, 'stop', { id: game.id }, alice);
  await until(() => feed.frames.some(frame => frame.type === 'game.ended'), 'game.ended');
  await until(() => host.sessions.snapshot(chatty.id, true).output.includes('CHATTY_LINE_20'), 'the chatty session printed');

  const started = feed.frames.find(frame => frame.type === 'game.started');
  assert.equal(started.sessionId, game.id); assert.equal(started.gameId, 'fixture-game');
  assert.deepEqual(started.by, { kind: 'agent', agentId: alice.agentId, label: 'claude' }, 'the launch is attributed to the agent that asked');
  assert.equal(feed.frames.find(frame => frame.type === 'game.ended').exitCode !== undefined, true);
  const device = feed.frames.filter(frame => frame.type.startsWith('device-action.'));
  assert.deepEqual(device.map(frame => frame.type), ['device-action.started', 'device-action.ended']);
  assert.deepEqual([device[0].sessionId, device[0].actionId, device[0].deviceId, device[0].kind], [deployed.id, 'deploy', 'answering-box', 'ssh']);
  assert.equal(feed.frames.some(frame => frame.type === 'workspace.updated'), true, 'the worker serving this root announced its generation');

  /* The negative, three ways: no frame type that is not lifecycle, no output frame, and none of the
     text the chatty session produced — while the desktop's own socket carries all of it. */
  assert.equal(eventFrames.some(frame => frame.type === 'output' && frame.data.includes('CHATTY_LINE')), true,
    'the control: the desktop socket did carry that output');
  assert.equal(feed.frames.some(frame => frame.type === 'output'), false, 'no output frame reached the feed');
  assert.doesNotMatch(JSON.stringify(feed.frames), /CHATTY_LINE|FIXTURE_GAME_STARTED|DEPLOY_STARTED/, 'and no line either process printed');
  assert.deepEqual([...new Set(feed.frames.map(frame => frame.type))].filter(type => !/^(token|game|device-action|capture|workspace)\./.test(type)), []);

  const sequences = feed.frames.map(frame => frame.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'sequences are monotonic');
  assert.equal(new Set(sequences).size, sequences.length, 'and never repeat');
  const cursor = sequences[Math.floor(sequences.length / 2)];
  const resumed = await feedSocket(worker, `${opened.feed}&after=${cursor}`);
  t.after(() => resumed.close());
  await until(() => resumed.frames.length >= sequences.filter(value => value > cursor).length, 'the replay arrives');
  assert.deepEqual(resumed.frames.map(frame => frame.sequence), sequences.filter(value => value > cursor),
    'a monitor opened with after=N receives every retained frame after N and no earlier one');
  const read = await ok(worker, `feed?${new URLSearchParams({ rootId: root.id, after: String(cursor) })}`, undefined, alice);
  assert.deepEqual(read.frames.map(frame => frame.sequence), resumed.frames.map(frame => frame.sequence), 'and the polling read agrees with the socket');
});

test('replacing the workspace worker keeps the holder, the deadline and the cursor', { timeout: 40000 }, async t => {
  const { directory, host, root, runtime, worker } = await workspace(t);
  const alice = identity('claude'), bob = identity('codex');
  await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, alice);
  await ok(worker, 'preferences', { tokenWindowMs: 2500 });
  const pending = await ok(worker, 'token-action', { rootId: root.id, action: 'contest' }, bob);
  const before = await status(worker, root.id, alice);
  await worker.close();

  const replacement = await startWorker({ url: host.url, token: host.token, instance: host.instance }, { directory: runtime });
  t.after(() => replacement.close());
  assert.notEqual(replacement.pid === undefined, true);
  const after = await status(replacement, root.id, alice);
  assert.equal(after.holder.agentId, alice.agentId, 'the holder survives the worker that recorded it');
  assert.equal(after.contest.id, pending.contestId, 'and so does the open contest');
  assert.equal(after.contest.deadline, pending.deadline, 'with the same absolute deadline, not a restarted countdown');
  assert.ok(after.feedCursor >= before.feedCursor, 'the feed cursor continues rather than rewinding');

  const transferred = await until(async () => {
    const value = await status(replacement, root.id, bob);
    return value.holder?.agentId === bob.agentId && value;
  }, 'the contest resolves at its original time under the replacement', 600);
  assert.ok(Date.now() >= Date.parse(pending.deadline), 'and not before it');
  const frames = (await ok(replacement, `feed?${new URLSearchParams({ rootId: root.id })}`)).frames;
  const claim = frames.filter(frame => frame.type === 'token.claimed').at(-1);
  assert.equal(claim.by.kind, 'deadline');
  assert.ok(claim.sequence > before.feedCursor, 'the frame the replacement wrote continues the same sequence');
  assert.equal(transferred.contest, null);
  const persisted = JSON.parse(await readFile(path.join(runtime, 'tokens', root.id, 'token.json'), 'utf8'));
  assert.equal(persisted.holder.agentId, bob.agentId, 'and the ledger on disk is the one a third worker would read');
});

test('the tools carry the token, and against a worker without the ledger they refuse naming the layer', { timeout: 40000 }, async t => {
  const { directory, host, root, worker } = await workspace(t);
  const empty = path.join(directory, 'no-runtime'); await mkdir(empty, { recursive: true });
  const client = async (who, target = worker) => {
    const context = { url: target.url, token: target.token, instance: host.instance, rootId: root.id, runtimeDirectory: empty };
    const plan = await agentLaunch({ agent: who, executable: who, context, directory, env: {} });
    const connection = new Client({ name: 'rengine-token-test', version: '1.0.0' });
    await connection.connect(new StdioClientTransport({ command: process.execPath, args: [toolWorkerMain, '--context', plan.contextFile], stderr: 'pipe' }));
    t.after(() => connection.close());
    return { connection, identity: plan.identity,
      call: async (name, args = {}) => { const result = await connection.callTool({ name, arguments: args }); return { error: result.isError === true, text: result.content?.[0]?.text ?? '', value: result.structuredContent }; } };
  };
  const alice = await client('claude'), bob = await client('codex');
  const listed = await alice.connection.listTools();
  for (const name of ['token_status', 'token_contest', 'token_reject', 'token_release', 'feed_url', 'feed_read']) {
    assert.ok(listed.tools.some(tool => tool.name === name), `${name} is offered`);
  }
  for (const name of ['launch_game', 'stop_session', 'open_script', 'dashboard_capture', 'reload_desktop', 'update_workspace']) {
    assert.match(listed.tools.find(tool => tool.name === name).description, /project token/, `${name} says it is gated`);
  }

  const free = await alice.call('token_status');
  assert.equal(free.error, false, free.text);
  assert.equal(free.value.holder, null);
  const claimed = await alice.call('token_contest', { reason: 'about to launch' });
  assert.equal(claimed.value.state, 'claimed');
  const launched = await alice.call('launch_game', { gameId: 'fixture-game' });
  assert.equal(launched.error, false, `the holder launches: ${launched.text}`);

  /* stop_session names the session alice started: a bogus id would be refused by the ownership
     check before the gate, which would prove nothing about the gate. */
  for (const [name, args] of [['launch_game', { gameId: 'fixture-game' }], ['stop_session', { id: launched.value.id }],
    ['open_script', { path: 'tools/deploy.sh', desktopId: 'nobody' }], ['dashboard_capture', { actionId: 'shot' }],
    ['update_workspace', { layers: ['workspace'] }]]) {
    const refused = await bob.call(name, args);
    assert.equal(refused.error, true, `${name} is refused`);
    assert.match(refused.text, /held by claude/, `${name} names the holder`);
    assert.match(refused.text, /token_contest/, `${name} points at token_contest`);
  }
  const seen = await bob.call('token_status');
  assert.deepEqual(seen.value.identities.map(entry => entry.label).sort(), ['claude', 'codex'],
    'an agent appears in token_status once it has called anything');

  const url = await alice.call('feed_url');
  assert.match(url.value.url, /^ws:\/\/127\.0\.0\.1:\d+\/feed\?/);
  const watched = await feedSocket(worker, url.value.url);
  t.after(() => watched.close());
  await alice.call('token_release');
  await until(() => watched.frames.some(frame => frame.type === 'token.released'), 'the monitor sees the release');
  const read = await bob.call('feed_read', { after: 0 });
  assert.equal(read.error, false, read.text);
  assert.ok(read.value.frames.some(frame => frame.type === 'token.claimed'), 'a non-holder may read the feed');
  assert.equal(read.value.socket, undefined, 'feed_read hands back frames, not a socket to open');

  /* An older workspace layer: one that cannot own a runtime directory serves everything else and
     advertises no agentToken, so the tools refuse by name rather than calling a worker with no gate. */
  const blocked = path.join(directory, 'not-a-directory');
  await writeFile(blocked, 'this is a file');
  const older = await startWorker({ url: host.url, token: host.token, instance: host.instance }, { directory: blocked });
  t.after(() => older.close());
  assert.equal((await ok(older, 'state')).capabilities.agentToken, undefined, 'the capability is absent, not merely unused');
  assert.equal((await ok(worker, 'state')).capabilities.agentToken, 1, 'while the worker that serves the ledger advertises it');
  const stale = await client('claude', older);
  for (const [name, args] of [['launch_game', { gameId: 'fixture-game' }], ['update_workspace', { layers: ['workspace'] }], ['token_status', {}]]) {
    const refused = await stale.call(name, args);
    assert.equal(refused.error, true, `${name} against an older worker is refused`);
    assert.match(refused.text, /update_workspace with layers \["workspace"\]|predates the ledger/, `${name} names the layer to update`);
  }
  await delay(10);
});
