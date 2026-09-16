/* F168 (F148b, spec 129, KI-092), amended by F178: the RENGINE_AGENT_* spawn-environment
 * composition was one pure function on each side — agentPaneComposition in sessions.mjs and
 * agent_pane_composition in the red-agents crate — and the two agreed byte-for-byte on every
 * fixture. F178 deleted the JS one, so the pane half now compares the crate against the record
 * the JS side left behind (pane-composition-fixtures.json, captured from the module immediately
 * before it was deleted and never regenerated): the claim outlives the implementation that was
 * the other half of it. The envelope they travel in, shellEnvironment, is still two live
 * implementations and is still compared as one, including the cleared-set discipline both apply
 * (KI-068's lesson: a pane must never inherit another pane's identity).
 *
 * The harness shape is red-contract's (F140): the JS suite owns the fixtures and the deep-equal,
 * the red-agent-env binary owns the Rust answer. Mint and the clock are data, so nothing here
 * depends on a random draw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CASES, KIMI_ID, RECORDED, SID } from './pane-composition-fixtures.mjs';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'orchestrator/agents/registry.toml');
const BIN = path.join(ROOT, 'red/target/debug/red-agent-env');
const run = promisify(execFile);

async function rustPanePlan(directory, input) {
  const file = path.join(directory, 'pane.json');
  await writeFile(file, JSON.stringify(input));
  return JSON.parse((await run(BIN, ['pane', REGISTRY, file])).stdout);
}

test('the pane composition matches the record the JS side left behind', async t => {
  await built('-p', 'red-agents', '--bin', 'red-agent-env');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-spawn-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  for (const [title, input] of CASES) {
    const rust = await rustPanePlan(directory, input);
    assert.deepEqual(rust, RECORDED[title], title);
  }
});

test('the refuse case names the agent in the composition\'s own words', async () => {
  assert.equal(RECORDED[CASES[3][0]].refuse, 'kimi names its own conversations: rEngine can put this CLI back into a recorded one but cannot tell it which to start. Resume it explicitly, or start without naming one.');
});

/* The pane the host actually launches goes through the service, not the binary the fixtures use.
   One case end to end says the two entry points answer the same thing — a client that quietly
   stopped passing the mint or the clock would pass every fixture above and still be wrong. */
test('the service answers the same plan as the fixture binary', async () => {
  const { paneComposition, closeAgents } = await import('./agents-client.mjs');
  const [title, input] = CASES[0];
  try {
    const plan = await paneComposition({
      id: input.id, agent: input.agent, conversation: input.conversation, resume: input.resume,
      action: input.action, args: input.args, workspace: input.workspace, remembered: input.remembered,
      mint: input.mint, now: input.now, paths: input.paths,
    });
    assert.deepEqual(plan, RECORDED[title], title);
  } finally { closeAgents(); }
});

/* The envelope: shellEnvironment scrubs what a pane must never inherit and declares colour, and
 * the two-stage composition (spawnTerminal's lines 133 and 205) is what 'cleared in BOTH
 * compositions' means. Fixtures cover the inherited-scrub, the explicit-override win, the
 * undefined-delete the cleared set rides on, and the win32 key rules. */
const SHELL_CASES = [
  ['a pane environment is scrubbed and augmented', {
    inherited: { PATH: '/usr/bin:/bin', NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1', EDITOR: 'vi' },
    overrides: {}, platform: 'darwin', userDirectory: '/home/person',
  }],
  ['an explicit NO_COLOR override wins', {
    inherited: { PATH: '/usr/bin:/bin' }, overrides: { NO_COLOR: '1' }, platform: 'darwin', userDirectory: '/home/person',
  }],
  ['undefined in the overrides deletes, the mechanism the cleared set rides on', {
    inherited: { PATH: '/usr/bin:/bin', RENGINE_AGENT_CONVERSATION: 'stale', FOO: 'x' },
    overrides: { FOO: null, RENGINE_AGENT_CONVERSATION: null }, platform: 'darwin', userDirectory: '/home/person',
  }],
  ['a host started inside a Claude pane hands no session identity to a pane (KI-113)', {
    inherited: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', CLAUDE_PID: '92680', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: '287bba3a', CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_01', CLAUDE_CODE_EXECPATH: '/v/2.1.260', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
      CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_DIFF_TOOL: 'cursor', CLAUDE_EFFORT: 'xhigh' },
    overrides: { CLAUDE_CODE_SESSION_ID: 'minted' }, platform: 'darwin', userDirectory: '/home/person',
  }],
  ['win32 upper-cases keys and dedupes PATH case-insensitively', {
    inherited: { Path: 'C:\\Windows;C:\\tools', TOOLS: 'C:\\tools', no_color: '1', claude_code_child_session: '1' },
    overrides: {}, platform: 'win32', userDirectory: 'C:\\Users\\person',
  }],
];

function jsShellEnv(input, shellEnvironment, declared) {
  const undefine = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]));
  return shellEnvironment(undefine(input.overrides), { inherited: input.inherited, platform: input.platform,
    userDirectory: input.userDirectory, ...declared });
}

async function rustShellEnv(directory, input) {
  const file = path.join(directory, 'shell.json');
  await writeFile(file, JSON.stringify(input));
  /* The registry too, since F220: what a pane must not inherit and where a CLI installs itself are
     the recipes', so neither side can compose the envelope without reading the one document. */
  return JSON.parse((await run(BIN, ['shell', REGISTRY, file])).stdout);
}

test('the shell envelope matches on every fixture', async t => {
  const sessions = await import('./sessions-client.mjs');
  const declared = { identity: await sessions.agentProcessIdentity(), installs: await sessions.agentInstallPaths() };
  assert.ok(declared.identity.length > 0, 'the declarations arrived — an empty list scrubs nothing and would match trivially');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-shell-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [title, input] of SHELL_CASES) {
    const js = jsShellEnv(input, sessions.shellEnvironment, declared);
    const rust = await rustShellEnv(directory, input);
    assert.deepEqual(rust, js, title);
  }
});

/* The full two-stage spawn environment for one pane fixture: stale RENGINE_AGENT_* and
 * ORCHESTRATOR_SESSION/HANDOFF_* values in the inherited set must be gone after BOTH
 * compositions, the launch's own CONVERSATION must survive, and AGENT_HOME must be present. */
test('the final spawn env is cleared in both compositions and keeps the launch identity', async t => {
  const sessions = await import('./sessions-client.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-final-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [recorded, input] = CASES[4];
  assert.match(recorded, /^kimi resumes a recorded conversation/, 'the fixture this stage builds on');
  const shell = {
    inherited: { PATH: '/usr/bin:/bin' }, platform: 'darwin', userDirectory: '/home/person',
    env: { RENGINE_AGENT_CONVERSATION: 'stale', RENGINE_AGENT_RESUME: 'stale', RENGINE_AGENT_CONVERSATIONS: 'stale',
           RENGINE_ORCHESTRATOR_SESSION: 'stale', RENGINE_HANDOFF_GATE: 'stale', RENGINE_HANDOFF_FILE: 'stale' },
    agentHome: '/state/agents',
  };
  const plan = RECORDED[recorded];
  const cleared = { RENGINE_HANDOFF_GATE: undefined, RENGINE_HANDOFF_FILE: undefined, RENGINE_ORCHESTRATOR_SESSION: undefined,
    RENGINE_AGENT_CONVERSATION: undefined, RENGINE_AGENT_RESUME: undefined, RENGINE_AGENT_CONVERSATIONS: undefined };
  const declared = { identity: await sessions.agentProcessIdentity(), installs: await sessions.agentInstallPaths() };
  const stage = (overrides) => sessions.shellEnvironment(overrides,
    { inherited: shell.inherited, platform: shell.platform, userDirectory: shell.userDirectory, ...declared });
  const js = stage({ ...cleared, ...stage({ ...shell.env, RENGINE_AGENT_HOME: shell.agentHome, ...cleared }), ...plan.sets, RENGINE_AGENT_HOME: shell.agentHome });

  const file = path.join(directory, 'final.json');
  await writeFile(file, JSON.stringify({ pane: input, shell }));
  const rust = JSON.parse((await run(BIN, ['spawn', REGISTRY, file])).stdout);
  assert.deepEqual(rust, js);
  for (const stale of ['RENGINE_HANDOFF_GATE', 'RENGINE_HANDOFF_FILE', 'RENGINE_AGENT_CONVERSATIONS'])
    assert.ok(!(stale in rust), `${stale} stayed gone`);
  assert.equal(rust.RENGINE_AGENT_CONVERSATION, KIMI_ID, 'the launch identity survived both clears');
  assert.equal(rust.RENGINE_AGENT_RESUME, '1');
  assert.equal(rust.RENGINE_ORCHESTRATOR_SESSION, SID, "cleared of the stale value, then set to this launch's own");
  assert.equal(rust.RENGINE_AGENT_HOME, shell.agentHome);
});
