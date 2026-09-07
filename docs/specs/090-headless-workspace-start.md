# A headless start: the sidecar without a desktop (F85)

Date: 2026-09-07. Status: owner-directed. Owner request: *"add a headless start to rEngine — a way to
run the sidecar alone, without building or spawning the native desktop."*

Parent: [orchestrator](002-orchestrator.md); the launcher's existing behaviour is qualified by
[combined NOLF launch qualification](055-launch-command-qualification.md), which this spec does not
change. Consumer that motivated it: the vtmb-vr wizard `scripts/wizards/remote-rengine.sh`, which
installs an rEngine instance on the Windows box so a workspace can own real sessions there.

## What was missing, and the evidence

The wizard's install stages succeeded — clone at the consumer's pin, `npm ci` with `node-pty`
compiled by MSVC, start through Task Scheduler `/IT` so the process lands in the logged-on
interactive session — and its verification stage refused. It was right to. The launcher it invoked,
`node orchestrator/launch.mjs --state .state --no-agent`, logged this on the box:

```
-- Building for: NMake Makefiles
-- [cmkr] Fetching cmkr...
CMake Error at CMakeLists.txt:21 (project): Running 'nmake' '-?' failed with: no such file or directory
```

That is not a configuration anyone got wrong. `launch.mjs` imported `./build.mjs` unconditionally,
then resolved the native binary and spawned the desktop; `--no-agent` only suppresses the agent pane.
`package.json` exposed `start` and `resume`, both of which are that same full path. **There was no
headless entry point at all.** The `nmake` failure is the symptom: an SSH logon has no MSVC
environment, and nothing should have been building a desktop there in the first place.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | A headless start runs the sidecar and nothing else: no desktop build, no desktop spawn, no native binary resolution. | Owner |
| 2 | It is a flag on the launcher, `--headless`, **and** an npm script `start:headless`, matching how `start` and `resume` are exposed. One argument parser, so headless and desktop options cannot drift apart. | Recommended; owner left the shape open |
| 3 | The headless run body lives in `orchestrator/launcher/headless.mjs`, beside `sidecar.mjs`. The module that runs a headless host cannot reach `build.mjs`, and the branch in `launch.mjs` is a structural `if/else`, not a sequence of early returns. | Recommended |
| 4 | It reuses `ensureSidecar`. A headless host is the same service the desktop retains, discovered and authenticated through the same `sidecar.json`, never a second kind of service. | Owner |
| 5 | It launches no agent. A headless host serves sessions; it does not start conversations. `--agent`, `--handoff`, `--launch-game` and `--inspect-ui` are refused with `--headless` rather than silently ignored, because each of them names a desktop or a conversation. | Owner (no agent); refusal recommended |
| 6 | Loopback is unchanged: `127.0.0.1` with the capability token. Reachability across machines is the caller's tunnel. No flag in this change can move the bind. | Owner |
| 7 | It prints one machine-parseable ready line, then stays in the foreground supervising the sidecar. Silence would leave a caller polling for a file. | Recommended; owner asked for a deliberate decision |
| 8 | The token is **not** printed. It stays in mode-0600 `sidecar.json`, where the desktop launcher already reads it. A headless start is normally redirected to a log file, and a log file is a worse place for a capability than the state directory. | Recommended |
| 9 | Stopping the foreground process leaves the sidecar and its sessions running, exactly as desktop exit does. Retention is the point of the sidecar; a headless start does not get to invent a second lifetime rule. | Recommended, from the existing retained-service behaviour |

## Shape

```sh
node orchestrator/launch.mjs --headless --state DIR [--project DIR]
npm run start:headless -- --state DIR [--project DIR]
```

- `runHeadless({ state, project })` resolves the state directory, calls `ensureSidecar`, and — when
  `--project` is given — registers the root through the same `POST /api/roots` the desktop launcher
  uses, so an instance is useful the moment it is up.
- It then prints, on one line:

  ```
  rengine headless ready url=http://127.0.0.1:<port> instance=<uuid> pid=<pid> state=<dir> root=<id|->
  ```

  A caller waits for `rengine headless ready` and takes the port from `url=`. A second human line
  names where the token is, states that the bind is loopback, and states that stopping the process
  keeps the sessions.
- It stays alive, checking once a second that the sidecar process is still there. If the sidecar
  exits, the headless start prints why, names `sidecar.log`, and exits non-zero, so a scheduled task
  or service wrapper sees a failure instead of a silent stop. `SIGINT`/`SIGTERM` detach: they print
  and exit zero, leaving the sidecar and its sessions alive.

## Verification

The sabotage rule in `AGENTS.md` applies to every assertion below: each was observed failing for its
own reason, and the record is in `docs/evidence/headless-start-macos-2026-09-07.md`.

- **A headless start writes a usable descriptor and answers the API.** `sidecar.json` carries the
  loopback URL from the ready line, a 64-hex token and a live pid; `/api/state` answers with that
  token and reports exactly the capability set `startServer` declares, compared against a second
  server started directly in the test rather than against a copy of the same literal. That is the
  assertion that discriminates "the sidecar" from "something that writes a sidecar.json".
- **The desktop launcher finds the same instance.** `ensureSidecar` on the same state directory —
  the exact call `launch.mjs` makes — returns the same instance and pid rather than starting a
  second service.
- **It binds loopback only.** The URL's host is `127.0.0.1`, and a connection to the same port on
  this machine's routable address is refused. This assertion is what makes decision 6 observable;
  it goes red if the bind ever becomes `0.0.0.0`.
- **It starts where the desktop build cannot run.** The check runs the real launcher with `PATH`
  pointing at an empty directory, so no `cmake`, no `nmake`, no compiler exists for the child — the
  macOS analogue of the box's SSH logon, which has no `vcvars64` and never will. Reaching the ready
  line under those conditions is only possible if `build.mjs` was never imported.
- **`--project` registers the root**, reported in the ready line and present in `/api/state`.
- **No agent session is created**, asserted before the broader "no sessions at all", so that adding
  agent creation back reddens the agent assertion for its own reason instead of tripping a more
  general one first.
- **The full `start` path still builds and spawns.** With a recording `cmake` stub on `PATH` and
  `RENGINE_NATIVE_BINARY` pointing at a recording stub, a plain `--state` launch invokes the build
  and then executes the binary with the workspace URL and token in its environment. This is what
  makes the change additive rather than a redirection of the existing path.
- **The refusals hold**: `--headless` with `--agent`, `--launch-game`, `--handoff` or `--inspect-ui`
  fails naming the flag, before any sidecar is started.

## Deferred

A stop or status verb for a headless instance; the wizard stops it by process. Service or
launchd/Task Scheduler packaging. Running a game from a headless host — `--launch-game` is refused
here because a game wants a pane, and the API remains the way to start one deliberately. Windows
runtime proof of this path: the failure it fixes was observed on the box, and the fix is verified on
macOS with the toolchain removed. See KI-060.
