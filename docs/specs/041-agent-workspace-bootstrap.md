# Agent workspace bootstrap

Implementation scope under F39–F41/F55: the Bash launcher finds the selected executable and
performs explicit install/update actions. For launch from an orchestrator session, it also supplies
a project-bound MCP server through the selected CLI's supported configuration overlay. Bare
standalone launcher use remains possible without a running workspace.

The sidecar writes a mode-0600 context file under its private state directory, containing the
loopback endpoint, instance identity and explicit root. The MCP child receives the context file
path, never a token in command arguments. Every call verifies the same sidecar instance and
root. File and session tools enforce that binding; changing the GUI's active project cannot
retarget an existing agent. This is process authority belonging to the local user, not a security
sandbox around the coding CLI itself.

Use the official MCP SDK with stdio and bounded file/log results. Initial tools expose project
identity, tree and text excerpts, session listing/output, NOLF preflight/launch and explicit Stop.
Tool failures preserve error status. Connecting the MCP server or starting the CLI must never
send an unsolicited coding task or start a training run.

CLI overlays must preserve existing user/project configuration and authentication. Codex uses
per-invocation config overrides, Claude uses an additional MCP config, OpenCode merges its runtime
config, and Gemini uses an additive managed defaults overlay preserving prior defaults. Custom
executables receive a generic MCP configuration path through the environment; automatic custom
CLI support must not be claimed without a declared recipe. No bypass-permission flags are added.

Acceptance: real MCP handshake and calls to the sidecar, rejection of cross-root file/session
access, failure against a changed sidecar instance, argv preservation and config merge fixtures,
then actual installed CLI startup and visible connected integration in its terminal. Actual
download/update verification uses an isolated managed installation. Authentication is handled
by the CLI, with any missing login shown in the terminal. Mac and Windows evidence stay separate.

Sources consulted:

- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://code.claude.com/docs/en/mcp
- https://opencode.ai/docs/config/
- https://geminicli.com/docs/reference/configuration/
- https://ts.sdk.modelcontextprotocol.io/server
