import { bashPath } from './sessions-client.mjs';
import test, { before } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through a service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (tests/cargo.mjs). */
before(() => built('--bins'));

const execute = promisify(execFile), helper = path.resolve('orchestrator/actions/lib/wizard.sh');

/* Every module path a shell action names has to EXIST. `replace-host.sh` went on naming
 * `orchestrator/launch.mjs` for a day after that file was deleted, and the way it failed is why
 * this is a test rather than a reading: the action double-forks a detached child, so node's
 * "Cannot find module" went to a log nobody opens, the mark file was written by the python that
 * execs it, and the action printed "The launcher is detached as PID ..." and exited 0. A dashboard
 * action that reports success and replaces nothing is worse than one that fails.
 *
 * It is a scan rather than a run because these actions replace hosts and restart supervisors; what
 * can be checked without doing any of that is that what they point at is there. */
test('no shell action names a module that has been deleted', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directories = ['orchestrator/actions', 'scripts'];
  const dangling = [];
  for (const directory of directories) {
    for (const entry of await readdir(path.join(root, directory))) {
      if (!entry.endsWith('.sh')) continue;
      const file = path.join(directory, entry);
      const source = await readFile(path.join(root, file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('#')) continue;
        for (const named of line.match(/orchestrator\/[A-Za-z0-9/_-]+\.mjs/g) ?? []) {
          if (!existsSync(path.join(root, named))) dangling.push(`${file}:${index + 1} names ${named}`);
        }
      }
    }
  }
  assert.deepEqual(dangling, [], `a shell action points at a module that is not there:\n${dangling.join('\n')}`);
});

test('shell actions preserve literal argv and progress, and propagate failures', async () => {
  const literal = 'a path $(do-not-execute) `nor-this`';
  const good = await execute(bashPath(), ['-c', 'set -euo pipefail; source "$1"; re_wizard Demo 1; re_stage Read; re_run Reading printf "%s\\n" "$2"; re_finish', 'fixture', helper, literal]);
  assert.equal(good.stdout, literal + '\n'); assert.match(good.stderr, /\[1\/1\]/); assert.match(good.stderr, /Completed 1/); assert.ok(!good.stderr.includes('\x1b'));
  await assert.rejects(execute(bashPath(), ['-c', 'set -euo pipefail; source "$1"; re_wizard Demo 1; re_stage Fail; re_run Broken bash -c "exit 7"; re_finish', 'fixture', helper]), error => error.code === 7 && !error.stderr.includes('Completed') && error.stderr.includes('Failed (7)'));
});

test('missing noninteractive values and incomplete procedures fail promptly', async () => {
  await assert.rejects(execute(bashPath(), ['-c', 'source "$1"; re_ask RE_PROJECT Project </dev/null', 'fixture', helper], { timeout: 2000 }), error => error.code === 2 && /Supply an explicit argument/.test(error.stderr));
  await assert.rejects(execute(bashPath(), ['-c', 'source "$1"; re_wizard Demo 2; re_stage One; re_finish', 'fixture', helper]), error => error.code === 2 && /Incomplete/.test(error.stderr));
  await assert.rejects(execute(bashPath(), ['orchestrator/actions/project-window.sh', '--project'], { timeout: 2000 }), error => error.code === 2 && /Missing value/.test(error.stderr));
});

test('interactive wizard input hides secrets and Ctrl-C cancels without success', async () => {
  const { default: pty } = await import('node-pty');
  const prompt = async (secret, input) => new Promise((resolve, reject) => {
    const child = pty.spawn(bashPath(), ['-c', 'set -euo pipefail; trap "exit 130" INT; source "$1"; re_ask RE_VALUE "Fixture input" "$2"; printf "VALUE_RECEIVED\\n"', 'fixture', helper, secret ? 'true' : 'false'], { name: 'xterm-256color', cwd: process.cwd(), env: process.env });
    let output = '', sent = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Wizard prompt did not finish')); }, 3000);
    child.onData(data => { output += data; if (!sent && output.includes('Fixture input:')) { sent = true; setTimeout(() => child.write(input), 50); } });
    child.onExit(result => { clearTimeout(timer); resolve({ ...result, output }); });
  });
  const hidden = await prompt(true, 'fixture-secret-value\r');
  assert.equal(hidden.exitCode, 0); assert.match(hidden.output, /VALUE_RECEIVED/); assert.ok(!hidden.output.includes('fixture-secret-value'));
  const canceled = await prompt(false, '\x03');
  assert.equal(canceled.exitCode, 130); assert.ok(!canceled.output.includes('VALUE_RECEIVED'));
});
