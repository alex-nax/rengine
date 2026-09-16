/* F155 (spec 129): the Rust devices and dashboard answer the recorded corpus.
 *
 * `devices-record.test.mjs` is the other half — it proves the record is what the JavaScript says.
 * This one proves the replacement says the same thing: every device's reachability and the sentence
 * behind it, every action's availability and which half of it failed, and the number of probes each
 * listing cost.
 *
 * Both listings are asked in ONE invocation, because they share a probe cache: the dashboard asks
 * each action's device whether it answers, and the devices tab asks the dashboard what is bound to
 * each one. Answering them in two processes would cost a probe per action, which is the thing the
 * recorded probe count exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED, fold, project, rootId } from './devices-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../red/target/debug/red-project');

function ask(root, id, refresh, env) {
  return new Promise((resolve, reject) => {
    /* `controls`, because the record was made with a `resolve` function handed in — the corpus is
       the full listing a Devices tab asks for. */
    const argv = ['workspace', id, root, refresh ? 'refresh,controls' : 'controls'];
    execFile(BINARY, argv, { maxBuffer: 1 << 26, env }, (error, stdout, stderr) =>
      error ? reject(new Error(`red-project workspace: ${stderr || error.message}`)) : resolve(JSON.parse(stdout)));
  });
}

test('the Rust devices and dashboard give the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'devices-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-devices-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const root = await project(directory, name, options);
    const env = { ...process.env, ...(options.env ?? {}) };
    for (const [key, value] of Object.entries(options.env ?? {})) if (value === undefined) delete env[key];
    const answer = await ask(root, rootId(name), options.refresh, env);
    let probes = 0;
    try { probes = (await readFile(path.join(root, 'probe-count.txt'), 'utf8')).length; } catch { /* nothing probed */ }
    const live = fold({ devices: { ...answer.devices, rootId: '<rootId>' }, dashboard: { ...answer.dashboard, rootId: '<rootId>' }, probes }, root);
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
});
