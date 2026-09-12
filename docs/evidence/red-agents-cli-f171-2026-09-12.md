# F171 (F149a) — the red-agents binary speaks the registry to its shell callers (2026-09-12)

The first slice of F149 (spec 129, KI-093, filed under the KI-092 standing rule). The
`red-agents` binary now carries the registry's shell surface — `list [--names]`, `show <agent>
[field]` byte-exact with the registry.mjs CLI, error paths included — plus the three
conversation flag parsers and the codex hook key/trust-hash math; agent.sh dispatches its
registry reads to the binary with its own CLI unchanged. Criteria 2 and 3 of the parent row.
Nothing deleted; F172 (report-session) and F173 (the server-side consumers and the deletion)
follow.

## Acceptance criteria and where each is proved

1. **Codex hook key and trust-hash computation matches codexHookKey/codexHookTrustHash
   byte-exactly on the evidence fixture set.** `red-agents/src/hooks.rs`: the key names codex's
   synthetic session-flags layer per platform (`hook-key [--platform P] [group handler]`); the
   hash is `sha256:` over compact canonical JSON of the normalized identity — keys sorted
   recursively for free from serde_json's BTreeMap, so the hashed bytes are identical to the JS
   side's. `red-agents-cli.test.mjs` compares both against the live JS on fixed commands and
   pins two literals computed from the JS side today
   (`sha256:12f31cc1…`/`sha256:8626ba99…` on the canonical command, matchers `startup|resume`
   and `startup`). Note on the fixture set: the 2026-09-11 evidence doc records the formula and
   a live hash with machine paths embedded (`sha256:01bab799…`); the portable pinning is the
   formula plus fixed commands, so drift in either side fails — tampering the hashed identity
   (timeout 600→601) and pretty-printing the canonical JSON both went red.
2. **agent.sh's CLI (list/show/check-resume/install/update) is unchanged to its callers while
   dispatching to red-agents.** Resolution: `$RENGINE_RED_AGENTS`, then
   `red/target/{debug,release}/red-agents` beside the repo, then a named fallback
   (`The red-agents binary is required…`), mirroring the old node resolution's honesty. The
   dispatch is proven by running agent.sh with `RENGINE_NODE=/nonexistent` and getting the five
   recipes; the pre-existing end-to-end install/update runs are untouched and green, and the
   file now builds the binary first so a fresh checkout is self-sufficient.
3. **The registry's shell surface is byte-exact.** list/show/show-field against the registry.mjs
   CLI on the shipped five plus an EXTRA-file recipe (the CLI honors
   `RENGINE_AGENT_REGISTRY_EXTRA` like the JS one did — caught when the end-to-end testcli run
   failed on exactly this), with `No agent named nope is registered.` / `The registry has no
   NOPE for claude.` / usage exit 2 compared too. The conversation parsers answer the same
   `{id, source}` as the JS parsers on 22 recorded argv cases (uuid/ULID shapes hand-rolled —
   case-insensitive, the i flag's lowercase-ULID acceptance included — with no regex
   dependency).

## Gates (green after the change)

- `node --test orchestrator/tests/red-agents-cli.test.mjs` — 4/4.
- `cd red && cargo test -p red-agents` — 18/18 (6 new: id shapes, three parser suites, key,
  hash).
- `npm test` — 290/290. `ctest --test-dir .cache/desktop` — 16/16. `./init.sh`,
  `python3 tools/design.py check` — green.

## Red-for-own-reason record

The CLI test ran before implementation: 4/4 red (no `red-agents` binary target). After
implementation, each sabotage with a file backup and a restore:

1. **timeout 600→601 in the hashed identity** → the codex hook test red (the hash moved).
2. **agent.sh resolves `red-agentz`** → the agent.sh test red with the named fallback.
3. **uuid_shape drops its length check** → first run **proved nothing on the JS side** (no
   fixture had a 35-char id; the Rust unit test alone would have caught it). Added the 35-char
   fixture to the parity cases; the sabotage then goes red on BOTH suites. Restored.
4. **pretty-printed canonical JSON** → the hash test red (the bytes changed, the hash moved).

## Notes for F172/F173

- `red-agents` resolves the registry document as `$RENGINE_AGENT_REGISTRY`, else
  `orchestrator/agents/registry.toml` relative to the binary (debug/release both work); F172's
  report-session should resolve it the same way.
- The parsers' `Parsed` shape `(Option<String>, &'static str)` is what F173's identity port
  consumes; the JS parsers stay the reference until registry.mjs is deleted there.
- agent.sh still execs `RENGINE_NODE` for the workspace launcher (launch.mjs) at line ~194 —
  that is F173/F163's removal, deliberately untouched here.
