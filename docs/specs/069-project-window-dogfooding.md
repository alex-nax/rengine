# Project windows and integration feedback

Date: 2026-09-06. Owner-authorized continuation of the NOLF workspace goal, following spec 065.
The owner requests a new project window with the current agent, inspection/management from that
agent, a return transport for rEngine findings and a routine other agents can bootstrap.

## Contract

Open an explicit absolute project path from a root-bound agent. Attach an explicitly selected
running agent from that original root; never launch or resume another conversation. The project
tree and later project sessions bind to the target root. The displayed existing agent and its MCP
stay bound to their original root. A window title identifies the target project. Repeated opens
reuse the same origin/project/agent window; explicit reopen retains its durable window identity.

Each project window owns a separate layout, retained when closed. Drafts and working-file version
checks remain with the original host; simultaneous editing of the same file in multiple windows
is not a new collaboration contract. Keep the legacy main window's layout separate and unchanged.

Root-bound MCP and context-file CLI expose list/open, inspect, focus, graceful close and reopen.
Inspection returns bounded native state, retained session identity, diagnostic tail and optional
screenshot in a private runtime directory. Control is a narrow supervisor-owned stdin pipe; it
cannot type into panes, invoke a provider, run shell commands or accept arbitrary snapshot paths.
Close uses the existing persistence/input-drain path; failure is reported and never force-kills
an agent. OS focus is a request, not a guarantee of foreground permission. Inspection may contain
visible project/terminal content and stays local unless separately authorized for export.

A durable window record links origin and project roots. Each side can post structured issue/status
reports to the other and poll its inbox using a monotonic cursor. Replies carry window ID, source,
destination, timestamp, kind, summary, detail and optional evidence references. References are
opaque strings, never fetched or executed. Reports are data, never instructions or injected PTY
input. Explicit retry keys deduplicate delivery; mismatch rejects. Reports survive view close and
worker/native/MCP updates. No provider-specific push or automatic agent turn is implied. The same
agent can inspect either side of its own window link through a window-scoped query.

The supervisor is the sole writer of window/report state; workers keep forwarding through it.
The versioned lifecycle/store protocol is stable infrastructure under spec 065's quiescence limit.
Explicit CLI bootstrap may adopt the original host without creating a desktop or CLI, allowing
this existing agent to open its project window even with the older loaded MCP connector.

## Acceptance and verification

1. A real MCP regression fails before the new tools exist.
2. Two real native windows retain independent layouts and one original agent PID/invocation;
   project tree and agent tabs show their distinct explicit roots.
3. Repeat open reuses a window. Inspect/focus/close/reopen work through MCP; close retains the
   agent and unsaved recovery draft, reopen restores the window layout. A production control
   pipe rejects test-only input operations. Screenshot exists and is visually inspected.
4. Reports round-trip through project- and origin-bound MCP contexts, reject unrelated roots and
   duplicate-key mismatches, and survive workspace/connector replacement and view closure.
5. CLI bootstrap/open/list/inspect/report/inbox uses the existing explicit context. No global
   agent configuration or sibling source changes are needed. A runbook and project skill guide
   agents through identity verification, consumer checks, reports and rEngine updates.
6. Run service/MCP tests, affected native tests, CTest, harness and sidecar/skill validation.
   Verify the real NOLF window from the current retained agent; qualify Windows separately.

No game launch is implicit in this capability. NOLF gameplay/menu correctness (KI-024), Windows
runtime/transfer approval and library proof remain separately tracked.
