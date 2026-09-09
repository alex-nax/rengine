# A task read rather than scanned (F124)

Date: 2026-09-09. Status: **implemented.** Asked for by the owner immediately after the trimming
landed: *"Now that text is trimmed there - we need a detailed task view"* — which is the right
consequence to draw. Trimming a title is correct for a list and useless for reading, so the list
needed somewhere to send you.

## What was actually missing

Not a view: **a control**. Every text control in `ui.h` drew one clipped line, which is right for a
table row and wrong for a task's description. So the first thing here is `re_ui_paragraph`, which
wraps to whatever width the layout gives it and is reusable by anything in the suite with prose to
show — dashboard descriptions, spec text, a manifest's claim.

Three decisions inside it worth stating:

- **Each line takes its own layout row.** The container then reserves real height and the pane
  scrolls over the whole paragraph, instead of a control drawing outside itself and relying on a
  clip to hide the overflow.
- **The width is read back from the first cell**, never assumed, because only the layout knows what
  the row actually got after the columns beside it took theirs.
- **A word longer than the line is broken by character.** A path, a URL or a C symbol is exactly the
  case where a word-only wrap would overflow and reintroduce the bleed this exists to end.

## The gesture is the title

The row trims the title; the title opens the full text. No new column in a row that already carries
four controls and a pill, and the thing that was cut is the thing you click. It joins Spawn, Hold
token and Tests as a fourth chooser kind, inline under its own row for the reason `tracker.c`
already records — an overlay costs one of microui's 32 root containers, and a block that scrolls
with its row cannot end up describing a different task than the one above it.

The block carries what the row cannot hold: the description in full, labels and assignee, what the
task is waiting on, and **every acceptance criterion wrapped**. The Spawn chooser shows criteria
clipped because it is composing a prompt; here they are the thing being read, and a trimmed
acceptance criterion is worthless.

## What making the title a button exposed

Turning the title from a label into a ghost button immediately failed the clip test from
[spec 118](118-label-clipping.md) — 715 pixels past the column. `contents()`, which draws every
button, select, and menu item's label, ended in a bare `ui_text`: **controls had the same overflow
labels did.** It had been invisible for the same reason — no control's label had been long enough to
reach anything.

So `contents` now clips too, to a box that stops before the caret, so a long label cannot run under
its own chevron. Together with spec 118's `apply_scissor` repair this finally makes clipping real for
every caller of `text_clipped`: textboxes, tree rows, pills, tabs and now buttons. All of them
believed they were clipping; none of them were.

## Evidence

The spec-118 oracle covers this too, because it asks the question that matters: **lengthening a title
must not change one pixel to the right of its own column.** It caught the button regression the
moment the gesture changed, which is exactly what it was written for.

Added to it: the block is measured **twice**, once with a long description and once with a short
one, and the gap the description opens above the row that follows it must be *larger* for the long
one. A "detail view" that also trims is not one.

**That assertion took three attempts, and the first two would have shipped as false evidence.**

1. *Count pixel rows with content below the header.* Passed with the paragraph cut to a single line —
   the rest of the block filled those rows regardless of the description.
2. *Require the gap to exceed twice the row height.* Also passed cut to one line: measured, the gap
   is 70px wrapped and **51px** unwrapped, and the fixed threshold of 48px cleared both. A number
   guessed from the layout rather than measured from it.
3. *Compare the long block against the short block.* Cut to one line this reports **"51px against
   51px"** and fails, because with no wrapping the two are identical by construction. Nothing to
   calibrate and nothing to guess.

The lesson is the one `docs/evidence/blind-regressions-2026-09-06.md` already records, met again
here: an assertion that has not been watched failing is a sentence, not a test — and a *threshold*
is the easiest kind to get wrong, because it looks like a measurement.

| Sabotage | Expected | Observed |
| --- | --- | --- |
| S1 — the paragraph draws one line | the detail view trims like the row | *"51px against 51px"* — the long and short blocks become identical |
| S2 — the button label back to a bare `ui_text` | the overflow the gesture introduced returns | the clip check fails |

Gates: `npm test` 230/230, the desktop suite 70/70, `./init.sh`, `design.py check`,
`features.py validate` 76.

## What this is not

- **It is not a pane.** The detail is inline under its row, which suits reading one task while
  scanning the list. A task in its own pane — side by side with an editor, or persisted across a
  restart — is a different thing and would need a tab type, a binding and layout persistence. Worth
  doing if the owner wants to keep a task open while working; not needed to stop the trimming from
  hiding the text.
- **It does not edit.** Nothing here writes a task; that is F117's lane.
- **It does not wrap the row.** The list stays one line per task on purpose: a list that reflows as
  titles change is not scannable, which is the property the trimming was protecting.
