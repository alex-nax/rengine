/* F156 (spec 129): the record the preview and the byte window are judged against.
 *
 * These are the last two things `formats.mjs` does: run a command the project declared over one of
 * its files, and hand back a window of raw bytes. A preview that will not run is what a person sees
 * instead of their file, and the sentence is the whole explanation — so every refusal is recorded
 * word for word.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './preview-corpus.mjs';

export const PARSER_WORDED = 'a declaration that would not read';

test('the recorded preview answers are the ones the module gives', { timeout: 180000 }, async () => {
  assert.ok(RECORDED, 'preview-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) {
    /* The one answer whose parenthetical belongs to whichever runtime read the file. */
    if (name === PARSER_WORDED) {
      assert.match(live[name].refused.message, /^\.rengine\/project\.json: invalid JSON \(/, name);
      continue;
    }
    assert.deepEqual(live[name], RECORDED[name], name);
  }
});

test('the corpus holds the rules a preview is bounded by', () => {
  const of = name => RECORDED[name];
  /* A preview runs a command the PROJECT declared, so the refusals are about the declaration first. */
  assert.equal(of('a project that declares nothing').refused.status, 415);
  assert.equal(of('a preview of a directory').refused.message, 'Previews require a regular file.');
  assert.match(of('a preview of a file no format matches').refused.message, /^No registered format matches nothing\.md\.$/);
  assert.equal(of('a preview naming a formatId this project has not').refused.status, 404);
  assert.match(of('a preview of a format that declares none').refused.message, /^Format bare-format declares no preview command\.$/);

  /* What a command said about itself reaches the person, and a status they can act on with it. */
  assert.equal(of('a text preview whose command fails').refused.message, 'Command failed (exit 4): the producer could not read it');
  assert.equal(of('a text preview whose command fails').refused.status, 502);

  /* Output is not trusted: text must be UTF-8 without NUL, and a tree must be one JSON object of
     the shape the viewer draws — a `size` that is not a whole non-negative number is not a file. */
  assert.equal(of('a text preview that is not UTF-8').refused.message, 'Preview output is not UTF-8 text without NUL.');
  assert.equal(of('a tree preview whose output is not JSON').refused.message, 'Preview output is not one JSON tree object.');
  assert.equal(of('a tree preview whose node is the wrong shape').refused.message, 'Preview output is not one JSON tree object.');
  const tree = of('a tree preview').ok.tree;
  assert.deepEqual(tree.files.map(file => file.name), ['a.dat']);
  assert.deepEqual(tree.dirs[0].files.map(file => file.path), ['sub/b.dat']);

  /* An entry answers its own bytes: the hash and the window are of what the command produced. */
  const entry = of('an entry').ok;
  assert.equal(entry.kind, 'entry');
  assert.equal(entry.text, 'readme.txt');
  assert.equal(entry.window.hex, Buffer.from('readme.txt').toString('hex'));
  assert.equal(of('an entry with a byte window').ok.window.offset, 2);
  assert.equal(of('an entry that is not a bounded string').refused.message, 'Entry must be a bounded string.');

  /* The byte window is confined like every declared path, and says what it actually read. */
  assert.equal(of('a byte window').ok.length, 14);
  assert.equal(of('a byte window with an offset and a length').ok.hex, Buffer.from('one two three\n').subarray(3, 8).toString('hex'));
  assert.equal(of('a byte window past the end of the file').ok.length, 0, 'an offset past the end reads nothing rather than refusing');
  assert.equal(of('a byte window with a negative offset').refused.status, 400);
  assert.equal(of('a byte window of a directory').refused.message, 'Raw view requires a regular file.');
  assert.equal(of('a byte window that leaves the project').refused.status, 403);
});
