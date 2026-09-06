---
name: rengine-continue
description: Run one incremental rEngine feature session under this repository's harness — orient from Codex-progress.md and the charter, verify the gates, write or extend the feature spec, establish a failing check, implement the bounded change, verify the real consumer path, record evidence and a machine-tagged session entry, and commit only your own paths. Use this instead of harness-continue in /Users/alex/rengine. Trigger on "rengine continue", "/rengine-continue", "continue", "next feature", "start F<n>", or any request to implement a feature here.
---

# rEngine Continue — spec-first, evidence-first feature session

`AGENTS.md` is the canonical workflow; this skill is its executable checklist. It does not add
authority: a feature the inventory blocks stays unpassed even when the owner asks to start it,
and owner directions that change boundaries are recorded, not assumed.

## Phase 1: ORIENT

```bash
pwd                                  # must be /Users/alex/rengine
git status --short                   # a parallel Codex session inside the native orchestrator
                                     # usually holds uncommitted files: never stage them
head -60 Codex-progress.md           # newest entry first
python3 tools/features.py status
python3 tools/features.py next
python3 tools/features.py show <ID>
ls docs/specs; git status --short docs/specs    # spec numbers, including untracked ones
```

Read the charter decision table (`docs/specs/000-charter.md`) for anything touching the
feature, `docs/architecture.md` constraints, `known-issues.md`, and every spec the feature
cites. Report: passing/total, the chosen feature, its dependencies' state, and whether the
owner explicitly directed a blocked feature (say so in the log later).

## Phase 2: VERIFY the gates before new work

```bash
./init.sh                                    # inventory validation and whitespace
python3 tools/design.py check                # theme, design mirror, native guards
npm run build && ctest --test-dir .cache/desktop --output-on-failure
npm test                                     # service tests
```

If anything fails that the current tree caused, fix it first and commit that alone. Failures in
the other session's uncommitted files are reported, not fixed here.

## Phase 3: SPEC (mandatory before code)

Create `docs/specs/NNN-slug.md` with the next free number after checking untracked specs, or
extend the existing spec. It must state: purpose, boundaries, the contract or behaviour, what is
deferred, and the verification plan with the exact commands and the evidence file it will produce.
If the design space is wide, run `/grill-me` first and record the attributed decisions in the spec.
Owner decisions that change a boundary also get a charter D-row and an `AGENTS.md` line.

## Phase 4: FAILING CHECK first

Behaviour changes need a failing regression or an equally meaningful acceptance check before the
change: a CTest under `orchestrator/native/tests/`, a native spec under `orchestrator/tests/`
driven through `--automation`, a service test, or a byte-identical snapshot baseline taken
**before** editing (`.cache/desktop/bin/rengine --smoke-test --snapshot before.bmp`). Documentation
changes need document and graph checks instead.

## Phase 5: IMPLEMENT the bounded change

- Views append to the draw list; never name rendering-API symbols above `render/backend_*.c`.
- Colours and layout sizes come from `RE_COLOR_*` / `RE_METRIC_*` (`orchestrator/native/theme.json`
  → `theme.h`); add a token before a new value.
- Keep owned files under 1,000 lines; pinned `third_party/` stays pristine; new dependencies are
  pinned in `third_party/sources.json` with licences.
- Rationale longer than two lines goes in `<file>._llm.json` (llm-sidecar skill); run
  `python3 ~/.claude/skills/llm-sidecar/scripts/validate_sidecar.py <file> --fix` after edits.
- Files the other session has modified: apply your substitutions to a copy of `HEAD:<file>`,
  stage that blob with `git hash-object -w` + `git update-index --cacheinfo`, and re-check `HEAD`
  right before committing — it can land a commit while your entries are staged.

## Phase 6: VERIFY the consumer path

Run every gate from Phase 2 again, plus what the feature claims: byte-compare snapshots, the
native desktop suite (`npm run test:desktop`, or the committed spec list with
`node --test --test-concurrency=1 …`), and measurements against budgets set beforehand.
Record numbers in `docs/evidence/<topic>-<platform>-<date>.md`. Missing assets, skipped checks,
infrastructure errors and pending human judgments are distinct from passes — say which.

## Phase 7: RECORD and COMMIT

1. `features.json`: add evidence paths; set `passes: true` only with evidence for every criterion
   and passing dependencies (`tools/features.py validate` enforces it). Regenerate the graph when
   the inventory changes: `python3 tools/features.py graph > docs/roadmap-graph.md`.
2. `known-issues.md`: new gaps as `KI-NNN` rows; update rows the work resolves.
3. Prepend or extend the machine-tagged entry in `Codex-progress.md`
   (`## Session N (<machine>) — YYYY-MM-DD — <title>`) with commands, results, evidence path,
   owner directions, coexistence notes and remaining work.
4. `git add <explicit paths>`; never `git add -A`. Commit with a conventional subject and the
   attribution trailer the running harness requires. Confirm `git status` shows only the other
   session's files afterwards.
