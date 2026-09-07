# Agent conversations, and the environment a pane inherits (F91, F92)

Date: 2026-09-07. Status: recorded from owner direction, given directly in the hirebase-v2 workspace
after the owner reported that every pane in a running workspace had lost its colour:

> "maybe in sessions list we should list sessions by the agent session list so we better control what
> session we are attaching into, thus making resuming more natural - this would help us stay in current
> claude session but we would be able to restart in and launch properly"

Parent: [orchestrator](002-orchestrator.md) and [layered workspace updates](065-layered-workspace-updates.md).
It extends the per-launch identity of [the project token](095-project-token.md) — which answers *which
agent is acting* — with the orthogonal question *which conversation a pane is holding*.

## The situation it answers

On 2026-09-07 the hirebase-v2 workspace ran every pane without colour. The cause was not the renderer
and not a regression on either side: `shellEnvironment` composes `inherited -> overrides -> {TERM,
COLORTERM}` and forwards whatever it was given, and the launcher for that workspace had been started
from an agent CLI's shell, which sets `NO_COLOR=1` for the shells it spawns. The variable was in the
session host's own environment from 09:16:13, so every pane the host would ever create inherited it.

Two properties of the system turned a one-character environment defect into an unfixable one:

- **The declaration was contradicted silently.** The function sets `TERM=xterm-256color` and
  `COLORTERM=truecolor` — it declares the surface colour-capable — and then hands the pane a variable
  that says the opposite. Measured in a real pane: `tput colors` 256, raw SGR intact, Node colour
  depth 1. The surface was fine; every Node tool in it was monochrome.
- **No restart could reach it.** Closing the window and restarting the agent replaced the desktop and
  the agent child, but the retained session host is durable by design (spec 065), so the new pane was
  spawned from the same environment. The only remedy was to kill the host, and killing the host
  destroys every live agent conversation on it. An in-app workaround does not exist either: the
  `open_script` env map takes strings only, and blanking the variable does not help, because Node
  disables colour on the variable's *presence* — measured, `NO_COLOR=` gives depth 1 and absence 8.

So the incident is really two defects. One is the environment. The other is that **an agent pane is
not restartable**: rEngine never records which conversation a pane holds, so it cannot put a new pane
back into it, and the owner is forced to choose between a broken environment and their work.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The surface **owns its colour declaration**. `shellEnvironment` sets `TERM`/`COLORTERM`, so an inherited `NO_COLOR` is dropped rather than forwarded, exactly as `ELECTRON_RUN_AS_NODE` already is. | Recommended; follows from the function already declaring the surface |
| 2 | An **explicit override still wins**. A caller that passes `NO_COLOR` in `overrides` gets it, so a project or a script action can still ask for plain output. The drop applies to the inherited layer only, and is case-insensitive on Windows like every other name here. | Recommended |
| 3 | rEngine **names the conversation at launch** rather than discovering it afterwards. It mints a UUID and tells the CLI, so the identifier is known before the first byte of output and no rollout directory has to be scraped. | Recommended; the Codex handoff path (spec 060) already showed what discovery costs |
| 4 | Naming is a **declared per-agent capability**, not an assumption. `claude` accepts `--session-id` to be told and `--resume` to be put back. An agent that names its own conversations is recorded with **none**, and is refused by name when a restart is attempted, rather than being started as a silent second conversation. | Recommended; house discipline (spec 078, *Who serves what*) |
| 5 | The conversation appears on the **session record** and in `workspace_info`, so a caller can see which panes are restartable before choosing one. | Owner ("list sessions by the agent session list ... so we better control what session we are attaching into") |
| 6 | A **restart replaces the child, not the host**. `restart_agent` stops the pane's process and starts a new one on the same conversation with a freshly composed environment. The session host, the other panes and their processes are untouched, so this is not a quiescence event. | Owner ("stay in current claude session but we would be able to restart in and launch properly") |
| 7 | A pane never **inherits another pane's** conversation: `RENGINE_AGENT_CONVERSATION` and `RENGINE_AGENT_RESUME` are cleared from the inherited environment before each spawn, as the handoff variables already are. | Recommended |
| 8 | The capability is declared by the **session host**, because the host owns the PTY. A retained host that predates it refuses `restart_agent` by name and says that replacing the host requires quiescence. | House pattern (`projectGame`, spec 078) |

## What this does not do

It does not add a session browser to the native desktop. Decision 5 puts the conversation on the
record and in the tool surface, which is what a caller and a future browser both read; drawing it is
its own work. It does not give Codex a mintable conversation — Codex names its own rollout, so under
decision 4 it is recorded with none and its existing handoff resume is untouched. It does not change
the retention contract of spec 065: the host still survives window and agent restarts, and a
host-level defect still needs a host restart. What changes is that a *pane*-level restart now exists,
so far fewer defects require reaching for the host at all.

## Verification

Unit, in `orchestrator/tests/`:

| Check | Establishes |
| --- | --- |
| `environment.test.mjs` | an inherited `NO_COLOR` never reaches a pane, an explicit override still suppresses colour, and the drop is case-insensitive on Windows |
| `agent-config.test.mjs` | a fresh launch carries `--session-id`, a resume carries `--resume`, an agent without the capability is given no identifier and none of its arguments, and an identifier rEngine did not mint is refused |
| `sessions.test.mjs` | a plain terminal holds no conversation, and a restart refuses both a non-agent session and an unknown one |

Each was observed failing for its own reason before the implementation existed: the `NO_COLOR`
assertion failed with `actual: '1'`, the argument assertion with a `deepStrictEqual` on the argv, and
the restart guard with `sessions.restartAgent is not a function`.

**Not verified here:** a live end-to-end restart of a real agent pane. It cannot be observed from
inside the workspace whose host predates this change, which is the very condition the spec describes;
and this repository already excludes `native-agent.spec.mjs` from the suite for needing a real agent
CLI on a trusted root. The first workspace started from a host carrying this change should record the
observation — pane restarted, conversation continued, process id changed, host pid unchanged — as
evidence under `docs/evidence/`. Until then F92 is implemented and unit-covered, not proven live, and
`passes` stays false.
