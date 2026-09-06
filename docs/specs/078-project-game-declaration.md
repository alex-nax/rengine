# Per-project game declarations (contract 3)

Date: 2026-09-06. Owner direction (explicit, overriding the AGENTS.md pause note): the toolbar's
hard-coded "NOLF" button and the `nolf_preflight`/`launch_nolf` agent tools name one game inside
rEngine. They are replaced by a per-project capability: a project declares its games in
`.rengine/project.json`, rEngine shows a control labelled by that declaration, launches the
declared executable and exposes generic agent tools. rEngine names no specific game anywhere in
server, native, agent or theme code. The second consumer (vtmb-vr, an SDL3-static application that
cannot use the SDL2 interposer) must be launchable in its own window today; the first consumer
(nolf-improved) keeps its live in-workspace surface through the same declaration.

**Shape decision, owner, 2026-09-06.** This lane first implemented a single optional root object
`game` under contract 2. The owner's nolf-improved session independently proposed an array
(`games`) under a contract bump, recorded there as F1615. The owner reconciled the two lanes onto
the array superset: `contract` becomes 1, 2 or 3; contract 3 adds the optional root key `games`;
the singular `game` key is removed entirely, because nothing had shipped it to a user, so there is
no migration path to keep and no alias to leave behind. The owner explicitly excluded the
deprecated NOLF-named tool aliases (`nolf_preflight`/`launch_nolf`) that the nolf-improved
proposal suggested keeping: they are gone and stay gone. This spec extends spec 074 (contract 1)
and spec 075 (contract 2's optional `dashboard`) the same way both extend their predecessor;
contract 1 and contract 2 declarations stay accepted unchanged.

## Declaration

Contract 3 adds an optional top-level `games` array:

```json
"contract": 3,
"games": [
  {
    "id": "nolf-flat",
    "title": "NOLF (flat)",
    "executable": ["build/relith-nolf", "build/Release/relith-nolf"],
    "args": ["--flat", "--game", "nolf", "--width", "1280", "--height", "720"],
    "env": { "RELITH_HIDDEN_WINDOW": "1", "RELITH_SKIP_INTRO": "1" },
    "cwd": "",
    "requires": ["nolf/NOLF.REZ"],
    "surface": "embedded"
  }
]
```

- `games`: 1–16 records. Declaring `games` **requires** `contract: 3`. That is the whole point of
  the bump: a reader that predates this contract rejects the document with *unknown contract 3*
  instead of the far less helpful *unknown key `games`*, so an operator running an older workspace
  is told to update it rather than to delete a key.
- `id`: kebab-case, at most 64 characters, **unique across the array**. Carried on the game session
  as `game` and used as the `gameId` selector on every route and tool.
- `title`: 1–32 characters. The toolbar label (one game) or the menu-entry label (several); the
  session and tab title is `<title> · <root name>`.
- `executable`: 1–8 candidates; the first that exists and is executable wins. Each candidate is
  resolved like a format `argv[0]` (spec 074): absolute as given; with a path separator relative
  to the project root (a `.exe` suffix is also tried on Windows); a bare name through the
  sidecar's PATH. Never a shell expression (`|`, `;`, `&`, `$`, backtick rejected).
- `args`: literal argv, 0–64 non-empty strings, no placeholders (`${…}` is rejected). Default `[]`.
- `env`: optional; keys match `^[A-Z][A-Z0-9_]*$`, values are literal strings (at most 4,096
  characters), at most 64 entries. Keys starting `RENGINE_`, `DYLD_` or `LD_` are reserved for the
  workspace and rejected by name. Kept from this lane's first implementation: NOLF's own launch
  needs `RELITH_HIDDEN_WINDOW` and `RELITH_SKIP_INTRO`.
- `cwd`: optional root-relative directory, confined to the root like every other declared path
  (no absolute path, no `..` segment, no backslash). `""` and an absent key both mean the project
  root, which stays the default. A missing or non-directory `cwd` is a named preflight issue.
- `requires`: optional, 0–32 root-relative regular files that must exist. Each missing file is one
  named preflight issue.
- `surface`: `embedded` (rEngine injects its cooperative SDL adapter and hosts the frames in a game
  tab, as the former `sdl2-interpose` did) or `external` (the process opens its own operating-system
  window; rEngine starts and tracks the session and retains its PTY output only). The enum value
  was renamed with the contract bump; nothing shipped the old spelling to a user.

`readDeclaration` accepts contract 1, 2 or 3. The schema's `contract` is the enum `[1, 2, 3]`,
`games` is an optional property under `additionalProperties: false`, so unknown keys are still
rejected. The reader validates the contract-1 part first and each optional block separately:
a bad `games` array is reported as `gamesError` (the offending path in the message) without
disabling the formats, the dashboard or the workspace, exactly as spec 075 reports
`dashboardError`; `games` under contract 1 or 2 is rejected the same way, by the contract it
needs, and ignored. The shared cross rules live in `orchestrator/server/game-rules.mjs` (reserved
and malformed env keys, root-relative `requires` and `cwd`, unique ids). The formats listing
(`GET /api/formats`, fetched once per connection per root) carries the accepted `games` array (or
`gamesError`) so the native desktop knows the titles and surfaces without a second request.

## Preflight and launch

`GET /api/game-config?rootId&gameId` and the MCP tool `game_preflight(gameId?)` return
`{ rootId, declared, id?, title?, surface?, executable?, args, env, requires, cwd, adapter?, issues, ready }`,
running nothing. `gameId` is optional everywhere; **omitted, it selects the first declared game**.
An unknown `gameId` is one clear error naming the declared ids.

- An undeclared root (no `.rengine/project.json`, or a declaration without `games`) answers
  `declared: false`, `ready: false`, `issues: ["This project declares no games in
  .rengine/project.json (contract 3)."]`.
- A malformed declaration or `games` array answers `declared: false` with its error as the issue.
- No resolvable executable adds an issue naming every candidate; each missing `requires` file
  adds `Required file is missing: <path>.`; a `cwd` that is not a directory adds
  `Working directory is missing: <path>.`.
- `embedded` additionally needs the adapter dylib on macOS (`Build the native surface first:
  npm run build:surface`) and reports the platform issue elsewhere. `external` has no surface
  prerequisite.

`POST /api/game { rootId, gameId }`, the MCP tool `launch_game(gameId?)`, the toolbar control and
`--launch-game` in the launcher launch the selected game, else reuse. **Reuse is per game id, not
per root** (owner-decided shape): a root that declares several games can have all of them running
at once, so a project can run its flat and its VR target side by side. A launch reuses the running
game session whose `rootId` *and* `game` both match, and otherwise spawns: cwd = the declared `cwd`
resolved inside the root (the root itself by default), env = the sidecar's shell environment plus
the declared `env`. For `embedded` the surface reservation
(`RENGINE_SURFACE_PORT`/`RENGINE_SURFACE_TOKEN`) and `DYLD_INSERT_LIBRARIES` are added, and the
reservation is released when the session exits. For `external` no surface item is reserved. The
session is `type: 'game'` with `title: "<title> · <root name>"`; its snapshot carries `surface` and
`game` (the declared id). A launch on an unready game fails with status 409 and the joined issues.
`--launch-game` in `orchestrator/launch.mjs` preflights the first declared game and reports its
issues before creating any shell or agent session.

## Native

The toolbar's game control follows the declaration count:

- **No games** for the bound root: no game control at all, and the row arithmetic collapses the
  column into the filler, as it already did.
- **Exactly one**: a button labelled with that game's `title`, which launches it.
- **Several**: a `Games` button that opens a menu window below the toolbar listing every declared
  game by title. A game whose preflight is ready is a button that launches it; a game whose
  preflight fails is a **disabled label** reading `<title> — unavailable: <first issue>`, mirroring
  how the dashboard lane disables an action with unmet `requires`/`tools`. This matters as soon as
  a project declares a target it cannot build everywhere — vtmb-vr declares a VR target beside its
  flat one — so a missing executable or required file names itself instead of the entry launching
  nothing. (Measured on this machine on 2026-09-06, both vtmb-vr entries preflight ready:
  `build/vtmb-vr` is present from an earlier build, so nothing is disabled there today; the
  disabled path is proven by the fixture's always-missing `fixture-absent`.) The menu re-preflights
  every declared game when it is opened, so a build makes an entry available without reconnecting.

The menu is a root container drawn after the panes, positioned and sized from generated metrics,
and while it is open the mouse events inside it are not routed to the view underneath. All widths
and row heights come from generated `toolbar` metrics; `design.py check` rejects literal row sizes.
The root button stays inspectable (`toolbar`/`Root`) so switching roots is drivable. Inspectable
control roles: `toolbar`/`Games` for the menu button, `game`/`<id>` for a launchable entry, and
`game-unavailable`/`<id>` for a disabled one.

For `embedded` the game tab is the existing live game view (texture, capture, Esc release). For
`external` the tab is a terminal-style view over the game session's PTY output (the session is
already a node-pty child) with a status row from the theme's string table: "Running in its own
window" while the session runs, "Game exited · reattach or Stop in Sessions" afterwards. The
Sessions view and Stop are unchanged; closing a tab detaches. The surface of a session is read
from the workspace state (`surface` on the session snapshot), so restored tabs, the session
browser's Attach and the initial `RENGINE_INITIAL_GAME` binding all pick the right view.

## Agents

`nolf_preflight` and `launch_nolf` are removed and no aliases replace them. `game_preflight`
(read-only) returns the preflight above; `launch_game` (open-world, executes the project's own
executable) launches or reuses one game session. Both take an optional `gameId` and default to the
first declared game; neither description names a game. Both require the host capability
`projectGame: 1`; an older retained host is told to update the workspace layer. The live connector
predates the tools and picks them up only through a layered `connector` update.

## Qualification of the real consumers

`orchestrator/tests/contracts.test.mjs` pins both real consumer declarations as fixtures:
vtmb-vr's contract-3 document (formats + two external games + dashboard) and nolf-improved's live
contract-2 document (formats + dashboard, no games), plus a contract-1 document. The two
real-NOLF fixtures (`native-nolf.spec.mjs`, `native-workspace.spec.mjs`, run with
`RENGINE_NOLF_ROOT`) stay as named qualifications of the `embedded` surface against the real NOLF
checkout, but they write a contract-3 `.rengine/project.json` with a `games` array into their
temporary project instead of relying on any hard-coded path; the scripts are `test:game-nolf` and
`test:workspace`. An `external` game is qualified by a temporary project whose executable is a
small script that prints and sleeps.

## Acceptance and verification

1. Service tests fail before the reader knows `games`, then cover: contract 1 and contract 2 still
   valid; contract 3 with and without `games`; `games` under contract 2 rejected by the contract it
   needs, with the formats and dashboard intact; rejections by name for a duplicate id, a 17th
   record, a bad env key, each reserved env prefix, a placeholder in `args`, more than 8
   executables, an unknown `surface`, an unknown key, a shell `argv[0]`, an escaping `requires`
   path, an escaping `cwd` and an over-long title; preflight issues for an undeclared root, a
   malformed declaration, a missing executable (naming the candidates), missing `requires` files
   (one issue each) and a missing `cwd`; an unknown `gameId` naming the declared ids; candidate
   order, absolute and bare-name resolution; `cwd` honoured at launch; launch of an `external`
   game through a temporary project with a script producer (session type, title, `surface`,
   `game`, declared env visible in its output, no surface reservation); **two games of one root
   running at once**, each reused by its own id; and a 409 on an unready game; MCP discovery shows
   `game_preflight` and `launch_game` with their optional `gameId` and not the removed names.
   `launcher.test.mjs` expects the undeclared message.
2. A native fixture (`native-game-declaration.spec.mjs`, in `test:desktop`) shows no game control
   for an undeclared root, the declared title for a single-game root, and for a two-game root a
   `Games` menu whose ready entry launches and whose failing entry renders disabled with its first
   issue; it shows the external game's output in its tab with the running status, reuses the
   session on a second click, and stops it from Sessions. `native-game.spec.mjs` keeps qualifying
   the live surface.
3. `npm test`, `npm run test:desktop`, CTest, `./init.sh`, design check and sidecar validation
   pass; the native build has zero warnings. Optional evidence: `RENGINE_NOLF_ROOT=… npm run
   test:game-nolf` passes through the declaration.

Boundaries: no new npm or C dependency; no game is named in rEngine code, theme strings, tool
descriptions or package scripts (the named real-NOLF qualification test and its npm script are the
only permitted mention); a cooperative surface for SDL3/static applications is a later spec
(recorded as a known issue); Windows stays unqualified (KI-014).
