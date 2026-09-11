import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/* The guided hook bootstrap (docs/specs/127-kimi-agent-integration.md, decision 6): the one edit
   rEngine ever offers to make to a person's global agent configuration, and only on explicit
   request — shown, confirmed, backed up, doctor-verified and restored on failure. The tests run
   against a fake kimi on PATH and a throwaway KIMI_CODE_HOME; no real configuration is touched. */
const script = path.resolve('orchestrator/actions/bootstrap-agent-hooks.sh');

async function fixture(t, { doctor = 0, config } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'kimi-home');
  await mkdir(bin);
  await mkdir(home);
  await writeFile(path.join(bin, 'kimi'), `#!/bin/bash
case "\${1:-}" in
  --version) printf 'kimi 0.30.0\\n';;
  doctor) exit ${doctor};;
  *) exit 0;;
esac
`, { mode: 0o755 });
  if (config !== undefined) await writeFile(path.join(home, 'config.toml'), config);
  /* PATH is masked to the fixture's bin plus the system directories: the real kimi installed on
     this machine must not leak in, and the script's node comes from RENGINE_NODE explicitly. */
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, KIMI_CODE_HOME: home, RENGINE_NODE: process.execPath };
  return { dir, home, env, run: args => spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: 10000, input: '' }) };
}

const HOOK = /# rEngine session reporting.*\[\[hooks\]\]\nevent = "SessionStart"\ncommand = '.*report-session\.mjs.*--provider kimi'/s;

test('the bootstrap appends one marked hook block, preserving what was there, and is idempotent', async t => {
  const original = 'default_model = "kimi-code/kimi-for-coding"\n';
  const { home, run } = await fixture(t, { config: original });

  const first = run(['--agent', 'kimi', '--yes']);
  assert.equal(first.status, 0, first.stderr);
  const written = await readFile(path.join(home, 'config.toml'), 'utf8');
  assert.ok(written.startsWith(original), 'the person’s own configuration is preserved verbatim');
  assert.match(written, HOOK, 'and the marked block names the reporter with kimi’s provider');
  const backups = (await readdir(home)).filter(name => name.startsWith('config.toml.rengine-backup-'));
  assert.equal(backups.length, 1, 'the original was backed up first');
  assert.equal(await readFile(path.join(home, backups[0]), 'utf8'), original);

  const second = run(['--agent', 'kimi', '--yes']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout + second.stderr, /already bootstrapped/i, 'a second run says so');
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), written, 'and changes nothing');
  assert.equal((await readdir(home)).filter(name => name.startsWith('config.toml.rengine-backup-')).length, 1, 'and makes no second backup');
});

test('a config that does not exist yet is created', async t => {
  const { home, run } = await fixture(t);
  const created = run(['--agent', 'kimi', '--yes']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(await readFile(path.join(home, 'config.toml'), 'utf8'), HOOK);
  assert.equal((await readdir(home)).filter(name => name.startsWith('config.toml.rengine-backup-')).length, 0,
    'nothing existed, so nothing needed backing up');
});

test('doctor rejecting the write restores the previous configuration byte for byte', async t => {
  const original = 'default_model = "kimi-code/kimi-for-coding"\n';
  const { home, run } = await fixture(t, { doctor: 1, config: original });
  const failed = run(['--agent', 'kimi', '--yes']);
  assert.notEqual(failed.status, 0, 'a verification failure is a failure, not a half-installed hook');
  assert.match(failed.stderr + failed.stdout, /restor/i, 'and the failure is the script’s own verify-and-restore path');
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), original, 'and the person’s file is back exactly as it was');

  /* The same guard removes a config it created this run rather than leaving a half-written one. */
  const fresh = await fixture(t, { doctor: 1 });
  const failedCreate = fresh.run(['--agent', 'kimi', '--yes']);
  assert.notEqual(failedCreate.status, 0);
  assert.match(failedCreate.stderr + failedCreate.stdout, /restor/i);
  assert.deepEqual(await readdir(fresh.home), [], 'a config created this run is removed again when verification fails');
});

test('the change is shown and confirmed: --dry-run writes nothing, and without --yes a non-terminal is refused', async t => {
  const { home, run } = await fixture(t);
  const dry = run(['--agent', 'kimi', '--yes', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout + dry.stderr, /SessionStart/, 'the dry run still shows the exact change');
  assert.deepEqual(await readdir(home), [], 'and wrote nothing');

  const unconfirmed = run(['--agent', 'kimi']);
  assert.equal(unconfirmed.status, 2, 'a missing confirmation in a non-terminal stops the write');
  assert.match(unconfirmed.stderr, /confirmation/i);
  assert.deepEqual(await readdir(home), [], 'so nothing was written');
});

test('only kimi is bootstrapped: the other CLIs are refused by name with the reason', async t => {
  const { home, run } = await fixture(t);
  const claude = run(['--agent', 'claude']);
  assert.equal(claude.status, 2);
  assert.match(claude.stderr, /per-launch settings/i, 'claude already gets its hook from the launcher');
  const gemini = run(['--agent', 'gemini']);
  assert.equal(gemini.status, 2);
  assert.match(gemini.stderr, /no hook channel/i);
  assert.deepEqual(await readdir(home), [], 'refusals write nothing');
});

test('a missing CLI stops before anything is written, naming the install path', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-hooks-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'kimi-home');
  await mkdir(home);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, KIMI_CODE_HOME: home, RENGINE_NODE: process.execPath };
  await mkdir(path.join(dir, 'bin'));
  const result = spawnSync('bash', [script, '--agent', 'kimi', '--yes'], { env, encoding: 'utf8', timeout: 10000, input: '' });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /kimi is not installed/);
  assert.deepEqual(await readdir(home), []);
});
