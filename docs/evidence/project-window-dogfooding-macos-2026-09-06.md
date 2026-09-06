# Project-window dogfooding — macOS, 2026-09-06

Specs 069–071 implement managed project windows, durable integration reports, project skills
and interactive shell tabs. The real NOLF window and shell menu were inspected through the
same authenticated APIs used by the tests. No game, replacement conversation or goal was launched.

## Consumer evidence

- The shell `project-window.sh` adopted original host instance
  `e9c3dbfd-83cf-4b2f-8cd0-555b80998335` into supervisor PID 44390, then opened NOLF window
  `4c55dec7-f1e5-4626-9286-01e8d37ef8f2` (initial native PID 44393).
- Native inspection shows its tree at NOLF root `9b7d8206-3542-4092-b8e6-f226b3ff3cba` and the
  original rEngine-bound agent `a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a` attached. Its CLI stayed PID
  20049. The original GUI stayed attached independently; no keyboard bootstrap was needed.
- The NOLF-bound agent delivered actual report sequence 2 requesting independent pane zoom.
  rEngine read and acknowledged it. KI-036 records intake; no zoom implementation is claimed.
- Live update job `999b2ed9-97db-464b-ab01-3778c6f17316` replaced workspace/native/connector layers
  successfully, retaining the same host and coding sessions. Replacement native PID: 98003.
- `open_script`'s CLI fallback opened the read-only `workspace-status.sh` interactive menu in
  that window: retained session `d102f6bd-61d7-4b6a-b14b-bf0bf28afc6a`, PID 7298. Inspection
  verifies attached state and the visible selection prompt. The human chooses its menu options.

Local screenshots `.cache/evidence/nolf-project-window.png` and
`.cache/evidence/nolf-interactive-flow.png` were inspected. They contain real terminal content
and stay private. IDs/PIDs above are observations, not assumptions for the next agent.

## Gates

MCP discovery regressions failed before window tools (2.44 s) and script tools (2.42 s) existed.
The native fixture uses an instrumented CLI as an agent stand-in in real PTYs, two native windows
and independent root-bound MCP clients. It verifies independent selected layouts, dirty draft
retention, no disk save, same-agent PID/invocation, screenshots, focus/close/reopen, root rejection,
report retries/cursors, worker/tool replacement and store reload. Interactive script checks cover
literal argv, escaped/symlinked paths, detach/reattach while waiting, native text input and completion.
An old desktop rejects script launch before process creation. Production control rejects test input.

Final commands (with inherited handoff variables removed only from test children):

- `npm test`: 27 passes, 4.76 s (`.cache/session21-service-pass.log`).
- `npm run test:desktop`: 13 passes, 103.92 s (`.cache/session21-desktop-complete.log`), including
  concurrent F57's committed renderer check.
- CTest: four passes; design/harness/inventory checks pass; shell syntax passes. ShellCheck is
  unavailable and was not installed. Real PTY tests qualify hidden input and Ctrl-C exit 130.
- Bundled sidecar tools: 19 tests pass. Six skill entry points validate. The measured sidecar
  tradeoff and provenance are recorded in `sidecar-efficiency-2026-09-06.md`.

One full service run exposed a test observation race: update_status could finish on an older
MCP worker while the update completed. The poll now observes the required next-request worker
replacement as well as job success. Another failure caught a changed reload error contract;
the broker now preserves the action-specific message. Final gates above include those repairs.

Windows runtime/packaging and the prior source-transfer destination approval remain unqualified.
Reports are explicitly polled data, not automatic agent turns. Simultaneous multi-window editing
of one file remains outside a collaboration contract. NOLF gameplay/menu correctness is KI-024;
window and transport evidence do not qualify it. Stable supervisor/PTY-host protocol migrations
retain spec 065's quiescence boundary.
