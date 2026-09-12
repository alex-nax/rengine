# F146 — design.py learns a Rust target (2026-09-12)

Slice of the JS-retirement epic (spec 129, charter D41/D57). `tools/design.py` now emits a Rust
target beside the `.mjs` and `.h` outputs: `red/red-core/src/theme.rs`, carrying the product
name/family and the theme constants (typography, every literal and token-resolved metric, preset
names, and the `[preset][colour]` RGBA tables theme.c carries). No Rust source hand-writes what
D41 made a data edit. J0's only non-deleting slice; it unblocks every later row's generated
constants.

## Acceptance criteria and where each is proved

1. **design.py generate emits the Rust source; design.py check fails on a hand-written
   product-name occurrence in Rust sources, as for the other targets.**
   - Emitter: `tools/design_rust.py` (pure formatting; design.py resolves), called from
     `theme_sources`, which now returns the Rust text as its third value. `generate` writes
     `red/red-core/src/theme.rs`; `check` compares it like the other outputs.
   - Guard: `PRODUCT_ROOTS` gained `red`, `PRODUCT_SUFFIXES` gained `.rs`, `PRODUCT_SKIP` gained
     `target` (cargo's build output is not shipping code), `PRODUCT_ALLOWED` gained the generated
     module, and a `.rs` occurrence hints `red_core::theme::PRODUCT_NAME`. `design.py product`
     reports all three generated files.
   - Automated: `orchestrator/tests/rust-design-target.test.mjs` (3 subtests) — the module carries
     the declaration (name, family, typography, every metric, preset and colour counts), both
     crates read it, and an out-of-tree `.rs` decoy (comment + string + enum variant) is caught in
     both code positions with the comment left alone.
2. **red-core and red-link compile against the generated constants, and a rename rehearsal
   changes only theme.json.**
   - red-core exposes `pub mod theme` and re-exports the name pair; red-link's version line opens
     with `red_core::theme::PRODUCT_NAME`; `red-link/tests/cli.rs` asserts the line starts with
     the generated constant.
   - Rehearsal below: only `theme.json` was edited by hand.

## Gates (all green after the change)

- `python3 tools/design.py check` — consistent; guard scans 5 shipping roots including `red`.
- `npm test` — 278/278 (was 266 at the slice's start; +3 is this test file, the rest are the
  parallel companion session's).
- `ctest --test-dir .cache/desktop` — 15/15, including `rust_red_core`/`rust_red_link`.
- `cd red && cargo test --workspace` — 5 + 2 + doc-tests green.
- `./init.sh` — harness checks passed.

## Red-for-own-reason record

The new test was run before implementation: all 3 subtests failed for the slice's absence
(no theme.rs, no `pub mod theme`, guard blind to `.rs`). After implementation:

1. **In-tree decoy** `red/red-core/src/decoy_sabotage.rs` with `"rEdit"` in a `pub const` →
   `check`: `decoy_sabotage.rs:1: hard-coded product name 'rEdit'; use
   red_core::theme::PRODUCT_NAME from red/red-core/src/theme.rs (spec 108)`. Same for `"Red"` at
   line 2 of a red-link decoy, line number exact. Files deleted; check green again.
2. **Stale output**: one digit edited in `theme.rs` → `check`: `red/red-core/src/theme.rs is
   stale or missing (run generate)`. Regenerated; green.
3. **Broken consumer**: `pub mod theme;` commented out of red-core →
   `error[E0432]: unresolved import 'theme'`, red-core fails to compile. Restored; workspace
   tests green. (Restore note: `git checkout` was the wrong tool here — it reverts to HEAD, not
   to the uncommitted edit; the module block was re-applied by hand and the detour is recorded so
   the loop's later slices use a file backup for sabotage of uncommitted work.)

## Rename rehearsal (criterion 2's proof)

`product.name` set to `Verde` and `rEdit` moved to `retired` in `theme.json` — the only hand
edit. Then `design.py generate` and:

- `design.py check` **green**: the guard scanned for `Verde`, `Red` and retired `rEdit` and found
  nothing hand-written; all generated outputs agree with the declaration.
- Changed files: `orchestrator/native/theme.json` (the edit) + `theme.h`, `product.mjs`,
  `theme.rs` (regenerated). `theme.c` and every hand-written source untouched.
- `cargo test --workspace` **green**: cli.rs asserts `starts_with(red_core::theme::PRODUCT_NAME)`,
  so the binary introduced itself as `Verde red-link 0.1.0 …` with no source edit.

Restored by backup + regenerate; final `git status` shows exactly the F146 change set and
`design.py check` is green.

## Notes for later slices

- `uncommented()`'s C path scans `.rs`: lifetimes like `'static` read as unterminated quotes, but
  every non-comment byte still lands in a scanned chunk, so a name cannot hide behind one.
- The 1,000-line ceiling on owned sources is why the emitter is `tools/design_rust.py` rather
  than more of `tools/design.py` (994 lines after wiring).
- `PRODUCT_NAME` values pass through `json.dumps(..., ensure_ascii=False)`: Rust string escapes
  match JSON's for the printable range, and non-ASCII passes as UTF-8, which a Rust source is.
