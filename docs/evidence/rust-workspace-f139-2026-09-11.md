# F139 evidence: the Rust toolchain and red/ workspace in the build

Date: 2026-09-11. Machine: macOS (aarch64). Slice: **F139** (spec 128, D57), the first slice of
the JS-retirement epic (spec 129) — taken by the epic's own rule (`features.py next` showed zero
ready J0 rows; F139 is the gateway they all depend on).

## What was built

- `rust-toolchain.toml` at the repo root: `channel = "1.93.1"`, an exact version. Verified live:
  `rustup show active-toolchain` inside the repo reports `1.93.1-aarch64-apple-darwin (overridden
  by '/Users/alex/rengine/rust-toolchain.toml')`; in `/tmp` it reports the default `stable`. The
  pin is repo-scoped and changes nothing machine-wide.
- `red/` cargo workspace: `red-core` (rlib, `CONTRACT_VERSION` + unit test) and `red-link`
  (binary, `--version` + two CLI integration tests). **Zero registry dependencies** — the
  committed `red/Cargo.lock` names exactly two local packages. The dependency-vendoring policy is
  deferred to F140, which lands the first real one (prost).
- `cmake.toml`: Corrosion fetched at configure, pinned by full commit sha
  `1499b14e4906a2890f5cee1547c8848db261753d` (tag `v0.6.1`), `corrosion_import_crate(MANIFEST_PATH
  red/Cargo.toml CRATES red-core red-link)`, and `rust_red_core` / `rust_red_link` ctest entries
  running `cargo test` from the workspace root (so the rustup shim resolves the pin).
- `init.sh`: requires cargo and the pinned toolchain; prints the exact `rustup toolchain install`
  line on failure; installs nothing.
- The acceptance check `orchestrator/tests/rust-workspace.test.mjs` (7 subtests) pins all of the
  above mechanically, including the exact Corrosion sha.

## Criterion-by-criterion results

| Criterion | Evidence |
| --- | --- |
| cmake --build builds red-core and red-link, generated CMakeLists committed, design.py check green | Build log: `Compiling red-core v0.1.0`, `Compiling red-link v0.1.0`, `Finished release profile`, `Copying byproducts red-link to .cache/desktop`, `Built target cargo-build_red-link`; the clean-tree rebuild (`rm -rf .cache/desktop && npm run build`) reproduces it; `.cache/desktop/red-link --version` prints `red-link 0.1.0 (red-core contract 0.1.0)`; `design.py check` green |
| Toolchain pinned; Corrosion pinned by commit; no fetch outside the two pins | `rust-toolchain.toml` (1.93.1); `cmake.toml` GIT_TAG sha; `red/Cargo.lock` has zero registry packages; `third_party/README.md` records the Corrosion pin and license |
| init.sh without cargo fails with instructions; with cargo proceeds; nothing installed silently | `env PATH=/Users/alex/miniconda/bin:/usr/bin:/bin ./init.sh` → exit 1, `ERROR: Rust (cargo) is required … rustup toolchain install 1.93.1`; `channel = "9.99.9"` (restored after) → exit 1, `ERROR: the pinned Rust toolchain 9.99.9 is not installed. Run: rustup toolchain install 9.99.9`; normal run passes |
| Both crates' smoke tests run through ctest | `ctest --test-dir .cache/desktop -R rust_ --output-on-failure`: `rust_red_core` and `rust_red_link` pass; full suite 15/15 |

## Regression establishment (red observed for its own reason, then restored)

| Sabotage | Observed |
| --- | --- |
| Initial run before implementation | 7 subtests fail: ENOENT on `rust-toolchain.toml`, `red/Cargo.toml`, crate manifests; assertions on missing Corrosion block, missing ctest entries |
| `channel = "stable"` | `channel "stable" is an exact version, not stable/nightly` |
| `GIT_TAG 1499b14e` → `1499b14f` in cmake.toml | `cmake.toml pins Corrosion to v0.6.1 by full commit sha` |
| cargo removed from PATH / pin set to `9.99.9` | init.sh exits 1 with the instruction lines quoted above |

## The Corrosion toolchain-resolution finding (the one non-obvious risk)

`Rust_RESOLVE_RUSTUP_TOOLCHAINS` defaults ON in Corrosion v0.6.1's `FindRust.cmake`: it runs
`rustup toolchain list --verbose` and selects the toolchain rustup marks active. Because
configure is driven from the repository root (build.mjs, npm scripts, humans in the checkout),
the active toolchain is the one `rust-toolchain.toml` names. Proof on this machine:
`.cache/desktop/CMakeCache.txt` carries `Rust_TOOLCHAIN:STRING=1.93.1-aarch64-apple-darwin`
with `Rust_TOOLCHAIN_IS_RUSTUP_MANAGED:INTERNAL=TRUE`. Today `stable` and `1.93.1` are the same
compiler, so a wrong selection would be invisible — the cache line is the evidence the right one
was picked. The ctest smoke tests additionally run cargo from the workspace root, where the shim
provably resolves the pin. If a future configure is ever driven from outside the repo, set
`-DRust_TOOLCHAIN=<pin>-<host-triple>` explicitly; the triple keeps that out of the TOML.

## Decisions taken in the slice (recorded, small)

- **Corrosion via FetchContent pinned by sha, not a `third_party/` submodule.** It is build
  tooling, the same shape as the pinned cmkr bootstrap in `cmake/cmkr.cmake` (fetched at
  configure into the build tree), not a vendored compiled source; `iklib` is the only submodule
  and it is one. The pin lives in `cmake.toml` next to its only consumer, and
  `third_party/README.md` records it beside the cmkr row.
- **`red-core` is rlib-only.** The cdylib + C ABI arrives with the slice that has a consumer
  (spec 128 decision 7), not before.
- **Edition 2021, `resolver = "2"`.** Nothing needs edition 2024 yet; the resolver is explicit.
- **`red/Cargo.lock` committed, `red/target/` ignored.** The lockfile is the dependency pin;
  build output is not.
- **Toolchain installed through the owner's rustup by hand (`rustup toolchain install
  1.93.1`)**, reported here; reversible with `rustup toolchain uninstall 1.93.1`.

## Gates after the change

`npm test` 266/266 (259 baseline + 7 new), full `ctest` 15/15, `./init.sh` pass,
`python3 tools/design.py check` pass, `python3 tools/features.py validate` pass.
