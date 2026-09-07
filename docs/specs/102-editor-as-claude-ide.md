# rEdit as a Claude Code IDE (F99)

Date: 2026-09-07. Status: recorded from owner direction — *"claude code has /ide integration can we
use it?"*, then *"yes, spec it and build the first slice"*. Parent: [spec 065](065-layered-workspace-updates.md)
for which layer may own a new capability, and [spec 101](101-live-capability-updates.md) for the rule
that a route needing no PTY, surface or store state belongs in the worker. Related:
[spec 032](032-desktop-v0.md) for the editor pane this ends up reading from.

## What `/ide` actually is, measured

Read out of the installed CLI (`/Users/alex/.local/share/claude/versions/2.1.263`, a Bun-compiled
binary) on 2026-09-07, not taken from documentation. This is **observed behaviour of one version**,
not a published contract: it can change under us, so every assumption below is asserted by a test
that fails loudly rather than by a comment.

| Thing | What the CLI does |
| --- | --- |
| Discovery | reads every `*.lock` under `~/.claude/ide/`. **The port is the filename**: `parseInt(basename.replace('.lock',''))`. Nothing inside the file names the port. |
| Fields read | `workspaceFolders`, `pid`, `ideName`, `useWebSocket`, `runningInWindows`, `authToken`. Unknown keys are ignored. |
| Transport | `useWebSocket` → `ws://127.0.0.1:<port>`; otherwise `http://127.0.0.1:<port>/sse`. |
| Validity | the process cwd must equal, or be under, one of `workspaceFolders` (NFC-normalised). |
| Liveness, in a terminal | `pid` must be alive **and** be the CLI's parent or within `_kn(process.ppid, 10)` — the first ten ancestors of the CLI process. |
| Escape hatches | `CLAUDE_CODE_SSE_PORT` equal to the lock's port skips both the workspace-folder and the ancestry checks; `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` skips the folder check alone. |
| Stale locks | a lock whose `pid` is dead is **deleted by the CLI**. |
| On connect | the CLI sends `notification { method: "ide_connected", params: { pid } }`. |
| Tools the CLI calls | `getDiagnostics({uri})`, `openDiff({old_file_path, new_file_path, new_file_contents, tab_name})`, `close_tab({tab_name})`, `closeAllDiffTabs({})`. |
| Tools it offers the model | `mcp__ide__getDiagnostics`, `mcp__ide__executeCode` — the connection is registered as an MCP server named `ide`. |
| Notifications it accepts | `selection_changed`, `at_mentioned`; `openDiff` resolves as `diff_accepted` / `diff_rejected`. |
| `--ide` | connects on startup when exactly one valid IDE is available; `/ide` chooses among them. |

A correction to what was said before the binary was read: the CLI does **not** call an `openFile`
tool on the IDE. The `openFile` symbols in that binary belong to its own LSP client, which is a
different subsystem.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The bridge lives in the **workspace worker** (`orchestrator/runtime/ide.mjs`), not in the session host and not in the C desktop. It needs no PTY, no surface and no store state — only the root paths and a socket — which is exactly spec 101's test for what the replaceable layer may own, and it means the capability arrives by a routine layered update. | Recommended; spec 101 applied |
| 2 | The lock file names the **session host's pid**, not the worker's and not the desktop's. The CLI checks ancestry, and the host is the only process in a pane's ancestor chain: a pane is a PTY the host forked, so the chain is CLI ← shell ← host, well inside the ten levels the CLI walks. Naming the desktop or the worker would produce a lock the CLI silently skips, and would push us into injecting `CLAUDE_CODE_SSE_PORT` from the host — a change a running host cannot receive (KI-043). | Recommended |
| 3 | Because the pid is the host's, and the host outlives many workers, **the CLI's own stale-lock sweep can never collect our locks** — it deletes a lock whose pid is dead, and ours is alive. The worker therefore unlinks its lock on shutdown, and sweeps stale rEdit locks on startup: ours are recognised by `rengineWorker`, a key the CLI's parser ignores, and a lock whose `rengineWorker` is dead is ours to delete. | Recommended; the failure it prevents is a `/ide` menu filling with dead rEdit entries |
| 4 | `workspaceFolders` is every root path the workspace has bound, so a pane in any of them sees rEdit as valid. The list is rewritten when roots change. | Recommended |
| 5 | WebSocket, bound to `127.0.0.1` on an ephemeral port, and `ideName: "rEdit"`. | Recommended |
| 6 | Slice 1 answers `getDiagnostics` with an empty diagnostic list, honestly: rEdit has no language server, and an empty list is the true answer rather than a refusal. `openDiff` and the tab tools are slice 2 — until they exist the CLI keeps using its own diff. | Recommended |
| 7 | The `authToken` is generated and written at 0600, and the server **requires** it. How the CLI presents it is not visible in the binary's strings, so the acceptance run captures the real handshake and the server accepts the token in whichever of the observed places it arrives; a connection presenting no token is refused. Nothing is trusted merely for being on loopback. | Recommended; the owner's machine runs many local processes |
| 8b | **One port for the runtime's life, not one per worker.** Added after the fact, from KI-066: the CLI reads a lock once and afterwards reconnects to the port it read, so an ephemeral port per worker ends every IDE session on every layered update — the exact event this feature exists to ride. The supervisor reserves the port once, carries it in `runtime.json` as `idePort`, and hands it to every worker; a worker whose predecessor still holds it retries rather than taking another, because another port is a session the CLI cannot get back. A worker that never gets the port says so and publishes nothing, which is a named absence rather than a silently moved socket. | Recommended, after the owner's own session lost its connection |
| 8 | Selection comes from the desktop: the editor pane reports the active file and its selected range to the worker over the desktop's existing POST path, and the worker pushes `selection_changed` to every connected CLI. The desktop learns nothing about the IDE protocol; it reports a selection, which is a fact about itself. | Recommended |

## Slices

**Slice 1 (this spec's implementation).** The lock file, the WebSocket MCP server, `initialize` and
`tools/list`, `getDiagnostics`, the startup sweep and shutdown unlink, and the `selection_changed`
push with the route the desktop posts to. `/ide` lists rEdit and connects.

**Slice 2 (follow-up rows).** The desktop's own reporting of its editor selection (a C accessor over
`ReEditor`'s existing `select_start`/`select_end` and the POST from the editor pane), `at_mentioned`
from an explicit "send to Claude" gesture, and `openDiff` with accept/reject rendered in a pane.

## Verification

| Check | Establishes |
| --- | --- |
| `ide.test.mjs` — the lock is what the CLI reads | the file is `<port>.lock` under the configured ide directory, the port in the name is the port the server listens on, `useWebSocket` is true, `ideName` is rEdit, `workspaceFolders` are the bound roots, and `pid` is the **host's**, not the worker's |
| `ide.test.mjs` — a real MCP client over WebSocket | `initialize` and `tools/list` answer, and `getDiagnostics` returns an empty diagnostic list for a file in the workspace |
| `ide.test.mjs` — the token is required | a connection without the token is refused, and one presenting it in the place the acceptance run observed is accepted |
| `ide.test.mjs` — a selection reaches a connected CLI | a selection posted to the worker arrives as a `selection_changed` notification on the socket |
| `ide.test.mjs` — the sweep | a lock left by a dead rEdit worker is removed at startup, and a lock belonging to another IDE is left alone |
| `ide.test.mjs` — shutdown | the worker unlinks its own lock, because the host pid it names stays alive and the CLI would never collect it |
| LIVE | the real `claude` CLI, run in a directory inside a bound root, lists rEdit under `/ide`, connects, and the handshake's auth material is recorded — that is what decision 7 is enforced against |

Each regression is verified by breaking the implementation in the way the test claims to catch,
observing that only its own assertion goes red, and restoring; recorded in
`docs/evidence/editor-as-claude-ide-2026-09-07.md`.
