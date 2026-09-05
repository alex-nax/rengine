# macOS agent bootstrap qualification checkpoint

The installed Codex CLI 0.153.4 was launched by the actual workspace button through
`scripts/agent.sh` in the NOLF project. `/mcp verbose` displayed the generated rEngine server
as **connected (8 tools)**: `launch_nolf`, `list_files`, `list_sessions`, `nolf_preflight`,
`read_file`, `session_output`, `stop_session`, and `workspace_info`. No coding task was submitted.

Command: `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved node --test orchestrator/tests/agent-desktop.spec.mjs`.
Result: pass, about 5.8 seconds. The screenshot was inspected. Its local path is
`.cache/evidence/installed-agent.png`; proprietary project paths and unrelated user integrations
remain in local runtime evidence. No generated context tokens or credentials are committed.
Screenshot SHA-256: `34c13406abeae8d5ace5c13fdd629461ec84787a3102ec476ed5e71c620b001a`.

The service test uses the official MCP SDK client over real stdio, performs discovery and file
calls, rejects traversal and access/Stop for another root's PTY, and checks that a changed
sidecar identity cannot initialize. Configuration tests preserve argv, pre-existing OpenCode
JSONC and Gemini defaults, and reject malformed configuration without replacing it. Runtime
qualification for Claude, OpenCode, Gemini and Windows remains open.

Pinned bridge dependencies: `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.5.4, `jsonc-parser` 3.3.1.

The real managed installer was exercised separately under `.cache/agent-qualification`:

1. `--agent codex --action install --version 0.153.3`: actual npm download, verified CLI 0.153.3.
2. `--agent codex --action update --version 0.153.4`: two packages changed, verified CLI 0.153.4.
3. `--agent codex --action launch -- --version`: selected the managed executable and returned 0.153.4.

The global Codex installation was not upgraded by these operations. Shell launch/version checks
inside the coding sandbox reported an optional PATH-alias write warning; interactive desktop
qualification ran with the normal app's OS permissions. Failures in earlier automated `/mcp`
attempts left the text unsubmitted. Waiting for startup and using 80 ms key intervals passed;
recorded PTY input confirms the final Enter arrived as carriage return. This is consistent with
rapid-input handling in the CLI, not evidence of dropped terminal input.

The existing user-configured Capture MCP failed its own startup handshake. rEngine's connection
and other existing servers were shown separately. That Capture failure is recorded as KI-017,
not flattened into a successful all-integrations claim. A process check after cleanup found no
remaining test-owned rEngine MCP or NOLF process.
