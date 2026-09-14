/* F161 (spec 102, spec 133): the Rust IDE bridge answers the recorded corpus.
 *
 * `ide-record.test.mjs` is the other half — it proves the record is what the JavaScript bridge
 * says. This one drives `red-ide serve` over stdio, the way `ide.mjs` will drive it, through the
 * same steps with the same raw WebSocket client, and compares every frame as text: the lock as
 * written, the sweep, the token gate, the SDK's answers and its silences, the retake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, SOURCES, answers } from './ide-corpus.mjs';
import { rustHarness } from './ide-serve-client.mjs';
import { built } from './cargo.mjs';

test('the Rust IDE bridge gives the recorded answers', { timeout: 600000 }, async () => {
  await built('-p', 'red-ide', '--bin', 'red-ide');
  assert.ok(RECORDED, 'ide-corpus.json is present');
  const harness = await rustHarness();
  let live;
  try { live = await answers(harness); } finally { await harness.finish(); }
  const drift = CASES.map(([name]) => name).filter(name => JSON.stringify(live[name]) !== JSON.stringify(RECORDED[name]));
  for (const name of drift) assert.deepEqual(live[name], RECORDED[name], name);
  assert.deepEqual(drift, [], 'every case answers as recorded');
});

test('a source that is not there is asked nothing', async () => {
  assert.equal(SOURCES.none, null, 'the corpus names a bridge with no source, and the harness starts it without asks');
});
