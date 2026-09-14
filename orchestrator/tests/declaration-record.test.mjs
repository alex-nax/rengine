/* F156b (spec 129, KI-107): the record `formats.mjs`'s declaration reader is judged against, and
 * the harness its replacement will be judged by.
 *
 * `readDeclaration` is the keystone of the remaining JS host: `dashboard.mjs`, `devices.mjs`,
 * `games.mjs` and `tracker.mjs` all read a project through it, and what it answers — including
 * every refusal, word for word — is what a person sees in the chrome when their project will not
 * load. A replacement cannot be compared against a module that no longer exists, so the module's
 * own answers are recorded while it is still here (`declaration-fixtures.json`) and the Rust side
 * is judged against the record afterwards. This spec is the half that runs today: it proves the
 * record is what the module actually says, so the record cannot drift from the thing it froze.
 *
 * The corpus is deliberately about the JUDGEMENTS rather than the happy path: a contract floor for
 * each key that has one, both halves of the icon's exactly-one rule, artwork that is absolute, not
 * an svg, or missing, a tracker wearing another provider's keys, and a pack with no facet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './declaration-fixtures.mjs';

test('the recorded declaration answers are the ones the reader gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'declaration-fixtures.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) {
    assert.deepEqual(live[name], RECORDED[name], name);
  }
});

/* The two properties the corpus exists to keep honest, asserted rather than left to a reader of the
   JSON: a declaration that cannot be read is REPORTED rather than thrown, and a block's problem
   disables that block alone. */
test('a bad declaration is reported, and a bad block does not take the formats with it', () => {
  for (const [name, answer] of Object.entries(RECORDED)) {
    assert.equal(typeof answer, 'object', name);
    if (answer.error !== undefined) {
      assert.match(answer.error, /^\.rengine\/project\.json: /, `${name} names the source it is refusing`);
      assert.deepEqual(answer.formats, [], `${name} answers no formats when the document itself is refused`);
    }
  }
  const blocked = RECORDED['a github tracker with no repository'];
  assert.match(blocked.trackerError, /requires repository for provider github/);
  assert.equal(blocked.formats.length, 1, 'a tracker problem leaves the formats alone');
  assert.equal(RECORDED['a wordmark whose dark half is missing'].wordmark.lightFile, '<root>/light.svg',
    'and artwork that resolved is still handed over when its sibling did not');
});
