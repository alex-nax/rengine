/* F159 (spec 144, spec 129): the record `runtime/desktop.mjs` is judged against, and the harness its
 * replacement is judged by.
 *
 * What a desktop is launched with is a contract with the NATIVE side. Getting it wrong does not
 * crash: it produces a window that starts and is quietly bound to nothing, or that resumes an agent
 * nobody asked to resume. The absences carry as much as the values — an ordinary desktop has no
 * `RENGINE_WINDOW_ID` at all, while a desktop with no terminal has `RENGINE_INITIAL_TERMINAL=""` —
 * so the record is taken from a process that actually received the environment.
 *
 * This half runs while `desktop.mjs` does and goes with it (F173), leaving
 * `red_supervisor::desktop`'s own replay of the same record as the whole of the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './desktop-launch-corpus.mjs';

test('the recorded desktop launches are the ones the module performs', { timeout: 60000 }, async () => {
  assert.ok(RECORDED, 'desktop-launch-corpus.json is present; it is the evidence, not a cache');
  assert.equal(RECORDED.cases.length, CASES.length, 'every case has a recorded launch');
  const live = await answers();
  for (let at = 0; at < CASES.length; at++) {
    assert.deepEqual(live.cases[at], RECORDED.cases[at], `${at}: ${CASES[at][0]}`);
  }
});

test('the record holds the distinction a port would collapse', () => {
  const of = name => RECORDED.cases.find(entry => entry.name === name);
  const plain = of('a desktop on a project and nothing else');
  /* Absent and empty are different facts. A port writing "" for both would tell the native side
     this desktop IS a project window whose id happens to be blank. */
  assert.ok(plain.absent.includes('RENGINE_WINDOW_ID'));
  assert.equal(plain.env.RENGINE_INITIAL_TERMINAL, '');
  assert.ok(plain.absent.includes('RENGINE_RESUME_AGENT'), 'not resuming is an ABSENT variable, never "0"');
  assert.equal(of('a desktop opening onto an agent, resuming it').env.RENGINE_RESUME_AGENT, '1');
  assert.ok(of('a desktop opening onto an agent WITHOUT resuming it').absent.includes('RENGINE_RESUME_AGENT'));

  /* An empty workspace names a root that is the empty string — a choice the person has not made,
     not a missing field. */
  assert.equal(of('an empty workspace names no root at all').env.RENGINE_INITIAL_ROOT, '');

  /* A project window carries both halves of its identity. */
  const window = of('a project window carries its id and the title the store kept');
  assert.equal(window.env.RENGINE_WINDOW_ID, 'window-1');
  assert.equal(window.env.RENGINE_WINDOW_TITLE, 'Alpha');

  /* And the argument, which is how a window a person uses differs from one a test drives. */
  assert.deepEqual(plain.argv, ['--control']);
  assert.deepEqual(of('a desktop opened for inspection takes a different argument').argv, ['--automation']);
});
