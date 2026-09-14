/* F156 (spec 129): the record a dashboard action's terminal payload is judged against.
 *
 * Pressing a script or a log action opens a PANE, and this is the argv, environment and title it is
 * started with — a contract with the session host on the other side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './run-payload-corpus.mjs';

test('the recorded run payloads are the ones the module builds', { timeout: 180000 }, async () => {
  assert.ok(RECORDED, 'run-payload-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

test('the corpus holds the rules a run payload is bounded by', () => {
  const of = name => RECORDED[name];

  /* A script is run THROUGH bash with the resolved absolute path, and its declared args and env are
     literal — the session host is handed argv, never a command line to re-parse. */
  const plain = of('a script action').ok;
  assert.equal(plain.command, '<bash>');
  assert.deepEqual(plain.args, ['<root>/hello.sh']);
  assert.equal(plain.title, 'Script · hello.sh', 'the title names the script, not the action');
  const armed = of('a script action with arguments and an environment').ok;
  assert.deepEqual(armed.args, ['<root>/hello.sh', '--fast', 'two']);
  assert.deepEqual(armed.env, { BUILD_TYPE: 'RELEASE' });

  /* A log action is its own argv, with no shell and no declared environment. */
  const log = of('a log action').ok;
  assert.equal(log.command, '/bin/echo');
  assert.deepEqual(log.args, ['LOG_LINE']);
  assert.deepEqual(log.env, {});
  assert.equal(log.title, 'Log · Log stream', 'the title names the action, because a log has no script');

  /* The script is confined like every declared path, and what it resolves to must be a file. */
  assert.match(of('a script action naming a file that is not there').refused.message, /^ENOENT: no such file or directory, realpath /);
  assert.equal(of('a script action naming a file that is not there').refused.status, null);
  assert.equal(of('a script action naming a directory').refused.message, 'Dashboard script is not a file.');
  assert.equal(of('a script action naming a path that leaves the project').refused.status, 403);

  /* The two kinds that are not terminals say where they go instead, rather than becoming one. */
  assert.equal(of('a capture action').refused.message, 'Capture actions run through dashboard-capture.');
  assert.equal(of('a game action').refused.message, 'Game actions run through the project game route.');
});
