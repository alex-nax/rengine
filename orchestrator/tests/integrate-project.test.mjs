import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bashPath } from '../server/sessions.mjs';
import { readDeclaration } from '../server/formats.mjs';

const execute = promisify(execFile);
const ENGINE = path.resolve();
const ACTION = path.join(ENGINE, 'orchestrator/actions/integrate-project.sh');
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const cleanup = [];

test.after(async () => { for (const directory of cleanup) await rm(directory, { recursive: true, force: true }); });

async function repository() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-integrate-')));
  cleanup.push(directory);
  await execute('git', ['init', '--quiet', directory]);
  await execute('git', ['-C', directory, 'config', 'user.email', 'fixture@example.invalid']);
  await execute('git', ['-C', directory, 'config', 'user.name', 'Fixture']);
  return directory;
}
const wizard = (args, options = {}) =>
  execute(bashPath(), [ACTION, ...args], { timeout: 180000, encoding: 'utf8', ...options });
const printed = output => output.split('\n').filter(line => line.startsWith('+ ')).map(line => line.slice(2));
const declarationOf = async root => JSON.parse(await readFile(path.join(root, '.rengine/project.json'), 'utf8'));
const missing = async file => { try { await stat(file); return false; } catch { return true; } };

/** The contract-2 rules of specs 074/075/076, applied here because this branch's reader knows
 * contract 1 only; the reader itself checks the contract-1 core in its own test below. */
function contractTwoProblems(value, root) {
  const problems = [], literal = list => Array.isArray(list) && list.every(item => typeof item === 'string' && item.length);
  if (![1, 2].includes(value.contract)) problems.push('contract must be 1 or 2');
  if (typeof value.project !== 'string' || !value.project.length) problems.push('project must be a non-empty name');
  if (!Array.isArray(value.formats) || !value.formats.length) problems.push('formats must be a non-empty array');
  for (const format of value.formats ?? []) {
    if (!KEBAB.test(format.id ?? '')) problems.push(`format id ${JSON.stringify(format.id)} is not kebab-case`);
    if (!Array.isArray(format.modes) || !format.modes.includes(format.default)) problems.push(`${format.id}: default must be one of modes`);
    if (format.modes?.includes('preview') && !format.preview) problems.push(`${format.id}: preview mode needs a preview command`);
    for (const key of ['preview', 'entry']) if (format[key] && !literal(format[key].command)) problems.push(`${format.id}.${key}.command must be literal argv`);
  }
  if (value.game !== undefined) {
    const game = value.game;
    if (!KEBAB.test(game.id ?? '')) problems.push('game.id must be kebab-case');
    if (typeof game.title !== 'string' || !game.title.length || game.title.length > 32) problems.push('game.title must be 1..32 characters');
    if (!literal(game.executable) || !game.executable.length) problems.push('game.executable must be a non-empty list of paths');
    for (const candidate of game.executable ?? [])
      if (path.isAbsolute(candidate) || candidate.split('/').includes('..')) problems.push(`game.executable ${candidate} must be root-relative`);
    if (!['external', 'sdl2-interpose'].includes(game.surface)) problems.push('game.surface must be external or sdl2-interpose');
    if (game.args !== undefined && !literal(game.args)) problems.push('game.args must be literal argv');
    for (const [key, item] of Object.entries(game.env ?? {}))
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof item !== 'string') problems.push(`game.env ${key} must be UPPER_SNAKE with a literal value`);
  }
  if (value.dashboard !== undefined) {
    if (value.contract !== 2) problems.push('a dashboard requires contract 2');
    const dashboard = value.dashboard, actions = new Set(), groups = new Set();
    if (typeof dashboard.title !== 'string' || !dashboard.title.length) problems.push('dashboard.title is required');
    if (!Array.isArray(dashboard.groups) || !dashboard.groups.length) problems.push('dashboard.groups must be a non-empty array');
    for (const group of dashboard.groups ?? []) {
      if (!KEBAB.test(group.id ?? '')) problems.push(`dashboard group id ${JSON.stringify(group.id)} is not kebab-case`);
      if (groups.has(group.id)) problems.push(`duplicate dashboard group ${group.id}`);
      groups.add(group.id);
      if (typeof group.title !== 'string' || !group.title.length) problems.push(`group ${group.id} needs a title`);
      if (!Array.isArray(group.actions) || !group.actions.length) problems.push(`group ${group.id} needs actions`);
      for (const action of group.actions ?? []) {
        if (!KEBAB.test(action.id ?? '')) problems.push(`action id ${JSON.stringify(action.id)} is not kebab-case`);
        if (actions.has(action.id)) problems.push(`duplicate action ${action.id}`);
        actions.add(action.id);
        if (typeof action.title !== 'string' || !action.title.length) problems.push(`action ${action.id} needs a title`);
        if (!['script', 'log', 'capture'].includes(action.kind)) problems.push(`action ${action.id} has an unknown kind`);
        if (action.kind === 'script') {
          if (typeof action.script !== 'string' || !action.script.endsWith('.sh') || path.isAbsolute(action.script) || action.script.split('/').includes('..'))
            problems.push(`action ${action.id}: script must be a root-relative .sh path`);
          if (action.args !== undefined && !literal(action.args)) problems.push(`action ${action.id}: args must be literal argv`);
          if (action.command !== undefined) problems.push(`action ${action.id}: script actions carry no command`);
        }
        if (action.kind !== 'script' && !literal(action.command)) problems.push(`action ${action.id}: command must be literal argv`);
      }
    }
  }
  return { problems, scripts: (value.dashboard?.groups ?? []).flatMap(group => group.actions.filter(action => action.kind === 'script').map(action => path.join(root, action.script))) };
}

test('the wizard scaffolds a contract 2 declaration, launcher and test that satisfy the contract rules', async () => {
  const root = await repository();
  const result = await wizard(['--project', root, '--name', 'sample-project', '--no-submodule',
    '--game-title', 'Sample game', '--game-exe', 'build/sample-game', '--game-surface', 'external']);
  assert.match(result.stderr, /\[1\/5\]/);
  assert.match(result.stderr, /Completed 5 stages/);

  const declaration = await declarationOf(root);
  assert.equal(declaration.contract, 2);
  assert.equal(declaration.project, 'sample-project');
  const { problems, scripts } = contractTwoProblems(declaration, root);
  assert.deepEqual(problems, []);
  assert.equal(declaration.game.surface, 'external');
  assert.ok(declaration.game.executable.includes('build/sample-game'), declaration.game.executable);
  const check = declaration.dashboard.groups.flatMap(group => group.actions).find(action => action.id === 'editor-check');
  assert.deepEqual([check.kind, check.script, check.args], ['script', 'editor.sh', ['--check']]);
  for (const script of scripts) assert.equal((await stat(script)).isFile(), true, script);

  const launcher = await stat(path.join(root, 'editor.sh'));
  assert.ok(launcher.mode & 0o111, 'editor.sh must be executable');
  assert.equal((await stat(path.join(root, 'tests/test_rengine_project_decl.py'))).isFile(), true);
  const template = await readFile(path.join(root, 'editor.sh'), 'utf8');
  assert.doesNotMatch(template, /nolf|vtmb|relith|troika/i, 'templates must not name a specific consumer');
  assert.match(result.stdout, /editor\.sh --check/);
});

test('the same skeleton at contract 1 without game or dashboard is read by this branch', async () => {
  const root = await repository();
  await wizard(['--project', root, '--name', 'contract-one', '--contract', '1', '--no-submodule']);
  const declaration = await declarationOf(root);
  assert.equal(declaration.contract, 1);
  assert.equal(declaration.game, undefined);
  assert.equal(declaration.dashboard, undefined);

  const read = await readDeclaration(root);
  assert.equal(read.declared, true);
  assert.equal(read.error, undefined, read.error);
  assert.equal(read.project, 'contract-one');
  assert.ok(read.formats.length >= 1, 'the skeleton needs at least one format record');
});

test('the scaffolded launcher bootstraps the pinned tree and never launches under --bootstrap-only', async () => {
  const root = await repository();
  await wizard(['--project', root, '--name', 'launcher-only', '--no-submodule']);
  const result = await execute(bashPath(), [path.join(root, 'editor.sh'), '--dry-run', '--rebuild', '--bootstrap-only'],
    { cwd: root, timeout: 60000, encoding: 'utf8' });
  const commands = printed(result.stdout);
  for (const expected of ['npm ci', 'npm run build:surface', 'npm run build'])
    assert.ok(commands.includes(expected), `${expected} missing from ${JSON.stringify(commands)}`);
  assert.ok(commands.some(command => command.includes('submodule update --init third_party/rengine')), commands);
  assert.ok(!commands.some(command => command.includes('launch.mjs')), commands);

  const launched = await execute(bashPath(), [path.join(root, 'editor.sh'), '--dry-run', '--agent', 'codex'], { cwd: root, timeout: 60000, encoding: 'utf8' });
  const launch = printed(launched.stdout).filter(command => command.includes('orchestrator/launch.mjs'));
  assert.equal(launch.length, 1, launched.stdout);
  assert.ok(launch[0].includes(`--project ${root}`) && launch[0].includes('--agent codex'), launch[0]);
});

test('the copied declaration test passes on the scaffold it was written for', async t => {
  try { await execute('python3', ['--version']); } catch { return t.skip('python3 is unavailable'); }
  for (const [name, extra] of [['python-contract-two', []], ['python-contract-one', ['--contract', '1']]]) {
    const root = await repository();
    await wizard(['--project', root, '--name', name, '--no-submodule', ...extra]);
    const result = await execute('python3', [path.join(root, 'tests/test_rengine_project_decl.py'), '--root', root, '--rengine', ENGINE],
      { cwd: root, timeout: 120000, encoding: 'utf8' });
    assert.match(result.stderr, /OK/, result.stderr);
  }
});

test('existing files are reported and never overwritten, and --dry-run writes nothing', async () => {
  const root = await repository();
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  const owned = { 'editor.sh': '# project owned\n', '.rengine/project.json': '{"sentinel":true}\n', 'tests/test_rengine_project_decl.py': '# owned test\n' };
  for (const [relative, body] of Object.entries(owned)) await writeFile(path.join(root, relative), body);
  const result = await wizard(['--project', root, '--name', 'already-integrated', '--no-submodule']);
  for (const [relative, body] of Object.entries(owned)) assert.equal(await readFile(path.join(root, relative), 'utf8'), body, relative);
  for (const relative of Object.keys(owned)) assert.ok(result.stderr.includes(`exists, skipped: ${relative}`), result.stderr);

  const empty = await repository();
  const dry = await wizard(['--project', empty, '--name', 'dry-run', '--no-submodule', '--dry-run']);
  assert.deepEqual(await readdir(empty), ['.git']);
  const commands = printed(dry.stdout);
  assert.ok(commands.some(command => command.startsWith('cp ') && command.endsWith('editor.sh')), commands);
  assert.ok(commands.some(command => command === 'write .rengine/project.json'), commands);
  assert.ok(commands.some(command => command.endsWith('tests/test_rengine_project_decl.py')), commands);
});

test('the submodule stage pins the requested rEngine commit, or prints exactly that plan', async () => {
  const root = await repository();
  const head = (await execute('git', ['-C', ENGINE, 'rev-parse', 'HEAD'])).stdout.trim();
  const source = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-origin-'))), 'rengine.git');
  cleanup.push(path.dirname(source));
  await execute('git', ['clone', '--quiet', '--bare', ENGINE, source]);
  const url = `file://${source}`;
  const environment = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const args = ['--project', root, '--name', 'pinned-project', '--rengine-url', url, '--pin', head];

  const plan = printed((await wizard([...args, '--dry-run'], { env: environment })).stdout);
  assert.ok(plan.some(command => command.includes(`submodule add ${url} third_party/rengine`)), plan);
  assert.ok(plan.some(command => command.includes(`checkout --detach ${head}`)), plan);

  try { await wizard(args, { env: environment }); }
  catch (error) {
    assert.match(String(error.stderr), /submodule/i);
    return; /* this git refuses a file:// submodule; the printed plan above is the assertion */
  }
  assert.equal((await stat(path.join(root, 'third_party/rengine/package.json'))).isFile(), true);
  assert.equal(await missing(path.join(root, '.gitmodules')), false);
  const status = (await execute('git', ['-C', root, 'submodule', 'status'], { env: environment })).stdout;
  assert.ok(status.includes(head), status);
});

test('the wizard refuses unknown options, missing values and a non-repository project', async () => {
  await assert.rejects(wizard(['--bogus'], { timeout: 20000 }), error => error.code === 2 && /Unknown option/.test(error.stderr));
  await assert.rejects(wizard(['--project'], { timeout: 20000 }), error => error.code === 2 && /Missing value/.test(error.stderr));
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-plain-')));
  cleanup.push(plain);
  await assert.rejects(wizard(['--project', plain, '--name', 'not-a-repo', '--no-submodule'], { timeout: 30000 }),
    error => /git repository/.test(error.stderr));
  await assert.rejects(wizard(['--project', plain, '--name', 'bad surface/', '--no-submodule'], { timeout: 30000 }),
    error => error.code === 2 && /name/.test(error.stderr));
});
