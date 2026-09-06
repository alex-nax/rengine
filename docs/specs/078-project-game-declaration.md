# Per-project game declaration (contract 2)

Date: 2026-09-06. Owner direction (explicit, overriding the AGENTS.md pause note): the toolbar's
hard-coded "NOLF" button and the `nolf_preflight`/`launch_nolf` agent tools name one game inside
rEngine. They are replaced by a per-project capability: a project declares its game in
`.rengine/project.json`, rEngine shows a button labelled by that declaration, launches the
declared executable and exposes generic agent tools. rEngine names no specific game anywhere in
server, native, agent or theme code. The second consumer (vtmb-vr, an SDL3-static application that
cannot use the SDL2 interposer) must be launchable in its own window today; the first consumer
(nolf-improved) keeps its live in-workspace surface through the same declaration. This spec
extends spec 074 (contract 1) in the same way spec 075 does: `contract` becomes 1 or 2 and
contract 2 adds an optional top-level object; contract 1 declarations stay accepted unchanged.

## Declaration

Contract 2 adds an optional top-level `game`:

```json
"game": {
  "id": "nolf-flat",
  "title": "NOLF",
  "executable": ["build/relith-nolf", "build/Release/relith-nolf"],
  "args": ["--flat", "--game", "nolf", "--width", "1280", "--height", "720"],
  "env": { "RELITH_HIDDEN_WINDOW": "1", "RELITH_SKIP_INTRO": "1" },
  "requires": ["nolf/NOLF.REZ"],
  "surface": "sdl2-interpose"
}
```

- `id`: kebab-case, at most 64 characters. Carried on the game session as `game`.
- `title`: 1–32 characters. The toolbar button label; the session and tab title is
  `<title> · <root name>`.
- `executable`: 1–8 candidates; the first that exists and is executable wins. Each candidate is
  resolved like a format `argv[0]` (spec 074): absolute as given; with a path separator relative
  to the project root (a `.exe` suffix is also tried on Windows); a bare name through the
  sidecar's PATH. Never a shell expression (`|`, `;`, `&`, `$`, backtick rejected).
- `args`: literal argv, 0–64 non-empty strings, no placeholders (`${…}` is rejected). Default `[]`.
- `env`: optional; keys match `^[A-Z][A-Z0-9_]*$`, values are literal strings (at most 4,096
  characters), at most 64 entries. Keys starting `RENGINE_`, `DYLD_` or `LD_` are reserved for the
  workspace and rejected by name.
- `requires`: optional, 0–32 root-relative regular files that must exist (no absolute paths, no
  `..` segments, no backslashes). Each missing file is one named preflight issue.
- `surface`: `sdl2-interpose` (the game is an SDL2 application; the macOS adapter dylib is
  interposed and its frames stream into the workspace pane as today) or `external` (the process
  opens its own operating-system window; rEngine retains the process and its PTY output only).

`readDeclaration` accepts contract 1 or 2. The schema's `contract` is the enum `[1, 2]`, `game`
is an optional property under `additionalProperties: false`, so unknown keys are still rejected.
The reader validates the contract-1 part first and the game block separately: a bad game block is
reported as `gameError` (the offending path in the message) without disabling the formats or the
workspace, exactly as spec 075 reports `dashboardError`; a `game` under contract 1 is reported the
same way and ignored. The shared cross rules live in `orchestrator/server/game-rules.mjs`
(reserved and malformed env keys, root-relative `requires`, no placeholders). The formats listing
(`GET /api/formats`, fetched once per connection per root) carries the accepted `game` object (or
`gameError`) so the native desktop knows the title and surface without a second request.

## Preflight and launch

`GET /api/game-config?rootId` and the MCP tool `game_preflight` return
`{ rootId, declared, id?, title?, surface?, executable?, args, env, requires, cwd, adapter?, issues, ready }`,
running nothing:

- An undeclared root (no `.rengine/project.json`, or a declaration without `game`) answers
  `declared: false`, `ready: false`, `issues: ["This project declares no game in
  .rengine/project.json (contract 2)."]`.
- A malformed declaration or game block answers `declared: false` with its error as the issue.
- No resolvable executable adds an issue naming every candidate; each missing `requires` file
  adds `Required file is missing: <path>.`.
- `sdl2-interpose` additionally needs the adapter dylib on macOS (`Build the native surface
  first: npm run build:surface`) and reports the platform issue elsewhere, exactly as before.
  `external` has no surface prerequisite.

`POST /api/game { rootId }`, the MCP tool `launch_game`, the toolbar button and `--launch-game` in
the launcher reuse the running game session of that root, else spawn: cwd = the root path,
env = the sidecar's shell environment plus the declared `env`. For `sdl2-interpose` the surface
reservation (`RENGINE_SURFACE_PORT`/`RENGINE_SURFACE_TOKEN`) and `DYLD_INSERT_LIBRARIES` are added
as today, and the reservation is released when the session exits. For `external` no surface item
is reserved. The session is `type: 'game'` with `title: "<title> · <root name>"`; its snapshot
carries `surface` and `game` (the declared id). A launch on an unready root fails with status 409
and the joined issues. `--launch-game` in `orchestrator/launch.mjs` performs the preflight and
reports its issues before creating any shell or agent session, as before.

## Native

The toolbar shows a button labelled with the declaration's `title` only when the bound root
declares a game; otherwise the row has no game column (generated `toolbar` metrics only;
`design.py check` rejects literal row sizes). The root button is inspectable (`toolbar`/`Root`)
so switching roots is drivable. The button posts the same `game` route as the launcher.

For `sdl2-interpose` the game tab is the existing live game view (texture, capture, Esc release).
For `external` the tab is a terminal-style view over the game session's PTY output (the session
is already a node-pty child) with a status row from the theme's string table: "Running in its own
window" while the session runs, "Game exited · reattach or Stop in Sessions" afterwards. The
Sessions view and Stop are unchanged; closing a tab detaches as today. The surface of a session is
read from the workspace state (`surface` on the session snapshot), so restored tabs, the session
browser's Attach and the initial `RENGINE_INITIAL_GAME` binding all pick the right view.

## Agents

`nolf_preflight` and `launch_nolf` are removed. `game_preflight` (read-only) returns the preflight
above; `launch_game` (open-world, executes the project's own executable) launches or reuses the
game session. Neither description names a game. Both require the host capability
`projectGame: 1`; an older retained host is told to update the workspace layer. The live connector
predates the tools and picks them up only through a layered `connector` update.

## Qualification of the real consumers

The two real-NOLF fixtures (`native-nolf.spec.mjs`, `native-workspace.spec.mjs`, run with
`RENGINE_NOLF_ROOT`) stay as named qualifications of the `sdl2-interpose` surface against the real
NOLF checkout, but they write a contract-2 `.rengine/project.json` with the NOLF game block above
into their temporary project instead of relying on any hard-coded path; the scripts are
`test:game-nolf` and `test:workspace`. An `external` game is qualified by a temporary project whose
executable is a small script that prints and sleeps.

## Acceptance and verification

1. Service tests fail before the reader knows the game block, then cover: contract 1 still valid;
   contract 2 with and without `game`; `game` under contract 1 reported without disabling formats;
   rejections by name for a bad env key, each reserved env prefix, a placeholder in `args`, more
   than 8 executables, an unknown surface, an unknown key, a shell `argv[0]`, an escaping
   `requires` path and an over-long title; preflight issues for an undeclared root, a malformed
   declaration, a missing executable (naming the candidates) and missing `requires` files (one
   issue each); candidate order, absolute and bare-name resolution; launch of an `external` game
   through a temporary project with a script producer (session type, title, `surface`, `game`,
   declared env visible in its output, no surface reservation), reuse of the running session
   through the route and the tool, and a 409 on an unready root; MCP discovery shows
   `game_preflight` and `launch_game` and not the removed names. `launcher.test.mjs` expects the
   undeclared message.
2. A native fixture (`native-game-declaration.spec.mjs`, in `test:desktop`) shows no game button
   for an undeclared root, the declared title after switching roots, launches on click, shows the
   external game's output in its tab with the running status, reuses the session on a second
   click, and stops it from Sessions; the existing `native-game.spec.mjs` keeps qualifying the
   live surface.
3. `npm test`, `npm run test:desktop`, CTest, `./init.sh`, design check and sidecar validation
   pass; the native build has zero warnings. Optional evidence: `RENGINE_NOLF_ROOT=… npm run
   test:game-nolf` passes through the declaration.

Boundaries: no new npm or C dependency; no game is named in rEngine code, theme strings, tool
descriptions or package scripts; a cooperative surface for SDL3/static applications is a later
spec (recorded as a known issue); Windows stays unqualified (KI-014).
