# 146 — red-agent-launch: the pane's own launcher is a binary (F163, spec 129, charter D57)

**Status**: implementing. **Depends on**: spec 129 (the Rust rewrite), spec 141 (the provider
split), spec 102/133 (red-ide), spec 145 (red-launch).

## What this is

`scripts/agent.sh` ends by execing `orchestrator/agents/launch.mjs`, and that module is what a
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

`agents/mcp.mjs` stays, for the reason below.

## Deferred: the pane's MCP server

The intent was to point `mcpMain` at `red-mcp` here, which is what would let `agents/mcp.mjs` be
deleted with the rest. It cannot ride on this row, and the reason is worth writing down because it
is invisible from the input: `launch_plan` composes the server as

```json
{ "type": "stdio", "command": "<node>", "args": ["<mcpMain>", "--context", "<file>"] }
```

so naming the Rust binary as `mcpMain` writes `node /path/to/red-mcp` into every pane's `mcp.json`
— a server that cannot start, in a file a person reads. The switch is a change to the SHAPE the
plan composes, and that shape is covered by its own frozen record (`agents-fixtures.json`, F173).
It gets its own row and its own evidence rather than arriving as a passenger on this one, where the
whole value of the comparison is that there is no intended divergence at all.

## Evidence

- `red-agents-launch.test.mjs`'s frozen record is unchanged and is not regenerated.
- A pane is launched for real and asked what it got: the suite drives `red-agent-launch` with a
  fake CLI that prints its own argv, environment and working directory, and compares that against
  what `launch.mjs` handed the same fake CLI. The record is taken **before** the module is deleted
  (F173), because a replacement compared against a regenerated record is judged against itself.
- The refusals and the best-effort paths get a case each, because "prints and continues" is the
  behaviour a green run cannot tell from "never happened".
