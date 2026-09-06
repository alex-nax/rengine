# Per-project game declarations (contract 3)

Date: 2026-09-06. Owner direction (explicit, overriding the AGENTS.md pause note): the toolbar's
hard-coded "NOLF" button and the `nolf_preflight`/`launch_nolf` agent tools name one game inside
rEngine. They are replaced by a per-project capability: a project declares its games in
`.rengine/project.json`, rEngine shows a control labelled by that declaration, launches the
declared executable and exposes generic agent tools. rEngine names no specific game anywhere in
server, native, agent or theme code. The second consumer (vtmb-vr, an SDL3-static application that
cannot use the SDL2 interposer) must be launchable in its own window today; the first consumer
(nolf-improved) keeps its live in-workspace surface through the same declaration.

**Launch-surface decision, owner, 2026-09-06 — reverses part of this spec.** The first
implementation put the launch control on the toolbar. The reLith consumer then launched a game from
its dashboard and got a terminal tab instead of a game pane, because dashboard launches go through
`kind: "script"` actions while only the toolbar button reached the game surface; `list_sessions`
showed it plainly, `type: "game"` for the button and `type: "terminal"` for the dashboard action.
The owner's decision: **the dashboard is where a game is launched from.** Contract 3's dashboard
gains an action `kind: "game"` that references a declared record by id and launches it through the
same route the toolbar button used, and **the toolbar game control is removed entirely** — the
button, the multi-game `Games` menu and its disabled-entry rendering, removed rather than relabelled
or hidden behind a flag. Configurable toolbar items are a separate rEngine feature the owner will
scope later; this spec deliberately leaves no stub button and no replacement. The preflight and
launch machinery below is unchanged and is exactly what the dashboard action now calls.

This is recorded here so the history stays legible: the toolbar game control **was built** (commit
`0cf70b6` on this branch) and **was removed by owner decision on 2026-09-06**. Nobody should re-add
it from this document.

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
- `title`: 1–32 characters. Names the record wherever rEngine shows it (a dashboard game action
  supplies its own action title); the session and tab title is `<title> · <root name>`.
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

### The error message is the recovery path (decision, 2026-09-06)

Each section fails whole: one bad `into` on one capture action empties `dashboard.groups` for the
whole project, because `dashboardError` is reported instead of the block. That stays — rendering a
partial dashboard from an invalid declaration would show something that does not match the file,
which is worse than showing nothing and an error. But with the toolbar game control removed, the
dashboard is the only human path to launch any game, so that one string is the entire recovery
path for a project whose own `games` records are perfectly valid. It has to say *which record*.

Every cross-rule error therefore names the record beside its JSON path — `$.dashboard.groups[1]
.actions[1] (quest-screen).into must be root-relative`, `$.games[1] (vtmb-vr).cwd must be
root-relative`, `$.formats[0] (troika-vpk).default must be one of its modes`. The path is what a
machine consumer keys on and never moves; the id is what a human greps for in the file. Rules:

- The **innermost** record on the path is named, not every level: a named action already locates
  itself (action ids are unique across the dashboard), and naming its group too would push the id
  a further ~8 columns right in surfaces that clip.
- A record whose `id` is missing or not a string falls back to the nearest named ancestor
  (`$.dashboard.groups[0] (device).actions[0].into …`), and to the bare path when nothing on the
  path is named. `undefined` is never printed and no name is invented.
- **Duplicate-id errors keep the bare path.** They already quote the id; what they must stay
  unambiguous about is *which occurrence* repeats, and that is the index.
- Structural (schema) errors keep bare paths. `schema.mjs` is a generic validator with no notion of
  a record, and for `formats` a structural failure short-circuits before the cross rules anyway.

**Truncation stays at three problems and now says what it hides**
(`…; and 2 more problems`). The cap is not raised: the message is one **unwrapped** line in both
places it is read — the dashboard tab label, clipped at the pane width, and the workspace status
row, ~159 monospace columns at the default 1280-wide window (8 px cell) and truncated into a
512-byte buffer. Three id-carrying problems already fill it, so a larger cap would push content off
the right edge rather than closer to a fix, and problems cascade anyway (one bad record yields
several). What was actually missing was knowing that the list was cut, so the count is stated — and
stated last, because it is the least load-bearing part of the line and the first thing that may
clip. The id, by contrast, lands around column 55–70, inside every surface that renders this.

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

`POST /api/game { rootId, gameId, args? }`, the MCP tool `launch_game(gameId?, args?)`, a dashboard
`game` action and `--launch-game` in the launcher launch the selected game, else reuse. `args` is
optional literal argv **appended** to the record's own `args`, validated like the record's (0–64
non-empty strings, no `${…}` placeholder, no shell). **Reuse is per game id, not
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

### The same game with different arguments (decision, 2026-09-06)

Two dashboard actions may reference the SAME record with DIFFERENT `args` — vtmb-vr's plain flat
launch and its `--newgame` variant are exactly that. Three shapes were possible and the choice is
deliberate:

1. Coalesce on (root, game id) and let the second launch silently attach to the running session,
   dropping its own arguments. **Rejected.** Someone clicking "new game" would get the old session
   with no indication why: a silent wrong result, which is worse than a visible refusal.
2. Coalesce on (root, game id, argv) so a different argv starts its own session.
3. Keep coalescing per (root, game id) and **refuse** the second launch with a message naming both
   argv lines.

**Chosen: 3.** The declared game id is already the single identity of a running game session
everywhere else in this design — `launch_game(gameId)` and `game_preflight(gameId)` select by it,
the session snapshot carries `game: <id>`, the native tab binding and `RENGINE_INITIAL_GAME` resolve
through it, and reuse is defined on the (root, game) pair. Shape 2 would make that id ambiguous:
two live sessions of `vtmb-flat` and no way for an id-keyed tool or route to say which one it means,
for the sake of running two variants of one game at once — something neither consumer asked for.
So a launch whose effective argv differs from the running session's fails with status 409 and
`<title> is already running with different arguments (<running argv>); stop it in Sessions before
launching it with <requested argv>.` The refusal is visible, names the difference, and tells the
operator the one action that resolves it. Identical argv still reuses, so clicking the same action
twice is idempotent, and the in-flight coalescing map keys on (root, game id) with the requested
argv beside it: an identical concurrent launch joins the flight, a differing one waits for it and
then meets the same refusal instead of racing a second spawn.

## Dashboard game actions (contract 3)

Spec 075's dashboard action kinds become `script | log | capture | game`. A `game` action:

```json
{ "id": "flat", "title": "Flat desktop: main menu", "kind": "game", "game": "vtmb-flat" }
{ "id": "flat-newgame", "title": "Flat desktop: new game", "kind": "game", "game": "vtmb-flat", "args": ["--newgame"] }
```

- `game`: **required**, must equal the `id` of a record in this declaration's `games` array. A
  reference to an undeclared id is a cross-field error reported like every other cross rule —
  `$.dashboard.groups[g].actions[i] (<action id>).game references undeclared game id "x"; this
  declaration declares a, b` (or `declares no games`) — so it lands in `dashboardError` and disables neither the
  formats nor the `games` array nor the workspace. When the `games` block itself failed validation
  the reference check is skipped: `gamesError` already names the real problem and a second,
  derived error would only mislead.
- `args`: **optional** literal argv appended to the referenced record's own `args`; the same rules
  as everywhere (non-empty strings, no `${…}` placeholder, no shell), enforced as a cross rule so
  script-action `args` keep their existing meaning.
- Availability comes from the referenced record's preflight, exactly as an action with unmet
  `requires`/`tools` renders today: an unbuilt or missing executable renders the action disabled
  with its first issue named, through the same preflight path as `game_preflight` rather than a
  duplicate set of checks. A `game` action's own `requires`/`tools` are checked **in addition** to
  the record's, and `description`/`artifacts` keep their meaning.
- Running one goes through `POST /api/dashboard-run`, which for this kind calls the launch above
  and returns the **game** session snapshot, so `embedded` streams into a pane and `external` opens
  its own window with its output retained. The replaceable worker serves the action by calling the
  retained host's game route, so a host that predates `projectGame: 1` reports that rather than
  silently opening a terminal.

**Why `args` is in the contract at all.** One consumer needs it: vtmb-vr's dashboard has a plain
flat launch and a `--newgame` variant, and `--newgame` is a real flag of its `src/main.cpp`. The
reLith session's `--world`/`--shells`/`--campaign` modes turned out **not** to be engine flags —
nothing in their engine parses them; their fast-start script rewrites a `boot_mode` value into a
temporary copy of a profile and passes `--profile FILE`, which the engine does parse. The general
rule worth keeping from that: **`args` serves a variant expressible as argv; a variant that needs a
different config file or profile is not expressible as argv and belongs in its own `games` record
or in a `script` action.**

## Native

**There is no game control on the toolbar.** The button, the `Games` menu, its `game` and
`game-unavailable` control roles, the per-game preflight cache behind them and the `toolbar.game-*`
metrics and strings are removed with the decision above. Toolbar row one is a fixed set of columns
again — brand, Tree, Dashboard, Shell, Agent, Manage, Sessions, Split vertical, Split horizontal,
Merge pane, then the Vim checkbox filling the rest — with no conditional column and therefore no
run-time row arithmetic to get wrong; `theme.json`'s `toolbar-row-1` string list and metric note
match it exactly. Games are launched from the Dashboard tab.

A `game` action renders in the dashboard tab like any other action: a button with its title and the
muted `kind · description` line when it is available, and a **label, never a button**, when it is
not. A game action's unavailable label reads `<title> — unavailable: <first issue>` (the preflight
issue reads as a sentence on its own, so it is not prefixed with `missing <type> <name>` the way an
unmet `requires`/`tools` entry is). Clicking an available one posts `dashboard-run` and the returned
session opens as a game tab through the existing session-tab path, so `embedded` gets the live view
and `external` gets the retained-output view. The inspectable roles stay the dashboard's own:
`dashboard-action`/`<action id>` and `dashboard-unavailable`/`<action id>`.

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
executable) launches or reuses one game session and additionally takes the optional `args` of a
dashboard game action, so an agent can reproduce a listed game action exactly. `dashboard_actions`
lists game actions with their `game` id and `args` beside the other kinds. Both game tools take an
optional `gameId` and default to the
first declared game; neither description names a game. Both require the host capability
`projectGame: 1`; an older retained host is told to update the workspace layer. The live connector
predates the tools and picks them up only through a layered `connector` update.

## Qualification of the real consumers

`orchestrator/tests/contracts.test.mjs` pins both real consumer declarations as fixtures, copied
fresh from the consumers' own `.rengine/project.json`: vtmb-vr's contract-3 document (formats + two
external games + dashboard) and nolf-improved's live contract-2 document (formats + dashboard, no
games), plus a contract-1 document. It also validates the vtmb-vr document with its two quick-start
script actions rewritten to `kind: "game"` (`vtmb-flat`, and the same record with `["--newgame"]`),
proving the contract accepts the shape that consumer is expected to adopt without editing their
repository from here. Assertions stay off the consumers' preview command strings, which move.

The two real-NOLF fixtures (`native-nolf.spec.mjs`, `native-workspace.spec.mjs`, run with
`RENGINE_NOLF_ROOT`) stay as named qualifications of the `embedded` surface against the real NOLF
checkout, and write a contract-3 `.rengine/project.json` with a `games` array into their temporary
project instead of relying on any hard-coded path; the scripts are `test:game-nolf` and
`test:workspace`. `test:game-nolf` now **launches through a dashboard `game` action** in the native
workspace — the declaration it writes carries a one-action dashboard, the fixture clicks
`dashboard-action`/`nolf-flat` and waits for real frames — which is the regression proving the new
path reaches a real game session. An `external` game is qualified by a temporary project whose
executable is a small script that prints and sleeps.

Test-design rule for anything asserting about a consumer's executables: never verify that a declared
executable is a real build target by grepping a build config. Targets can be created outside the
top-level file (reLith declares `relith-nolf`/`relith-nolf2` in `cmake.toml` but creates
`relith-avp2` in `cmake/avp2_game.cmake`), so a config grep produces a false failure for exactly one
of three targets; the build system is the only authority (`cmake --build <dir> --target help`).
Absence of a **built** binary is a skip, not a failure: unbuilt is a normal state, and rEngine
already reports it as a named preflight issue.

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
2. Dashboard game actions: the reader rejects a `game` action without `game`, one carrying another
   kind's field, one with a `${…}` placeholder in `args` and one referencing an undeclared id
   (naming the id and the declared ids) — each as `dashboardError` with the formats and the `games`
   array intact; the reference check is skipped when `gamesError` is set; `GET /api/dashboard`
   marks a game action available from its record's preflight and unavailable with the record's
   first issue when the executable is missing, and honours the action's own `requires`/`tools` as
   well; `POST /api/dashboard-run` on a game action returns a `type: 'game'` session carrying the
   record's args followed by the action's; a second run of the same action reuses it; a second
   action referencing the same record with different `args` is refused with 409 naming both argv;
   the same through the replaceable worker.
3. A native fixture (`native-game-declaration.spec.mjs`, in `test:desktop`) shows **no** toolbar
   game control for a root that declares games — the toolbar's last column is Merge pane before the
   Vim checkbox — a dashboard whose game action launches the external game into its tab with the
   running status and reuses the session on a second click, an unbuilt record rendering its action
   as a disabled label naming the first issue, and Stop from Sessions. `native-game.spec.mjs` keeps
   qualifying the live surface.
4. `npm test`, `npm run test:desktop`, CTest, `./init.sh`, design check and sidecar validation
   pass; the native build has zero warnings. `RENGINE_NOLF_ROOT=… npm run test:game-nolf` launches
   the real NOLF build through a dashboard game action and sees its frames.

Boundaries: no new npm or C dependency; no game is named in rEngine code, theme strings, tool
descriptions or package scripts (the named real-NOLF qualification test and its npm script are the
only permitted mention); a cooperative surface for SDL3/static applications is a later spec
(recorded as a known issue); Windows stays unqualified (KI-014).
