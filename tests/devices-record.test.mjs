/* F155 (spec 129, KI-107): the record `devices.mjs` and `dashboard.mjs` are judged against, and the
 * harness their replacement will be judged by.
 *
 * What these two modules answer is what a person sees in the Devices tab and on every dashboard
 * button: whether a box is reachable, and if not, in whose words; whether an action may be pressed,
 * and which half of its availability failed. None of that is a crash when it goes wrong — it is a
 * button that is grey for a reason nobody stated, or worse, one that is green for a device that is
 * not there.
 *
 * The half that runs today replays the corpus against the live modules and compares every answer,
 * so the record cannot drift from what it froze.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './devices-corpus.mjs';

test('the recorded device and dashboard answers are the ones the modules give', { timeout: 180000 }, async () => {
  assert.ok(RECORDED, 'devices-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

/* The properties the corpus exists to keep, asserted rather than left for a reader of the JSON to
   notice. Each is a rule with a sidecar entry behind it. */
test('the corpus holds the rules these two modules are for', () => {
  const of = name => RECORDED[name];
  /* The implicit local device is always offered, so a consumer never has to declare it to bind. */
  assert.deepEqual(of('a declaration with no devices block').devices.devices.map(d => d.id), ['local']);
  assert.equal(of('a declaration with no devices block').devices.devices[0].declared, false,
    'and it says it was not declared, so a chooser can tell it from a real record');
  assert.equal(of('a declared local device wins its own title').devices.devices[0].title, 'The workstation');

  /* A probe is reachability, never launchability, and a failure carries the box's own first line. */
  const silent = of('a remote device that refuses, with only its first stderr line').devices.devices[1];
  assert.equal(silent.reachable, false);
  assert.equal(silent.issues.length, 1, 'one sentence, not every line the probe printed');
  assert.match(silent.issues[0], /Silent box \(silent-box\) is not reachable: the probe failed \(exit 7\): fixture: the box is not answering\.$/);
  assert.match(of('a remote device whose probe hangs past its own timeout').devices.devices[1].issues[0], /the probe timed out after 400 ms/);

  /* requires and tools are local by definition even on a remote device, and are checked FIRST:
     there is no point probing an ssh box when ssh is not installed. */
  const gated = of('a device whose requires and tools are missing here');
  assert.equal(gated.probes, 0, 'nothing was probed for a device whose prerequisites are absent');
  assert.equal(gated.devices.devices[1].issues.length, 2, 'and both prerequisites are named');

  /* value or env: an env that is unset or empty is a named reason, never a spawn with an empty
     argument and never one with the placeholder left in. */
  assert.match(of('a placeholder whose environment variable is unset').devices.devices[1].issues[0], /RENGINE_FIXTURE_SERIAL is not set in the workspace environment/);
  assert.match(of('a placeholder whose environment variable is empty').devices.devices[1].issues[0], /RENGINE_FIXTURE_SERIAL is empty in the workspace environment/);
  assert.equal(of('a placeholder the environment answers').devices.devices[1].reachable, true);
  assert.equal(of('a declared literal value rather than an environment one').devices.devices[1].reachable, true);

  /* Availability composes, and BOTH halves are reported: a device that cannot be reached and a
     file that is not there are two reasons, not one. */
  const both = of('an action on an unreachable device with a missing file too').dashboard.groups[0].actions[0];
  assert.equal(both.available, false);
  assert.deepEqual(both.missing.map(m => m.type).sort(), ['device', 'requires']);
  const fine = of('an action whose prerequisites are present').dashboard.groups[0].actions[0];
  assert.equal(fine.available, true);
  assert.deepEqual(fine.missing, []);
  /* An action naming a device the project does not declare never reaches availability at all: the
     DECLARATION refuses it, by name and with the ids the project does offer, and the whole dashboard
     fails with it — which is the section-fails-whole rule, and the reason that message has to name
     the record. `targetAvailability`'s own "Unknown device" sentence is therefore reachable only for
     a caller that hands it a target the reader never saw. */
  const stray = of('an action naming a device the project does not declare').dashboard;
  assert.deepEqual(stray.groups, []);
  assert.match(stray.error, /\(stray\)\.device references undeclared device id "no-such-box"; this declaration offers local, answering-box$/);

  /* A game action's availability is its record's preflight, not a second copy of those checks. */
  const play = of('a game action whose target is not built').dashboard.groups[0].actions[0];
  assert.equal(play.available, false);
  assert.equal(play.missing.at(-1).type, 'game');

  /* And the targets a device carries, so the Devices tab can list what is bound to each box. */
  const bound = of('games and actions bound to their devices').devices.devices;
  assert.deepEqual(bound.find(d => d.id === 'answering-box').games, ['remote-target']);
  assert.deepEqual(bound.find(d => d.id === 'silent-box').games, ['offline-target']);
  assert.deepEqual(bound.find(d => d.id === 'local').games, ['local-target']);
});
