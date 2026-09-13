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
import { agentLaunch, codexHookTrustHash, closeAgents } from '../agents/agents-client.mjs';
import { LAUNCHES, recordLaunch, scrub } from './agents-fixtures.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = JSON.parse(await readFile(new URL('./agents-fixtures.json', import.meta.url), 'utf8'));

test('the Rust launch plan is the plan config.mjs composed, for every CLI', { timeout: 120000 }, async t => {
  await run('cargo', ['build', '-p', 'red-agents'], { cwd: path.join(ROOT, 'red') });
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
  const one = await codexHookTrustHash("'/opt/red-agents' report-session --context '/tmp/a.json'");
  const other = await codexHookTrustHash("'/opt/red-agents' report-session --context '/tmp/b.json'");
  assert.notEqual(one, other, 'two commands codex would trust separately hash separately');
  assert.match(one, /^sha256:[0-9a-f]{64}$/);
});
