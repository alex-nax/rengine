# Sidecar efficiency evaluation — 2026-09-06

Decision: bundle llm-sidecar for selective rationale lookup and metadata maintenance. Keep `rg`
and small source excerpts for ordinary code lookup. No measured model-accuracy claim is made.

## Measurements

`tools/evaluate_sidecars.py --revision ca44dd5 --output FILE` copies three committed source/sidecar
pairs into a temporary corpus, queries an explicit anchor with radius 8 three times, and records
UTF-8 byte counts and wall time. The raw measurements are in
[the JSON record](sidecar-efficiency-2026-09-06.json). These are bytes, not model tokens. Code
excerpts do not replace reading the implementation when the task needs broader context.

| File / rationale task | Full source | Tool JSON with source excerpt and notes | Selected source excerpt alone | Selected note |
| --- | ---: | ---: | ---: | ---: |
| terminal.c — snapshot replay and live query replies | 16,231 | 9,317 | 937 | 761 |
| store.mjs — save/draft write ordering | 8,375 | 3,839 | 816 | 315 |
| supervisor.mjs — prepare, switch and recover | 17,404 | 3,829 | 1,099 | 651 |

Combined tool output is 16,985 bytes versus 42,010 for full source reads: 59.6% less. But the
three targeted source excerpts total only 2,852 bytes; sidecars add context and overhead to that
cheaper baseline. The tool currently returns all notes for a selected file, including irrelevant
ones, and JSON diagnostics can duplicate information. Do not load it indiscriminately.

Warm median query time in the small corpus was 45–50 ms. In this real checkout the installed
skill's targeted query took 25.414 s. Its indexer walks `.cache`, including build/version trees
and runtime state. The project adaptation excludes that directory. Its first measured refresh
was 3.511 s; three later observations were 3.454, 0.063 and 0.064 s (median 0.064 s). Workspace
edits and warm-cache effects confound a pure causal speed ratio; this is an operational comparison,
not an isolated benchmark of the exclusion alone. Exclusion also prevents generated credentials
and captured conversations from becoming source-index content. The global installation is unchanged.

## Usefulness and maintenance cost

The same agent reviewed each note against its anchored implementation and the associated spec:

- Terminal: explains why replay silences historical queries while live queries still reply,
  and connects that distinction to the observed input-queue failure. Useful maintenance context.
- Store: distinguishes disk-version checks, draft retention and serialized persistence; useful
  when changing save ordering, unnecessary for simply locating a method.
- Supervisor: identifies the preserved worker/binary and why failure is final only after recovery;
  useful when modifying asynchronous update code and its acceptance tests.

This is a qualitative review, not blinded grading or a multi-agent experiment. The frozen terminal
sidecar has a stale source fingerprint, which the tool correctly reports (exit 1); notes can drift
and are never evidence of correctness by themselves. Batching check/repair/review/stamp/check on
affected paths costs time and extra files, justified for these non-obvious invariants. New trivial
files and public API comments should not be moved into artificial sidecars.

## Bundling and verification

Canonical skill/tooling: `.claude/skills/llm-sidecar/`; Codex adapter:
`.agents/skills/llm-sidecar/`. Provenance hashes record the installed version-2 tool snapshot;
local changes are the concise project guidance, `.cache` exclusion and its regression test.
The cache-exclusion regression fails against unmodified discovery. The bundled suite passes
19 tests, covering indexing, incremental refresh, queries, anchors, source/format fingerprints
and cache exclusion. Source notes remain authoritative; SQLite under `.cache` is disposable.


A later full-check refresh of the pre-existing shared index ran long, and an overlapping stamp
hit SQLite writer contention. Only this turn's validator was stopped; the rerun uses its own
index and sequential commands. The exact cause of that slow refresh was not profiled, so it is
not attributed solely to F57's vendor addition. The final bundle also excludes `third_party` as
an explicit owned-code scope choice, with a failing-before-fix regression; use `rg` for pinned
upstream. Cold index construction still has a cost that the warm figures above do not measure.
