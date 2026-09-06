# Claude Design foundations on the GPU renderer, macOS, 2026-09-06

Scope: F60 ([spec 076](../specs/076-design-foundations.md)) on macOS 15.7.3, Apple M3 Max, the Metal
default backend, 1280×800 logical / 2560×1600 drawable. The surfaces this feature owns are the
toolbar, the tab strip and the status bar; the views are F67 and the overlays F68.

## What the desktop now draws

- `design/tokens.css` is the runtime theme source. `orchestrator/native/theme.json` holds only
  bindings from native names to tokens; `tools/design.py generate` resolves all three layers and
  every preset into `theme.h` and `theme.c`, so `default`, `teal` and `light` are compiled in and
  `re_draw_theme` switches the live theme. The shipping look is the design's default palette; the
  previous look is preserved as the teal preset.
- `orchestrator/native/ui` is a separate target (`rengine_ui`) holding the owned controls: buttons in
  ghost, standard, primary and segmented forms, selects, text fields with icon and placeholder,
  checkboxes, sliders, separators, labels, the focus ring, the tab face and the transition clock.
  It depends on the renderer and microui only, and upstream microui is untouched.
- Bundled faces: Inter Regular, Medium and SemiBold for UI text and Phosphor for icons, both pinned
  in `third_party` with hashes and licences. `orchestrator/native/icons.json` maps every card symbol
  to an icon; `design.py check` fails when a card uses one that is unmapped.

## Card reference

`python3 tools/design.py cards` writes `design/cards.json` from the token layers: the geometry and
resolved sRGB colours each surface must show, per preset, never hand-copied.
`orchestrator/tests/native-design.spec.mjs` drives the desktop through all three presets, captures a
snapshot per preset and probes real pixels with `tools/bmp_probe.py`.

| Surface | Reference (default preset) | Measured |
| --- | --- | --- |
| Toolbar height and background | 36px, #242424 | #242424 at rows 2 and 34; row 37 is #1b1b1b |
| Brand mark | #f97c3d | #f97c3d |
| Tab strip background | #1b1b1b | #1b1b1b |
| Active tab marker | #f97c3d | found in the strip's top rows |
| Status bar height and background | 22px, #2d2d2d | #2d2d2d to the bottom edge; the row above is #242424 |

The teal and light presets pass the same probes against their own resolved colours; the full
snapshots are `design/foundations-default.png`, `-teal.png` and `-light.png` beside this document.

## Renderer comparisons after the redesign

| Scene | Differing pixels (each GPU adapter) | Outside the 2px band | SDL median ms | OpenGL / Metal / Vulkan median ms |
| --- | --- | --- | --- | --- |
| Workspace | 672 | 0 | 2.825 | 0.438 / 0.457 / 0.356 |
| Terminal | 672 | 0 | 1.671 | 0.881 / 0.596 / 0.326 |
| Primitives | 32227 | 0 | 2.699 | 0.557 / 0.593 / 0.330 |

The current-UI scenes now contain anti-aliased rounded controls, so they carry the edge-band rule
the owner set for the primitives scene rather than a per-channel limit: the differing fraction stays
at 0.1% and nothing may differ outside a 2px band of a shape's edge. Every differing pixel in both
scenes is an anti-aliased edge, and the three GPU adapters stay identical to each other.

Resident memory is now the median of four samples per backend, one after each scene and one at the
end, because a single reading swings by more than the budget itself (three consecutive runs of the
old measurement gave OpenGL deltas of 20, 33 and 37 MiB while its own resident size stayed near
186 MiB and the SDL baseline moved 13 MiB). Medians: SDL 156720 KiB, OpenGL 186224 KiB
(delta 29504 KiB of 32768), Metal 143616 KiB and Vulkan 145328 KiB, both below the reference.

## Other checks

| Check | Result |
| --- | --- |
| Native desktop suite, including the new design spec | 17 tests passed, 13 spec files |
| CTest (layout, editor, terminal, draw list) | 4 passed |
| `python3 tools/design.py check` | passes: theme.h, theme.c, render/icons.h, the token mirror, cards.json and every card symbol |
| Build targets | `rengine_render`, `rengine_ui` and `rengine_desktop_core` build separately; the control layer links only the renderer and microui |

## Criteria

| F60 criterion | Status |
| --- | --- |
| tokens.css layers and presets generate the runtime theme; default, teal and light switch live on the GPU backend | Met: the design spec applies each preset through the automation `theme` op and probes the resulting pixels |
| An owned control library over pristine microui in microui's conventions, as its own build target with no workspace dependencies | Met: `rengine_ui` with `mu_Context` identity, layout and input, `MU_RES_*` results, no allocation, and no workspace header |
| Toolbar, tab strip and status bar match their cards on macOS under a generated reference, with the snapshots recorded | Met as tabulated; the snapshots are beside this document for the owner's sign-off |
| Every existing desktop behaviour gate still passes on the GPU backend | Met: 17 of 17 on the default Metal backend, including the render comparison across all four backends |
