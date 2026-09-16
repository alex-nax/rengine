# JavaScript retirement: what is left

Charter D57 makes the orchestrator's target language Rust, and spec 129 retired the Node modules
under `orchestrator/` one feature row at a time. This is where that ended.

Measured 2026-09-16, at `68d78ab`. Regenerate the number with:

```sh
git ls-files '*.mjs' | grep -vE 'tests/|\.test\.mjs' | xargs wc -l | tail -1
```

## The number

| | lines |
|---|---|
| Production JavaScript remaining | **30** in 1 file |
| Rust in `red/` | ~36,000 |

Down from 5,504 across 43 files when this was first written — **99.5% of it gone**, in two days.

## What is left, and why it stays

`orchestrator/templates/external/commands.mjs`, 30 lines. It is **JavaScript on purpose rather than
by history**, and it is the only file here that can say so.

It is not part of this workspace. The external installer copies it into a *consumer project's*
profile (spec 085), where the declaration's dashboard actions run it: it reads that project's
`package.json`, lists the scripts it declares, runs one through the project's package manager, and
pretty-prints JSON. Every one of those is a fact about the Node ecosystem, in a project that is a
Node project — the installer refuses one without a `package.json`.

Replacing it would mean shipping a Rust binary into a web project's profile whose whole job is to
shell out to `pnpm` and parse `package.json`. That is a worse tool for the job, not a better one,
and it would make an install depend on a compiled artifact where today it depends on the runtime
the project already has.

**This is the line the retirement stops at**, and it is a different kind of line from the ones
before it. Everything else went because it was the JavaScript rEngine happened to be written in
first. This stays because of what it is about.

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
3. **An external project's profile helper**, above.

The desktop build requires none: `find_program(node REQUIRED)` and `-DRENGINE_NODE_EXECUTABLE` are
gone from `cmake.toml`, and a from-scratch `.cache/desktop` mentions node zero times.

## The entry points

`./editor.sh` opens this checkout with no npm anywhere in it: cargo builds the launcher, the
launcher builds the desktop through cmake. `package.json` remains as the **test harness's** file —
its `scripts` are thin wrappers over `cargo run` plus the suite itself, which is what F163 meant by
"shrinks to metadata".
