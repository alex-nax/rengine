/* F156 (spec 129): the Rust preview and byte window answer the recorded corpus.
 *
 * The record was taken from `formats.mjs` while that module still ran these itself (be626ea); this
 * proves the replacement says the same thing — which format a file is matched to, what a project's
 * own producer said about it, and every refusal a viewer shows instead of the file. The test that
 * judged the record against the JavaScript went with the JavaScript: that module is a thin client of
 * this implementation now, and asking it would be asking the replacement about itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, PARSER_WORDED, fixtureFor, foldFor } from './preview-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-project');

function ask(call, rootId, rootPath, data) {
  return new Promise(resolve => {
    const child = execFile(BINARY, [call, rootId, rootPath], { maxBuffer: 1 << 26 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { resolve({ refused: { message: `red-project answered nothing: ${stdout}`, status: null } }); return; }
      resolve(value?.error !== undefined && value?.status !== undefined ? { refused: { message: value.error, status: value.status } } : { ok: value });
    });
    child.stdin.end(JSON.stringify(data));
  });
}

test('the Rust preview and byte window give the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'preview-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-preview-parity-')));
  await writeFile(path.join(directory, 'escape.txt'), 'outside\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
    const root = await fixtureFor(directory, name, options);
    let live = await ask(options.call, `root-${slug}`, root, options.data);
    if (live.ok) live = { ok: foldFor({ ...live.ok, rootId: live.ok.rootId === undefined ? undefined : '<rootId>' }, root) };
    else live = { refused: { ...live.refused, message: live.refused.message.split(root).join('<root>') } };
    /* The one answer whose parenthetical belongs to whichever runtime read the file. */
    if (name === PARSER_WORDED) {
      assert.match(live.refused.message, /^\.rengine\/project\.json: invalid JSON \(/, name);
      assert.equal(live.refused.status, RECORDED[name].refused.status, name);
      continue;
    }
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
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

  /* The shapes a ROUTE delivers. A query string has no numbers in it, and an absent parameter and
     an empty one are different things a person can send. */
  assert.equal(of('a byte window whose offset and length arrived as text').ok.offset, 3);
  assert.equal(of('a byte window whose offset arrived empty').ok.offset, 0, 'an empty parameter reads from the start');
  assert.equal(of('a byte window whose offset is not a number').refused.status, 400);
  assert.equal(of('a byte window whose offset is fractional').refused.status, 400);
  assert.equal(of('a byte window whose length is written in exponent form').ok.length, 10);
  assert.equal(of('an entry whose byte window has a negative offset').refused.message,
    'Byte window needs non-negative integer offset and length.', 'an entry window is bounded by the same rule');
});
