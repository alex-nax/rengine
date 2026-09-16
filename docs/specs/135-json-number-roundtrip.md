# JSON number preservation at the Rust boundary

Date: 2026-09-14. Bounded repair of KI-108 under specs 055 and 069, before further
NOLF game-control work. No accepted feature criteria or layout format change.

## Contract

Reading and returning native workspace state through Rust must preserve the binary64
value represented by each JSON number. In particular, inspecting a project window through
MCP and inspecting its reopened native view must report the same split ratio, selected
editor, tab order and root/session bindings. Keep the exact layout comparison.

The existing native fixture is red at its close/reopen comparison: MCP reports
`0.2300000041723251`, while the native view reports `0.23000000417232513`.
Investigate JSON decoding separately from the desktop's deliberate float32 layout storage;
changing the storage type or adding comparison tolerance would not prove that a transport
preserves its input. The earlier D62 fixture-record correction remains intact.

## Scope and verification

Use the existing pinned JSON dependency's correctly rounded parsing support if the small
regressions confirm the decoder as the cause. Place the requirement in the shared Rust
transport dependency so an independently built MCP binary inherits it. No new subsystem,
dependency version, native layout ABI or retained-host replacement is needed.

Establish both a Rust numeric regression and a fast MCP tool-call regression against a
controlled HTTP response. The expected values come from native float32 values widened to
binary64 and JavaScript's direct parsing of the response, not from Rust's output. Assert
both MCP result representations. Observe each test failing at its numeric assertion before
the fix; the existing native fixture must then pass without weakening its comparison.

Commands:

- `cargo test --manifest-path red/Cargo.toml -p red-core --test json_numbers`
- `node --test tests/red-mcp-numbers.test.mjs` (included in `npm test`)
- `node --test --test-concurrency=1 tests/native-project-windows.spec.mjs`
- `./init.sh`, `python3 tools/design.py check`, `npm run build`,
  `ctest --test-dir .cache/desktop --output-on-failure`, `npm test`.

Record results in `docs/evidence/json-number-roundtrip-macos-2026-09-14.md`.
Sandbox socket refusals are infrastructure failures, not regression evidence. Use isolated
fixture services and native windows; do not restart the owner's host or CLI. The other
session's Projects-modal and rendering-baseline edits remain outside this repair. KI-105's
handoff failure, KI-024's real gameplay oracle and Windows qualification remain separate.
