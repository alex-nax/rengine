---
name: rengine-housekeep
description: Reconcile a small batch of rEngine specs and docs against the code (code as shipped is the source of truth) — fix drifted specs, move rejected approaches into docs/lessons-learned.md, file follow-up rows for defects found while reading, keep docs/architecture.md and spec 056's checkpoint current, and stamp each spec in the housekeeping ledger so later batches skip it. Use on "housekeep", "/rengine-housekeep", "spec cleanup", "reconcile docs with code", or when doc-vs-code drift needs systematic cleanup rather than a spot fix.
---

# rEngine Housekeep — depth pass over specs

`/rengine-audit` finds categories of rot across the repository; this skill retires it spec by spec
in small batches. It edits documentation, `features.json`, `known-issues.md`,
`docs/lessons-learned.md`, the ledger and `Codex-progress.md` only.

## Batch selection

The ledger is `docs/housekeeping.md`, a table `| Spec | Date | Note |`; create it on first use.
The queue is every `docs/specs/NNN-*.md` (lowest number first) with no ledger row, excluding
`000-*` foundations unless named explicitly.

- Default batch: **3 specs**. `/rengine-housekeep 5` → batch of 5;
  `/rengine-housekeep 060 061` → exactly those.
- A spec with a long history can consume the whole batch. Shrink rather than skim.

## Ground rules

1. **Code as shipped wins** where spec and code disagree; update the doc. If a test, snapshot
   or evidence file proves the code wrong, that is a defect: file a follow-up, never bless it.
2. **No code edits.** Defects become `KI-NNN` rows or follow-up feature rows.
3. **`features.json` discipline** (AGENTS work protocol): accepted IDs, descriptions, criteria
   and dependencies stay stable. A necessary correction needs a recorded rationale and owner
   decision; never weaken a criterion; `passes` never flips to true here, and true→false only
   with hard evidence, reported prominently.
4. **Specs describe the current solution.** Rejected approaches move to
   `docs/lessons-learned.md` (`LL-NNN`, with a one-line transferable rule) and the spec keeps a
   one-line pointer. Keep every table, offset map and derivation that documents what shipped.
5. **Evidence documents are history.** Link `docs/evidence/*`; never rewrite them.
6. **Serial, quiet work.** No agents, launches or full native suites; a targeted
   `ctest -R <name>` is fine when a verdict hinges on it and the build is green.
7. **Never touch the other session's uncommitted files.** Check `git status --short` first.

## Per-spec routine

1. **Gather**: read the spec, `python3 tools/features.py show` for the rows it serves, the
   evidence files it cites, `grep -n "<spec number>" Codex-progress.md known-issues.md docs/`.
2. **Verify** every load-bearing claim against the code: files, functions, constants, limits,
   commands, test names. Build a claim table (claim, reality, verdict: OK / DRIFT / UNVERIFIED).
   For token or metric claims, check `orchestrator/native/theme.json` and `design/tokens.css`.
3. **Fix** the spec to present-tense truth; write a concise spec from the code when a landed
   behaviour has none.
4. **Extract** lessons removed from the spec into `docs/lessons-learned.md`.
5. **File follow-ups**: `KI-NNN` rows for gaps (next free number, three-column format), or a
   feature row (next free ID verified with `python3 tools/features.py show <id>` immediately
   before editing; `passes: false`; regenerate the graph).
6. **Architecture docs**: keep `docs/architecture.md` (constraints, placement table) and the
   checkpoint paragraph of `docs/specs/056-native-desktop.md` at overview altitude and true.
7. **Mark** the spec in `docs/housekeeping.md` with the date and a one-line note
   (“clean” or what changed).

## Batch wrap-up

1. `python3 tools/features.py validate`; regenerate `docs/roadmap-graph.md` if rows changed.
2. Stage only touched files; prepend a machine-tagged session entry to `Codex-progress.md`
   (“housekeeping batch 060, 061, …”).
3. Commit `chore(housekeep): 060,061 — <summary>` with the harness's attribution trailer.
4. Optional cross-agent review: `codex exec -s read-only "Review documentation-only commit <SHA>
   … reply GO or a numbered defect list"`; fold accepted findings into one follow-up commit; note
   “cross-review skipped (unavailable)” when the CLI is missing.

## Report

```markdown
# Housekeeping batch — YYYY-MM-DD
## Processed: 060, 061 (ledger: X housekept / Y pending)
### 060 — <title>: drift fixed / lessons / follow-ups / flags
## Needs user decision
## Cross-agent review
## Architecture docs touched
```
