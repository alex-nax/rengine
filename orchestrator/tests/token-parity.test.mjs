/* F157 (spec 132): the Rust ledger replays the recorded script and is judged against the record.
 *
 * The other half of this spec ran while `runtime/token.mjs` existed and proved the record was what
 * that ledger actually said; it went with the module, because a live half that replayed the
 * REPLACEMENT would be judging it against itself. What is left is the comparison — the replacement
 * says the same thing, step for step, and leaves the same two files behind — and the rules the
 * record exists to hold, asserted rather than left for a reader of the JSON to notice.
 *
 * The script is the one the record was made with, imported rather than copied: a second copy is a
 * second thing that can drift, and a drifted script would compare a replacement against answers to
 * different questions.
 *
 * What a failure here means is not a crash. It is that the one mechanism the workspace has for
 * keeping two agents out of each other's work changed a rule — a refusal reworded, a cooldown
 * charged to the wrong contest, a deadline re-timed, a holder that reads as gone because liveness
 * followed the process rather than the session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDED, ROOT, SCRIPT, STARTED_AT, WINDOW, mintOf } from './token-transcript.mjs';
import { built } from './cargo.mjs';

const REPLAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-token-replay');

/* Every id the script can reach for, computed by the recorder's own formula. The list is generous:
   an exhausted one would fall through to a real draw, and a drawn id is exactly the kind of drift
   this comparison exists to catch. */
const document = {
  rootId: ROOT,
  windowMs: WINDOW,
  startedAt: STARTED_AT,
  mints: Array.from({ length: 2 * SCRIPT.length }, (_, index) => mintOf(index + 1)),
  script: SCRIPT.map(([name, step]) => ({ name, step })),
};

function replay() {
  return new Promise((resolve, reject) => {
    const child = execFile(REPLAY, [], { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      error ? reject(new Error(`red-token-replay: ${stderr || error.message}`)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(document));
  });
}

test('the Rust ledger gives the recorded answers', { timeout: 180000 }, async () => {
  await built('-p', 'red-token', '--bin', 'red-token-replay');
  const live = await replay();
  assert.equal(live.steps.length, RECORDED.steps.length, 'every step is answered');
  for (const [index, step] of live.steps.entries()) {
    assert.deepEqual(step, RECORDED.steps[index], `${index}: ${RECORDED.steps[index].name}`);
  }
});

/* The files rather than the answers: a replacement that agreed step for step and left a different
   token.json would be one that agreed about everything except what happens next — the holder a
   replaced worker resumes and the sequence a monitor continues from live there, not in an answer. */
test('and leaves the same two files behind', { timeout: 180000 }, async () => {
  await built('-p', 'red-token', '--bin', 'red-token-replay');
  const live = await replay();
  assert.deepEqual(live.ledger, RECORDED.ledger, 'token.json');
  assert.deepEqual(live.feed, RECORDED.feed, 'feed.json');
  /* Key order too: both files are read back by JavaScript, and the record froze the bytes. */
  assert.equal(JSON.stringify(live.ledger), JSON.stringify(RECORDED.ledger), 'token.json, key for key');
  assert.equal(JSON.stringify(live.feed), JSON.stringify(RECORDED.feed), 'feed.json, key for key');
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

/* The two rules that had NO case until a sabotage of each passed: charging the contester a cooldown
   for an assign it did not ask for, and re-timing a running contest when the preference changes.
   Both were added to the script and re-recorded while the JavaScript still existed. */
test('including the two a sabotage walked through before they were recorded', () => {
  const step = name => RECORDED.steps.find(entry => entry.name === name);
  /* The desktop answering an open contest costs the contester nothing, so it may contest again at
     once — a cooldown here would refuse it instead. */
  assert.equal(step('the desktop assigns while a contest is open').ok.by, 'desktop');
  assert.equal(step('and charges the contester it answered nothing').ok.state, 'pending');
  /* The window a contest opened under travels with the contest: halving the preference leaves the
     running deadline alone, still charges the old window on a rejection, and applies to the next. */
  const open = step('the open contest keeps the deadline it was opened with').ok;
  assert.equal(open.window, 30000, 'the preference is the new one');
  assert.equal(open.contest.windowMs, 60000, 'and the contest still carries the one it opened under');
  assert.equal(open.contest.deadline, '2026-09-14T12:03:02.000Z', 'its deadline did not move');
  assert.equal(step('and rejecting it charges the window it ran on').ok.cooldownUntil, '2026-09-14T12:03:02.000Z');
  assert.equal(step('while the next contest opens on the new one').ok.deadline, '2026-09-14T12:02:32.000Z');
});
