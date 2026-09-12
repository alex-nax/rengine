# F169 (F147a) — red-store: the workspace store in Rust, byte-compatible (2026-09-12)

The crate half of F147 (spec 129, KI-091; owner-approved split). `red-store` ports
WorkspaceStore and the bounded schema validator with byte-compatible on-disk behavior, judged
against a corpus captured by driving the REAL JS host through scripted operations — 89
judgements, no drift, both directions. Nothing deleted; the swap is F170.

## Acceptance criteria and where each is proved

1. **Rust reads every store file the JS host wrote in the fixture corpus and vice versa,
   byte-for-byte, both directions; schema.mjs's validator rides as a second module with
   identical error strings.**
   - The corpus (`orchestrator/tests/red-store.test.mjs`): every state op with args, result,
     error(+status) and the workspace.json bytes after it; a readback section; file ops on a
     recorded tree (LF/CRLF/BOM/binary/invalid-UTF-8/>2MiB/symlink-escape, lists with hidden
     entries and child counts, saveText create/ok/stale-409); 24 schema cases covering every
     error kind plus both committed contracts. `red-store-check` replays and judges.
   - Byte parity's rules, discovered and pinned: serde_json runs with `preserve_order` (JS
     insertion order is the on-disk key order; `to_string_pretty` == `JSON.stringify(v,null,2)`
     for the same ordered value); hooks.rs now writes its canonical keys in sorted insertion
     order by hand so the unified feature changes nothing it hashes; TextDecoder consumes a
     leading BOM rather than emitting it (`bom` reports it separately); mint and the clock are
     injectable, with transient temp names on a second injector so a replay's id sequence stays
     aligned while `.UUID.tmp` names stay unique and unobserved.
   - The schema port (`red-store/src/schema.rs`): identical error strings, and error ORDER —
     `required` follows the schema, properties follow the item's key order. Patterns are JS
     RegExp with the u flag; the committed contracts use negative lookahead, which the regex
     crate refuses by design, so fancy-regex evaluates them.
2. **Nothing is deleted and the host's behavior is unchanged; every corpus entry was captured
   from the real JS host, and each ported test was observed failing for the module's absence.**
   The crate is additive (store.mjs/schema.mjs untouched); the capture drives the real
   WorkspaceStore/validateSchema; both harness subtests ran red before the crate existed.

## Gates (green after the change)

- `node --test orchestrator/tests/red-store.test.mjs` — 2/2 (89 judgements replayed;
  vice-versa: the JS store opens the crate-written state and reads the same model).
- `cd red && cargo test -p red-store` — schema unit tests green.
- `npm test` — 292/292. `ctest --test-dir .cache/desktop` — 17/17 (`rust_red_store` added;
  cmkr regenerated; Cargo.lock gained fancy-regex under the F140 pin policy). `./init.sh`,
  `python3 tools/design.py check` — green.

## Red-for-own-reason record

Harness red 2/2 before implementation. After implementation, five sabotages, each red for its
own reason and restored from a file backup:

1. **default_state key order** (conversations before preferences) → every file-bytes judgement
   red — byte parity is key order, not just content.
2. **'Unknown project root.' → '!'** → the error-string judgements red.
3. **Conversation MRU flipped** (append instead of prepend) → the conversations judgements red.
4. **persist writes compact JSON** → the file-bytes judgements red.
5. **uniqueItems condition inverted** → the schema corpus red on `repeats an item`.

## Capture-side lessons (why the corpus was hard to make honest — recorded for F170)

- **Placeholder ids fed back into real calls make fake parity.** The first capture passed
  normalized placeholder ids to the REAL store, which 404'd them all; the replay faithfully
  reproduced the 404s, and the two sides "agreed" on garbage. The capture drives real calls
  with real ids and normalizes only the recordings. This happened twice in one day (root ids,
  then the tree-root id) and is exactly the blind-regressions pattern.
- **Minted-id alignment is by recorded expectation, not by sequence.** The replay answers with
  the ids the recorded run produced (deduped: an idempotent re-add mints nothing), because the
  capture's placeholders number every distinct uuid, arg-supplied ones included.
- **macOS paths have two spellings** (/var/… vs realpath /private/var/…); both the capture and
  the replay canonicalize before substituting <DIR>.

## Boundaries noted for F170 (the swap)

- `list` sorts by codepoint; JS `localeCompare` diverges from codepoint over case and
  punctuation classes the corpus does not use.
- Whole-valued floats would print as `1.0` from serde vs `1` from JS — the on-disk format
  carries ints today; no corpus value exercises it.
- Conversation id-shapes are injected (`IdShape`); the checker wires the three shipped recipes.
  Arbitrary extra-recipe regexes are a decision for the channel slice (or a regex dep there).
- The JS store's per-file operation queue (saveText serialization) is a no-op in the
  single-threaded replay; the mid-save 409 race needs an interleaving hook the store does not
  offer and stays covered by store.test.mjs on the JS side.
