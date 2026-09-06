# Claude Design handoff for the native workspace

Date: 2026-09-06. Status: owner-directed preparation (“prepare this project for Claude Design to
enhance our UI”). It changes no accepted feature criterion, adds no inventory row and does not
resume the paused NOLF goal; the [D28 pause](000-charter.md) boundary is unchanged. Related:
[native desktop](056-native-desktop.md), charter D26–D27, architecture constraint 14.

## Purpose

Claude Design edits HTML design-system projects. The desktop is C with pinned microui and cannot
load HTML. This spec defines the one channel between them: a token file that generates both the
native theme header and self-contained preview cards, so a change made in Claude Design can be
pulled back into the tokens and rebuilt into the C desktop without a browser runtime anywhere.

## Boundaries

- `design/` is design material. Nothing under it is compiled, packaged, downloaded or loaded by
  the desktop, the service, the launcher or a game. Charter D26–D27 hold.
- `design/tokens.json` is the single source for colours, typography and layout metrics.
  `python3 tools/design.py generate` derives `orchestrator/native/theme.h`, `design/tokens.css`,
  `design/manifest.json` and the managed `re:tokens`/`re:base`/`re:palette`/`re:metrics` blocks
  inside every preview. `check` rejects hand edits to generated output and any
  `mu_color`/`vterm_color_rgb` literal in `orchestrator/native/*.c` outside the palette.
- Preview cards are self-contained HTML with an `@dsCard` first line and no external URLs. The
  `:root` token block is the machine-readable channel back to the repository. Markup changes made
  in Claude Design are proposals for C implementation, not automatically applied behaviour.
- Card content documents the real desktop: literal microui column widths, strings, states and the
  renderer's constraints. A proposal counts as implementable when the constraints card can express
  it; anything else is renderer work with its own spec.
- Syncing uses Claude Design's incremental design-system tool with a per-run plan. The plan lists
  `design/**` paths only; no other repository content is uploaded. The design credential belongs
  to the owner's interactive `/design-login`; agent sessions do not hold it, and this session's
  read attempt was refused for that reason.
- Standard library only for the tool. Generated C stays within the owned line limit and the
  pinned upstream sources remain untouched.

## Round trip

1. Owner runs `/design-login` in an interactive Claude Code session, then asks to sync `design/`
   into a design-system project (create one if none exists). Review the plan: writes are
   `design/**`, deletes are none for the first push.
2. Edit in Claude Design: token values in a card's `:root` block, or the card markup.
3. Pull an edited card back into `design/previews/...`, then run
   `python3 tools/design.py import design/previews/<group>/<card>.html`. Changed tokens are
   reported, `tokens.json` is rewritten and everything regenerates.
4. `npm run build`, then a native smoke snapshot and the desktop suite as applicable. Commit the
   tokens together with the regenerated header and cards.
5. A markup proposal becomes a feature spec and a bounded C change under the existing criteria.

## Verification for this preparation

- `python3 tools/design.py check` passes: header, CSS and manifest regenerate identically, all
  13 cards carry valid card markers and fresh managed blocks, and every native colour literal is
  a token. `./init.sh` and the sidecar validator pass.
- `draw.c` consumes the generated header. A native smoke snapshot taken with the previous binary
  and with the rebuilt one must be identical; CTest native tests must pass. Results are recorded
  in `Codex-progress.md`, Session 18.
- Import round trip: change one colour in a scratch copy of a card, run `import`, observe the
  token and header change, restore the tokens and regenerate.

## Deferred and open

- Replacing the remaining literal colours in editor, terminal, workspace, scroll, main and game
  sources with `RE_COLOR_*` waits until the in-flight spec 061/062 edits to those files are
  committed, so this change does not collide with that session. `check` already guards them.
- No feature row is added. If the owner wants UI enhancement tracked as work, a candidate row
  is “Apply an owner-approved Claude Design token/markup proposal to the native desktop with
  before/after native evidence on macOS”, depending on F32 and this spec.
- A Claude Design canvas of exploratory redesigns can be seeded from `screens/workspace.html`
  when the owner wants free-form mockups; it is a separate step from the design-system sync.
- Font glyph coverage, Windows rendering and image previews remain as recorded in spec 056.
