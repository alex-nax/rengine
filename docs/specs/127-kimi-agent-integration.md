# Kimi Code is a named agent (F138)

Date: 2026-09-11. Status: recorded from owner direction, given in a Kimi Code session on this
checkout:

> "We need to integrate our rengine environment better with kimi, note that we should aim for
> unified integration so it would be the same functionality for everyone including session
> listing+discovery and etc"

and, reviewing the first draft of this plan:

> "I think we can make a user guided action to bootstrap hooks for agent - that would make
> integration even greater"

Parent: [orchestrator](002-orchestrator.md), extending [agent session resume](096-agent-session-resume.md),
[conversation persistence](097-agent-conversation-persistence.md) and [the sessions tab](099-sessions-tab-resume.md)
to a fourth named CLI, over the identity rules of [the project token](095-project-token.md). It deliberately
does **not** build the [agent recipe registry](114-dev-suite-roadmap.md) (F113) or the ACP session
kind (F114): kimi is added to the per-consumer tables that exist today, and F113 moves that row into
one registry as data when it lands.

## The situation it answers

Skills are already unified: `.agents/skills/` is a documented project-level skill location for both
Codex and Kimi Code, with the canonical definitions in `.claude/skills/` — yet AGENTS.md described
entry points for Claude Code and Codex only, and a kimi **pane** got nothing at all. `NAMED` in
`orchestrator/agents/config.mjs` listed four CLIs, so a kimi launch fell into `plan.custom` and
printed "Configure this CLI to consume it": no workspace MCP, no session identity, no conversation
on the session record, no resume line, no restart-into-conversation. Session listing+discovery was
not the same for everyone.

Kimi Code's own integration channels, verified against its published documentation on 2026-09-11
(`kimi.com/code/docs`: Agent Skills, MCP, Hooks, Configuration files, Environment variables,
`kimi` command, FAQ):

- **MCP** is configured only through `mcp.json`: user-level `$KIMI_CODE_HOME/mcp.json` or
  project-level `.kimi-code/mcp.json`. There is no `--mcp-config` flag and no environment override.
  An untrusted folder surfaces kimi's own trust prompt listing each project-level server — visible
  consent, by kimi's design.
- **Sessions**: `kimi --session <id>` (also `-S`, and the hidden alias `-r`/`--resume`) resumes a
  named session; bare `--session` opens an interactive selector; `-c`/`--continue` continues the
  most recent. There is **no start-with-id flag** — like Codex, kimi names its own conversations.
  Observed ids are `session_<uuid>`; the documentation also shows ULID-shaped ids.
- **Hooks**: `SessionStart` fires on startup and resume carrying `session_id` on stdin — but hook
  rules live only in the user-level `config.toml` (`$KIMI_CODE_HOME` or `~/.kimi-code`). There is no
  per-launch or project-level hook channel, so live session reporting needs a one-time edit to the
  person's own config — which is exactly what the owner asked to make a guided action.
- **Install/update**: npm package `@moonshot-ai/kimi-code`; `kimi upgrade` updates any install
  type. `kimi doctor config [path]` validates a config file without starting the TUI.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | kimi joins the named agents **everywhere the other four are named**: `NAMED` in `agents/config.mjs`, `scripts/agent.sh` list/install/update, `KNOWN_AGENTS` and `MODEL_FLAGS` in `server/tasks.mjs`, and the launcher/bind usage strings. F113 stays the follow-up that collapses these per-consumer tables into one declared registry; kimi's row becomes data then. | Owner (unified integration); house rule "add follow-up work instead of rewriting a requirement" |
| 2 | The workspace MCP is wired through the **project-level `.kimi-code/mcp.json`** at the pane's repository root — the only per-project channel kimi publishes. rEngine owns exactly its `rengine_` namespace: the file is created `0o600` when absent, parsed tolerantly when present, every foreign entry preserved, rEngine's own keys replaced (a stale one points at a per-launch context that no longer exists), and invalid JSON is refused without touching the file. The user-level `mcp.json` and any `KIMI_CODE_HOME` redirect are rejected: global mutable state, and a redirect moves the person's login and session history. | Recommended; house boundary "no global mutable configuration" |
| 3 | kimi **never has a conversation minted for it** — the CLI offers no start-with-id flag. Identity comes from the pane's own `--session` flags (any documented spelling); a launch that names nothing records an honest unknown, never an invented id. The resume line is `kimi --session <id>`. | Follows spec 096 decision 4 ("an agent absent from this table names its own") |
| 4 | `CONVERSATIONS` becomes **per-capability**: telling a CLI which conversation to start and putting it back into one are separate capabilities, and kimi declares `resume` only. Minting stays gated on `start`, so nothing changes for the agents that can be told. | Recommended |
| 5 | The shared project file is **last-writer-wins** across panes, so the MCP facade's context resolution prefers the pane's own environment (`RENGINE_MCP_CONFIG`, then `RENGINE_WORKSPACE_CONTEXT`) over its `--context` argv: two kimi panes on one root keep their own identities instead of both attributing to the newest launch. A kimi started outside any pane has no such environment and falls back to argv — the project file's entry. | Recommended; consequence of decision 2 |
| 6 | Live session-report parity comes from a `SessionStart` hook, and because kimi's hooks live only in the user-level `config.toml`, it is installed by an **explicit guided dashboard action** (`bootstrap-agent-hooks`): it detects the CLI, shows the exact change, asks confirmation (or `--yes`), backs up the config, appends idempotently, verifies with `kimi doctor`, restores the backup on any failure, and prints removal instructions. It is never a silent write and never a precondition for a pane to work. | Owner ("a user guided action to bootstrap hooks for agent") |
| 7 | `report-session.mjs` learns `--provider kimi`: accepted id shapes are `session_<uuid>`, a bare UUID and a ULID; the label is `kimi <first8>` of the id without its `session_` prefix; the resume line is `kimi --session <id>`; the report still travels over `POST /api/agent-conversation`. Binding discovery stays argv/env-only — deliberately **no** cwd discovery of `.kimi-code/mcp.json`, because a kimi session started outside any pane would otherwise rewrite a live pane's recorded identity. | Recommended; spec 095's identity rules |
| 8 | `bind.mjs` gains kimi: binding writes the project `mcp.json` against the **bound root**, not the caller's working directory, and the printed guidance points at the bootstrap action. | Recommended |
| 9 | `.kimi-code/` is git-ignored in this checkout — the launcher-written `mcp.json` carries per-launch absolute paths and is machine-local. Consumers choose for themselves; the integration runbook says so. | Recommended |
| 10 | AGENTS.md's entry points describe all three consuming CLIs uniformly: `.agents/skills/` discovered by Codex and Kimi Code, canonical definitions in `.claude/skills/`, invocation `/skill-name` (Claude Code), `$skill-name` (Codex), `/skill:name` (Kimi Code). | Owner ("update agents.md because it states deprecated info") |

## What a pane gets that it did not

A kimi agent pane launched from the workspace now: is detected, installable and updatable through
`agent.sh` like the other four; finds the workspace MCP through the project `mcp.json` (after kimi's
own trust prompt for the folder); records its conversation when its flags name one, with
`kimi --session <id>` as the resume line in the pane output, the session record and the restart
path; can pick a recorded kimi conversation to resume from the launcher's picker; and — once the
owner runs the bootstrap action — reports the session it is actually running back over the same
route Claude's hook uses, so a `/session` switch inside the CLI heals the record on its next start.

## Boundaries that did not move

- No silent or required edits to `~/.kimi-code`: the only writer of the global config is the
  owner-confirmed bootstrap action, and it is reversible by construction.
- `check-resume` stays Codex-specific (the handoff flow's probe); kimi's resume needs no probe —
  `--session` is documented, stable and versioned with the CLI.
- Nothing here spawns an agent as a side effect: the action and the pane launch are explicit owner
  gestures. Tests use fake executables and simulated hook payloads, never a live CLI.
