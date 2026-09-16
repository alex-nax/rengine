# How a CLI is handed the brief a spawn carries (F221)

Date: 2026-09-16. Status: recorded from a live failure in the NOLF workspace, reported by the owner
with the pane's own output:

```
Launching /Users/alex/.kimi-code/bin/kimi in /Users/alex/nolf-improved
Workspace MCP: rengine_485221fc6933
Workspace identity: kimi ec36a646
unknown command '# F1765 — Replay fidelity: …'. See 'kimi --help'.
```

The pane died in about two seconds with exit code 1. Nothing in the workspace was broken; the brief
was delivered the way one CLI takes it to a CLI that takes it another way.

Parent: [task-driven agents](103-task-driven-agents.md), whose spawn renders the brief, over
[the provider abstraction](141-provider-abstraction.md), whose rule this applies: shared code asks
the recipe what a CLI *can do*, and never who it is.

## What was wrong

`red_worker::agent_spawn` appends the rendered brief to the pane's argv as a positional argument,
under a comment that says so:

> *The CLI's own initial prompt is a positional argument after the model flag, which is how both of
> the CLIs that take one take it.*

Two of the five declared CLIs take one that way. The comment was true when it was written and had
become a rule applied to CLIs it was never measured against. A bare positional is not a neutral
thing to pass: a CLI with subcommands reads the first bare word as **the subcommand**, so a brief
handed to one is not ignored, it is a command that does not exist — and the pane exits on it.

This is the same class the model flag was already held to. `red_project::tasks::model_args` refuses
by name rather than guessing:

> *rEngine does not know how gemini is told which model to run, so it will not guess a flag … Nothing
> was started.*

Prompt delivery had no such rule, so it guessed, and the guess killed the pane.

## What was measured

Against the installed CLI (`kimi-code 0.42.0`) with `KIMI_BASE_URL` pointed at a closed port, so no
turn is ever taken. Each is a run, not a reading of documentation:

| # | Question | Answer |
|---|---|---|
| 1 | Does it take a bare positional prompt? | No. `kimi [options] [command]`; `-p/--prompt` is documented as *"Run one prompt non-interactively and print the response"* — a one-shot, not a seeded interactive pane. |
| 2 | Can a session be created with a first message from outside? | No. `kimi session` offers `list` only; `fork` needs a session that exists. |
| 3 | Does the TUI read its keystrokes from a pipe as well as a tty? | Yes — a piped byte stream drove its trust dialog. So the bytes a pane's PTY delivers **are** typed input. |
| 4 | Does a bracketed paste arrive whole? | Yes. A 6-line brief written as `ESC[200~ … ESC[201~` landed in the composer as one entry with its newlines intact and **did not submit**; a following `\r` submitted it and the transcript showed the brief as the user turn. |
| 5 | Is "the composer is ready" visible in the output? | **No.** `ESC[?2004h` (bracketed paste on) is emitted once at startup, *before* the trust dialog — so the terminal setup cannot be read as composer readiness. |
| 6 | What does the composer echo? | A long paste collapses to `[paste #1 +31 lines]` — the text itself is not echoed. A **single line** is echoed verbatim (wrapped inside the box, but every character present). |
| 7 | What does a paste do while the trust dialog is up? | 6 bytes of redraw and nothing else: the paste is decoded as one event and the dialog ignores it. Nothing is selected, nothing is answered. |

Measurement 7 is the one that decides the shape below, and measurement 5 is the one that rules out
the obvious shape: there is no marker to wait for, so the handshake has to *ask* rather than watch.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **How a CLI takes an initial prompt is a declared capability**, `prompt.kind` in the recipe. The KINDS are rEngine's to implement; which one a CLI takes is the recipe's to say. Shared code asks for the kind and never for the name. | Spec 141's rule applied |
| 2 | A CLI whose recipe declares **no** prompt delivery is **refused by name before anything starts**, in the words `model_args` refuses an unknown model flag with. Guessing a positional is what this spec exists to stop, and a refusal a caller can act on beats a pane that dies. | The `model_args` precedent |
| 3 | `kind = "argv"` — the brief is the CLI's last positional argument. Declared by the two CLIs that were already taking it that way, and by nothing that has not been measured. | Recorded behaviour |
| 4 | `kind = "paste"` — the brief is **typed into the pane**, as a bracketed paste, by the service that owns the pane's PTY. Nothing else can: the CLI is interactive, the launcher's stdin *is* the pane, and only the master side can put characters into it. | Measurements 3 and 4 |
| 5 | A `paste` delivery types **one short line naming a file**, and the brief itself is written to that file (`<state>/integrations/<id>.brief.md`, 0600 beside the launch's other per-launch files). Not because a file is nicer, but because measurement 6 says a multi-line paste is not echoed and a single line is: the line has to be readable back for decision 6 to be possible at all. | Measurement 6 |
| 6 | **The Enter is never sent blind.** The paste goes in, and the `\r` that submits it follows *only* when the pane echoes the line back — matched on the launch's own 8-character token, over output normalised to alphanumerics so the composer's wrapping cannot hide it. Unconfirmed means unsubmitted, forever. | Measurement 7 + KI-068 |
| 7 | An unconfirmed paste is **retried at the next settle**, three times inside 90 seconds, and a pane that never goes quiet is typed into after ten seconds of talking. The case it exists for is a first pane in a project, sitting on the CLI's own trust prompt: a person answers it, the composer appears, and the next attempt lands. A paste that is ignored costs 6 bytes of redraw, which is what makes retrying safe. | Measurements 7 and 4 |
| 8 | The pane's record says which happened — `seed: "delivered"` or `seed: "unconfirmed"` — because a brief that did not arrive must not look like one that did. | House rule: never silently turn missing evidence into success |
| 9 | The delivery decision is `red_agents::launch::prompt_delivery`, beside the other launch decisions, and it returns the **kind**. Composing the file, the line and the token is the host's, and driving the handshake is the PTY service's: the decision is pure and the environment-dependent parts are supplied by the caller, which is what `launch.rs` already promises. | `launch.rs`'s stated contract |

## What a seeded pane does, in order

1. `spawn_agent` renders the brief, asks the recipe how this CLI takes one, and — for `paste` —
   leaves argv alone and puts the brief on the terminal call as `seed`.
2. `red-host` writes the brief to `<state>/integrations/<id>.brief.md`, composes the one line that
   names it, and hands `red-pty` `{ paste, confirm }`.
3. `red-pty` starts the child as usual. A watcher waits for the pane to produce output and then fall
   quiet for 800 ms — the CLI has drawn *something* and stopped — and writes
   `ESC[200~<line>ESC[201~`. A CLI that never falls silent (a spinner, a clock in a status line) is
   typed into anyway once it has plainly been up for **ten seconds**, because waiting for a silence
   that is not coming would seed nothing at all, and a person watching one of those starts typing
   too. Safe for the same reason the retries are: only the echo earns the Enter.
4. Everything the pane emits afterwards is normalised and searched for the token. Found: `\r`, and
   the record says `delivered`. Not found within 4 s: the attempt is abandoned and the wait starts
   again, up to three attempts inside 90 s, after which the record says `unconfirmed` and no Enter
   is ever sent.

## Why not the other three routes

- **`kimi -p`** is a one-shot: it prints an answer and exits. A pane made of it is not a
  conversation, and following it with `--continue` would mean the agent has already taken a turn
  before the person sees the pane, in a session identified by "most recent for this directory" —
  which two panes in one checkout race over.
- **`kimi acp`** is very likely the right long-term surface, and it is already a filed row: **F114**,
  the ACP session kind, with [spec 138](138-project-agents-over-acp.md) holding its design. It is a
  different *kind of session* — no terminal, a transcript service, an Agent tab — not a way to hand
  a terminal pane its first message. Building it here would be building F114 by the side door.
- **Refusing kimi outright** is what decision 2 does for every CLI that has not been measured, and
  it is the honest answer when there is no mechanism. There is a measured mechanism here, so
  refusing would be choosing not to use it.

## Open, and deliberately not decided here

**Where the brief file lives.** It is written to `<state>/integrations/<id>.brief.md`, beside every
other per-launch file a pane is given, 0600, machine-local, and outside the person's checkout. That
puts it **outside the pane's working directory**, and an agent CLI may ask before reading a path
outside its workspace — or, if it confines itself, decline. This was not measured, because measuring
it costs a turn against a live model.

The alternatives were weighed and left open rather than guessed: writing it into the project root
(the precedent exists — the project MCP overlay already writes `.kimi-code/mcp.json` there) would put
a machine-local file in the person's checkout, and declaring a flag that adds a readable directory to
a CLI's workspace is a new recipe capability that this row does not need. Nothing is lost in the bad
case: the file is named on screen and a person can open it, where today the pane is simply dead.

## Boundaries

- No agent name enters shared code: `paste` is a kind, the file and the line are composed from the
  launch's own paths, and `tools/agent_names.py check` gains no exception.
- Nothing writes to the person's own CLI configuration, and nothing answers the CLI's trust prompt
  on their behalf — decision 6 exists precisely so that a prompt awaiting a human decision is never
  answered by a workspace keystroke.
- `argv` delivery is byte-identical to what shipped: the same argument, in the same position, after
  the model flag.
