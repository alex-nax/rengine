# Running NOLF workspace with agent onboarding

Status: implementation authorized by the owner's active goal, 2026-09-05.

The owner now requests the ability to launch the orchestrator on NOLF with proper game launching,
project tree, editor and an agent CLI booted through a shell script that finds, updates, downloads
or launches the preferred agent. This instruction supersedes the initialization-only restriction
and brings agent onboarding into the first usable workflow. It does not require another review
export before implementation. Prior macOS/Windows, live game tab, root binding, retained sessions,
optional Vim and explicit-save recovery requirements still apply.

## Scope and acceptance

- A documented command opens the desktop workspace for an explicit NOLF checkout. It detects
  that checkout's real executable/data prerequisites, reports failures, and launches the correct
  flat target with its own cwd/arguments. The game renders live into a movable, interactive tab.
- Real project files appear in a navigable tree. Editing, explicit Save, local draft recovery,
  external conflicts and optional Vim work through the intended root, including duplicate names.
- Real PTY terminals run shells and CLI agents. The standalone Bash launcher detects installed
  supported agents and offers launch, install/download, update and a custom executable path.
  The chosen CLI runs interactively in the selected project. Installation/update failures remain
  visible; no fake agent output or unconditional successful status can satisfy the goal.
- Closing GUI views retains the sidecar sessions. Session browser reattachment, explicit Stop,
  split/tab moves, GUI restart and multi-root operation preserve the intended processes and files.
- Supported CLI recipes/bootstrap integrations are explicit and tested; existing settings are
  preserved. Required authentication is performed by the CLI in its terminal.
- Verify the actual NOLF/editor/tree/agent workflow and record separate Mac/Windows evidence.
  Native game assets and credentials stay local. Fixtures supplement, rather than replace, the
  live NOLF and installed-agent proof.

## Implementation approach under qualification

Use Electron as the desktop shell, a separately launched Node sidecar, node-pty/xterm.js for
terminals, React/FlexLayout for splits/tabs, and CodeMirror with an optional Vim extension for
editing. Pin resolved package versions and lockfile integrity. Node sidecar lifetime is independent
of Electron; native PTY modules are built for the sidecar's Node ABI rather than Electron's ABI.
The initial development launcher therefore requires Node as a declared prerequisite. Packaging
must include or explicitly provision that prerequisite before claiming an installable release.

The game surface is a separate adapter with explicit process/session identity. Qualify NOLF's
SDL2/OpenGL swap and input boundaries; do not treat an external game window or screenshots as
the live interactive tab. Bound buffered frames and terminal output to avoid memory growth.

Local HTTP/WebSocket access uses a loopback listener, an unguessable session token and explicit
root/session identifiers. The browser renderer has no Node integration. File writes check the
base version and preserve drafts; shell commands retain their normal operating-system authority.

## Delivery and verification

Activate only the reviewed proposal rows required for this goal, plus its aggregate F55. Retain
the broader library/Quest/training proposal separately. Implement in bounded commits and keep
non-passing states until every corresponding acceptance criterion is proven; unfinished Windows
or host evidence must not be converted into a successful feature merely to unblock coding.

Initial tests cover real sidecar PTYs and process lifetime, root-bound file/conflict/draft behavior,
agent recipe dispatch with controlled executable fixtures, malformed surface frames and session
authentication. Desktop integration tests then exercise the actual UI, followed by the local NOLF
and installed-agent run. Concrete platform and performance evidence is recorded as it is obtained.

Primary component references reviewed during qualification:

- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- https://github.com/microsoft/node-pty
- https://github.com/caplin/FlexLayout
- https://github.com/replit/codemirror-vim
