# The token ledger, the gates and the feed — sabotage record, 2026-09-07

Stage 2 of [spec 095](../specs/095-project-token.md): the ledger and the contest in the workspace
worker, the gates on the agent-originated routes, the lifecycle feed, and the `token_*`/`feed_*`
tools. Twenty sabotages, each broken in the specific way one assertion claims to catch, observed
red for that assertion and not an earlier one, then restored. `orchestrator/tests/project-token.test.mjs`,
run with `node --test --test-name-pattern …`; the working tree was verified clean after every restore.

| # | Broken | Assertion that went red | Criterion |
| --- | --- | --- | --- |
| 1 | The worker's `gate()` computes the refusal and does not throw it | `game is refused with 409, not 200` | 2 |
| 2 | `gate()` gives a request with no `X-Rengine-Agent` header a fabricated identity | `the desktop sends no identity header and is never gated: The project token is held by claude …` | 2 |
| 3 | `Ledger.window()` returns `DEFAULT_WINDOW_MS` instead of reading the preference | `the window is the configured length, not 59999ms` | 3 |
| 4 | A rejection records no cooldown | `a rejected contester cannot contest again until its cooldown ends` | 3 |
| 5 | `settle()` never transfers at the deadline | `Timed out: the token transfers at the deadline` | 3 |
| 6 | The transfer is attributed to the contester rather than the deadline | `the transfer is attributed to the deadline, not to either agent` | 3 |
| 7 | `gone()` reports every holder alive | `no window is opened against a holder that is gone` | 4 |
| 8 | A desktop act is attributed `by: {kind:'agent'}` | `each desktop act is one frame attributed to the desktop` | 5 |
| 9 | The desktop's `recording` frame is forwarded to the host instead of intercepted | `Timed out: the commit reaches the feed` | 5 |
| 10 | The host stream turns `output` frames into feed frames (and `output` is added to the feed's type set) | `no output frame reached the feed` | 6 |
| 11 | `Feed.after()` ignores the cursor | `a monitor opened with after=N receives every retained frame after N and no earlier one` | 6 |
| 12 | A reloaded contest's deadline is rewritten to `now + window` | `with the same absolute deadline, not a restarted countdown` | 7 |
| 13 | `Feed.load()` restarts the sequence at zero | `the feed cursor continues rather than rewinding` | 7 |
| 14 | `agentToken: 1` is added unconditionally, the way every other flag in `capabilities()` is | `the capability is absent, not merely unused` | 8 |
| 15 | The tool worker stops checking `capabilities.agentToken` before calling | `launch_game against an older worker is refused` | 8 |
| 16 | The worker's `/api/stop` interception is removed, so the call falls through `forward()` | `stop is refused with 409, not 200` | 2 |
| 17 | The worker's `/api/update-workspace` interception is removed | `update-workspace is refused with 409, not 404` | 2 |
| 18 | A registering desktop is not pushed the ledger, only the next transition is | `Timed out: the desktop is pushed the ledger the moment it registers, with nothing yet to report` | 5, pinned frame 1 |
| 19 | The pushed frame carries the agent-facing status object instead of the pinned flat shape | `and the frame is the pinned flat shape, not the agent-facing status object` | 5, pinned frame 1 |
| 20 | `reject` and `grant` stop requiring the contest id the pinned frame carries | `The input did not match the regular expression /Name the contest to reject/` | 5, pinned frame 2 |

## Three assertions the pass had to fix before they discriminated

- **Case 2** first went red inside a setup line — `ok(worker, 'dashboard-run', …)` throwing `409` — which
  is the right *reason* wearing no name. The desktop call is now made with `api()` and asserted
  directly, so the defect it catches ("the desktop was gated") is what the report says.
- **Case 4** went red on a bare `Expected values to be strictly equal`. The status assertion carries
  its sentence now.
- **Case 18 first went GREEN.** The register push was asserted after the first `token_contest`, by
  which time a transition had pushed the same frame anyway, so removing the register push changed
  nothing the test looked at. The assertion moved to immediately after `desktop-register`, before
  anything has happened on the root, and the sabotage then reddened it — which is also the defect
  that matters: a freshly opened window would sit with an empty segment until somebody else acted.

## What the fixtures had to be shaped like to discriminate

- **The "no PTY output" proof is measured against a socket that is carrying that output.** The test
  opens the worker's `/events` stream at the same time as the feed and asserts, in the same run,
  that `CHATTY_LINE` appears on `/events` and appears nowhere in the feed's frames. Without that
  control the assertion would pass on a machine where the session simply never ran, which is case 3
  of `blind-regressions-2026-09-06.md` in the other direction. Sabotage 10 has to widen the feed's
  own type allowlist as well as add the producer, because `Feed.emit` refuses a frame type it does
  not know — the structural half of the guarantee.
- **Criterion 7 replaces the worker for real.** The first worker is closed, a second `startWorker` is
  given the same runtime directory, and the assertions are made against the second one: the holder,
  the contest id, the *absolute* deadline string, and a feed sequence that continues rather than
  restarting. The `token.json` on disk is read at the end, so the proof is the file a third worker
  would load, not the second worker's memory.
- **Criterion 8 needs a worker that genuinely cannot serve the ledger**, not a stubbed capability: the
  fixture starts one whose runtime directory is a regular file, so `Tokens.open` fails for a reason
  the code has no branch for, and the capability is absent because the ledger is absent.
- **`stop_session` in the tool-worker test names a real session.** A bogus id is refused by the
  ownership check before the gate is reached, which would have proved nothing about the gate.
- **The launch attribution needed a queue, not a map keyed by session id.** The host emits the
  `session` event before `/api/game` returns, so the frame is built before the worker knows the id
  it would key on; the first assertion of `by: {kind:'agent'}` failed with `{kind:'workspace'}` for
  exactly that reason. Each launch now queues its asker on the root and the frame takes the oldest
  fresh entry, with a launch coalesced onto a session that already existed taking its entry back.

## Facts the code corrected in the spec

- **The host's preference store allowlists its keys.** `store.preferences()` destructures the keys it
  knows and silently drops the rest, so a `tokenWindowMs` forwarded to it would never be persisted
  and the window would always be the default. The worker keeps that one preference beside the
  ledgers, intercepts `POST /api/preferences` to split it off, forwards the rest unchanged, and
  merges it back into `/api/state`. No host change, and the window is settable.
- **Two of the seven gated routes never reach the worker.** The runtime supervisor answers
  `/api/update-workspace` and `/api/desktop-action` itself and forwards everything else, so their
  gate is read from the ledger by the tool worker before the call. The worker gates them too, for
  the case where it is addressed directly.
- **The feed socket is the worker's own URL.** The supervisor's upgrade handler allowlists `/events`
  and `/surface`, so a `/feed` upgrade through it is refused; `feed_url` therefore hands back the
  worker's own loopback URL and capability — the same one the caller is already reaching through —
  and a monitor re-reads it after a workspace replacement.
- **Liveness is pid, uniformly.** `scripts/agent.sh` execs the launcher, so a pane-spawned agent's
  `process.pid` is the pty session's, and `bind.mjs` already records `process.ppid`, the terminal
  that will run the CLI. Both are a process that exists exactly while the agent does, so no
  `boundBy` discriminator was needed.
