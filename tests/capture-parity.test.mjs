/* F156 (spec 129): the Rust capture answers the recorded corpus, and lands what the record says.
 *
 * The record was taken from `dashboard.mjs` while that module still captured (5f84f05); this proves
 * the replacement says the same thing AND writes the same thing, because a capture is the one
 * dashboard action that changes the project and what is on disk afterwards is half the answer. The
 * test that judged the record against the JavaScript went with the JavaScript: that module is a thin
 * client of this implementation now, and asking it would be asking the replacement about itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, fixtureFor, fold, landed } from './capture-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../red/target/debug/red-project');

function ask(rootId, rootPath, actionId) {
  return new Promise(resolve => {
    execFile(BINARY, ['dashboard-capture', rootId, rootPath, actionId ?? ''], { maxBuffer: 1 << 26 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { resolve({ refused: { message: `red-project answered nothing: ${stdout}`, status: null } }); return; }
      resolve(value?.error !== undefined && value?.status !== undefined ? { refused: { message: value.error, status: value.status } } : { ok: value });
    });
  });
}

test('the Rust capture gives the recorded answers and lands the recorded files', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'capture-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-capture-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
    const root = await fixtureFor(directory, name, options);
    if (options.twice) await ask(`root-${slug}`, root, options.action);
    let live = await ask(`root-${slug}`, root, options.action);
    if (live.refused) live = { refused: { ...live.refused, message: live.refused.message.split(root).join('<root>') } };
    live = { ...fold(live), landed: fold(await landed(root)) };
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers and writes as recorded');
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
