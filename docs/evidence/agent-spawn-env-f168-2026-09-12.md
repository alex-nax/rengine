# F168 (F148b) — the spawn-environment composition is one pure function in both languages (2026-09-12)

The spawn half of F148 (spec 129, KI-092; owner-approved split). The RENGINE_AGENT_*
composition — the pane-identity family, the workspace trio, the mint/refuse/resume rules, the
bare-pane history listing, and the `shellEnvironment` envelope with its cleared-in-both
discipline — is now one pure function on each side: `agentPaneComposition` in
`orchestrator/server/sessions.mjs` (extracted, so the behavior pty.spawn receives is pinned at
exactly that boundary) and `spawn.rs` in the red-agents crate. The `red-agent-env` binary answers
fixtures; the JS suite deep-equals. With F167's evidence this completes F148.

## Acceptance criteria and where each is proved

1. **The composition is pinned at the pty.spawn boundary and ported, consuming the F167 recipe
   projection rather than re-reading the TOML.** `spawnTerminal`'s agent block is a call into the
   extracted function plus the side effects the function returns (context file, listing file,
   conversation record); the full npm suite (285/285) ran behavior-identical before any Rust
   existed. The Rust side reads capabilities through `load_registry` (the F167 parser), never
   the TOML text.
2. **Composed spawn environments for kimi, claude and codex match the current JS output
   exactly, on the enumerated fixtures.** `orchestrator/tests/agent-spawn-env.test.mjs`:
   - mint-when-start-capable (claude bare mints; claude with trailing args still mints and is
     offered nothing),
   - refuse-named-without-start-unless-resume (kimi refuses in its own words, byte-exact; kimi
     and codex resume with CONVERSATION+RESUME set and the record returned),
   - listing only for a bare pane (six remembered rows age every `describe_age` branch; a pane
     with args or a named conversation is offered nothing; the offered list never contains the
     conversation the pane just took — the fixture added when the first sabotage below proved
     nothing),
   - cleared-in-both-compositions (the two-stage final env: stale identity keys gone after both
     stages, the launch's own CONVERSATION/RESUME/ORCHESTRATOR_SESSION surviving),
   - the shell envelope (inherited scrub, explicit-override win, undefined-deletes, win32 key
     and PATH rules), plus the no-capability (gemini), unknown-agent and no-workspace edges
     (argv only, nothing claimed).

## Gates (green after the change)

- `node --test orchestrator/tests/agent-spawn-env.test.mjs` — 4/4 (12 pane fixtures, 4 shell
  fixtures, the two-stage final env, the refuse wording).
- `cd red && cargo test -p red-agents` — 12/12 (7 new: ages, envelope scrub, override/delete,
  win32, mint/refuse, listing gate, no-workspace).
- `npm test` — 285/285. `ctest --test-dir .cache/desktop` — 16/16. `./init.sh`,
  `python3 tools/design.py check` — green.

## Red-for-own-reason record

The parity test ran before implementation: 4/4 red (no `agentPaneComposition`, no
`red-agent-env`). After implementation, each sabotage with a file backup and a restore:

1. **Rust drops the RESUME set** → pane parity red on the resume fixtures. Restored.
2. **JS listing filter includes the current conversation** → red — but only after the fixture
   was added: the first run of this sabotage **proved nothing**, because no fixture had the
   current conversation in the offered list. `the offered list never contains the conversation
   the pane just took` now pins it directly. (The extraction note: the original read
   `listConversations` *after* `recordConversation`, so the filter dropped the just-recorded
   mint; the extracted caller reads before the record — identical output rows, and the ported
   filter is pinned by fixture rather than by faith.)
3. **Rust loses the 'an hour ago' branch** → pane parity red on the 90-minute row. Restored.
4. **JS shellEnvironment always deletes NO_COLOR** → shell fixture `an explicit NO_COLOR
   override wins` red. Restored.

## Behavior notes for the F151/F152 ports (criterion 4 of the epic: undocumented quirks get written down)

- The store read is skipped for a *decided* pane (`chosen = conversation named or args
  present`); the composition applies the same gate internally, and the fixtures exercise it
  there. The caller's skip is an optimization with no observable difference.
- The context file is written *before* the refuse check: a refused spawn still leaves
  `<rootId>.json` behind. Preserved from the original; a later successful spawn rewrites it.
- `conversation` normalizes to null unless the launch environment carries it (the old
  `type !== 'agent' || !env.RENGINE_AGENT_CONVERSATION` rule, now inside the plan).
- `RENGINE_ORCHESTRATOR_SESSION` is both a cleared key and a set key: cleared of the stale
  value, then set to this launch's id.
