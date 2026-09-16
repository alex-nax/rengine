/* The answers `devices.mjs` and `dashboard.mjs` give, recorded before they are replaced (F155,
 * spec 129, KI-107).
 *
 * The device F148/F172/F178 established and F156b/F157 repeated: a replacement cannot be compared
 * against a module that no longer exists, so the modules' own answers are recorded while they are
 * still here and the Rust side is judged against the record afterwards. Regenerate ONLY from a
 * checkout where these two modules still answer — never after the deletion commit, because a
 * regenerated record would be judging the replacement against itself.
 *
 *   node orchestrator/tests/devices-corpus.mjs > orchestrator/tests/devices-corpus.json
 *
 * What is recorded is the ANSWER, including every refusal word for word: an unreachable device's
 * sentence is what a person reads in the Devices tab, and an unavailable action's `missing` list is
 * why a button will not press.
 *
 * Two things are folded so the record is the same on any machine: the project's absolute path
 * becomes `<root>`, and `checkedAt` becomes `<stamp>` — it is a wall clock, and the cache timing it
 * belongs to is asserted by `devices.test.mjs` rather than frozen here. Everything else, including
 * the probe COUNT each case leaves behind, is compared exactly: a port that probed twice where this
 * probes once would be a port that costs a person two ssh round trips per listing.
 */
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deviceProject, devicesDeclaration, HOST, SERIAL, answering, counted, gated, headset, localGame, remoteGame, remoteHost, silent, stalling, thisMachine } from './device-fixtures.mjs';

/* This corpus declares its own format rather than borrowing `format-fixtures`', which names this
   machine's node and this checkout's producer — a record carrying either is a record only this
   machine could check. Every path here is a constant or a project-relative fixture. */
const FORMAT = {
  id: 'fixture-pack', title: 'Fixture pack', match: ['*.pack'], modes: ['raw'], default: 'raw',
};
export const base = (extra = {}) => ({ contract: 1, project: 'fixture', formats: [FORMAT], ...extra });
const devices = (records, extra = {}) => devicesDeclaration(records, base(extra));

const action = (extra = {}) => ({ id: 'check', title: 'Check', kind: 'log', command: ['/bin/echo', 'checked'], ...extra });
const board = (actions, title = 'Fixture') => ({ title, groups: [{ id: 'build', title: 'Build', actions }] });

/* Each case names the declaration, the environment the workspace is holding at that moment, and
   whether the caller asked for a refresh. The fixture project is written fresh per case, so the
   probe counter starts at zero every time. */
export const CASES = [
  ['no declaration at all', { document: null }],
  ['a declaration with no devices block', { document: base() }],
  ['a devices block the rules refuse', { document: devices([{ id: 'bare', kind: 'ssh', title: 'Bare' }]) }],

  /* The implicit local device is always offered, so a consumer never has to declare it. */
  ['no devices declared at contract 4', { document: devices([]) }],
  ['a declared local device wins its own title', { document: devices([thisMachine({ title: 'The workstation' })]) }],

  ['a remote device that answers', { document: devices([answering()]) }],
  ['a remote device that refuses, with only its first stderr line', { document: devices([silent()]) }],
  ['a remote device whose probe hangs past its own timeout', { document: devices([stalling()]) }],
  ['a device whose requires and tools are missing here', { document: devices([gated()]) }],
  ['the same device once its required file exists', { document: devices([gated()]), files: { 'config/host.env': 'HOST=fixture\n' } }],

  /* value or env: an env that is unset or empty is a named reason, never a spawn with an empty
     argument and never one with the placeholder left in. */
  ['a placeholder whose environment variable is unset', { document: devices([headset()]) }],
  ['a placeholder whose environment variable is empty', { document: devices([headset()]), env: { [SERIAL]: '' } }],
  ['a placeholder the environment answers', { document: devices([headset()]), env: { [SERIAL]: '1WMHH815K9000X' } }],
  ['a host the environment answers', { document: devices([remoteHost()]), env: { [HOST]: 'fixture-host' } }],
  ['a declared literal value rather than an environment one', { document: devices([remoteHost({ host: { value: 'literal-host' } })]) }],

  /* What a device carries: the targets bound to it, and the controls they become. */
  ['games and actions bound to their devices', { document: devices([answering(), silent()], {
    games: [localGame(), remoteGame(), remoteGame({ id: 'offline-target', title: 'Offline target', device: 'silent-box' })],
    dashboard: board([action(), action({ id: 'remote-check', title: 'Remote check', device: 'answering-box' })]),
  }) }],
  ['an action naming a device the project does not declare', { document: devices([answering()], {
    dashboard: board([action({ id: 'stray', title: 'Stray', device: 'no-such-box' })]),
  }) }],
  ['an action whose local prerequisites are missing', { document: devices([answering()], {
    dashboard: board([action({ id: 'needs', title: 'Needs', requires: ['build/never-built'], tools: ['definitely-missing-tool-9f'] })]),
  }) }],
  ['an action whose prerequisites are present', { document: devices([answering()], {
    dashboard: board([action({ id: 'present', title: 'Present', requires: ['build/present-locally'] })]),
  }) }],
  /* Both halves are reported: a reachable device with a missing local file reports the file. */
  ['an action on an unreachable device with a missing file too', { document: devices([silent()], {
    dashboard: board([action({ id: 'both', title: 'Both', device: 'silent-box', requires: ['build/never-built'] })]),
  }) }],
  ['a game action whose target is not built', { document: devices([answering()], {
    games: [localGame()],
    dashboard: board([action({ id: 'play', title: 'Play', kind: 'game', game: 'local-target', command: undefined })]),
  }) }],
  ['a refresh asks again rather than answering from the cache', { document: devices([counted()]), refresh: true }],
];

/* `checkedAt` is a wall clock and the probe scripts write into the project, so the two things that
   are not decisions are folded here rather than compared. */
const fold = (value, root) => JSON.parse(JSON.stringify(value, (key, item) => {
  if (key === 'checkedAt') return typeof item === 'string' && Date.parse(item) > 0 ? '<stamp>' : item;
  return typeof item === 'string' ? item.split(root).join('<root>') : item;
}));

export async function answers() {
  const { projectDevices, forgetProbes } = await import('./devices.mjs');
  const { dashboardActions } = await import('./dashboard.mjs');
  const { readDeclaration } = await import('./formats.mjs');
  const { inspectGame } = await import('./devices.mjs');
  /* realpath, because macOS hands back a /var symlink to /private/var and `resolveInRoot`
     refuses a path that leaves the root through one — which would make every `requires` read as
     missing and record a corpus of false negatives. `devices.test.mjs`'s own `scratch()` does the
     same thing for the same reason. */
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-devices-corpus-')));
  const recorded = {};
  try {
    for (const [name, options] of CASES) {
      forgetProbes();
      const held = {};
      for (const [key, value] of Object.entries(options.env ?? {})) { held[key] = process.env[key]; process.env[key] = value; }
      try {
        const root = await project(directory, name, options);
        const selected = { id: `root-${slug(name)}`, path: root, name: 'fixture' };
        const declared = await readDeclaration(root);
        const preflight = (rootId, gameId) => inspectGame(selected, gameId);
        const listing = await projectDevices(selected, declared, { refresh: Boolean(options.refresh), preflight,
          resolve: () => dashboardActions(selected, preflight) });
        const actions = await dashboardActions(selected, preflight);
        /* The probe counter the fixture leaves behind: a port that probes twice where this probes
           once costs a person two ssh round trips for one listing. */
        let probes = 0;
        try { probes = (await readFile(path.join(root, 'probe-count.txt'), 'utf8')).length; } catch { /* nothing probed */ }
        recorded[name] = fold({ devices: { ...listing, rootId: '<rootId>' }, dashboard: { ...actions, rootId: '<rootId>' }, probes }, root);
      } finally {
        for (const [key, value] of Object.entries(held)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }
    return recorded;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const slug = name => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
export const rootId = name => `root-${slug(name)}`;

/** The project a case is asked about, written fresh so its probe counter starts at zero. */
export async function project(directory, name, options) {
  if (options.document === null) {
    const root = path.join(directory, slug(name));
    await mkdir(root, { recursive: true });
    return root;
  }
  const root = await deviceProject(directory, slug(name), options.document);
  for (const [file, body] of Object.entries(options.files ?? {})) await writeFile(path.join(root, file), body);
  return root;
}

/** The folding both harnesses apply, so the Rust side is compared on the same terms. */
export { fold };

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./devices-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}
