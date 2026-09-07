# The CLI reports what it runs: closing the last gap in "the conversation IS the identity"

Date: 2026-09-07. Machine: macos. Branch: `feat/report-session-hook`, from `origin/main` at `6f61640`.
Parent evidence: [conversation-is-identity-2026-09-07.md](conversation-is-identity-2026-09-07.md),
which reconciled the two lanes that both minted a UUID. This closes what that reconciliation left open.

## The gap, observed live

A workspace pane launched Claude with a minted conversation `b9e2114c…` (`--session-id`), and the host
recorded it. The person then resumed a **different** conversation from inside the running CLI — Claude
Code's own `/resume` picker — so the process ran `5b8d47c2…`. Its transcript is
`~/.claude/projects/<slug>/5b8d47c2….jsonl`; no `b9e2114c….jsonl` ever appeared, because that
conversation was named and then abandoned before its first byte. Meanwhile the pane's record,
`workspace_info.agent`, the token ledger identity and the Sessions tab all still said `b9e2114c`.

The launcher cannot see an in-CLI resume: it decides the conversation from the launch's own flags and
then the process is opaque to it. Inference after the fact — from transcripts, rollout directories or
the process tree — is exactly what spec 095 forbids, and what a previous attempt "constantly botched".

## What was verified on this machine first, not assumed

`claude --version` → **2.1.263 (Claude Code)**. `claude --help`:

```
  --session-id <uuid>                   Use a specific session ID for the conversation …
  --settings <file-or-json>             Path to a settings JSON file or a JSON string to load
                                        additional settings from
```

One cheap real hook, run in an empty directory so nothing of this project's configuration was in play:

```sh
claude -p "say ok" --max-turns 1 \
  --settings '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"cat > /tmp/hook-input.json"}]}]}}'
```

The exact stdin the CLI handed the hook, `source: startup`:

```json
{
  "session_id": "5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca",
  "transcript_path": "/Users/alex/.claude/projects/-private-tmp-hookprobe/5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca.jsonl",
  "cwd": "/private/tmp/hookprobe",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

Resuming that same conversation with `--settings <path>` (a **file**, which is the form the launcher
uses) and `RENGINE_PROBE=inherited-ok` in the environment established two more facts the design needs:
the payload for `source: resume`, and that a hook inherits the launch environment — so
`RENGINE_MCP_CONFIG`, `RENGINE_WORKSPACE_CONTEXT` and `RENGINE_ORCHESTRATOR_SESSION` reach it:

```json
{
  "session_id": "5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca",
  "transcript_path": "/Users/alex/.claude/projects/-private-tmp-hookprobe/5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca.jsonl",
  "cwd": "/private/tmp/hookprobe",
  "hook_event_name": "SessionStart",
  "source": "resume",
  "seconds_since_last_response": 19,
  "context_tokens": 34342,
  "prompt_cache_likely_expired": false,
  "estimated_cache_write_usd": 0.3434
}
```

`printenv RENGINE_PROBE` inside the hook printed `inherited-ok`.

## What changed

| file | change |
| --- | --- |
| `orchestrator/agents/report-session.mjs` (new) | reads the hook payload from stdin, finds this launch's binding, posts `POST /api/agent-conversation`, and rewrites the per-launch `context.json` identity |
| `orchestrator/agents/config.mjs` | writes that hook into a per-launch `settings.json` beside `mcp.json`, and passes `--settings` on a claude launch |
| `orchestrator/agents/bind.mjs` | prints the same `--settings` flag, so a session started outside the workspace reports itself too |
| `orchestrator/agents/mcp-worker.mjs` | re-reads the identity from the context file once per tool call; the binding stays the facade's snapshot |

No `orchestrator/server/*` change — the `agent-conversation` route already existed for `launch.mjs` —
and no `orchestrator/native/*` change: the ledger identity follows because its header comes from the
context, and the status bar reads the ledger.

Three properties the hook holds, each of them a way this could have gone wrong:

- **It never fails the CLI it runs inside.** Every error goes to stderr; the exit status is always 0.
- **Nothing goes to stdout.** A `SessionStart` hook's stdout is added to the CLI's own context, so a
  status line here would become text in the person's conversation.
- **It does nothing outside a workspace pane.** No binding environment, no report, silent exit 0.
  `RENGINE_MCP_CONFIG` and `RENGINE_WORKSPACE_CONTEXT` are the launcher's own plumbing, not user
  configuration, so their absence is the honest signal that this CLI is nobody's pane.

It posts on **every** session start, not only when the id changed: this is the one report that comes
from the CLI itself, so a record the launcher could not write — a `-c` launch that claimed nothing —
heals on the next start instead of staying unknown.

## The real run, through the actual CLI

The live gap reproduced end to end: the launcher named `b9e2114c-0000-…`, and the CLI was then started
on a different conversation, which is what an in-CLI `/resume` leaves behind. A second `SessionStart`
hook (`cat > hook-stdin.json`) recorded the payload beside the launcher's own reporter, so the stdin is
observed rather than described. Fake host on loopback; `claude -p "say ok" --max-turns 1`.

The settings the launcher wrote, verbatim:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "/Users/alex/.n/bin/node /Users/alex/rengine/.cache/worktrees/report-session/orchestrator/agents/report-session.mjs" } ] }
    ]
  }
}
```

The plan's argv: `--mcp-config <…>/mcp.json --settings <…>/settings.json --session-id b9e2114c-0000-4000-8000-000000000001`.

The exact stdin the CLI gave the hook in that run:

```json
{"session_id":"5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca","transcript_path":"/Users/alex/.claude/projects/-private-var-folders-…-T-rengine-e2e-QzBPxu/5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca.jsonl","cwd":"/private/var/folders/…/T/rengine-e2e-QzBPxu","hook_event_name":"SessionStart","source":"resume","seconds_since_last_response":634,"context_tokens":36362,"prompt_cache_likely_expired":false,"estimated_cache_write_usd":0.3636}
```

| | identity in the per-launch context | posted to the host |
| --- | --- | --- |
| as launched | `b9e2114c-0000-…`, label `claude b9e2114c`, `source: workspace` | (the launcher's own report, at launch) |
| after the hook | `5a9a90ce-96ea-…`, label `claude 5a9a90ce`, `source: reported`, `resume: claude --resume 5a9a90ce-…` | `{ id: 'pane-e2e', conversation: '5a9a90ce-96ea-4bb4-b9dd-c44b15aab6ca', agent: 'claude' }` |

`pid` and `startedAt` are unchanged: they are the launcher's, and the CLI has no business rewriting
them — the pid is what liveness is measured on (spec 095, *Liveness*). The CLI exited 0, and the MCP
facade connected against the same fake host during the run (two `/api/state` calls), so the settings
flag did not disturb the configuration flag beside it.

## Tests

New: `orchestrator/tests/report-session.test.mjs`.

| test | establishes |
| --- | --- |
| a claude launch carries a settings file whose SessionStart hook runs the reporter | `--settings` is on the argv beside `--mcp-config`, naming a mode-0600 file in this launch's own directory; it declares exactly one hook, `SessionStart`, running `report-session.mjs` by absolute path under the launcher's own node |
| the CLI's own report replaces the conversation: the host is told and the context follows | fed the recorded payload, it posts `{ id, conversation, agent }` and rewrites agentId, label and the whole session descriptor (`source: reported`, the resume line); `pid`, `startedAt` and the root binding are untouched; a second report that changes nothing rewrites nothing and still posts |
| outside a workspace pane the hook reports nothing and never fails the CLI | with no binding environment it returns `bound: false` and posts nothing; run as a real subprocess on the recorded payload, on `{}` and on malformed input it exits 0 every time, writes nothing to stdout, and puts its one complaint on stderr |
| a launch that continued or forked becomes known once the CLI reports | a `-c` launch claims nothing and records `known: false`; after the report the identity is the id the CLI minted for itself, `known: true`, and the host holds it — so the pane the launcher had to leave empty is restartable |
| the tool worker's next call carries the conversation the CLI reported | `workspace_info` answers with the launched conversation, then with the reported one after the hook runs, with no worker restart and with the facade snapshot still holding the old id; `X-Rengine-Agent` and its label change on the wire; the root stays the snapshot's |

Extended: `agent-identity.test.mjs` and `conversation-identity.test.mjs` — the argv assertions now name
`--settings`, and `bind` without `--agent` is asserted to print it on the claude line.

## Sabotage table

Each regression was observed failing **for its own reason**, driven by a harness that applied the
change, ran the one test by name, and restored the file. Every case produced exactly one failing test.

| # | sabotage | file | test that went red | the assertion it failed on |
| --- | --- | --- | --- | --- |
| 1 | drop `--settings` from the claude launch | `agents/config.mjs` | a claude launch carries a settings file… | "the CLI is given the per-launch settings beside the per-launch MCP configuration" |
| 2 | register the hook on `SessionEnd` instead of `SessionStart` | `agents/config.mjs` | a claude launch carries a settings file… | "and it adds one hook: the one that says what this CLI is running" — got `SessionEnd` |
| 3 | report to the host but never rewrite the per-launch context | `agents/report-session.mjs` | the CLI's own report replaces the conversation… | the result deep-equal: `rewrote: false` where `true` was expected |
| 4 | rewrite the context but never tell the host | `agents/report-session.mjs` | the CLI's own report replaces the conversation… | the result deep-equal: `posted: false` where `true` was expected |
| 5 | keep the launch's session descriptor beside the reported id | `agents/report-session.mjs` | the CLI's own report replaces the conversation… | "the session says the CLI reported it, and the line that resumes it is that one" — `id: b9e2114c-…`, wanted `5b8d47c2-…` |
| 6 | write the hook's note to stdout instead of stderr | `agents/report-session.mjs` | outside a workspace pane the hook reports nothing… | "and writes nothing to stdout, which a SessionStart hook would add to the CLI's context" |
| 7 | drop the not-in-a-pane early return | `agents/report-session.mjs` | outside a workspace pane the hook reports nothing… | `The "path" argument must be of type string … Received null` — it tried to read a context that does not exist |
| 8 | follow only a conversation the launcher already knew (`session.known`) | `agents/report-session.mjs` | a launch that continued or forked becomes known… | "the id the CLI minted for itself becomes the identity as soon as it reports it" — still the mint |
| 9 | take the identity from the facade snapshot once, as before | `agents/mcp-worker.mjs` | the tool worker's next call carries… | "the identity is re-read per call, so workspace_info follows the CLI without a restart" — got `b9e2114c-…` |
| 10 | re-read the identity but freeze the headers at start | `agents/mcp-worker.mjs` | the tool worker's next call carries… | the wire header: `X-Rengine-Agent` still `b9e2114c-…` while `workspace_info` had moved on |
| 11 | drop `--settings` from the line `bind.mjs` prints | `agents/bind.mjs` | binding by discovery finds the one instance serving the directory… | "the claude line carries the settings that make a session started outside the workspace report its own conversation" |

Case 11 initially produced **zero** failures: `bind --agent claude` prints its line through
`describeInvocation`, which picked the flag up for free, and the hand-built line in the no-`--agent`
branch had no assertion on it at all. The assertion was added, and the sabotage then went red on it.

## Gates

| gate | result |
| --- | --- |
| `node --test orchestrator/tests/*.test.mjs` | 160/160 |
| `python3 tools/features.py validate` | 50 features, types, evidence and the dependency graph |
| `python3 tools/design.py check` | consistent |
| `node --check` on each changed module | clean |

## Not verified here

A live pane in a running workspace, which is the same gap specs 095–098 record: this session's session
host predates all of it. The first workspace started from a host carrying this change should record
here that a pane launched with one conversation, that an in-CLI `/resume` moved it, and that
`token_status`, the Sessions tab and the pane title all named the new one afterwards without a restart.
