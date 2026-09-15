/* The answers `tracker.mjs`'s REMOTE half gives, recorded before it is replaced (F154, spec 083,
 * spec 100).
 *
 * The local half's corpus deliberately left these out, because they needed a network client and
 * F154 owned that decision. It is made: `red_core::tls`, with the machine's own trust roots. So
 * these can be recorded the way everything else was — by driving the JavaScript with a provider's
 * answer handed in rather than fetched, and asking the Rust the same question with the same bytes.
 *
 *   node orchestrator/tests/tracker-remote-corpus.mjs > orchestrator/tests/tracker-remote-corpus.json
 *
 * Regenerate ONLY from a checkout where `tracker.mjs` still reads a provider. A record that moved
 * with the implementation would prove nothing.
 *
 * What is recorded is the whole answer AND the request that produced it: a filter that reaches the
 * provider is the whole of what a declaration means, so a corpus comparing only rows would let a
 * wrong question return the right shape.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT_ID = '11111111-2222-3333-4444-555555555555';
const NOW = 1_700_000_000_000;

const linear = (extra = {}) => ({ contract: 5, project: 'kohai', formats: [], tracker: { provider: 'linear', team: 'KOH', ...extra } });
const github = (extra = {}) => ({ contract: 5, project: 'kohai', formats: [], tracker: { provider: 'github', repository: 'o/r', ...extra } });

const ISSUE = {
  id: 'uuid-1', identifier: 'KOH-12', title: 'A thing', url: 'https://linear.app/x', priority: 2,
  updatedAt: '2026-01-01T00:00:00.000Z', state: { id: 's1', name: 'In Progress', type: 'started' },
  assignee: { displayName: 'Alex' }, labels: { nodes: [{ name: 'bug' }, { name: 'ui' }] },
  relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'KOH-9' } }, { type: 'related', relatedIssue: { identifier: 'KOH-8' } }] },
};
const GITHUB_ISSUES = [
  { id: 1, number: 7, title: 'Open one', html_url: 'https://github.test/7', state: 'open', labels: ['bug', { name: 'ui' }], assignee: { login: 'alex' }, updated_at: '2026-01-01T00:00:00Z' },
  { id: 2, number: 8, title: 'Done', state: 'closed', state_reason: 'completed', labels: [] },
  { id: 3, number: 9, title: 'Dropped', state: 'closed', state_reason: 'not_planned', labels: [] },
  { id: 4, number: 10, title: 'A PR', state: 'open', pull_request: { url: 'x' }, labels: [] },
];

/* Each case is a declaration, whether a credential exists, and what the provider answered. */
export const CASES = [
  ['linear, not signed in', { declared: linear(), credential: null, answered: { status: 200, body: '{}' } }],
  ['linear, a token it refuses', { declared: linear(), credential: 'lin_api_x', answered: { status: 401, body: '' } }],
  ['linear, a provider that is down', { declared: linear(), credential: 'lin_api_x', answered: { status: 500, body: '' } }],
  ['linear, rate limited', { declared: linear(), credential: 'lin_api_x',
    answered: { status: 200, body: JSON.stringify({ errors: [{ message: 'RATELIMITED: too many' }] }) } }],
  ['linear, a declaration that asks for nothing real', { declared: linear(), credential: 'lin_api_x',
    answered: { status: 200, body: JSON.stringify({ errors: [{ message: 'no such team' }] }) } }],
  ['linear, rows', { declared: linear(), credential: 'lin_api_x',
    answered: { status: 200, body: JSON.stringify({ data: { issues: { nodes: [ISSUE] } } }) } }],
  ['linear, narrowed by project, assignee and states', { declared: linear({ project: 'Platform', assignee: 'Alex', states: ['started', 'unstarted'] }),
    credential: 'lin_api_x', answered: { status: 200, body: JSON.stringify({ data: { issues: { nodes: [] } } }) } }],
  ['linear, narrowed to whoever holds the token', { declared: linear({ assignee: 'me' }), credential: 'lin_api_x',
    answered: { status: 200, body: JSON.stringify({ data: { issues: { nodes: [] } } }) } }],
  ['github, no token', { declared: github(), credential: null, answered: { status: 200, body: '[]' } }],
  ['github, a token it refuses', { declared: github(), credential: 'gh_x', answered: { status: 403, body: '' } }],
  ['github, a repository it cannot see', { declared: github(), credential: 'gh_x', answered: { status: 404, body: '' } }],
  ['github, a provider that is down', { declared: github(), credential: 'gh_x', answered: { status: 502, body: '' } }],
  ['github, rows', { declared: github(), credential: 'gh_x', answered: { status: 200, body: JSON.stringify(GITHUB_ISSUES) } }],
];

/* A stand-in provider: it records what it was asked and answers what the case says. */
function stub(answered, asked) {
  return async (url, options = {}) => {
    asked.push(options.body ? { url, body: JSON.parse(options.body) } : { url });
    return {
      ok: answered.status >= 200 && answered.status < 300,
      status: answered.status,
      json: async () => JSON.parse(answered.body || '{}'),
    };
  };
}

/** Every case, through `tracker.mjs` as a caller reaches it. */
export async function answers() {
  const { projectTracker } = await import('../server/tracker.mjs');
  const { forget } = await import('../server/tracker.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-remote-corpus-'));
  const out = {};
  try {
    for (const [name, spec] of CASES) {
      const root = path.join(directory, name.replace(/[^a-z0-9]+/gi, '-'));
      await mkdir(path.join(root, '.rengine'), { recursive: true });
      await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(spec.declared));
      const state = path.join(root, 'state');
      await mkdir(path.join(state, 'trackers'), { recursive: true });
      if (spec.credential) await writeFile(path.join(state, 'trackers', 'kohai.token'), spec.credential);
      const asked = [];
      /* The cache is per-module and keyed by the narrowing, so it is cleared between cases: a corpus
         that answered case six from case five's entry would record the cache, not the provider. */
      forget();
      const declared = { declared: true, ...spec.declared };
      const answer = await projectTracker({ id: ROOT_ID, path: root }, declared,
        { stateDirectory: state, fetch: stub(spec.answered, asked) });
      /* `checkedAt` is a clock reading and `fresh` follows from it, so both are dropped: what is
         recorded is what a provider's answer BECOMES, not when it was read. */
      const { checkedAt, fresh, ...rest } = answer;
      out[name] = { ...rest, asked };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return out;
}

export const RECORDED = (() => {
  try { return require('./tracker-remote-corpus.json'); } catch { return null; }
})();

if (process.argv[1] && process.argv[1].endsWith('tracker-remote-corpus.mjs')) {
  process.stdout.write(`${JSON.stringify(await answers(), null, 2)}\n`);
}
