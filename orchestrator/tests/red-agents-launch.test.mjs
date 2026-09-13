/* F173 (F149c, spec 129): the launch plan the Rust side composes IS the one config.mjs composed.
 *
 * Owner decision, 2026-09-13: the decisions move to Rust while the environment-dependent inputs —
 * the root context, the workspace's session list, the IDE probe's answer — stay with the caller.
 * So this feeds both sides the same inputs and compares the plans: the args a CLI is launched with,
 * the env it inherits, the per-launch files and their contents, and the identity that names the
 * conversation. Compared while config.mjs still exists; after the swap there is nothing to compare.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { agentLaunch, codexHookTrustHash } from '../agents/config.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-agents-serve');
const MCP_MAIN = path.join(ROOT, 'orchestrator/agents/mcp.mjs');
const RED_AGENTS = path.join(ROOT, 'red/target/debug/red-agents');
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';
const MINT = 'aaaaaaaa-1111-4111-8111-111111111111';
const STAMP = '2026-09-13T00:00:00.000Z';

async function serve(t, env = {}) {
  await run('cargo', ['build', '-p', 'red-agents'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(BIN));
  const child = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0, onStarted;
  const started = new Promise(resolve => { onStarted = resolve; });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.started !== undefined) return onStarted(message);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await started;
  return (method, args = []) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
  });
}

/* Both sides get the same inputs and the same minted id and clock, so what is left to differ is
   the decisions. The JS side's identity is passed in for the same reason. */
async function bothPlans(t, { agent, executable, args = [], conversation = null, resume = false, env = {}, ide = null }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-launch-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = { url: 'http://127.0.0.1:1', token: 'a'.repeat(64), instance: ROOT_ID, rootId: ROOT_ID };
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify(context));

  const jsDirectory = path.join(directory, 'js');
  const rustDirectory = path.join(directory, 'rust');
  await Promise.all([jsDirectory, rustDirectory].map(d => writeFile(path.join(directory, '.keep'), '').then(() => rm(d, { recursive: true, force: true }))));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(jsDirectory, { recursive: true }); await mkdir(rustDirectory, { recursive: true });

  const js = await agentLaunch({ agent, executable, args, contextFile, context, directory: jsDirectory, conversation, resume,
    env, cwd: null, ide: async () => ide ?? { flags: [], env: {}, reason: 'none' } });
  const call = await serve(t, { RED_AGENTS_MINT_SEQUENCE: `${MINT},${MINT}`, RED_AGENTS_NOW_SEQUENCE: STAMP });
  const rust = await call('agentLaunch', [{ agent, executable, args, contextFile, context, directory: rustDirectory,
    conversation, resume, env, platform: process.platform, nodeExecutable: process.execPath, mcpMain: MCP_MAIN,
    redAgents: RED_AGENTS, pid: js.identity.pid, ide }]);
  return { js, rust, jsDirectory, rustDirectory };
}

/* The per-launch directory carries a minted uuid in its name, and the identity carries a minted id
   and a clock; neither is a decision, so they are normalised before the plans are compared. */
const scrub = (value, directory) => JSON.parse(JSON.stringify(value)
  .replaceAll(directory, '<home>')
  .replace(/rengine_[0-9a-f]{12}-[0-9a-f-]{36}/g, 'rengine_<root>-<mint>')
  .replace(/"startedAt":"[^"]*"/g, '"startedAt":"<stamp>"')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
  /* The label carries the first eight characters of that same minted id, which survives the line
     above because it is only part of a uuid. */
  .replace(/"label":"([a-z0-9-]+) [0-9a-f]{8}"/g, '"label":"$1 <short>"')
  /* The trust hash is over the command, and the command names this launch's own context file —
     so the two sides hash different strings by construction. The hash is checked directly below
     instead: each side's must be the right function of the command it actually composed. */
  .replace(/sha256:[0-9a-f]{64}/g, '<hash>'));

for (const [name, launch] of [
  ['claude, whose overlay is a flag and whose hook is a settings file', { agent: 'claude', executable: '/installed/claude' }],
  ['codex, whose overlay and hook both ride the -c layer', { agent: 'codex', executable: '/installed/codex' }],
  ['kimi, whose MCP config is a project file', { agent: 'kimi', executable: '/installed/kimi' }],
  ['gemini, whose overlay is a defaults file', { agent: 'gemini', executable: '/installed/gemini' }],
  ['opencode, whose overlay is an inline environment variable', { agent: 'opencode', executable: '/installed/opencode' }],
]) {
  test(`the Rust plan is the JS plan for ${name}`, async t => {
    const { js, rust, jsDirectory, rustDirectory } = await bothPlans(t, launch);
    assert.deepEqual(scrub(rust.args, rustDirectory), scrub(js.args, jsDirectory), 'the args the CLI is launched with');
    assert.deepEqual(scrub(rust.consumes, rustDirectory), scrub(js.consumes, jsDirectory), 'what the launch consumed');
    assert.deepEqual(scrub(rust.identity, rustDirectory), scrub(js.identity, jsDirectory), 'the identity that names the conversation');
    assert.equal(rust.name, js.name, 'the MCP server name is the root’s');
    assert.deepEqual(scrub(rust.conversation ?? null, rustDirectory), scrub(js.conversation ?? null, jsDirectory));
    /* Codex trusts a hook only when its exact definition hashes to what the layer claims, so the
       hash has to be the right function of the command this launch composed — not merely equal to
       the other side's, which hashes its own paths. */
    const hookLayer = rust.args.find(arg => typeof arg === 'string' && arg.startsWith('hooks.state='));
    if (hookLayer) {
      const command = JSON.parse(rust.args.find(arg => arg.startsWith('hooks.SessionStart=')).match(/command=("(?:[^"\\]|\\.)*")/)[1]);
      assert.match(hookLayer, new RegExp(`trusted_hash="${codexHookTrustHash(command)}"`),
        'the trust hash is the one codex will compute for the command this launch wrote');
    }

    /* The files, by content: a plan that names a file nobody wrote is not a plan. */
    for (const key of ['generic', 'contextFile', 'settings']) {
      if (!js[key]) { assert.ok(!rust[key], `${key} is absent on both sides`); continue; }
      assert.ok(rust[key], `${key} is written on both sides`);
      assert.deepEqual(scrub(JSON.parse(await readFile(rust[key], 'utf8')), rustDirectory),
                       scrub(JSON.parse(await readFile(js[key], 'utf8')), jsDirectory), `${key}'s contents`);
      assert.equal((await stat(rust[key])).mode & 0o777, 0o600, `${key} is private`);
    }
  });
}
