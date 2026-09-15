/* F159 (spec 144, spec 129): the record `runtime/windows.mjs` is judged against, and the harness its
 * replacement is judged by.
 *
 * What this store answers is where one team's findings land. A report addressed to the wrong side of
 * a project window is not a crash — it is an inbox that stays empty while the other team believes it
 * was told, which is exactly the failure this durable transport exists to prevent.
 *
 * The half that runs today replays the corpus against the live module and compares every answer, so
 * the record cannot drift from what it froze. When `windows.mjs` is deleted this file goes with it
 * (F173: a parity proof cannot outlive the side it compares against) and
 * `red_supervisor::windows`'s own replay of the same record becomes the whole of the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './window-store-corpus.mjs';

test('the recorded project-window answers are the ones the module gives', { timeout: 60000 }, async () => {
  assert.ok(RECORDED, 'window-store-corpus.json is present; it is the evidence, not a cache');
  assert.equal(RECORDED.cases.length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (let at = 0; at < CASES.length; at++) {
    assert.deepEqual(live.cases[at], RECORDED.cases[at], `${at}: ${CASES[at][0]}`);
  }
});

/* The rules the corpus exists to keep, asserted rather than left for a reader of the JSON to notice.
   A record is only evidence if somebody states what it is evidence OF. */
test('the record holds the addressing rule this store is for', () => {
  const of = name => RECORDED.cases.find(entry => entry.name === name)?.answer;

  /* A window links two roots and a report always goes to the OTHER one. */
  assert.equal(of('the origin reports to the project side').value.report.destinationRootId, 'root-project');
  assert.equal(of('the project side reports back to the origin').value.report.destinationRootId, 'root-origin');
  /* `fromProject` is the origin speaking AS the project it opened — so the sender is the project
     side, and the letter lands back in the origin's own inbox. Backwards here would deliver one
     team's findings to the other team. */
  const asProject = of('the origin may report AS the project it opened, and that lands back with the origin').value.report;
  assert.equal(asProject.senderRootId, 'root-project');
  assert.equal(asProject.destinationRootId, 'root-origin');
  assert.equal(asProject.reportedByRootId, 'root-origin', 'and who actually asked is still recorded');
  assert.equal(of('the project side may not report as the origin').status, 403);
  assert.equal(of('a root on neither side cannot report at all').status, 404);

  /* A retry key is a promise: the same letter or none, never a rewrite of one already read. */
  assert.equal(of('the same key and the same content is the same report, reused').value.reused, true);
  assert.equal(of('the same key and the same content is the same report, reused').value.report.sequence, 1,
    'and it is the FIRST report, not a second one with the same key');
  assert.equal(of('the same key with different content is refused rather than overwritten').status, 409);

  /* A listing is a menu; a layout is a document asked for by name. */
  assert.ok(of('the origin lists the windows it is on either side of').value.every(window => !('layout' in window)));
  assert.equal(of('a window with no layout yet answers null rather than a refusal').value, null);
  assert.equal(of('a root on neither side lists nothing').value.length, 0);

  /* An inbox cursor is a resume point, and hasMore is asked from the cursor rather than the cursor
     the caller sent — a client that paged to the end must not be told there is more. */
  const first = of('the project side reads what the origin sent it').value;
  assert.equal(first.cursor, first.reports.at(-1).sequence);
  assert.equal(first.hasMore, false);
  assert.equal(of('a cursor past the end is empty and keeps itself').value.cursor, 999);
  assert.equal(of('a cursor that is not a whole number is refused').status, 400);

  /* The bounds are bounds rather than a smaller box, which is the case that would go unnoticed. */
  assert.equal(of('the bounds themselves are allowed, so they are bounds and not a smaller box').value.reused, false);
});
