# F167 (F148a) — the agent recipe registry becomes one TOML document (2026-09-12)

The data half of F148 (spec 129, KI-092; owner approved the split 2026-09-12: "approved, do
now"). `orchestrator/agents/registry.toml` is now the ONE recipe table: `registry.mjs` (until
F149) and the new `red-agents` crate both parse it through the same bounded subset, cook()
validation runs on both sides in the same words, and a JSON dump from the Rust side proves the
two resolve identical recipes for every CLI. The spawn-env composition half is F168.

## Acceptance criteria and where each is proved

1. **One TOML recipe document is the only recipe table; JS and Rust resolve identical recipes
   for every CLI.**
   - The document: `orchestrator/agents/registry.toml` — the five shipped recipes with absent
     capabilities as omitted tables (TOML has no null), id-shape regexes as literal strings,
     and a `recipes.*` shape the EXTRA file shares.
   - The subset (both parsers implement exactly it, refusing the rest by name with `file:line`):
     comments, `[table]`/`[table.sub]` headers, basic strings, literal strings, integers,
     booleans, one-line arrays. A general TOML dependency on the Rust side would accept a
     superset the JS refuses — the hole would sit exactly where an author makes a mistake, which
     is why both parsers are hand-rolled.
   - cook() mirrored in Rust in the same words (name shape, package, update mode and command,
     MCP/hooks overlay kinds, conversation parser names).
   - The parity harness: `red-agents-dump <registry.toml> [--extra x.toml]` prints the resolved
     atom projection (the harness shape red-contract established in F140);
     `orchestrator/tests/agent-registry-toml.test.mjs` deep-compares it against registry.mjs's
     new `resolvedRecipes()`.
2. **RENGINE_AGENT_REGISTRY_EXTRA still adds agents as data with no code edit, now through the
   TOML path.** The EXTRA file moved JSON→TOML (the contract change KI-092 records — it was
   documented only in registry.mjs's header and the tests, so the surface is those two).
   `agent-registry.test.mjs`'s end-to-end killer test (selectable, launchable with its MCP
   overlay, offered for task spawn, installable, updateable) runs on the TOML form, as does the
   minimal-recipe refusal test. Redeclaration is refused on both sides in the same words.

## Gates (green after the change)

- `node --test orchestrator/tests/agent-registry-toml.test.mjs agent-registry.test.mjs` — 9/9,
  including the cross-language parity and the migrated EXTRA tests.
- `cd red && cargo test --workspace` — all green; red-agents carries 5 lib tests (document
  parse, projection atoms and nulls, subset refusals with line numbers, cook refusals, extra
  merge/redeclare).
- `npm test` — 281/281 (three new parity subtests; `rust-workspace.test.mjs`'s member set
  gained red-agents, the F140-comment pattern for exactly this event).
- `ctest --test-dir .cache/desktop` — 16/16 (`rust_red_agents` added; CMakeLists.txt regenerated
  by cmkr from the edited cmake.toml, never hand-edited; Cargo.lock updated by cargo).
- `python3 tools/design.py check`, `./init.sh` — green.

## Red-for-own-reason record

The parity test ran before implementation: all 3 subtests red (`red-agents` did not exist;
registry.toml did not exist). After implementation:

1. **A recipe leaves the document** (`[recipes.kimi]` removed): `every shipped recipe is
   complete, valid, and named once` and `every consumer reads the one table` both red — the JS
   runtime provably reads the TOML, not a shadow table. Restored green.
2. **Unterminated string** in registry.toml: importing registry.mjs throws
   `orchestrator/agents/registry.toml:17: unterminated string` — file and line named, the way a
   malformed const would not have compiled. Restored.
3. **Rust projection drift** (`resumeLine` → `resume_line` in red-agents): the parity subtest
   `JS and Rust resolve identical recipes for every CLI` red. Restored green.
4. **Data drift** (`stripPrefix = "session_x"` in the document): agent-config's
   `kimi's own flags name the session` red — the behavioral suite pins the exact strip, so a
   data edit cannot silently change pane labels. (The parity test stayed green here by design:
   both sides read the same document; correctness of the atoms is the behavioral suite's job,
   sameness across languages is the parity test's.) Restored green.

## Notes for F168 and F149

- `resolvedRecipes()` on the JS side and `red_agents::projection()` on the Rust side are the one
  comparable shape; F148b's spawn-env work should consume it rather than re-reading the TOML.
- The JS parser is interim by design and retires with registry.mjs in F149; the Rust parser is
  the permanent one.
- registry.mjs exports `REGISTRY_DOCUMENT` (the path) for anything that needs to point a person
  at the file rather than a module.
