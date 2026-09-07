# The Sessions tab revokes the token: five regressions, each watched failing — 2026-09-07

Evidence for [spec 103](../specs/103-task-driven-agents.md) decision 1 and acceptance criterion 1:
the Conversations section of the Sessions tab marks which agent session holds the project token and
offers **Revoke** beside it, **Free** when the holder's process is gone. F105 stays `passes: false` —
decisions 2 through 9 are not built, and this records only what the Sessions tab now does.

Everything here is `orchestrator/tests/native-sessions-token.spec.mjs`, driven through the token
fixture stage 3 already uses (`orchestrator/tests/token-desktop-fixtures.mjs`): a stand-in for the
workspace worker's interception that proxies the session host, keeps the `token-action` frames the
desktop sends, and pushes the ledger's own `token` frames back. It holds no ledger, which is
deliberate and unchanged from [the stage 3 evidence](token-desktop-2026-09-07.md) — what the ledger
*does* with a `token-action` is stage 2's criteria, not this surface's.

The live row under test is a real `claude` agent pane (`--action menu`, which blocks on its own
prompt), so the conversation the row is keyed on is one the workspace actually minted for a running
process rather than a string the test invented.

## Method

Each row was produced the house way (`AGENTS.md`, *Work protocol*): break the one mechanism the
assertion claims to catch, rebuild, run the spec, read **which** assertion went red and confirm it is
that one and not an earlier one, then `git checkout` the file. The loop is `scratchpad/sabotage.sh`
in this session, and it refuses to run against a dirty tree — the first attempt at this table ran
before the implementation was committed and its `git checkout` restored the file to the commit
*without* the feature, which is a red for the wrong reason and was discarded.

| # | Broken | Assertion that went red | Not an earlier one, because |
| --- | --- | --- | --- |
| 1 | `re_token_holds` compares the row against `holder_label` — the name the status segment shows — instead of `holder_agent` | `the holder's own row is marked not reached` (test 1) and `the gone holder is still marked on its own row not reached` (test 2) | the three assertions above it in test 1 passed in the same run: the row is reported, `holdsToken` is false before the ledger speaks, and neither control is offered |
| 2 | the row's Revoke sends the other gesture (`re_token_action(a, revoke ? "free" : action)`) | the frame's `deepEqual`: `+ action: 'free'` against `- action: 'revoke'` | the mark, the `revoke` control and the absence of a `free` control were all asserted first; test 2, which presses Free, passed untouched, so the failure is specific to the revoke gesture |
| 3 | the mark never clears: `re_token_holds` answers from the last holder the ledger named rather than the current one | `a freed token clears the mark not reached` | the mark, the control and the frame all passed above it — the row was drawn correctly right up to the holder-null frame |
| 4 | liveness is ignored: `conversation_token_action` returns `"revoke"` unconditionally | `a holder whose process is gone is freed, not revoked` | test 1 passed in full, so a live holder still gets Revoke; and the mark on the gone holder's row was found before the action was read |
| 5 | any held token marks every row: `re_token_holds` never compares the holder to the row | `a row for a non-holder carries no mark` | test 1 passed in full (there the row *is* the holder), and in test 2 the Free assertions and the Free frame passed above it |

## What the fixture can and cannot say

- It proves the **frame the row sends**, byte for byte, because `token-action` is compared with
  `deepEqual` against the pinned contract — and that it is the *same* frame the popover sends,
  because both surfaces call `re_token_action` and there is no second builder.
- It proves the **row's own derivation**, because `re_app_inspect` reports the conversation rows as
  the interface pass drew them (`holdsToken`, `tokenAction`) rather than the test re-deriving them
  from the token state. A mark keyed on the wrong id is therefore red in the report as well as wrong
  on the screen — row 1.
- It proves the row **follows the ledger** rather than remembering it: a holder-null frame clears the
  mark and both controls — row 3.
- It cannot prove what the ledger does with the frame, and does not try: no transition, no cooldown,
  no re-claim by `token_contest` is asserted here. Criterion 1's second half — "another agent's
  `token_contest` then claims it" — is stage 2's ledger, already covered by `native-token-e2e`.
- It cannot prove the row's **pixels**. What is asserted is the rectangle the pointer lands on, the
  gesture that rectangle sends, and the mark the row reports.

## Two things the next stage should know

1. **The pinned `token` frame carries no liveness.** `segmentFrame()` in `runtime/token.mjs` drops
   the `holderAlive` that `status()` computes, and the worker was not changed here, so the desktop
   derives the holder's liveness from the `holder.pid` the frame does carry — `kill(pid, 0)` on
   POSIX, `OpenProcess` on Windows — on the ledger's own terms (`gone()`: a pid it does not know is
   not a dead pid, and a process this desktop may not signal is still a process). Both halves run on
   the machine the ledger runs on, which is the only place a loopback workspace puts them. If a later
   stage adds `holderAlive` to the frame, `re_token_holder_alive` is the one place that changes.
2. **A hold outlives the process that took it.** The conversation IS the identity (spec 095), so the
   past-conversation row carries the mark too — and that is exactly where a holder whose pane has
   exited is listed. Marking only live rows would have made Free unreachable in the case it exists
   for. The test drives the live row, because a live pane with a dead ledger pid is the case a
   fixture can produce deterministically; the past row shares the derivation, not a second one.

**Not verified here:** the live gesture on the owner's own workspace — that pressing Revoke on the
Sessions tab of a running desktop takes the token off a real agent and that the next `token_contest`
claims it. It carries the same reason spec 099 carries: a workspace whose host predates this cannot
exercise it, and this session runs inside that host.
