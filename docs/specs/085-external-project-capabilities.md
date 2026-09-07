# External project capabilities

Date: 2026-09-07. Owner request: open `~/hirebase-v2` in rEdit, keep every rEdit
extension outside that project, install a home-directory launcher and launch it.
This is explicit authority for this integration while the broader NOLF goal remains paused.

## Contract

`launch.mjs --project DIR --declaration FILE` registers a canonical absolute declaration
path on that root in private workspace state. The existing project declaration schema is
unchanged. An explicit declaration replaces discovery of `.rengine/project.json`; it is
never merged with it. Omitting the option on later launches preserves the binding. A
different declaration for an already bound root is refused, naming the existing binding.
Editing the selected file updates capabilities through the normal refresh path.

The host advertises `externalDeclarations: 1` only when it persists these bindings. A
launcher refuses an older host before creating sessions; it never restarts retained hosts.
The replaceable worker reads the same root record for formats, dashboard, games and devices.
Missing or malformed external declarations report their actual filename, without falling
back to a project-local file. All file, draft, command cwd and session bindings remain the
real project root. Existing root-relative script and file confinement stays in force;
external helper executables use the existing literal-argv command contract.

## Installation

A reusable installer takes explicit project, rEngine checkout, profile directory, runtime
state directory and launcher paths. It writes the declaration and helper outside the
project, plus a quoted Bash-compatible `.command` launcher. Existing differing files are
refused. It performs no dependency install, project mutation or remote operation.

The initial web-project profile provides identity, JSON preview with text editing, project
status and package-script discovery. Optional development/check buttons call only existing
package scripts through literal argv. These controls run on request; opening the workspace
does not run dev servers, tests, deployments or an agent conversation. Agent launch remains
available through the native toolbar. No project `editor.sh`, submodule, declaration,
instructions, hooks or ignore edits are required.

## Acceptance

1. Register an external declaration via the actual HTTP root API; reload workspace state,
   reopen without a declaration and retain the same root/binding. Conflicting, relative,
   missing and non-file declaration paths fail explicitly.
2. Read external identity, previews, dashboard, devices and game preflight through both host
   and replaceable worker. Commands run in the project and file APIs cannot reach the
   external profile. Missing/bad declarations identify their source without local fallback.
3. Exercise meaningful failures before implementation; preserve existing local declarations.
   Keep the test in `npm test`, with native acceptance in `npm run test:desktop`.
4. Install using paths containing spaces and shell metacharacters; verify launcher syntax,
   literal arguments and refusal to overwrite differing files or install inside the project.
5. Launch the actual hirebase workspace from its home launcher, inspect the native project
   identity/tree/dashboard and run the read-only status capability. Record project status
   before/after, launch paths and verification evidence outside hirebase-v2.
