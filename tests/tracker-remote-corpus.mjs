/* The answers `tracker.mjs`'s REMOTE half gives, recorded before it is replaced (F154, spec 083,
 * spec 100).
 *
 * The local half's corpus deliberately left these out, because they needed a network client and
 * F154 owned that decision. It is made: `red_core::tls`, with the machine's own trust roots. So
 * these can be recorded the way everything else was — by driving the JavaScript with a provider's
 * answer handed in rather than fetched, and asking the Rust the same question with the same bytes.
 *
 * FROZEN. `tracker.mjs` is deleted, so there is nothing left to record from and this cannot be
 * regenerated — which is the point rather than a limitation (F173): a record that moved with the
 * implementation it checks would prove nothing. To change what is asked, add a case and record it
 * from a checkout that still has the JavaScript, which is to say from history.
 *
 * What is recorded is the whole answer AND the request that produced it: a filter that reaches the
 * provider is the whole of what a declaration means, so a corpus comparing only rows would let a
 * wrong question return the right shape.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
  /* Linear counts 1 as the MOST urgent and 0 as no priority at all, which is the opposite of the
     obvious reading — a list that had them backwards would sort a board upside down. */
  ['linear, the whole priority scale', { declared: linear(), credential: 'lin_api_x',
    answered: { status: 200, body: JSON.stringify({ data: { issues: { nodes: [0, 1, 2, 3, 4, 9].map(priority => ({
      ...ISSUE, id: `p${priority}`, identifier: `KOH-${priority}`, priority,
    })) } } }) } }],
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

/* `answers()` used to replay the corpus through tracker.mjs's REMOTE half and is gone with it (F173): a
 * parity proof cannot outlive the side it compares against, so what the module SAID is the evidence
 * now and the module that said it is deleted. The cases and the record below are what the Rust is
 * judged against, and they are frozen — regenerating them from the implementation they check would
 * prove nothing. To change what is asked, add a case and record it from a checkout that still has
 * the JavaScript, which is to say from history.
 */
export const RECORDED = (() => {
  try { return require('./tracker-remote-corpus.json'); } catch { return null; }
})();

/* Run directly, this says so rather than failing on a name that is not there. A recorder whose
   subject is gone is not broken — it is finished. */
if (process.argv[1] && process.argv[1].endsWith('tracker-remote-corpus.mjs')) {
  console.error('tracker-remote-corpus.json is frozen: server/tracker.mjs is deleted, so there is nothing left to record from.');
  process.exit(1);
}
