# Resume development inside the orchestrator

Owner direction: pause broader NOLF workspace development here. Prepare the next session to
resume this exact Codex conversation in the native orchestrator. C/microui remains the GUI.

`npm start -- --handoff FILE` reads a version-1 JSON manifest with a project path relative to
the manifest, an explicit Codex session UUID, and a checkpoint document relative to the project.
Reject missing/mismatched session metadata, missing checkpoint, conflicting project/agent options,
missing CLI, unsupported resume or missing login. Never substitute `--last` or a new conversation.
Keep credentials and machine-specific runtime records outside Git. The checkpoint carries the
goal, proven work, outstanding issues and next steps; it does not claim to transfer a scheduler.

The service prepares one retained agent PTY for the project/conversation. Its bootstrap waits
until a native terminal view is attached and presented before invoking `codex resume UUID PROMPT`.
Failed GUI startup leaves a waiting session visible in the session browser; reopening can release
it. Concurrent launches reuse the same live handoff session; unrelated agents are not reused.
An explicit Stop or real process exit allows a later explicit launch to resume again.

Cmd+Shift+R / Ctrl+Shift+R flushes drafts/layout, closes the desktop, rebuilds it, and opens it
against the same retained service. Build failure reports the error and leaves sessions retained.
Normal window close still detaches. Reload never sends another continuation prompt or restarts
the running agent. This reload covers native code; service changes require a separate explicit
service restart, and the Codex conversation can then be resumed through the manifest.

Acceptance: invalid prerequisites create no new CLI; a real PTY with an instrumented Codex
executable cannot start before native presentation; actual resume arguments and MCP bootstrap
reach that PTY once; repeated launch and native reload retain its PID, output and drafts.
Inspect the installed real Codex resume/auth prerequisites without resuming the actively written
conversation in parallel. macOS runtime proof and Windows implementation coverage are distinct.

The calling environment has no goal-pause API. Preserve the user's pause in the handoff and agent
instructions, stop work here after preparing it, and request the application's Pause goal control
if the scheduler remains active. Do not mark an unfinished goal complete or blocked as a substitute.
