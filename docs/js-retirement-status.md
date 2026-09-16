# JavaScript retirement: what is left

Charter D57 makes the orchestrator's target language Rust, and spec 129 retired the Node modules
under `orchestrator/` one feature row at a time. This is where that ended.

Measured 2026-09-16. Regenerate the number with:

```sh
git ls-files '*.mjs' | grep -v 'tests/' | wc -l    # 0
```

## The number

| | |
|---|---|
| Production JavaScript remaining | **none** |
| Rust in `red/` | ~36,000 lines |

From 5,504 lines across 43 files, in two days. There is no production `.mjs` in this repository.

## The last file, and the argument that was wrong about it

The external profile helper — the thing the installer copies into a consumer project so its
dashboard can show `status`, `scripts` and a few of its package scripts — was the last JavaScript
here, and it was defended on the grounds that a helper which reads `package.json` and runs `pnpm` is
a helper *about* the Node ecosystem, so JavaScript was the honest tool.

**That mistook the subject for the requirement**, and the owner said so. Reading `package.json` is
reading JSON. Running `pnpm` is running a subprocess. Neither wants the Node runtime, and this
repository's tooling is already Python, standard library only (`tools/*.py`). It is
`templates/external/commands.py` now, and the declaration names an absolute `python3` for the same
reason every other interpreter path here is absolute: a declaration's argv is data a person reads
and a runner execs, not a line a shell resolves.

The one behaviour the port had to be corrected on is worth keeping, because it is invisible in a
green test: Python block-buffers stdout to a pipe while a subprocess writes straight to the same
descriptor, so `Project: …` — a line a person reads as a header — landed *after* the git output it
was heading. `run()` flushes first.

The only `.js` left in the repository is `docs/reviews/ispec.js`, 148 lines of browser script in a
generated review page. Browsers run JavaScript; that one is not a choice anybody here makes.

## What went, in order

The last day of it, each row with its own frozen record where one was possible (F173):

| what | replaced by |
|---|---|
| `server/main.mjs`, `server/sessions.mjs` and the thin clients | `red-host` |
| `runtime/worker.mjs`, `runtime/scripts.mjs`, `server/desktops.mjs` | `red-worker` |
| `runtime/tracker.mjs`, `server/tracker.mjs`, `server/tracker-auth.mjs` | `red-project` |
| `runtime/supervisor.mjs`, `runtime/windows.mjs`, `runtime/desktop.mjs` | `red-supervisor` |
| `launch.mjs`, `build.mjs`, `launcher/{headless,replace,restart-supervisor}.mjs` | `red-launch` |
| `agents/launch.mjs`, `agents-client.mjs`, `ide-connect.mjs`, `handoff/`, `runtime/ide.mjs` | `red-agent-launch` |
| `agents/mcp.mjs` | `red-mcp --facade` |
| `runtime/bootstrap.mjs` | `red-launch bootstrap` |
| `runtime/client.mjs` | `red-launch client` |
| `external-project.mjs` | `red-project install-external` |

`runtime/{discovery,protocol,service-client}.mjs` and `launcher/sidecar.mjs` were not rewritten:
`red_core::descriptor` had already replaced what they decided, and they moved to `tests/` as the
fixtures 35 specs judge it against. `orchestrator/runtime/` and `orchestrator/launcher/` are gone as
directories.

## Where node is still required, and for what

Node is no longer on any path that opens a workspace. It is required in three places, all of them
outside the product:

1. **The test suite.** `npm test` is still the runner, and the specs use the MCP SDK, `ws` and
   `node-pty` to drive the Rust binaries from the outside. That is a harness, not a product, and
   driving a Rust MCP server with the reference client is a *feature* of the evidence.
2. **An agent pane's CLI**, where that CLI is itself a Node program. rEngine does not choose that.

The external project's profile helper used to be the third, and is not any more.

The desktop build requires none: `find_program(node REQUIRED)` and `-DRENGINE_NODE_EXECUTABLE` are
gone from `cmake.toml`, and a from-scratch `.cache/desktop` mentions node zero times.

## The entry points

`./editor.sh` opens this checkout with no npm anywhere in it: cargo builds the launcher, the
launcher builds the desktop through cmake. `package.json` remains as the **test harness's** file —
its `scripts` are thin wrappers over `cargo run` plus the suite itself, which is what F163 meant by
"shrinks to metadata".
