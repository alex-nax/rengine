# PTY sessions outlive their host (F177 / F151b)

Date: 2026-09-13. Status: **F177 passing** (evidence `docs/evidence/pty-retention-f177-2026-09-13.md`); F178 owes the swap. Spec 129's F151 row, split by KI-096; the
decision this document records is charter **D60**.

## The question specs 059/060 left open

Spec 059 promises that a desktop reattaches its retained terminal IDs after transport loss, and
says plainly that *"a replaced service identity/address still needs explicit launcher
reconnection."* Spec 060 promises scrollback rebuilt from the service's retained raw output after
a GUI restart. Neither says a session survives the **host** being replaced — and today it does
not: `orchestrator/launcher/replace.mjs` lists the running sessions it is about to end, by name,
because the PTYs are file descriptors inside the session-host process.

That is why this repository carries a standing rule that the owner's session host is never
restarted without their say-so. The rule exists to protect agent panes from a process boundary.

F176 moved the PTYs into `red-pty-serve`, a separate process. Once they are in a separate process,
where that process's lifetime is anchored becomes a real choice rather than an inherited fact.

## The decision

> "Per-state-dir service, survives host replacement" — owner, 2026-09-13.

`red-pty-serve` becomes **long-lived per state directory**. A session host does not own it; it
finds it. Replacing the host — including every remaining row of the J0 epic, each of which
replaces the host to prove itself — leaves the PTYs running and the agent CLIs inside them alive.

The alternative on the table was keeping it a per-host child, which preserves today's semantics
exactly and reaches a node-free stack one tick sooner. It was rejected because the cost is paid
once and the benefit is collected by every later row: F152–F163 each replace the host, and a
dogfood loop that ends the owner's agent panes on every iteration is a loop nobody runs.

## The shape, and why each part is the boring choice

**Loopback TCP with a token in a state-directory descriptor**, not a Unix socket. `sidecar.json`
already establishes this discipline for the session host: `{url, token, instance, pid}` written
0600 through tmp+rename, validated on read for `http:`, `127.0.0.1` and a 64-hex token, with
liveness checked by PID and identity confirmed against the process itself. `pty.json` is the same
document for the same reason, and it works on Windows, which `AF_UNIX` in Rust's standard library
does not.

**The same newline-delimited JSON-RPC** the stdio mode speaks (F174's channel shape), preceded by
one `attach` handshake carrying the token and the protocol number. stdio mode stays exactly as it
is: the scenario harness uses it, and a service with no descriptor to write is the right thing for
a test that wants one PTY and no state directory.

**Events broadcast to every attached client.** The host is normally the only one, but during a
replacement two hosts briefly overlap, and the honest answer to "who gets the output" is "whoever
is listening" — the session's scrollback is authoritative and every attacher rebuilds from a
snapshot anyway.

**Adoption is discovery, not handover.** A starting host reads the descriptor, validates it, and
attaches; `list` answers with the live sessions and their PIDs, and the host rebuilds its view
from snapshots — the same path spec 059 already takes after transport loss. There is no state to
transfer, so there is no transfer to get wrong.

**A protocol mismatch is refused by name and falls back to today's behavior.** A host that needs a
protocol the running service does not speak does not silently adopt it and does not strand it: it
says which protocol each side speaks, ends that service, and starts its own — which ends those
sessions exactly as a host replacement does today. Version skew is rare; silence about it is not
acceptable, and stranding a process holding live PTYs is worse than ending them.

**One service per state directory**, through the same `startup.lock` + stale-owner reap that
`ensureSidecar` uses. Two hosts racing to start one get one service.

**An idle service reaps itself.** With no sessions and no attached client for
`RED_PTY_IDLE_SECONDS` (default 600), it removes its descriptor and exits. A service holding
sessions never reaps, however long nobody is listening — that is the entire point of it.

## What the tests have to show

1. A session spawned through one client survives that client's death: a second client attaches to
   the same service and finds the same session id, the same child PID and the same scrollback, and
   input typed after the reattach reaches the same shell.
2. The token is load-bearing: a client that attaches with the wrong one is refused by name and
   learns nothing about the sessions.
3. Two clients racing produce one service, not two.
4. A protocol mismatch is named, the old service ends, and the new one serves.
5. Idle reaping removes the descriptor and the process — and a service with a live session does
   not reap.

Each observed failing for its own reason before it is believed, per the repository's regression
rule.

## What this does not change

**F179 made it real** (2026-09-13). A pane's own record — root, type, agent, conversation, title —
travels with its PTY as a `meta` value the service carries and never reads, and a host started as
its own process on a state directory attaches to that directory's service and **adopts** what it
holds. A host embedded in a test keeps owning its PTYs unless it asks otherwise, because a suite
that left a service holding a shell per test would leak processes no test asked for.

`replace.mjs` leaves the service running — it is a child in `ps` only because the parent that
started it has not exited — names it in its report, and says the sessions were *handed to the next
host* rather than ended. That last clause **supersedes F94's criterion 4** ("roots persist and
sessions do not"), with charter D60 as the recorded reason; everything else F94 proved is untouched.

What deliberately does not travel: handoff gates and recovery drafts, which belong to the launch
that made them. A session whose record a host cannot read is left running and unadopted rather than
stopped — tidying a list is not a reason to end an agent's work.

## The record becomes live (charter D62, 2026-09-13)

The clause above — "handoff gates do not travel" — was a consequence of the record being a *photo*
rather than a *record*: `meta` was written once at spawn and never updated, so a gate carried in it
could never be released and the pane would refuse input forever. That was the right call while one
host at a time read a directory.

F189 made two hosts read one directory, and then it was wrong. A front door answering `/api/input`
from a spawn-time photo refuses a pane whose gate the host serving the socket has already released,
and lets input into one that is still waiting for its native view (KI-104). So:

- red-pty gains **`describe(id, patch)`** — merge into the record, broadcast the pane, `null`
  removes a key because a pane that cannot forget a conversation would offer to resume the wrong
  one. The wire protocol number goes to **2**; a service on the other number is ended by name and a
  new one starts, which is what the number has always been for.
- A **spawn is announced** like an exit. A pane the service is holding that no host has described
  is still a pane every attached host must know about; before this, a second host answered
  `Unknown session.` about a session running in front of the person.
- The gate travels now, and adoption keeps its old behavior **explicitly**: the host that adopts a
  gated pane releases it and writes that down, because the native view it was waiting for went with
  the host that died. What used to happen implicitly, by the photo always saying `released: true`,
  is now a decision with a name.
- `sessions-client.mjs` writes the record through on every change and applies the changes other
  hosts make; it never answers a broadcast with a write.

The record is still the *host's* knowledge, not the service's opinion: red-pty stores and forwards
it and reads nothing in it, exactly as before. What changed is who may write, and when.
