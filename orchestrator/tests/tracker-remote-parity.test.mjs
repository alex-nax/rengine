/* F154 (spec 083, spec 100): the Rust remote providers answer the recorded corpus.
 *
 * `tracker-remote-corpus.mjs` is the other half — it is what the JavaScript said, recorded from a
 * checkout where `tracker.mjs` still read a provider. Here the same declarations and the same
 * provider answers go to `red-project tracker-remote`, and the two are compared whole.
 *
 * What is compared is the answer AND the request: a filter that reaches the provider is the whole of
 * what a declaration means, so comparing only the rows would let a wrong question return the right
 * shape. The four states a person acts on differently — denied, invalid, unavailable, and the
 * `signIn` naming that says which gesture fixes it — are each their own case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED } from './tracker-remote-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-project');
const ROOT_ID = '11111111-2222-3333-4444-555555555555';

function ask(rootPath, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(BINARY, ['tracker-remote', ROOT_ID, rootPath], { maxBuffer: 1 << 26 },
      (error, stdout, stderr) => error ? reject(new Error(`red-project tracker-remote: ${stderr || error.message}`)) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

test('the Rust remote providers give the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'tracker-remote-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-remote-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const drift = [];
  for (const [name, spec] of CASES) {
    const root = path.join(directory, name.replace(/[^a-z0-9]+/gi, '-'));
    await mkdir(path.join(root, '.rengine'), { recursive: true });
    await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(spec.declared));
    const live = await ask(root, { declared: { declared: true, ...spec.declared }, credential: spec.credential, answered: spec.answered });
    const { checkedAt, fresh, ...rest } = live;
    if (JSON.stringify(rest) !== JSON.stringify(RECORDED[name])) drift.push([name, rest]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');

  /* The four a person acts on differently are each present, and each names something to do. A
     corpus that happened to record four empty lists would be green and prove nothing. */
  const said = key => Object.values(RECORDED).filter(answer => answer[key] !== undefined);
  assert.equal(said('denied').length, 4, 'not signed in, and each provider refusing a token');
  assert.equal(said('invalid').length, 2, 'a declaration that asks for nothing real, either provider');
  assert.equal(said('unavailable').length, 3, 'a provider that is down, and one that is rate limited');
  const signIn = Object.values(RECORDED).filter(answer => answer.signIn !== undefined);
  assert.deepEqual(signIn.map(answer => answer.signIn), ['linear'],
    'only the provider a browser sign-in exists for names the gesture');
  /* And rows, so the four states are not the only thing this proves. */
  const rows = Object.values(RECORDED).filter(answer => answer.rows.length > 0);
  assert.equal(rows.length, 2, 'one list from each provider');
});
