# Task tracking with pluggable backends (F78)

Date: 2026-09-06. Status: recorded after a design interview. Owner request: "an integration with task
tracking, here and in some of projects we use local tracking checked out to git with a features.json
and py tool(default) but we might want in other projects to set up github issues or linear
integration. So a tracker UI tool is needed."

Parent: [project dashboard](075-project-dashboard.md), [project devices](082-project-devices.md),
charter D26–D27. Shares contract 5 with [project identity](084-project-identity.md).

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The tracker view reads; it does not write. It lists, filters, groups and opens tasks. Local rows keep being edited as JSON in git and validated by the Python tool; a remote issue gets an open-in-browser action. | Owner, against read-write and against a split local-write/remote-read design |
| 2 | A project declares one tracker and the view shows that one. No mirroring, no local-to-remote identifier map, no reconciliation. A project cannot use two at once. | Owner, against mirroring and against a side-by-side view |
| 3 | A credential lives beside the workspace state, never in `.rengine/project.json`, which is committed. The declaration names the provider and the repository or team and nothing secret. | Owner, against an environment variable and against an OS keychain |
| 4 | The `tracker` block is contract 5, shared with the project identity keys of spec 084, so a project bumps its contract once rather than twice. | Recommended, owner-implied by asking for both together |
| 5 | Refresh is a poll with an explicit staleness indicator and a manual refresh. 30 s while the view is visible, longer when it is not. | Codebase- and API-derived; see Constraints |

## Why read-only is the whole feature and not half of one

Neither GitHub nor Linear offers optimistic concurrency on an issue write: there is no `If-Match` on
the issue PATCH and no version field in Linear's `IssueUpdateInput`. Every write from a desktop is
last-write-wins against whatever a teammate just did in the web interface, with no way to detect the
collision. A read-only view has no such failure mode, and the fields a person would most want to
edit are exactly the ones that do not survive the round trip (below).

## What maps, and what does not

Verified against both providers' documentation and Linear's published schema. The dependency array,
which was expected to be the hard case, is not: GitHub has a first-class `blocked_by`/`blocking` API
and Linear has `IssueRelation` with a `blocks` type. The awkward fields are the ones nobody flagged.

| Local row field | GitHub | Linear |
| --- | --- | --- |
| `id` (int) | No writable home. `number` is server-assigned and changes on transfer. | A caller-supplied UUID is accepted on create, so creation could be idempotent. |
| `dependencies[]` | `blocked_by` / `blocking` | `issueRelationCreate` with type `blocks` |
| `milestone` | Repo milestone, good fit | Poor fit; the nearest is a project milestone, which needs a parent project |
| `category` | Label, issue type or a single-select field | Label |
| `priority` | No native field without organisation-level administration | Fixed five-point scale, inverted (1 is Urgent) |
| `passes` (bool) | Collides with open/closed plus a state reason | Collides with seven state categories and team-defined state objects |
| `acceptance_criteria[]` | No structured home | No structured home; Linear has no custom fields at all |
| `evidence` | Comment, body section or a text field | Comment or attachment |

Two consequences the design must respect rather than paper over. State is `(opaque id, display name,
category)` and not a boolean, because a two-value enum cannot represent Linear. And `passes` is a
local concept: it is never read back from a provider as truth.

## Constraints that shape the shape

- **No push a local desktop can rely on.** Both providers' webhooks require a public non-localhost
  HTTPS URL. Linear has GraphQL subscriptions, but their transport and limits are undocumented on
  the reachable pages, so they are at most a later provider-specific accelerator behind a flag.
  Polling is the only mechanism both support.
- **Change detection differs sharply.** GitHub gives conditional requests, and an unchanged poll
  answered `304` costs nothing against the 5,000-per-hour budget. Linear has no conditional requests:
  every poll spends one of 2,500 requests per hour, so 30 s costs about five per cent of the budget.
  Neither change cursor reports deletions, so a periodic full reconciliation is required on both.
- **The local backend must not be distorted.** It is a file read plus a validator that either passes
  or fails, its conflicts are git merges resolved by a person, and it is always current. It must not
  be made to fake a cursor, an ETag or an HTTP status. The shared error vocabulary is therefore
  `ok`, `invalid` with reasons, `unavailable` and `denied` — not status codes.

## Shape

- `tracker` block in the declaration: a provider name and provider-specific location (repository, or
  team), no secret. Contract 5. Absent means the local backend if `features.json` exists.
- A server module per provider behind one interface returning the neutral row shape. The local
  provider shells the existing Python tool for validation rather than reimplementing its rules.
- Remote providers use the time-bounded cache with in-flight coalescing that the devices module
  already established; the local provider needs no cache.
- A data-only desktop view, the shape the dashboard and devices views use: no live connection
  object, no custom event routing, microui's own scroll container. It must be opened explicitly like
  the devices view rather than auto-opening like the dashboard, and that choice is deliberate.

## Verification

- The local provider returns every row of this repository's own inventory with the states the Python
  tool reports, and a row whose dependency is unmet reads blocked in the view.
- A declaration naming a provider under contract 4 is refused by name and version, not with a generic
  unknown-key error.
- A credential in `.rengine/project.json` is refused; the declaration carries no secret field at all.
- With the network unavailable a remote tracker renders from cache with the staleness indicator set,
  and the view never blocks the frame.
- Every regression is verified against the specific failure it claims to prevent, per the work
  protocol: for the cache, a stale entry served past its window; for the contract gate, a block
  declared one contract too early.

## What shipped (F78, 2026-09-07)

Contract 5 carries a `tracker` block naming a provider and the locator that provider needs: a
repository for GitHub, a team key for Linear, nothing for local. A declaration naming the wrong
locator is refused at declaration time rather than failing later against the network, and the block
has no credential field at all, so a secret cannot be committed by mistake — the schema refuses the
key outright.

Three providers answer the same neutral row. Local reads the project's own inventory and derives
readiness with the rule `tools/features.py` applies, so the view and the command line cannot disagree
about what is blocked. A project that declares no tracker still gets its inventory, which is the
default backend and the one this repository uses. Remote providers are cached for thirty seconds with
in-flight coalescing, the shape the devices probe established; the local backend is never cached,
because it is always current and a staleness indicator on it would be a lie.

State reaches the row as `(id, name, category)`. A Linear team names its own states — "In Review",
"Icebox" — and only the category is shared vocabulary, which is why a boolean would not have done.
The failure vocabulary is the backend's rather than HTTP's: `denied` when a token is missing or
refused, `unavailable` when a service cannot be reached, `invalid` with reasons when a declaration or
an inventory is malformed. Linear reports its rate limit as a 400 carrying a RATELIMITED error rather
than a 429, and that is handled by name.

A token lives at `<workspace state>/trackers/<project>.token`, keyed by the declared project identity
so a person can create it by name. For an externally owned project whose declaration lives outside
its checkout, this works unchanged: the declaration is found through the root's declaration file and
the token is keyed on the `project` it declares.

To point a project at Linear:

```json
{ "contract": 5, "tracker": { "provider": "linear", "team": "KOH" } }
```

then write the key to `trackers/<project>.token` beside the workspace state.

## Deferred

Writing to any backend. Mirroring between backends. Linear subscriptions. Image icons and anything
needing a decoder. Projects v2 for GitHub ranking, which is GraphQL-only and needs a broader scope.
