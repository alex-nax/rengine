/* The payload `dashboard.mjs` builds for a dashboard action that becomes a terminal (F156, spec 129).
 *
 * Pressing a script or a log action opens a PANE, and this is the argv, environment and title that
 * pane is started with. Recorded before the payload is built in Rust, because the shape is a
 * contract with the session host on the other side and the two refusals are what a person sees when
 * a declared action names something that is not there.
 *
 *   node orchestrator/tests/run-payload-corpus.mjs > orchestrator/tests/run-payload-corpus.json
 *
 * Regenerate ONLY from a checkout where `dashboard.mjs` still builds it. The project path and the
 * bash this machine has are folded; nothing else here is a machine's.
 */
import { mkdir, writeFile, readFile, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { declaration } from './format-fixtures.mjs';

const script = (id, extra = {}) => ({ id, title: id, kind: 'script', script: 'hello.sh', ...extra });
const board = () => ({
  ...declaration(), contract: 3,
  dashboard: { title: 'Fixture', groups: [{ id: 'run', title: 'Run', actions: [
    script('plain'),
    script('with-args', { args: ['--fast', 'two'], env: { BUILD_TYPE: 'RELEASE' } }),
    script('missing-script', { script: 'not-there.sh' }),
    script('directory-script', { script: 'tools.sh' }),
    script('escaping-script', { script: 'escape.sh' }),
    { id: 'logger', title: 'Log stream', kind: 'log', command: ['/bin/echo', 'LOG_LINE'], filters: ['LOG'] },
    { id: 'shot', title: 'Screenshot', kind: 'capture', command: ['/bin/echo'], into: '.cache/captures', format: 'png' },
    { id: 'play', title: 'Play', kind: 'game', game: 'fixture-game' },
  ] }] },
  games: [{ id: 'fixture-game', title: 'Fixture game', executable: ['./hello.sh'], surface: 'external' }],
});

export const CASES = [
  ['a script action', 'plain'],
  ['a script action with arguments and an environment', 'with-args'],
  ['a script action naming a file that is not there', 'missing-script'],
  ['a script action naming a directory', 'directory-script'],
  ['a script action naming a path that leaves the project', 'escaping-script'],
  ['a log action', 'logger'],
  ['a capture action', 'shot'],
  ['a game action', 'play'],
];

export async function fixtureFor(directory, name) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  /* A directory that a `script` may lexically name: the schema requires the `.sh` spelling, so the
     "not a file" refusal needs a directory spelled that way to be reachable at all. */
  await mkdir(path.join(root, 'tools.sh'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(board()));
  await writeFile(path.join(root, 'hello.sh'), '#!/bin/bash\necho hello\n');
  await chmod(path.join(root, 'hello.sh'), 0o755);
  const outside = path.join(directory, `${name}-outside`);
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'escape.sh'), '#!/bin/bash\necho outside\n');
  await symlink(path.join(outside, 'escape.sh'), path.join(root, 'escape.sh'));
  return root;
}

/* The project it ran in, and whichever bash this machine has. Neither is a rule. */
export const fold = (value, root, bash) =>
  JSON.parse(JSON.stringify(value).split(root).join('<root>').split(bash).join('<bash>'));

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./run-payload-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

export async function answers() {
  const { dashboardAction, dashboardRunPayload } = await import('../server/dashboard.mjs');
  const { bashPath } = await import('../server/sessions-client.mjs');
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-run-payload-')));
  const recorded = {};
  try {
    for (const [name, actionId] of CASES) {
      const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
      const root = { id: `root-${slug}`, path: await fixtureFor(directory, slug), name: 'fixture' };
      try {
        const action = await dashboardAction(root, actionId, undefined);
        recorded[name] = { ok: fold(await dashboardRunPayload(root, action), root.path, bashPath()) };
      } catch (error) {
        recorded[name] = { refused: { message: fold(error.message, root.path, bashPath()), status: error.status ?? null } };
      }
    }
    return recorded;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}
