# 146 — red-agent-launch: the pane's own launcher is a binary (F163, spec 129, charter D57)

**Status**: complete. **Depends on**: spec 129 (the Rust rewrite), spec 141 (the provider
split), spec 102/133 (red-ide), spec 145 (red-launch).

## What this is

`actions/pane/posix/agent.sh` ends by execing `agents/launch.mjs`, and that module is what a
person's CLI actually runs inside. It is the last **live** JavaScript entry point in a pane, and it
holds the remaining production tree up: it imports `agents-client.mjs`, and through it
`service-client.mjs`, `launcher/sidecar.mjs`, `runtime/protocol.mjs`, `agents/handoff/`, and — for
the editor probe — `ide-connect.mjs` and `runtime/ide.mjs`. It also supplies `mcpMain`, which is
why every pane's `mcp.json` still names `node agents/mcp.mjs` rather than `red-mcp`.

This spec makes it `red-agent-launch` and deletes the nine modules behind it.

## Why this is the acting half, and nothing more

**The decisions are already Rust's and already proved.** `red_agents::launch::launch_plan` composes
the plan, and `red-agents-launch.test.mjs` judges it against what `config.mjs` composed, for every
declared CLI, out of a record frozen while that module still existed (F173). Nothing in this spec
re-decides any of that, and the record is not regenerated.

What has no Rust is the half that *does* things, and it is the same list spec 145 found under
`replace.mjs`:

| what `launch.mjs` does | who already answers it |
| --- | --- |
| wait for the pane to be presented, read the manifest, check resume | `red_agents::handoff` |
| the pid chain that tells this workspace's editor from a machine-mate's | `red_supervisor::replace::ancestors_of` |
| probe for a published editor | `red_ide::discovery::auto_connect` |
| the plan | `red_agents::launch::launch_plan` |
| tell the workspace which conversation this pane holds | `red_core::descriptor::request` |
| the sentences a person reads in their pane | this spec |
| spawn the CLI, forward signals, carry its exit code out | this spec |

So this is a wiring binary over parts that exist, plus a process it owns.

## What must not change

1. **A pane is not refused because something optional did not answer.** The ancestor chain, the
   session list and the conversation report are all best-effort in the JavaScript, each with its
   own reason: an editor decision is not worth failing a launch over, a host that did not answer in
   time has not made the CLI unusable, and a workspace that was not told which conversation this
   pane holds is a lost record rather than a lost session. Each failure prints and continues.
2. **The conversation reported is the one the CLI was STARTED with.** The workspace may have minted
   one, the person may have chosen another from the offered list, and their own `--resume` beats
   both. A launch that continues or forks reports `null`, so no record claims an id rEngine cannot
   resume.
3. **The exit code is the CLI's.** A signal becomes `130` for SIGINT and `1` otherwise, exactly as
   the JavaScript mapped it; `SIGINT` is ignored in the launcher itself so the CLI owns Ctrl-C, and
   `SIGTERM` is forwarded to the child.
4. **Windows runs the CLI through `RENGINE_BASH`**, with `--noprofile --norc -c 'exec "$@"'`, and
   refuses by name when that variable is absent.
5. **The pane's MCP server does not change here.** See Deferred.

## What this deletes

`agents/launch.mjs`, `agents/agents-client.mjs`, `agents/ide-connect.mjs`,
`agents/handoff/{index,codex}.mjs`, `runtime/ide.mjs`, `runtime/service-client.mjs`,
`runtime/protocol.mjs`, `runtime/discovery.mjs` and `launcher/sidecar.mjs` — once nothing imports
them. Each is a module whose Rust counterpart already exists and is already judged; they survive
only as imports of the file this spec replaces.

`agents/mcp.mjs` stays, for the reason below — and went in its own row once that reason was dealt
with. `templates/external/commands.py` became `commands.py`: see the note at the end.

## The pane's MCP server — deferred within this spec, then done

The intent was to point `mcpMain` at `red-mcp` in the launcher row, which is what would let
`agents/mcp.mjs` be deleted with the rest. It could not ride there, and the reason is worth keeping
because it is invisible from the input: `launch_plan` composes the server as

```json
{ "type": "stdio", "command": "<node>", "args": ["<mcpMain>", "--context", "<file>"] }
```

so naming the Rust binary as `mcpMain` writes `node /path/to/red-mcp` into every pane's `mcp.json`
— a server that cannot start, in a file a person reads. The switch is a change to the SHAPE the
plan composes, and that shape is covered by its own frozen record (`agents-fixtures.json`, F173).
It got its own row and its own evidence rather than arriving as a passenger on the launcher's, where
the whole value of the comparison is that there is no intended divergence at all.

**What it took**, once separated: `launch_plan` gained `mcpCommand`, an argv PREFIX, with `mcpMain`
kept because the frozen record is taken through it — so that record still passes unchanged, and the
one declared divergence is normalised on both sides with the new value asserted directly. And
`mcp.mjs` turned out not to be a shim at all: it is the process that holds a CLI's stdio connection
while the worker behind it is replaced by an update. `red-mcp --facade` is that, with a watcher
thread so an IDLE CLI is still told the list changed, and a worker that is replaced rather than
reported when its pipe breaks — which is the ordinary end of a layered update.

## Evidence

- `red-agents-launch.test.mjs`'s frozen record is unchanged and is not regenerated.
- A pane is launched for real and asked what it got: the suite drives `red-agent-launch` with a
  fake CLI that prints its own argv, environment and working directory, and compares that against
  what `launch.mjs` handed the same fake CLI. The record is taken **before** the module is deleted
  (F173), because a replacement compared against a regenerated record is judged against itself.
- The refusals and the best-effort paths get a case each, because "prints and continues" is the
  behaviour a green run cannot tell from "never happened".

## The external helper: Python, not JavaScript

The profile helper the external installer copies into a consumer project was argued to be
JavaScript on purpose, because it reads `package.json` and runs `pnpm`. The owner rejected that,
correctly: reading `package.json` is reading JSON and running `pnpm` is running a subprocess, and
this repository's tooling is already Python with the standard library only. It is `commands.py`, the
declaration names an absolute `python3`, and no JavaScript ships from this repository.

The subtlety the port had to be corrected on: Python block-buffers stdout to a pipe while a
subprocess writes straight to the same descriptor, so the `Project: …` header printed *after* the
output it headed. `run()` flushes before it spawns.
