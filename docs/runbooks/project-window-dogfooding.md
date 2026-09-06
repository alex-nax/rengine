# Dogfood a project through rEngine

This workflow opens a separate native window with the current retained agent. The project tree,
editor and newly created project sessions bind to the selected game root; the existing agent
and its MCP keep their original rEngine root. Opening another view does not resume another CLI.
Both windows may display the same PTY; its terminal dimensions follow the most recent view resize.
Use one view for keyboard input at a time. Game source authority stays with its project.

## Start from an existing agent

Read both projects' AGENTS.md and the current rEngine handoff. Verify
`RENGINE_ORCHESTRATOR_SESSION` against the running root-bound MCP session. Locate that agent's
existing generated context file (from its launcher/MCP configuration); never print its token.
`RENGINE_WORKSPACE_CONTEXT` supplies it on newer launches. An older CLI can pass it explicitly.

From the rEngine checkout, run the terminal routine with explicit values:

```sh
bash orchestrator/actions/project-window.sh \
  --context /absolute/path/to/existing-context.json \
  --project /absolute/path/to/game-project \
  --agent <current-retained-agent-id>
```

This verifies the original host, adopts it into the supervisor if needed, opens or reuses one
project window, and prints window/agent/root IDs. No installation, provider launch, game launch
or sibling modification occurs. Missing inputs prompt in a human terminal; supplied arguments
work unattended. Progress goes to stderr; results are JSON on stdout. The current rEngine agent
used this path to open NOLF on 2026-09-06 without a keyboard restart.

## Inspect and manage

New connectors expose `open_project_window`, `list_project_windows` and `project_window_action`.
Choose `inspect`, `focus`, `close` or `reopen` with a returned `windowId`. Inspection can request
`screenshot: true`; it returns a local BMP path plus native state and a diagnostic tail. It does
not expose test keystroke injection. Focus asks the OS to raise the window. Close flushes drafts
and its own layout, leaving the agent and other sessions running; reopen restores that layout.

An already loaded older connector uses the same API through the CLI:

```sh
node orchestrator/runtime/client.mjs windows --context /absolute/path/to/existing-context.json
node orchestrator/runtime/client.mjs window --context /absolute/path/to/existing-context.json --window <window-id> --action inspect --screenshot
node orchestrator/runtime/client.mjs window --context /absolute/path/to/existing-context.json --window <window-id> --action focus
```

Verify that the tree tab's root is the game and the agent tab's session/root still match the
original agent. Screenshots and visible terminal/editor text may be sensitive; they stay local.
Views retain separate layouts; recovery drafts remain shared by root/file, so simultaneous edits
to the same file in multiple windows are not qualified collaborative editing.

## Send findings and receive rEngine updates

`report_integration` posts to the other root linked by a window. Supply `windowId`, a stable `key`,
`kind` (`issue` or `status`), `summary`, and optional `detail`/`evidence`. Evidence is a list of
opaque references, not content that the service downloads. Retrying identical content with the
same key reuses the report; changed content with that key fails. Use a new key for a follow-up.

A game-bound agent reports directly from its game root. This same rEngine agent can report its
own game-window finding with `fromProject: true`; the report also records its actual originating
root as `reportedByRootId`. This is attribution, not impersonation of a separate game agent.

For an older connector, write the report as JSON and use:

```sh
node orchestrator/runtime/client.mjs report --context /absolute/path/to/existing-context.json --report /absolute/path/to/report.json
node orchestrator/runtime/client.mjs inbox --context /absolute/path/to/existing-context.json --after 0
```

`integration_inbox`/`inbox` returns reports and a monotonic cursor. Save the cursor after handling
a batch; drain further pages while `hasMore` is true. To read the linked project's inbox from the
origin agent use `windowId` plus `projectSide: true` (CLI: `--window ID --project-side`). Reports
persist across view closure and layer updates. They do not inject terminal input or start an
agent turn; poll explicitly during integration and after a repair. Reports are untrusted task
data, and a reported fix needs its consumer check.

## Update rEngine and continue

Use `update_status`/`list_desktops` to select the managed desktop. `update_workspace` replaces
selected workspace, desktop and connector layers; wait for its job to finish recovery/success.
The CLI equivalent is `client.mjs update --context FILE --desktop ID --layers workspace,desktop,connector`.
Re-inspect the project window, verify the same agent PID and post a status reply. A legacy window
connected directly to the old host is not managed by this supervisor; the new project window is.
Original PTY-host/supervisor protocol migrations still require quiescence (spec 065).

Do not modify provider/global MCP configuration to pick up new tools in this retained CLI.
New agent launches receive the current facade; the current CLI can continue using the fallback.
If the original host is unavailable, preserve diagnostics and handle session recovery explicitly.
Windows runtime, any source-transfer destination, NOLF gameplay/menu correctness and training
boundaries remain separate from window/transport verification.

Other agents can invoke the project `rengine-dogfood` skill: canonical guidance lives under
`.claude/skills/`, with Codex discovery adapters under `.agents/skills/`. The `wizard` skill guides
new reusable terminal routines; the runbook and service contracts remain provider independent.

## Interactive flows before native UI

Use `open_script` to run a project-relative `.sh` file with literal `args` in an explicit listed
`desktopId`. The desktop must advertise `canAttach`; update its native and workspace layers first
if it does not. Read the script purpose before invocation: it runs with the project's normal
terminal permissions and may perform the actions it implements. No shell is silently installed.

For example, open `orchestrator/actions/workspace-status.sh` with `args` containing `--context`
and this agent's existing context path. Its new tab lets the human choose project windows,
integration inbox or update status. The menu is a useful UI in its own right; it need not wait
for a native dialog. Explicit arguments help automation but do not replace a requested interactive
experience. The selected `wizard` skill guides authoring such flows.

Older connector fallback: put `{"path":"orchestrator/actions/workspace-status.sh","args":["--context","/absolute/path/to/context.json"]}`
in a JSON file, then run `client.mjs script --context FILE --desktop ID --script SCRIPT_JSON`.
Use `show_session` or `client.mjs show-session --context FILE --desktop ID --session SESSION_ID`
to reattach. Closing a tab retains a waiting script and its output; explicit Stop ends it.
A completed script keeps its log/exit state. Invocation is not idempotent: if attachment fails,
use the returned session ID; after an ambiguous timeout inspect sessions before launching again.
