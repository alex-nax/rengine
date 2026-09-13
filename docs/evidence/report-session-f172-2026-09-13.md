# F172 (F149b) — the hook reporter in Rust, and report-session.mjs deleted (2026-09-13)

Spec 129, KI-093. Started by kimi on 2026-09-12 and finished here after their weekly quota ran out
mid-task; the handover is recorded in Codex-progress.md Session 131.

## What the reporter has to be identical about

The hook runs *inside* somebody's CLI. It may not fail it, it may not write to stdout (a SessionStart
hook's stdout is added to the CLI's context), and everything it reports has to match what the JS
reporter posted, because the host's records and the pane's identity are keyed on it.

So parity is tested against answers the JS CLI itself recorded before it was deleted
(`orchestrator/tests/report-session-fixtures.json`, captured by `report-session-fixtures.mjs`):
fourteen cases covering the three reporting providers, the two refusals, both binding orders, the
gating and the malformed edges. Each case compares the exit code, stderr, stdout, the POST body the
stub host received, and the context file afterwards.

## The ported test, and why its assertions changed shape

`report-session.test.mjs` had been reaching through the module's return value —
`report()` handed back `{ bound, rewrote, posted, was }`. A subprocess cannot, and that summary was
an implementation detail rather than the hook's contract. Every claim it made is now made against
what the hook LEAVES BEHIND: the POSTs the host recorded, the context file afterwards, the exit code
and stderr. The eight tests are otherwise the ones that were there — the launcher's settings file,
the line `bind` prints running with no environment at all, the conversation replacing the identity,
the kimi and codex hooks with their own resume spellings, and the tool worker's next call following
the CLI without a restart.

## One parity gap the port had, found by porting

The JS reporter parsed stdin **outside** its binding check, so a hook handed garbage said so on
stderr even when it had nothing to report to. The Rust port had the parse after the check and
swallowed unparseable stdin into an empty object — which made exactly that case silent. A hook that
cannot say it was handed garbage stays wired up wrong, so the read and the parse moved ahead of the
binding check. The fixtures did not cover it; the ported test did.

## One regression the deletion exposed elsewhere

`preserve_order` had to go on `serde_json` so the POST bodies keep the JS field order byte for byte.
That makes every JSON object in the crate keep insertion order, including the recipe projection the
registry parity test dumps — whose keys had been coming out sorted only because serde_json's default
map is a BTreeMap. The test was asserting an incidental order rather than its own claim; it compares
the SET of CLIs now.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the POST body's fields reordered (`id, agent, conversation`) | `claude-startup-rewrites-and-posts: the POST the host recorded` |
| the launcher writes `node report-session.mjs` into the hook line again | `the hook runs the red-agents binary by absolute path (/Users/alex/.n/bin/node report-session.mjs …)` |
| unparseable stdin swallowed into `{}` again | `trouble goes to stderr and nowhere else (not json at all)` |

## The gates

`npm test` — **297 of 297**, with `report-session.mjs` deleted in the same commit. `cargo build -p
red-agents` clean. The deletion is what c2 asks for: the module is gone and the ported tests are the
ones that would have failed for its absence.
