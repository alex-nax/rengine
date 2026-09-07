# Blind-regression evidence: the tracker's Linear filters (F97)

Date: 2026-09-07. Feature: [spec 100](../specs/100-tracker-view-filters.md).

A test that has never failed is an assertion with no evidence behind it. Each regression below was
broken in the one way it claims to catch, run, and restored. The suites are
`orchestrator/tests/tracker-filter.test.mjs` (tests 1–6) and `orchestrator/tests/tracker.test.mjs`
(tests 7–13); the baseline is green and the tree was green again after every restore.

## The masked first run, recorded because it is the trap

Run against the unchanged code, **all six** new tests went red — and three of them for the wrong
reason. The schema's `additionalProperties: false` refused `assignee` and `states` outright, so
`readDeclaration` reported an unknown key, `projectTracker` returned that error, and no request was
ever built. Tests 1, 2 and 6 were failing because the declaration was rejected, not because the
filter was wrong; the control masked the thing under test, which is the sixth case in
[blind-regressions-2026-09-06](blind-regressions-2026-09-06.md).

The schema keys were therefore added **alone**, and the suite re-run before any filter existed:

| Test | Red for its own reason, with the schema keys present and nothing else |
| --- | --- |
| 1 assignee | the request carries no `filter` variable at all, so there is nothing to name a person |
| 2 states | the same, with no `state` clause to carry the categories |
| 3 back-compat | `variables.filter` is `undefined`; the document still spends `$team`/`$project` |
| 4 invalid category | **green** — the enum alone refuses `in-progress` at declaration time, which is exactly what the test claims |
| 5 provider | `trackerError` is empty: `local` and `github` **accepted** the keys and would have ignored them |
| 6 cache | two different filters got one request; the second was answered from the first's entry |

## The sabotage table

Each row is one edit, applied alone, with the tree restored afterwards.

| # | The break | What went red |
| --- | --- | --- |
| S1 | `assignee` is always `{ displayName: { eq: … } }`, so `"me"` is treated as a person's name | 1 (and 2, whose third case narrows by both) |
| S2 | the `state` clause is never added to the filter | 2 |
| S3 | the `project` clause is dropped when nothing is declared, instead of being present and null | 3, and tracker.test.mjs 9 — which is the back-compat claim stated twice, once from each side |
| S4 | the `states` items schema accepts any string instead of the five categories | 4 |
| S5 | the linear-only rule covers `project` alone again, so `assignee`/`states` pass silently under `local` and `github` | 5 |
| S6 | the cache key drops the narrowing | 6 |

S1 and S3 each took a second test with them. Both are the same assertion made from another angle
rather than a leak: S1's second casualty declares `assignee: "me"` alongside its states, and S3's is
the pre-existing Linear test that has always asserted the null project clause. No sabotage left the
suite green, and none produced a red anywhere it should not have.

## Gates at the merge

`node --test orchestrator/tests/*.test.mjs` 152/152. `./init.sh` clean, 50 features validated.
`bash orchestrator/actions/verify.sh design` clean. No test makes a network call: every Linear test
drives an injected `fetch` and asserts on the request body it records.
