# The agent identity is the CLI's session id — sabotage record, 2026-09-07

The owner's decision (verbatim at the head of [spec 095](../specs/095-project-token.md)'s *Identity*
section) makes the `agentId` the agent CLI's own session id, decided at launch from the flags the
launch was given. Two ledger defects seen live the same day are closed beside it: a `release` that
left an open contest hanging, and a `tokenWindowMs` change that re-timed one.

Twelve sabotages, each broken in the specific way one assertion claims to catch, observed red for
that assertion and not an earlier one, then restored. Tests are
`orchestrator/tests/agent-identity.test.mjs` and `orchestrator/tests/project-token.test.mjs`, run with
`node --test --test-name-pattern=…`.

| # | Broken | Assertion that went red | Notes |
| --- | --- | --- | --- |
| 1 | `agentLaunch` stops adding `claudeStart(bound)` to the claude args | `a launch with no session of its own is started as the identity rEngine minted` | The minted id would then be a number beside the conversation instead of its name — the exact failure the owner's decision is about. |
| 2 | `claudeSession()` reads the session flags but not their value | `--session-id names the session, and that session is the identity` | Red on the first of the three spellings; `--resume` and `-r` are the same loop. |
| 3 | `claudeStart` names a session even when the args already named one | `--session-id is passed through unchanged, with no second session named beside it` | Two `--session-id`-shaped flags on one command line is the "pass through unchanged" rule, not a cosmetic one. |
| 4 | `-c` / `--continue` treated as an ordinary argument | `--continue resumes a conversation whose id rEngine cannot know` (`true !== false`) | The id is minted inside the CLI. Claiming `known: true` here is how a wrong id gets recorded confidently. |
| 5 | `--fork-session` ignored | `a fork is a new conversation, so the resumed id is not this identity` | The resumed uuid is on the command line and looks authoritative; the fork is what makes it wrong. |
| 6 | `agentIdentity` drops the codex handoff's `sessionId` | `codex's handoff names the conversation, and it is the identity` | The one non-Claude CLI that already carries a session id. |
| 7 | `agentLabel` returns the CLI name alone | `the label is the CLI name and the first eight of the id it resumes by` | Test 1 of the identity suite: two launches otherwise identical. |
| 8 | `bind` ignores `--session` and mints its own id | `--session binds the identity to the session that already exists` | The half of the decision that binds a session that is already running. |
| 9 | A bound session's start line is `--session-id` instead of `--resume` | `the start line resumes that session rather than naming a new one` | `--session-id` on a session that exists is the one way to make binding *look* right and be wrong. |
| 10 | `Ledger.seen()` no longer refreshes the holder's pid | `under the process it is running in now` (`12154 !== 12129`) | The resumed session's own request is what carries the new pid. |
| 10b | Same defect, with the pid assertions lifted out of the way | `so another agent opens a window rather than taking it as a token nobody holds` | The consequence assertion discriminates on its own: without the refresh the resumed holder reads as gone and another agent takes the token at once. Case 3 of `blind-regressions-2026-09-06.md` in miniature. |
| 11 | `release()` restored to freeing the token and leaving the contest open (the defect as it shipped) | `releasing under an open contest hands the token to the contester` (`'free' !== 'claimed'`) | |
| 11b | The transfer is attributed `by: { kind: 'agent' }` | `the transfer is attributed to the release, not to a deadline that never arrived` (`'agent' !== 'release'`) | The frame's `by` is what a monitor reads to learn *why* it now holds the token. |
| 12 | `Tokens.setWindow()` re-times every open contest to `now + value` | `and the open contest keeps the deadline it opened with` | |
| 12b | `settleRejection()` charges `this.window()` instead of the contest's own | `a rejection costs the window its own contest was opened under, not whatever the preference has since become` | The cooldown is the other duration a contest implies, and it was the one still reading the live preference. |

## What the fixtures had to be shaped like to discriminate

- **The resumed-session test claims the token under a pid that has already exited**, then answers
  under `process.pid`. The control assertion (`the process that claimed it really is gone`) runs
  first, so a fixture where the "old" process was still alive would pass without proving anything.
- **The release/window test opens its contest under a 5 s window and then shortens the preference to
  300 ms**, waits 900 ms — three of the new windows — and checks the token has *not* moved. A
  re-timing defect resolves the contest in that gap, so the assertion fails by the token being in the
  wrong hands rather than by an unequal timestamp alone.
- **The cooldown assertion runs the change the other way** (4 s window at the contest, 300 ms
  preference at the rejection) so the two numbers cannot be confused and the threshold is nowhere
  near either.
- **`token.released` is asserted absent** after a release that transferred. The token was never free,
  and a frame saying otherwise would be read by a monitor as a moment when anyone could have claimed
  it.

## What the code corrected in the report that prompted it

The report said a `tokenWindowMs` change "re-timed an open contest". The stored deadline was already
an absolute wall time and `arm()` already read it, so **the deadline itself never moved** — what
followed the live preference were the two other durations a contest implies: the window a `status`
read reported for an already-open contest, and the cooldown a rejection of it charged. Both now come
from `contest.windowMs`, pinned when the contest opens, and `setWindow` touches no open contest at
all. The regression in the table is the sabotage of the invariant, not of a defect that was there;
the release defect (11) was, and is reproduced by restoring the shipped code.
