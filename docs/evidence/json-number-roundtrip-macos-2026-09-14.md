# JSON number preservation — macOS, 2026-09-14

Spec 135; KI-108. Base commit `73c5ef5`. The owner's resumed Codex conversation
`01a07104-f626-7631-afea-0386f16f4e86` was verified through root-bound MCP at
`/Users/alex/rengine`, running as session `04d13d34-887f-4a80-b340-1a66ae2e8919`,
PID 69970. No new goal or conversation was created.

## Diagnosis and failing checks

The native project-window fixture failed at its exact close/reopen layout comparison:
the reopened desktop reported `0.23000000417232513`, while the preceding MCP inspection
reported `0.2300000041723251`. These are adjacent binary64 values. The desktop's float32
storage was not changed: `f64::from(0.23_f32)` is the former value, exactly.

Two small checks isolated the decoder from the desktop:

- `cargo test --manifest-path red/Cargo.toml -p red-core --test json_numbers`
  failed at the decoded ratio's bit comparison: actual `4597454643755220991`,
  expected `4597454643755220992`.
- `node --test orchestrator/tests/red-mcp-numbers.test.mjs` failed after the real
  `project_window_action` HTTP route was reached. Both `structuredContent` and parsed
  `content[0].text` changed that ratio. The oracle is JavaScript's direct parsing of the
  controlled HTTP response, whose ratios are independently generated with `Math.fround`.

Each was observed red for its numeric assertion before the implementation change. The MCP
fixture starts a local HTTP server and the real Rust MCP binary; it invokes no coding agent.
The native fixture uses an instrumented process, not a provider conversation.

## Change and results

Enable `serde_json`'s `float_roundtrip` feature in `red-core`, the shared transport dependency.
The pinned version remains 1.0.151; Cargo.lock and the dependency versions are unchanged.
The locally installed pinned source has distinct decoder implementations selected by that
feature (`serde_json/src/de.rs`, `f64_from_parts`). The feature is inherited when building
`red-mcp` independently as well as through the workspace. No layout tolerance, native type,
ABI, JSON schema, tool declaration or frozen corpus was changed.

| Check | Before | After |
| --- | --- | --- |
| Native float32-to-binary64 JSON decoding | Numeric assertion failed | 1/1 passed |
| MCP number preservation, both result representations | Numeric assertion failed | 1/1 passed |
| Existing native project-window fixture | Exact layout comparison failed | 1/1 passed, 13.20 s |
| Service suite | 352/352 passed | 353/353 passed, 31.44 s |
| Native build and CTest | Build passed; 20/20 passed | Build passed; 20/20 passed, 35.39 s |

The existing native fixture was not edited. It continued past the formerly failing assertion
through dirty-draft recovery, one retained agent PID/invocation, interactive script input,
root isolation, durable reports and supervisor store reload. That is the actual consumer path
for this repair, not a replacement numeric-only assertion. The fast MCP test is included by
`npm test`'s `*.test.mjs` glob; the Rust test is included by CTest's `rust_red_core` gate.

Initial sandboxed service/native attempts failed because loopback listeners were denied
(`EPERM` and service-descriptor timeouts). Those attempts were not counted as red regression
evidence; authorized isolated runs outside that sandbox reached the assertions above.

## Live connector update

After the gates passed, claimed the free project token and called root-bound
`update_workspace` with `layers: ["connector"]`. Job
`a2aa5eb1-d343-4dca-80e0-a9b31008887b` completed successfully. Connector generation
advanced from 2 to 3 and its worker PID from 70146 to 67559. Subsequent MCP workspace
inspection confirmed the same root, conversation, running agent session and PID 69970.
Supervisor PID 20207, workspace-worker PID 68487, host instance
`e9c3dbfd-83cf-4b2f-8cd0-555b80998335` and both desktop IDs/PIDs were unchanged.
Released the project token afterward. No human restart was required.

`./init.sh`, `python3 tools/design.py check`, inventory validation and `git diff --check`
pass. Cargo.lock is unchanged. No annotated source file was edited.

## Scope and coexistence

Other-session Projects-modal, rendering-baseline, charter, inventory and shared-log edits were
present at orientation. This repair does not stage them or mutate their source. No feature
gate is promoted: the inventory remains 61 passing of 144 in the observed working tree.
The full desktop suite was not rerun; KI-105's handoff failure and KI-109's suite visibility
remain separate. NOLF in-world input (KI-024/F118), Windows qualification and the overall
workspace goal remain unfinished. No game was launched and no game/training assets exported.

Private logs are `.cache/resume-20260914-{project-windows,numbers-rust,numbers-mcp}-{before,after}.log`,
plus the service/build/CTest logs of the same prefix.
