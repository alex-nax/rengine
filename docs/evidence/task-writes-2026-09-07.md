# Blind-regression evidence: token-serialised task writes and task-driven spawns (F105)

Date: 2026-09-07. Feature: [spec 103](../specs/103-task-driven-agents.md), decisions 2–4 and 6–9,
plus the desktop `assign` action of decision 5. Suite:
`orchestrator/tests/task-writes.test.mjs` (tests 1–9), fixtures
`orchestrator/tests/task-fixtures.mjs`. Baseline before this branch: 170/170; after: 179/179.

A test that has never failed is an assertion with no evidence behind it. Every row below is one
edit, applied alone against the finished code, run, and restored — `git checkout -- <file>` after
each, with the tree confirmed clean and green again at the end.

## What the fixture actually does

The write is not mocked. `tools/write-task.mjs` in the fixture project is a real executable the
declaration names in `tracker.write`; it appends the argv it was handed to `write-log.txt`, brackets
its work with `start`/`end` lines, sleeps for as long as the row's `slowMs` asks, and then edits the
project's own `features.json`. So "two holders never interleave" is read off a log a second writer
would have interleaved, not inferred from a lock's existence. The spawn is not mocked either: a real
executable is planted where `agent.sh` looks first
(`$RENGINE_AGENT_HOME/<agent>/node_modules/.bin/<agent>`), it records its own argv as JSON and stays
running, so the model flag and the rendered prompt are read out of the arguments a CLI was actually
started with.

## The first thing the tests found

The pinned interface says the spawn goes through the host's existing `/api/terminal` with
`type: 'agent'`, `agent` and `args`. The host **accepted `args` on that route and dropped them**:
`spawnTerminal` overwrites `argv` for an agent pane and never forwards the caller's arguments to
`agent.sh`. Nothing errored — the pane started, the CLI ran, and the prompt and the model flag were
simply gone. That is why the host change is two things rather than one (see the spec-103 correction
in that spec), and S9 is the regression that holds it.

## The sabotage table

| # | The break | What went red, and for what |
| --- | --- | --- |
| S1 | `/api/task` takes the caller's identity without calling the gate | 3 — the non-holder's write answers `200 !== 409`; and 9, where `task_add` from the second tool client is no longer refused |
| S2 | the write runs directly instead of through the per-root chain | 4 — the log reads `start F10, start F11, end …` instead of `start, end, start, end` |
| S3 | the missing-`tracker.write` check is skipped | 5 — the route reaches `runCommand` with no command and answers `500 !== 409` instead of naming what is missing |
| S4 | the non-local-provider check is skipped | 5 — the GitHub project falls through to the *no write command* refusal, so the message never says `tracker is github` |
| S5 | the document is built `{ action, ...row }` instead of action last | 8 — a row carrying `action: 'update'` renames an `add` call |
| S6 | `renderPrompt` does not scan for unknown placeholders | 2 — "Missing expected rejection: a placeholder the project misspells is reported, never emptied" |
| S7 | `promptFor` never reads the project's file | 2 — the override does not take; the shipped brief comes back instead |
| S8 | `modelArgs` guesses `--model` for a CLI it has no flag for | 6 (gemini is started rather than refused) and 8 ("Missing expected exception") |
| S9 | the host does not append `--` and the pane's args to `agent.sh` | 6 — the recorded argv is the MCP wiring alone; `--model` is not in it |
| S10 | the spawn records the conversation without the task | 6 — the conversation's `task` is `undefined !== 'F1'` |
| S11 | the spawn emits `task.added` instead of `agent.spawned` | 6 — "Timed out: agent.spawned reaches the feed" |
| S12 | `assign` settles the open contest with a cooldown | 7 — the contester is charged a window it never earned |
| S13 | `assign` consults only the ledger's own identities | 7 — an agent known to the project's conversations and not to the ledger cannot be given the token |
| S14 | the `write` contract floor is dropped | 1 — `write` under contract 5 is accepted in silence (`trackerError: undefined`) |
| S15 | the `default must be one of its models` rule is dropped | 1 — a menu whose default is not on it validates |
| S16 | the `${json}` rule is dropped | 1 — a write command that never names the row validates |
| S17 | `agents` is not carried into the declaration result | 1 — the reader gets `undefined`, so a declared menu would be silently ignored |
| S18 | `taskWrites`/`agentSpawn` are advertised unconditionally | 9 — the ledgerless worker claims them (`1 !== undefined`), which is the spec-078 asymmetry |
| S20 | `localRows` stops carrying `acceptance_criteria` | 6 — the rendered prompt no longer carries the task's criteria |
| S21 | the spawn always renders the `task` brief | 6 — a decompose spawn hands the CLI the task brief |

Two rows took a second test with them, and in both cases it is the same claim made from the other
side rather than a leak: S1's second casualty is the tool-worker client, which asks the same
question through MCP, and S8's is the unit assertion beside the route's.

## The masked case, recorded because it is the trap

| # | The break | What went red |
| --- | --- | --- |
| S19 | `CONTRACTS` loses `6` while the keys stay | 1, 3, 4, 5, 6 and 9 — six tests, none of them for their own reason |

With the ceiling back at 5 the whole fixture declaration is refused as an unknown contract, so the
project has no tracker at all: the writes fail because there is no declaration, the spawn fails with
`No task "F1"`, and test 1 fails on the first line rather than on the contract floor it is about.
This is the sixth case in
[blind-regressions-2026-09-06](blind-regressions-2026-09-06.md) — the control masking the thing under
test — and it is why S14, S16 and S17 are separate rows: each is the specific rule, with the ceiling
left alone.

S11's first attempt is worth recording too. It replaced the frame with
`await Promise.resolve(null) ?? await note(…)`, which is `null ?? x` — so `note` was still called and
the suite **stayed green**. A sabotage that does not break what it claims to break proves nothing;
the row above is the corrected edit, which emits the wrong frame type and is caught by name.

## Gates at the merge

`node --test orchestrator/tests/*.test.mjs` 179/179 (170 before this branch, 9 added). Tree clean
after every restore. No test makes a network call: the remote-provider refusal is a declaration
read, and nothing in the suite reaches GitHub or Linear. The fake CLIs and the fake write command are
executables inside per-test temporary directories, removed with them.
