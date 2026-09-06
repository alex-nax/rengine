# Project dashboard (contract 2, step 1)

Date: 2026-09-06. Owner-directed continuation of spec 074: a bound project declares a
**dashboard** of grouped actions (quick starts, distribution, device work) and rEngine renders
it as a tab. Owner decisions: the screen is called dashboard; it lives in the same
`.rengine/project.json` as contract 2 (contract 1 plus an optional top-level `dashboard`);
log filtering is a later client-side overlay on terminal tabs (step 2); headset visuals are
screenshots into a capture directory with a manifest (this step writes the files, step 3 shows
them); `stream` and `operator` are reserved kind names. The consumer proposal is
`nolf-improved/docs/specs/feature-1615-project-dashboard.md`; its staged `.rengine/dashboard.json`
merges into `project.json` once this lands.

## Declaration (contract 2)

`contract` is 1 or 2. Contract 2 adds an optional `dashboard` `{ title, groups }`; a `dashboard`
under contract 1 is reported and ignored. A group has `id` (kebab-case, unique), `title` and
`actions` (1–64). An action has `id` (kebab-case, unique across the dashboard), `title`, optional
`description`, `kind` ∈ {`script`, `log`, `capture`} and optional `requires` (root-relative
files that must exist), `tools` (bare executable names on the sidecar PATH) and `artifacts`
(root-relative paths the action produces). Per kind: `script` has `script` (root-relative `.sh`
inside the root, the `open_script` rule), optional literal `args` and `env` (`UPPER_SNAKE` keys,
literal string values); `log` has a literal argv `command` and optional non-empty `filters`;
`capture` has a literal argv `command` producing one PNG on stdout, `into` (root-relative
directory inside the root) and `format` `"png"`. Unknown keys, unknown kinds and fields of
another kind are rejected with the offending path in the message. Structural problems are
reported before cross-field rules (unique ids, root-relative paths, env keys, kind fields,
`argv[0]` without shell characters). The schema stays `contracts/project-v1.schema.json`
(the consumer validates the merged document with `validateSchema` and expects no errors).

A bad dashboard never disables the formats section or the workspace: the reader validates the
contract-1 part first and reports the dashboard separately (`dashboardError`), the dashboard
route returns the error with empty groups, and the tab renders the message.

## Service

- `GET /api/dashboard?rootId` → `{ rootId, declared, contract, title, groups, error? }` with each
  action carrying `available` and `missing: [{ type: "requires"|"tools", name }]`, computed by
  stat inside the root boundary and a PATH lookup, running nothing.
- `POST /api/dashboard-run { rootId, actionId }` creates a retained terminal session and returns
  its snapshot: a `script` action runs `bash <script> args…` with `env` merged over the shell
  environment (the same session the script tab uses; `open_script` also accepts `env`), a `log`
  action runs its argv in a plain terminal (no overlay yet). Nothing runs implicitly.
- `POST /api/dashboard-capture { rootId, actionId }` runs the capture command once with
  contract-1 bounds (10 s, 8 MiB, no shell, cwd = root), requires the PNG signature, creates
  `into` if missing (inside the root), writes `<into>/<ISO timestamp, colons as dashes>.png`,
  appends `{ file, time, size, sha256, action }` to `<into>/manifest.json` (atomic rename) and
  returns that entry plus `path` and `manifest` (root-relative). Non-PNG output, a failing
  command, a timeout or oversized output fail with stderr's first line and write nothing.
- Host and replaceable worker both serve the routes (`dashboard: 1` capability); the worker
  creates sessions through the retained host's `terminal` route, which already merges `env`.

## Agents

`dashboard_actions` (read-only) lists groups and actions with availability and the exact
script/args/env or command; `dashboard_capture(actionId)` runs one capture and returns the
manifest entry (open-world, not read-only). Script actions are run with `open_script` (now
accepting `env`); log actions start from the dashboard tab and are followed with
`show_session`/`session_output`. The live connector picks the tools up through a layered update.

## Native

A Dashboard tab type per declared root: the toolbar's Dashboard button opens it for the active
root, and it opens automatically once per root when a bound root declares a dashboard and the
layout holds none for it (recorded in the persisted layout so a closed tab stays closed).
Groups are sections; each action is a button with its title and a muted description line, or,
when unavailable, a label naming the first missing item and never a button. A script click opens
the script's retained session as a tab; a log click opens the terminal tab; a capture click
runs the capture and shows the written path in the status line; artifacts are buttons that
reveal the path in the project tree. Refresh re-reads the declaration and availability. Per-row
state is owned by the tab (no shared microui pools).

## Acceptance and verification

1. Service tests fail before the reader knows contract 2, then cover contract 1 acceptance,
   contract 2 acceptance, the copied nolf-improved merged document validating with zero errors,
   unknown kind/key and mixed-kind rejection, dashboard-under-contract-1 reporting without
   disabling formats, availability (missing file, missing tool, present tool), script sessions
   receiving `args` and `env`, log sessions, capture writing PNG + manifest twice, rejecting
   non-PNG output and an `into` outside the root, and the MCP tools.
2. A native fixture opens the dashboard automatically for a synthetic root, sees the groups, a
   disabled action naming its missing file, runs a script action and reads its output in the
   script tab, runs a capture action and finds the file and manifest, reveals an artifact in the
   tree and reopens the tab from the toolbar.
3. `npm test`, `npm run test:desktop`, CTest, `./init.sh`, design check and sidecar validation.
   The owner verifies the real nolf-improved dashboard after the consumer merges its staged
   section into `project.json` and a layered update; Windows stays unqualified.
