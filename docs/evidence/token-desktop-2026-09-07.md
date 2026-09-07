# The project token in the chrome: thirteen regressions, each watched failing — 2026-09-07

Evidence for stage 3 of [spec 095](../specs/095-project-token.md): the native desktop's status-bar
segment, its popover, and the recorder's announcements on the live channel. F90 stays
`passes: false` — stages 2 and 4 are not built, and this records only what the desktop now does.

Everything here is `orchestrator/tests/native-token.spec.mjs`, driven through
`orchestrator/tests/token-fixtures.mjs`: a stand-in for the workspace worker's interception that
proxies the session host, keeps the frames the desktop sends on `/events`, and pushes the ledger's
own frames back. It holds no ledger, which is deliberate — the ledger is stage 2, and a fixture that
invented one here would be asserting against itself.

## Method

Each row was produced the house way (`AGENTS.md`, *Work protocol*): break the one mechanism the
assertion claims to catch, rebuild, run the spec, read **which** assertion went red and confirm it
is that one and not an earlier one, then `git checkout` the file. The full loop is
`scratchpad/sabotage.sh` in this session; every row below is a real run. Rows 10 and 13 were run
against the shipped shape of the segment's press — served in `re_app_event` rather than as a microui
control, because the status bar is drawn outside microui and a window of its own would have cost one
of the 32 root containers that fifteen leaf panes with a surface open already fill.

| # | Broken | Assertion that went red | Not an earlier one, because |
| --- | --- | --- | --- |
| 1 | `re_token_segment` drops the held branch and always prints *Token · free* | `a held token wears the holder label not reached` (the inspected state showed `holder.label: "claude"` beside `segment: "Token · free"`) | the free-token assertion above it passed in the same run |
| 2 | `re_token_event` never parses the deadline (`deadline_ms = 0`) | `the countdown runs against the desktop's own clock: 0` | the segment still matched `Contest · codex · \d+s`, so only the number was wrong |
| 3 | `re_token_event` drops the primary-root comparison | `another root's ledger never renames this segment` — expected `Token · claude`, actual `Token · gemini` | the held and free segments both passed first |
| 4 | `send_action` omits `contestId` | the reject frame's `deepEqual`, missing `contestId: 'contest-1'` | the popover opened and the control was found; only the frame's text differed |
| 5 | `send_action` attaches `contestId` whenever one is open, not only to reject and grant | the revoke frame's `deepEqual`, with an extra `contestId: 'contest-1'` | reject and grant passed in the same run, so the failure is specific to the two gestures that own no contest |
| 6 | `app.c` no longer calls `re_token_clear` on `disconnected` | `a lost connection clears the token state not reached` | all four gestures passed above it |
| 7 | `re_recording_toggle` announces nothing when it starts | `a started frame never arrived: []` | the first test passed; the recorder's own state still reached `recording` |
| 8 | `begin_commit` mints a fresh id instead of reusing the explicit segment's | `the start and the commit name one directory` — `…084503Z-b872d9` against `…084502Z-b87650` | the start frame arrived and was well-formed; only the pairing broke |
| 9 | the announcement uses the manifest's word (`segment`) rather than the feed's (`explicit`) | `the feed names the gesture, not the manifest shape` — expected `explicit`, actual `segment` | the frame arrived with the right ids and timestamp |
| 10 | `re_app_event` no longer serves a press on the segment | `the segment opens the popover not reached` | the segment's text, countdown and reported rectangle were all still correct |
| 11 | the popover's held-token block is skipped | `the popover offers revoke` | the contest block's Reject and Grant were found first |
| 12 | `re_recording_commit_ring` announces a `started` of its own | `a ring commit has no start to announce` — expected `committed`, actual `started` | the explicit pair passed above it |
| 13 | the segment reports no rectangle to automation | `token segment not reached` | the free, held and contested segments were all read from the inspect op first, so only the reachable rectangle was missing |

## What the fixture can and cannot say

- It proves the **text the desktop sends**, byte for byte, because the frames are compared with
  `deepEqual` against the pinned contract rather than matched loosely.
- It proves the **segment's own text**, because `re_app_inspect` reports `token.segment` — the same
  string the status bar draws, from the same function — rather than the fixture re-deriving it.
- It cannot prove what the ledger does with a `token-action`, and does not try: no transition, no
  cooldown, no deadline transfer is asserted here. Those are stage 2's criteria (3, 4, 7).
- It cannot prove the segment's **pixels**. The face is owned drawing laid down after every pane;
  what is asserted is the rectangle the pointer lands on and the text that rectangle carries.

## Two things stage 2 should know

1. **The countdown is floored, not rounded up.** The desktop's wall clock is `time(NULL)`, so a
   deadline 60 s away is somewhere in `[60000, 61000)` ms by the desktop's reckoning. Rounding up
   would open a 60-second window reading `61s`; flooring reads `60s` and shows `0s` for the last
   part-second. Nothing depends on the desktop's number — the ledger owns the deadline.
2. **The recorder's `kind` is the feed's vocabulary.** `ring` and `explicit`, per the pinned
   contract. The manifest spec 081 writes still says `kind: "segment"` for the explicit gesture, and
   the two are deliberately different words for the same segment: the feed names the gesture, the
   artifact names its shape. A worker mapping `recording` frames onto `capture.*` must not expect
   the manifest's word.
