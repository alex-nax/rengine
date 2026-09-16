/* F159 (spec 144, spec 098): the record `launcher/replace.mjs` is judged against, and the harness
 * its replacement is judged by.
 *
 * What this module decides is which process gets a SIGTERM, from a descriptor that names a pid and a
 * `ps` table that may have recycled it. Getting one of its refusals wrong does not produce a wrong
 * answer — it stops somebody else's work, or it stops the terminal the command was typed in.
 *
 * This half runs while `replace.mjs` does and goes with it (F173), leaving
 * `red_supervisor::replace`'s own replay of the same record as the whole of the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './replace-host-corpus.mjs';

test('the recorded process-table answers are the ones the module gives', { timeout: 30000 }, async () => {
  assert.ok(RECORDED, 'replace-host-corpus.json is present; it is the evidence, not a cache');
  assert.equal(RECORDED.cases.length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (let at = 0; at < CASES.length; at++) {
    assert.deepEqual(live.cases[at], RECORDED.cases[at], `${at}: ${CASES[at][0]}`);
  }
});

test('the record holds the refusals that are refusals to SIGNAL', () => {
  const of = name => RECORDED.cases.find(entry => entry.name === name)?.answer;

  /* A pid is recycled in minutes. These two are the whole reason the descriptor is not trusted. */
  assert.match(of('a pid that is alive but is not a host is refused by name').refused,
    /is not a session host: .*Nothing was signalled\.$/);
  assert.match(of('a host serving ANOTHER directory is refused by name').refused,
    /is the session host of .*, not .*\. Nothing was signalled\.$/);

  /* And the two that are not refusals: a descriptor whose process is gone is stale rather than
     wrong, and a directory with no descriptor has nothing to replace. */
  assert.equal(of('a descriptor naming a pid that is gone is stale').value.stale, true);
  assert.equal(of('no descriptor at all is nothing to replace').value.descriptor, null);

  /* A state directory with a space in its name is ONE directory. A split on whitespace makes it
     two, and the second one is a host serving somewhere else. */
  assert.equal(of('a session host names the directory it serves').value.stateDir, '/home/x/My Workspaces/with space');

  /* A pane's ancestry is walked to the top, not to its parent: an agent CLI is three levels below
     the host it would be replacing. */
  assert.deepEqual(of('a pane deep inside a host knows its ancestors').value, [12342, 12336, 68944, 1]);
  assert.equal(of('a launcher inside the workspace is recognised').value, true);

  /* Both supervisor spellings, because a workspace started before the port still runs the module. */
  assert.equal(of('the JavaScript supervisor is one').value, true);
  assert.equal(of('the binary is one').value, true);
  assert.equal(of('a worker under it is not').value, false);

  /* The report is read by a person deciding whether their editor is about to vanish. Since charter
     D60 the sessions are HANDED OVER rather than ended, and the retained services are named with
     the reason they are not the host's to stop. */
  const full = of('a replacement that stopped a host, its supervisor and its children').value;
  assert.match(full, /handed 2 running session\(s\) to the next host:/);
  assert.match(full, /left the pty service running \(PID 10282\): it belongs to .*, not to a host/);
  assert.match(full, /left the store service running \(PID 10280\)/);
  assert.match(of('a replacement with nothing running').value, /no running sessions to hand over/);
  assert.match(of('a host that would not say what it was holding').value, /note: the host did not answer/);
});
