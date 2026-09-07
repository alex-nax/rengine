import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installExternalProject } from '../external-project.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'redit-install-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project ' & $literal `name`"); await mkdir(project);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'echo test', dev: 'echo dev', deploy: 'echo never' } }));
  return { project, profile: path.join(dir, "profile ' & $literal `name`"), launcher: path.join(dir, 'open project.command'), state: path.join(dir, 'state'), title: 'Fixture' };
}

test('external installer keeps the project untouched and quotes launcher paths literally', async t => {
  const options = await fixture(t);
  await installExternalProject({ ...options, dryRun: true });
  await assert.rejects(readFile(options.launcher), { code: 'ENOENT' });
  await assert.rejects(installExternalProject({ ...options, title: '' }), /shorter/);
  await assert.rejects(readFile(options.launcher), { code: 'ENOENT' });
  const installed = await installExternalProject(options);
  await run('/bin/bash', ['-n', installed.launcher]);
  const help = await run('/bin/bash', [installed.launcher, '--help']);
  assert.match(help.stdout, /external project.json/);
  const declaration = JSON.parse(await readFile(installed.declarationFile, 'utf8'));
  const actions = declaration.dashboard.groups.flatMap(group => group.actions);
  assert.deepEqual(actions.map(a => a.id), ['status', 'scripts', 'dev', 'test']);
  assert.deepEqual(actions[1].command, [process.execPath, path.join(options.profile, 'commands.mjs'), 'scripts']);
  const scripts = await run(actions[1].command[0], actions[1].command.slice(1), { cwd: options.project });
  assert.match(scripts.stdout, /fixture/); assert.match(scripts.stdout, /deploy\n  echo never/);
  await assert.rejects(run(process.execPath, [path.join(options.profile, 'commands.mjs'), 'deploy'], { cwd: options.project }), /Unknown external action/);
  await assert.rejects(run('/bin/bash', [installed.launcher, '--project', '/tmp']), /bound to its installed project/);
  await assert.rejects(run('/bin/bash', [installed.launcher, '--unknown']), /Unknown option/);
  assert.deepEqual(await readdir(options.project), ['package.json']);
  await installExternalProject(options);
  await writeFile(installed.declarationFile, 'owner edit');
  await assert.rejects(installExternalProject(options), /Refusing to overwrite/);
  assert.equal(await readFile(installed.declarationFile, 'utf8'), 'owner edit');
});

test('external installer refuses writes within the consumer including symlink destinations', async t => {
  const options = await fixture(t);
  for (const key of ['profile', 'launcher', 'state']) {
    await assert.rejects(installExternalProject({ ...options, [key]: path.join(options.project, key) }), /outside the project/);
  }
  await symlink(options.project, options.profile, 'dir');
  await assert.rejects(installExternalProject(options), /outside the project/);
  assert.deepEqual(await readdir(options.project), ['package.json']);
});
