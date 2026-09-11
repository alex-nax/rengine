# Codex SessionStart hook: trust gate, self-trust formula, and a live end-to-end report

2026-09-11, macOS, codex-cli 0.153.4 (installed at `/Users/alex/.n/bin/codex`), node 22.
Consumer-path evidence for F113 criterion 6 (a codex launch carries the SessionStart hook
overlay beside its MCP wiring) and the basis for `codexHookKey`/`codexHookTrustHash` in
`orchestrator/agents/config.mjs`.

## What had to be true

rEngine launches codex panes with a per-launch `-c` overlay (MCP server, SessionStart hook).
For the pane's conversation record to follow the CLI the way claude's and kimi's do, the hook
must (1) parse, (2) be allowed to run, and (3) carry the session id to
`report-session.mjs --provider codex`.

## Finding 1: the overlay parses — `exec` reached the model call

`codex -c features.hooks=true -c 'hooks.SessionStart=[{matcher="startup|resume",hooks=[{type="command",command="..."}]}]' exec '…'`
printed the session banner (`session id: 01a09156-…`) and died only at the model call:
`ERROR: You've hit your usage limit … try again at Sep 15th, 2026`. A malformed `-c` fails at
config load, before any of that — so the inline array-of-tables form is accepted. (`exec`
itself never runs SessionStart hooks; a `touch` marker hook confirmed. Interactive panes are
the shape rEngine launches anyway.)

## Finding 2: non-managed hooks are trust-gated, and the launch can trust itself

A marker hook that was only injected never ran. The codex source (tag `rust-v0.153.0`,
sparse-cloned to /tmp) says why: `hooks/src/engine/discovery.rs` runs a non-managed hook only
when `hooks.state."<key>".trusted_hash` equals the hash of its normalized definition
(`hook_trust_status`); anything else needs review in the TUI `/hooks` browser
(`https://developers.openai.com/codex/hooks`). The trust formula, verified against the live
CLI through the app-server protocol (`codex app-server --stdio`, method `hooks/list`):

- key: `<key_source>:session_start:<group>:<handler>` where the key source for `-c` overrides
  is codex's synthetic session-flags layer path — `/<<session-flags>/config.toml` on unix,
  `C:\<session-flags>\config.toml` on Windows (`config_toml_source_path`). For one injected
  hook: `/<<session-flags>/config.toml:session_start:0:0`. Codex printed exactly this key.
- hash: `sha256:<hex>` over the compact canonical JSON (keys sorted recursively) of
  `{event_name:"session_start", matcher:"<matcher>", hooks:[{type:"command",command:"<cmd>",timeout:600,async:false}]}`
  — unset fields (`commandWindows`, `statusMessage`, `additionalContextLimit`) omitted
  (`hook_hash` → `NormalizedHookIdentity` → `version_for_toml` in
  `config/src/fingerprint.rs`). Codex printed `sha256:01bab799…`, byte-identical to the hash
  computed by `codexHookTrustHash` for the same command. With the same hash supplied as
  `-c 'hooks.state={"<key>"={trusted_hash="sha256:…"}}'`, `hooks/list` reported
  `trustStatus: "trusted"`; a wrong hash reported `"modified"`.

Notes for maintenance: the `-c` key parser is a naive dot-split (`config/src/overrides.rs`),
so the state entry must be passed as one TOML table value under the dotted key `hooks.state`
(the quoted key containing dots lives inside the value). Trust state merges per key across the
user and session-flags layers (`hook_states_from_stack`), session-flags winning — so the
launch's entry affects only the hook the launch composed; the person's own hooks keep their
review gate, and nothing is written to `~/.codex`. `--dangerously-bypass-hook-trust` exists
and was deliberately NOT used: it would also waive review for untrusted project-layer hooks.

## Finding 3: SessionStart fires on session start and carries the id

Interactive TUI under a PTY (node-pty), trusted dump hook `cat > <file>`: after startup the
hook fired the moment a session was submitted, with:

```json
{
  "session_id": "01a09169-cda8-7932-a725-f3db4b6224af",
  "transcript_path": "/Users/alex/.codex/sessions/2026/09/11/rollout-….jsonl",
  "cwd": "/Users/alex/rengine",
  "hook_event_name": "SessionStart",
  "model": "gpt-6-astra",
  "permission_mode": "default",
  "source": "startup"
}
```

`session_id` is a UUIDv7 — inside the recipe's UUID id shape. `source` is `startup` on a fresh
session (the `resume` arm of the matcher is for resumed ones). This is the exact shape
`report-session.mjs` reads (`input.session_id`, `input.source`).

## Finding 4: the full report round trip works live

Same TUI, hook command = `tee <dump> | node report-session.mjs --provider codex --context <ctx>`
against a stub workspace host: the dump appeared, the reporter exited 0, and the stub received
`POST /api/agent-conversation {"id":"codex-probe-pane","conversation":"01a0916f-e723-…","agent":"codex"}`
— the same route claude's and kimi's hooks report on, under codex's own name. The per-launch
context rewrite on identity change is covered by `orchestrator/tests/report-session.test.mjs`
(the codex provider case), as is the reporter's exact-args composition by
`orchestrator/tests/agent-registry.test.mjs`.

## Caveats observed while probing

- The TUI's "Update available!" nag blocks startup on a modal; a person answers it and moves
  on. It is a pre-session dialog, so it does not affect the hook.
- The model call is irrelevant to the hook: SessionStart fires at session submit, before the
  first model response, so an account at its usage limit still reports (verified: this whole
  probe ran against a limited account).
- `codex exec` does not run SessionStart hooks at all; rEngine launches interactive panes, so
  this does not affect the integration, but a headless `exec` path would need another channel.

## Control check: claude still reports, same day

Claude's per-launch `--settings` path (the reference this codex work mirrors) was re-verified live
against Claude Code 2.1.266 the same day: launched exactly as `agentLaunch` composes it under a
PTY, SessionStart fired at startup with no approval prompt — claude has no trust gate for this
channel — and the stub received
`POST /api/agent-conversation {"id":"claude-probe-pane","conversation":"63244892-c75b-4574-bf3f-af42a936f8dd","agent":"claude"}`,
the conversation being exactly the id the launcher minted (`source: "minted"`). No prompt was
sent, so the check spent no model tokens.
