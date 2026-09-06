# Layered workspace updates

Date: 2026-09-06. The owner requests one final manual Cmd/Ctrl+Shift+R to install an
agent-operated update path. This extends specs 058 and 062 within the active workspace scope.

## Process boundaries

Keep the current authenticated service as the session host. It owns existing PTYs, game
connections, roots and durable workspace state. Never copy its state into a second writer,
relaunch a conversation, or terminate it to activate new workspace code. Existing contexts
remain bound to that host instance and their original root. The host is a retained compatibility
layer; changing its PTY implementation still requires its sessions to finish or explicit Stop.

Add a small local update supervisor with a stable authenticated endpoint. It owns versioned
workspace workers and native desktops, without owning terminal/agent processes. A workspace
worker forwards session/storage operations to the original host and supplies current desktop
actions. Replace workers after authenticated health and host-identity checks. Existing streams
may finish through the previous worker; do not retry non-idempotent requests or interrupt PTY
input merely to unload code. Retire a worker only when its requests and views have drained.
Allow one automatic workspace-worker recovery per explicit generation; a failed recovery leaves
supervisor state/update actions available against the original host. Never restart the host as
a substitute. A crashed MCP tool worker is replaced on the next request through its retained
stdio facade.

The supervisor snapshots the current native executable into a private version directory. For
an agent-requested update, build and probe the replacement before requesting normal native
save/detach. Launch the replacement with the same explicit initial bindings and saved layout.
Build/start failures keep or restore the previous executable, and record failure rather than
claiming success. Native persistence refusal cancels the switch. Normal close detaches views;
it does not restart the desktop or stop the host. Serialize updates and return a job ID with
observable preparing/switching/recovering/succeeded/failed status. Failed means recovery has
finished; report any recovery error separately. Probe new MCP tool code before publishing its
generation; existing facades replace their tool worker between requests and retain an older
working worker if a later source edit prevents the replacement from starting.

## Bootstrap and agent control

The first new native executable reached by the old launcher's existing reload routine delegates
to the new supervisor before opening another window. Pass the inherited host capability and
initial bindings through the environment, never shell interpolation or logged arguments.
Development builds receive explicit Node/helper locations through CMake configuration; no
user-specific home directory is required. Standalone smoke/inspection clients stay available.
Future normal launches use the same supervisor. Bootstrap discovery is locked and validates
host identity; an alive but unavailable supervisor never justifies a duplicate.

New MCP connections use a stable stdio facade and a replaceable tool worker, preserving the CLI
and immutable context across tool implementation refreshes. Root-bound tools expose update
status and explicit layer/desktop actions; their result distinguishes acceptance from completion.
An existing connector loaded before this mechanism cannot retroactively acquire new tools.
Provide a command-line client using the existing RENGINE_WORKSPACE_CONTEXT so this very agent
can issue the same actions without restarting the CLI or asking for another keyboard shortcut.

This is routine workspace/UI/tool updating, not arbitrary process control. No action accepts
shell commands, foreign endpoints, or a replacement root. Tokens and local descriptors remain
private; HTTP and WebSocket authentication/Origin rules remain enforced. Session-host and
supervisor protocol changes requiring quiescence report that boundary explicitly. A machine
crash or an incompatible low-level migration cannot be promised to require no recovery.

## Acceptance

1. Establish a failing consumer check for layered discovery/update before implementation.
2. Start above an older host without desktopActions, retain one instrumented CLI invocation,
   its PID/output/input and root, and prove current workspace actions work through the new layer.
3. Replace workspace code and the MCP tool worker while retaining the client transport, host,
   CLI and active native terminal input. Reject foreign roots/desktop IDs, unauthenticated
   actions, stale descriptors and concurrent update requests.
4. Use the real native desktop to edit an unsaved draft, request a prepared update through MCP,
   observe replacement and recovered draft/layout, and verify one unchanged CLI invocation.
   Exercise the command-line fallback and the old-launcher bootstrap as real consumer paths.
5. Fail candidate worker startup and native build/startup; retain usable old layers and report
   failure. Close the native view normally and prove its sessions stay running.
6. Run affected service/MCP/native gates, sidecar and harness checks; record macOS evidence and
   remaining Windows runtime verification separately. Do not flip broad feature gates.
