/* F156 (spec 129): the Rust run payload is the one the record holds.
 *
 * The record was taken from `dashboard.mjs` while that module still built it (d8a05aa); this proves
 * the replacement says the same thing — the argv a pane is started with, and the refusals a person
 * sees when a declared action names something that is not there. The test that judged the record
 * against the JavaScript went with the JavaScript: that module is a thin client of this
 * implementation now, and asking it would be asking the replacement about itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, fixtureFor, fold } from './run-payload-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-project');
const BASH = '/bin/bash';

function ask(rootId, rootPath, actionId) {
  return new Promise(resolve => {
    execFile(BINARY, ['dashboard-run', rootId, rootPath, actionId, BASH], { maxBuffer: 1 << 26 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { resolve({ refused: { message: `red-project answered nothing: ${stdout}`, status: null } }); return; }
      resolve(value?.error !== undefined && value?.status !== undefined ? { refused: { message: value.error, status: value.status } } : { ok: value });
    });
  });
}

test('the Rust run payload is the recorded one', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'run-payload-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-run-payload-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, actionId] of CASES) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
    const root = await fixtureFor(directory, slug);
    const live = fold(await ask(`root-${slug}`, root, actionId), root, BASH);
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
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
