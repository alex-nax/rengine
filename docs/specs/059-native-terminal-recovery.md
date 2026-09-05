# Native terminal responsiveness after agent output

The owner reported that the resumed agent view appeared stuck and neither it nor the shell
accepted input. The real conversation did resume and call its root-bound MCP before the desktop
and agent exited. A later user message resumed this conversation externally to diagnose the
handoff failure; this bounded repair is explicitly authorized. Defer KI-024 game-input work.

Animated ANSI output alone stayed interactive. An 8,000-event burst reproduced a failure in
both panes: the full 128-message native receive queue stopped the stream worker, and its
disconnect notification could also be discarded. The UI kept its connected state and accepted
outgoing input into a queue with no worker. This establishes a matching failure mechanism;
there was no trace of the original window's queue at the instant of the owner's report.

Required behavior: output processing remains bounded and responsive; overload cannot silently
leave both terminals permanently disconnected. Report connection loss, recover the same retained
sessions through fresh snapshots, and never replay keyboard input queued on a failed connection.
Attach/recovery must not start a new CLI or repeat a handoff continuation. Session/process exit
remains distinct from transport loss. Retain current drafts and root/session associations.

Exercise native input and emitted PTY output, including animation escape sequences, connection
loss and recovery, retained process identity, and explicit cleanup. Keep the native C/microui
GUI and pinned terminal library. No Windows runtime or full terminal compatibility claim follows
from macOS checks. Preserve existing user shells/service while running isolated regressions.

## Implementation and evidence

The stream worker waits for queue capacity with a condition variable; polling releases capacity,
and shutdown wakes blocked producers. Incoming work is capped at 128 messages per UI tick so
continuous output yields to SDL input/drawing. Binary game frames retain their latest-frame slot.
After transport failure, clear unsent input, report disconnect and retry the same authenticated
endpoint after 500 ms. Reconnection refreshes workspace state and reattaches each retained
terminal ID. Input stays disabled until its fresh snapshot arrives. This path neither creates
sessions nor sends another continuation prompt. A replaced service identity/address still needs
explicit launcher reconnection.

`orchestrator/tests/native-terminal-recovery.spec.mjs` exercises actual PTYs and native input
with ANSI cursor clears, Unicode, color and synchronized-update sequences; it then fills the
transport with stale output events and verifies executed input in both PTYs. A local TCP proxy
forces an outage. The test verifies loss/recovery, same PIDs/session count, fresh input after
attachment and no replay of input typed while offline. Test windows identify themselves as
automated verification. All fixture sessions/services are isolated and explicitly cleaned up.

Optional `RENGINE_TERMINAL_REPLAY=/absolute/file.ansi` feeds a local byte recording through the
same real PTY before the controlled animation. This passed using 803,215 bytes from the ended
resumed Codex session; the recording stays ignored/local and starts no provider conversation.
It supplements controlled fixtures, without claiming complete terminal or provider coverage.
See [macOS evidence](../evidence/native-terminal-recovery-macos-2026-09-06.md).
