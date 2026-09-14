/* F161 (F103, spec 133): Rust editor discovery answers the recorded corpus.
 *
 * `ide-connect-record.test.mjs` is the other half — it proves the record is what the JavaScript
 * decides. This one asks `red-ide offered` and `red-ide auto-connect` the same questions with the
 * same locks on disk, and compares: which editors, which one is ours, and every sentence a pane
 * prints at startup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './ide-connect-corpus.mjs';
import { rustHarness } from './ide-connect-client.mjs';
import { built } from './cargo.mjs';

test('Rust editor discovery gives the recorded answers', { timeout: 300000 }, async () => {
  await built('-p', 'red-ide', '--bin', 'red-ide');
  assert.ok(RECORDED, 'ide-connect-corpus.json is present');
  const live = await answers(rustHarness);
  const drift = CASES.map(([name]) => name).filter(name => JSON.stringify(live[name]) !== JSON.stringify(RECORDED[name]));
  for (const name of drift) assert.deepEqual(live[name], RECORDED[name], name);
  assert.deepEqual(drift, [], 'every case answers as recorded');
});
