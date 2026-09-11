/* Task tracking with a declared backend (spec 083).
 *
 * The view reads and never writes: neither GitHub nor Linear offers concurrency control on an issue
 * write, so every write from here would be last-write-wins against whatever a teammate just did in
 * the web interface. Reading has no such failure mode.
 *
 * Every provider answers the same neutral row, and the vocabulary is deliberately not HTTP-shaped:
 * the local backend is a file read whose conflicts are git merges resolved by a person, and forcing
 * it to speak in status codes would distort the backend this project actually uses.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, resolveInRoot } from './store.mjs';
import { parseCredential, expiring, refresh } from './tracker-auth.mjs';
import { validateSchema } from './schema.mjs';

const PROBE_TTL_MS = 30000;          /* one poll every 30 s is about 5% of a Linear key's budget */
const CACHE_LIMIT = 64;
const cache = new Map();

/* A remote list is cached with in-flight coalescing, the shape the devices probe established: two
   callers arriving together share one request rather than spending the budget twice. The local
   backend is a file read and is never cached, because it is always current and a staleness
   indicator on something that cannot be stale would be a lie. */
async function coalesced(key, produce) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < PROBE_TTL_MS)) return hit.value;
  const entry = { pending: true, at: Date.now(), value: produce() };
  cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  try {
    entry.value = await entry.value;
    return entry.value;
  } catch (error) {
    cache.delete(key);
    throw error;
  } finally {
    entry.pending = false;
    entry.at = Date.now();
  }
}
export function forget() { cache.clear(); }

/* The token lives beside the workspace state and never in the committed declaration. Keyed by the
   declared project identity rather than a root id, so a person can create it by name. */
export async function credential(stateDirectory, project, options = {}) {
  if (!stateDirectory || !project) return null;
  const file = path.join(stateDirectory, 'trackers', `${project}.token`);
  let grant;
  try {
    grant = parseCredential(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!grant) return null;
  /* A signed-in grant is refreshed before it lapses; a pasted personal key never expires and is
     handed back untouched. A refresh that fails keeps the token it had, because Linear allows the
     request to be replayed for thirty minutes and a cleared grant could not use that. */
  if (expiring(grant)) grant = await refresh(stateDirectory, project, grant, options);
  return grant.accessToken ?? null;
}

/* The neutral row. State is (id, name, category) and never a boolean: a two-value enum cannot
   represent Linear's team-defined workflow states, and a local row's `passes` is never read back
   from a provider as truth. */
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'blocked'];
const row = value => ({
  id: String(value.id),
  key: value.key ?? String(value.id),
  title: value.title ?? '',
  state: { id: value.stateId ?? '', name: value.stateName ?? '', category: value.category ?? 'backlog' },
  priority: value.priority ?? null,
  labels: value.labels ?? [],
  assignee: value.assignee ?? null,
  url: value.url ?? null,
  updatedAt: value.updatedAt ?? null,
  blockedBy: value.blockedBy ?? [],
  /* Added for spec 103: the prompt a spawned agent is seeded with says what "done" means, and only
     the local backend has that written down. A remote row answers with an empty list rather than
     with the issue body, which is prose rather than criteria. */
  criteria: value.criteria ?? [],
  /* Added for spec 116: what a criterion claims and what proves it are one question, and reading
     them apart is what left the Tasks tab unable to answer "which test backs this". Same empty-list
     rule as criteria, and for the same reason — an issue body is prose, not an evidence list. */
  evidence: value.evidence ?? [],
  /* Added for spec 117: the entries a project's own tests manifest records for this task. rEngine
     joins them by the provider's key and runs nothing; an entry never moves a row. */
  tests: value.tests ?? [],
});

/* Local. Readiness follows the same rule tools/features.py applies, so the view and the command
   line cannot disagree about what is blocked. */
function localState(feature, byId) {
  if (feature.passes) return { stateId: 'passing', stateName: 'passing', category: 'completed' };
  const unmet = (feature.dependencies ?? []).some(id => !byId.get(id)?.passes);
  if (unmet) return { stateId: 'blocked', stateName: 'blocked', category: 'blocked' };
  return { stateId: 'ready', stateName: 'ready', category: 'unstarted' };
}
async function localRows(root, block) {
  const name = block.inventory ?? 'features.json';
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root.path, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { rows: [], unavailable: `${name} is not in this project.` };
    return { rows: [], invalid: [`${name}: ${error.message}`] };
  }
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  const byId = new Map(features.map(feature => [feature.id, feature]));
  return {
    rows: features.map(feature => row({
      id: feature.id,
      key: `F${feature.id}`,
      title: feature.description,
      ...localState(feature, byId),
      priority: feature.priority ?? null,
      labels: [feature.milestone, feature.category].filter(Boolean),
      assignee: feature.owner_workspace ?? null,
      blockedBy: (feature.dependencies ?? []).map(id => `F${id}`),
      criteria: Array.isArray(feature.acceptance_criteria) ? feature.acceptance_criteria : [],
      evidence: Array.isArray(feature.evidence) ? feature.evidence.filter(item => typeof item === 'string') : [],
    })),
  };
}

/* Linear. A personal API key sends the token bare, without a Bearer prefix, which is the one thing
   about its auth that surprises everyone. States are objects carrying a category, so they reach the
   neutral row without being flattened into open and closed. */
/* The whole filter is one variable, so this document is a fixed string whatever the declaration
   narrows to; nothing is interpolated into it. See linearFilter for what goes in. */
const LINEAR_QUERY = `query Issues($filter: IssueFilter, $first: Int!) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {
      id identifier title url priority updatedAt
      state { id name type }
      assignee { displayName }
      labels(first: 10) { nodes { name } }
      relations(first: 20) { nodes { type relatedIssue { identifier } } }
    }
  }
}`;
const LINEAR_PRIORITY = [null, 'urgent', 'high', 'medium', 'low'];

/* An undeclared narrowing contributes no clause, so the two-clause object below is byte-identical to
   what the previous document produced and an existing declaration asks exactly what it always did.
   The project clause stays null-safe: present and null leaves the team unfiltered (spec 100). */
function linearFilter(block) {
  const filter = { team: { key: { eq: block.team } }, project: { name: { eq: block.project ?? null } } };
  /* "me" is the one assignee value that is not a name: it asks Linear who the token belongs to, so a
     personal declaration keeps working when someone else's token reads it. */
  if (block.assignee !== undefined) filter.assignee = block.assignee === 'me' ? { isMe: { eq: true } } : { displayName: { eq: block.assignee } };
  /* Declared categories are the row's own vocabulary, which is Linear's state type. */
  if (block.states !== undefined) filter.state = { type: { in: block.states } };
  return filter;
}

async function linearRows(block, token, fetchImpl) {
  if (!token) return { rows: [], denied: 'Not signed in to Linear.', signIn: 'linear' };
  const response = await fetchImpl('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query: LINEAR_QUERY, variables: { filter: linearFilter(block), first: 100 } }),
  });
  if (response.status === 401 || response.status === 403) return { rows: [], denied: 'Linear refused the token.' };
  if (!response.ok) return { rows: [], unavailable: `Linear answered ${response.status}.` };
  const body = await response.json();
  if (body.errors?.length) {
    const message = body.errors.map(error => error.message).join('; ');
    /* Linear reports its rate limit as a 400 carrying a RATELIMITED error rather than a 429. */
    if (/ratelimit/i.test(message)) return { rows: [], unavailable: 'Linear rate limit reached; the list refreshes shortly.' };
    return { rows: [], invalid: body.errors.map(error => error.message) };
  }
  const nodes = body.data?.issues?.nodes ?? [];
  return {
    rows: nodes.map(issue => row({
      id: issue.id,
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      stateId: issue.state?.id,
      stateName: issue.state?.name,
      category: issue.state?.type,
      priority: LINEAR_PRIORITY[issue.priority] ?? null,
      labels: (issue.labels?.nodes ?? []).map(label => label.name),
      assignee: issue.assignee?.displayName ?? null,
      updatedAt: issue.updatedAt,
      blockedBy: (issue.relations?.nodes ?? [])
        .filter(relation => relation.type === 'blocks')
        .map(relation => relation.relatedIssue?.identifier)
        .filter(Boolean),
    })),
  };
}

/* GitHub. State is open or closed with a reason, so the category is derived rather than read. */
async function githubRows(block, token, fetchImpl) {
  if (!token) return { rows: [], denied: `No GitHub token. Put one in the workspace state directory as trackers/${block.identity}.token` };
  const url = `https://api.github.com/repos/${block.repository}/issues?state=all&sort=updated&direction=desc&per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status === 401 || response.status === 403) return { rows: [], denied: 'GitHub refused the token.' };
  if (response.status === 404) return { rows: [], invalid: [`${block.repository} is not reachable with this token.`] };
  if (!response.ok) return { rows: [], unavailable: `GitHub answered ${response.status}.` };
  const issues = (await response.json()).filter(issue => !issue.pull_request);
  return {
    rows: issues.map(issue => row({
      id: issue.id,
      key: `#${issue.number}`,
      title: issue.title,
      url: issue.html_url,
      stateId: issue.state,
      stateName: issue.state_reason ?? issue.state,
      category: issue.state === 'closed' ? (issue.state_reason === 'not_planned' ? 'canceled' : 'completed') : 'unstarted',
      labels: (issue.labels ?? []).map(label => (typeof label === 'string' ? label : label.name)),
      assignee: issue.assignee?.login ?? null,
      updatedAt: issue.updated_at,
    })),
  };
}

/* The project's tests manifest (contract 10, spec 117). Read here rather than in the declaration
   because it is the project's own artifact with its own lifetime, exactly as the local inventory is.
   Nothing in here opens a test, runs anything, or lets an entry change a row's state. */
const TESTS_SCHEMA = JSON.parse(await readFile(new URL('../../contracts/task-tests-v1.schema.json', import.meta.url), 'utf8'));

/* The checkout's own revision, read from files and never by running git: a subprocess for a display
   detail is a cost and a permission this reader should not take. A layout it cannot follow answers
   null, so "stale" and "cannot tell" stay different answers. */
async function headCommit(rootPath) {
  try {
    const head = (await readFile(path.join(rootPath, '.git', 'HEAD'), 'utf8')).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.startsWith('ref: ') ? head.slice(5).trim() : null;
    if (!ref) return null;
    const value = (await readFile(path.join(rootPath, '.git', ref), 'utf8')).trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null; /* packed refs are a follow-up; unknown beats a guess */
  } catch { return null; }
}

async function withTests(root, declared, result) {
  const manifest = declared?.tests?.manifest;
  if (!manifest) return result;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root.path, manifest), 'utf8'));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return { ...result, testsError: `${manifest}: ${missing ? 'the declared tests manifest is not in this project.' : error.message}` };
  }
  const problems = validateSchema(TESTS_SCHEMA, parsed, TESTS_SCHEMA, '$');
  if (problems.length) return { ...result, testsError: `${manifest}: ${problems.slice(0, 3).join('; ')}` };

  const byTask = new Map();
  for (const entry of parsed.entries ?? []) {
    if (!byTask.has(entry.task)) byTask.set(entry.task, []);
    byTask.get(entry.task).push(entry);
  }
  /* A manifest drifts from its inventory the moment a criterion is renumbered, and a claim pointing
     past the task's criteria reads as coverage it does not have — worse than claiming none. Only a
     provider that knows its own criteria can be checked, so the others carry the index unjudged. */
  const drift = [];
  for (const row of result.rows ?? []) {
    for (const entry of byTask.get(row.key) ?? []) {
      for (const index of entry.criteria ?? []) {
        if (row.criteria.length && index > row.criteria.length) {
          drift.push(`${manifest}: ${row.key} claims criterion ${index}, but the task has ${row.criteria.length} criterion${row.criteria.length === 1 ? '' : 's'}`);
        }
      }
    }
  }
  const head = await headCommit(root.path);
  /* An artifact is answered for HERE rather than when someone clicks it, so a row can say "missing"
     or "outside this project" instead of a click failing. rEngine still opens nothing it was not
     asked to open and still produces nothing: this is a resolve and a stat (spec 126). */
  const outside = [];
  const settle = async artifact => {
    const label = typeof artifact.label === 'string' ? artifact.label : '';
    try {
      const { relative } = await resolveInRoot(root, artifact.path, true);
      let state = 'ok';
      try { await stat(path.join(root.path, relative)); } catch { state = 'missing'; }
      return { path: relative, label, state };
    } catch {
      outside.push(artifact.path);
      return { path: artifact.path, label, state: 'outside' };
    }
  };
  const rows = await Promise.all((result.rows ?? []).map(async row => ({
    ...row,
    tests: await Promise.all((byTask.get(row.key) ?? []).map(async entry => ({
      ...entry,
      /* The field the format exists for: a green run says a command went green, and only a sabotage
         row says the test can go red for its own reason (AGENTS.md). Never collapsed into one word. */
      proven: Array.isArray(entry.sabotage) && entry.sabotage.length > 0,
      ...(Array.isArray(entry.last?.artifacts)
        ? { last: { ...entry.last, artifacts: await Promise.all(entry.last.artifacts.map(settle)) } }
        : {}),
    }))),
  })));
  if (outside.length) drift.push(`${manifest}: ${outside.slice(0, 3).map(p => `${p} is outside this project`).join('; ')}`);
  return {
    ...result, rows,
    tests: { at: parsed.at ?? null, commit: parsed.commit ?? null, count: parsed.entries?.length ?? 0,
             current: head && parsed.commit ? head === parsed.commit : null },
    ...(drift.length ? { testsError: drift.slice(0, 3).join('; ') } : {}),
  };
}

export async function projectTracker(root, declared, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = { rootId: root.id, declared: declared.declared === true, provider: null, rows: [], categories: CATEGORIES };
  /* A project that declares nothing at all still has its own inventory if it keeps one, which is
     the default backend and the one this repository uses. */
  if (!declared.declared) return { ...base, provider: 'local', ...(await localRows(root, {})), fresh: true };
  if (declared.error) return { ...base, error: declared.error };
  if (declared.trackerError) return { ...base, contract: declared.contract, error: declared.trackerError };
  /* A project that declares no tracker still has its own inventory, which is the default backend. */
  const block = declared.tracker ?? { provider: 'local' };
  /* `identity` is the declared project name the token file is keyed by; `project` inside the block
     is Linear's project filter. Naming both `project` made the filter silently take the token's
     value, which the tests caught by asserting the variable that reaches the query. */
  const named = { ...block, identity: declared.project ?? root.id };
  const result = { ...base, contract: declared.contract, provider: block.provider };
  if (block.provider === 'local') return withTests(root, declared, { ...result, ...(await localRows(root, block)), fresh: true });

  if (typeof fetchImpl !== 'function') fail('This build cannot reach a network tracker.', 501);
  const token = await credential(options.stateDirectory, named.identity, options);
  /* The narrowing is part of the key: two declarations that ask different questions are different
     questions, and answering the second from the first's entry would be wrong rather than stale. */
  const key = [root.id, block.provider, block.repository ?? block.team, block.project ?? '', block.assignee ?? '', (block.states ?? []).join(',')].join(' ');
  if (options.refresh) cache.delete(key);
  const produce = () => (block.provider === 'linear'
    ? linearRows(named, token, fetchImpl)
    : githubRows(named, token, fetchImpl));
  const entry = await coalesced(key, produce);
  const at = cache.get(key)?.at ?? Date.now();
  return withTests(root, declared, { ...result, ...entry, fresh: Date.now() - at < PROBE_TTL_MS, checkedAt: new Date(at).toISOString() });
}
