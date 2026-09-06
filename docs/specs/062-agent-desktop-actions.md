# Agent-requested desktop reload

Date: 2026-09-06. The owner explicitly requests that an agent can invoke the Cmd/Ctrl+Shift+R
routine, preferably through MCP. Add root-bound desktop discovery and an explicit reload action.

Authenticated native desktops register their displayed project/session bindings and whether
they were started by the reload-capable launcher. MCP lists only desktops associated with its
immutable bound root. A reload requires an explicit desktop ID; never broadcast to every view
or infer the target from focus. Reject unknown actions, stale IDs, foreign roots, unsupported
clients and concurrent requests. A bounded acknowledgement distinguishes accepted from timeout
or rejection. An acknowledgement means the native routine was requested, not that its build
has succeeded. Re-list desktops to observe replacement after rebuild.

The native request sets the same reload state as the keyboard shortcut. Both paths flush local
drafts/layout, cancel on persistence failure, and use launcher exit code 75 for rebuild/reattach.
Neither path stops the sidecar, terminal, agent or game, sends a continuation prompt, or creates
a conversation. Normal native close still detaches. A direct binary reports unsupported reload.

The service advertises desktop-actions protocol version 1. New desktops only register against
that capability; retained older services remain usable and report that agent actions need a
service upgrade. Loading new service/MCP code is separate from reloading the native executable.
Do not stop this session's retained service to bootstrap the new action. Existing keyboards
remain usable; no OS keystroke injection or hidden replacement sidecar is introduced.

Write a failing MCP consumer check before implementation. Verify authenticated registration,
root isolation, stale/unsupported targets, acknowledgement timeout and same-request handling.
Then exercise the actual MCP call against a real native launcher with a dirty draft and a
retained instrumented CLI, proving rebuild, draft recovery, unchanged PID and one continuation.
