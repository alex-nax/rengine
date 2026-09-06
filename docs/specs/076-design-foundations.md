# Claude Design update on the GPU renderer: foundations and the owned control layer (F60)

Date: 2026-09-06. Status: started after a `/grill-me` interview. Parent: [design system handoff](064-design-system-handoff.md),
[GPU rendering](066-gpu-rendering.md), [draw-list contract](067-draw-list-contract.md), charter D29–D34.
Sibling features from the same interview: F67 (views), F68 (menus, theme panel and theme files),
F69 (Windows card evidence).

## Decisions from the interview

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | Controls the design needs beyond microui are written as owned additions in microui's conventions, never a fork, and they join the curated library packs. | Owner: “if microui is not enough - we write addition keeping the same compatible contract and conventions like in microui lib - these extensions will be also part of our library packs”, 2026-09-06 (charter D33); this also answers spec 066's open control-layer question |
| 2 | F60 is narrowed to the foundations plus the toolbar, tab strip and status bar; the views become F67, menus/theme panel/theme files F68, and Windows card evidence F69. Each carries its own card evidence. F60's dependencies on F37 (tree, previews, editing) and F54 (session browser) move to F67 with them, because those are the surfaces that were narrowed out; F60 keeps F57. | Recommended, owner confirmed (accepted-criteria and dependency correction) |
| 3 | Card matching is gated mechanically: `tools/design.py cards` extracts each card's geometry and resolved token colours into a JSON reference, and the native snapshot is asserted at named probe points. Full native snapshots go into evidence for one owner sign-off on the visual whole. | Recommended, owner confirmed |
| 4 | The control layer is its own build target from the start (`orchestrator/native/ui`), with a public header, no workspace dependencies and no allocation. | Recommended, owner confirmed |
| 5 | Icons come from Bootstrap Icons, pinned as one TTF in `third_party` and rasterised through the existing font path as a third face. A generated table maps each card symbol to an icon name; `design.py check` fails on an unmapped symbol. | Recommended, owner confirmed |
| 6 | The UI face is bundled Inter 4.1 (OFL-1.1) in Regular, Medium and SemiBold, so weights are real faces and metrics match on both desktops. A theme file may still point the UI font at a system face. | Recommended, owner confirmed |
| 7 | The hue gradient becomes a first-class draw-list primitive rather than a texture: an axis-aligned linear gradient over up to eight caller-supplied stops with per-corner radius, interpolated in 8-bit sRGB, one quad per segment with vertex colours so all four adapters agree. The draw list goes to version 2. | Owner decision against the texture recommendation |
| 8 | Theme files use the card's `[theme "name"]` key/value format and may override all three token layers. They live in the workspace state directory, and a project root may carry one too. | Owner decision (project-local reach) beyond the recommended state-directory-only scope |
| 9 | A project's theme is offered, never applied on its own: the theme panel lists it and one click applies it, remembered per root. | Recommended, owner confirmed (trust boundary, charter D34) |
| 10 | The three design features carry macOS card evidence; Windows card evidence is F69, after the Windows desktop gaps of KI-038 close. | Recommended, owner confirmed (accepted-criteria correction, the F57/F62 precedent) |
| 11 | The transition clock ships with the control layer: per-control animation state, redraws scheduled only while a transition runs, idle cost unchanged. | Recommended, owner confirmed |

## What F60 covers

- **Theme generation.** `design/tokens.css` becomes the runtime theme source: `tools/design.py generate`
  resolves all three layers and every preset into `theme.h`, so `default`, `teal` and `light` are
  compiled in and switch live. `orchestrator/native/theme.json` retires as the interim source once the
  generated header carries the same names.
- **The control layer** (`orchestrator/native/ui/`, target `rengine_ui`): rounded buttons in three
  variants (ghost, standard, primary), grouped segmented buttons, selects, text fields with an icon
  slot and placeholder, checkboxes, sliders, separators, pills, labels, the focus ring and the
  transition clock. Conventions follow pinned microui exactly: `mu_Context` supplies ids, layout and
  input state; every widget takes `(mu_Context *ctx, ...)` and an `opt` flag word; return values are
  microui's `MU_RES_*`; nothing allocates; the header is the documentation. Drawing goes through
  `re_draw_*` because rounded rects, frames with an inner highlight, shadows, rings and gradients have
  no microui command. Upstream microui stays pristine.
- **Surfaces:** the 36px toolbar (brand, segmented view switcher, pane actions, project select, path
  field, agent select, Vim checkbox, theme button), the 28px tab strip (marker, dirty dot, overflow)
  and the segmented 22px status bar.
- **Draw list v2:** `RE_CMD_GRADIENT` with up to eight stops, plus the version bump and the same
  command in the SDL reference and all three GPU adapters.
- **Fonts and icons:** `RE_FACE_UI` becomes bundled Inter with `RE_FACE_UI_MEDIUM` and
  `RE_FACE_UI_SEMIBOLD`; `RE_FACE_ICON` is Bootstrap Icons. Both are pinned in `third_party` with
  hashes and licences in `sources.json`.

F67 takes the tree, editor, terminal and session browser. F68 takes menus, the theme panel, the hue
slider and theme files. F69 repeats the card evidence on Windows.

## Verification

- `tools/design.py cards` writes `design/cards.json`: per card and per element, the geometry
  (position, size, radius, padding, row height) and the resolved sRGB colours of every state, taken
  from the card HTML and the token layers, never hand-copied.
- `orchestrator/tests/native-design.spec.mjs` drives the desktop to each covered surface, captures a
  snapshot and asserts the reference's probe points: pixel colour at named coordinates for rest,
  hover, focus, active and disabled states, and geometry from the automation `state` op.
- The committed native desktop suite, CTest and the render comparison keep passing on macOS; the SDL
  reference stays byte-identical for the primitives that did not change, and the new gradient
  primitive is compared across all four backends like every other primitive.
- Evidence: `docs/evidence/design-foundations-macos-<date>.md`, including the full native snapshots
  for the owner's visual sign-off.

## Deferred

Windows card evidence (F69). Nested overlays, gradients beyond the accent slider, and any card that
F67 or F68 owns. The renderer's catalog entry and the control layer's place in the library packs are
F61's work; this feature only keeps the boundary clean.
