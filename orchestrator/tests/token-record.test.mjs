/* F157 (spec 132): the record the project token ledger is judged against, and the harness its
 * replacement will be judged by.
 *
 * This ledger is what stops two agents writing over each other's work, so its failure mode is not a
 * crash but a rule that quietly changed: a refusal whose wording moved, a cooldown charged to the
 * wrong contest, a deadline that re-times when a preference changes, a holder that reads as gone
 * because liveness followed the process rather than the session. None of those break anything
 * visibly, and all of them are in this transcript.
 *
 * The half that runs today replays the script against the live ledger and compares every answer,
 * every status and both files it leaves behind — so the record cannot drift from what it froze.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECORDED, SCRIPT, transcript } from './token-transcript.mjs';

test('the recorded ledger transcript is the one the ledger gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'token-transcript.json is present; it is the evidence, not a cache');
  assert.equal(RECORDED.steps.length, SCRIPT.length, 'every step has a recorded answer');
  const live = await transcript();
  for (const [index, step] of live.steps.entries()) {
    assert.deepEqual(step, RECORDED.steps[index], `${index}: ${step.name}`);
  }
  /* The two files a replaced worker reads: the ledger it resumes and the ring a monitor continues
     from. A transcript that matched step for step and left a different file behind would be a
     ledger that agreed about everything except what happens next. */
  assert.deepEqual(live.ledger, RECORDED.ledger, 'the ledger on disk');
  assert.deepEqual(live.feed, RECORDED.feed, 'the feed on disk');
});

/* The properties the transcript exists to keep, asserted rather than left for a reader of the JSON
   to notice. */
test('the transcript holds the rules a ledger is for', () => {
  const step = name => RECORDED.steps.find(entry => entry.name === name);
  assert.match(step('a third agent is refused while one is open').refused.message, /already has a contest open until/);
  assert.equal(step('a third agent is refused while one is open').refused.status, 409);
  assert.match(step('the rejected agent is in cooldown').refused.message, /cannot contest again until/);
  /* A deadline is an absolute wall time: the clock passes it with nobody watching, and the next
     read settles it rather than a timer having had to fire. */
  assert.equal(step('a read that settles nothing still shows the old holder').ok.holder.label, 'claude aaaa');
  const transferred = step('and the token transfers when anything settles');
  assert.equal(transferred.status.holder.label, 'codex bbbb');
  assert.equal(transferred.status.contest, null);
  /* A release under an open contest answers that contest rather than leaving a free token the
     contester would wait a whole window for. */
  assert.equal(step('and the holder letting go').ok.state, 'claimed');
  assert.equal(step('and the holder letting go').ok.by, 'release');
  /* The person at the desktop is never gated, and an assign the desktop makes charges the contester
     nothing — it did nothing wrong. */
  assert.equal(step('the desktop assigns to an agent it has seen').ok.by, 'desktop');
  assert.equal(step('but not to one it has not').refused.status, 404);
  /* A holder whose process left is not holding, and the claim says which kind of claim it was. */
  assert.equal(step('so the next contest claims it outright').ok.by, 'holder-gone');
  /* Identity is the session, not the process: a holder that came back under a new pid still holds,
     so the next contester opens a window rather than claiming a token it thinks nobody has. */
  assert.equal(step('the same session comes back under a new process').ok.state, 'held');
  assert.equal(step('so another agent opens a contest rather than claiming it').ok.state, 'pending');
  /* And the refusal a tool shows names the holder, the window and what to call. */
  assert.match(step('the refusal a tool shows while another holds it').ok.refusal, /task_add needs it. Nothing was attempted. Call token_contest/);
  assert.match(step('reads differently').ok.refusal, /free, and task_add needs it/);
});
