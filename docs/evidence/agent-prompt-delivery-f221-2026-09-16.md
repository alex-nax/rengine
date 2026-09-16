# F221 — the brief reaches a CLI that takes none on its command line (2026-09-16)

Spec 146, over spec 141's rule. Reported from the NOLF workspace as a pane that died:

```
Launching …/kimi in /Users/alex/nolf-improved
Workspace MCP: rengine_485221fc6933
Workspace identity: kimi ec36a646
unknown command '# F1765 — Replay fidelity: …'. See 'kimi --help'.
```

Exit 1, about two seconds. The workspace had done everything else right — MCP wired, identity
stamped, pane retained — and then appended the brief to the command line, which is how two of the
five declared CLIs take one and how the third reads a **subcommand**.

## What was measured before anything was designed

Seven runs against the installed CLI (0.42.0) with its base URL pointed at a closed port, so the
mechanism is exercised and no turn is ever taken. The table is in spec 146; the two that decided the
shape:

- **There is no readiness marker.** `ESC[?2004h` — the terminal declaring it takes pastes — is
  emitted **once, at startup, before** the CLI's own trust dialog. So "the composer is up" cannot be
  watched for. The handshake has to ask and look at the answer.
- **A paste into a modal costs six bytes and changes nothing.** The bracketed sequence is decoded as
  one paste event, and a dialog that takes arrow keys ignores it. That is what makes typing into a
  pane whose state is unknown safe — and what makes *pressing Enter* into one unsafe, because the
  highlighted option in that dialog was "Trust this folder".

A third measurement decided the payload: a 31-line paste collapses to `[paste #1 +31 lines]` and
echoes none of its text, while a single line comes back verbatim (wrapped inside the composer's box,
every character present). An echo is the only thing that can earn an Enter, so the typed thing has to
be a line — which is why the brief goes to a file and the line names it.

## The four layers, and what each is allowed to know

| Layer | What it does | What it does not know |
|---|---|---|
| `registry.toml` | `prompt.kind` per recipe: `argv`, `argv`, `paste` | — (it is the data) |
| `red_agents::launch::prompt_delivery` | answers the kind, or refuses by name | anything about pastes or files |
| `red_worker::agent_spawn` | `argv` appends, `paste` puts the brief on the terminal call | which CLI this is |
| `red_host::panes` | writes `<id>.brief.md`, composes the line and the token | the handshake's timing |
| `red_pty` | settles, pastes, waits for the token, submits or gives up | that agents exist at all |

`tools/agent_names.py check` passes with **no new exception**: the only place a CLI's name appears is
the recipe key, which is where it belongs.

## Regressions, and each observed failing for its own reason

Ten sabotages, each observed failing at its own assertion. Every one was compiled before it ran
(KI-120): the two that touch the registry are data and need none, the rest were rebuilt with
`cargo build --bins` between the edit and the run. **One sabotage passed the first time round** and
is the most useful line here — the host edit did not compile, so the test judged a stale binary and
came back green. It was redone and went red.

| Sabotage | Test that went red | Its reason |
|---|---|---|
| `kimi` declared `argv` again — the shipped bug, exactly | `a CLI that takes no prompt on its command line is typed into instead` | `the brief is not a bare word on the command line any more`, with the rendered brief as the actual value |
| the host composes no seed | same test | `Timed out: the brief was typed into the pane` |
| an undeclared CLI falls back to a positional | `how_a_cli_takes_a_brief_is_declared_and_an_undeclared_one_is_refused_by_name` | the three undeclared CLIs stopped being refused |
| `cook` accepts any prompt delivery | `a_prompt_delivery_rengine_does_not_implement_is_refused_at_cook` | `telepathy` cooked |
| the echo gate removed (submit as soon as it is pasted) | `a_paste_nothing_echoes_is_retried_and_then_given_up_on_without_an_enter` | `an unechoed paste must never be submitted` |
| normalisation removed, so a wrapped token is two tokens | `a_seed_is_typed_once_the_pane_is_quiet_and_submitted_once_it_comes_back` | the echo split across the composer's frame stopped matching |
| a silent pane counts as quiet | `a_pane_that_says_nothing_is_given_up_on_rather_than_typed_at` | it got typed at |
| a pane that never goes quiet waits for a silence that never comes | `a_pane_that_never_falls_silent_is_still_typed_into` | it was never typed into |
| one attempt instead of three | the retry test | the trust-prompt case lost its retries |
| the paste presses Enter itself | `the_typed_bytes_are_one_bracketed_paste_and_press_nothing` | a `\r` inside the bracket |

## The fixture had to become a TUI before it proved anything

The end-to-end test failed first, and the reason is worth keeping. The stand-in CLI attached a
`data` listener to `process.stdin` and left the terminal **cooked** — so the kernel's line discipline
echoed the paste back for it, and `ICRNL` turned the workspace's `\r` into `\n`. The handshake looked
like it worked (the echo the watcher matched was the *kernel's*), and the application never saw the
Enter at all.

A real TUI sets raw mode, which turns both off. The fixture does now, which is what makes its green
mean something: the echo the Enter is earned by is the **application's own**.

## What the full suite found that a single spec could not

The end-to-end spec passed alone and **failed under the loaded suite**, timing out on
`the echo earned the Enter that submits it`. Two things came out of it, and the second is the one
worth keeping:

- the wait was fifteen seconds against a handshake whose own worst case is fifteen seconds — a budget
  measured on an idle machine, which is precisely KI-124's lesson. It is sixty now;
- **a CLI that never falls silent would never have been typed into at all.** The settle rule waits
  for quiet, and a spinner or a status-line clock means quiet never arrives. Under load the fixture
  got close enough to that shape to expose it. The watcher now types after ten seconds of continuous
  talking as well as after 800 ms of quiet, which is safe for the same reason the retries are: only
  the echo earns the Enter. Sabotage-verified.

## Numbers

- `cargo test --workspace` — **360/360**, +8 on this branch (two in red-agents, six in red-pty)
- `npm test` — **365/366** — the one failure is `red-agents-launch.test.mjs`, which fails identically at HEAD in this checkout (KI-127) and is not this branch's; +2 on this branch, both in `task-writes.test.mjs`
- `./init.sh` — green, `5 declared, 5 declared exceptions`

The suite is run from a checkout at `third_party/rengine` **inside a consuming project**, which is
how the pin is meant to be consumed and is not where these records were made. That produced the one
failure and it was baselined rather than assumed: with this branch stashed, the same spec fails at
HEAD with the same two paths side by side. Filed as **KI-127** — `agents-fixtures.json` freezes
`/Users/alex/rengine/orchestrator/agents/mcp.mjs`, the recorder's own checkout, in eleven places, and
`scrub` replaces the home directory, the root id and the mint but not the checkout.

## What is not proven here

A pane of the real CLI, opened from the real workspace, coming up holding a real brief. That is an
owner-run dogfood step of the same kind **F186** already exists for, and it is the one thing a
fixture cannot stand in for. What is proven is that every mechanism it depends on was measured
against the real CLI first, and that the workspace drives them in the right order.

And one thing inside that: the brief file sits in the state directory, **outside the pane's working
directory**, so a CLI that confines its reads to its workspace may ask before opening it. Measuring
that costs a turn against a live model, so it was not measured. Spec 146 records the alternatives and
why the choice was left open rather than guessed.
