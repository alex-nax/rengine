# A label stays in its cell, and a pixel oracle proves it (KI-074)

Date: 2026-09-09. Status: **fixed, with a regression that fails for its own reason.** Reported by the
owner from the Tasks view, twice — the second time after a fix that did not work.

## The defect, in two layers

**Layer one.** `re_ui_label_ex` drew at its layout cell's origin and never clipped to the cell, so a
long task title ran straight across the buttons beside it and out to the pane edge. Invisible until
F115's Tests caret narrowed the title column enough to make the overflow reach the right-hand side.

**Layer two, which is why the first fix failed.** `ui.c` already had `text_clipped`, whose whole
purpose is this: measure, draw unclipped when the text fits, narrow the scissor when it does not.
Routing the label through it changed nothing, because **`text_clipped` had never clipped anything**:

```c
ui_clip(&box);   /* emits the narrow box, sets ui.applied = box */
ui_text(...);    /* → apply_scissor() FIRST … */
```

and `apply_scissor` restores the container's wider scissor whenever `ui.applied` differs from it —
which is exactly the state `ui_clip` had just created. The narrow clip was emitted and then undone
before a single glyph was drawn. Every caller of `text_clipped`, buttons included, was affected; it
only ever showed when text was long enough to reach something.

The sidecar note on `clip-cost` described the intended behaviour, and had been describing something
that did not happen.

## The fix

`ui_clip(&box)` now records that an explicit clip is in force, and `apply_scissor` leaves it alone
until `ui_clip(NULL)` releases it. Three lines. The cost model the note describes is finally true:
text that fits is drawn unclipped and keeps the adapters' batch; text that does not narrows the
scissor for exactly its own draw.

## The oracle, which is the part worth keeping

KI-074 recorded that no test in this repository builds an owned UI control, so the first fix shipped
on reasoning alone — and was wrong. The harness that was missing turns out not to need one: the
desktop already answers `op: 'snapshot'`, and the automation snapshot already reports every control's
rect.

**Lengthening a title must not change one pixel to the right of its own column.** Everything right of
the title — the Tests and Spawn carets, Decompose, Hold token, the state pill — is drawn from data an
edit to the title does not touch, so any difference there *is* the title bleeding. No colours, no
glyph metrics, no golden image, and both frames come from one process so font, theme, backend and
layout are identical by construction.

Two details the first run got wrong, both worth recording because they will catch the next person:

- **The snapshot is the drawable, not the window.** It came back 2560×1600 for a 1280×800 window, so
  logical control rects have to be scaled by the device ratio. The test derives the scale from the
  reported width rather than assuming 2.
- **A sanity assertion earns its place.** The test first requires that the longer title *did* change
  pixels inside its own column. Without it, a change that stopped drawing the title at all would pass
  the bleed check perfectly.

## Evidence

| Sabotage | Expected | Observed |
| --- | --- | --- |
| S1 — revert `apply_scissor`'s respect for an explicit clip, keeping the label's `text_clipped` call | the clip is emitted and immediately undone, so the title still bleeds | **689 pixels changed right of the boundary, first at x=2517** — the pane's right edge, which is what the owner photographed |
| S2 — return the label to a plain unclipped `ui_text` | the original defect | fails |

S1 is the one that matters: it is the exact state the first fix left the tree in, and it shows that
fix was insufficient rather than merely unverified.

Gates: the new spec passes, `native-tracker`, `native-tasks-controls` and `native-render` unchanged,
`npm test` green.

## What is still open

KI-074 asked for a harness that can render an owned control and inspect the emitted draw list. This
is the *pixel* form of that, which is stronger in one way — it proves what reached the screen rather
than what was queued — and weaker in another: it needs a real window, so it lives in the desktop
suite rather than in CTest, and it cannot say *why* a difference appeared. A draw-list assertion
would name the missing clip command directly. Both are worth having; only one exists.
