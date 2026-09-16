/* The answers `tracker.mjs`'s LOCAL half gives, recorded before it is replaced (F153, spec 100,
 * spec 116, spec 117).
 *
 * The local backend is this repository's own: a project's `features.json` read as neutral rows,
 * with the readiness `tools/features.py` applies, so the Tasks tab and the command line cannot
 * disagree about what is blocked. Joined onto it is the tests manifest of spec 117 — what a
 * criterion claims and what proves it — which rEngine READS and never runs.
 *
 *   node tests/tracker-corpus.mjs > tests/tracker-corpus.json
 *
 * Regenerate ONLY from a checkout where `tracker.mjs` still reads the inventory. The remote
 * providers are not here: they need a network client, and F154 owns that decision.
 */
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const feature = (id, extra = {}) => ({
  id, description: `Feature ${id}`, milestone: 'M1', category: 'workspace', priority: 'medium',
  acceptance_criteria: [`${id} does the thing`, `${id} does the other thing`],
  passes: false, dependencies: [], owner_workspace: 'rengine', deliverable: 'a thing', evidence: [], ...extra,
});
const inventory = (features) => ({ schema_version: 1, project: 'fixture', created: '2026-01-01', review_status: 'approved', features });

const entry = (extra = {}) => ({
  task: 'F2', test: { path: 'tests/thing.test.mjs', name: 'the thing holds' },
  claim: 'the thing holds when the other thing does not', criteria: [1], ...extra,
});
const manifest = (entries, extra = {}) => ({ version: 1, at: '2026-09-14T00:00:00.000Z', commit: HEAD, entries, ...extra });

/* Each case is the declaration the reader is handed and the files beside it. `git` writes a HEAD so
   a manifest's commit can be current or not; `tests` writes the manifest the declaration names. */
export const CASES = [
  ['no declaration at all', { declared: { declared: false }, features: inventory([feature(1), feature(2)]) }],
  ['a declaration that would not read', { declared: { declared: true, error: '.rengine/project.json: broken' } }],
  ['a tracker block that would not read', { declared: { declared: true, contract: 6, trackerError: '.rengine/project.json: $.tracker is wrong' } }],
  ['a declaration that names no tracker', { declared: { declared: true, contract: 6 }, features: inventory([feature(1)]) }],

  ['an inventory this project does not have', { declared: { declared: true, contract: 6, tracker: { provider: 'local' } } }],
  ['an inventory that is not JSON', { declared: { declared: true, contract: 6, tracker: { provider: 'local' } }, raw: '{ not json' }],
  ['an inventory under a name the declaration gives', { declared: { declared: true, contract: 6, tracker: { provider: 'local', inventory: 'tasks/backlog.json' } },
    named: ['tasks/backlog.json', inventory([feature(1, { passes: true })])] }],

  /* Readiness follows features.py: passing, blocked by an unmet dependency, otherwise ready. */
  ['readiness: passing, blocked and ready', { declared: { declared: true, contract: 6, tracker: { provider: 'local' } },
    features: inventory([feature(1, { passes: true }), feature(2, { dependencies: [1] }), feature(3, { dependencies: [2] }), feature(4)]) }],
  ['a row carries its criteria, labels, owner and blockers', { declared: { declared: true, contract: 6, tracker: { provider: 'local' } },
    features: inventory([feature(9, { dependencies: [1, 2], evidence: ['first', 'second'], priority: 'high' })]) }],
  ['an inventory whose features key is not a list', { declared: { declared: true, contract: 6, tracker: { provider: 'local' } }, raw: '{"features":"no"}' }],

  /* --- the tests manifest (spec 117) ---------------------------------------------------------- */
  ['a declared manifest this project does not have', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]) }],
  ['a manifest the schema refuses', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), tests: { version: 1, entries: [{ task: 'F2' }] } }],
  ['a manifest joined onto the rows it names', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2), feature(3)]), git: HEAD, tests: manifest([entry(), entry({ task: 'F3', claim: 'another thing holds' })]) }],
  /* A green run says a command went green; only a sabotage row says the test can go red for its own
     reason (AGENTS.md). Never collapsed into one word. */
  ['an entry with a sabotage is proven, and one without is not', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), git: HEAD, tests: manifest([entry({ sabotage: [{ break: 'removed the guard', red: 'the guard test, for its own reason' }] }), entry({ claim: 'unproven but green' })]) }],
  ['a manifest whose commit is not this checkout', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), git: OTHER, tests: manifest([entry()]) }],
  ['a manifest with no commit at all', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), git: HEAD, tests: { version: 1, entries: [entry()] } }],
  /* A claim pointing past the task's criteria reads as coverage it does not have. */
  ['a claim past the task’s own criteria', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), git: HEAD, tests: manifest([entry({ criteria: [1, 9] })]) }],
  /* An artifact is answered for here rather than when someone clicks it. */
  ['artifacts that are there, missing and outside the project', { declared: { declared: true, contract: 10, tracker: { provider: 'local' }, tests: { manifest: 'tests.json' } },
    features: inventory([feature(2)]), git: HEAD, artifacts: true,
    tests: manifest([entry({ last: { result: 'pass', at: '2026-09-14T00:00:00.000Z', artifacts: [
      { path: 'artifacts/there.txt', label: 'there' }, { path: 'artifacts/gone.txt', label: 'gone' }, { path: '../escape.txt', label: 'escape' },
    ] } })]) }],
];

export const rootIdFor = name => `root-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}`;
/** The project a case is asked about, shared with the harness that judges the replacement. */
export async function fixtureFor(directory, name, options) {
  return fixture(directory, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48), options);
}

async function fixture(directory, name, options) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, 'tasks'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  if (options.features) await writeFile(path.join(root, 'features.json'), JSON.stringify(options.features));
  if (options.raw !== undefined) await writeFile(path.join(root, 'features.json'), options.raw);
  if (options.named) await writeFile(path.join(root, options.named[0]), JSON.stringify(options.named[1]));
  if (options.tests) await writeFile(path.join(root, 'tests.json'), JSON.stringify(options.tests));
  if (options.git) await writeFile(path.join(root, '.git/HEAD'), `${options.git}\n`);
  if (options.artifacts) {
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await writeFile(path.join(root, 'artifacts/there.txt'), 'here\n');
  }
  return root;
}

/* The one machine-dependent thing a local answer carries is a JSON parser's own wording for a
   document that will not parse — V8 says one thing and serde another. Marked rather than excused. */
export const PARSER_WORDED = 'an inventory that is not JSON';

/* `answers()` used to replay the corpus through tracker.mjs's LOCAL half and is gone with it (F173): a
 * parity proof cannot outlive the side it compares against, so what the module SAID is the evidence
 * now and the module that said it is deleted. The cases and the record below are what the Rust is
 * judged against, and they are frozen — regenerating them from the implementation they check would
 * prove nothing. To change what is asked, add a case and record it from a checkout that still has
 * the JavaScript, which is to say from history.
 */
export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./tracker-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

/* Run directly, this says so rather than failing on a name that is not there. A recorder whose
   subject is gone is not broken — it is finished. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.error('tracker-corpus.json is frozen: server/tracker.mjs is deleted, so there is nothing left to record from.');
  process.exit(1);
}
