# 145 — red-launch: the launcher is a binary (F159, spec 129, charter D57)

**Status**: implementing. **Depends on**: spec 144 (red-supervisor), spec 098 (replace the session
host), spec 090 (headless start), spec 102/KI-066 (restart the supervisor).

## What this is

`npm start` is the command a person types to open this workspace. Today it is
`orchestrator/launch.mjs`, and under it sit `launcher/headless.mjs`, `launcher/replace.mjs`,
`launcher/restart-supervisor.mjs` and `orchestrator/build.mjs`. This spec makes that one binary,
`red-launch`, and deletes the five modules.

It is the LAST row of F159. `red_supervisor::replace` already holds every decision
`launcher/replace.mjs` makes — which process is a session host, which is a supervisor, whose
ancestor is whose, what the report says — judged against `replace-host-corpus.json`. What it does
not hold is the **acting** half: reading `ps`, sending the signals, waiting for a port to close,
starting the next host. That half is here.

## Why the launcher is one unit and not five

A module retires with its caller. `replace.mjs` is held by `launch.mjs --replace-host` and by
`restart-supervisor.mjs`; `headless.mjs` is held by `launch.mjs --headless`; `build.mjs` is held by
`launch.mjs` and by `npm run build`. Porting any one of them alone would leave a Rust binary
shelling back into Node for the rest, which is more moving parts than either arrangement.

## The commands

```
red-launch [--project DIR] [--declaration FILE] [--agent NAME|EXEC] [--state DIR] [--no-agent]
           [--headless] [--launch-game] [--handoff FILE] [--inspect-ui] [--replace-host]
red-launch build
red-launch replace-host --state DIR [--process-table FILE]
red-launch restart-supervisor --state DIR [--plan | --stop-only]
red-launch ancestors [--pid N]
```

The first form is `launch.mjs`, flag for flag, refusal for refusal, including the `--help` text
whose agent list is the registry's rather than the source's (F220). The rest are the commands that
were their own files.

`--process-table FILE` reads a captured `ps` table instead of running `ps`. It is how a refusal is
reproduced from a machine that is not this one, and it is how the suite proves the refusals are
wired up rather than merely implemented: a doctored table can only make the launcher **refuse** or
target the pid its own descriptor already names, never widen what it signals.

## What must not change

1. **The refusals come before the signals.** A descriptor whose pid is not a session host, a host
   serving another directory, a launcher inside the workspace it would replace: each is refused by
   name with nothing signalled. `red_supervisor::replace` decides all three; this layer must ask.
2. **The PTY service and the store are left running** (charter D60/D61). They are children in `ps`
   only because the parent that started them has not exited, and they are named by the descriptor
   each published, never by a command line.
3. **The supervisor is stopped before the host**, so nothing recovers a worker against a dying host.
4. **`restart-supervisor` never signals the host.** Its `--plan` is read-only and names the host it
   would leave alone; the confirm prompt with no non-interactive bypass stays in
   `orchestrator/actions/restart-supervisor.sh`, which is where it always was.
5. **The new supervisor is started detached**, in its own session. Whoever asked for the restart is
   usually a pane inside the workspace being restarted.
6. **Exit 75 means "I detached for an update".** The launcher rebuilds and runs the desktop again;
   any other code is the launcher's own exit code.
7. **The headless host outlives the launcher.** `--headless` prints the ready line, supervises, and
   says on SIGINT/SIGTERM that the sidecar keeps its sessions.

## The build

`red-launch build` is `orchestrator/build.mjs`: `cmake -S . -B .cache/desktop -DCMAKE_BUILD_TYPE=Release`
and then `cmake --build`, under `build.lock` so two launchers do not build at once.

It used to pass `-DRENGINE_NODE_EXECUTABLE=<node>`, because the desktop execed a node script at
startup. **It does not any more** (F163, spec 146): the desktop's bootstrap is `red-launch bootstrap`,
the build bakes `RENGINE_CHECKOUT` instead of an interpreter, and `find_program(node REQUIRED)` is
gone from `cmake.toml`. Naming the coupling here is what made it visible when it went.

## Evidence

- `replace-host.test.mjs`, `restart-supervisor.test.mjs`, `headless.test.mjs` and
  `launcher.test.mjs` drive the binary. Their unit halves — the process table, `hostArguments`,
  `ancestorsOf`, `insideHost`, `findSupervisors`, `stopProcess`, `hostAge` — are Rust tests, because
  the functions are Rust; what stays in the suite is what only a real host can show.
- The record (`replace-host-corpus.json`) is unchanged and is not regenerated. It was frozen while
  the JavaScript still existed, which is the whole of its value (F173).
