# A task list costs the viewport, not the inventory (F125)

Date: 2026-09-10. Status: **implemented and measured.** Asked for by the owner:

> fix the performance on long task list (>1000 in ~/nolf-improvement) by the same technique that is
> used in https://reactnative.dev/docs/virtualizedlist (adapt for c microui)

## What it cost

`re_tracker_ui` ended in `cJSON_ArrayForEach(task, tasks) task_row(...)` — every row, every frame.
Each row lays out eight columns, draws a key label, a title button whose **full description is
measured** by `re_draw_text_width`, four more buttons and a state pill. `~/nolf-improved` keeps
**1317** tasks; a viewport shows about twenty. The other thirteen hundred were laid out, measured,
turned into draw commands, and then clipped away by microui — the work was done and thrown out.

Measured through the automation `stats` op, draw commands per frame:

| Tasks | Before | After |
| --- | --- | --- |
| 200 | 5 513 | **842** |
| 1300 | 35 213 | **842** |

Before, the cost was proportional to the inventory. After, it is flat: the same 842 commands and 23
rows for either list, because the viewport is the same. For a 1300-task list that is a **42×**
reduction, and the shape changed from O(inventory) to O(viewport), which matters more than the
factor.

## The adaptation, and where it is simpler than VirtualizedList

The technique is React Native's: keep only what the viewport can reach, and stand in for the rest
with blank space so the scrollbar and the scroll position are unchanged. Two things differ.

**No height estimation, because immediate mode does not need one.** VirtualizedList must
`getItemLayout` or estimate row heights, then correct once real ones are measured — it is building a
retained tree ahead of laying it out. Here the rows are emitted in order, so after a spacer the
layout's own `next_row` **is** the content offset of the row about to be drawn. The window is
computed from truth on every frame; there is nothing to estimate and nothing to correct.

```c
int y = layout->next_row + skipped;          /* exactly where this row would start */
bool wanted = (y + row_h > top && y < bottom);
if (!wanted) { skipped += row_h; continue; } /* pay nothing for it */
skipped = list_spacer(ui, skipped);          /* one spacer for the whole run */
task_row(a, ui, tab, task, local, answered);
```

**A run of skipped rows becomes one spacer, not one per row.** A spacer is a single
`mu_layout_row` of the run's exact height, one shorter than the sum by a `style->spacing`, because
the layout adds a spacing after every row. That keeps `content_size` — and therefore the scrollbar —
identical to what it was when all 1317 rows were drawn.

**The open chooser is always emitted.** Its block is much taller than a row and reaches into the
viewport when its own row does not, so the window rule has an explicit exception for the one row
`menu.task` names. Without it, scrolling a detail block half off the top would make it vanish.

Overscan is four rows either side, so a scroll of a row or two draws nothing new.

## Why the first assertion was wrong, and what replaced it

The first version compared a 1300-row list against a **ten**-row list and required the rows drawn to
be within overscan of each other. It failed at 23 against 10 — and the failure was the *test's*, not
the code's: ten rows is shorter than the viewport, so it draws ten for a reason that has nothing to
do with virtualising. Comparing two lists that both **exceed** the viewport is the honest form: the
only difference between them is how much is below the fold, so the rows drawn must be equal.

## Evidence

**Sabotage.** Restoring `bool wanted = true` — the original loop — reports:

```
the draw list does not grow with the inventory:
35213 commands for 1300 tasks against 5513 for 200
```

which is the defect stated as a number. Restored and byte-compared.

**Correctness, not just speed.** Virtualising is only right if what a person sees is unchanged, so
the spec also snapshots both lists and asserts the visible rows are **pixel-identical** between the
200-row and 1300-row cases. A window that drew the wrong rows, or shifted them, would pass a
command-count check and fail this one.

Gates: `npm test` 230/230, the desktop suite, `./init.sh`, `design.py check`, `features.py validate`
77. Registered in `test:desktop` so it cannot go missing from a green report.

## What this does not do

- **It does not virtualise anything else.** The Sessions, Devices and Dashboard lists have the same
  shape and none of them has thousands of rows today; `list_spacer` and this loop are the pattern to
  copy when one does.
- **It does not sort, filter or page.** A person looking for one task among 1317 still scrolls.
  Filtering is a different feature and a better answer to that particular problem.
- **It does not change the row.** Same columns, same controls, same pixels.
