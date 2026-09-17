/* F222, spec 148: saying one line to a pane that is already running.
 *
 * The workspace could already type into a pane it had just spawned (F221). What it could not do was
 * say anything to one that was already there, so a person did it by hand with two curl calls and an
 * eye on the pane. This spec drives the replacement end to end — a real host, a real worker, a real
 * PTY service and a fake TUI that takes a bracketed paste and echoes it the way the measured one
 * does — and it is mostly about the refusals, because a relay that cannot be refused is a keystroke
 * injector with a nicer name.
 *
 * The one thing it never does is touch a live pane. Every pane here is this spec's own.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './red-host-fixture.mjs';
import { startWorker } from './red-worker-fixture.mjs';
import { api, feedSocket, identity, ok, until } from './token-fixtures.mjs';
import { fakePasteCli, taskDeclaration, taskProject } from './task-fixtures.mjs';
import { built } from './cargo.mjs';

/* This spec drives compiled binaries, so it builds them first: run alone — or used to check that a
   regression fails for its own reason — it would otherwise judge whatever is on disk, and a
   sabotage that is never compiled always passes (KI-120). */
before(() => built('--bins'));

const run = promisify(execFile);
const LAUNCH = process.env.RENGINE_RED_LAUNCH
  || fileURLToPath(new URL('../red/target/debug/red-launch', import.meta.url));

async function workspace(t, { echoes = true } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-message-')));
  const project = await taskProject(directory, 'project', taskDeclaration());
  const stateDir = path.join(directory, 'state');
  const host = await startServer({ stateDir });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance },
    { directory: path.join(directory, 'runtime') });
  const cli = await fakePasteCli(stateDir, 'kimi', { echoes });
  t.after(async () => { await worker.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  await ok(worker, 'preferences', { tokenWindowMs: 700 });
  return { directory, stateDir, host, root, worker, cli };
}

/** A pane running the fake CLI, started the way a spawn starts one but carrying no brief. */
async function pane(host, root, agent = 'kimi') {
  const started = await host.sessions.terminal({ rootId: root.id, type: 'agent', agent, action: 'launch', args: ['-m', 'k3'] });
  return started.id;
}

const hold = (worker, rootId, who) => ok(worker, 'token-action', { rootId, action: 'contest' }, who);
const grant = (stateDir, id, messages = 3, minutes = 30) =>
  run(LAUNCH, ['message-grant', '--state', stateDir, '--session', id, '--messages', String(messages), '--minutes', String(minutes)]);
const grants = async stateDir =>
  JSON.parse((await run(LAUNCH, ['message-grant', '--state', stateDir, '--list'])).stdout).grants;
const record = (host, id) => host.sessions.list().find(session => session.id === id);
/* The pane has to have fallen quiet before anything may be said to it — the composer a relay types
   into is a settled one, and the refusal for an unsettled one is its own test below. */
const settled = () => new Promise(resolve => setTimeout(resolve, 1200));

/* The whole handshake, in the order it happens: the pane is quiet, the line goes in carrying a token
   nobody can guess, the pane echoes it, and only then is Enter pressed. Plus the two things the
   hand-rolled version had none of — an audit frame and a bound that is spent. */
test('one line reaches a running pane, is submitted only on its own echo, and is on the feed', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker, cli } = await workspace(t);
  const id = await pane(host, root);
  await until(async () => (await cli.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  const status = await ok(worker, `token?${new URLSearchParams({ rootId: root.id })}`, undefined, alice);
  const feed = await feedSocket(worker, status.feed);
  t.after(() => feed.close());
  await grant(stateDir, id, 3, 30);
  await settled();

  const said = await ok(worker, 'session-message', { id, text: 'Re-read the notes, then continue.' }, alice);
  assert.equal(said.delivered, true, said.reason ?? '');
  assert.match(said.typed, /^Re-read the notes, then continue\. \[[0-9a-z]{8}\]$/,
    `the line carries its own confirm token: ${said.typed}`);
  assert.equal(said.confirm.length, 8);
  assert.ok(said.typed.includes(said.confirm), 'and the token is IN the line, so the pane shows the marker too');

  const typed = await cli.read();
  assert.deepEqual(typed.pastes, [said.typed], 'one paste, exactly what the caller asked for plus the token');
  assert.equal(typed.submits, 1, 'one Enter, earned by the echo');
  await until(() => record(host, id)?.message === 'delivered', 'and the pane record says it arrived', 2400);

  const grant_ = said.grant;
  assert.equal(grant_.remaining, 2, 'the owner grant is spent down by one');
  assert.equal((await grants(stateDir))[0].remaining, 2, 'on disk as well as in the answer');

  const frame = await until(() => feed.frames.find(entry => entry.type === 'session.message'),
    'one frame per delivery reaches the feed');
  assert.equal(frame.sessionId, id);
  assert.equal(frame.delivered, true);
  assert.equal(frame.characters, 'Re-read the notes, then continue.'.length);
  assert.equal(frame.by.agentId, alice.agentId, 'and it says who did it');
  assert.ok(!JSON.stringify(frame).includes('Re-read'), 'the feed carries the fact and never the words');
});

/* The hazard the whole handshake exists for, and the shape of KI-068's second half: a surface that
   takes a paste and never echoes it. Nothing is submitted, ever — and the bound is still spent,
   because the line went into somebody's composer whether it was answered or not. */
test('a line the pane never echoes is left unsubmitted, and still costs one of the grant', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker, cli } = await workspace(t, { echoes: false });
  const id = await pane(host, root);
  await until(async () => (await cli.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  await grant(stateDir, id, 2, 30);
  await settled();

  const said = await ok(worker, 'session-message', { id, text: 'a line into a surface that says nothing' }, alice);
  assert.equal(said.delivered, false);
  assert.match(said.reason, /not submitted and no Enter was sent/);
  const typed = await cli.read();
  assert.equal(typed.pastes.length, 1, 'one attempt, never a second copy in the composer');
  assert.equal(typed.submits, 0, 'and no Enter at all');
  assert.equal(record(host, id)?.message, 'undelivered', 'the record does not let it read like one that arrived');
  assert.equal(said.grant.remaining, 1, 'spent for the attempt, not for the outcome');
});

/* The permission that is deliberately not the token. Holding the token is necessary and is not
   enough: it transfers to a contester on silence, so an agent can hold it without anyone acting. */
test('the project token does not arm a relay, and a grant for another pane does not either', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker, cli } = await workspace(t);
  const id = await pane(host, root);
  await until(async () => (await cli.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);

  const unarmed = await api(worker, 'session-message', { id, text: 'nothing should reach this pane' }, alice);
  assert.equal(unarmed.status, 409, unarmed.body.error);
  assert.match(unarmed.body.error, /No owner grant covers this pane/);
  assert.match(unarmed.body.error, /transfers to a contester on silence/, 'and says why the token is not enough');
  assert.match(unarmed.body.error, /Nothing was typed\.$/);

  await grant(stateDir, 'some-other-pane', 5, 30);
  const wrongPane = await api(worker, 'session-message', { id, text: 'nor should this' }, alice);
  assert.equal(wrongPane.status, 409);
  assert.match(wrongPane.body.error, /No owner grant covers this pane/, 'a grant names ONE pane');

  await grant(stateDir, id, 1, 30);
  const bob = identity('kimi');
  const notHolder = await api(worker, 'session-message', { id, text: 'nor this' }, bob);
  assert.equal(notHolder.status, 409);
  assert.match(notHolder.body.error, /held by claude/, 'the token still gates it');

  assert.deepEqual((await cli.read()).pastes, [], 'not one of the three refusals typed anything');
  assert.equal((await grants(stateDir)).find(row => row.sessionId === id).remaining, 1, 'and none of them spent the grant');
});

/* Blast radius. A control byte is refused rather than stripped, which is what keeps this tool from
   ever being able to press Enter, interrupt a turn or answer a dialog. */
test('a message is one printable line, and anything else is refused rather than cleaned', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker, cli } = await workspace(t);
  const id = await pane(host, root);
  await until(async () => (await cli.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  await grant(stateDir, id, 5, 30);
  await settled();

  for (const [text, says] of [['two\nlines', /a newline/], ['submit\r', /a carriage return/],
                              ['interrupt', /U\+0003/], ['x'.repeat(401), /at most 400 characters/],
                              ['', /is one line of text/]]) {
    const refused = await api(worker, 'session-message', { id, text }, alice);
    assert.equal(refused.status, 400, refused.body.error);
    assert.match(refused.body.error, says);
    assert.match(refused.body.error, /Nothing was typed\.$/);
  }
  assert.deepEqual((await cli.read()).pastes, [], 'nothing was typed');
  assert.equal((await grants(stateDir))[0].remaining, 5, 'and nothing was spent');
});

/* The capability rule, from the side that matters: a CLI nobody measured is refused BY NAME rather
   than typed into hopefully. Two of the declared CLIs take a brief on their command line and say
   nothing whatever about their composers, which is why this is a second key and not `prompt.kind`. */
test('a pane whose CLI has not declared how it takes a message is refused by name', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker } = await workspace(t);
  /* A CLI whose overlay rides on the ENVIRONMENT rather than on a flag, so the fake one sees an
     argv it understands; and one that has declared no message capability, which is the point. */
  const other = await fakePasteCli(stateDir, 'opencode');
  const id = await pane(host, root, 'opencode');
  await until(async () => (await other.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  await grant(stateDir, id, 5, 30);
  await settled();

  const refused = await api(worker, 'session-message', { id, text: 'this CLI has declared nothing' }, alice);
  assert.equal(refused.status, 409, refused.body.error);
  assert.match(refused.body.error, /does not know how opencode takes a message/);
  assert.match(refused.body.error, /Nothing was typed\.$/);
  assert.deepEqual((await other.read()).pastes, [], 'and nothing was');
  assert.equal((await grants(stateDir))[0].remaining, 5, 'the grant is intact: the refusal came first');
});

/* The two quiet rules. A pane mid-turn is not a composer, and a pane somebody has just typed into
   is somebody's — a relay appends to whatever is already in there. */
test('a pane that is talking and a pane somebody is using are both refused', { timeout: 180000 }, async t => {
  const { stateDir, host, root, worker, cli } = await workspace(t);
  const id = await pane(host, root);
  await until(async () => (await cli.read().catch(() => null))?.argv, 'the fake CLI came up', 600);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  await grant(stateDir, id, 5, 30);
  await settled();

  /* A person's keystroke, through the route a person's keystroke takes. It never echoes here — the
     fixture only answers pastes — so what this proves is the INPUT rule rather than the settle one. */
  await host.sessions.input(id, 'a half-written line');
  const busy = await api(worker, 'session-message', { id, text: 'not into that' }, alice);
  assert.equal(busy.status, 409, busy.body.error);
  assert.match(busy.body.error, /typed into moments ago|is talking/);
  assert.deepEqual((await cli.read()).pastes, [], 'nothing was typed');
  assert.equal((await grants(stateDir)).find(row => row.sessionId === id).remaining, 5,
    'and a refusal that typed nothing costs the owner nothing: the grant is checked before the line goes in and spent after');
});

/* The grant is the owner's gesture: bounded on both axes, replaceable, revocable, and expiring on
   its own clock whether anybody comes back to it or not. */
test('a grant names one pane, needs both bounds, and can be taken back', { timeout: 60000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-grant-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = ['--state', directory];

  await assert.rejects(() => run(LAUNCH, ['message-grant', ...state, '--session', 'p', '--messages', '3']),
    error => /--minutes is required/.test(error.stderr), 'a grant with no deadline is not a grant');
  await assert.rejects(() => run(LAUNCH, ['message-grant', ...state, '--session', 'p', '--minutes', '30']),
    error => /--messages is required/.test(error.stderr), 'nor is one with no count');
  await assert.rejects(() => run(LAUNCH, ['message-grant', ...state, '--session', 'p', '--messages', '999', '--minutes', '30']),
    error => /between 1 and 50 messages/.test(error.stderr));
  assert.deepEqual(await grants(directory), [], 'and none of the three wrote anything');

  await grant(directory, 'p', 4, 30);
  await grant(directory, 'p', 2, 30);
  assert.deepEqual((await grants(directory)).map(row => [row.sessionId, row.remaining]), [['p', 2]],
    'a second grant for one pane replaces the first rather than adding to it');

  const revoked = JSON.parse((await run(LAUNCH, ['message-grant', ...state, '--session', 'p', '--revoke'])).stdout);
  assert.equal(revoked.revoked, true);
  assert.deepEqual(await grants(directory), []);

  /* And the action's own half of it: the confirm has no non-interactive bypass, there is no --yes,
     and a run nobody could answer is a FAILURE rather than a quiet "not granted" — a caller must
     not be able to read "nobody was asked" as either answer. */
  const ACTION = fileURLToPath(new URL('../actions/posix/grant-session-message.sh', import.meta.url));
  await assert.rejects(
    () => run(ACTION, ['--state', directory, '--session', 'p', '--messages', '2', '--minutes', '10'], { stdio: 'pipe' }),
    error => error.code === 2 && /needs a person to answer/.test(error.stderr),
    'a confirm nobody can answer is refused, not bypassed');
  assert.deepEqual(await grants(directory), [], 'and it wrote nothing');
  const help = await run(ACTION, ['--help']);
  assert.ok(!/--yes/.test(help.stdout), 'there is no flag that answers the prompt for a person');
});

/* The scope, through the connection an agent actually holds: `session_message` is a tool with a
   schema, it refuses a pane on another project by name, and it is gated like the tools that start
   and stop things. */
test('the tool is offered, scoped to this project, and named in the token refusal', { timeout: 180000 }, async t => {
  const { worker, root } = await workspace(t);
  const alice = identity('claude');
  await hold(worker, root.id, alice);
  const status = await ok(worker, `token?${new URLSearchParams({ rootId: root.id, tool: 'session_message' })}`, undefined, alice);
  assert.equal(status.refusal, null, 'the holder is not refused');
  const bob = identity('kimi');
  const refused = await ok(worker, `token?${new URLSearchParams({ rootId: root.id, tool: 'session_message' })}`, undefined, bob);
  assert.match(refused.refusal, /session_message/, 'and a non-holder is refused naming the tool');
  assert.match(refused.refusal, /token_contest/);

  const foreign = await api(worker, 'session-message', { id: 'a-pane-in-another-project', text: 'nope' }, alice);
  assert.equal(foreign.status, 404, foreign.body.error);
  assert.match(foreign.body.error, /Unknown session\./);
});
