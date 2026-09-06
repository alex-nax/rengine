# Claude Design handoff for the native workspace

Date: 2026-09-06. Status: owner-directed preparation (“prepare this project for Claude Design to
enhance our UI”). It changes no accepted feature criterion and does not resume the paused NOLF goal;
the [D28 pause](000-charter.md) boundary is unchanged. Related: [native desktop](056-native-desktop.md),
charter D26–D27 and D29–D30, architecture constraints 14–15, [GPU rendering](065-gpu-rendering.md).

## Purpose

Claude Design edits HTML design-system projects. The desktop is C with pinned microui and cannot
load HTML. This spec defines how design source moves between the two: the design project owns
`design/`, and the desktop consumes resolved tokens through generated C. Since the 2026-09-06
theming update the design's visual language exceeds what the SDL_Renderer path can draw; spec 065
carries the renderer work, and the desktop keeps an interim theme source until then.

## Boundaries

- `design/` mirrors the Claude Design project “rEngine native workspace”
  (`9e977c1b-7cbd-4a89-90a4-5524771712d7`). Nothing under it is compiled, packaged, downloaded or
  loaded by the desktop, the service, the launcher or a game. Charter D26–D27 hold.
- `design/tokens.css` is the authoritative token form: three `:root` layers (palette, semantic
  roles, per-view) plus `[data-theme]` presets (default, teal, light). `design/tokens.json` is a
  generated mirror that keeps the design notes and the renderer primitive list.
  `python3 tools/design.py resolve <preset>` resolves `var()` chains and oklch to sRGB 8-bit.
- `orchestrator/native/theme.json` is the interim source of the shipping desktop's colours,
  typography and layout metrics; `generate` derives `orchestrator/native/theme.h` from it. The
  teal preset reproduces its surfaces and controls. The interim source retires when F60 generates
  the runtime theme from `tokens.css`.
- Cards are HTML with an `@dsCard` first line (name, group, subtitle, viewport) and one stylesheet
  link to `../../styles.css`, which imports `tokens.css` and `base.css`; no external URLs. Markup
  changes are proposals for C implementation under spec 065's primitives, never automatically
  applied behaviour.
- `check` rejects stale generated output, mirror drift, malformed or non-self-contained cards,
  undefined or cyclic token references, any numeric `mu_color`/`vterm_color_rgb` literal in
  `orchestrator/native/*.c`, and numeric sizes in `mu_layout_row` calls.
- Syncing uses Claude Design's incremental design-system tool with a per-run plan limited to
  `design/**`; the credential belongs to the owner's interactive `/design-login`.
- Standard library only for the tool; pinned upstream sources stay untouched.

## Round trip

1. Owner runs `/design-login` in an interactive Claude Code session, then asks to sync `design/`
   into the project above. Writes are `design/**`; deletes only for cards removed locally.
2. Edit in Claude Design.
3. Pull edited files back verbatim into `design/` (cards, `tokens.css`, `base.css`, `styles.css`),
   run `python3 tools/design.py generate` to refresh the mirror and manifest, then `check`.
4. Until F60, colour or metric changes for the shipping desktop go into `theme.json` deliberately,
   followed by `generate`, `npm run build` and a native smoke snapshot. Commit design and generated
   files together.
5. New primitives or controls become renderer or workspace features under spec 065.

## Verification for this preparation

- `python3 tools/design.py check` passes: header, mirror and manifest regenerate identically, all
  19 cards carry valid markers and the single stylesheet link, every preset resolves, and no native
  source hard-codes a colour or layout row size. `./init.sh` and the sidecar validator pass.
- `draw.c` consumes the generated header; native smoke snapshots before and after that wiring were
  byte-identical, and CTest and the native desktop suite passed (`Codex-progress.md`, Session 18).
- Resolving the teal preset reproduces the interim native surfaces and controls exactly (surface
  20, 24, 30; control 38, 46, 56; hover 52, 68, 78).

## 2026-09-06 theming update

- Pulled: `tokens.css` with the teal and light presets, rewritten `base.css`, `styles.css`, six new
  cards (buttons and fields, menus, theme architecture, theme panel, workspace light, workspace
  teal) and thirteen rewritten cards. The project's `_ds_manifest.json`, thumbnail and bundle files
  are app-generated and stay remote.
- Renderer requirements are tabulated in spec 065; KI-031 tracks the gap.
- `check` found `--terminal-cursor: var(--ui-accent-dim)` referencing an undefined token; corrected
  locally to `var(--re-accent-dim)`, pending a sync back. The pulled JSON carried different font
  stacks from the CSS; the mirror now follows the CSS.
- The former `import` command was retired: cards no longer carry `:root` blocks, and pulls replace
  files directly.

## Deferred and open

- Every owned native source uses `RE_COLOR_*` and `RE_METRIC_*` since 2026-09-06; non-design pixel
  arithmetic (glyph baseline nudge, drag threshold, timers, capacity limits) stays literal.
- No feature row exists for the design system itself; F60 covers applying the theming update.
- Seeding an exploratory Claude Design canvas from a screen card remains optional.
- Font glyph coverage, Windows rendering and image previews remain as recorded in spec 056.
