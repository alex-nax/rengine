# The reference frames

These are what `native-render.spec.mjs` judges every backend against. They are recorded from
**OpenGL** as of 2026-09-14 (charter D64). Before that they were captured from SDL_Renderer, and
the change of baseline is worth understanding rather than discovering.

## Why they exist at all

rEngine's renderer comparison used to run every backend against SDL_Renderer live, and that worked
because SDL shared no code with the others — it was an independent witness. Once OpenGL, Vulkan and
Metal all render through one seam, a defect in that seam moves pixels identically in all three and
cross-comparison sees nothing at all. Retiring the only independent path would have retired the only
thing that could catch it, so the witness became data: a recorded frame cannot drift along with the
code it judges.

## What the OpenGL baseline does and does not give you

It still catches **drift over time**. A change that moves pixels — in the seam, in a backend, in the
desktop's own drawing — shows up against a frame recorded before it, which is the property that
matters day to day and the one that caught spec 134 D3's toolbar change on the day it landed.

It no longer catches **a defect that was already present when the frame was recorded**. SDL was an
independent witness of the seam; OpenGL is not, because it renders through the seam. Cross-backend
comparison remains the check on a backend diverging from its siblings, and it is unaffected.

That trade was made deliberately: SDL_Renderer has not been a shipping path since charter D49/D54,
so an SDL-captured frame was judging three backends nobody could re-record it from. A baseline
recorded from a backend that actually ships can be regenerated when the desktop legitimately changes,
which the SDL one could not.

## Regenerating

Still a deliberate act, not a fix. A backend that stops matching these is either wrong or the desktop
has changed on purpose; the second wants a note here saying what changed and why.

Recorded 2026-09-14 from OpenGL, at the commit that landed spec 134's Projects modal. What changed
against the SDL frames, measured rather than assumed:

- `y=10..61` — the toolbar, whose project switcher, path field and Add-project button moved into the
  Projects modal (spec 134 D3), and whose agent control became the select design had specified since
  spec 064 (D7).
- `y=1568..1595` — the status bar, whose project name became its own pressable segment, the modal's
  opener (D4).
- `primitives` additionally carried ~31,800 differing pixels in its middle that predate this change.
  They had accumulated across nineteen commits of desktop work since the SDL capture and sat inside
  the tolerance until the toolbar band pushed the out-of-band count over. **Recording this baseline
  accepts them**, which is the honest cost of having let the reference drift unnoticed for that long.

PNG at full resolution: 2560x1600 is 16 MiB as a BMP and about 100 KiB as a PNG, and this repository
is pinned as a submodule by two games. `tools/render_compare.py` reads either.
