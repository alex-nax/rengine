/* The answers `dashboard.mjs`'s capture gives, recorded before it is replaced (F156, spec 129).
 *
 * A capture is the one dashboard action that WRITES: it runs a command the project declared, judges
 * the bytes, and lands a PNG and a manifest entry inside the project. So the record holds three
 * things per case — the answer, what is in the capture directory afterwards, and what the manifest
 * says — because "nothing was written" is half of what several of these refusals promise.
 *
 * The record is FROZEN. It was taken from `orchestrator/server/dashboard.mjs` at 5f84f05, the last
 * commit where that module captured itself; it is a thin client of `red_project::capture` now, so
 * regenerating would judge the replacement against itself. The generator is gone with the module it
 * asked — recover it from that commit if the record ever has to be taken again. A capture's file
 * name is the moment it was taken, so the timestamp is folded wherever it appears; the bytes are a
 * fixture's, so the size and the sha256 are the rule's and are recorded as they are.
 *
 * One rule is NOT here, because it cannot be: a second capture in the same millisecond is named
 * `<time>-2.png`, and nothing in a corpus can make two calls share a millisecond. It is unit-tested
 * where it is implemented, and `dashboard.test.mjs` drives two captures over the route.
 */
import { mkdir, writeFile, readFile, readdir, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { declaration } from './format-fixtures.mjs';
import { captureProducer } from './dashboard-fixtures.mjs';

const capture = (id, verb, extra = {}) => ({ id, title: id, kind: 'capture', command: [process.execPath, captureProducer, verb], into: '.cache/captures', format: 'png', ...extra });
const board = () => ({
  ...declaration(), contract: 2,
  dashboard: { title: 'Fixture', groups: [{ id: 'shots', title: 'Shots', actions: [
    { id: 'hello', title: 'Say hello', kind: 'script', script: 'hello.sh' },
    capture('shot', 'png'),
    capture('bad-shot', 'text'),
    capture('failing-shot', 'fail'),
    capture('needy-shot', 'png', { requires: ['missing.env'] }),
    capture('escape-shot', 'png', { into: 'captures-link' }),
    capture('file-shot', 'png', { into: 'notes.txt' }),
  ] }] },
});

export const CASES = [
  ['a project that declares nothing at all', { document: null, action: 'shot' }],
  /* A contract-1 declaration is not a project without a dashboard — it is a project whose dashboard
     is empty, so the action is simply unknown. The 415 belongs to a project with no declaration. */
  ['a project whose contract has no dashboard', { document: declaration(), action: 'shot' }],
  ['an action this dashboard has not', { action: 'no-such-action' }],
  ['an action that is not a capture', { action: 'hello' }],
  ['a capture whose prerequisite is missing', { action: 'needy-shot' }],
  ['a capture into a path outside the project', { action: 'escape-shot' }],
  ['a capture into a path that is a file', { action: 'file-shot' }],
  ['a capture whose command fails', { action: 'failing-shot' }],
  ['a capture whose output is not a PNG', { action: 'bad-shot' }],
  ['a capture', { action: 'shot' }],
  ['a capture into a directory that already holds a manifest', { action: 'shot', twice: true }],
  ['a capture whose manifest is not JSON', { action: 'shot', manifest: 'not json at all' }],
  ['a capture whose manifest is JSON but not a list', { action: 'shot', manifest: '{"entries":[]}' }],
];

/** The project a case is asked about, shared with the harness that judges the replacement. */
export async function fixtureFor(directory, name, options) {
  return fixture(directory, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48), options);
}

async function fixture(directory, name, options) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  if (options.document !== null) await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(options.document ?? board()));
  await writeFile(path.join(root, 'hello.sh'), '#!/bin/bash\necho hello\n');
  await chmod(path.join(root, 'hello.sh'), 0o755);
  await writeFile(path.join(root, 'notes.txt'), 'a file where a directory is asked for\n');
  const outside = path.join(directory, `${name}-outside`);
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(root, 'captures-link'), 'dir');
  if (options.manifest !== undefined) {
    await mkdir(path.join(root, '.cache/captures'), { recursive: true });
    await writeFile(path.join(root, '.cache/captures/manifest.json'), options.manifest);
  }
  return root;
}

/* A capture is named for the moment it was taken. Nothing else in the answer is a clock. */
const STAMP = /\d{4}-\d{2}-\d{2}T[\d:.-]{8,}Z/g;
export const fold = value => JSON.parse(JSON.stringify(value).replace(STAMP, '<time>'));

/** What landed in the project: the capture directory, and the manifest as it now reads. */
export async function landed(root) {
  const directory = path.join(root, '.cache/captures');
  let files = [];
  try { files = (await readdir(directory)).sort(); } catch { return { directory: null, manifest: null, bytes: null }; }
  let manifest = null;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); } catch { manifest = 'unreadable'; }
  const png = files.find(file => file.endsWith('.png'));
  const bytes = png ? createHash('sha256').update(await readFile(path.join(directory, png))).digest('hex') : null;
  return { directory: files, manifest, bytes };
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./capture-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();
