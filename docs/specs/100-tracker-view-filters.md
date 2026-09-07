# A Linear tracker narrows to a person and to the states that mean active (F97)

Date: 2026-09-07. Status: recorded from owner direction. Parent:
[spec 083](083-task-tracking.md), which built the tracker and its project filter; shares contract 5
with [spec 084](084-project-identity.md).

## The situation it answers

The tracker tab shows everything the declaration can reach. For hirebase-v2 that is a hundred rows
spanning every assignee and every workflow state, because a Linear team's project holds everyone's
work and every state it has ever been in. The owner opening their workspace to work through their
own active tasks has to hunt for their own rows in someone else's backlog.

Spec 083 already met half of this: a Linear tracker can narrow a team to one project by name,
"which matters because a team holds everything it has ever done and a person opening one project
wants that project". The same argument runs one level further. A project holds everyone's work, and
a person opening their workspace wants their own — and wants it in the states that mean *now*.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | Two optional keys on the `tracker` block, `assignee` and `states`. Both absent behaves exactly as before, so every declaration already in the field keeps working unchanged. | Owner ("Both absent must behave EXACTLY as today, because existing declarations must keep working") |
| 2 | `assignee` is a string. The literal `"me"` means the signed-in user and becomes `assignee: { isMe: { eq: true } }`; any other value is matched against Linear's `displayName`. `"me"` is what a personal workspace declaration wants, and it survives the declaration being read under a different person's token. | Owner, query shape verified against live Linear |
| 3 | `states` is a non-empty array of **category** names — `backlog`, `unstarted`, `started`, `completed`, `canceled` — not team-defined state names. The category is the vocabulary the neutral row already normalises to, so the declaration says the same word the row shows and cannot drift when a team renames "In Review". | Recommended, from spec 083's decision that state is `(id, name, category)` and only the category is shared vocabulary |
| 4 | Both keys are Linear-only, and naming either under `local` or `github` is **refused at declaration time with a message naming the provider**, the way `repository`, `team`, `inventory` and `project` already are. Silently ignoring a declared filter is the failure the tracker rules exist to prevent. | Codebase rule (`trackerRules`) |
| 5 | An unknown category is refused by the schema at declaration time, not carried to Linear to fail as a GraphQL error against the network. | Owner ("an invalid state category refused at declaration time rather than at query time") |
| 6 | The filter is built in JavaScript and passed as a **single `$filter: IssueFilter` variable**; no clause is interpolated into the query document. The document is therefore one fixed string for every shape. | Owner, verified against live Linear |
| 7 | Filters join the remote cache key. Two declarations that ask different questions are different questions; a thirty-second window that answered the second with the first's rows would be wrong rather than merely stale. | Recommended |

## The query shape

Verified against team BAS / project Kohai before this was written; not re-derived here.

```graphql
query Issues($filter: IssueFilter, $first: Int!) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ... } }
}
```

| Filter passed as `$filter` | Rows |
| --- | --- |
| `{team, project, assignee: {isMe: {eq: true}}, state: {type: {in: ["started"]}}}` | 13 |
| the same with `assignee: {displayName: {eq: "jon"}}` | 11 |
| `{team, project}` only — no assignee, no state clause | 50 |
| `state: {type: {in: ["started", "unstarted"]}}` | 13 |

The `project` clause keeps the null-safe treatment it already had: it is always present as
`project: { name: { eq: <declared project or null> } }`, which is byte-for-byte what the previous
document produced through its `$project` variable when nothing was declared. That is what makes
"both keys absent" identical to today rather than merely equivalent.

## What this does not change

Row normalisation, the neutral row shape, the thirty-second cache with in-flight coalescing, the
failure vocabulary (`denied`, `unavailable`, `invalid`), and the read-only contract: the view lists
and opens, it never writes. The local and GitHub backends gain no filtering; they gain a refusal.

The desktop needs no change. Filtering happens where the query is built, so the tab renders the same
rows it always did — there are simply fewer of them.

## Verification

- The filter object built for `"me"` is `assignee: { isMe: { eq: true } }`; for a named person it is
  `assignee: { displayName: { eq: name } }`. Asserted on the object that actually reaches the
  request body, not on the result, which is the mistake spec 083 recorded catching once already.
- Declared categories reach the query as `state: { type: { in: [...] } }` in declaration order.
- With both keys absent the filter is deep-equal to the two-clause object the previous document
  produced, including `project: { name: { eq: null } }`.
- An unknown category, a repeated one, an empty array, and either key under `local` or `github` are
  each refused by `readDeclaration` with a message naming the key, before any request is made.
- Two declarations differing only in their filters do not share a cache entry.
- No test makes a live network call; every Linear test drives an injected `fetch`.
- Each regression was observed failing for its own reason before the change, per the work protocol.

## Sequencing

The schema has `additionalProperties: false` and a running session host freezes the schema at
startup, so a declaration carrying these keys is refused **wholesale** by any host that predates this
change — which takes that project's dashboard down with it, as it already did once. The code lands
first. A declaration is edited only after the host is replaced with `~/hirebase-v2.command
--replace-host` (spec 098).

## Deferred

Filtering the local and GitHub backends. A filter a person changes in the view rather than in the
declaration; the declaration is the workspace's own default and a view-level filter is a separate
feature over the same rows.
