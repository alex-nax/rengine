/* F155/F189 (spec 142): the game surface wire format in Rust answers what the JavaScript answered.
 *
 * `/api/game` and `/surface` were the last things the JS host uniquely served. The wire format went
 * first because everything else is built on it and because a divergence here is one a person meets
 * as a corrupt picture rather than as an error.
 *
 * This began as a LIVE comparison against `server/surface-protocol.mjs`, and it found a real
 * divergence on its first run: the JavaScript refuses input in TWO stages with two different
 * messages, and the Rust judge reported the first for the second case. That module is deleted now,
 * and **a parity proof cannot outlive the side it compares against** — so what Rust answers is
 * judged against the answers that module gave, recorded before its deletion
 * (`surface-protocol-fixtures.json`, the device F173 used for the agent registry). Regenerating the
 * record would be judging the replacement against itself; the generator's own header says so.
 *
 * **The refusals are compared too.** A port that accepts more than the original is a wider door on
 * the same hinge, and the producer is a game process — exactly the thing that crashes mid-write.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED } from './surface-protocol-fixtures.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'red/target/debug/red-surface');

/* This spec drives a Rust binary, so it builds one first: run alone — or used to check that a
   regression fails for its own reason — it would otherwise judge whatever binary happened to be on
   disk (orchestrator/tests/cargo.mjs). */
before(() => built('--bins'));

test('the surface wire format answers what the JavaScript answered, refusals included', async t => {
  assert.ok(RECORDED, 'surface-protocol-fixtures.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');

  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-surface-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corpus = path.join(directory, 'corpus.json');
  await writeFile(corpus, JSON.stringify(CASES.map(([, kase]) => kase)));

  const rust = JSON.parse((await run(BIN, [corpus], { maxBuffer: 1 << 24 })).stdout);
  assert.equal(rust.length, CASES.length, 'one answer per case');

  /* Both halves of the claim: the answers agree, AND the corpus exercises both outcomes. A corpus
     that happened to be all refusals would compare two implementations that both refuse everything
     and prove nothing. */
  let accepted = 0, refused = 0;
  for (const [index, [title]] of CASES.entries()) {
    const was = RECORDED[title];
    assert.deepEqual(rust[index], was, `${title}: ${JSON.stringify({ rust: rust[index], recorded: was })}`);
    if (was.refused) refused++; else accepted++;
  }
  assert.ok(accepted >= 15, `the corpus accepts real cases (${accepted})`);
  assert.ok(refused >= 15, `and refuses real ones (${refused})`);
});
