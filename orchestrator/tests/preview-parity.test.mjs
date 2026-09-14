/* F156 (spec 129): the Rust preview and byte window answer the recorded corpus.
 *
 * `preview-record.test.mjs` is the other half — it proves the record is what the JavaScript says.
 * This one proves the replacement says the same thing: which format a file is matched to, what a
 * project's own producer said about it, and every refusal a viewer shows instead of the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, fixtureFor, foldFor } from './preview-corpus.mjs';
import { PARSER_WORDED } from './preview-record.test.mjs';
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
