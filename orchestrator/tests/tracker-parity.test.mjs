/* F153 (spec 129): the Rust local tracker answers the recorded corpus.
 *
 * `tracker-record.test.mjs` is the other half — it proves the record is what the JavaScript says.
 * The remote providers are deliberately absent from both: they need a network client, and F154 owns
 * that decision. What is compared here is the backend this repository itself uses, and the tests
 * manifest joined onto it — including the one claim a reader must never make quietly, that a green
 * run proves anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, PARSER_WORDED, RECORDED, fixtureFor, rootIdFor } from './tracker-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-project');

function ask(rootId, rootPath, declared) {
  return new Promise((resolve, reject) => {
    const child = execFile(BINARY, ['tracker', rootId, rootPath], { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      error ? reject(new Error(`red-project tracker: ${stderr || error.message}`)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ declared }));
  });
}

test('the Rust local tracker gives the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'tracker-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-tracker-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const root = await fixtureFor(directory, name, options);
    const live = { ...await ask(rootIdFor(name), root, options.declared), rootId: '<rootId>' };
    const expected = RECORDED[name];
    /* The one answer whose wording belongs to whichever runtime read the file: V8 says one thing
       and serde another for a document that will not parse. The reader is held to the prefix — the
       half a person reads — and everything around it is compared exactly. */
    if (name === PARSER_WORDED) {
      assert.match(live.invalid[0], /^features\.json: /, name);
      assert.deepEqual({ ...live, invalid: null }, { ...expected, invalid: null }, name);
      continue;
    }
    if (JSON.stringify(live) !== JSON.stringify(expected)) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
});
