# Initial harness verification — 2026-09-05

Scope: local rEngine setup on macOS. These results do not certify any game, device,
shared-runtime integration, catalog package, training job or supported-platform matrix.

## Results

- `./init.sh`: passed repeatedly, including invocation from an unrelated temporary directory.
- `bash -n init.sh`: passed.
- `python3 tools/features.py validate`: 30 proposed features; structure and dependency graph pass.
- `status`, `next`, `show`, `graph`: exercised. The real proposal offers no executable feature.
- Generated `docs/roadmap-graph.md`: byte-identical to fresh helper output.
- Local Markdown document links: resolve.
- Sidecar `stamp` after note review and `check tools/features.py`: clean.

## Focused CLI checks

Temporary JSON fixtures were passed to the real helper through subprocess invocations. They were
removed after checking; the approved fixtures were synthetic CLI inputs, never an owner approval
or an activation of the real roadmap.

- duplicate-id: passed.
- unknown-dependency: passed.
- cycle: passed.
- boolean-id: passed.
- invalid-priority-type: passed.
- missing-evidence: passed.
- proposed-next: passed.
- approved-next: passed.
- host-handoff: passed.
- missing-review: passed.
- passing-with-unmet-dependency: passed.
- malformed-json-and-shape: passed.
- bootstrap-outside-repository: passed.
- graph-reproducibility: passed.
- local-document-links: passed.
- all-query-modes: passed.

## Corrections during verification

The first document-link pass detected the not-yet-written progress file; final verification ran
after adding it. Inspection also identified a malformed-priority edge case that could produce a
Python TypeError; validation now rejects a non-string priority cleanly, with a negative fixture
confirming the error path.

## Limits and reproduction

The persistent local gate is `./init.sh`; inspect a deliberate fixture with
`python3 tools/features.py --file /path/to/fixture.json validate` (or `next`). The temporary
negative-input matrix is recorded here rather than installed as a second product test suite.
The helper validates evidence references structurally; it cannot authenticate owner review or
prove referenced acceptance evidence on its own.

No sibling project was modified or built. Source observations and file hashes are in
`docs/source-inventory.json`. Package publishing, service operation, game/device launches and
training remain outside this initialization.
