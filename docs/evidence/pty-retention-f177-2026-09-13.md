# F177 (F151b) — the PTYs stop belonging to the host (2026-09-13)

Spec 131, charter D60, KI-096. The decision was the owner's, taken before anything was built:

> "Per-state-dir service, survives host replacement" — owner, 2026-09-13, choosing between that
> and a per-host child that preserves today's semantics and reaches a node-free stack one tick
> sooner.

What it buys is not abstract. `orchestrator/launcher/replace.mjs` prints the running sessions it is
about to end, by name, every time the host is replaced — and every remaining row of the J0 epic
(F152–F163) replaces the host to prove itself. This row is the difference between a dogfood loop
that costs the owner their agent panes each iteration and one that does not.

## What was built

`red-pty-serve` keeps its stdio mode unchanged and gains `--state DIR`: loopback listener,
`pty.json` written 0600 through tmp+rename, one `attach` handshake carrying the token and the
protocol, then the same newline-delimited JSON-RPC. `orchestrator/server/pty-client.mjs` gains
`PtyHost.attach(stateDir)` beside `PtyHost.open()` — the descriptor read and refused the way
`discoverSidecar` refuses a sidecar's, a `pty-startup.lock` whose stale owner is reaped by PID, and
a detached spawn whose stderr lands in `pty-serve.log`.

Adoption is discovery, not handover: `attach` answers with the live session list, and the host
rebuilds from snapshots — the path spec 059 already takes after transport loss. There is no state
to transfer, so there is no transfer to get wrong.

## The five claims, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| `attach` falls back to the F176 stdio child (the per-host shape) | `the host's PTYs live in a service of their own (null), and it outlives the host` |
| the service accepts any attach token | `a wrong token is refused, never served: {…"sessions":[{…"pid":10887…}]}` |
| commands are served before any attach | `a list before any attach is refused: [{…"pid":11109…}]` |
| the client adopts a descriptor whose protocol differs | `a service this host cannot read is not adopted` |
| the reaper ignores whether it holds sessions | `a service holding a session waits however long nobody is listening` |
| the reaper never exits | `a service with no sessions and no client reaps itself (PID 15173 was still running after 8s)` |

The first one is the interesting one twice over. Its first form **failed for the wrong reason** —
the test read `pty.json` to learn the service's PID, and with the stdio shape there is no
descriptor at all, so it died on `ENOENT` before reaching its own claim. The test now learns the
service PID from the client it is testing (`pty.service.pid`, reported by the host process it
kills), so the sabotage fails on the sentence it is there to defend.

## The control that masked the thing under test, again

"Two hosts racing get one service" is defended twice: the client's `pty-startup.lock` and the
service's own `already_serving` refusal. Sabotaging **either one alone left the test green** —
each guard is sufficient on its own, which is the point of defense in depth and also exactly how a
vacuous test hides. Two things came out of chasing it:

- The assertion was comparing what the two clients *found*, which is the same service even when two
  are running, because the loser of the descriptor write is invisible to every reader of the file
  while still holding a port and a PTY. It now counts `red-pty-serve --state <dir>` processes in
  the process table.
- With both guards removed, that assertion goes red. With either one present it is green, and that
  is recorded here rather than presented as a single-sabotage proof.

This is the sixth case of the pattern `docs/evidence/blind-regressions-2026-09-06.md` collects.

## A hang the tests found in the client

A host whose service has died still has to close. `close()` awaited `socket.once('close')`
unconditionally, so a socket that had already closed — the service killed out from under it —
waited for an event that had already fired, with nothing ref'd left to wake it. Node's test runner
reports that as *"Promise resolution is still pending but the event loop has already resolved"*,
which names the symptom and not the cause; the cause was one missing `destroyed` check.

## Gates

`npm test` — **308 of 308** (303 before this row, five added). `cargo build -p red-pty` clean.
`python3 tools/features.py validate` — 130 features.

## What is deliberately not here

- **The swap.** `server/sessions.mjs` still owns the PTYs the desktop actually uses; F178 moves it
  onto this client and deletes it. Nothing in a running workspace changed today, and the standing
  rule about the owner's session host stays until F178 puts this in front of real panes.
- **Forgetting a session.** The service keeps exited sessions' scrollback forever, exactly as the
  JS host keeps them for as long as it lives. That parity is deliberate, but the JS host's "forever"
  ended when the host did, and this one's does not. F178 inherits the question of who prunes.
- **Windows.** The descriptor and the loopback transport were chosen to be portable, and
  `already_serving` asks the port rather than the PID for that reason. It is untested there, like
  the rest of the session path (`replace.mjs` refuses Windows outright).
