import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeAtomically } from '../runtime/feed.mjs';
import { Tokens } from '../runtime/token.mjs';

/* KI-064. `writeAtomically` named its temporary after the writing *process*, so two writes to one
   file in flight in the same process shared it: the first rename moved the bytes both had written
   into place and the second failed `ENOENT ... rename tokens/preferences.json.<pid>.tmp`. Seen as a
   flake in `token-retirement.test.mjs`, about one run in three, on a clean checkout. */

test('two writes to one file at once both land, and the file is one of them whole', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'preferences.json');
  /* Padded so a writer that is interrupted mid-write leaves a file that will not parse, rather than
     one that happens to be short enough to be written in a single syscall. */
  const values = Array.from({ length: 8 }, (unused, index) => ({ write: index, pad: 'x'.repeat(64 * 1024) }));

  const results = await Promise.allSettled(values.map(value => writeAtomically(file, value)));
  const refused = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
  assert.deepEqual(refused, [], 'no write is thrown away by another write of the same file');

  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(values.some(value => value.write === stored.write && value.pad === stored.pad),
    'the file is one whole value, not a mixture of two');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), [],
    'and no temporary is left behind');
});

test('the workspace preference file agrees with memory after concurrent writers', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-atomic-tokens-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokens = await Tokens.open(directory, {});

  /* Three writers of one file, started together: the window, then two generation bumps. Each reads
     and updates `preferences` synchronously before it awaits, so the values are deterministic; what
     is not deterministic without a per-write temporary is whether all three writes survive. */
  await Promise.all([tokens.setWindow(120000), tokens.bumpGeneration(), tokens.bumpGeneration()]);
  await tokens.writing;

  const file = path.join(directory, 'tokens', 'preferences.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.tokenWindowMs, 120000, 'the window the caller set');
  assert.equal(stored.generation, 2, 'and the last generation it handed out');
  assert.deepEqual(stored, tokens.preferences, 'the file on disk is the preferences this worker holds');
  assert.equal(tokens.window(), 120000);
  assert.deepEqual((await readdir(path.join(directory, 'tokens'))).filter(name => name.endsWith('.tmp')), []);
});
