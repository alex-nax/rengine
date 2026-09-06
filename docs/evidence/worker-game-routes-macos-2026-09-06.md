# The layered-update asymmetry in the game routes — macOS, 2026-09-06

F74, spec 078 (section *Who serves the routes: the layered-update asymmetry*). Branch
`fix/worker-game-routes` in the `.cache/worktrees/merge-verify` worktree, cut from `origin/main`
at `f42bdea`. No live orchestrator, sidecar, connector, agent session or real game window was
replaced; `update_workspace` was not run from here.

## The defect on the live workspace

Everything merged that day worked in isolation, and failed through the live runtime:

| Probe | Answer |
| --- | --- |
| MCP `game_preflight` / `launch_game` (live) | `This retained service predates per-project game declarations. Update the workspace layer first.` — unchanged by repeated `update_workspace` |
| Retained host `GET /api/state` | `capabilities: {handoff: 1}` |
| Retained host `GET /api/game-config?rootId=<vtmb-vr>&gameId=vtmb-flat` | **HTTP 200**, `args: ["--flat","--game","nolf","--width","1280","--height","720"]`, `issues: ["Build NOLF first; expected build/relith-nolf in the selected project."]` — the removed built-in config, for that root and for every `gameId` |

The cause is an asymmetry in `orchestrator/runtime/worker.mjs`. Dashboard routes are **served** by
the replaceable workspace worker (it imports `dashboard.mjs` and answers `/api/dashboard` and
`/api/dashboard-run`), which is why `dashboard: 1` appears the moment the worker is replaced. Game
routes were **forwarded** to the retained host, and `projectGame` was never advertised — so the
capability was the host's to give, and the host was the process from before the merge. Forwarding
did not merely fail to advertise: it returned wrong answers from deleted code, which also made both
of vtmb-vr's flat dashboard entries render unavailable with a NOLF issue.

**The general lesson, recorded in spec 078 and KI-043: a capability served only by the retained
session host cannot be delivered by a layered update.**

## What moved, and what could not

`orchestrator/server/games.mjs` exports `inspectGame(root, gameId)` — the same body, with
`Games.inspect` now a one-line delegation — because preflight reads only the declaration, the
filesystem and `root.id`/`root.path`. The worker calls it, serves `GET /api/game-config`, and
advertises `projectGame: 1` beside `dashboard: 1`.

**Launch stays with the host, decided by reading the code, not assumed.** Creating a game session
needs `Sessions` (node-pty ownership and the retained output the session browser reattaches to),
`Surfaces.reserve()` and the session-id → surface-item map the host's `/surface` upgrade reads for
an `embedded` game — nolf-improved declares three embedded records — and the host's `/api/terminal`
deliberately refuses `type: "game"` (`Use the game adapter to launch a game.`), in the merged code
and in the retained host alike, so there is no primitive a worker could compose a game session from.
The capability is therefore split, and the worker mirrors rather than claims the half it forwards:

| Capability | Meaning | Host | Worker |
| --- | --- | --- | --- |
| `projectGame: 1` | `game-config` answers from the declaration | advertises | **advertises itself** |
| `projectGameLaunch: 1` | the launch answers from the declaration | advertises | mirrors the host's `projectGame` |

Above an older host the worker refuses `POST /api/game` and the `game` branch of
`/api/dashboard-run` by name (`This retained session host predates per-project game declarations and
would launch its removed built-in game; game_preflight answers from the declaration. Replacing the
session host requires quiescence.`), and `launch_game` gates on `projectGameLaunch` with the same
message. `supervisor.mjs` needs no change: its worker path passes the worker's set through, and its
`workspaceWorkerUnavailable` fallback claims only what the supervisor itself serves
(`desktopActions`, `layeredUpdates`, `projectWindows`) — adding `projectGame` there would claim
declaration-backed routes while the host is answering, which is this defect again.

## Capability sets

| Process | Before | After |
| --- | --- | --- |
| Retained live host (pre-merge process) | `{handoff: 1}` | unchanged — it is not replaced |
| Host from this checkout | `handoff, desktopActions, formatRegistry, dashboard, projectGame` | `+ projectGameLaunch` |
| Worker above the retained host | `handoff, desktopActions, layeredUpdates, scriptActions, formatRegistry, dashboard` | `+ projectGame` (no `projectGameLaunch`) |
| Worker above a merged host | same as above, `projectGame` inherited from the host | `projectGame, projectGameLaunch` both 1 |

## Failing check first

`orchestrator/tests/games.test.mjs`, *the replaceable worker serves preflight from the declaration
above a host that predates it*: a proxy in front of a real host advertises only `handoff: 1` and
answers `game-config` with the built-in NOLF config for every root and `gameId`, and the real
supervisor + worker run above it. Red before the fix on the first assertion
(`capabilities.projectGame`: `undefined !== 1`, commit `658fec8`). Green after, asserting each
declared record, the unknown-`gameId` 404 naming the declared ids, dashboard availability from the
declaration, both launch paths refused by name, and `game_preflight` answering through the real MCP
connector while `launch_game` reports the host limit. `dashboard.test.mjs` covers the merged-host
path: `projectGameLaunch: 1` and the worker's `game` route launching and reusing declared sessions.

## Gates

Final sweep, run after `git fetch origin` and `git merge origin/main` (`f42bdea`, already contained).

| Gate | Result |
| --- | --- |
| `npm test` | 56 pass, 0 fail, 7.2 s |
| `npm run test:desktop` (sequential) | 18 pass, 0 fail, 354.5 s |
| `ctest --test-dir .cache/desktop --output-on-failure` | 5 pass, 0 fail, 0.08 s |
| Clean native build (fresh `cmake` configure + Release build) | exit 0, **0 warnings** |
| `./init.sh` | passed (33 features validated, Vulkan shader header matches) |
| `python3 tools/design.py check` | 19 design cards, token mirror and 3 presets consistent |
| `python3 tools/features.py validate` | 33 features, types, evidence and dependency graph |
| `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:game-nolf` | 1 pass, 0 fail, 4.86 s — real NOLF renders and takes menu input through a dashboard game action |

## Both live consumer declarations through the fixed code

`inspectGame` run directly against the two real roots (read-only; neither repository was edited):

```
/Users/alex/vtmb-vr (contract 3) schema=valid, no error/gamesError/dashboardError
  vtmb-flat: ready=true  surface=external exe=/Users/alex/vtmb-vr/build/vtmb args=["--width","1280","--height","720"]
  vtmb-vr:   ready=false surface=external issues=["Game executable not found; expected build/vtmb-vr or build/Release/vtmb-vr in the selected project."]
  (no gameId) -> vtmb-flat;  actions flat, flat-newgame (["--newgame"]) both available
/Users/alex/nolf-improved (contract 3) schema=valid, no error/gamesError/dashboardError
  nolf-flat, avp2-flat, nolf2-flat: ready=true, surface=embedded, each resolving its build/relith-* binary
  (no gameId) -> nolf-flat;  actions nolf-flat, avp2-flat, nolf2-flat all available
```

That reproduces the isolated-server observation exactly: `vtmb-flat` ready with `build/vtmb`,
`vtmb-vr` unavailable naming its executable, and both flat dashboard entries as game actions.

## What still needs a host restart

Launching a declared game on the live workspace. The retained session host owns the PTYs, the
`embedded` surface reservation and the `/surface` session map, and its game route is the removed
built-in one; replacing it requires quiescence, which stops the retained PTYs. Preflight, the
dashboard's game-action availability and `game_preflight` do not need it — a routine
`update_workspace` (workspace + connector) delivers those. Windows behaviour stays unqualified
(KI-014). Sidecar drift in `orchestrator/native/**` and `tests/native-client.mjs` is pre-existing
and belongs to the other active lanes; nothing in this change touches those files.
