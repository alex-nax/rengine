# JavaScript retirement: what is left

Charter D57 makes the orchestrator's target language Rust, and spec 129 retires the Node modules
under `orchestrator/` one feature row at a time. This is where that stands.

Measured 2026-09-15, at `1b247bb`; the narrative below is current as of the F154 work that followed. Regenerate the numbers with:

```sh
git ls-files '*.mjs' | grep -vE 'tests/|\.test\.mjs' | xargs wc -l | tail -1
```

## The number

| | lines |
|---|---|
| Production JavaScript remaining | **4,128** across 37 files |
| Rust in `red/` | ~34,000 |

Down from 5,504 across 43 when this was first written. Gone: `runtime/worker.mjs`,
`runtime/scripts.mjs`, `server/desktops.mjs`, `runtime/tracker.mjs`, `server/tracker.mjs` and
`server/tracker-auth.mjs` — **a quarter of it**.

**The line count is the wrong headline, and it is worth saying why.** Most of what remains is not
waiting to be rewritten — it is waiting to be *deleted*. A JS module retires with its CALLER, not on
its own: `runtime/ide.mjs` and `runtime/lsp-client.mjs` are 316 lines that already do nothing but
speak to Rust binaries, and they go the day `worker.mjs` does, not before. So the useful measure is
not how many lines are left but **how many callers are left**, and there are four.

## The four callers

### 1. `worker.mjs` and its world — ~600 lines left of 1,429

| file | lines | |
|---|---|---|
| ~~`runtime/worker.mjs`~~ | ~~733~~ | **deleted** |
| ~~`server/desktops.mjs`~~ | ~~76~~ | **deleted** — the registry is `red_core::desktops` |
| ~~`runtime/scripts.mjs`~~ | ~~25~~ | **deleted** |
| `runtime/ide.mjs` | 191 | client of `red-ide serve`; retires with `agents/ide-connect.mjs` (F163) |
| `runtime/token-client.mjs` | 161 | client of `red-token-serve`; four specs still drive it |
| ~~`server/tracker.mjs`~~ | ~~231~~ | **deleted** (was group 3) |
| ~~`server/tracker-auth.mjs`~~ | ~~232~~ | **deleted** (was group 3) |
| `runtime/lsp-client.mjs` | 125 | client of `red-lsp-serve`; the LSP corpus compares against it (F173) |
| `runtime/protocol.mjs` | 60 | shared with the supervisor, so it goes with F159 |
| ~~`runtime/tracker.mjs`~~ | ~~58~~ | **deleted** — `red_worker::signin` finds a retained host |

**Status: the supervisor runs `red-worker`.** Every route is answered, both sockets are served, the
host's session stream is followed, and the whole suite is green on it. Eight specs that drove the
JavaScript worker in-process now drive the binary, unchanged apart from one import.

**The registry is the worker's**, and the reason is the lesson of this whole epic, hit twice:
`runtime.test.mjs`'s legacy-host case asserts *current desktop actions above legacy host*, and a
worker that forwarded `/api/desktops` would answer from a host that never had the route. **A route
the worker forwards answers from whatever is beneath it, and what is beneath it may predate the
route.** So the registry is `red_core::desktops`, held by the worker, which terminates `/events`,
understands the four frames the JavaScript understood and passes the rest through. That also settled
where the token segment is pushed from and let `POST /api/ledger` go.

**F154 is done** as part of this: `red_core::tls` (trust roots from the MACHINE, not a bundled CA
set), the PKCE sign-in flow, and both providers' reads.

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

**Status: begun (spec 144).** `red_supervisor::windows` answers what `windows.mjs`'s store answered,
case for case. Nothing is deleted yet, because a module retires with its caller and the caller is the
supervisor process. This is still the largest genuinely-unported piece, and the one with the most
process-lifecycle in it — the part a port gets wrong quietly.

### 3. The JS session host behind the door — 1,405 lines

| file | lines | |
|---|---|---|
| `server/sessions-client.mjs` | 459 | the agent launcher: env, resume, titles |
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

1. ~~**`/api/dashboard-run`**~~, ~~**the token segment**~~, ~~**defaulting the supervisor**~~ — **done**.
2. ~~**Bring the desktop registry back to the worker**~~ — **done**, and `worker.mjs` with it.
   What is left of that group is seven client files that retire with the supervisor, not with it.
3. ~~**F154**~~ — **done**, and its JavaScript with it: `server/tracker.mjs` and
   `server/tracker-auth.mjs` are deleted. The evidence is on the row in `features.json`; `passes`
   stays false only because the prerequisite chain (F153 → F152) is unmarked.
4. **F159** — the supervisor. **−1,368**, the largest remaining port, and **started**: the
   project-window store is `red_supervisor::windows`, judged against a 47-case record frozen from
   `windows.mjs`. Six of the supervisor's thirteen routes are that store; the rest is process
   lifecycle, which no record can judge and the existing suites do. `docs/specs/144-red-supervisor.md`
   has the order the remaining six pieces come in.
5. **`sessions-client.mjs`** — how an agent CLI is launched. **−459**.
6. **F163** — the entry points, `main.mjs` and the service clients that retire with it. **−~1,700**.

## Two things worth knowing before the next step

**A module retires with its caller.** Counting lines invites porting a client that has nothing to
port. `surfaces.mjs` retired with `games.mjs`; `windows.mjs` will retire with `supervisor.mjs`.

**A parity proof cannot outlive the side it compares against** (F173). Several Rust tests read
`worker.mjs` and `main.mjs` as the authority on what the answers are. Those tests say so in a comment
and fall back to a recorded corpus when the file is gone — so the deletion step is *record the
answers first, then delete*, not *delete and see what breaks*.
