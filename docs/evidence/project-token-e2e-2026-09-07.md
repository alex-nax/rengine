# The two halves of the project token, meeting — 2026-09-07

The check [spec 095](../specs/095-project-token.md) still lacked after stages 2 and 3: the **real**
workspace worker's ledger and feed driving the **real** native desktop's token segment, and the
desktop's own controls driving the real ledger. Stage 2 asserted the ledger against a stand-in
desktop (`fakeDesktop` on a raw socket); stage 3 asserted the desktop against a stand-in worker
(`token-desktop-fixtures.mjs`, which holds no ledger). Its report said so plainly: *"Nothing yet
asserts the two halves together."*

`orchestrator/tests/native-token-e2e.spec.mjs`, two cases, run by `npm run test:desktop`:

- **the real ledger drives the real segment, and the real popover drives the real ledger** — a real
  session host, a real runtime supervisor (`startRuntime`) with a real workspace worker under it,
  and the real desktop binary the supervisor snapshots and launches. Four identities claim, contest,
  are rejected, granted and revoked; every gesture is a click on the real popover and every
  assertion about it is read back through `re_app_inspect` and through `GET /api/token` and the
  feed socket on the worker's own URL.
- **the recorder in the real desktop commits a segment the real feed announces** — the recorder
  toggle in a real game pane, over the real surface fixture, announced on the same `/events` socket
  the desktop registers on, intercepted by the real worker, landing on the real feed.

Nothing in either case is a fixture except the project the agents are arguing about
(`tokenProject`, stage 2's) and the SDL surface the game pane draws.

## What it proves that neither stage could

| Spec 095 criterion | Stage 2 proved | Stage 3 proved | This adds |
| --- | --- | --- | --- |
| 5 (desktop reject/grant/revoke/free) | the ledger's answer to a raw socket's frames | the frames the desktop sends | the desktop's *click* reaching the ledger, and the ledger's answer reaching the *segment* |
| 9 (segment free/held/countdown, popover controls) | — | against a hand-written `token` frame | against the frame `Ledger.segment()` actually produces |
| 6 (capture.started / capture.committed) | against hand-sent `recording` frames | against a stand-in that only kept them | the recorder's own ids, through the worker, onto the feed |
| 7 (replacement keeps holder and deadline) | `close()` + `startWorker` on one runtime directory | — | a real supervisor `update-workspace`, with a desktop attached — and the boundary it exposes, below |

## Sabotage table

Each row: break the one mechanism the assertion claims to catch, rebuild (`npm run build` for every
row, including the JavaScript ones — a restored source tree still leaves the previous row's binary,
which produced seven misattributed reds on the first sweep and is why they were all re-run), run the
spec, read **which** assertion went red, `git checkout` the file. Harness and raw output:
`.cache/probe/` in this session, not committed.

| # | Broken | Assertion that went red | Criterion |
| --- | --- | --- | --- |
| 1 | `worker.mjs` does not push the ledger at `desktop-register`, only on the next transition | `the desktop is pushed the ledger it registered against not reached` | 9 |
| 2 | `Ledger.segment()` reports `holder: null` whatever it holds | `the segment wears the holder the real ledger recorded not reached` | 9 |
| 3 | `re_token_event` drops the holder's pid | `the identity's live pid reached the chrome: 0 !== 36514` | 1, 9 |
| 4 | `re_token_event` keeps a compiled-in window instead of the frame's `windowMs` | `the configured window, not the compiled-in default: 60000 !== 45000` | 3, 9 |
| 5 | `send_action` names a contest that is not the open one | `Timed out: the rejection reaches the feed` | 5 |
| 6 | `worker.mjs` passes a generic label where the desktop's own id belongs | `naming the desktop the supervisor listed: 'desktop' !== 'dee989ca-…'` | 5 |
| 7 | `worker.mjs` stops pushing the ledger after a desktop gesture | `and the segment goes back to the holder not reached` | 5, 9 |
| 8 | a rejection records no cooldown | `the desktop's rejection cost the contester a cooldown on the real ledger: 200 !== 409` | 3, 5 |
| 9 | a grant at the desktop is attributed `by: {kind:'deadline'}` | `Timed out: the grant reaches the feed` | 5 |
| 10 | a revoke is announced as `token.released` | `Timed out: the revoke reaches the feed` | 5 |
| 11 | each worker owns its own ledger directory rather than the runtime's one | `the worker that replaced it serves the same holder: undefined !== '7486db3b-…'` | 7 |
| 12 | a worker announces no generation of its own when it starts serving | `the replacement announced its own generation …: [] !== ['workspace.updated']` | 6, 7 |
| 13 | `re_token_recording` misspells the event (`start`) | `Timed out: the start reaches the feed` | 6 |
| 14 | an explicit commit mints a fresh id instead of the one the start announced | `the start and the commit name one directory: '…3519Z-285506' !== '…3518Z-2851be'` | 6 |
| 15 | `worker.mjs` maps every `recording` frame onto `capture.started` | `Timed out: the commit reaches the feed` | 6 |

Two assertions had to be shaped before they discriminated:

- **The popover press toggles.** Stage 3's fixture pressed the segment once and drove four gestures;
  here the popover is still open from the previous gesture, and a second press closes it. The first
  run failed with `the popover opens again after the reconnection not reached` — a red about the
  test, not about the code. Every gesture now goes through `popover(gui)`, which presses only when
  the overlay is not already the token's.
- **The supervisor opens the project's dashboard beside the game**, and the dashboard takes the
  pane, so the recorder's controls — which belong to the visible game view — were not drawn at all.
  The second case selects the game tab first. Stage 3's `nativeClient` never had a dashboard beside
  it, which is exactly the kind of difference a stand-in hides.

## What the check found: two workers, one ledger

The fifth thing asked of this fixture was criterion 7 *seen from the desktop*: replace the workspace
layer mid-contest and watch the desktop re-register onto the new worker. **It does not.** Measured
on `a12d582`, through the real supervisor, with a desktop attached and `layers: ['workspace']`:

```
retiring: [{"pid":16359,"streams":1,"requests":0}]
current worker serves : 1:workspace.updated 2:token.claimed 3:workspace.updated 4:game.started 5:game.ended
the file on disk holds: 1:workspace.updated 2:token.claimed 3:game.started 4:game.ended
agree: false
```

The desktop's `/events` socket is tunnelled to the worker that was current when it connected.
`supervisor.mjs`'s `retire()` refuses to close a worker while `worker.streams` is non-zero, and an
attached desktop is exactly such a stream — so after a workspace-only replacement **two workers own
one ledger**:

- the desktop reads and writes the retired one (its segment showed `Contest · codex · 58s` for a
  contest the current worker had already rejected; the person's Reject, Grant, Revoke and Free land
  on a ledger no agent reads);
- both workers stay subscribed to the retained host's `/events`, so both mint feed frames into the
  same `tokens/<rootId>/feed.json`, and the sequence numbers **collide**: the run above has
  `game.started` at sequence 4 in the worker that serves the feed and at sequence 3 in the file a
  third worker would load. A monitor resuming from a cursor after a restart would replay the wrong
  frames.

This is not a stage-2 or stage-3 defect — each half is correct against its own contract. It is where
**spec 095 and spec 065 meet**. Spec 065 is explicit:

> Existing streams may finish through the previous worker; do not retry non-idempotent requests or
> interrupt PTY input merely to unload code. Retire a worker only when its requests and views have
> drained.

Spec 095 then put a *stateful* service — the ledger, its timers and its feed — on that same stream.

**The obvious fix was tried and is refused by 065.** Making `retire()` destroy the replaced worker's
tunnelled sockets (so the desktop reconnects onto the current worker, re-registers and is pushed the
ledger there) makes the whole end-to-end scenario pass — and turns
`orchestrator/tests/runtime.test.mjs:91`, *"layered workspace and MCP replacement retain a legacy
host and active PTY streams"*, red at `0 !== 1`: it asserts the retired worker is still there and
the client's socket is still `OPEN` across the replacement. Both reds were observed in one run and
the change was reverted. Choosing between them is an owner decision, recorded as **KI-061**.

What the spec here asserts instead is the half that is true and wanted: the worker that replaced the
old one serves the same holder, the same open contest, the same absolute deadline and the same
window preference, its feed continues rather than rewinding, and it announces its own generation on
it. And it asserts spec 065's rule itself — `workspace.retiring.length === 1`, *because* the
desktop's stream finishes through the replaced worker — so the reason the desktop half is missing is
in the fixture rather than only in this file.

## Commands

`npm test` 107/107 · `npm run test:desktop` 45/45 (43 before this spec's two) · `ctest` in
`.cache/desktop` 6/6 · `python3 tools/features.py validate` 43 features ·
`python3 tools/design.py check` clean. The sidecar `check` reports pre-existing drift on 25 files
this lane never touched (`native/*.c`, `server/formats.mjs`, `templates/project/editor.sh`, …),
which is KI-052's pattern and not repaired here.
