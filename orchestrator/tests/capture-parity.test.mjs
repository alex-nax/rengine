/* F156 (spec 129): the Rust capture answers the recorded corpus, and lands what the record says.
 *
 * `capture-record.test.mjs` is the other half — it proves the record is what the JavaScript says.
 * This one proves the replacement says the same thing AND writes the same thing: a capture is the
 * one dashboard action that changes the project, so what is on disk afterwards is half the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, fixtureFor, fold, landed } from './capture-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-project');

function ask(rootId, rootPath, actionId) {
  return new Promise(resolve => {
    execFile(BINARY, ['dashboard-capture', rootId, rootPath, actionId ?? ''], { maxBuffer: 1 << 26 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { resolve({ refused: { message: `red-project answered nothing: ${stdout}`, status: null } }); return; }
      resolve(value?.error !== undefined && value?.status !== undefined ? { refused: { message: value.error, status: value.status } } : { ok: value });
    });
  });
}

test('the Rust capture gives the recorded answers and lands the recorded files', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'capture-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-capture-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
    const root = await fixtureFor(directory, name, options);
    if (options.twice) await ask(`root-${slug}`, root, options.action);
    let live = await ask(`root-${slug}`, root, options.action);
    if (live.refused) live = { refused: { ...live.refused, message: live.refused.message.split(root).join('<root>') } };
    live = { ...fold(live), landed: fold(await landed(root)) };
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers and writes as recorded');
});
