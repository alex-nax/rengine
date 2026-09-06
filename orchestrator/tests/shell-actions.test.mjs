import { bashPath } from '../server/sessions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const execute = promisify(execFile), helper = path.resolve('orchestrator/actions/lib/wizard.sh');

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
