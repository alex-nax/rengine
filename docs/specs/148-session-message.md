# Saying one line to a pane that is already running (F222)

Date: 2026-09-16. Status: recorded from an owner instruction, given after the capability was
exercised by hand:

> *"fix the flow so when I next want to do this we do not use any workarounds."*

What was done by hand: two `curl` calls to `POST /api/input` against a live agent pane — the first a
bracketed paste carrying a marker, the second a bare `\r`, with a person looking at the pane in
between to confirm the marker had echoed. It worked. It is also unscoped (any pane id in any project
on that host), unarmed, unaudited, refuses nothing, and pastes a 64-hex bearer token into shell
history.

Parent: [how a CLI is handed the brief a spawn carries](146-agent-prompt-delivery.md), whose
handshake this reuses; [the project token](095-project-token.md), whose arbitration it joins;
[the provider abstraction](141-provider-abstraction.md), whose rule it applies — shared code asks
the recipe what a CLI *can do* and never who it is.

## The recorded decision this has to answer first

`main` carries **spec 139 decision 6**, and **F205** makes it testable:

> *"Delegation is the existing gesture: hold the token, file the task, spawn the chosen CLI on it,
> watch `agent.spawned` and `task.updated` and the row. **It never types into a pane.**"*
> — 139, decision 6, attributed *"Spec 103 applied"*

> *"Delegation: **the local agent** files a task and spawns a chosen CLI agent on it through the
> existing task and spawn tools … **It** never types into a pane."* — F205, with the criterion
> *"No input route call is made by **the loop**, asserted by route trace."*

**Read as a general principle, that forbids this feature and the right answer is to build nothing.**
It is not read that way here, and the evidence is four facts rather than a preference:

1. **The sentence's subject is the loop, in both places.** Spec 139 is *"a local model in the
   editor"*; its decision 6 is the delegation *gesture* that loop uses, and F205's row names the
   local agent as the actor twice before the sentence. The criterion is scoped the same way — *the
   loop* makes no input-route call — which is a statement about one tool vtable, not about whether
   the capability may exist. `spawn_agent` and `stop_session` are heavier acts on a project than one
   typed line and both are offered, gated.
2. **The workspace already types into panes, and did so in this branch's own parent.** F221
   (`passes: true`, commit `93a9a0d`) has `red-pty` write a bracketed paste into a pane it just
   started and press Enter when the pane echoes it back (`red/red-pty/src/lib.rs:299-306`). A
   general reading of decision 6 would make the tree already in breach of its own decision, which is
   the strongest evidence that the general reading is not the one the tree holds.
3. **The one place the rule *is* general is a different channel, and is untouched.** Spec 069's
   contract — *"Control is a narrow supervisor-owned stdin pipe; it cannot type into panes"* and
   *"Reports are data, never instructions or injected PTY input"* — governs the **project-window
   supervisor pipe and the cross-root integration inbox**. That rule is right and stays: the inbox
   links an origin root to a project root, so relaxing it would let *another project's* report
   become an instruction in this one. Nothing here touches `integration_inbox`, and nothing composes
   a relay out of inbox content.
4. **So the live rule is not "the workspace never types"; it is "the workspace types only when
   something with authority asked it to."** Today the one asker is a spawn. This adds one more: an
   owner-armed message to a pane the workspace already owns. That is a step, which is why the step
   needs the owner's hand rather than an agent's judgement — hence decision 7.

**F205 stays satisfiable and is not amended.** `session_message` is excluded from the local agent's
tool set by default (decision 10), so its route trace still shows no input-route call. F205's row,
description and criteria are untouched.

## What is being built

One tool, `session_message(id, text)`, that types **one printable line** into a **retained agent pane
of the same project** and presses Enter **only** when the pane echoes the line's own token back.

```
session_message(id, text) → { delivered: true,  confirm, typed, grant: { remaining, expires } }
                          | { delivered: false, reason: "…", confirm, typed, grant: … }
                          | a refusal by name, with nothing typed
```

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **The message is a capability the recipe declares**, `[recipes.<cli>.message] kind`, and a CLI that declares none is refused by name with nothing typed. **Not `prompt.kind`**: that says how a CLI takes its *first* message *on a command line*. One CLI declares `argv` there, which is true of its command line and says nothing whatever about its running composer — conflating the two would type into CLIs nobody measured. | Spec 141's rule; spec 146 decision 1's shape |
| 2 | **Only `kind = "paste"` is implemented, and only one recipe declares it.** The recipe that does is the one spec 146 measured a composer echo on. Every other CLI — including the one this tool is usually called *from* — declares nothing and is refused, because measuring a running composer means typing into a live conversation and nobody has. A kind rEngine does not implement is refused at the route, as `prompt.kind`'s is. | Spec 146's measure-or-refuse discipline |
| 3 | **One line, printable, and control bytes are refused rather than stripped.** 1–400 characters, no C0, no C1, no DEL, no newline. Stripping would deliver a line the caller did not write while reporting success; refusing makes the caller fix it. The tool can therefore never send a bare Enter, a Ctrl-C or an arrow key: interrupting a pane stays `stop_session`'s job and the owner's keyboard. | KI-068 |
| 4 | **The handshake is spec 146's, run by the service that owns the PTY**, not driven from HTTP polls. `SeedWatch` stays the one decision — the two numbers that differ (attempts, deadline) become fields rather than constants, so there are two policies and not a second copy of the decision. What is new is a `message` verb that attaches one to a pane that is **already running**, and two facts the caller supplies that a spawn does not have: when the pane last spoke and when it was last typed into. | Spec 146 decision 9 |
| 5 | **One attempt, and a 15-second ceiling.** A spawn's seed retries three times inside 90 s because the pane it seeds may be sitting on a trust dialog it has to reach *through*. A relay has no such excuse: decision 6 refuses unless the pane is already quiet, which is the state the retries exist to wait for. One attempt also removes the only way a relay could paste its line twice. The Enter is structurally impossible more than ~5 s after the paste, which is the specific shape of KI-068's second half. | KI-068; spec 146 measurements 6 and 7 |
| 6 | **Two quiet preconditions, refused rather than waited out.** A pane that has produced output within **800 ms** is talking, and a pane that has been **typed into within 60 s** is somebody's — a person's half-written draft is exactly the composer a relay must not append to and submit. Both are refused by name; neither is retried into. | Spec 146 measurement 5 (there is no readiness marker to watch, so the handshake asks); this spec's own hazard, below |
| 7 | **The project token is necessary and not sufficient.** `session_message` joins the token-gated set — *"every tool that starts, stops, replaces or captures something the project owns"* — because submitting a turn in another agent's conversation is that class. But spec 095 decision 2 transfers the token to a contester on silence, so an agent can hold it without the owner ever acting. Relay therefore needs a **separate owner grant**: a dashboard action whose confirm prompt has no non-interactive bypass, naming **one pane**, bounded by **a count and a deadline**, both required. | Spec 095 decisions 2 and 4 |
| 8 | **The grant lives in the workspace state directory, not in the token ledger.** `<state>/message-grants.json`, 0600, written only by `red-launch message-grant`, read and spent by the worker. Beside the ledger is the tempting place and the wrong one: the ledger's whole semantics is *transfer* — contest, reject, release, take on silence — and a grant that lived there would inherit them. A grant is the owner's and transfers to nobody. | Recommended, stated because the alternative is the obvious one |
| 9 | **One feed frame per delivery, carrying the outcome.** `session.message` with the pane, the CLI, the confirm token, `delivered`, the remaining grant and **the character count, never the text**. The feed is this project's lifecycle record and "an agent submitted a turn in another agent's conversation" is a lifecycle event if anything is. PTY output never goes on the feed, and neither does the message body: what is auditable is that a relay happened, to which pane, by whom. | Spec 095 decision 7 |
| 10 | **Excluded from the local agent's tool set by default.** F204 and F205 are unbuilt, so there is no vtable to leave it out of yet; this is a requirement recorded here *for* them, so that when the loop is built its route trace still shows no input-route call and spec 139 decision 6 stays true of the thing it was written about. | This spec's own reconciliation |

## What a delivery does, in order

1. `session_message` scopes the pane with `session_of` — *"Session is not bound to this project."* —
   and refuses a pane that is not a running agent.
2. The worker resolves the pane's **own** project from its record (never the caller's claim), asks
   the ledger, and refuses a non-holder naming the holder and `token_contest`.
3. The text is judged: one printable line, 1–400 characters, refused rather than cleaned.
4. The worker asks the recipe for `message.kind` for the pane's CLI. None declared: refused by name;
   a kind rEngine does not implement is refused as such. Then it reads the grant — no grant for
   **this pane**, spent, or expired is refused by name, and the sentence says which of the three
   and how a grant is made.
5. The door composes `paste = "<text> [<confirm>]"` and hands the PTY service `{ paste, confirm }`
   with a fresh 8-hex confirm token. The token is **in the line**, so the receiving agent sees the
   marker too — which is what the owner was checking by eye.
6. The service refuses a pane that is talking, that was typed into recently, or that already has an
   unsettled handshake; otherwise it attaches a `SeedWatch` seeded with the pane's last-output time,
   so a pane that has been quiet for an hour is pasted into at once rather than waiting for a byte
   that is not coming. **This is the one behavioural difference from F221's watcher.**
7. The watcher pastes, and presses Enter only when the confirm token comes back through
   `normalised()`. No echo inside 4 s: one attempt is all there is, the record says `undelivered`,
   and **no Enter is ever sent**.
8. The grant is **checked** before step 5 and **spent** after it, so every refusal that typed
   nothing — including step 6's — leaves the owner's count where it was, and a line that went into
   somebody's composer costs one whether or not it was ever submitted.
9. The worker waits for the pane record to say which happened and mints the frame.

## The door's route and the tool's capability are two names on purpose

A workspace with no worker in front of its session host has a door that can type and nothing that
decides whether it may — no ledger to gate with, no state directory read for a grant, no feed to
record on. So the door declares **`sessionMessageRoute`**, which no tool checks, and the worker turns
it into **`sessionMessage`** only when it also serves a ledger. A pane whose calls fall back to the
bare host therefore reads no `sessionMessage` and is refused by name.

This was found by asking what happens when the worker is absent, and it is the difference between a
gate and a gate a caller can step around. The same question is worth asking of
`launch_game`/`projectGameLaunch`, which share this shape and where the answer today is that a
workspace with no ledger has nothing to be refused by — acceptable for arbitration between agents,
and not acceptable for an owner's permission. Not fixed here; noted because the shapes look alike
and only one of them may be read that way.

## The hazard this design does not fully close, stated rather than discovered later

A relay appends to whatever the composer already holds. If a person left a half-written line in a
pane and walked away for longer than the 60-second input window, the relay's line lands after theirs
and the Enter submits both. There is no way to read a composer's contents through a PTY, and the one
way to clear it is a control byte, which decision 3 refuses. What is done instead: the grant names
one pane and is bounded, the input window covers the case where the person is actually there, and
the feed frame makes the relay visible afterwards. A pane a person opened by hand has no grant and
is refused whatever state it is in.

**And none of this is authentication.** Spec 095 says the identity headers are *"arbitration, never
authentication"*, and the same is true one layer down: anything running as this user can read
`sidecar.json` and post `/api/input` itself, exactly as the owner did by hand. The grant is not a
lock against a hostile process. It is a control surface that makes the sanctioned path scoped,
bounded, audited and stoppable — and that makes the unsanctioned path a visible violation rather
than the normal way of working. A spec that claimed more would be selling a lock that is not one.

## Why not the shapes that were weighed

- **Drive `SeedWatch` from `/api/session` polls in `red-mcp`.** The proposal that reached this spec.
  It is possible and it is wrong here: `red-mcp` cannot write to a pane at all — only the process
  holding the master file descriptor can, and nothing in `red/` passes descriptors — so polling
  would split the watching from the writing across two processes, put a second copy of the decision
  where it could drift, and add a round trip per 150 ms tick. The service already reads every byte
  the pane emits; that read loop *is* `SeedWatch`'s eyes.
- **A synchronous `message` verb on the PTY service.** `red_pty_serve.rs` takes one lock around the
  whole dispatch, so a verb that waited five seconds for an echo would freeze every pane in the
  workspace while it did. The verb attaches and returns; the outcome arrives on the pane record and
  the session event, exactly as a spawn seed's does.
- **Reuse `prompt.kind`.** Decision 1.
- **Put the grant in the token ledger.** Decision 8.
- **Let `integration_inbox` start a turn.** Refused; §"the recorded decision", point 3.
- **`restart_agent` or a second `spawn_agent`.** Neither carries a message to an existing
  conversation: one replaces the process on the same conversation, the other starts a new pane with
  none of the accumulated context that is the whole reason for steering the pane rather than
  replacing it.

## Boundaries

- No agent CLI name enters shared code. `message` is a kind; the roster is the recipe's;
  `tools/agent_names.py check` gains no exception.
- Same root only. A pane in another project is refused by name, and the project is read from the
  pane's own record rather than from anything the caller sent.
- Nothing is read from disk to compose the line, so the brief-file question spec 146 left open does
  not arise.
- Three stops, plus one that is never gated: revoke the grant (`--revoke`, or let it expire), take
  the token, `stop_session` — and the owner's own keyboard, which spec 095 decision 6 keeps ungated.
- The feed carries the fact and never the text.

## Acceptance criteria (F222)

1. A declared CLI's quiet agent pane is typed into and submitted: the line carries the confirm token,
   the pane echoes it, the Enter follows, the pane record says `delivered`, and one `session.message`
   frame carries the pane, the outcome and no message text.
2. A pane whose recipe declares no message capability is refused by name with nothing typed, in the
   words `prompt_delivery` refuses with; a kind rEngine does not implement is refused as such.
3. A pane in another project is refused *"Session is not bound to this project."*; a non-holder is
   refused naming the holder and `token_contest`; both refuse before anything is typed. A workspace
   whose calls reach a bare session host — no worker, therefore no gate, no grant and no feed —
   does not advertise the tool at all, so the call is refused by name rather than served ungated.
4. Without an owner grant for **that** pane the call is refused even when the caller holds the token,
   and the refusal says how a grant is made. A grant for a different pane does not serve. A spent
   grant and an expired grant are each refused by their own name.
5. Text carrying a control byte, a newline, or more than 400 characters is refused rather than
   cleaned, and nothing is typed.
6. A pane that has spoken within 800 ms, and a pane that was typed into within 60 s, are each
   refused by name and nothing is typed.
7. An unechoed paste is **never** submitted: one attempt, no Enter, the record says `undelivered`,
   the frame says so, and the grant is spent exactly once for the attempt.
8. The grant action writes nothing without an interactive confirmation, names one pane, requires both
   bounds, and a revoke leaves no grant for that pane.
9. Each regression was observed failing for its own reason, with a rebuild between the sabotage and
   the run (KI-120).
