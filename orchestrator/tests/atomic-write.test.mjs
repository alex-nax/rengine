import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Tokens } from './token-client.mjs';
import { built } from './cargo.mjs';

/* KI-065. `writeAtomically` named its temporary after the writing *process*, so two writes to one
   file in flight in the same process shared it: the first rename moved the bytes both had written
   into place and the second failed `ENOENT ... rename tokens/preferences.json.<pid>.tmp`. Seen as a
   flake in `token-retirement.test.mjs`, about one run in three, on a clean checkout.

   The naming rule moved to Rust with the ledger (F157), and so did its regression: `red-token`'s
   `two_writes_to_one_file_at_once_both_land_and_the_file_is_one_of_them_whole` is the direct test,
   at the level where the temporary is named. What is left here is the consumer's half — three
   writers of the workspace preference file, through the client, ending with the file and the
   client's own copy saying the same thing. */

test('the workspace preference file agrees with memory after concurrent writers', { timeout: 60000 }, async t => {
  await built('-p', 'red-token', '--bin', 'red-token-serve');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-atomic-tokens-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokens = await Tokens.open(directory, {});
  t.after(() => tokens.close());

  /* Three writers of one file, started together: the window, then two generation bumps. The service
     applies them one at a time, so the values are deterministic; what is not deterministic without a
     per-write temporary is whether all three writes survive. */
  await Promise.all([tokens.setWindow(120000), tokens.bumpGeneration(), tokens.bumpGeneration()]);

  const file = path.join(directory, 'tokens', 'preferences.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.tokenWindowMs, 120000, 'the window the caller set');
  assert.equal(stored.generation, 2, 'and the last generation it handed out');
  assert.equal(tokens.window(), 120000, 'which is the window this client answers with');
  assert.deepEqual(stored, tokens.preferences, 'the file on disk is the preferences this worker holds');
  assert.deepEqual((await readdir(path.join(directory, 'tokens'))).filter(name => name.endsWith('.tmp')), [],
    'and no temporary is left behind');
});
