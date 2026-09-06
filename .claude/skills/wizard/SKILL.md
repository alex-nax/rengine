---
name: wizard
description: Author reusable terminal shell actions for the rEngine orchestrator, as interactive terminal workflows, with staged progress, explicit project/session bindings and reliable results for coding agents. Use for setup, project integration or another requested multi-step terminal routine.
---

# rEngine terminal actions

Read the target project's AGENTS.md and existing action before designing stages. Record the
intended inputs, side effects and acceptance check in a spec. The owner's current request can
settle the stages; ask only for missing decisions or a concrete approval boundary.

Use Bash 3.2-compatible `.sh` entry points under `orchestrator/actions/`, reusable helpers from
`orchestrator/actions/lib/wizard.sh`, and `project-window.sh` as the working reference. Native
Windows uses the project's explicit Bash/Git Bash prerequisite; WSL is a distinct environment,
not evidence for native Windows. Do not silently install a shell or dependency.

Interactive PTY tabs are a first-class workflow UI, including functionality whose native GUI
has not been built yet. An agent can call `open_script` with a project-relative `.sh` path, literal
argv and an explicit listed desktop ID; the human proceeds through menus/prompts in that new tab.
`show_session` reattaches a waiting or completed flow without rerunning it. Closing the view retains
the script and log; explicit Stop ends it. Use `workspace-status.sh` as the interactive reference.
Keep menu choices with the human when that is the requested experience; do not substitute an
unattended procedure merely because the agent could perform the underlying operation.

Offer explicit arguments for automatable stages and deterministic tests. Prompt for human inputs
when stdin is a TTY; a missing required input outside a human terminal fails promptly. Keep stdout available for
machine results and progress/errors on stderr. Preserve scrollback, avoid full-screen clearing,
animations and hidden waits. Show current/total stages and what succeeded or remains incomplete.

Bind paths and session IDs explicitly. Derive the rEngine helper path from the script location,
not the terminal's focus or cwd. Quote argv arrays, use task-specific variables, and never `eval`
input, source generated state or put secrets into logged commands. Sensitive input uses the
helper's hidden-input option and is written only to its explicitly authorized destination.

Keep reusable implementation in the underlying command/MCP API; shell stages compose it. A
window open reuses a retained agent, and window close detaches it. Use a retry key for report
mutations. After an interrupted update, inspect its job before repeating. Browser/provider or
irreversible actions require the applicable concrete authorization, not a blanket wizard launch.

Verify `bash -n`, ShellCheck when installed, missing-input/EOF/cancel/error exits, paths containing
spaces and shell metacharacters, and the actual consumer path on temporary projects. Human login
steps need a documented manual check; don't manufacture credentials to complete a test. Commit
repeatable actions and link their runbook. Do not introduce a wizard when one ordinary command
already handles the user's task.

Only the explicitly selected upstream wizard informed this adaptation. There is no dependency
on, recommendation for, or automatic installation of its author's other skills. Provenance and
required copyright notice are in `provenance.json` and `LICENSE`.
