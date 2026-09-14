/* F156 (spec 129): the record a dashboard capture is judged against.
 *
 * A capture is the one dashboard action that writes into the project. What is recorded is the
 * answer AND what landed — the capture directory and the manifest — because "nothing was written"
 * is half of what several of these refusals promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './capture-corpus.mjs';

test('the recorded capture answers are the ones the module gives', { timeout: 180000 }, async () => {
  assert.ok(RECORDED, 'capture-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

test('the corpus holds the rules a capture is bounded by', () => {
  const of = name => RECORDED[name];

  /* A capture is an ACTION first: the board decides whether it may be pressed, and the reason a
     person sees for a grey button is the reason this refuses with. */
  assert.equal(of('a project that declares nothing at all').refused.status, 415);
  assert.equal(of('a project whose contract has no dashboard').refused.message, 'Unknown dashboard action.');
  assert.equal(of('an action that is not a capture').refused.message, 'Action hello is not a capture action.');
  assert.equal(of('a capture whose prerequisite is missing').refused.message, 'Action needy-shot is unavailable: requires missing.env.');

  /* Where it writes is confined the way every declared path is, and the store's words are used. */
  assert.equal(of('a capture into a path outside the project').refused.status, 403);
  assert.match(of('a capture into a path that is a file').refused.message, /^EEXIST: file already exists, mkdir /);
  assert.equal(of('a capture into a path that is a file').refused.status, null, 'a refusal the filesystem raised carries no route status');

  /* The bytes are judged before anything is written, and a refusal leaves the directory as it was. */
  assert.equal(of('a capture whose command fails').refused.message, 'Command failed (exit 2): capture: device offline');
  assert.equal(of('a capture whose output is not a PNG').refused.message, 'Capture output is not a PNG (signature mismatch); nothing was written.');
  for (const name of ['a capture whose command fails', 'a capture whose output is not a PNG']) {
    assert.deepEqual(of(name).landed.directory, [], `${name}: the directory exists and holds nothing`);
  }

  /* What lands: the PNG under the moment it was taken, and one manifest row describing it. */
  const taken = of('a capture').ok;
  assert.equal(taken.path, '.cache/captures/<time>.png');
  assert.equal(taken.manifest, '.cache/captures/manifest.json');
  assert.equal(taken.size, 226);
  assert.deepEqual(of('a capture').landed.directory, ['<time>.png', 'manifest.json']);
  assert.equal(of('a capture').landed.bytes, taken.sha256, 'the file on disk is the file the answer described');
  assert.deepEqual(of('a capture').landed.manifest, [{ file: taken.file, time: taken.time, size: taken.size, sha256: taken.sha256, action: 'shot' }]);

  /* A manifest ACCUMULATES, and one this workspace cannot read is replaced rather than fatal — a
     capture a person just took is not lost to a file someone else wrote badly. */
  assert.equal(of('a capture into a directory that already holds a manifest').landed.manifest.length, 2);
  assert.equal(of('a capture whose manifest is not JSON').landed.manifest.length, 1);
  assert.equal(of('a capture whose manifest is JSON but not a list').landed.manifest.length, 1);
});
