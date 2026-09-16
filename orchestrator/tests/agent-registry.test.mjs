import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/* F113 (docs/specs/114-dev-suite-roadmap.md, charter D46): one declared agent recipe registry is
   the single source for an agent's package, install/update mode, model flag, conversation flags and
   id shapes, MCP overlay kind, hooks overlay kind and IDE connect. config.mjs, tasks.mjs,
   ide-connect.mjs and agent.sh read it rather than carrying their own tables, so adding an agent is
   a data edit — proven here by registering one as data and watching every consumer follow. */
import { agentNames, recipe, resolvedRecipes, MCP_OVERLAYS, HOOK_OVERLAYS, processIdentity, installPaths } from './agents-client.mjs';
import { agentLaunch, agentConversation, hookTrustHash } from './agents-client.mjs';
import { knownAgents, modelArgs } from './tasks.mjs';
import { ideConnectFlag } from './ide-connect.mjs';
import { ideDirectory } from './ide.mjs';
import { built } from './cargo.mjs';

const script = path.resolve('scripts/agent.sh');
const FIVE = ['claude', 'codex', 'gemini', 'opencode', 'kimi'];
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';

/* F171: agent.sh's registry reads dispatch to the red-agents binary, so this file's end-to-end
   runs need it built — on a fresh checkout nothing else in the suite has built it yet. */
test('the red-agents binary agent.sh dispatches to is present', async () => {
  await built('-p', 'red-agents');
  assert.ok(existsSync(path.resolve('red/target/debug/red-agents')), 'red-agents is built');
});

async function contextDir(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'f'.repeat(64), instance: '87654321-4321-4321-4321-cba987654321', rootId: ROOT_ID }));
  return { directory, contextFile };
}

test('every shipped recipe is complete, valid, and named once', () => {
  assert.deepEqual(agentNames(), FIVE, 'the registry names the five CLIs, in the order the menus show them');
  for (const cli of agentNames()) {
    const entry = recipe(cli);
    assert.ok(entry, `${cli} has a recipe`);
    assert.match(entry.package, /^[@a-z0-9][@a-z0-9./-]*$/i, `${cli} names an npm package`);
    assert.ok(entry.update.kind === 'self' || entry.update.kind === 'reinstall', `${cli} update mode`);
    if (entry.update.kind === 'self') assert.ok(entry.update.command.length > 0, `${cli} names its update subcommand`);
    assert.ok(MCP_OVERLAYS.includes(entry.mcp.kind), `${cli} MCP overlay is one rEngine implements`);
    assert.ok(HOOK_OVERLAYS.includes(entry.hooks?.kind ?? null), `${cli} hooks overlay is one rEngine implements, or null`);
    if (entry.model) assert.deepEqual(entry.model('x').length, 2, `${cli} model flag takes the model`);
    if (!entry.conversation) continue;
    const talk = entry.conversation;
    assert.ok(talk.ids instanceof RegExp, `${cli} names its id shape`);
    /* Parsing a CLI's own resume spellings is a DECISION, and F173 moved the decisions to Rust: the
       recipe declares which parser answers for this CLI and the service runs it. What the cooked
       view carries is the declaration, not a function. */
    assert.equal(typeof resolvedRecipes()[cli].conversation.parser, 'string', `${cli} declares which parser reads its resume spellings`);
    const id = cli === 'kimi' ? 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6' : '3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
    assert.ok(talk.ids.test(id), `${cli}'s id shape accepts the id it resumes by`);
    assert.ok(Array.isArray(talk.resume(id)), `${cli} resume args`);
    assert.ok(talk.resumeLine(id).includes(id), `${cli} resume line names the id`);
    assert.equal(typeof talk.short(id), 'string', `${cli} short form`);
    assert.equal(typeof talk.provider, 'string');
  }
});

test('every consumer reads the one table', async t => {
  const { contextFile } = await contextDir(t);
  /* config.mjs: conversation capabilities are the recipes' — claude starts and resumes, codex and
     kimi resume without a start (neither CLI has a start-with-id spelling), gemini/opencode name
     their own and are recorded with nothing. */
  assert.equal(typeof agentConversation('claude').start, 'function');
  assert.equal(agentConversation('codex').start, null, 'codex resumes but is never minted one, like kimi');
  assert.deepEqual(agentConversation('codex').resume('3f85774e-05bb-4791-bb9f-1c90dc37d0e6'), ['resume', '3f85774e-05bb-4791-bb9f-1c90dc37d0e6']);
  assert.equal(agentConversation('kimi').start, null);
  assert.equal(agentConversation('gemini'), null);
  assert.equal(agentConversation('opencode'), null);

  /* tasks.mjs: the menu and the model flags are derived. */
  assert.deepEqual(knownAgents().map(entry => entry.cli), FIVE);
  assert.deepEqual(modelArgs('claude', 'claude-opus-5'), ['--model', 'claude-opus-5']);
  assert.deepEqual(modelArgs('codex', 'gpt-5'), ['-m', 'gpt-5']);
  assert.deepEqual(modelArgs('kimi', 'kimi-code/kimi-for-coding'), ['-m', 'kimi-code/kimi-for-coding']);
  assert.throws(() => modelArgs('gemini', 'anything'), /does not know how gemini is told which model/);

  /* ide-connect.mjs: only claude is told to connect. */
  assert.deepEqual(ideConnectFlag('claude'), ['--ide']);
  assert.equal(ideConnectFlag('codex'), null);
  assert.equal(ideConnectFlag('kimi'), null);

  /* agent.sh: the launcher’s own listing is the registry's list. */
  const bin = path.join(await mkdtemp(path.join(tmpdir(), 'rengine-registry-bin-')), 'bin');
  await mkdir(bin);
  t.after(() => rm(path.dirname(bin), { recursive: true, force: true }));
  const listed = spawnSync('bash', [script, '--project', tmpdir(), '--action', 'list'],
    { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RENGINE_AGENT_HOME: path.join(tmpdir(), 'managed-registry'), RENGINE_NODE: process.execPath }, encoding: 'utf8', timeout: 15000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').map(line => line.split('\t')[0]), FIVE);
});

/* The killer test (criterion 2): a recipe added as DATA — an extra registry file, no source file
   edited — makes the agent selectable, installable, launchable with its MCP overlay, and offered
   for a task spawn. F148a moved the extra file from JSON to the same TOML document shape the
   shipped registry now is (KI-092); the end-to-end proof is unchanged. */
test('a recipe added as data becomes an agent end to end, with no file edited', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-registry-extra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extra = path.join(directory, 'extra-recipes.toml');
  await writeFile(extra, `[recipes.testcli]
package = "@test/testcli"

[recipes.testcli.update]
kind = "self"
command = "upgrade"

[recipes.testcli.model]
flag = "--model"

[recipes.testcli.models]
kind = "none"

[recipes.testcli.mcp]
kind = "flag"
flag = "--servers"
`);
  const env = { ...process.env, RENGINE_AGENT_REGISTRY_EXTRA: extra };
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });

  /* selectable: the registry itself takes the data (recipes are read through the environment at
     call time, so the data needs no process restart and no file edit) */
  assert.ok(agentNames().includes('testcli'), 'the registry itself takes the data');
  assert.equal(recipe('testcli').package, '@test/testcli');
  assert.ok(knownAgents().some(entry => entry.cli === 'testcli'), 'the menu offers it');

  /* launchable with its MCP overlay: kind 'flag' is the generic configuration channel, and the
     recipe spells the flag. `--servers` is nobody's real flag, which is the point — shared code
     used to impose claude's `--mcp-config` on every CLI declaring this kind (F214, spec 141). */
  const contextFile = path.join(directory, 'context.json');
  await writeFile(contextFile, JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'f'.repeat(64), instance: '87654321-4321-4321-4321-cba987654321', rootId: ROOT_ID }));
  const plan = await agentLaunch({ agent: 'testcli', executable: '/installed/testcli', contextFile, env: {} });
  assert.deepEqual(plan.args, ['--servers', plan.generic], 'the overlay the recipe names is the wiring it gets, spelled the way the recipe spells it');
  assert.equal(plan.env.RENGINE_MCP_CONFIG, plan.generic);
  assert.equal(plan.conversation, undefined, 'no conversation capability, so nothing is recorded or invented');

  /* offered for a task spawn: its model flag is known */
  assert.deepEqual(modelArgs('testcli', 'some-model'), ['--model', 'some-model']);

  /* installable and listed: agent.sh asks the registry for the recipe */
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$@" > "$RENGINE_AGENT_HOME/npm-args"\nwhile [ "$1" != --prefix ]; do shift; done\nshift\nmkdir -p "$1/node_modules/.bin"\nprintf "#!/bin/bash\\nprintf managed-testcli\\n" > "$1/node_modules/.bin/testcli"\nchmod +x "$1/node_modules/.bin/testcli"\n', { mode: 0o755 });
  const run = args => spawnSync('bash', [script, '--project', tmpdir(), ...args],
    { env: { ...env, PATH: `${bin}:/usr/bin:/bin`, RENGINE_AGENT_HOME: path.join(directory, 'managed'), RENGINE_NODE: process.execPath }, encoding: 'utf8', timeout: 15000 });
  const installed = run(['--agent', 'testcli', '--action', 'install', '--version', '1.0.0']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(await readFile(path.join(directory, 'managed/npm-args'), 'utf8'), /@test\/testcli@1\.0\.0/);
  assert.match(run(['--action', 'list']).stdout, /^testcli\t.+managed/m, 'and the launcher’s listing discovers it');

  /* and its update goes through the subcommand the recipe names */
  const updated = run(['--agent', 'testcli', '--action', 'update']);
  assert.equal(updated.status, 0, updated.stderr);
});

test('a recipe that omits a capability is refused by name for that capability alone', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-registry-minimal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extra = path.join(directory, 'extra-recipes.toml');
  await writeFile(extra, `[recipes.barecli]
package = "@test/barecli"

[recipes.barecli.update]
kind = "reinstall"

[recipes.barecli.models]
kind = "none"

[recipes.barecli.mcp]
kind = "flag"
flag = "--servers"
`);
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; });

  assert.throws(() => modelArgs('barecli', 'anything'), /does not know how barecli is told which model/,
    'no model flag means a spawn refuses to pass one rather than guessing');
  assert.ok(knownAgents().some(entry => entry.cli === 'barecli'), 'and it still works for the rest: it is in the menu');
  assert.equal(ideConnectFlag('barecli'), null, 'no IDE connect means nothing is added to its command line');
});

/* Criterion 6's overlay: a codex launch carries its SessionStart hook the way claude's carries its
   settings file — same reporter, codex's own provider, the launch's own context on the command line,
   and no read or write of the person's ~/.codex (codex loads every config layer's hooks, so the
   person's own entries run beside ours untouched). Codex runs a non-managed hook only when its
   exact definition is trusted, so the same layer also carries this launch's trusted_hash, keyed to
   the session-flags layer codex synthesizes for -c overrides (verified against codex 0.153.4:
   docs/evidence/codex-sessionstart-hook-2026-09-11.md). */
test('a codex launch carries the SessionStart hook overlay beside its MCP wiring', async t => {
  const { contextFile } = await contextDir(t);
  const plan = await agentLaunch({ agent: 'codex', executable: '/installed/codex', contextFile, env: {} });
  const joined = plan.args.join(' ');
  assert.ok(plan.args.some(value => value.startsWith('hooks.SessionStart=')), 'the hook table is injected as a -c override');
  assert.ok(plan.args.some(value => value === 'features.hooks=true' || value.startsWith('features.hooks=')), 'and the feature is enabled for this launch');
  assert.match(joined, /red-agents.*report-session/, 'the hook runs the session reporter');
  assert.match(joined, /--provider codex/, 'with codex’s own provider');
  assert.ok(joined.includes(plan.contextFile), 'and the launch’s own context on the command line');

  const state = plan.args.find(value => value.startsWith('hooks.state='));
  assert.ok(state, 'the same layer carries the trust entry: no review prompt, no ~/.codex write');
  assert.ok(state.includes('/<session-flags>/config.toml:session_start:0:0'), 'keyed to codex’s synthetic session-flags layer');
  const hash = /trusted_hash=\\?"(sha256:[0-9a-f]{64})/.exec(state)?.[1];
  assert.ok(hash, 'with a sha256 of the hook definition codex hashes');
  const command = /(\/[^ '"]*red-agents)[^"]* report-session --provider codex --context [^"']+/.exec(joined)?.[0];
  assert.ok(command?.includes('/red-agents'), 'the reporter is the red-agents binary');
  assert.ok(command, 'the exact command the hook will run');
  assert.equal(hash, await hookTrustHash(command), 'and the trusted hash is for exactly that command, nothing else');
  assert.notEqual(hash, await hookTrustHash(`${command} --tampered`), 'a different command hashes differently, so trusting one trusts no other');
});

/* Criterion 5: the IDE lock directory follows CLAUDE_CONFIG_DIR, which Anthropic documents as
   moving it, with rEngine's own override still first. */
test('the IDE lock directory honours CLAUDE_CONFIG_DIR', t => {
  const saved = { RENGINE_IDE_DIRECTORY: process.env.RENGINE_IDE_DIRECTORY, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  delete process.env.RENGINE_IDE_DIRECTORY;
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.ok(ideDirectory().endsWith(path.join('.claude', 'ide')), 'the default is the CLI’s own path');
  process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config-elsewhere';
  assert.equal(ideDirectory(), path.join('/tmp/claude-config-elsewhere', 'ide'), 'a moved config moves the lock directory with it');
  process.env.RENGINE_IDE_DIRECTORY = '/tmp/rengine-ide-explicit';
  assert.equal(ideDirectory(), '/tmp/rengine-ide-explicit', 'and rEngine’s explicit override still wins');
});

/* KI-121: two reads of the recipe service AT ONCE. ref/unref are not counted by the runtime, so a
 * client that unrefs on every answer releases the handles a second call is still waiting on — the
 * loop drains and that call never resolves. `runtime/service-client.mjs` had already met this and
 * counts its refs; this client carried a comment claiming an answer in flight is always heard, and
 * did not. Any caller reaching for Promise.all could hang, which is how it was found.
 */
test('two reads of the recipe service at once both answer', async () => {
  const [identity, installs] = await Promise.all([processIdentity(), installPaths()]);
  assert.ok(Array.isArray(identity) && identity.length > 0, 'the first answered');
  assert.ok(Array.isArray(installs), 'and so did the second, rather than waiting forever');
  /* Three at once, to prove the count rather than a two-deep special case. */
  const three = await Promise.all([processIdentity(), installPaths(), processIdentity()]);
  assert.equal(three.length, 3);
  assert.deepEqual(three[2], identity, 'and the answers are not crossed between flights');
});
