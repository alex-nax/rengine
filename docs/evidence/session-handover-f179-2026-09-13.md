# F179 — a replaced host adopts the panes the state directory still holds (2026-09-13)

Charter D60, KI-096. F177 proved the PTYs outlive a host; F178 deliberately did **not** use that,
because a session the next host cannot *name* is an orphan rather than a retained pane. This row
closes the gap: the pane's own record travels with its PTY, and a starting host adopts what the
directory's service is holding.

## What travels, and what deliberately does not

`red-pty` sessions carry a `meta` value the service never reads — the host's own record of the pane:
its root, type, agent, conversation, title and whether the title was chosen or composed. The
service has no opinion about what a session means; it carries the note so the next host can read it.

Handoff gates and recovery drafts are **not** in it. They belong to the launch that created them,
and a new host inheriting a half-finished handoff would be inheriting a promise it cannot keep. A
session whose record this host cannot read is left running and unadopted rather than stopped:
stopping it to tidy a list would end an agent's work.

## The switch, and why it is a switch

`startServer({ retainSessions })`. A host that **owns** a state directory — the process a person or
a launcher starts — attaches to that directory's PTY service, so replacing it leaves the agent CLIs
alive. A host embedded in a test passes nothing and keeps the old behaviour, because a suite that
left a service holding a shell per test would leak processes no test asked for. `server/main.mjs`'s
own `--state` path is the one that sets it.

## F94's criterion 4 is superseded in one clause, and this says so

F94 records: *"roots persist and sessions do not, and the report names … each ended running
session"*. That was true when the PTYs were file descriptors inside the host. The owner's decision
(D60, 2026-09-13: *"Per-state-dir service, survives host replacement"*) replaces it, for the reason
the decision was taken — a replacement should not cost the owner their agent panes.

So `replace-host.test.mjs` now asserts that the new host **adopts** the pane, with the same child
process, and `replace.mjs` prints `handed N running session(s) to the next host` where it printed
`ended N running session(s)`. The clause is recorded as superseded rather than quietly rewritten,
and F94's own evidence is unchanged: everything else it proved still holds.

## The service is not the host's to end

`replace.mjs` stops the host's children. The PTY service is a child in `ps` only because the parent
that started it has not exited yet — it is detached and belongs to the directory. It is now excluded
**by the descriptor it published**, not by its command line, and the report says what it left
running and why.

Finding that took a bug of its own: `servicePid` caught every error and returned "there is no
service", so a `ReferenceError` inside it read as "nothing to retain" and the service was stopped
anyway. Only a missing or torn descriptor is "no service" now; anything else is raised.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the new host adopts nothing | `the new host lists the pane it did not start: []` |
| the host does not retain (`retainSessions: false`) | `and the shell it started is not` — the pane dies with its host |
| `replace.mjs` stops the PTY service with the other children | the replacement test's adoption fails |

## The test is a real handover

`session-handover.test.mjs` starts a host **as its own process**, opens a pane, types into it,
**SIGKILLs the host**, and starts another. The second host lists the pane it did not start, with the
same child PID, the title the first host gave it and the project it was bound to — and typing into
it reaches the same shell, with the scrollback from before the handover still there. A host asked
politely to go away is not the case anybody worries about.

## Gates

`npm test` — **318 of 318**. `cargo test -p red-pty` clean.

## What this unblocks

F151 can close (its criterion 2 — a retained session surviving the host's restart — is now used
rather than only built), and F152 stops waiting on it.
