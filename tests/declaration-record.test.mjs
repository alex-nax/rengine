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
import { CASES, PARSER_WORDED, RECORDED, answers } from './declaration-fixtures.mjs';

/* An unknown contract is refused by NAME and the supported set is enumerated in the reader's own
   sentence — that is the rule, and it is what the record holds. The list itself is the SCHEMA's
   data: a contract added to `project-v1.schema.json` moves it, as spec 134's worktrees block did
   when it raised the ceiling to 11. So the enumeration is folded on both sides, the way this
   corpus already folds the JSON parser's own phrasing, and what stays compared is the sentence. */
const contractsFolded = answer => (typeof answer?.error !== 'string' ? answer
  : { ...answer, error: answer.error.replace(/(supports contracts ).*/, '$1<contracts>') });

test('the recorded declaration answers are the ones the reader gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'declaration-fixtures.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) {
    /* The one answer whose parenthetical is the JSON parser's rather than this workspace's: V8 says
       one thing and serde another, so the reader is held to the prefix — which is the half a person
       reads — and not to a runtime's phrasing. Everything else is compared exactly. */
    if (name === PARSER_WORDED) {
      assert.match(live[name].error, /^\.rengine\/project\.json: invalid JSON \(/, name);
      assert.deepEqual({ ...live[name], error: null }, { ...RECORDED[name], error: null }, name);
      continue;
    }
    assert.deepEqual(contractsFolded(live[name]), contractsFolded(RECORDED[name]), name);
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
