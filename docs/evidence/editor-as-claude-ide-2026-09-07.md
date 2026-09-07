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

---

# Slice 2, part two: the Language Server Protocol (F102, charter D37)

The owner chose the protocol over the narrower proposal — *"LSP adoption looks great"* — so
`getDiagnostics` now answers with what a project's declared servers publish, driven by the buffer the
desktop holds rather than by the file on disk.

## The sabotages

| | Sabotage | Red for |
| --- | --- | --- |
| L1 | the reader splits on the delimiter instead of honouring `Content-Length` | one message expected, none read |
| L2 | an edited buffer is never sent as a change | `Timed out: the change is reflected` |
| L3 | a missing command is swallowed instead of named | `Timed out: the absence is reported` |
| L4 | a dead server's diagnostics are left standing | `Timed out: the dead server's diagnostics are cleared` |
| L5 | closing a file keeps what the server said about it | the closed file still had diagnostics |
| L6 | the single star is matched before the directory wildcard | `a ** pattern matches a nested file` |

Two of these were written twice. The first attempts at L1 and L3 produced a *syntax error* rather
than a failed assertion, which establishes nothing at all — a test that goes red because the file no
longer parses has not been shown to catch anything. Both were rewritten as valid code doing the wrong
thing.

## Two bugs the tests found in the implementation

- **The glob ordering (L6 for real).** `src/**/*.c` did not match `src/deep.c`. Expanding the
  directory wildcard to its regular expression and *then* rewriting every remaining star rewrote the
  star inside that expansion. Rather than reorder the two passes, the rewrite became a single pass
  over an alternation, which cannot have the bug at all. An intermediate version used a placeholder
  that ended up in the source as a literal NUL byte — invisible in a diff and worse than the bug.
- **A crash that raced its own evidence.** The first version of the crash test had the fake server
  exit immediately after publishing, so the answer and its retraction happened in the same
  millisecond and the assertion could never observe the first. Moved to crashing on the second open,
  which leaves a real window. Separately, the fake server needed to flush stdout before exiting —
  `process.exit` after a write to a pipe drops the write.

## The pane draws them too

The editor pane now asks the worker for its file's diagnostics twice a second — answered `unchanged`
almost every time, against a version the pane already drew — and underlines each reported range in
the severity's colour. A native spec drives the real desktop against a real worker with a real
declared server: the file opens, the pane reports drawing one diagnostic, and typing an unsaved line
takes it to two while the file on disk is untouched.

| | Sabotage | Red for |
| --- | --- | --- |
| D1 | the pane never asks | `the pane draws the server's diagnostic not reached` |
| D2 | an `unchanged` answer is taken as an empty list | the count did not stay drawn between polls |
| D3 | the unsaved buffer is never sent | nothing to report, because the file on disk has no second TODO |

**D2 passed the first time, and that mattered.** The original assertion was a poll-until, which the
sabotaged build satisfied by flickering: the count alternated between one and none twice a second and
the poll caught it on a good tick. A test that passes because it sampled at the right moment has not
established anything. The assertion now samples six times over a second and requires the count to
*stay*, which the sabotage fails.

**A limit worth stating rather than glossing:** the spec asserts the count the pane holds, not the
cells the underline lands on. The draw loop tracks the protocol's column separately from the
selection path's conversion, and that tracking runs on every frame but is not asserted positionally.

---

# The live restart, and what it finally delivered (F107, 17:27)

The stable IDE port had been on `main` for hours unable to reach the running workspace, because the
supervisor is the layer that *performs* layered updates and so cannot receive one. The restart action
was built for exactly this and then run against the owner's own workspace.

| | before | after |
| --- | --- | --- |
| supervisor | 44390 | **57193** |
| workspace worker | 67302 | **57195** |
| desktop | 67548 | **57227**, 13 sessions |
| IDE lock | a new port on every update | **65353**, reserved in `runtime.json` as `idePort` |
| session host | 33465 | **33465, never signalled** |

With that in place the routes that had been unreachable answered on the live workspace: capabilities
carry `ide: 1`, `POST /api/ide-mention` returned `delivered: 1` against a really-connected CLI, and
`GET /api/diagnostics` answered.

**Two things the live run found that the tests had not.**

- **The action's own wrapper was broken.** The wizard imported the tool and passed its path as
  `argv[1]`, so the module's entry-point check fired and printed usage instead of reading the
  workspace. It failed safely at stage one with nothing signalled, but no unit test had that shape —
  only running it through `open_script` exposed it. The tool grew a `--plan` mode and the action now
  invokes it as a program: one entry point, rather than a caller that can impersonate it.
- **`since` absent was read as `since=0`.** `Number(null)` is 0 and the diagnostics version starts at
  0, so a caller that omitted the parameter was told nothing had changed since a version it never
  held. The desktop always sends one, so nothing was visibly wrong — it surfaced only when a hand
  probe asked without it. Absent is not the same as zero.

---

# Auto-connect, and the measurement that set its rule (F103)

## Four editors, and the check that did not fire

The plan was to reason from the CLI's discovery code: a lock is valid when its `workspaceFolders`
cover the cwd **and** its `pid` is one of the CLI's first ten ancestors. Two live locks covered
`/Users/alex/rengine` at the time — this workspace's (host 33465) and hirebase-v2's (host 24145) —
so the reasoning predicted that ancestry would leave exactly one.

It was measured instead. Two more locks were published naming the probe's own process, and a real
CLI was driven in a PTY with `/ide`:

```
1. rEdit  /Users/alex/rengine
2. rEdit  /Users/alex/rengine
3. rEdit  /Users/alex/hirebase-v2, /Users/alex/rengine
4. rEdit  /Users/alex/rengine, /Users/alex/nolf-improved, …
   Found 2 other running IDE(s). However, their workspace/project
   directories do not match the current cwd.
     ● rEdit:
     ● rEdit: /Users/alex/vtmb-vr
```

**All four were offered**, including hirebase-v2's, which is not this pane's ancestor by any reading.
The only filter that actually applied was folders-against-cwd; the two excluded ones were excluded
for that reason and said so. So the ancestry gate is conditional on something not true in a real
pane, and auto-connect cannot lean on it. The rule implemented is the one observed: exactly one
editor covering the working directory, and it is ours.

That also settles the question raised when a peer mentioned replacing the vtmb-vr host — the
overlapping-folder case is not hypothetical, it is the owner's machine today, and `--ide` would
silently decline rather than connect.

## A criterion that was wrong, corrected

F103 originally said auto-connect could only reach a running workspace by replacing its session
host, on the KI-043 reasoning that the launch environment is host-composed. That is wrong. The host
spawns `scripts/agent.sh`, which execs `orchestrator/agents/launch.mjs` **from the checkout at every
pane launch**. The decision is therefore made in the pane, by code read from disk, and reaches a
running workspace with no host replacement and no layered update at all. The row records the
correction rather than quietly dropping the claim.

## The sabotages

| | Sabotage | Red for |
| --- | --- | --- |
| C1 | the flag is passed whenever any editor is offered | `two offered means no flag` |
| C2 | containment is a bare prefix test | `/work/rengine-old` matched the editor serving `/work/rengine` |
| C3 | a dead editor is still offered | a lock with no live process was returned |
| C4 | every CLI is given the flag | codex, gemini and opencode were not left alone |

C2 passed on the first attempt, and the fixture was the reason: it asserted that `/work/rengine-old`
is not offered when querying from *inside* `/work/rengine`, which a bare prefix also gets right. The
direction that distinguishes them is the opposite one — querying from the sibling — and the test now
asserts that instead.

## What is not met, and said so in the row

- Parsed check-action output as a second source is not built. Marked NOT MET.
- F107 meets every criterion including the live run and still stays `passes: false`: its
  prerequisite F94 is unverified, and the dependency is real rather than bookkeeping — the refusals
  that keep the session host safe are F94's code. The inventory validator refused the alternative.

## What is not done

`at_mentioned` has its transport but no gesture. Which affordance sends it — a key chord, a pane
control, a menu entry — is a design choice for the owner; inventing one silently is how an editor
grows a gesture nobody can find. F100 stays `passes: false` for that reason, and the criterion says
so rather than being quietly dropped.
