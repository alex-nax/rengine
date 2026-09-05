# Native terminal burst and reconnection evidence

Date: 2026-09-06. Parent checkpoint: `0b601211e0d40b6c20b2b1bf6d005270b5249579`.
Scope: [spec 059](../specs/059-native-terminal-recovery.md), the owner's report that neither the
resumed agent nor its neighboring shell accepted input. All 15 feature gates remain false.

## Actual handoff and repair authority

The real resumed conversation reported `RENGINE_ORCHESTRATOR_SESSION` as
`bc3ecd45-f85e-4216-a3fc-46f9b93925bb`. Calls to the available root-bound rEngine MCP
`workspace_info` and `list_sessions` returned root `046c207b-f579-4225-a517-8fe282e33e40`,
`/Users/alex/rengine`, and the matching running agent PID 33534, with its exact handoff and
`waitingForView: false`. Thus the real CLI crossed the native presentation gate and reached MCP.

During the subsequent freeze report, that desktop and agent exited and the same conversation
was resumed externally. Its orchestrator environment marker was then absent and the scoped MCP
tools were no longer available. The owner's new input authorized this bounded repair outside
the orchestrator; broader NOLF work was deferred. No new goal, conversation or provider run was
started for these tests. Final read-only state inspection confirmed the original retained
service PID 33465 and user shell PIDs 33500/39735 still running; they were not stopped by tests.

## Regression and consumer path

- Before the fix, animated ANSI alone passed (6.17 s), while an 8,000-event burst made native
  input produce no response in the real PTY (failed, 14.15 s). Both panes share the same stream.
  A full 128-message receive queue returned failure, killing its worker; the disconnect event
  could be lost in that queue. The UI still reported connected and accepted undelivered input.
- The final test feeds ANSI cursor clears, Unicode, color and synchronized-update escapes
  through a real Node PTY, fills the native queue with stale output events, then types through
  native SDL events in that PTY and a real shell. Assertions require output from executed input.
- A local TCP proxy interrupts the connection. The UI reports loss, rejects offline typing,
  reconnects to the same endpoint and waits for fresh terminal attachments. Both original PTYs
  accept new input, keep their PIDs, and the session count remains two. Offline input is absent.
- The final screenshot was visually inspected: the retained terminal shows
  `INPUT_RECEIVED_AGENTALIVE` and restored connection status. The font displays the spinner as
  a missing glyph; this is a font-coverage limit, independent of the transport failure.

`RENGINE_TERMINAL_REPLAY` additionally replayed 803,215 bytes of the ended real Codex session's
retained output through that PTY before the animation/burst/outage checks: pass, 8.69 s. Local
recording `.cache/session16-codex-replay.ansi`, SHA-256
`ffe18956ac97704e67eae2cdab1fb54118dc61d191e68de7fa5424c68ef8e5a9`, remains ignored/private.
It is neither exported as training data nor committed. This is byte replay, not another live
provider qualification. No original-window queue trace establishes its exact failure timing.

## Final verification

| Command | Result |
| --- | --- |
| `env -u RENGINE_WORKSPACE_CONTEXT -u RENGINE_HANDOFF_GATE -u RENGINE_HANDOFF_FILE -u RENGINE_ORCHESTRATOR_SESSION npm test` | 20 service/agent tests passed, 4.30 s; inherited handoff context removed only for isolated standalone test children |
| `RENGINE_TERMINAL_REPLAY=/Users/alex/rengine/.cache/session16-codex-replay.ansi node --test orchestrator/tests/native-terminal-recovery.spec.mjs` | Passed, 8.69 s |
| `npm run test:desktop` | Build plus five native tests passed, 41.89 s: game texture/capture, once-only handoff/reload, pane navigation, terminal recovery, tree/editor/PTY |
| `ctest --test-dir .cache/desktop --output-on-failure` | Two C tests passed, 0.45 s |
| `./init.sh`; `python3 tools/features.py next`; sidecar checks; `git diff --check` | Passed; inventory unchanged |

Local evidence hashes (SHA-256):

| Artifact | Hash |
| --- | --- |
| `.cache/desktop/bin/rengine` | `a2a5125a82230395923bf70e45c3d6305d4e1304959e3cc8b7fc144a80d8429f` |
| `.cache/evidence/native-terminal-recovery.png` | `05716d50d8e0989944a053df0ed60e672e0482d08d8b97be1139949b7a2eecb2` |
| `.cache/session16-real-output-replay.log` | `2def2e8da55e272536ecd8574d4554d508c58cfa67a3555f9d1b9c6456b7624a` |
| `.cache/session16-final-desktop.log` | `2d4f13bfbf19f33333128deb688877753143a5ee06fdcc6f45ce370505084d43` |
| `.cache/session16-baseline-service.log` | `60f84e5d56e1d65acbda7270a6451976bd91edaac2c697374227880e4ba630e0` |

One intermediate proxy run received unrelated native typing and changed selection before the
outage assertion. Automation windows now carry a distinct title; the repeated isolated check
and final suite passed. No assertion was suppressed. Test-owned GUIs, proxies, services and PTYs
were cleaned up. Windows runtime, service identity/address replacement, terminal scrollback,
complete CLI escape/font coverage and NOLF KI-024 remain outside this proof.
