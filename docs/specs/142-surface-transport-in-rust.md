# Spec 142 — the last route off the JS host: the game surface in Rust

Owner goal, 2026-09-15: *"proceed with js retirement in favour of rust"* (charter D57, spec 129).

Status: **done.** The wire format, the transport, the launch decisions and the cutover all landed.
`games.mjs`, `surfaces.mjs` and `surface-protocol.mjs` are deleted, and **the JS host has no route
the door does not own** — all eleven it still answers are intercepted.

## Why this row, and why now

`red-host` owns **32 routes**. The JS host uniquely serves **one**: `POST /api/game`, plus the
`/surface` WebSocket. Everything else it answers is a copy the door already intercepts.

That makes this the row KI-102 named — *"the four modules are deleted by the row that moves the last
of those"*. When the game launch and its surface move, `server/main.mjs`, `games.mjs`,
`surfaces.mjs`, `surface-protocol.mjs` and `desktops.mjs` all become deletable together: **~600
lines, and the JS session host with them.**

The whole chain below `F152` is otherwise gated on `F186`, a dogfood run that needs a live pane of
each CLI in the owner's own workspace. That gate is real and is not code; this row is the code that
is ready either way, and it is what the gate opens onto.

## What moves

| piece | JS | what it is |
|---|---|---|
| the wire format | `surface-protocol.mjs` (43) | a 24-byte frame header, a streaming decoder, a 32-byte input packet with per-kind ranges |
| the transport | `surfaces.mjs` (99) | a loopback TCP listener taking one FRAME and one INPUT socket per reserved token, fanning frames to WebSocket viewers |
| the launch | `games.mjs` (90) | launch de-duplication per (root, game), the refusals, the embedded-vs-cooperative injection, reserve-then-spawn |

## Decisions

| # | Decision |
|---|---|
| 1 | **The wire format is ported first and proved byte-exact.** It is pure, it is what everything else is built on, and a corpus compared against both implementations is the same evidence shape `red-store` (F169) and `red-mcp` (F185) used. A frame this refuses and the JS accepts — or the reverse — is a divergence a game would meet as a corrupt picture. |
| 2 | **The decoder's refusals are part of the format.** `magic`, the 1..=1920 / 1..=1080 bounds, `bytes == width * height * 4` and `flags == 0` are each a refusal the JS makes, and each is kept with its own case in the corpus. A decoder that accepts more than the one it replaces is not a port. |
| 3 | **Focus eviction is preserved verbatim** (F189 criterion 2, `surfaces.mjs:72-76`): a focus-gain packet from a viewer that is not the owner releases the previous owner's input first and then takes ownership; a non-owner's input is dropped silently rather than refused. The eviction and the silence are both the semantic. |
| 4 | **One producer per channel.** A second FRAME or INPUT socket for a token is destroyed, not multiplexed — the token names one game, and two producers on one token is the failure `games.mjs`'s cooperative-injection note exists to prevent. |
| 5 | **The four modules are deleted by this row**, per KI-102, once `/api/game` and `/surface` are answered in Rust and the cooperative surface suite passes against the Rust door. |

## What the corpus caught, twice

**A divergence, on its first run.** The JavaScript refuses in two stages with two different
messages: the kind and the arity are *"Unsupported game input."*, and anything wrong with a VALUE —
including one that is not a whole number — is *"Game input is out of range."* The Rust judge
reported the first message for the second case. That is the whole reason the refusals are compared
and not only the acceptances.

**A blind case, under sabotage.** The first width and height cases wrote the field as a header
override and left the byte count saying what the ORIGINAL dimensions gave — so
`bytes != width * height * 4` refused them first and the dimension bound was never reached.
Dropping the width bound entirely left the suite green. The cases come in pairs now, and the second
of each pair builds the header from the bad dimension so its byte count agrees and only the bound
can refuse it. This is the control masking the thing under test, which
`docs/evidence/blind-regressions-2026-09-06.md` already has six of.

## What the cutover found

Two real bugs, both caught by specs that had to be migrated rather than deleted:

- **The reservation was never released.** `games.mjs` subscribed to session-exit events and removed
  the surface; the door did not, so a viewer could attach to an exited game forever. It releases on
  the pane event now, and closes the viewers with the JS host's own sentence.
- **The door read a pane's fields from the wrong level.** What rEngine composes lives under the
  service's `meta`; only the id and the state are the service's own. Reading `type` and `game` from
  the top meant *no* pane ever matched "already running", so every launch of a running game would
  have started a second one.

Both were found by pointing the existing specs at the door instead of rewriting them to suit it.

## Where the evidence moved

Seven specs asserted on the JS host's internals — `server.sessions.terminal` wrapped to capture a
composed environment, `server.games.surfaces.items.size` counted to prove a reservation. Neither
exists here any more, so each claim moved to where it can still be made:

| claim | now |
|---|---|
| no injection reaches a cooperative game | `games.rs::a_cooperative_game_is_handed_no_injection_and_an_embedded_one_is` — the composition's own test, and the ONLY place it can be made: macOS purges `DYLD_*` before a protected interpreter sees them, so a game reporting "no injection" cannot be told from one that was injected and purged |
| a surface is reserved / released | whether a viewer can attach, which is the consequence the reservation exists for |
| frame count, size, status | the status message a viewer is sent on attaching, which is the door's own account |
| an external game gets no surface | the fixture reports `surface=`, so the game says what it was handed |

That is a better set than the one it replaces: every row is an observable consequence rather than a
private field, and the one claim that genuinely needs composition-side capture is asserted where the
composition is, with four sabotages behind it.

## What is left

`server/main.mjs` is not deleted here, and KI-102 is why: it is the process a launcher starts and
the backend the door is pointed at, so retiring it is **F163** — entry points move off Node — not
this row. What this row did is empty it: the door owns every route it answers.



The three pieces above are the parts with decisions in them, and each is tested and
sabotage-verified on its own. What remains is wiring:

`desktops.mjs` also survives: `runtime/worker.mjs` still imports `Desktops`, so it retires with the
worker (F158). The two that could go, went.

## Evidence

- A corpus of frames and input events, each run through the JS implementation and the Rust one and
  compared byte for byte, refusals included: `tests/surface-protocol-parity.test.mjs`.
- The existing cooperative surface suite (`surface.test.mjs`, `native-game.spec.mjs`) passing
  against the Rust door once the transport moves.
- Each refusal observed failing for its own reason by sabotage, per the work protocol.
