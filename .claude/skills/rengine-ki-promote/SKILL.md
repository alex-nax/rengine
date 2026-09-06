---
name: rengine-ki-promote
description: Drain the known-issues.md backlog in small verified batches — check each open KI row against today's code, promote real defects or gaps to features.json rows, mark stale rows resolved with evidence, merge duplicates into the feature that already tracks them, and defer judgment calls to the owner. Use on "ki promote", "/rengine-ki-promote", "promote known issues", "triage known issues", "known-issues cleanup", or when a batch loop over known-issues.md is requested.
---

# rEngine KI Promote — known issue → feature promotion with verification

`known-issues.md` is a three-column table: `| KI-NNN | Issue | Consequence / next action |`.
Rows have no dependency graph or acceptance criteria, so they rot invisibly. This skill verifies
each row against the code and gives it exactly one outcome; the queue shrinks monotonically.

## Batch selection

The queue is every row whose next-action cell does not start with `RESOLVED` or
`NEEDS-DECISION`, lowest number first:

```bash
python3 - <<'EOF'
import re
rows = []
for line in open('known-issues.md'):
    m = re.match(r'\|\s*(KI-\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|', line)
    if m and not re.match(r'\s*(RESOLVED|NEEDS-DECISION)', m.group(3)):
        rows.append((int(m.group(1)[3:]), m.group(1), m.group(2).strip()[:80]))
rows.sort(); print("pending:", len(rows))
for n, kid, issue in rows: print(kid, "::", issue)
EOF
```

- Default batch: **5 rows**. `/rengine-ki-promote 8` → batch of 8; `/rengine-ki-promote KI-014 KI-021` → exactly those.
- One row done right beats five skimmed; shrink rather than skim.

## Ground rules

1. **Verify before promoting.** A row is a claim made at filing time; re-establish it against
   the code, tests, evidence documents and later session entries. When you cannot decide by
   reading, DEFER; never guess.
2. **No code edits.** The promoted feature is the vehicle for any fix.
3. **Never delete information.** A row leaves the file only when its content lives somewhere
   better (a new feature row, an existing feature's evidence, or a `RESOLVED` history row).
   Evidence in the row (paths, commands, hashes, dates) survives verbatim.
4. **`features.json` discipline.** Promoted rows are always `passes: false`; never reword
   existing descriptions; extend criteria only under MERGE and only with what the KI adds.
   Re-derive the next free ID immediately before each edit
   (`python3 tools/features.py show <id>` must fail) — parallel sessions have collided before.
   Regenerate `docs/roadmap-graph.md` after adding rows.
5. **Serial, quiet work.** No agents, launches or native suites; targeted `ctest -R` only.
6. **Never touch the other session's uncommitted files.**

## Per-row routine

1. **Gather**: read the whole row; `grep -n "KI-NNN" Codex-progress.md docs/ -r`; find the
   feature or spec that may already track it (`python3 tools/features.py show`).
2. **Verify**: claim table with verdict STILL-REAL / FIXED-SINCE / ALREADY-TRACKED / UNDECIDABLE.
3. **Triage**, exactly one outcome:
   - **PROMOTE** (STILL-REAL): add a feature row (milestone, category and priority from the
     evidence; description starts “Promoted from KI-NNN:” and preserves all evidence; criteria are
     observable fix conditions; `dependencies` only when logically required), then remove the row.
   - **CLOSE** (FIXED-SINCE with hard evidence): set the next-action cell to
     `RESOLVED YYYY-MM-DD (ki-promote: <commit/spec/test that fixed it>)`; keep the row.
   - **MERGE** (ALREADY-TRACKED): move evidence the KI adds into that feature's spec or
     evidence list; remove the row; record `KI-NNN → FNN`.
   - **DEFER**: prefix the next-action cell with `NEEDS-DECISION YYYY-MM-DD:` and the question;
     append a dated verification note when the row's own claim is now wrong; never reword it.
4. **Docs**: lessons with a transferable rule go to `docs/lessons-learned.md`; update spec
   citations of the KI number to the new feature ID or the resolved status; fix miscitations.

## Batch wrap-up

1. `python3 tools/features.py validate`; re-run the queue script and record the real count.
2. Stage only touched files; prepend a machine-tagged session entry to `Codex-progress.md`
   mapping each row to its outcome.
3. Commit `chore(ki-promote): KI-NN,KI-NN → FNN — <summary>` with the harness's attribution
   trailer.
4. Optional cross-agent review as in `/rengine-housekeep`.

## Report

```markdown
# KI promotion batch — YYYY-MM-DD
## Processed: KI-NN, … (queue: X pending remain)
### KI-NN — <gist>: Verdict / Outcome / Lessons
## Needs user decision
## Cross-agent review
## Docs touched
```
