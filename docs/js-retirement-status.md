# JavaScript retirement: what is left

Charter D57 makes the orchestrator's target language Rust, and spec 129 retires the Node modules
under `orchestrator/` one feature row at a time. This is where that stands.

Measured 2026-09-15, at `1b247bb`. Regenerate the numbers with:

```sh
git ls-files '*.mjs' | grep -vE 'tests/|\.test\.mjs' | xargs wc -l | tail -1
```

## The number

| | lines |
|---|---|
| Production JavaScript remaining | **5,504** across 43 files |
| Rust in `red/` | 30,328 |

**The line count is the wrong headline, and it is worth saying why.** Most of what remains is not
waiting to be rewritten — it is waiting to be *deleted*. A JS module retires with its CALLER, not on
its own: `runtime/ide.mjs` and `runtime/lsp-client.mjs` are 316 lines that already do nothing but
speak to Rust binaries, and they go the day `worker.mjs` does, not before. So the useful measure is
not how many lines are left but **how many callers are left**, and there are four.

## The four callers

### 1. `worker.mjs` and its world — 1,429 lines

| file | lines | |
|---|---|---|
| `runtime/worker.mjs` | 733 | the workspace worker |
| `runtime/ide.mjs` | 191 | client of `red-ide serve` |
| `runtime/token-client.mjs` | 161 | client of `red-token-serve` |
| `runtime/lsp-client.mjs` | 125 | client of `red-lsp-serve` |
| `server/desktops.mjs` | 76 | the desktop registry — already the door's |
| `runtime/protocol.mjs` | 60 | shared with the supervisor |
| `runtime/tracker.mjs` | 58 | the worker's tracker routes |
| `runtime/scripts.mjs` | 25 | `openScript` |

**Status: `red-worker` answers 15 of 17 routes, serves both sockets, follows the host's session
stream, and the supervisor can run it** (`startRuntime({ workerFile: null })`, proved by
`worker-cutover.test.mjs`). It is not the default yet.

Between here and the default:

- **`POST /api/dashboard-run`** — composed rather than gated, the way `/api/game` is: an action whose
  `kind` is `game` runs the project's preflight and the old-host refusal, and a device-bound one
  bounds a `device-action.*` pair on the feed. `red_project::dashboard::dashboard_action` and
  `run_payload` already exist.
- **`POST /api/tracker/signin` and `/signout`** — a TLS decision, which is **F154**'s. Forwarded
  meanwhile, and above a current door the backend answers them.

Three of the eight files above are already dead weight kept alive by the ninth: the registry moved to
the door, and `ide`/`lsp-client`/`token-client` are clients of binaries that exist.

Details: `docs/specs/143-red-worker.md`.

### 2. The supervisor and the launchers — 1,368 lines (**F159**)

| file | lines | |
|---|---|---|
| `runtime/supervisor.mjs` | 439 | layered updates, desktop windows, retirement |
| `launcher/replace.mjs` | 224 | `--replace-host`, the process-table scan |
| `runtime/service-client.mjs` | 199 | now duplicated by `red_core::service::start_service` |
| `runtime/windows.mjs` | 109 | the window store |
| `launcher/restart-supervisor.mjs` | 96 | the declared action |
| `launcher/sidecar.mjs` | 89 | descriptor discovery |
| `runtime/discovery.mjs` | 72 | runtime descriptor discovery |
| `runtime/client.mjs`, `desktop.mjs`, `headless.mjs`, `bootstrap.mjs` | 140 | |

**Status: untouched.** This is the largest genuinely-unported piece. It is also the one with the most
process-lifecycle in it, which is the part a port gets wrong quietly.

### 3. The JS session host behind the door — 1,868 lines

| file | lines | |
|---|---|---|
| `server/sessions-client.mjs` | 459 | the agent launcher: env, resume, titles |
| `server/tracker-auth.mjs` | 232 | OAuth device flow (**F154**) |
| `server/tracker.mjs` | 231 | the remote providers (**F154**) |
| `server/store-client.mjs` | 229 | client of `red-store-serve` |
| `server/main.mjs` | 227 | the dispatcher `red-host` fronts |
| `server/pty-client.mjs` | 189 | client of `red-pty-serve` |
| `server/{tasks,devices,project-client,formats,dashboard,recordings}.mjs` | 301 | thin clients of `red-project` |

**Status: `red-host` owns the port and answers most of it; this is what it still forwards to.** Four
of these are clients of Rust services that already exist and retire with `main.mjs`. What is real
work: `sessions-client.mjs` (how an agent CLI is actually launched) and F154's two tracker files.

### 4. Agent-side and entry points — 839 lines (**F163**)

`agents/agents-client.mjs` (253), `agents/mcp.mjs` (127), `orchestrator/launch.mjs` (109),
`external-project.mjs` (89), `agents/handoff/*.mjs` (105), and six smaller files.

**Status: mostly thin.** `agents/mcp.mjs` is a facade over `red-mcp`, which exists; `agents-client`
speaks to the recipe service. `launch.mjs` and `external-project.mjs` are the entry points a person
types, and F163 is the row that deletes them.

## What "done" looks like, in order

1. **`/api/dashboard-run`** composed in `red-worker`. Small; the crate functions exist.
2. **Default the supervisor to `red-worker`** and delete `worker.mjs` + the seven files that retire
   with it. **−1,429 lines**, the largest single deletion left.
3. **F154** — a TLS client, and `tracker.mjs` + `tracker-auth.mjs` move. **−463**, and it unblocks
   the worker's last two routes.
4. **F159** — the supervisor. **−1,368**, the largest remaining port.
5. **`sessions-client.mjs`** — how an agent CLI is launched. **−459**.
6. **F163** — the entry points, `main.mjs` and the service clients that retire with it. **−~1,700**.

## Two things worth knowing before the next step

**A module retires with its caller.** Counting lines invites porting a client that has nothing to
port. `surfaces.mjs` retired with `games.mjs`; `windows.mjs` will retire with `supervisor.mjs`.

**A parity proof cannot outlive the side it compares against** (F173). Several Rust tests read
`worker.mjs` and `main.mjs` as the authority on what the answers are. Those tests say so in a comment
and fall back to a recorded corpus when the file is gone — so the deletion step is *record the
answers first, then delete*, not *delete and see what breaks*.
