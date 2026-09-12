# A scene rendered in a tab, and a test's artifacts where its task is (F135–F137)

Date: 2026-09-11. Status: **designed; F137 implemented, the rendering chain not started.** Asked for by the owner:

> once we have rendering scene - we should be able to browse its tests, see test outcomes and their
> artifacts(the thing that I ask you for testing interface) also we should be able to launch it
> rendered in a new tab, note that it should use the tab surface to render on - to preview the level
> integration we will get(and not capturing from running process that we have in nolf now)

Designed through `/grill-me`. Every decision below is attributed, and the two where the owner
overruled the recommendation are marked, because their consequences are most of this document.

## What already answers itself

Asked of the codebase rather than the owner:

- **A tab can already show rendered output.** `RE_CMD_TEXTURE` exists, and the game view uses it —
  `re_draw_texture_update(g->texture, m->data + 24, w * 4)` uploads pixels a *different process*
  streamed over the surface protocol. That is the "capturing from running process" the owner is
  contrasting with, and it is what `embedded` and `cooperative` mean in contract 3.
- **The scene code is already in the right shape.** `scene.c`, `obj.c` and `scene_math.h` call the
  seam and nothing else; every platform call lives in `main.c` and `host_{gl,vk,metal}.*`. That split
  was made so three backends could be compared, and it happens to be exactly what an in-process
  consumer needs.
- **Tests already have a home.** F116 passes: the Tasks tab draws each task's manifest entries with
  `proven` or `UNPROVEN` and the last result, and rEngine runs nothing.
- **Artifacts do not exist in the contract.** `last` carries `result`, `at`, `commit`, `host` and
  `log`, and `log` is documented as "Where the project kept the output. **Not opened.**"
- **The desktop idles on purpose.** `SDL_WaitEventTimeout(&event, re_ui_animating() ? 16 : 250)`.
  A tab that animates continuously does not cost its own frames; it costs the window's.

## The decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **rEngine's own scene first; a project-declared level preview generalises later**, shaped by the first game that has one. | Recommended, confirmed |
| 2 | **The scene shares one seam with the desktop, so it waits for F133** rather than opening its own seam on the desktop's live device. | **Owner, overruling the recommendation** |
| 3 | **F133 keeps `--renderer` a runtime switch**: rEngine links three copies of the seam with its public symbols prefixed and dispatches through a small table. The pack stays compile-time selected, so D14b's zero indirection holds for the games it serves. SDL_Renderer retires to the committed reference frames. | Recommended, confirmed |
| 4 | **Tests are browsed in the Tasks tab**, extending F116's manifest rows rather than opening a second home for the same entries. | Recommended, confirmed |
| 5 | **Contract 10 gains `last.artifacts`**: root-relative paths with an optional label each, opened in the views rEngine already has. `log` stays the text output it already is. rEngine still runs nothing. | Recommended, confirmed |
| 6 | **The scene view is F108's first plugin**, not a desktop view. | **Owner, overruling the recommendation** |
| 7 | **An `.obj` in the tree opens a Scene tab**, as a `.png` opens the image view; a command opens the built-in procedural scene, which has no file. | Recommended, confirmed |
| 8 | **Still by default.** One frame on open, frames while dragging, continuous only when explicitly played, nothing while unfocused. | Recommended, confirmed |
| 9 | **A plugin's render target is frame-scoped and never held.** | Recommended, confirmed |
| 10 | **A plugin receives pointer and wheel, scoped to its own tab.** No keyboard, no shortcuts, nothing outside its rectangle. | Recommended, confirmed |

## The tension decisions 3 and 6 create, and how 9 resolves it

Worth stating plainly because it is the most interesting thing the interview found.

Spec 106 deferred textures from the plugin ABI for one reason, quoted exactly:

> Textures are deferred because they are backend-owned objects whose lifetime is the renderer's, and
> a plugin holding one **across a backend switch** is a use-after-free the desktop cannot see.

Decision 3 keeps `--renderer` a **runtime** switch. Decision 6 puts the scene in a **plugin**. Those
two together are precisely the hazard that reason describes — a plugin holding a render target while
the renderer changes underneath it.

Decision 9 removes the hazard rather than policing it. A plugin asks for a target each frame and gets
a handle good for that frame only; the host owns it, and the plugin stores nothing across frames.
There is nothing to dangle when the backend changes, and it is the discipline the desktop already
uses for tabs, where a generation number invalidates work in flight (`RePending`, `ReExpansion`, and
now `reclaim_view` in spec 125).

## What D38 has to widen to, and what it must not

D38 grants a plugin "registration, drawing, clipping, measurement and colour lookup and nothing
else". Two things move, both with the containment criterion 5 already establishes for the clip — a
frame opens with the clip set to the tab's area and closes with it reset whatever the plugin did:

- **A frame-scoped render target**, requested by size, returned as a handle valid for that frame, and
  drawn into the tab through the same `TEXTURE` command the game view already uses.
- **Pointer position, buttons and wheel while the pointer is inside the plugin's own tab**, plus
  whether that tab is focused.

Everything else D38 refuses stays refused: no keyboard, no shortcuts, no controls, no unloading, and
no reach into store, session or host state. A plugin fault still costs the window and never a session.

## The chain, stated honestly

Decisions 2 and 6 put the scene view behind two features that do not exist yet, and one of them has
to grow first:

```
F133  the draw list on the seam, three prefixed copies, SDL retires   (rEngine)
F108  the plugin ABI, which is open and whose Windows criterion is
      NOT MET behind KI-038                                           (rEngine)
F135  the ABI widens: frame-scoped targets and tab-scoped pointer      (rEngine)
F136  the scene plugin: .obj opens a Scene tab, still by default       (rEngine)
```

That is a long chain for "show me the level", and it is the cost of the two overrules rather than a
surprise. The alternative offered — the scene opening its own seam on the desktop's live device,
which works today on the shipped renderer — was declined in favour of one seam for everything.

**The tests half depends on none of it** and should not wait:

```
F137  contract 10 gains last.artifacts; the Tasks tab shows them and
      opens them in the image view and the format registry             (rEngine)
```

## What F136 is not

It is not the surface protocol. `external`, `embedded` and `cooperative` all stream pixels from
another process, and a scene plugin renders in this one, on the device the window already has. Nothing
in F136 touches `RENGINE_SURFACE_PORT`, the SDL2 interpose adapter, or the game view. The owner's
phrase for the difference — "use the tab surface to render on, not capturing from a running process"
— is the whole distinction, and it is why this is a plugin tab rather than a fourth surface kind.


## F137's evidence

The half that depends on none of the rendering chain, and the one asked for first.

**Contract 10's `last` gains `artifacts`** — root-relative paths with an optional label, at most
sixteen. `log` is untouched, because "where the output went" and "what the run produced" are
different claims and one field cannot make both.

**The server answers for them at read time, not on click.** Each path goes through `resolveInRoot`,
which the editor's own open path already uses and which follows symlinks, and then a `stat`. Each
artifact arrives as `ok`, `missing` or `outside`, and an escaping path is also named in the
manifest's error line the way criterion drift already is. rEngine opens nothing it was not asked to,
and produces, refreshes and regenerates nothing.

**The Tasks tab draws them under the result F116 already shows.** A ready one is a ghost row that
opens the file in whatever view this workspace already has for it; one that is not ready is drawn
disabled saying which — "not on disk" or "outside this project" — rather than hidden or left to fail
when someone clicks it.

Three sabotages, all caught, all on the assertion that owns the claim — `the artifact the project
wrote is offered`, with `and the one it did not write and the one outside the root are shown as
unavailable, not hidden` catching the third as well:

| Sabotage | Observed |
| --- | --- |
| a path escaping the root is settled as `ok` | two artifacts offered where one should be |
| a missing artifact is settled as `ok` | the same |
| every artifact is offered whatever its state | three offered, none unavailable |

### Two things the test had to learn

**The assertion had to be about identity, not content.** Waiting for the opened artifact's editor
text never succeeded, and the reason is not a defect: the fixture's declaration routes a `.txt`
through the format registry, so the tab opens in `raw` mode with no editor at all. Which view opens
is the registry's answer — that is what "opened in the view rEngine already has for it" means — so
the test asserts the right file opened under the label the project gave it, and leaves the view to
the specs that own it.

**Opening an artifact focuses it**, exactly as clicking a file in the explorer does, so the task list
is no longer the visible view and the rest of the test could not find its controls. Coming back is
what a person does; the test now does it too.

## F135 and F136, built — and the one decision the interview did not foresee

Date: 2026-09-12. Asked for as "let's get back to scene, please render 'sponza' into tab".

The chain this spec drew is finished except for what is listed as owed at the end: F133 landed, the
ABI widened, and Crytek Sponza renders in a tab — 786,801 vertices in 393 parts, through the seam
the window itself renders with, on Metal.

### How a plugin reaches the GPU, which is not the obvious way

D55 says a plugin gets "a render target requested by size each frame". It does not say how the
plugin *draws* into one, and the answer is forced by D56: rEngine links **three** copies of the seam
with their symbols prefixed, so `re_seam_draw` exists in no copy under that name. A plugin module
cannot call the seam at all, and the ABI promises a module with no undefined references.

So the seam arrives **by pointer**. `plugin_render.h` is a table whose every member has the
signature of the seam function it stands for, filled from whichever prefixed copy the window linked
(`plugin_seam.c`, compiled once per API exactly as `backend_seam.c` is). Two consequences worth
having:

- A rendering plugin defines the pack's own `re_seam_*` names as one-line forwarders — 29 of them in
  `plugins/scene/seam_forward.c` — and then compiles the pack's sources **unmodified**. F136's third
  criterion, "the plugin and the pack's standalone example render the same scene from the same
  sources", is therefore true by construction. There is no second copy to keep in step.
- The table is chosen per window by backend name, the same way the backend itself is. Handing a
  plugin the OpenGL table while the window renders on Metal was one of the two sabotages, and it is
  red: the calls would land on another copy's seam.

The owner chose this over two alternatives on 2026-09-12: a built-in Scene view (no ABI work, but it
reverses decision 6) and a plugin linking its own seam copy (cheapest, but two code copies operating
on one object, three plugin builds for `--renderer`, and nothing to catch a layout drift).

### The sequencing that makes an off-screen pass possible at all

A 3D pass has to be inside a seam frame, and `re_app_draw` — where a plugin's tab is drawn — runs
**before** the desktop's frame opens: the draw list is still being recorded there and is not executed
until `re_draw_end`. So the plugin opens its own seam frame on its own target, closes it, and the
composite command recorded immediately afterwards samples a finished texture when the desktop's frame
executes. No nesting, and the target is finished before anything samples it.

`draw_target` refuses unless *this* frame asked for a target, which is how D55's "good for that
frame only" is enforced without policing the handle: a target kept from an earlier frame cannot be
presented. The allocation itself is not per frame — a depth buffer rebuilt sixty times a second
would cost more than the scene — and a resize or a different `ReDraw` throws the whole thing away,
which is the renderer change D55 worries about.

### The third thing the ABI needed, which decision 7 implies

Decision 7 opens a Scene tab from an `.obj` in the explorer, and tabs are registered during `start`
— so the file cannot be part of the tab. F135's description says the ABI widens "by exactly two
things" and it does: a target and a pointer. The tab's **subject** is F136's, and it is a tab's own
parameter rather than a reach into anything: `host->subject(frame)` is the path the desktop opened
this tab for, or "" for the built-in scene. It names no other view and reaches no store.

### Two places a hardcoded count was the bug

Adding one command found the same defect twice: the toolbar's switcher had `int views = 6` beside a
seven-entry table, and the pane menu's height was `6 * (row + 2)` beside its own. In both cases the
extra entry existed in the layout and was invisible on the screen — the menu's last command was
drawn outside its own surface and reported by no control. Both counts are derived now.

### Why the built-in scene is a command and not a button

It was a toolbar cell first, and the reference-image gate refused it: 0.6% of the workspace's pixels
differed, 12,741 of them outside the edge band. Those frames were captured from SDL_Renderer before
it retired (F133), so they are an oracle that **cannot be re-recorded** — which makes the chrome's
appearance something a feature may not change casually. Decision 7 says "a command", and a command
it is: `Cmd/Ctrl E`, listed in the pane menu, where the card compares colours rather than row count.

### What is owed

Stated rather than absorbed, because F135 and F136 both stay `passes: false` until it is done:

- **F135 c2 and c3 have no test.** The frame-scoped refusal and the tab-scoped pointer are
  implemented and neither is evidenced; both need a fixture plugin that keeps a target and one that
  asks about another tab. c6 names exactly these two, so the row cannot pass on the render evidence
  alone.
- **F136 c1 is proven for the built-in scene, not for an `.obj`, in the suite.** Sponza was verified
  by hand from `~/assets/sponza` and the explorer path works; a committed gate cannot depend on a
  local asset, so what the suite renders is the procedural scene. The `.obj` half needs a small
  committed model of its own.
- **F136 c4 is not measured.** "A still scene costs no frames" is designed for — the plugin asks for
  no frames and only advances the animation while a drag is in progress — but the idle wait and the
  frame budget with a Scene tab open have not been recorded.
- **F136 c5 is implemented and untested.** Dragging moves the orbit through the tab-scoped pointer;
  nothing yet drives a drag over the tab and checks the image changed.
