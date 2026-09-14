/* F161 (charter D37, spec 102): the record the language-server client is judged against.
 *
 * Diagnostics are the one thing an agent and a person have to agree about — the editor pane and
 * `mcp__ide__getDiagnostics` read one store — so what is recorded is not the protocol, which the
 * fake server already speaks honestly, but what the CLIENT does with it.
 *
 * The half that runs today replays the corpus against the live module, so the record cannot drift
 * from what it froze.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './lsp-corpus.mjs';

test('the recorded language-server answers are the ones the client gives', { timeout: 180000 }, async () => {
  assert.ok(RECORDED, 'lsp-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

test('the corpus holds the rules a diagnostics client is for', () => {
  const of = name => RECORDED[name];
  const step = (name, index) => of(name).steps[index];
  /* A file is matched to the servers that declare it, and one nothing declares starts nothing. */
  assert.deepEqual(step('a declared server is matched, started and read', 0).servers, ['fake']);
  assert.deepEqual(step('a file no server declares is nobody’s business', 0).servers, []);
  /* The directory wildcard reaches a file directly inside the directory too — the bug this glob
     had the first time it was written. */
  assert.deepEqual(step('a directory wildcard reaches a file directly inside it', 0).servers, ['fake']);

  /* The BUFFER is the truth, not the file: nothing is written to disk and the answer changes. */
  const first = step('a declared server is matched, started and read', 1).items;
  assert.deepEqual(first.map(item => item.message), ['TODO on line 2']);
  const changed = step('a declared server is matched, started and read', 3).items;
  assert.deepEqual(changed.map(item => item.message), ['TODO on line 1', 'TODO on line 2']);

  /* rEngine runs a declared language server and never installs one, so a machine without it gets a
     named absence rather than a silent empty list. */
  assert.match(step('a server that is not on this machine is named', 1).unavailable[0],
    /^absent: definitely-not-a-language-server-9f is not on this machine; rEngine runs a declared language server but never installs one$/);

  /* A crashed server's diagnostics go with it: keeping them would mean reporting a file as broken
     on the word of a process that is no longer running and may have been wrong when it died. */
  const crash = of('a crash clears what the server said, and says when it will come back');
  assert.deepEqual(crash.steps[2].items, [], 'nothing outlives the process that said it');
  assert.match(crash.steps[1].unavailable[0], /^fake: exited \(code N\); restarting in 500 ms$/,
    'and the first backoff is stated, so a port that restarted eagerly would hammer a crashing server');

  /* Closing tells the server and drops what it said. */
  assert.deepEqual(of('closing a file tells the server and drops what it said').steps[2].items, []);
});
