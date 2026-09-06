# Nested explorer, macOS — 2026-09-06 (F73)

Every acceptance criterion of F73 is implemented and gated on macOS. The row is not marked passing:
F73 depends on F67, which is signed off but waits on the Windows card evidence blocked by KI-038.
This document records what was verified here so the Windows pass has something to repeat.

## What was driven

`orchestrator/tests/native-explorer.spec.mjs`, four tests against the real desktop through the
automation bridge, on the Metal backend at 1280x800.

| Criterion | How it was driven | Result |
| --- | --- | --- |
| Nested expands in place, keeps siblings, caret drills in | Toggle the setting, click `src`, assert its children appear while `top.txt` stays and the tab's directory is unchanged; nest a second level; collapse and assert the branch closes whole; click the caret and assert the directory became the root | pass |
| Flat drills down; the setting decides | Toggle the setting off, click `src`, assert the tab's directory changed and the children are listed as the root | pass |
| Cap collapses the least-recently-expanded, protects the branch in use, refuses when all are protected | Two 700-entry directories against the 1200-row cap: the older branch closes and the status names it. Then a nested branch with a file open inside it, and a third directory: the expansion is refused, the status says what to do, and nothing already open closes | pass |
| Expansion survives a reload of the same directory | Expand, choose the explorer from the toolbar (which reloads the listing), assert the expansion is still there | pass |

## Numbers

| Item | Value |
| --- | --- |
| Row cap | 1200 (`RE_METRIC_TREE_ROW_CAP`, generated from the tree metrics) |
| Expansion slots | 48, shared across tabs |
| Directories in the cap fixture | 700 + 700 entries |
| Directories in the protection fixture | 500 + 500 + 500 entries |

## Gates run beside it

`npm test` 56/56, `npm run test:desktop` 26/26, CTest 5/5, `python3 tools/design.py check`, and the
cross-backend render comparison.

## Defects found and fixed while building this

- The new expansion request sorted above `OP_BYTES`, the boundary the request path uses to decide an
  operation belongs to a format view, so it read a format the explorer does not have and the desktop
  died on the first expand. The enum now records that boundary and `re_format_mode` tolerates no view.
- The row-cap collapse passed a pointer into the slot it then cleared, so the branch test compared
  against an empty string and closed every open branch. The path is copied first.
- The pool's free marker was the tab index, which made tab 0 indistinguishable from an unused slot.
  An empty path is the marker now.
- Control rectangles recorded for the caret were not clipped to the container the way every other
  control's are, so a caret scrolled far out of view was still reported as reachable.
