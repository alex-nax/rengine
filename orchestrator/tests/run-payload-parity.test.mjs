/* F156 (spec 129): the Rust run payload is the one the record holds.
 *
 * `run-payload-record.test.mjs` is the other half — it proves the record is what the JavaScript
 * says. This one proves the replacement says the same thing: the argv a pane is started with, and
 * the two refusals a person sees when a declared action names something that is not there.
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
