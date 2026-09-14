/* F153 (specs 100, 116, 117): the record `tracker.mjs`'s local half is judged against.
 *
 * This replays the corpus through the module as a caller reaches it — which since F153 is the
 * client, the binary and `red_project::tracker` together, one layer more than `tracker-parity`
 * drives. The remote providers are deliberately absent: they need a network client, and F154 owns
 * that decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, PARSER_WORDED, RECORDED, answers } from './tracker-corpus.mjs';

test('the recorded local tracker answers are the ones the module gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'tracker-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) {
    /* The one answer whose parenthetical belongs to whichever runtime read the file: V8 says one
       thing and serde another for a document that will not parse. Since F153 the reader is Rust,
       so the module is held to the prefix — the half a person reads — and everything around it is
       compared exactly. */
    if (name === PARSER_WORDED) {
      assert.match(live[name].invalid[0], /^features\.json: /, name);
      assert.deepEqual({ ...live[name], invalid: null }, { ...RECORDED[name], invalid: null }, name);
      continue;
    }
    assert.deepEqual(live[name], RECORDED[name], name);
  }
});

test('the corpus holds the rules a task inventory is read by', () => {
  const of = name => RECORDED[name];
  /* A project that declares nothing at all still has its own inventory if it keeps one. */
  assert.equal(of('no declaration at all').provider, 'local');
  assert.equal(of('no declaration at all').rows.length, 2);
  /* Readiness follows features.py, so the tab and the command line cannot disagree. */
  const readiness = Object.fromEntries(of('readiness: passing, blocked and ready').rows.map(row => [row.key, row.state.name]));
  assert.deepEqual(readiness, { F1: 'passing', F2: 'ready', F3: 'blocked', F4: 'ready' });
  /* State is (id, name, category) and never a boolean. */
  assert.deepEqual(of('readiness: passing, blocked and ready').rows[2].state, { id: 'blocked', name: 'blocked', category: 'blocked' });
  assert.deepEqual(of('no declaration at all').categories, ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'blocked']);
  /* A missing inventory is a named absence, not an empty list that looks like an empty project. */
  assert.match(of('an inventory this project does not have').unavailable, /features\.json is not in this project\.$/);
  assert.deepEqual(of('an inventory this project does not have').rows, []);

  /* The tests manifest: read, never run. */
  assert.match(of('a declared manifest this project does not have').testsError, /the declared tests manifest is not in this project\.$/);
  assert.match(of('a manifest the schema refuses').testsError, /\$\.entries\[0\] requires test/);
  /* THE field the format exists for: a green run says a command went green, and only a sabotage row
     says the test can go red for its own reason (AGENTS.md). Never collapsed into one word. */
  const proven = of('an entry with a sabotage is proven, and one without is not').rows[0].tests;
  assert.equal(proven.length, 2);
  assert.equal(proven[0].proven, true, 'the entry that recorded a sabotage');
  assert.equal(proven[1].proven, false, 'and the one that only ran green');
  /* A claim pointing past the task's criteria reads as coverage it does not have. */
  assert.match(of('a claim past the task’s own criteria').testsError, /F2 claims criterion 9, but the task has 2 criterions$/);
  /* An artifact is answered for here rather than when someone clicks it. */
  const artifacts = of('artifacts that are there, missing and outside the project').rows[0].tests[0].last.artifacts;
  assert.deepEqual(artifacts.map(item => item.state), ['ok', 'missing', 'outside']);
  assert.match(of('artifacts that are there, missing and outside the project').testsError, /is outside this project$/);
  /* And whether the manifest describes the checkout in front of the reader. */
  assert.equal(of('a manifest joined onto the rows it names').tests.current, true);
  assert.equal(of('a manifest whose commit is not this checkout').tests.current, false);
  assert.equal(of('a manifest with no commit at all').tests.current, null, 'unknown, rather than a guess either way');
});
