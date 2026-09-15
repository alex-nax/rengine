import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readHandoff } from '../agents/handoff/index.mjs';
import { conversationHandoff, handoffCapableAgents, forgetRecipes } from '../agents/agents-client.mjs';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* This spec drives a Rust binary, so it builds one first: run alone it would otherwise judge
   whatever binary happened to be on disk (orchestrator/tests/cargo.mjs). */
before(() => built('--bins'));

test('handoff binds an explicit local conversation and checkpoint to the real project', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionId = '00000000-0000-0000-0000-000000000058';
  const home = path.join(dir, 'codex');
  const sessions = path.join(home, 'sessions/2026/09/05');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(dir, 'checkpoint.md'), 'Paused goal checkpoint.');
  const manifest = path.join(dir, 'handoff.json');
  await writeFile(manifest, JSON.stringify({ version: 1, project: '.', sessionId, checkpoint: 'checkpoint.md' }));
  const rollout = path.join(sessions, `rollout-test-${sessionId}.jsonl`);
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /Cannot find/);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: home } }) + '\n');
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /different project/);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: dir } }) + '\n');
  const result = await readHandoff(manifest, dir, { CODEX_HOME: home });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.project, await (await import('node:fs/promises')).realpath(dir));
  await assert.rejects(readHandoff(manifest, home, { CODEX_HOME: home }), /different project/);
  await rm(path.join(dir, 'checkpoint.md'));
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /ENOENT/);
});

/* F216, spec 141: which CLIs can be handed a paused conversation is a DECLARATION, not a name the
   door compares. `bridgecli` appears in no source file anywhere — it is a recipe, and that is the
   whole of what makes it capable. Before this, the door and agent.sh both refused everything but
   codex by name, so a second CLI that could be handed one had to edit shared code to say so. */
const BRIDGE_RECIPE = `[recipes.bridgecli]
package = "@test/bridgecli"

[recipes.bridgecli.update]
kind = "reinstall"

[recipes.bridgecli.models]
kind = "none"

[recipes.bridgecli.mcp]
kind = "flag"
flag = "--servers"

[recipes.bridgecli.conversation]
ids = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
parser = "codex-resume"
normalize = "lowercase"
provider = "bridgecli"
resumeLine = "bridgecli resume {id}"

[recipes.bridgecli.conversation.handoff]
kind = "rollout-jsonl"
ready = ["resume --help"]
`;

test('a CLI that is not codex can be handed a conversation by declaring it', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-declared-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const extra = path.join(dir, 'extra.toml');
  await writeFile(extra, BRIDGE_RECIPE);
  process.env.RENGINE_AGENT_REGISTRY_EXTRA = extra;
  t.after(() => { delete process.env.RENGINE_AGENT_REGISTRY_EXTRA; forgetRecipes(); });
  forgetRecipes();

  assert.deepEqual(await conversationHandoff('bridgecli'), { kind: 'rollout-jsonl', ready: ['resume --help'] },
    'the declaration is the answer, for a CLI with no code anywhere');
  assert.equal(await conversationHandoff('claude'), null, 'and a CLI that declares nothing cannot be handed one');
  const capable = await handoffCapableAgents();
  assert.deepEqual([...capable].sort(), ['bridgecli', 'codex'], 'both are capable, and nothing else is');

  /* The shell surface the resume check asks through, which used to compare the name itself. */
  const bin = path.join(ROOT, 'red/target/debug/red-agents');
  const asked = await promisify(execFile)(bin, ['can', 'bridgecli', 'handoff']);
  assert.match(asked.stdout, /kind=rollout-jsonl/);
  await assert.rejects(promisify(execFile)(bin, ['can', 'claude', 'handoff']),
    error => /claude does not declare handoff/.test(error.stderr), 'and it refuses the ones that do not');
});
