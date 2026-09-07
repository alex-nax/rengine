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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './store.mjs';
import { parseCredential, expiring, refresh } from './tracker-auth.mjs';

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
  if (block.provider === 'local') return { ...result, ...(await localRows(root, block)), fresh: true };

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
  return { ...result, ...entry, fresh: Date.now() - at < PROBE_TTL_MS, checkedAt: new Date(at).toISOString() };
}
