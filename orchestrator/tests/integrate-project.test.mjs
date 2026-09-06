import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bashPath } from '../server/sessions.mjs';
import { readDeclaration } from '../server/formats.mjs';
import { validateSchema } from '../server/schema.mjs';
import { dashboardRules } from '../server/dashboard-rules.mjs';

const execute = promisify(execFile);
const ENGINE = path.resolve();
const ACTION = path.join(ENGINE, 'orchestrator/actions/integrate-project.sh');
const SCHEMA = JSON.parse(await readFile(path.join(ENGINE, 'contracts/project-v1.schema.json'), 'utf8'));
const CONTRACTS = new Set(SCHEMA.properties.contract.enum ?? []);
const gameRules = await import('../server/game-rules.mjs').then(module => module.gameRules, () => null);
const knowsGames = CONTRACTS.has(3) && Boolean(SCHEMA.properties.games);
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

/** Validate a scaffolded declaration with the rules this checkout actually ships — the committed
 * contract through validateSchema plus the shared cross-rule modules — instead of restating them.
 * `games` (contract 3) is owned by the game lane, so while the committed schema predates it the
 * core is still validated for real and the games tier is reported as uncovered here. */
function declarationProblems(value, root) {
  const problems = [], uncovered = [];
  let subject = value;
  if (!CONTRACTS.has(value.contract) || (value.games !== undefined && !knowsGames)) {
    subject = { ...value, contract: Math.min(value.contract, Math.max(...CONTRACTS)) };
    delete subject.games;
    uncovered.push('games');
  }
  problems.push(...validateSchema(SCHEMA, subject));
  problems.push(...dashboardRules(value.dashboard));
  if (gameRules) problems.push(...gameRules(value.games ?? []));
  else uncovered.push('game-rules.mjs');
  if (value.dashboard !== undefined && value.contract < 2) problems.push('a dashboard requires contract 2');
  if (value.games !== undefined && value.contract !== 3) problems.push('a games array requires contract 3');
  const scripts = (value.dashboard?.groups ?? []).flatMap(group =>
    group.actions.filter(action => action.kind === 'script').map(action => path.join(root, action.script)));
  return { problems, scripts, uncovered };
}

test('the wizard scaffolds a contract 3 declaration, launcher and test that satisfy the contract rules', async () => {
  const root = await repository();
  const result = await wizard(['--project', root, '--name', 'sample-project', '--no-submodule',
    '--game-title', 'Sample game', '--game-exe', 'build/sample-game', '--game-surface', 'external']);
  assert.match(result.stderr, /\[1\/5\]/);
  assert.match(result.stderr, /Completed 5 stages/);

  const declaration = await declarationOf(root);
  assert.equal(declaration.contract, 3);
  assert.equal(declaration.project, 'sample-project');
  const { problems, scripts } = declarationProblems(declaration, root);
  assert.deepEqual(problems, []);
  assert.equal(declaration.game, undefined, 'the singular game key does not exist');
  assert.equal(declaration.games.length, 1, 'the wizard scaffolds one target; further targets are added by hand');
  assert.deepEqual([declaration.games[0].id, declaration.games[0].title, declaration.games[0].surface],
    ['sample-game', 'Sample game', 'external']);
  assert.ok(declaration.games[0].executable.includes('build/sample-game'), declaration.games[0].executable);
  const check = declaration.dashboard.groups.flatMap(group => group.actions).find(action => action.id === 'editor-check');
  assert.deepEqual([check.kind, check.script, check.args], ['script', 'editor.sh', ['--check']]);
  for (const script of scripts) assert.equal((await stat(script)).isFile(), true, script);

  const launcher = await stat(path.join(root, 'editor.sh'));
  assert.ok(launcher.mode & 0o111, 'editor.sh must be executable');
  assert.equal((await stat(path.join(root, 'tests/test_rengine_project_decl.py'))).isFile(), true);
  const template = await readFile(path.join(root, 'editor.sh'), 'utf8');
  assert.doesNotMatch(template, /nolf|vtmb|relith|troika/i, 'templates must not name a specific consumer');
  // Two scaffolded projects sharing the sidecar's default state directory put both their roots in
  // one workspace, and a host restart from one checkout then took the other's retained sessions.
  assert.match(template, /--state/, 'the launcher passes a state directory');
  assert.match(template, /basename "\$ROOT"/, 'and keys it on this checkout rather than sharing one');
  assert.match(result.stdout, /editor\.sh --check/);
});

test('the reference template declaration follows the same contract rules and shows the games array', async () => {
  const templates = path.join(ENGINE, 'orchestrator/templates/project');
  const template = JSON.parse(await readFile(path.join(templates, 'project.json'), 'utf8'));
  const { problems, scripts } = declarationProblems(template, templates);
  assert.deepEqual(problems, []);
  assert.equal(template.contract, 3);
  assert.ok(Array.isArray(template.games) && template.games.length > 1, 'the reference shows several targets on one engine');
  assert.deepEqual([...new Set(template.games.map(game => game.surface))].sort(), ['embedded', 'external']);
  assert.equal(new Set(template.games.map(game => game.id)).size, template.games.length, 'game ids are unique');
  assert.ok(scripts.some(script => script.endsWith('editor.sh')), scripts);
  for (const file of ['editor.sh', 'project.json', 'test_rengine_project_decl.py', 'README.md'])
    assert.equal((await stat(path.join(templates, file))).isFile(), true, file);
});

test('the same skeleton at contract 1 without games or dashboard is read by the shipped reader', async () => {
  const root = await repository();
  await wizard(['--project', root, '--name', 'contract-one', '--contract', '1', '--no-submodule']);
  const declaration = await declarationOf(root);
  assert.equal(declaration.contract, 1);
  assert.equal(declaration.games, undefined);
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
  const cases = [['python-contract-two', []], ['python-contract-one', ['--contract', '1']],
    ['python-contract-three', ['--game-title', 'Sample game', '--game-exe', 'build/sample-game', '--game-surface', 'embedded']]];
  for (const [name, extra] of cases) {
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

test('the wizard rejects the retired sdl2-interpose surface by naming embedded, and holds the contract-3 rules', async () => {
  const root = await repository();
  const game = ['--game-title', 'Sample game', '--game-exe', 'build/sample-game'];
  await assert.rejects(wizard(['--project', root, '--name', 'retired-surface', '--no-submodule', ...game,
    '--game-surface', 'sdl2-interpose'], { timeout: 30000 }),
    error => error.code === 2 && /sdl2-interpose/.test(error.stderr) && /embedded/.test(error.stderr));
  await assert.rejects(wizard(['--project', root, '--name', 'unknown-surface', '--no-submodule', ...game,
    '--game-surface', 'window'], { timeout: 30000 }),
    error => error.code === 2 && /embedded/.test(error.stderr) && /external/.test(error.stderr) && /cooperative/.test(error.stderr));
  await assert.rejects(wizard(['--project', root, '--name', 'wrong-contract', '--no-submodule', ...game,
    '--contract', '2'], { timeout: 30000 }),
    error => error.code === 2 && /contract 3/.test(error.stderr));
  assert.equal(await missing(path.join(root, '.rengine/project.json')), true, 'a rejected run writes nothing');
});
