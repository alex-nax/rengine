# GPU rendering with graphics-API adapters

Date: 2026-09-06. Status: owner architectural decision, recorded as charter D29–D30 and proposed as
features F56–F61. No renderer code exists yet; the shipping desktop still draws through SDL_Renderer.
Related: [native desktop](056-native-desktop.md), [design system](064-design-system-handoff.md),
architecture constraint 15, [library quality](../library-quality.md).

## Decision

- The desktop moves to full GPU rendering. SDL2 keeps windowing, input, clipboard and surface
  creation; drawing moves from SDL_Renderer to an owned renderer core behind a graphics-API adapter
  boundary. Adapters arrive in this order: OpenGL first, then Metal, then Vulkan.
- The renderer is a candidate approved rendering library for the curated base. It earns that status
  only through the [library-quality](../library-quality.md) record and the D24 adoption rules: explicit
  inputs, pinned dependencies, no umbrella runtime, and at least one game adopting it through an
  adapter with passing integration checks. Games are never required to use it.
- Appearance is designed in the Claude Design project and pulled into `design/` (spec 064). The
  theming update pulled on 2026-09-06 is the first design target for the GPU renderer. The
  interim `orchestrator/native/theme.json` → `theme.h` path keeps the current look until then.

## What the theming update asks of the renderer

Extracted from `design/tokens.json` (`renderer.primitives`), the rendering-primitives card and the
component stylesheet. The SDL_Renderer path can draw none of the starred items today.

| Primitive | Used by | Notes |
| --- | --- | --- |
| Filled rectangle with alpha and per-corner radius 0–6px ★ | Every control, pane, tab, popover, pill, dot | Radius comes from `--ui-radius` (3px) and `--ui-radius-lg` (6px); circles are radius = half size. |
| 1px frame plus 1px inner highlight ★ | Buttons, fields, selects, panes | Highlight is `rgb(255 255 255 / 0.05)`, the only permitted gradient-like effect. |
| Soft shadow behind one overlay layer ★ | Popovers, menus, theme panel, slider knob, history indicator | One blurred rectangle; `--ui-shadow` and `--ui-shadow-sm`. |
| Two text faces at several sizes ★ | UI sans 11/12/13px with weights 500–700; mono 13/19 cells | Needs a glyph atlas per face, size and density; bold is a real face in the UI font. |
| Glyph icons tinted per use ★ | Tabs, tree, toolbar, menus, status | Cards use Unicode symbols; the desktop needs a bundled, licensed icon font or atlas because trusted local fonts do not guarantee coverage. |
| 2px focus ring outside a control ★ | Focused buttons and fields | `--ui-focus`. |
| Hover and focus transitions ≤ 90ms ★ | Buttons, tabs, dividers, scroll thumbs | The event-driven loop needs a transition clock that schedules redraws for their duration only. |
| One popover layer with clipping ★ | Menus, agent picker, theme panel | Drawn above every pane; no nested overlays. |
| Transparent-track overlay scrollbars with rounded thumbs ★ | Editor, terminal, lists | Thumb radius 5px; accent while dragging. |
| Hue gradient ★ | Theme panel accent slider only | Outside the stated primitive list; needs either a gradient fill or a small texture. Record as an open question. |
| Colour resolution from tokens | Everything | `oklch` and `var()` chains resolve at generation time through `tools/design.py resolve`; the runtime only blends RGBA. |
| Live game texture | Game tab | Unchanged: one latest frame composited with the UI. |
| HiDPI | Everything | Geometry in logical pixels, glyphs rasterized at drawable density, as today. |

Layout changes that ride on the renderer but are workspace work, not rendering work: a single 36px
toolbar with segmented view switcher and selects, 28px tab strip with marker and dirty dot, tree
indent and meta column, editor breadcrumb bar, 44px gutter, current-line tint and syntax colours,
segmented 22px status bar, session table with state pills, and the menus and theme panel.

## Architecture

```
workspace and views  →  draw list (backend-neutral)  →  renderer core  →  API adapter  →  SDL2 window
microui commands ─┘     clip, rrect, frame, shadow,      batching, glyph     OpenGL / Metal /
owned controls ───┘     text run, icon, texture, ring     and icon atlases,   Vulkan / SDL_Renderer
                                                          SDF shapes          (reference, fallback)
```

- The draw list is the contract: RGBA8 colours, logical-pixel geometry, a density factor, clip
  rectangles, and the primitives in the table. It is produced once per frame by the workspace and is
  independent of any API. Adapters consume it; nothing above the list includes an API header.
- Pinned upstream microui stays pristine (agent rule). Its rect/text/icon/clip commands are
  translated into the draw list. Controls the design needs beyond microui (rounded buttons, tabs
  with markers, menus, sliders, pills) come from an owned control layer that emits draw-list
  commands directly. The design's mention of “a microui fork” is not selected; a fork would need
  its own owner decision.
- Backend selection is explicit (`--renderer opengl|metal|vulkan|sdl`) and recorded in run evidence.
  The SDL_Renderer adapter remains the reference and fallback until each GPU adapter passes its gate.
- OpenGL targets 3.3 core on Windows and 4.1 core on macOS through SDL's GL context; Metal uses
  SDL's Metal view on macOS; Vulkan starts on Windows and extends to Linux and Android when those are
  targeted. Shader sources are owned, versioned files; no runtime shader downloads.
- Fonts follow the existing trusted-local policy for the UI and mono faces; the icon set is a pinned
  third-party asset with its license recorded in `third_party/sources.json`.
- Theme data: `tools/design.py resolve <preset>` already yields sRGB values for default, teal and
  light. The renderer work replaces `theme.json` with generation from `design/tokens.css` (three
  layers plus presets), a runtime theme table, and live reload from the theme panel.

## Phases and acceptance

| Feature | Milestone | Deliverable and gate |
| --- | --- | --- |
| F56 | R0 | Draw-list contract and the SDL_Renderer reference adapter. Native smoke snapshots stay byte-identical to the pre-change baseline; CTest and the native desktop suite pass. |
| F57 | R0 | OpenGL adapter on macOS and Windows. Per-primitive snapshot tests (radius, frame, shadow, text, icon, ring) and whole-screen comparisons against the reference within a recorded tolerance; frame time and memory measured against budgets set beforehand; explicit backend switch with fallback. |
| F58 | R1 | Metal adapter on macOS with the same comparisons and measurements. |
| F59 | R1 | Vulkan adapter on Windows, with the same comparisons and measurements; other platforms when targeted. |
| F60 | R2 | The theming update on the GPU renderer: tokens.css presets generate the runtime theme, the redesigned toolbar, tabs, tree, editor, terminal, status bar, session browser, menus and theme panel match their Claude Design cards, theme files import and export, and every existing behaviour gate still passes. |
| F61 | R3 | Rendering library candidacy: catalog entry with the library-quality record, conformance checks, and one game adopting the renderer through an adapter with evidence. |

Windows evidence needs the authorized source transfer (KI-014). Each phase records evidence per
platform; no phase marks an earlier feature passing.

## Boundaries

- No Electron or browser runtime (D26–D27). No universal game renderer is imposed on games; the
  roadmap's expansion rule still applies to them. The workspace renderer is the one approved
  rendering deliverable.
- The renderer never becomes a mandatory dependency of a curated library or a game; adoption goes
  through a game-owned adapter and reverts to the game's own renderer without workspace changes.
- Resource budgets are measured before adapters replace the reference path, per constraint 14.

## Open questions for the owner

- Icon set: which licensed font or atlas, and whether cards should switch from Unicode symbols to
  its glyph names.
- UI font policy: system sans as designed, or a bundled face for identical rendering on both desktops.
- Owned control layer over pristine microui, as proposed here, versus the fork the design mentions.
- OpenGL floor (3.3 core versus 4.1) and the first Vulkan platform.
- Whether R0 may start before desktop v0 (F48) closes, or waits for it.
- The hue gradient in the theme panel: gradient primitive, texture, or a discrete swatch row only.
