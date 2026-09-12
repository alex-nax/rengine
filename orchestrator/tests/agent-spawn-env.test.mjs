/* F168 (F148b, spec 129, KI-092): the RENGINE_AGENT_* spawn-environment composition is one pure
 * function on each side — agentPaneComposition in sessions.mjs (extracted here, so the behavior
 * pty.spawn receives is pinned at exactly that boundary) and agent_pane_composition in the
 * red-agents crate — and the two agree byte-for-byte on every fixture. The envelope they travel
 * in, shellEnvironment, is pinned the same way, including the cleared-set discipline both
 * compositions apply (KI-068's lesson: a pane must never inherit another pane's identity).
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'orchestrator/agents/registry.toml');
const BIN = path.join(ROOT, 'red/target/debug/red-agent-env');
const run = promisify(execFile);

const PATHS = {
  agentScript: '/repo/scripts/agent.sh',
  rootPath: '/work/project',
  workspaceContextFile: '/state/integrations/12345678-1234-1234-1234-123456789abc.json',
  listingFile: '/state/integrations/00000000-0000-0000-0000-0000000000aa.conversations.tsv',
  node: '/usr/local/bin/node',
  bash: '/bin/bash',
};
const SID = '00000000-0000-0000-0000-0000000000aa';
const MINT = '11111111-2222-3333-4444-555555555555';
const KIMI_ID = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const UUID = '3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const NOW = 1_800_000_000_000;
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

const REMEMBERED = [
  { id: UUID, agent: 'codex', lastSeenAt: NOW - 30 * 1000 },        // just now
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', agent: 'claude', lastSeenAt: NOW - 45 * MINUTE },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', agent: 'kimi', lastSeenAt: NOW - 90 * MINUTE },  // an hour ago
  { id: 'aaaaaaaa-0000-0000-0000-000000000003', agent: '', lastSeenAt: NOW - 5 * HOUR },
  { id: 'aaaaaaaa-0000-0000-0000-000000000004', agent: 'claude', lastSeenAt: NOW - 30 * HOUR },  // yesterday
  { id: 'aaaaaaaa-0000-0000-0000-000000000005', agent: 'codex', lastSeenAt: NOW - 5 * DAY },
];

const pane = fields => ({
  id: SID, agent: null, conversation: null, resume: false, action: 'launch', args: [],
  workspace: true, remembered: REMEMBERED, mint: MINT, now: NOW, paths: PATHS, ...fields,
});

const CASES = [
  ['claude mints for a bare workspace pane and offers the project history', pane({ agent: 'claude' })],
  ['claude with trailing args still mints, and is offered nothing', pane({ agent: 'claude', args: ['--model', 'claude-opus-5'] })],
  ['kimi names its own on a bare pane: nothing minted, the history still offered', pane({ agent: 'kimi' })],
  ['kimi refuses a named conversation without resume, in its own words', pane({ agent: 'kimi', conversation: KIMI_ID })],
  ['kimi resumes a recorded conversation, which leaves the offered list', pane({ agent: 'kimi', conversation: KIMI_ID, resume: true })],
  ['codex resumes a recorded conversation', pane({ agent: 'codex', conversation: UUID, resume: true })],
  ['codex on a bare pane mints nothing', pane({ agent: 'codex' })],
  ['gemini has no conversation capability and is not refused for one named', pane({ agent: 'gemini', conversation: UUID })],
  ['an unknown agent is not refused either', pane({ agent: 'testcli', conversation: UUID })],
  ['without a workspace only argv is composed, and no conversation is claimed', pane({ agent: 'claude', conversation: UUID, workspace: false })],
  ['claude resumes when asked', pane({ agent: 'claude', conversation: UUID, resume: true })],
  ['the offered list never contains the conversation the pane just took', pane({ agent: 'claude',
    remembered: [{ id: MINT, agent: 'claude', lastSeenAt: NOW - 30 * 1000 }, ...REMEMBERED] })],
];

function jsPanePlan(input, agentPaneComposition) {
  return agentPaneComposition({
    id: input.id, agent: input.agent ?? undefined, conversation: input.conversation ?? undefined,
    resume: input.resume, action: input.action, args: input.args, workspace: input.workspace,
    remembered: input.remembered, mint: () => input.mint, now: input.now, paths: input.paths,
  });
}

async function rustPanePlan(directory, input) {
  const file = path.join(directory, 'pane.json');
  await writeFile(file, JSON.stringify(input));
  return JSON.parse((await run(BIN, ['pane', REGISTRY, file])).stdout);
}

test('the pane composition matches byte-for-byte on every fixture', async t => {
  await run('cargo', ['build', '-p', 'red-agents', '--bin', 'red-agent-env'], { cwd: path.join(ROOT, 'red') });
  const { agentPaneComposition } = await import('../server/sessions.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-spawn-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [title, input] of CASES) {
    const js = jsPanePlan(input, agentPaneComposition);
    const rust = await rustPanePlan(directory, input);
    assert.deepEqual(rust, JSON.parse(JSON.stringify(js)), title);
  }
});

test('the refuse case names the agent in the composition\'s own words', async t => {
  const { agentPaneComposition } = await import('../server/sessions.mjs');
  const input = CASES[3][1];
  const plan = jsPanePlan(input, agentPaneComposition);
  assert.equal(plan.refuse, 'kimi names its own conversations: rEngine can put this CLI back into a recorded one but cannot tell it which to start. Resume it explicitly, or start without naming one.');
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
  ['win32 upper-cases keys and dedupes PATH case-insensitively', {
    inherited: { Path: 'C:\\Windows;C:\\tools', TOOLS: 'C:\\tools', no_color: '1' },
    overrides: {}, platform: 'win32', userDirectory: 'C:\\Users\\person',
  }],
];

function jsShellEnv(input, shellEnvironment) {
  const undefine = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? undefined]));
  return shellEnvironment(undefine(input.overrides), { inherited: input.inherited, platform: input.platform, userDirectory: input.userDirectory });
}

async function rustShellEnv(directory, input) {
  const file = path.join(directory, 'shell.json');
  await writeFile(file, JSON.stringify(input));
  return JSON.parse((await run(BIN, ['shell', file])).stdout);
}

test('the shell envelope matches on every fixture', async t => {
  const { shellEnvironment } = await import('../server/sessions.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-shell-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [title, input] of SHELL_CASES) {
    const js = jsShellEnv(input, shellEnvironment);
    const rust = await rustShellEnv(directory, input);
    assert.deepEqual(rust, js, title);
  }
});

/* The full two-stage spawn environment for one pane fixture: stale RENGINE_AGENT_* and
 * ORCHESTRATOR_SESSION/HANDOFF_* values in the inherited set must be gone after BOTH
 * compositions, the launch's own CONVERSATION must survive, and AGENT_HOME must be present. */
test('the final spawn env is cleared in both compositions and keeps the launch identity', async t => {
  const sessions = await import('../server/sessions.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-final-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = pane({ agent: 'kimi', conversation: KIMI_ID, resume: true });
  const shell = {
    inherited: { PATH: '/usr/bin:/bin' }, platform: 'darwin', userDirectory: '/home/person',
    env: { RENGINE_AGENT_CONVERSATION: 'stale', RENGINE_AGENT_RESUME: 'stale', RENGINE_AGENT_CONVERSATIONS: 'stale',
           RENGINE_ORCHESTRATOR_SESSION: 'stale', RENGINE_HANDOFF_GATE: 'stale', RENGINE_HANDOFF_FILE: 'stale' },
    agentHome: '/state/agents',
  };
  const plan = jsPanePlan(input, sessions.agentPaneComposition);
  const cleared = { RENGINE_HANDOFF_GATE: undefined, RENGINE_HANDOFF_FILE: undefined, RENGINE_ORCHESTRATOR_SESSION: undefined,
    RENGINE_AGENT_CONVERSATION: undefined, RENGINE_AGENT_RESUME: undefined, RENGINE_AGENT_CONVERSATIONS: undefined };
  const stage = (overrides) => sessions.shellEnvironment(overrides,
    { inherited: shell.inherited, platform: shell.platform, userDirectory: shell.userDirectory });
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
