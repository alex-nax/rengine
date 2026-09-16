/* F173 (F149c, spec 129): the launch plan the Rust side composes IS the one config.mjs composed.
 *
 * Judged against the answers config.mjs gave, recorded by agents-fixtures.mjs while that module
 * still existed — the device F172 used for the hook reporter, and for the same reason: a
 * replacement cannot be compared against a module that has been deleted, and regenerating the
 * record afterwards would be judging the replacement against itself.
 *
 * Owner decision, 2026-09-13: the decisions are Rust's and the environment-dependent inputs stay
 * with the caller, so the client hands the service the root context, the session list and the IDE
 * probe's answer, and the service decides everything else — which overlay, which hook layer, which
 * conversation, and the per-launch files that say so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentLaunch, hookTrustHash, closeAgents } from './agents-client.mjs';
import { LAUNCHES, recordLaunch, scrub } from './agents-fixtures.mjs';
/* Spec 146's half lives in this file rather than its own, and deliberately: node --test runs FILES
   concurrently, this suite already sits at that limit — `launcher.test.mjs` says so in its own
   timeout comment — and one more file tipped six unrelated specs past their budgets. The two halves
   belong together anyway: this is the launch, judged against what the JavaScript answered. */
import { CASES, ROOT as CHECKOUT, recordLaunch as recordPaneLaunch } from './pane-launch-corpus.mjs';
import { mkdtemp as makeTemp, writeFile as write, chmod as mode } from 'node:fs/promises';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = JSON.parse(await readFile(new URL('./agents-fixtures.json', import.meta.url), 'utf8'));

test('the Rust launch plan is the plan config.mjs composed, for every CLI', { timeout: 120000 }, async t => {
  await built('-p', 'red-agents');
  t.after(() => closeAgents());
  for (const kase of LAUNCHES) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-launch-parity-'));
    try {
      const actual = await recordLaunch(agentLaunch, kase, directory);
      const expected = FIXTURES.launches[kase.name];
      assert.deepEqual(actual.args, expected.args, `${kase.name}: the args the CLI is launched with`);
      assert.deepEqual(actual.consumes, expected.consumes, `${kase.name}: what the launch consumed`);
      assert.deepEqual(actual.identity, expected.identity, `${kase.name}: the identity that names the conversation`);
      assert.equal(actual.name, expected.name, `${kase.name}: the MCP server name is the root's`);
      assert.deepEqual(actual.conversation, expected.conversation, `${kase.name}: what the host is told this pane holds`);
      assert.equal(actual.custom, expected.custom, `${kase.name}: whether the CLI consumes the plan as it stands`);
      /* The files, by content AND by mode: a plan that names a file nobody wrote is not a plan, and
         one that writes a token readable by anyone is worse than none. */
      assert.deepEqual(Object.keys(actual.files).sort(), Object.keys(expected.files).sort(), `${kase.name}: the files written`);
      for (const [key, recorded] of Object.entries(expected.files)) {
        assert.deepEqual(actual.files[key].body, recorded.body, `${kase.name}: ${key}'s contents`);
        assert.equal(actual.files[key].mode, recorded.mode, `${kase.name}: ${key} is as private as it was`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

/* Codex trusts a hook only when its exact definition hashes to what the layer claims, and the
   command names this launch's own context file — so the hash cannot be compared to a recorded one.
   What must hold is that it is the right function of the command this launch actually wrote. */
test('the codex hook layer carries the trust hash codex will compute for it', { timeout: 60000 }, async t => {
  t.after(() => closeAgents());
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-launch-trust-'));
  try {
    const plan = await recordLaunch(agentLaunch, LAUNCHES.find(kase => kase.name === 'codex'), directory);
    const layer = plan.args.find(arg => typeof arg === 'string' && arg.startsWith('hooks.state='));
    assert.ok(layer, 'the codex launch carries a hooks.state layer');
    assert.match(layer, /trusted_hash="<hash>"/, 'and the recorded shape is a hash, scrubbed for comparison');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the trust hash is computed, not copied: a different command hashes differently', async t => {
  t.after(() => closeAgents());
  const one = await hookTrustHash("'/opt/red-agents' report-session --context '/tmp/a.json'");
  const other = await hookTrustHash("'/opt/red-agents' report-session --context '/tmp/b.json'");
  assert.notEqual(one, other, 'two commands codex would trust separately hash separately');
  assert.match(one, /^sha256:[0-9a-f]{64}$/);
});


/* ---- the ACTING half: spec 146 ------------------------------------------------------------- */

const RECORD = JSON.parse(await readFile(new URL('./pane-launch-corpus.json', import.meta.url), 'utf8'));
const BINARY = () => process.env.RENGINE_RED_AGENT_LAUNCH || path.join(CHECKOUT, 'red/target/debug/red-agent-launch');

/* The ONE declared divergence from the record (spec 146): the pane's MCP server was
   `node agents/mcp.mjs` and is `red-mcp --facade`. It is normalised on BOTH sides rather than
   regenerated — launch.mjs is gone, so a regenerated record would be judging the replacement
   against itself — and what proves the new value is right is the assertion below it, not this.
   Only codex is affected: every other CLI is handed a --mcp-config PATH, and the path did not move. */
const server = record => JSON.parse(JSON.stringify(record)
  .replace(/mcp_servers\.[a-z0-9_]+\.command=\\"[^\\]*\\"/g, 'mcp_servers.<name>.command=<server>')
  .replace(/mcp_servers\.[a-z0-9_]+\.args=\[[^\]]*\]/g, 'mcp_servers.<name>.args=<server-args>'));

test('the Rust pane launcher hands a CLI what launch.mjs handed it, for every CLI', { timeout: 180000 }, async t => {
  await built('-p', 'red-supervisor');
  const directory = await makeTemp(path.join(tmpdir(), 'rengine-pane-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const launcher = { command: BINARY(), args: [] };
  for (const kase of CASES) {
    const expected = RECORD.cases.find(item => item.name === kase.name);
    assert.ok(expected, `${kase.name} is in the record`);
    const actual = await recordPaneLaunch(launcher, kase, directory);
    /* The whole case at once: a per-field comparison reports the first difference and hides the
       rest, and what matters when this fails is everything that moved. */
    assert.deepEqual(server(actual), server(expected), `${kase.name}: the pane launch differs from what launch.mjs did`);
  }

  /* What the normalisation above hides, asserted directly: the server a pane is given is the Rust
     facade, started as a COMMAND rather than as an argument to an interpreter. Composing it the old
     way would write `node /path/to/red-mcp` — a server that cannot start, in a file a person reads. */
  const codex = await recordPaneLaunch(launcher, { name: 'codex-server', agent: 'codex' }, directory);
  const declared = codex.received.argv.find(argument => argument.includes('mcp_servers.') && argument.includes('.command='));
  assert.match(declared, /red-mcp/, `the pane's MCP server is the Rust binary: ${declared}`);
  assert.doesNotMatch(declared, /node/, `and is not handed to an interpreter: ${declared}`);
  const args = codex.received.argv.find(argument => argument.includes('mcp_servers.') && argument.includes('.args='));
  assert.match(args, /--facade/, `started in facade mode, which is what survives a worker swap: ${args}`);
});

/* "Prints and continues" is the behaviour a green run cannot tell from "never happened", so the
   best-effort paths get a case each. Each of these WOULD be a refusal if the rule were dropped. */
test('a pane is not refused because something optional did not answer', { timeout: 120000 }, async t => {
  await built('-p', 'red-supervisor');
  const directory = await makeTemp(path.join(tmpdir(), 'rengine-pane-optional-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  /* The host at 127.0.0.1:1 answers nothing, so the session list and the conversation report both
     fail. The record's `claude-reporting` case carries the sentence; this asserts the CONSEQUENCE:
     the CLI still ran, and the exit code is the CLI's. */
  const reported = await recordPaneLaunch({ command: BINARY(), args: [] },
    { name: 'optional', agent: 'claude', session: '00000000-0000-0000-0000-0000000000a1' }, directory);
  assert.equal(reported.code, 0, reported.stderr.join('\n'));
  assert.ok(reported.received, 'the CLI ran even though the workspace never answered');
  assert.match(reported.stderr.join('\n'), /was not told which conversation/);
});

/* The exit code is the CLI's, and a launcher that swallowed it would make every failed agent look
   like a clean exit to whatever is watching the pane. */
test('the exit code that comes out is the CLI\'s own', { timeout: 120000 }, async t => {
  await built('-p', 'red-supervisor');
  const directory = await makeTemp(path.join(tmpdir(), 'rengine-pane-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { url: 'http://127.0.0.1:1', token: 'a'.repeat(64), instance: '12345678-1234-1234-1234-123456789abc', rootId: '12345678-1234-1234-1234-123456789abc' };
  const contextFile = path.join(directory, 'root-context.json');
  await write(contextFile, JSON.stringify(context));
  const cli = path.join(directory, 'exits-17');
  await write(cli, '#!/bin/bash\nexit 17\n');
  await mode(cli, 0o755);
  const run = promisify(execFile);
  const env = { PATH: process.env.PATH, HOME: directory, RENGINE_IDE_DIRECTORY: path.join(directory, 'locks') };
  const failed = await run(BINARY(), ['claude', cli, contextFile], { cwd: directory, env }).then(
    () => ({ code: 0 }), error => ({ code: error.code }));
  assert.equal(failed.code, 17, 'the CLI exited 17 and the launcher carried it out');
});
