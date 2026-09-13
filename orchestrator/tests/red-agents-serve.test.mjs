/* F173 (F149c, spec 129, KI-093): the red-agents stdio service — the channel the JS consumers
 * read recipes through once registry.mjs is gone, in the shape red-store-serve established.
 *
 * The service is the only thing that parses the registry document from here on, so what this
 * asserts is that its answers ARE the JS module's: the same names, the same projected recipe, and
 * the same codex hook numbers. Parity against registry.mjs is checked while that module still
 * exists — after the swap there would be nothing left to compare against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentNames, resolvedRecipes } from '../agents/registry.mjs';
import { codexHookKey, codexHookTrustHash } from '../agents/config.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-agents-serve');

/* One service, spoken to the way the client will speak to it. */
async function serve(t) {
  await run('cargo', ['build', '-p', 'red-agents'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(BIN), `red-agents-serve was built at ${BIN}`);
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0, onStarted;
  const started = new Promise(resolve => { onStarted = resolve; });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.started !== undefined) { onStarted(message); return; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method, args = []) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
  return { started: await started, call };
}

test('the service answers what registry.mjs answers, and says so before the first read', async t => {
  const { started, call } = await serve(t);
  assert.equal(started.started, true, 'the first line is the startup outcome, so a registry that will not parse fails open()');
  assert.equal(started.recipes, agentNames().length);

  assert.deepEqual(await call('agentNames'), agentNames(), 'the same CLIs, in the document’s order');
  assert.deepEqual(await call('resolvedRecipes'), resolvedRecipes(), 'the whole projection, atom for atom');
  /* The DATA, which is what the service carries. `recipe()` hands consumers a cooked object with a
     compiled RegExp and bound parser functions on it; those are assembled from this projection by
     whoever needs them, and are not something a process boundary can pass. */
  const projection = resolvedRecipes();
  for (const cli of agentNames()) {
    assert.deepEqual(await call('recipe', [cli]), projection[cli], `${cli}: the recipe the consumers' cooked view is built from`);
  }
  assert.equal(await call('recipe', ['nothing-by-that-name']), null, 'an unknown CLI is null, as the module returns undefined for one');
});

test('the service carries the codex hook numbers the launcher composes with', async t => {
  const { call } = await serve(t);
  assert.equal(await call('codexHookKey', [0, 0]), codexHookKey(0, 0));
  assert.equal(await call('codexHookKey', [2, 1]), codexHookKey(2, 1));
  const command = "'/opt/red-agents' report-session --provider codex --context '/tmp/c.json'";
  assert.equal(await call('codexHookTrustHash', [command]), codexHookTrustHash(command),
    'the trust hash codex looks this launch’s hook up by');
  assert.equal(await call('codexHookTrustHash', [command, 'startup']), codexHookTrustHash(command, 'startup'));
});

test('a malformed request is answered, never fatal: the service outlives a bad line', async t => {
  const { call } = await serve(t);
  await assert.rejects(call('no-such-method'), /Unknown agents method/);
  assert.deepEqual(await call('agentNames'), agentNames(), 'and the next request is answered as if nothing happened');
});
