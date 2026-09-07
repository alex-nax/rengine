import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readDeclaration, CONTRACTS } from '../server/formats.mjs';
import { projectTracker, credential, forget } from '../server/tracker.mjs';

const FORMAT = { id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' };
const base = tracker => ({ contract: 5, project: 'kohai', formats: [FORMAT], ...(tracker ? { tracker } : {}) });

async function project(directory, name, declaration, inventory) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration));
  if (inventory) await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory));
  return { id: name, path: root };
}
const read = async root => projectTracker(root, await readDeclaration(root));

const INVENTORY = {
  schema_version: 1, project: 'kohai', review_status: 'approved',
  features: [
    { id: 1, description: 'done', passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high' },
    { id: 2, description: 'ready', passes: false, dependencies: [1], milestone: 'O1', category: 'workspace', priority: 'medium' },
    { id: 3, description: 'blocked', passes: false, dependencies: [2], milestone: 'O2', category: 'design', priority: 'low' },
  ],
};

test('the local backend reads the inventory and derives the same readiness the tool reports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-local-'));
  try {
    const declared = await project(directory, 'declared', base({ provider: 'local' }), INVENTORY);
    const result = await read(declared);
    assert.equal(result.provider, 'local');
    assert.equal(result.fresh, true, 'a file read is never stale');
    const byKey = Object.fromEntries(result.rows.map(row => [row.key, row]));
    assert.equal(byKey.F1.state.category, 'completed');
    assert.equal(byKey.F2.state.category, 'unstarted', 'its only dependency passes, so it is ready');
    assert.equal(byKey.F3.state.category, 'blocked', 'its dependency does not pass');
    assert.deepEqual(byKey.F3.blockedBy, ['F2']);
    assert.deepEqual(byKey.F1.labels, ['O1', 'workspace']);

    // A project that declares nothing still shows its own inventory: that is the default backend.
    const bare = await project(directory, 'bare', null, INVENTORY);
    const fallback = await read(bare);
    assert.equal(fallback.provider, 'local');
    assert.equal(fallback.rows.length, 3);

    // The common case, and the one this repository itself is in: a project that declares formats and
    // a dashboard but no tracker at all. It must still show its own inventory rather than nothing.
    const other = await project(directory, 'other',
      { contract: 2, project: 'kohai', formats: [FORMAT], dashboard: { title: 'D', groups: [] } }, INVENTORY);
    const implicit = await read(other);
    assert.equal(implicit.provider, 'local', 'an older contract with no tracker block still reads its inventory');
    assert.equal(implicit.rows.length, 3);

    // A project with neither says so rather than showing an empty list as if it were finished.
    const empty = await project(directory, 'empty', base({ provider: 'local' }), null);
    const missing = await read(empty);
    assert.match(missing.unavailable ?? '', /features\.json is not in this project/);
    assert.deepEqual(missing.rows, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a declaration names the locator its provider needs, and carries no credential', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-declare-'));
  try {
    const beyond = CONTRACTS.at(-1) + 1;
    const early = await project(directory, 'early', { ...base({ provider: 'linear', team: 'KOH' }), contract: 4 });
    assert.match((await readDeclaration(early)).trackerError ?? '', /tracker requires contract 5 \(declared contract 4\)/);

    const noTeam = await project(directory, 'no-team', base({ provider: 'linear' }));
    assert.match((await readDeclaration(noTeam)).trackerError ?? '', /requires team for provider linear/);

    const crossed = await project(directory, 'crossed', base({ provider: 'linear', team: 'KOH', repository: 'o/n' }));
    assert.match((await readDeclaration(crossed)).trackerError ?? '', /repository belongs to provider github/);

    // A secret has no home in the declaration at all: the schema refuses the key outright.
    const secret = await project(directory, 'secret', base({ provider: 'linear', team: 'KOH', token: 'lin_api_x' }));
    assert.match((await readDeclaration(secret)).trackerError ?? '', /unknown key token/);

    const future = await project(directory, 'future', { ...base({ provider: 'local' }), contract: beyond });
    assert.match((await readDeclaration(future)).error ?? '', new RegExp(`unknown contract ${beyond}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a Linear team reaches the neutral row, and its states keep their own names', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-linear-'));
  forget();
  try {
    const root = await project(directory, 'kohai', base({ provider: 'linear', team: 'KOH' }));
    const state = path.join(directory, 'state');
    await mkdir(path.join(state, 'trackers'), { recursive: true });
    await writeFile(path.join(state, 'trackers', 'kohai.token'), 'lin_api_fixture\n');
    assert.equal(await credential(state, 'kohai'), 'lin_api_fixture', 'the token is read from the workspace state');

    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url, auth: options.headers.Authorization, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [
        { id: 'uuid-1', identifier: 'KOH-12', title: 'Wire the intake form', url: 'https://linear.app/kohai/issue/KOH-12',
          priority: 1, updatedAt: '2026-09-07T08:00:00.000Z',
          state: { id: 's1', name: 'In Review', type: 'started' },
          assignee: { displayName: 'Alex' }, labels: { nodes: [{ name: 'frontend' }] },
          relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'KOH-9' } }] } },
        { id: 'uuid-2', identifier: 'KOH-13', title: 'Icebox idea', url: 'https://linear.app/kohai/issue/KOH-13',
          priority: 0, updatedAt: '2026-09-06T08:00:00.000Z',
          state: { id: 's2', name: 'Icebox', type: 'backlog' }, assignee: null, labels: { nodes: [] }, relations: { nodes: [] } },
      ] } } }) };
    };
    const result = await projectTracker(root, await readDeclaration(root), { stateDirectory: state, fetch: fetchImpl });
    assert.equal(result.provider, 'linear');
    assert.equal(seen.length, 1, 'one request');
    assert.equal(seen[0].auth, 'lin_api_fixture', 'a personal key is sent bare, with no Bearer prefix');
    assert.equal(seen[0].body.variables.team, 'KOH');
    assert.equal(seen[0].body.variables.project, null, 'a team without a project filter passes null, not a missing variable');

    const [first, second] = result.rows;
    assert.equal(first.key, 'KOH-12');
    assert.equal(first.state.name, 'In Review', 'the team names its own states');
    assert.equal(first.state.category, 'started', 'and the category is the shared vocabulary');
    assert.equal(first.priority, 'urgent', 'Linear counts 1 as the most urgent');
    assert.deepEqual(first.blockedBy, ['KOH-9']);
    assert.deepEqual(first.labels, ['frontend']);
    assert.equal(first.assignee, 'Alex');
    assert.equal(second.priority, null, 'zero means no priority, not the lowest');
    assert.equal(second.state.category, 'backlog');

    // A second read inside the window is served from cache rather than spending the budget again.
    await projectTracker(root, await readDeclaration(root), { stateDirectory: state, fetch: fetchImpl });
    assert.equal(seen.length, 1, 'the cached list costs no request');
    await projectTracker(root, await readDeclaration(root), { stateDirectory: state, fetch: fetchImpl, refresh: true });
    assert.equal(seen.length, 2, 'an explicit refresh does spend one');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a Linear tracker can narrow a team to one project', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-project-'));
  forget();
  try {
    const root = await project(directory, 'kohai', base({ provider: 'linear', team: 'BAS', project: 'Kohai' }));
    const declared = await readDeclaration(root);
    assert.equal(declared.trackerError, undefined, declared.trackerError);
    assert.equal(declared.tracker.project, 'Kohai');
    const state = path.join(directory, 'state');
    await mkdir(path.join(state, 'trackers'), { recursive: true });
    await writeFile(path.join(state, 'trackers', 'kohai.token'), 'lin_api_fixture');
    let variables = null;
    await projectTracker(root, declared, { stateDirectory: state, fetch: async (url, options) => {
      variables = JSON.parse(options.body).variables;
      return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [] } } }) };
    } });
    assert.equal(variables.team, 'BAS');
    assert.equal(variables.project, 'Kohai', 'the project reaches the query, or the view shows the whole team');

    // The filter belongs to Linear; naming it elsewhere is refused rather than ignored.
    const wrong = await project(directory, 'wrong', base({ provider: 'github', repository: 'o/n', project: 'Kohai' }));
    assert.match((await readDeclaration(wrong)).trackerError ?? '', /project belongs to provider linear/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a tracker without a token, or without a network, says which and keeps what it had', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-degrade-'));
  forget();
  try {
    const root = await project(directory, 'kohai', base({ provider: 'linear', team: 'KOH' }));
    const state = path.join(directory, 'state');
    const declared = await readDeclaration(root);

    const denied = await projectTracker(root, declared, { stateDirectory: state, fetch: async () => { throw new Error('unreachable'); } });
    assert.match(denied.denied ?? '', /Not signed in to Linear/, denied.denied);
    assert.equal(denied.signIn, 'linear', 'and it says which provider to sign in to, so the view can offer it');
    assert.deepEqual(denied.rows, [], 'and no rows are invented');

    await mkdir(path.join(state, 'trackers'), { recursive: true });
    await writeFile(path.join(state, 'trackers', 'kohai.token'), 'lin_api_fixture');
    forget();
    const limited = await projectTracker(root, declared, { stateDirectory: state, fetch: async () => ({
      ok: true, status: 200, json: async () => ({ errors: [{ message: 'RATELIMITED: too many requests' }] }) }) });
    assert.match(limited.unavailable ?? '', /rate limit/i, 'a Linear rate limit is a 400, not a 429');

    forget();
    const refused = await projectTracker(root, declared, { stateDirectory: state, fetch: async () => ({ ok: false, status: 401 }) });
    assert.match(refused.denied ?? '', /refused the token/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a GitHub repository reaches the same row, and pull requests are not tasks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-github-'));
  forget();
  try {
    const root = await project(directory, 'kohai', base({ provider: 'github', repository: 'kohai/hirebase' }));
    const state = path.join(directory, 'state');
    await mkdir(path.join(state, 'trackers'), { recursive: true });
    await writeFile(path.join(state, 'trackers', 'kohai.token'), 'ghp_fixture');
    let requested = '';
    const result = await projectTracker(root, await readDeclaration(root), { stateDirectory: state, fetch: async (url, options) => {
      requested = url;
      assert.equal(options.headers.Authorization, 'Bearer ghp_fixture', 'GitHub takes a Bearer token');
      return { ok: true, status: 200, json: async () => ([
        { id: 1, number: 7, title: 'Open one', html_url: 'https://github.com/kohai/hirebase/issues/7', state: 'open', labels: [{ name: 'bug' }], assignee: { login: 'alex' }, updated_at: '2026-09-07T00:00:00Z' },
        { id: 2, number: 8, title: 'Wont do', html_url: 'https://x/8', state: 'closed', state_reason: 'not_planned', labels: [], assignee: null, updated_at: '2026-09-06T00:00:00Z' },
        { id: 3, number: 9, title: 'A pull request', html_url: 'https://x/9', state: 'open', pull_request: {}, labels: [], updated_at: '2026-09-05T00:00:00Z' },
      ]) };
    } });
    assert.match(requested, /repos\/kohai\/hirebase\/issues\?state=all/);
    assert.equal(result.rows.length, 2, 'the pull request is not a task');
    assert.equal(result.rows[0].key, '#7');
    assert.equal(result.rows[0].state.category, 'unstarted');
    assert.equal(result.rows[1].state.category, 'canceled', 'closed as not planned is not completed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
