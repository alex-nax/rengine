/* F171 (F149a, spec 129, KI-093): the red-agents binary speaks the registry to its shell callers.
 * Its list/show surface is byte-exact with the registry.mjs CLI it replaces behind agent.sh; the
 * conversation flag parsers answer the same {id, source} the JS parsers answer for the same argv;
 * the codex hook key and trust hash are byte-exact with codexHookKey/codexHookTrustHash on the
 * documented formula's fixture set (docs/evidence/codex-sessionstart-hook-2026-09-11.md — the
 * recorded live hash embedded machine paths, so the pinned literals here are computed by the JS
 * side on fixed commands today, and any drift in EITHER side fails).
 *
 * And agent.sh itself: its registry reads dispatch to the binary, proven by running it with a
 * node that does not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { built } from './cargo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-agents');
/* registry.mjs was deleted in F173. Its answers were recorded first (agents-fixtures.json), which
   is what a byte-exactness claim can be judged against once the other side no longer exists —
   regenerating the record would be judging the replacement against itself. */
const FIXTURES = JSON.parse(readFileSync(new URL('./agents-fixtures.json', import.meta.url), 'utf8'));
const run = promisify(execFile);
const NODE = process.execPath;

async function build() {
  await built('-p', 'red-agents');
  assert.ok(existsSync(BIN), `red-agents was built at ${BIN}`);
}

const cli = async args => run(BIN, args).catch(error => error);
/* A refusal should read as a refusal. `parse` prints its answer on stdout and its refusal on
   stderr, so JSON.parse of a refused run used to throw "Unexpected end of JSON input" and hide
   which CLI said no and why — an afternoon of F213 went into re-deriving that. */
const parsed = async (cliName, args) => {
  const answered = await cli(['parse', cliName, '--', ...args]);
  assert.ok(answered.stdout, `parse ${cliName} ${args.join(' ')} answered — instead: ${(answered.stderr || '').trim() || 'nothing at all'}`);
  return JSON.parse(answered.stdout);
};
/* Two recordings, and `list --names` is in both: which one a case is judged against is the whole
   point of the case, so the table is named rather than searched. */
const recorded = (args, table = 'cli') => FIXTURES[table][args.join(' ')];

test('list and show are byte-exact with the registry.mjs CLI, errors included', async t => {
  await build();
  for (const args of [['list'], ['list', '--names'], ['show', 'claude'], ['show', 'codex', 'UPDATE_COMMAND'],
                      ['show', 'kimi', 'STRIP_PREFIX'], ['show', 'gemini', 'STRIP_PREFIX']]) {
    const rust = await cli(args), js = recorded(args);
    assert.equal(rust.stdout, js.stdout, `stdout for ${args.join(' ')}`);
    assert.equal(rust.code ?? 0, js.code ?? 0, `exit for ${args.join(' ')}`);
  }
  /* The extra file rides the same environment on both sides (F167's TOML form). */
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-cli-extra-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extra = path.join(directory, 'extra.toml');
  await writeFile(extra, `[recipes.testcli]\npackage = "@test/testcli"\n\n[recipes.testcli.update]\nkind = "self"\ncommand = "upgrade"\n\n[recipes.testcli.models]\nkind = "none"\n\n[recipes.testcli.mcp]\nkind = "flag"\nflag = "--servers"\n`);
  const env = { ...process.env, RENGINE_AGENT_REGISTRY_EXTRA: extra };
  for (const args of [['list', '--names'], ['show', 'testcli'], ['show', 'testcli', 'UPDATE_COMMAND']]) {
    const rust = await run(BIN, args, { env }).catch(error => error), js = recorded(args, 'cliWithExtra');
    assert.equal(rust.stdout, js.stdout, `stdout for ${args.join(' ')} with an extra`);
    if (args.length < 3) assert.ok(rust.stdout.includes('testcli'), 'the extra recipe is in the answer');
  }
  for (const [args, message] of [
    [['show', 'nope'], 'No agent named nope is registered.'],
    [['show', 'claude', 'NOPE'], 'The registry has no NOPE for claude.'],
    [[], 'Usage:'],
  ]) {
    const rust = await cli(args), js = recorded(args);
    assert.ok((rust.code ?? 0) !== 0, `${args.join(' ')} fails`);
    /* The refusal a person reads, and the exit code a script reads: `js` is the recording where one
       was made, and a usage refusal (no arguments at all) was not worth recording to compare a 2 to
       a 2 — the message is the claim. */
    if (js) assert.equal((rust.code ?? 0) === 2, (js.code ?? 0) === 2, `exit code for ${args.join(' ')}`);
    assert.ok(rust.stderr.includes(message), `stderr names it: ${rust.stderr.trim()}`);
  }
});

/* The three resume spellings, on recorded argv. The JS parsers in registry.mjs are the reference;
 * the literal anchors pin a few so a drift in JS alone is also caught. */
const UUID = '3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const KIMI_ID = 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6';
const ULID = '01M2AGK5YNB630T8HJ2SQPXR3B';
const PARSE_CASES = [
  ['claude', ['--session-id', UUID]], ['claude', ['--resume', UUID]], ['claude', [`--session-id=${UUID}`]],
  ['claude', ['-c']], ['claude', ['--continue']], ['claude', ['--fork-session']],
  ['claude', ['--session-id', 'not-a-uuid']], ['claude', ['--resume', UUID, '-c']],
  ['claude', ['--resume', UUID.slice(0, 35)]], ['claude', ['--resume', UUID.toUpperCase()]], ['claude', []],
  ['kimi', ['--session', KIMI_ID]], ['kimi', ['-S', KIMI_ID]], ['kimi', ['--resume', ULID]],
  ['kimi', ['-c']], ['kimi', ['--session', 'garbage']], ['kimi', [`--session=${ULID}`]], ['kimi', []],
  ['codex', ['resume', UUID]], ['codex', ['resume']], ['codex', ['-m', 'gpt-5', 'resume', UUID]],
  ['codex', ['--model=gpt-5', 'resume', UUID]], ['codex', ['exec', 'resume', UUID]],
  ['codex', ['resume', 'not-a-uuid']], ['codex', []],
];

test('the conversation parsers answer what the JS parsers answer', async t => {
  await build();
  /* Against the answers the JS parsers gave, recorded before they were deleted. The pinned anchors
     below are the half that needs no other implementation at all, and they are why this test still
     says something once there is only one parser left. */
  for (const [cliName, cases] of Object.entries(FIXTURES.parsers)) {
    for (const { args, parsed: expected } of cases) {
      const rust = await parsed(cliName, args);
      assert.deepEqual(rust, expected, `${cliName} ${args.join(' ')}`);
    }
  }
  const anchors = [
    [['claude', ['--resume', UUID]], { id: UUID, source: 'flag' }],
    [['claude', ['-c']], { id: null, source: 'unknown' }],
    [['kimi', ['--session', KIMI_ID]], { id: KIMI_ID, source: 'flag' }],
    [['codex', []], { id: null, source: 'minted' }],
  ];
  for (const [[cliName, args], expected] of anchors) {
    const rust = await parsed(cliName, args);
    assert.deepEqual(rust, expected, `${cliName} ${args.join(' ')} pinned`);
  }
});

test('the codex hook key and trust hash are byte-exact with the JS math', async t => {
  await build();
  assert.equal((await cli(['hook-key'])).stdout.trim(), FIXTURES.hookKeys['0,0']);
  assert.equal((await cli(['hook-key'])).stdout.trim(), '/<session-flags>/config.toml:session_start:0:0');
  assert.equal((await cli(['hook-key', '--platform', 'win32'])).stdout.trim(),
    'C:\\<session-flags>\\config.toml:session_start:0:0');
  assert.equal((await cli(['hook-key', '1', '2'])).stdout.trim(), '/<session-flags>/config.toml:session_start:1:2');

  const commands = [
    '/usr/local/bin/node /repo/orchestrator/agents/report-session.mjs --provider codex --context /state/context.json',
    "'/opt/homebrew/bin/node' '/space dir/report-session.mjs' --provider codex --context '/state/my context.json'",
    'C:\\node\\node.exe C:\\repo\\report-session.mjs --provider codex --context C:\\state\\context.json',
  ];
  for (const command of commands) {
    for (const matcher of [undefined, 'startup']) {
      const args = ['trust-hash', command, ...(matcher ? [matcher] : [])];
      assert.equal((await cli(args)).stdout.trim(), FIXTURES.trustShapes[JSON.stringify([command, matcher ?? null])],
        `${command} [${matcher ?? 'default'}]`);
    }
  }
  /* The pinned literals, computed from the JS side on the canonical command today: any drift in
     either side's canonicalization fails, even if the two were to drift together by edit. */
  assert.equal((await cli(['trust-hash', commands[0]])).stdout.trim(),
    'sha256:12f31cc1e970b72812fdbf48aad7d942ae48cbdf1293a490f430831b16651e2a');
  assert.equal((await cli(['trust-hash', commands[0], 'startup'])).stdout.trim(),
    'sha256:8626ba99e1506308944b1ebc1f2dfcbcbb97057a8ff478807fba46080a38ed60');
  assert.notEqual((await cli(['trust-hash', `${commands[0]} --tampered`])).stdout.trim(),
    (await cli(['trust-hash', commands[0]])).stdout.trim(), 'a different command hashes differently');
});

test('agent.sh reads the registry through the binary, with node gone', async t => {
  await build();
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-sh-rust-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(ROOT, 'scripts/agent.sh');
  const env = { ...process.env, PATH: `${directory}:/usr/bin:/bin`,
    RENGINE_AGENT_HOME: path.join(directory, 'managed'), RENGINE_NODE: '/nonexistent/node' };
  const listed = spawnSync('bash', [script, '--project', tmpdir(), '--action', 'list'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.trim().split('\n').map(line => line.split('\t')[0]);
  assert.deepEqual(names, ['claude', 'codex', 'gemini', 'opencode', 'kimi'],
    'the registry answered with RENGINE_NODE pointing nowhere — the binary, not node, answered');

  const missing = spawnSync('bash', [script, '--project', tmpdir(), '--action', 'list'],
    { env: { ...env, RENGINE_RED_AGENTS: '/nonexistent/red-agents' }, encoding: 'utf8', timeout: 15000 });
  assert.match(missing.stderr, /red-agents/, 'a missing binary is named, not silently worked around');
});
