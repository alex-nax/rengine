# rEdit as a Claude Code IDE — macOS, 2026-09-07

F99, spec 102, slice 1. The protocol facts were read out of
`/Users/alex/.local/share/claude/versions/2.1.263` (a Bun-compiled binary) and then checked against
the running CLI, because a string in a binary is a guess until something connects.

## What the binary said

`~/.claude/ide/<port>.lock`, port taken from the filename; keys `workspaceFolders`, `pid`, `ideName`,
`useWebSocket`, `runningInWindows`, `authToken`; `ws://` when `useWebSocket`; cwd must be under a
workspace folder; in a terminal the `pid` must be alive and within `_kn(process.ppid, 10)` — the
CLI's first ten ancestors. `CLAUDE_CODE_SSE_PORT` and `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` bypass those
checks. Tools called on the IDE: `getDiagnostics`, `openDiff`, `close_tab`, `closeAllDiffTabs`.
Notifications accepted: `selection_changed`, `at_mentioned`.

Two things the binary did **not** say, both of which decided the implementation:

- **Where the token is presented.** Not visible in the strings.
- **Whether print mode connects at all.** It does not — see below.

## The live run

| Attempt | Result |
| --- | --- |
| `claude -p --ide --model haiku` in a temp workspace, probe as parent | CLI answered normally, **0 connections**. Print mode never connects to an IDE; `--ide` alone proves nothing. |
| Interactive CLI under a PTY in a fresh temp directory | stuck on *"Is this a project you created or one you trust?"* — answering it would have written a trust record for a temp path into the owner's config, so the probe moved to this checkout, which is already trusted. |
| Interactive CLI under a PTY, cwd `/Users/alex/rengine`, `/ide` | **`Select IDE … ❯ 1. rEdit ✔`**, then **`Connected to rEdit.`** One connection observed, accepted. |

The accepted handshake, recorded by the bridge:

```
sec-websocket-protocol: mcp
user-agent: claude-code/2.1.263 (cli)
x-claude-code-ide-authorization: <the lock's authToken>
```

So the token arrives in `x-claude-code-ide-authorization` and the CLI negotiates the `mcp`
subprotocol. Both are now enforced rather than guessed: the speculative query-string and
subprotocol token positions were removed once the real one was known, and the server echoes `mcp`.

## Failing first, then the sabotages

Each row is the implementation broken in the one way the test claims to catch, the single test run
by name, and what it printed. Restored after each.

| | Sabotage | Red for |
| --- | --- | --- |
| S1 | the lock names the worker instead of the session host | `the lock names the host, not the worker` — expected 4242, actual 99 |
| S2 | publish a lock even with no host pid to name | `published` expected false, actual true |
| S3 | diagnostics refuse instead of answering an empty list | `MCP error -32603: no language server for file:///work/a.c` |
| S4 | any loopback connection is trusted | `the socket was neither closed nor refused` |
| S5 | the notification uses a name the CLI does not know | expected `selection_changed`, actual `selectionChanged` |
| S6 | the sweep collects every stale lock, not only ours | another IDE's `333.lock` was deleted too |
| S7 | close leaves the lock behind for the CLI to collect | the lock survived, and it names a host that is still alive |
| S8 | the `mcp` subprotocol is not echoed back | `Server sent no subprotocol` |

## The trap this design is built around

The CLI deletes a lock whose `pid` is dead. Ours names the **session host**, because that is the only
process in a pane's ancestor chain — so the CLI's own garbage collection can never fire for us: the
host outlives every worker. That is why the bridge unlinks its lock at retirement and sweeps stale
rEdit locks on startup, recognising its own by `rengineWorker`, a key the CLI's parser ignores.
Naming the worker or the desktop instead would have produced a lock the CLI silently skips — the
failure would have looked like "rEdit doesn't show up" with nothing in any log.

## Gates

`node --test orchestrator/tests/ide.test.mjs` 7/7; `npm test` on the merged head; `./init.sh` and
`python3 tools/features.py validate` clean. Recorded in `Codex-progress.md`.

---

# Slice 2, part one: the editor reports what the person is looking at (F100)

## The selection contract, confirmed by accident

The shape pushed as `selection_changed` was invented from the CLI's vocabulary, not from a
documented schema. It was confirmed the same afternoon, by accident: the probe that proved the live
bridge posted a real selection into the owner's own session, and the CLI rendered it as
*"The user selected the lines 19 to 19 from …/ide.mjs: export const IDE_NAME = 'rEdit';"* — a
0-based `line: 18` shown as line 19. So `{filePath, text, selection: {start: {line, character}, end}}`
is understood, lines are counted from zero, and the notification reaches the conversation as context
rather than being merely accepted.

## Counting characters

The editor's buffer holds code points; the protocol counts UTF-16 code units. The fixture line
`const char *s = "🙂🙂";` gives three different answers, which is the point of choosing it:

| Counting | Result |
| --- | --- |
| code points | 21 |
| **UTF-16 code units** | **23** |
| bytes | 27 |

The first run of the spec failed at 23 against an expected 24 — the arithmetic in the test's own
comment was wrong, not the implementation. The expectation was corrected to what the rule actually
produces.

## The native sabotages

| | Sabotage | Red for |
| --- | --- | --- |
| N1 | characters counted as code points | `1:0-1:21` against the expected 23 |
| N2 | a pane with no editor keeps the last selection standing | the Tasks tab still reported `a.c\|1:0-1:23` |
| N3 | byte offsets instead of the protocol's units | `1:0-1:27` |

Each was rebuilt, run alone against `native-ide-selection.spec.mjs`, and restored.

## What is not done

`at_mentioned` has its transport but no gesture. Which affordance sends it — a key chord, a pane
control, a menu entry — is a design choice for the owner; inventing one silently is how an editor
grows a gesture nobody can find. F100 stays `passes: false` for that reason, and the criterion says
so rather than being quietly dropped.
