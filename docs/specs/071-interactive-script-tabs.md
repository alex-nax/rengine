# Interactive scripts as workspace views

Date: 2026-09-06. The owner clarifies that interactive shell flows are a first-class way to
implement functionality before a native UI: the agent opens a script through MCP in a new tab,
and the human proceeds through the prompts there. This extends specs 069–070.

A root-bound `open_script` selects an existing native desktop, a `.sh` file within the bound
project and an explicit argv array. Validate the desktop's attach capability and script path
before creating a retained PTY. Run the project's explicit Bash prerequisite at that root; no
shell interpolation, downloads, browser/agent launch or arbitrary endpoint is implicit. Scripts
can have their own authorized effects, so the caller reads their purpose before invoking them.
The service forwards script output/input normally and opens its session in the chosen desktop.

A failed view attachment reports the created session ID and the failure; it never reruns or
kills the script. Invocation is not an idempotent operation. On an ambiguous timeout inspect
sessions before retrying. `show_session` reattaches a retained session without starting a process.
Closing a view preserves a waiting script; explicit Stop terminates it. Completed output and exit
state stay inspectable. Existing native versions reject attachment before a script is launched.

Implementation belongs in the replaceable workspace/tool layers and native tab client; no new
supervisor protocol is needed. Install it into the live project window through the prepared
layered update, keeping the current coding agents alive. The older connector uses the same
context-bound CLI fallback. Wizard guidance prioritizes human-facing interactive flows when
that is the requested product; explicit arguments remain useful for automation and tests.

Acceptance: actual MCP discovery fails before tools exist; a real native fixture opens an
interactive script, accepts human-style input, closes/reattaches the same waiting PTY, observes
completion and preserves the original agent. Foreign desktop/root, escaped/symlinked script
paths and unsupported clients fail before launch. Run relevant service/native/shell gates and
open a useful interactive inspection flow in the real NOLF project window. Record Windows proof
separately; no source-transfer or provider authorization is expanded.
