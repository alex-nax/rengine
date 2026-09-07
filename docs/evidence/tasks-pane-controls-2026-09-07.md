# The Tasks pane's per-task controls: twelve regressions, each watched failing — 2026-09-07

Evidence for the Tasks-pane half of [spec 103](../specs/103-task-driven-agents.md) decision 5 and
acceptance criteria 4 and 5: **Spawn ▾** (agent · model), **Decompose**, **Hold token ▾** (live
agents), the labels of the agents already working a task, and the pane's own note for what the
workspace refuses. F105 stays `passes: false` — criteria 5's end-to-end (a scripted agent whose
`task_add` calls actually create child rows) and criterion 4's *Sessions tab and `workspace_info`
show the task beside the agent* are not proved here.

Everything below is `orchestrator/tests/native-tasks-controls.spec.mjs` (six tests), driven through
`orchestrator/tests/tasks-controls-fixtures.mjs`: a stand-in for the worker layer that proxies the
session host, serves `/api/tracker`, `/api/agents-menu` and `/api/agent-spawn` itself, folds the
capabilities a test chooses into `/api/state`, and keeps the `token-action` frames the desktop sends
on `/events`. The real worker landed on `origin/main` during this work and its own routes are proved
by `orchestrator/tests/task-writes.test.mjs`; the fixture is kept because what is under test here is
the **pane** — which body it sends for which gesture — and a fixture records that byte for byte
without a project, a ledger, an installed CLI and a real pane standing between the press and the
assertion.

## Method

Each row was produced the house way (`AGENTS.md`, *Work protocol*): break the one mechanism the
assertion claims to catch, rebuild, run the spec, read **which** assertion went red and confirm it is
that one and not an earlier one, then `git checkout` the file. The loop is
`scratchpad/sabotage2.py` in this session; every row below is a real run.

| # | Broken | Assertion that went red | Not an earlier one, because |
| --- | --- | --- | --- |
| 1 | `spawn()` never puts `model` on the body | the spawn body's `deepEqual`, missing `model: 'haiku'` | the chooser assertions above it passed in the same run — the agent list, the preselected `opus`, and the three model controls were all found; only the body differed |
| 2 | Decompose sends `brief: 'task'` | the decompose body's `deepEqual` — `+ brief: 'task'` against `- brief: 'decompose'` | the spawn body, `model: 'haiku'` and all, passed above it in the same test, so the failure is specific to the second gesture |
| 3 | the assign names the live agent's `sessionId` rather than its agent id | the assign frame's `deepEqual` — `agentId: 'sess-1'` against the conversation | the chooser opened and `tracker-live` was found *by that agent id* and clicked, so only the frame's text differed; the other five tests stayed green |
| 4 | the provider is ignored: every row reads as local | `decompose writes rows into an inventory this provider owns` — `['#7']` against `[]` | `tracker-spawn` `['#7']` passed immediately above, so Spawn was still offered and only the writing controls leaked onto a remote row |
| 5 | choosing an agent clears the model instead of preselecting the declared default | `the declared default is preselected` — `'' !== 'opus'` | the chooser-opened `deepEqual` and both agent-control lists passed first |
| 6 | `working_labels` drops the task comparison | `the working mark is on the task the agent records, not on every row` — `['F1','F2']` against `['F2']` | the three control-cluster assertions passed above it, so the rows themselves were right and only the join was wrong |
| 7 | the `agents-menu` request is never made | `the agent menu answers not reached`, in five of the six tests | the sixth is the one asserting that a workspace serving no menu says so — which is exactly what an unfetched menu looks like from the pane, and is the honest failure mode of deleting the fetch |
| 8 | the `agentSpawn` gate is removed | `the refusal names the missing gate not reached`; the inspected state showed `status: "claude is on F2 · conversation-1"` — the spawn had gone out | the five other tests stayed green, including the one where the capability is present and the same press must send |
| 9 | the `taskWrites` gate is removed from Decompose | `the refusal names the missing write not reached`; the state showed the decompose had gone out | the ungated test (no `agentSpawn` at all) still passed, so only Decompose's *extra* prerequisite was lost, not the shared one |
| 10 | the menu is fetched whatever the workspace advertises | `The input did not match /serves no agent menu/. Input: ''` | the menu answered instead, so the pane had nothing to say; the other five tests passed |
| 11 | the spawn leaves on the generic operation instead of `OP_AGENT_SPAWN` | `the worker's detail reaches the pane not reached` | both spawn bodies were still exact in the same run — the request is unchanged; only its answer no longer reaches the pane |
| 12 | the criteria loop skips every string it is given | `the task's own criteria are shown where the agent is chosen` — `[]` against `['F2','F2']` | the agent and missing-agent control lists passed above it, so the chooser opened and only the criteria rows were absent |

## Two ways this table nearly lied

1. **The loop restored the files to the commit without the feature.** The first sweep ran with the
   implementation uncommitted, so `git checkout -- <file>` after case 1 restored tracker.c from the
   *index* — the merge result, before the capability gating — and every later case was measuring code
   that was not the code under test. Session 64 hit the same trap the same day and wrote it down; this
   sweep runs from a committed tip and the tree is verified clean before it starts.
2. **One sabotage did not compile.** `cJSON_ArrayForEach(criterion, NULL)` is `member reference base
   type 'void'`, so the test ran the *previous* case's binary and went red for the previous case's
   reason — a green-looking row that proved nothing. The loop captures the build output beside every
   run, which is how it was caught; case 12 was re-run as "skip every string criterion", which
   compiles, and went red where it should.

## What the fixture can and cannot say

- It proves **which body each gesture sends**, byte for byte: the bodies are compared with `deepEqual`
  against the pinned contract — `desktopId` included, read back from `/api/desktops` rather than
  assumed — so a spawn that quietly drops the chosen model or sends the wrong brief is red.
- It proves the **assign frame** the same way, and that it is the *conversation* that names the
  identity: a live agent whose CLI names its own conversation is listed under a different control
  role and cannot be pressed, because the ledger would refuse an assign with no `agentId`.
- It proves **what a press does not send**: the refusal tests assert `spawns.length === 0`, so a gate
  that draws a refusal and posts anyway is red.
- It cannot prove the **pixels**. What is asserted is the rectangle the pointer lands on, reported by
  the same `re_app_control` every other `tracker-*` control uses, and the pane state
  `re_app_inspect` reports from the same fields the rows draw from.
- It cannot prove what the worker **does** with a spawn: no pane is started, no conversation is
  recorded, no subtask row is written. Those are criteria 4 and 5's other half, in
  `orchestrator/tests/task-writes.test.mjs` and, for the end-to-end, still owed.
