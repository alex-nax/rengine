# Per-project game declaration and the contract-2 reconciliation — macOS, 2026-09-06

Spec 078 implements F71: the toolbar's hard-coded "NOLF" button and the `nolf_preflight` /
`launch_nolf` agent tools are replaced by a contract-2 `game` block in `.rengine/project.json`,
a title-labelled toolbar button, generic `game_preflight` / `launch_game` tools and an `external`
surface that opens the game's own window. Work happened on branch `feat/project-game` in a
worktree from `43bbb80`; no live orchestrator, sidecar, agent or real game window was touched.
`rg -i nolf orchestrator/server orchestrator/agents orchestrator/native orchestrator/runtime
orchestrator/launcher orchestrator/*.mjs package.json` finds only the qualification script name
`test:game-nolf`.

The branch then merged main twice: `5ccadaf` (the owner's per-platform Vulkan memory ceiling,
which arrives unmodified — this lane never touched `native-render.spec.mjs`) and `6a3271d`, which
carries the project dashboard (spec 075, F65/F66) and the Claude Design split (F67–F69). The
second merge is the reconciliation described below.

## Fixtures

`orchestrator/tests/game-fixtures.mjs` declares a contract-2 project whose game is
`tools/game.sh` (second of two executable candidates; the first, `build/missing-game`, does not
exist), args `--flat --width 640`, env `FIXTURE_FLAVOUR=blue`, `requires: [data/present.bin]`,
surface `external`. The script prints its argv, the declared variable and its cwd, then idles
until SIGTERM.

Red first: `games.test.mjs` failed on the reader (`contract 2` rejected), the preflight (the old
"Build NOLF first / NOLF data is missing" issues), the launch (`declares no game` never raised)
and the launcher (`launcher.test.mjs` still saw "Build NOLF first"); the native fixture showed the
"NOLF" toolbar control and the status line `.rengine/project.json: unknown contract 2; this rEngine
supports contract 1`.

Green: the service tests cover contract 1 unchanged, contract 2 with and without `game`, a
`game` under contract 1 reported as `gameError` beside intact formats, sixteen named rejections
(bad and reserved env keys, a non-string env value, a placeholder in `args`, nine and zero
executables, a shell `argv[0]`, an unknown surface, an unknown key, a 33-character title, a bad
id, escaping and absolute `requires`, a missing surface), an unknown contract 3; preflight for an
undeclared root, a formats-only contract-2 root, a malformed game block, missing candidates (both
named) with two missing required files (one issue each), the ready external shape (no `adapter`),
an absolute candidate, a bare `sh` resolved through PATH and the `sdl2-interpose` adapter path;
launch of the external game (session `type: game`, title `Fixture game · game`, `surface`,
`game`, the declared env and cwd visible in its output, zero surface reservations), reuse through
the route and through `launch_game`, a 409 for an undeclared root, the `terminal` route still
refusing `type: game`, MCP discovery with `game_preflight` (read-only) and `launch_game`
(open-world) and no tool name or description matching `nolf`, `stop_session`, and a fresh launch
after Stop.

The native fixture `native-game-declaration.spec.mjs` starts on an undeclared root (no game
control across five polled frames), cycles the now-inspectable root button to the declared root,
finds the `Fixture game` control right of `Merge pane`, launches it, reads
`FIXTURE_GAME_STARTED args=--flat --width 640 flavour=blue cwd=…/declared` in a type-5 tab titled
`Fixture game · declared` under the `running` status row, confirms a second click reuses the one
session, stops it from Sessions and sees the `exited` status row. Snapshot
`.cache/evidence/native-game-declaration.bmp` was inspected: the button sits after Merge pane on
the first toolbar row, the tab shows "Running in its own window" above the retained output.

## Contract-2 reconciliation with the dashboard lane

Main and this lane extend the same declaration, so the shared files were unioned, never taken
from one side:

- `contracts/project-v1.schema.json`: one document with `contract` `[1, 2]`, `additionalProperties:
  false`, and BOTH optional `dashboard` and `game` properties; each lane's `$defs` sub-schema is
  kept verbatim (the shared `$defs` were byte-identical between the lanes, asserted while merging)
  and the description carries both sets of cross rules.
- `orchestrator/server/formats.mjs`: `readDeclaration` splits both optional blocks off before the
  contract-1 pass, then validates each through one shared `section` helper. `gameError` and
  `dashboardError` are independent: a bad game leaves the dashboard and the formats intact and
  vice versa, and either block under contract 1 is reported and ignored.
- `orchestrator/server/main.mjs`: `capabilities` advertise `dashboard: 1` and `projectGame: 1`.
  `orchestrator/runtime/worker.mjs` keeps forcing only the capabilities it serves itself; the game
  routes are forwarded to the host, so `projectGame` correctly comes from the host.
- `orchestrator/server/sessions.mjs`: the optional session `title` serves both lanes' callers, plus
  the game session's `surface` and `game`; the derived default no longer names a game (`Game ·
  <root>` where the dashboard lane still had `NOLF · <root>`).
- `orchestrator/agents/mcp-worker.mjs`: `dashboard_actions`/`dashboard_capture` and
  `game_preflight`/`launch_game` coexist, each behind its own capability guard, with
  `dashboard_capture` and `launch_game` both in `openWorldHint`.
- `orchestrator/native/workspace.c`: one toolbar array of 12 columns — brand, Tree, Dashboard
  (fixed), Shell, Agent, Manage, Sessions, Split vertical, Split horizontal, Merge pane, the
  declared game title, the Vim filler. Without a declared game the game slot becomes the filler and
  the count drops to 11, so the row arithmetic holds with both buttons present and with the
  dashboard alone.
- `orchestrator/native/app.c`: the dashboard probe/auto-open and the external-game view helpers are
  both present; `formats_loaded` reports `gameError` and still probes the dashboard.
- `orchestrator/native/theme.json`: `dashboard-width` 100 and `game-width` 110 coexist; the toolbar
  metric note and the `toolbar-row-1` string table now list the Dashboard button, which the
  dashboard lane had not recorded.

`orchestrator/tests/contract2.test.mjs` pins the result: a declaration carrying formats + game +
dashboard validates structurally and reads back all three; each block's error stays isolated;
both blocks under contract 1 are reported without losing the formats. The same document is
rejected by either lane alone — `$ has unknown key dashboard` against `132af4b` (this lane before
the merge) and `$ has unknown key game` against `7c2dc38` (main before the merge).

## Real consumer declarations

`orchestrator/tests/fixtures/` now holds the two real declarations verbatim:

- `vtmb-project.json` (`/Users/alex/vtmb-vr/.claude/worktrees/agent-a7139f860c8a520ff/.rengine/`):
  contract 2 with formats + a `surface: "external"` game + a dashboard. `validateSchema` returns
  zero errors; `readDeclaration` returns `contract 2`, `formats[0].id troika-vpk`, `game.id
  vtmb-flat` with `surface external`, `dashboard.title reSource`, and no `error`, `gameError` or
  `dashboardError`. `matchFormat` matches `gamedata/Vampire/pack000.vpk` and `PACK000.VPK` to
  `troika-vpk` and returns `null` for `pack000.txt`.
- `nolf-project.json` (`/Users/alex/nolf-improved/.rengine/project.json`): contract 1, unchanged,
  still validates and reads back with no game and no dashboard; `nolf/NOLF.REZ` matches
  `lithtech-rez`.
- `nolf-merged-project.json` (the dashboard lane's merged `project.json + dashboard.json`
  document): contract 2, validates, reads back `dashboard.title reLith` with no game.

## Gates (all on the reconciled tree, main merged at `6a3271d`)

- `npm test`: 43 passes, 0 failures, 6.07 s — both lanes' service suites plus the two new
  contract-2 composition tests.
- `npm run test:desktop`: 17 passes, 0 failures, 294.3 s. Test 3 is the dashboard tab, test 6 the
  declared game button, test 11 the GPU adapter budgets under the owner's per-platform ceiling.
- CTest in `.cache/desktop`: 4 passes, 0 failures, 0.05 s.
- `./init.sh`: passes (30 features). `python3 tools/design.py check`: consistent (`toolbar.game-width`
  85 → 110 alongside `dashboard-width` 100, new `game` strings, no literal row sizes).
- Native build: zero warnings under the picky flag set; all owned objects recompiled.
- Sidecars, `--index .cache/sidecars-contract2.sqlite`, run sequentially: repair (`check
  --fix-anchors`), review, `stamp`, `check` — clean for the ten touched files plus
  `native-workspace.spec.mjs`, whose `normal-native-launch-qualification` snippet was stale from
  this lane's own rename. The whole-tree check still reports 18 pre-existing diagnostics in files
  this session did not touch (`automation.c`, `bootstrap.c`, `draw.c`, `game.c`, `layout.c`,
  `main.c`, `scroll.c`, `terminal.c`, the five render backends, `draw_list.c`, `font.c`,
  `native-client.mjs`); the same diagnostics exist on main.
- Real-NOLF qualification through the declaration (`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm
  run test:game-nolf`): 1 pass, 0 failures, 3.34 s. The fixture writes a contract-2
  `.rengine/project.json` with the NOLF game block into its temporary project, so the live
  `sdl2-interpose` surface is reached through the declaration and not through any built-in path.

Windows is unqualified (KI-014): the `.exe` fallback and PATH walk are code only. The SDL3
cooperative surface does not exist; `external` is the supported shape for such consumers (KI-041).
