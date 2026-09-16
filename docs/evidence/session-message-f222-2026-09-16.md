# F222 — saying one line to a pane that is already running

Date: 2026-09-16 (macos). Spec: [148](../specs/148-session-message.md). Branch: `feat/session-message`
off `agent-prompt-delivery` at `93a9a0d`.

## The recorded decision, and how it was read

Spec 139 decision 6 and F205 say *"It never types into a pane"*. The evidence for reading that as a
scoping rule rather than a general principle, gathered before any code was written:

| What was checked | Where | What it says |
|---|---|---|
| The decision's subject | `docs/specs/139-local-model-agent.md:69` | The row is *"Delegation is the existing gesture"* in a spec titled *"a local model in the editor"*, attributed *"Spec 103 applied"* — spec 103 is the task/spawn surface, not a rule about the PTY. |
| The feature row's subject | `features.json` F205 | *"**the local agent** files a task and spawns a chosen CLI agent on it … **It** never types into a pane"*, criterion *"No input route call is made by **the loop**"*. The actor is named twice before the sentence. |
| Whether the workspace already types | `red/red-pty/src/lib.rs`, F221 `passes: true` at `93a9a0d` | It does, as of this branch's own parent. A general reading would put the tree in breach of its own decision. |
| Where the rule IS general | `docs/specs/069-project-window-dogfooding.md:22,30`; `docs/architecture.md:35` | The supervisor control pipe and the cross-root integration inbox. Both untouched; `integration_inbox` is not a turn and nothing composes a relay from one. |
| Whether F205 stays satisfiable | spec 148 decision 10 | `session_message` is excluded from the local agent's tool set by default, so the route trace still shows no input-route call. F205's row is not amended. |

## What was verified rather than taken on trust

Each of these was read out of the source on this branch before it was built on:

- `POST /api/input` and `deliver_input` exist and are the door's (`red-host/src/routes.rs`,
  `panes.rs`) — **verified**.
- `SeedWatch` is `pub`, terminal-free, and its decision is separable (`red-pty/src/lib.rs:210-306`)
  — **verified**, and reused as the decision rather than reimplemented.
- **Driving `SeedWatch` from HTTP polls is "plumbing"** — *verified and rejected*. `red-mcp` cannot
  write to a pane at all: only the process holding the master fd can, and nothing in `red/` passes
  descriptors. Polling would split the watching from the writing across two processes and put a
  second copy of the decision where it could drift. The service's own read pump already **is** the
  watcher's eyes.
- **A synchronous PTY verb was checked and rejected**: `red_pty_serve.rs` takes one lock around the
  whole dispatch, so a verb that waited for an echo would freeze every pane in the workspace.
- `session_of` scopes a pane to the bound project (`red-mcp/src/tools.rs:64-71`) — **verified**.
- The worker's `Names::Session` gate resolves a pane's project from the pane's own record — **verified**.
- **Not verified, and changed because of it**: `SeedWatch::new` refuses to type into a pane that has
  said nothing, which is right for a spawn and wrong for a pane that has been quiet for an hour.
  `SeedWatch::listening` takes the last-output time from the caller (spec 146 decision 9's own rule)
  and the pane is typed into at once.
- **Not verified, and reported as a limit**: kimi's composer echo was measured by spec 146 against
  **0.42.0** at a *fresh* composer. A composer mid-conversation was not measured, because measuring
  it means typing into a live conversation.
- **`claude`'s message capability was NOT measured**, so it declares none and is refused by name.

## Sabotages — each observed failing for its own reason, with a rebuild in between (KI-120)

`cargo build --bins` between every sabotage and its run; the harness script is
`sabotage.sh <file> <patch> <test-name-pattern>`. Ten staged, and one found rather than staged.

| # | Sabotage | Red |
|---|---|---|
| 1 | `SeedWatch::step` submits without matching the echo | `a line the pane never echoes is left unsubmitted` |
| 2 | `grants::check` always answers armed | `the project token does not arm a relay` |
| 3 | `one_printable_line` stops looking for control bytes | `a message is one printable line` |
| 4 | `message::delivery` falls back to `paste` for an undeclared CLI | `a pane whose CLI has not declared how it takes a message` |
| 5 | the last-input rule removed from `PtyHost::message` | `a pane that is talking and a pane somebody is using` |
| 6 | the grant spent BEFORE the line is typed rather than after | same test, on `4 !== 5` — the refusal that typed nothing cost the owner one |

| 7 | the door's capability key republished as the tool's | `the_ledgers_three_are_advertised_together_or_not_at_all`, on *"the door's route is not a tool's promise"* |
| 8 | the relay watcher given the spawn's three attempts back | `an_unechoed_message_is_tried_once_and_never_submitted`, on `3 !== 1` |
| 9 | `SeedWatch::listening` waits for a first byte, as a spawn's does | `a_message_to_a_pane_that_fell_silent_long_ago_is_typed_at_the_first_look`, on `Wait` where a paste was due |
| 10 | the grant action's confirm replaced with `true` | `a grant names one pane…`, on *"Missing expected rejection: a confirm nobody can answer is refused, not bypassed"* |

Sabotage 7 is the one that came from asking an adversarial question rather than from a criterion:
**what happens when there is no worker?** `red-mcp` falls back to the session host, which has the
route that types. If the door had advertised the tool's own capability, a pane in a worker-less
workspace would have relayed with no gate, no grant and no feed frame. So the door declares
`sessionMessageRoute` and the worker alone turns it into `sessionMessage`. `launch_game` shares the
shape and is not changed here; the spec says why the two may be read differently.

**An eighth was found rather than staged**, and it is the one worth keeping: the feed's frame-type
list is an allowlist (`red-token/src/feed.rs`), and `note()` swallowed the ledger's refusal with
`.ok()?`. So the first green route answered `delivered: true` while its audit frame silently went
nowhere. The frame type is declared now, and `note()` says out loud when the feed refuses one —
otherwise the next feature to add a frame type ships the same silence.

## Gates

| Gate | Baseline at `93a9a0d` | After |
|---|---|---|
| `cargo test --workspace` | 360 passed, 0 failed | 375 passed, 0 failed |
| `npm test` | 366 tests, 364 pass, 2 named failures | 374 tests, 373 pass, 1 fail — KI-127's, and no other |
| `./init.sh` | green | green |
| `tools/agent_names.py check` | 5 declared, 5 exceptions | unchanged — no new exception |
| `tools/design.py check` | green | green |

The `npm test` baseline was measured at the merge base rather than assumed, and it is one real
failure plus load-sensitive flakes:

- **Real and pre-existing**: `red-agents-launch.test.mjs` — **KI-127**: `agents-fixtures.json`
  freezes eleven `/Users/alex/rengine/...` paths, so it cannot pass from a checkout at
  `third_party/rengine`.
- **Flaky under load**, in both directions across three full runs: `games.test.mjs:144` (*declared
  games launch in their own window*, `Unknown session.` from the fixture's pane mirror) failed at the
  merge base and passed afterwards; `external-declaration.test.mjs:114` (*launcher refuses a legacy
  host*) passed at the merge base and hit its 30 s timeout once. Both pass when run without a
  concurrent build. Neither is touched by anything here.

One real regression was caught by the suite and fixed: the frozen MCP conversation record carries the
capability list the JS worker answered with, and `sessionMessage` is not in it. The record may not be
regenerated, so `mcp-conversation.mjs` now drops capabilities **declared since the capture** from both
sides, in one declared list with the row that added each — `red_agents::declared_since`'s shape, for
the same reason.

## What remains unproven, and can only be settled at a live pane

1. **That a bracketed paste lands in a real running composer mid-conversation.** Every pane in the
   spec is this suite's own fake TUI, which behaves as spec 146 measured the real one. The running
   pane that prompted this work reports **0.42.0** while the installed binary is **0.43.1**.
2. **What `claude`'s composer does with a paste.** Unmeasured, therefore undeclared, therefore
   refused. Measuring it is one short session at a throwaway pane.
3. **The residual hazard in spec 148**: a composer holding somebody's abandoned half-written line,
   older than the 60-second input window, is appended to rather than replaced. There is no way to
   read a composer through a PTY and the one way to clear it is a control byte, which is refused.
