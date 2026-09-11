# A scene rendered in a tab, and a test's artifacts where its task is (F135–F137)

Date: 2026-09-11. Status: **designed; nothing implemented.** Asked for by the owner:

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
