/* F169 (F147a, spec 129, KI-091): the red-store crate reads and writes the store files the JS
 * host writes — byte-for-byte, both directions — and the bounded schema validator answers with
 * identical error strings, order included. The corpus is captured by driving the REAL
 * WorkspaceStore and validateSchema through scripted operations; `red-store-check` replays the
 * same script with the same args and must answer identically, file bytes included. Nothing is
 * deleted in this slice.
 *
 * Determinism: Date.now is pinned during capture; minted uuids become placeholders; the capture
 * directory becomes <DIR>. (The mid-save 409 race needs an interleaving hook the store does not
 * offer; it stays covered by store.test.mjs.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { buildCorpusForImport } from './store-corpus.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = path.join(ROOT, 'red/target/debug/red-store-check');
const run = promisify(execFile);

async function buildCorpus(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-store-corpus-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const corpus = await buildCorpusForImport(directory);
  const file = path.join(directory, 'corpus.json');
  await writeFile(file, JSON.stringify(corpus));
  return { corpus, file, directory };
}

test('the crate replays the captured corpus byte-for-byte', async t => {
  await run('cargo', ['build', '-p', 'red-store', '--bin', 'red-store-check'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(CHECK), `red-store-check was built at ${CHECK}`);
  const { file } = await buildCorpus(t);
  const judged = await run(CHECK, [file], { maxBuffer: 32 * 1024 * 1024 }).catch(error => error);
  assert.equal(judged.code ?? 0, 0, `red-store-check disagreed:\n${judged.stdout}\n${judged.stderr}`);
});

test('the JS host reads what the crate writes (the other direction)', async t => {
  const { corpus, file, directory } = await buildCorpus(t);
  /* red-store-check --emit DIR replays with DIR as its working directory (tree, projects and
     state all under it); the JS store then opens DIR/state and must read the same model the
     recorded bytes describe. */
  const outDir = path.join(directory, 'rust-replay');
  await run(CHECK, [file, '--emit', outDir], { maxBuffer: 32 * 1024 * 1024 });
  const { WorkspaceStore } = await import('../server/store.mjs');
  const store = await WorkspaceStore.open(path.join(outDir, 'state'));
  const { realpath } = await import('node:fs/promises');
  const expected = JSON.parse(corpus.ops[corpus.ops.length - 1].file.replaceAll('<DIR>', await realpath(outDir)));
  assert.deepEqual(store.state, expected, 'the JS host opens the crate-written state and reads the same model');
});
