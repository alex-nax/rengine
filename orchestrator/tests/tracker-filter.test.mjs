/* The Linear filter a declaration builds (spec 100).
 *
 * Every assertion here reads the object that actually reaches the request body rather than the rows
 * that come back. Spec 083 recorded why: naming the credential key and the project filter both
 * `project` made the filter silently take the token file's name, and only an assertion on the
 * variable caught it. A filter is exactly the kind of thing whose result looks plausible when it is
 * wrong, so the result is not the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readDeclaration } from '../server/formats.mjs';
import { projectTracker, forget } from '../server/tracker.mjs';

const FORMAT = { id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' };
const base = tracker => ({ contract: 5, project: 'kohai', formats: [FORMAT], tracker });

async function workspace(label, tracker) {
  const directory = await mkdtemp(path.join(tmpdir(), `rengine-tracker-${label}-`));
  const root = { id: label, path: path.join(directory, label) };
  await mkdir(path.join(root.path, '.rengine'), { recursive: true });
  const state = path.join(directory, 'state');
  await mkdir(path.join(state, 'trackers'), { recursive: true });
  await writeFile(path.join(state, 'trackers', 'kohai.token'), 'lin_api_fixture');
  const declare = async block => {
    await writeFile(path.join(root.path, '.rengine', 'project.json'), JSON.stringify(base(block)));
    return readDeclaration(root);
  };
  const sent = [];
  /* One request is one recorded body; a test that asserts on rows could not tell an unsent clause
     from an unhonoured one. */
  const ask = async (declared, options = {}) => {
    forget();
    await projectTracker(root, declared, {
      stateDirectory: state,
      fetch: async (url, request) => { sent.push(JSON.parse(request.body)); return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [] } } }) }; },
      ...options,
    });
    return sent.at(-1);
  };
  const filterFor = async block => (await ask(await declare(block))).variables.filter;
  return { root, state, directory, declare, ask, filterFor, sent, done: () => rm(directory, { recursive: true, force: true }) };
}

const TEAM = { provider: 'linear', team: 'BAS', project: 'Kohai' };
const TEAM_FILTER = { team: { key: { eq: 'BAS' } }, project: { name: { eq: 'Kohai' } } };

test('the filter names the signed-in user, or a person by display name', async () => {
  const w = await workspace('assignee');
  try {
    assert.deepEqual(await w.filterFor({ ...TEAM, assignee: 'me' }),
      { ...TEAM_FILTER, assignee: { isMe: { eq: true } } },
      '"me" is the one value that is not a name: it asks Linear who the token belongs to');

    assert.deepEqual(await w.filterFor({ ...TEAM, assignee: 'jon' }),
      { ...TEAM_FILTER, assignee: { displayName: { eq: 'jon' } } },
      'any other value is a display name');

    // The clauses are built in JavaScript and passed as one variable, so the document never varies.
    const [forMe, forJon] = w.sent;
    assert.equal(forMe.query, forJon.query, 'one document serves every shape');
    assert.match(forMe.query, /\$filter: IssueFilter/, 'the whole filter is a variable');
    assert.match(forMe.query, /filter: \$filter/, 'and it reaches the query only as that variable');
    assert.doesNotMatch(forMe.query, /isMe|jon|eq:/, 'no clause is interpolated into the document');
  } finally { await w.done(); }
});

test('declared states reach the query as the category vocabulary, in declaration order', async () => {
  const w = await workspace('states');
  try {
    assert.deepEqual(await w.filterFor({ ...TEAM, states: ['started'] }),
      { ...TEAM_FILTER, state: { type: { in: ['started'] } } });

    assert.deepEqual(await w.filterFor({ ...TEAM, states: ['started', 'unstarted'] }),
      { ...TEAM_FILTER, state: { type: { in: ['started', 'unstarted'] } } },
      'the categories are the vocabulary the neutral row already normalises to, not team state names');

    assert.deepEqual(await w.filterFor({ ...TEAM, assignee: 'me', states: ['started'] }),
      { ...TEAM_FILTER, assignee: { isMe: { eq: true } }, state: { type: { in: ['started'] } } },
      'and both narrow together');
  } finally { await w.done(); }
});

test('with neither key declared the filter is the one the tracker has always sent', async () => {
  const w = await workspace('unfiltered');
  try {
    const narrowed = await w.filterFor({ provider: 'linear', team: 'BAS', project: 'Kohai' });
    assert.deepEqual(narrowed, TEAM_FILTER);
    assert.deepEqual(Object.keys(narrowed), ['team', 'project'],
      'an undeclared key contributes no clause at all, not an empty one Linear would read as a constraint');

    const whole = await w.filterFor({ provider: 'linear', team: 'BAS' });
    assert.deepEqual(whole, { team: { key: { eq: 'BAS' } }, project: { name: { eq: null } } },
      'a team without a project keeps the null-safe project clause the $project variable produced');
  } finally { await w.done(); }
});

test('a state category outside the vocabulary is refused when it is declared, not when it is queried', async () => {
  const w = await workspace('invalid');
  try {
    const refused = async block => (await w.declare(block)).trackerError ?? '';

    assert.match(await refused({ ...TEAM, states: ['in-progress'] }), /states\[0\] must be one of/,
      '"in-progress" is a team state name; the declaration speaks categories');
    assert.match(await refused({ ...TEAM, states: ['started', 'started'] }), /states repeats an item/);
    assert.match(await refused({ ...TEAM, states: [] }), /states needs at least 1 items/);
    assert.match(await refused({ ...TEAM, states: 'started' }), /states must be array/);
    assert.match(await refused({ ...TEAM, assignee: '' }), /assignee is shorter than 1/);
    assert.match(await refused({ ...TEAM, assignee: 'x'.repeat(65) }), /assignee is longer than 64/);

    // A refused declaration is reported, and the network is never reached to find out.
    const declared = await w.declare({ ...TEAM, states: ['in-progress'] });
    const result = await projectTracker(w.root, declared, {
      stateDirectory: w.state,
      fetch: () => { throw new Error('a refused declaration must not reach Linear'); },
    });
    assert.match(result.error ?? '', /states\[0\] must be one of/);
    assert.deepEqual(result.rows, [], 'and no rows are invented');

    assert.equal((await w.declare({ ...TEAM, assignee: 'me', states: ['started', 'unstarted'] })).trackerError, undefined,
      'the shapes this feature exists for are accepted');
  } finally { await w.done(); }
});

test('both keys belong to Linear, and a backend that cannot honour one refuses it by name', async () => {
  const w = await workspace('provider');
  try {
    const refused = async block => (await w.declare(block)).trackerError ?? '';

    assert.match(await refused({ provider: 'local', assignee: 'me' }), /assignee belongs to provider linear/,
      'the local inventory has an owner_workspace, not a Linear user; silently ignoring the key would be the worse answer');
    assert.match(await refused({ provider: 'local', states: ['started'] }), /states belongs to provider linear/);
    assert.match(await refused({ provider: 'github', repository: 'o/n', assignee: 'me' }), /assignee belongs to provider linear/);
    assert.match(await refused({ provider: 'github', repository: 'o/n', states: ['completed'] }), /states belongs to provider linear/);
  } finally { await w.done(); }
});

test('two declarations that ask different questions do not share one cached answer', async () => {
  const w = await workspace('cache');
  try {
    const mine = await w.declare({ ...TEAM, assignee: 'me', states: ['started'] });
    const everyones = await w.declare({ ...TEAM });
    const record = [];
    const fetchImpl = async (url, request) => { record.push(JSON.parse(request.body).variables.filter); return { ok: true, status: 200, json: async () => ({ data: { issues: { nodes: [] } } }) }; };

    forget();
    await projectTracker(w.root, mine, { stateDirectory: w.state, fetch: fetchImpl });
    await projectTracker(w.root, mine, { stateDirectory: w.state, fetch: fetchImpl });
    assert.equal(record.length, 1, 'the same question inside the window still costs one request');

    await projectTracker(w.root, everyones, { stateDirectory: w.state, fetch: fetchImpl });
    assert.equal(record.length, 2, 'a different filter is a different question, not a stale answer to this one');
    assert.equal(record[1].assignee, undefined);
  } finally { await w.done(); }
});
