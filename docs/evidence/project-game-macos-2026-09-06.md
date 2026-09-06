# Per-project game declarations (contract 3) — macOS, 2026-09-06

Spec 078 implements F71: the toolbar's hard-coded "NOLF" button and the `nolf_preflight` /
`launch_nolf` agent tools are replaced by a contract-3 `games` array in `.rengine/project.json`,
a toolbar control labelled from the declaration, generic `game_preflight` / `launch_game` tools
taking an optional `gameId`, and an `external` surface that opens the game's own window. Work
happened on branch `feat/project-game` in a worktree; no live orchestrator, sidecar, agent or real
game window was touched. `rg -i nolf -g '!*._llm.json' orchestrator/server orchestrator/agents
orchestrator/native orchestrator/runtime orchestrator/launcher orchestrator/*.mjs package.json
contracts/` returns exactly one line: the qualification script name `test:game-nolf` in
`package.json`. (The `._llm.json` sidecars excluded there mention it only in `docs/specs/055-…`
references, one `formatview.c` note recalling a NOLF.REZ-driven microui defect, and the
`mcp-worker.mjs` note recording that the removed tools have no alias.)

The branch merged main twice: `5ccadaf` (the owner's per-platform Vulkan memory ceiling, which
arrives unmodified — this lane never touched `native-render.spec.mjs`) and `6a3271d`, which carries
the project dashboard (spec 075, F65/F66) and the Claude Design split (F67–F69).

## The contract-3 rework (owner decision, 2026-09-06)

This lane first shipped a single optional root object `game` under contract 2. The owner's
nolf-improved session independently proposed an array under a contract bump (recorded there as
F1615), and the owner reconciled the two onto the array superset, minus that proposal's deprecated
NOLF-named tool aliases. What changed here:

- `contract` is the enum `[1, 2, 3]`; contract 3 adds the optional root key `games`, 1–16 records
  with unique kebab-case ids. The singular `game` is removed outright, with no alias: nothing had
  shipped it to a user, so there is no migration path to keep.
- Declaring `games` requires `contract: 3`. A reader that predates the bump answers `unknown
  contract 3; this rEngine supports contracts 1 and 2` rather than `unknown key games`, which is
  the whole point of the bump; this reader reports `gamesError` — `games requires contract 3
  (declared contract 2)` — for a `games` block under 1 or 2, leaving formats and dashboard intact.
- New per-record `cwd`: root-relative, confined like every other declared path, with `""` and an
  absent key both meaning the project root. `spawnTerminal` re-confines the resolved directory
  against the root before spawning.
- `surface` `sdl2-interpose` is renamed `embedded` everywhere, including the platform-support
  message ("The embedded game surface needs host integration and qualification on this platform.")
  and the native tab's reported surface. `env` is kept, against the sibling proposal, because
  NOLF's own launch needs `RELITH_HIDDEN_WINDOW` and `RELITH_SKIP_INTRO`.
- `GET /api/game-config?rootId&gameId`, `POST /api/game {rootId, gameId}`, `game_preflight(gameId?)`
  and `launch_game(gameId?)`: `gameId` is optional and selects the first declared game when
  omitted; an unknown id is a 404 naming the declared ids
  (`Unknown gameId "nope" for this project; it declares fixture-game, fixture-absent,
  fixture-second.`).
- **Reuse is per game id, not per root.** A launch coalesces and reuses on the (root, game id)
  pair, so one project can run several declared games at once — the flat and the VR target side by
  side. An undeclared project fails before the reuse lookup, so a game session started outside a
  declaration can never be handed back as "the project's game".

## Fixtures

`orchestrator/tests/game-fixtures.mjs` declares a contract-3 project with up to three games:
`fixture-game` (`tools/game.sh`, the second of two candidates — the first, `build/missing-game`,
does not exist; args `--flat --width 640`, env `FIXTURE_FLAVOUR=blue`, `requires:
[data/present.bin]`, `surface: external`), `fixture-second` (`tools/second.sh`) and
`fixture-absent` (`build/absent-game`, which never exists, so its preflight always fails). The
scripts print their argv, the declared variable and their cwd, then idle until SIGTERM.

Red first: 6 of 43 service tests failed before the reader knew `games` — the two contract tests,
the games declaration/preflight/launch tests and the launcher's undeclared message.

Green: the service tests cover contracts 1 and 2 unchanged, contract 3 with and without `games`,
`games` under contracts 1 and 2 reported as `gamesError` beside intact formats and dashboard,
twenty named rejections (bad and reserved env keys, a non-string env value, a placeholder in
`args`, nine and zero executables, a shell `argv[0]`, an unknown surface — the old
`sdl2-interpose` spelling is used as the unknown value — an unknown key, a 33-character title, a
bad id, escaping and absolute `requires`, escaping and absolute `cwd`, a missing surface, a
duplicate id, a 17th record, an empty array), an empty `cwd` accepted as the project root, and an
unknown contract 4; preflight for an undeclared root, a formats-only contract-3 root, a malformed
games array, missing candidates (both named) with two missing required files and a missing working
directory (one issue each, in that order), the ready external shape (no `adapter`), a declared `cwd`
resolved under the root, an absolute candidate, a bare `sh` resolved through PATH, the `embedded`
adapter path, the first-declared default, an explicit `gameId`, a failing `gameId` and an unknown
one; launch of the external game (session `type: game`, title `Fixture game · game`, `surface`,
`game`, the declared env and the declared `work/` cwd visible in its output, zero surface
reservations), reuse by id through the route and through `launch_game`, **two games of the same
root running at once**, a 409 for an undeclared root and for the unready `fixture-absent`, the
`terminal` route still refusing `type: game`, MCP discovery with `game_preflight` (read-only) and
`launch_game` (open-world) both carrying an optional `gameId` and no tool name or description
matching `nolf`, and a fresh launch after Stop.

The native fixture `native-game-declaration.spec.mjs` has two tests. The first starts on an
undeclared root (no game control across five polled frames), cycles the inspectable root button to
a single-game root, finds the `Fixture game` control right of `Merge pane` and no `Games` control,
launches it, reads `FIXTURE_GAME_STARTED args=--flat --width 640 flavour=blue cwd=…/declared` in a
type-5 tab titled `Fixture game · declared` under the `running` status row, confirms a second
click reuses the one session, stops it from Sessions and sees the `exited` status row. The second
binds a three-game root: only a `Games` control exists (no per-title button, no menu rows until it
is opened); opening it lists all three, with `fixture-game` and `fixture-second` as `game`
controls and `fixture-absent` as a `game-unavailable` control; `re_app_inspect` reports the
rendered rows, and the disabled one reads

    Fixture absent — unavailable: Game executable not found; expected build/absent-game in the selected project.

Choosing `fixture-second` launches it (`Fixture second · many`, `surface external`) and closes the
menu; reopening and choosing it again reuses the one session; choosing `fixture-game` afterwards
leaves both running. Snapshots `.cache/evidence/native-game-declaration.bmp` and
`.cache/evidence/native-games-menu.bmp` were inspected: the menu hangs below the toolbar at the
control's left edge, clamped inside the window, ready entries drawn as left-aligned buttons and
the failing one as a plain label — the same shape the dashboard lane uses for an action with unmet
`requires`/`tools`. A long issue string clips at the menu's right edge, as every long label in
this desktop does; the full text is in the declaration's preflight and in the inspect payload.

## Reconciliation with the dashboard lane

Main and this lane extend the same declaration, so the shared files were unioned, never taken
from one side:

- `contracts/project-v1.schema.json`: one document with `contract` `[1, 2, 3]`,
  `additionalProperties: false`, and BOTH optional `dashboard` and `games` properties; each lane's
  `$defs` sub-schema is kept verbatim and the description carries both sets of cross rules.
- `orchestrator/server/formats.mjs`: `readDeclaration` splits both optional blocks off before the
  contract-1 pass, then validates each through one shared `section` helper whose `SECTIONS` table
  gives each block the contract it needs — dashboard 2, games 3. `gamesError` and `dashboardError`
  are independent: a bad games array leaves the dashboard and the formats intact and vice versa.
- `orchestrator/server/main.mjs`: `capabilities` advertise `dashboard: 1` and `projectGame: 1`.
  `orchestrator/runtime/worker.mjs` keeps forcing only the capabilities it serves itself; the game
  routes are forwarded to the host, so `projectGame` correctly comes from the host.
- `orchestrator/server/sessions.mjs`: the optional session `title` serves both lanes' callers, plus
  the game session's `surface`, `game` and the confined `cwd`; the derived default names no game.
- `orchestrator/agents/mcp-worker.mjs`: `dashboard_actions`/`dashboard_capture` and
  `game_preflight`/`launch_game` coexist, each behind its own capability guard, with
  `dashboard_capture` and `launch_game` both in `openWorldHint`.
- `orchestrator/native/workspace.c`: one toolbar array of 12 columns — brand, Tree, Dashboard
  (fixed), Shell, Agent, Manage, Sessions, Split vertical, Split horizontal, Merge pane, the game
  control, the Vim filler. Without declared games the game slot becomes the filler and the count
  drops to 11, so the row arithmetic holds in all three declaration states.
- `orchestrator/native/theme.json`: `dashboard-width` 100 and `game-width` 110 coexist, plus
  `games-menu-width` 640 and `games-menu-inset` 4; the toolbar metric note, the `toolbar-row-1`
  string list and a new `games-menu` string list record the menu.

## Real consumer declarations

`orchestrator/tests/contracts.test.mjs` (renamed from `contract2.test.mjs`) pins both real
declarations, copied verbatim into `orchestrator/tests/fixtures/`:

- `vtmb-project.json` (`/Users/alex/vtmb-vr/.rengine/project.json`): **contract 3** with formats +
  two `surface: "external"` games + a dashboard. `validateSchema` returns zero errors;
  `readDeclaration` returns `contract 3`, `formats[0].id troika-vpk`, games
  `[vtmb-flat "VtMB" external, vtmb-vr "VtMB (VR)" external]`, `dashboard.title reSource`, and no
  `error`, `gamesError` or `dashboardError`. `matchFormat` matches `gamedata/Vampire/pack000.vpk`
  and `PACK000.VPK` to `troika-vpk` and returns `null` for `pack000.txt`.
- `nolf-merged-project.json` (`/Users/alex/nolf-improved/.rengine/project.json`, byte-identical to
  the live file): **contract 2**, formats + dashboard, no games. It validates and reads back
  `dashboard.title reLith` unchanged under the new reader.
- `nolf-project.json`: the earlier contract-1 document, still valid, with no games and no
  dashboard; `nolf/NOLF.REZ` matches `lithtech-rez`.

Preflighting the live vtmb-vr root through the service (nothing run) returns no `error`,
`gamesError` or `dashboardError` and **both** games ready, so the menu rows there read `VtMB` and
`VtMB (VR)`. The brief for this session expected the VR entry to be the disabled example because
it does not build on macOS; on this checkout `build/vtmb-vr` is a Mach-O arm64 binary dated
2026-08-23, so it resolves and the entry is launchable. The disabled path is therefore proven by
the fixture's always-missing `fixture-absent`, not by the real consumer; the vtmb-vr entry will
disable itself with the same message the moment that binary or
`gamedata/Vampire/pack000.vpk` is absent.

## Gates

- `npm test`: 43 passes, 0 failures, 6.0 s.
- `npm run test:desktop`: 18 passes, 0 failures, 310.3 s (the new multi-game menu test is the
  eighteenth).
- CTest in `.cache/desktop`: 4 passes, 0 failures, 0.91 s.
- `./init.sh`: passes (30 features). `python3 tools/design.py check`: consistent — 19 design cards,
  the token mirror and 3 presets, no literal row sizes in native sources.
- Native build from a wiped `.cache/desktop`: zero warnings under the picky flag set. The rebuild
  caught a real defect it would otherwise have hidden: adding `game[65]` to `RePending` made the
  existing aggregate initialiser consume the `timeout` argument into the new array
  (`-Wmissing-field-initializers`), which is fixed.
- Sidecars, `--index .cache/sidecars-contract3.sqlite`, run sequentially: index, repair (`check
  --fix-anchors`), review, `stamp`, `check` — clean for the nine touched files, with two new
  entries (`games.mjs#launch-identity`, `game-rules.mjs#working-directory`) and one new native
  entry each in `app.c` (`games-preflight-cache`) and `workspace.c`
  (`games-menu-owns-its-pointer`). The whole-tree check still reports the same 18 pre-existing
  diagnostics in files this session did not touch; they are present on main.
- Real-NOLF qualification through the declaration (`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm
  run test:game-nolf`): 1 pass, 0 failures, 3.26 s. The fixture writes a contract-3
  `.rengine/project.json` whose `games` array holds the NOLF record with `cwd: ""` and `surface:
  "embedded"`, so the live cooperative surface is reached through the declaration and not through
  any built-in path.

Windows is unqualified (KI-014): the `.exe` fallback and PATH walk are code only. The SDL3
cooperative surface does not exist; `external` is the supported shape for such consumers (KI-041).
