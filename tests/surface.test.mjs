/* The wire format's own suite, now that the format is Rust (spec 142).
 *
 * This file used to drive `server/surface-protocol.mjs` — a fragmented frame, and the input ranges.
 * That module is deleted, and both claims outlived it in two places: `red_core::surface`'s own
 * tests hold them against the implementation, and `surface-protocol-parity.test.mjs` holds them
 * against the ANSWERS the JavaScript gave, recorded before it went.
 *
 * What is left here is the one thing neither of those covers: that the record exists and still
 * describes the cases this file used to assert, so deleting the corpus cannot quietly delete the
 * evidence with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED } from './surface-protocol-fixtures.mjs';

test('the wire format\'s recorded answers still cover what this suite used to assert', () => {
  assert.ok(RECORDED, 'the record is present');
  const titles = new Set(CASES.map(([title]) => title));

  /* The fragmented frame: a decoder driven a byte at a time, which is the case a streaming decoder
     exists for. */
  assert.ok(titles.has('one small frame, a byte at a time'));
  assert.deepEqual(RECORDED['one small frame, a byte at a time'].frames.map(frame => frame.sequence), [7]);

  /* Every header bound, each refused on its own. */
  for (const title of ['a header whose magic is wrong', 'a width past the format', 'a height of zero',
    'a byte count that would allocate four gigabytes', 'a flag this format does not have']) {
    assert.ok(titles.has(title), title);
    assert.equal(RECORDED[title].refused, 'Invalid game frame header.', title);
  }

  /* And the input ranges, including the kind that does not exist and the value out of range. */
  assert.equal(RECORDED['a key down'].packet.length, 64, 'thirty-two bytes, as hex');
  assert.equal(RECORDED['a kind this format does not have'].refused, 'Unsupported game input.');
  assert.equal(RECORDED['a key past the top of its range'].refused, 'Game input is out of range.');
});
