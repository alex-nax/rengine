# The declaration reader is Rust (2026-09-14)

F156b, spec 129. `readDeclaration` — the keystone the JS host's `dashboard.mjs`, `devices.mjs`,
`games.mjs` and `tracker.mjs` all read a project through — is `red/red-project/` now, judged against
the record frozen before it moved.

## What moved

The document-level judgements (the 256 KiB bound, the contract table, the contract floors for
`title`, `icon`, `agents` and brand artwork, the icon's exactly-one rule and its design token, the
artwork that must be relative, `.svg` and readable), the format cross-rules, the agents and packs
rules, and the seven sections with their order — devices settle before games and games before
dashboard, so each resolves the references it makes. The cross-field rules of
`device-rules.mjs`, `game-rules.mjs` and `dashboard-rules.mjs` came with them, into
`red-project/src/rules.rs`; the JS copies stay only because `scripts.mjs`, `games.mjs`,
`devices.mjs` and the worker still import them directly.

`orchestrator/server/formats.mjs` went from 386 lines to 169 — what stayed is what RUNS a project's
own commands, a preview, an entry or a byte window, which is the other half of what a format is for.
`project-client.mjs` is the 44-line client both it and `recordings.mjs` ask through.

The contract document is compiled into the binary, the way red-mcp carries its tool surface: a
reader that had to find a file beside itself would stop working when it is installed elsewhere. The
schema subset it validates with is `red_store::schema`, already ported with identical error strings
in F169.

## How it was judged

`orchestrator/tests/declaration-fixtures.json` — **57 cases, 44 of them refusals**, recorded from the
JavaScript before it was replaced. The Rust matched **56 exactly on the second run**; the first run
differed on four, three of which were one mistake: a pack is named by its `name` where every other
record here is named by its `id`.

**The 57th is the JSON parser's own wording** — V8 says `Expected property name or '}' in JSON at
position 2`, serde says `key must be a string at line 1 column 3`. No port can reproduce another
runtime's parse message, so that case is marked `parserWorded` in the corpus and held to the prefix
a person reads first, with every other field compared exactly. It is the one deviation in the port
and it is written down rather than quietly excused.

**One rule was missing and the record did not catch it**, because the corpus had no case for it:
`tracker.write` is the only key whose contract floor (6) differs from its block's (5), so it is
checked with the block rather than with the section. `task-writes.test.mjs` caught it. Four cases
were added — the floor, a remote provider, a write that never names `${json}`, and one that does —
and recorded from the JavaScript, which still existed in the working tree for exactly this reason.

| Sabotage | Observed |
| --- | --- |
| artwork is accepted below its contract floor | the contract-7 case answers a declaration where the record has a refusal |
| a section's problem takes the whole document with it | the contract-5 tracker case loses everything but its error |
| a dashboard capture may write outside the root | the action is accepted where the record refuses it |

## And the door answers them

`/api/formats`, `/api/recordings` and `/api/recording` are red-host's now, answered from
`red_project` directly rather than forwarded: what a project declares and what it left behind are
read from the root, not from the host. The spec proves ownership the way the store routes did — with
the backend stopped, they still answer — and a sabotage that forwards them again fails there.

## Gates

`npm test` — **328 of 328**. `cargo test` — all crates. `native-identity` and `native-dashboard`.

JavaScript on the app path: **6,533**, from 6,743.
