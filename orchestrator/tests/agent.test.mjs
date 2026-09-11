import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/agent.sh');
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project with spaces');
  const bin = path.join(dir, 'bin');
  await mkdir(project); await mkdir(bin);
  await writeFile(path.join(bin, 'codex'), '#!/bin/bash\nprintf "cwd=%s\\n" "$PWD"\nprintf "arg=%s\\n" "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RENGINE_AGENT_HOME: path.join(dir, 'managed') };
  return { dir, bin, project, env, run: args => spawnSync('bash', [script, '--project', project, ...args], { env, encoding: 'utf8', timeout: 10000 }) };
}

test('agent launcher preserves explicit cwd and literal custom arguments', async t => {
  const { project, run } = await fixture(t);
  const result = run(['--agent', 'codex', '--action', 'launch', '--', 'literal $(no-command)', 'two words']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`cwd=${project}`));
  assert.match(result.stdout, /arg=literal \$\(no-command\)/);
  assert.match(result.stdout, /arg=two words/);
});

test('update dispatch uses the installed agent and install failure cannot report success', async t => {
  const { bin, run } = await fixture(t);
  const updated = run(['--agent', 'codex', '--action', 'update']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /arg=update/);
  await writeFile(path.join(bin, 'npm'), '#!/bin/bash\nexit 37\n', { mode: 0o755 });
  const failed = run(['--agent', 'gemini', '--action', 'install']);
  assert.equal(failed.status, 37);
  assert.doesNotMatch(failed.stdout, /Installation verified/);
});

test('managed install is explicit, verified and discoverable without global package changes', async t => {
  const { dir, bin, run } = await fixture(t);
  await writeFile(path.join(bin, 'npm'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$@" > "$RENGINE_AGENT_HOME/npm-args"\nwhile [ "$1" != --prefix ]; do shift; done\nshift\nmkdir -p "$1/node_modules/.bin"\nprintf "#!/bin/bash\\nprintf managed-gemini\\n" > "$1/node_modules/.bin/gemini"\nchmod +x "$1/node_modules/.bin/gemini"\n', { mode: 0o755 });
  const installed = run(['--agent', 'gemini', '--action', 'install', '--version', '1.2.3']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installation verified/);
  const args = await readFile(path.join(dir, 'managed/npm-args'), 'utf8');
  assert.match(args, /@google\/gemini-cli@1\.2\.3/);
  assert.doesNotMatch(args, /--global/);
  assert.match(run(['--action', 'list']).stdout, /gemini\t.*managed/);
});

test('kimi is listed like the other four, installs from its npm package and updates through its own upgrade', async t => {
  const { dir, bin, run } = await fixture(t);
  assert.match(run(['--action', 'list']).stdout, /^kimi\t.+$/m, 'kimi appears in the launcher’s own listing, whatever this machine has installed');

  /* A kimi the person installed themselves is updated through the CLI's own subcommand. */
  await writeFile(path.join(bin, 'kimi'), '#!/bin/bash\nprintf "arg=%s\\n" "$@"\n', { mode: 0o755 });
  const updated = run(['--agent', 'kimi', '--action', 'update']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /arg=upgrade/);
  await rm(path.join(bin, 'kimi'));

  /* And a managed install names kimi's npm package and is discoverable afterwards. */
  await writeFile(path.join(bin, 'npm'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$@" > "$RENGINE_AGENT_HOME/npm-args"\nwhile [ "$1" != --prefix ]; do shift; done\nshift\nmkdir -p "$1/node_modules/.bin"\nprintf "#!/bin/bash\\nprintf managed-kimi\\n" > "$1/node_modules/.bin/kimi"\nchmod +x "$1/node_modules/.bin/kimi"\n', { mode: 0o755 });
  const installed = run(['--agent', 'kimi', '--action', 'install', '--version', '9.9.9']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installation verified/);
  assert.match(await readFile(path.join(dir, 'managed/npm-args'), 'utf8'), /@moonshot-ai\/kimi-code@9\.9\.9/);
  assert.match(run(['--action', 'list']).stdout, /kimi\t.*managed/);
});
