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
`description`, `kind` ∈ {`script`, `log`, `capture`, `game`} and optional `requires` (root-relative
files that must exist), `tools` (bare executable names on the sidecar PATH) and `artifacts`
(root-relative paths the action produces). Per kind: `script` has `script` (root-relative `.sh`
inside the root, the `open_script` rule), optional literal `args` and `env` (`UPPER_SNAKE` keys,
literal string values); `log` has a literal argv `command` and optional non-empty `filters`;
`capture` has a literal argv `command` producing one PNG on stdout, `into` (root-relative
directory inside the root) and `format` `"png"`; `game` has `game` (the `id` of a record in the
same declaration's contract-3 `games` array) and optional literal `args` appended to that record's
own, and is owned by spec 078. Unknown keys, unknown kinds and fields of
another kind are rejected with the offending path in the message. Structural problems are
reported before cross-field rules (unique ids, root-relative paths, env keys, kind fields,
`argv[0]` without shell characters). The schema stays `contracts/project-v1.schema.json`
(the consumer validates the merged document with `validateSchema` and expects no errors).

The `game` kind arrived on 2026-09-06 with the same owner decision that **removed** the toolbar's
game control. That control was built first (branch `feat/project-game`, commit `0cf70b6`: a button
for one declared game, a `Games` menu for several, disabled entries naming their first preflight
issue) and then removed outright, because a consumer launching from the dashboard got a terminal
tab while only the toolbar reached the game surface. Games are launched from the dashboard; a
configurable toolbar is a separate rEngine feature the owner will scope later. Do not re-add a
toolbar game button from this document or from spec 078.

A bad dashboard never disables the formats section or the workspace: the reader validates the
contract-1 part first and reports the dashboard separately (`dashboardError`), the dashboard
route returns the error with empty groups, and the tab renders the message.

## Service

- `GET /api/dashboard?rootId` → `{ rootId, declared, contract, title, groups, error? }` with each
  action carrying `available` and `missing: [{ type: "requires"|"tools"|"game", name }]`, computed
  by stat inside the root boundary and a PATH lookup, running nothing. A `game` action additionally
  carries its referenced record's preflight verdict: unready adds `{ type: "game", name: <first
  issue> }` through the spec-078 preflight path, never a second copy of those checks.
- `POST /api/dashboard-run { rootId, actionId }` creates a retained terminal session and returns
  its snapshot: a `script` action runs `bash <script> args…` with `env` merged over the shell
  environment (the same session the script tab uses; `open_script` also accepts `env`), a `log`
  action runs its argv in a plain terminal (no overlay yet), and a `game` action launches or
  reuses its declared game (spec 078) and returns that **game** session, so `embedded` streams into
  a pane and `external` opens its own window. Nothing runs implicitly.
- `POST /api/dashboard-capture { rootId, actionId }` runs the capture command once with
  contract-1 bounds (10 s, 8 MiB, no shell, cwd = root), requires the PNG signature, creates
  `into` if missing (inside the root), writes `<into>/<ISO timestamp, colons as dashes>.png`,
  appends `{ file, time, size, sha256, action }` to `<into>/manifest.json` (atomic rename) and
  returns that entry plus `path` and `manifest` (root-relative). Non-PNG output, a failing
  command, a timeout or oversized output fail with stderr's first line and write nothing.
- Host and replaceable worker both serve the routes (`dashboard: 1` capability); the worker
  creates sessions through the retained host's `terminal` route, which already merges `env`. A
  `game` action's availability comes from the worker's own preflight (`projectGame: 1`, served
  there since the spec-078 asymmetry fix), while the launch itself goes through the retained host's
  game route, so a host without `projectGameLaunch: 1` is refused by name instead of quietly
  opening a terminal or the removed built-in game.

## Agents

`dashboard_actions` (read-only) lists groups and actions with availability and the exact
script/args/env, command, or referenced game id and args; `dashboard_capture(actionId)` runs one
capture and returns the manifest entry (open-world, not read-only). Script actions are run with
`open_script` (now accepting `env`); log actions start from the dashboard tab and are followed with
`show_session`/`session_output`; game actions are run with `launch_game(gameId, args)`. The live
connector picks the tools up through a layered update.

## Native

A Dashboard tab type per declared root: the toolbar's Dashboard button opens it for the active
root, and it opens automatically once per root when a bound root declares a dashboard and the
layout holds none for it (recorded in the persisted layout so a closed tab stays closed).
Groups are sections; each action is a button with its title and a muted description line, or,
when unavailable, a label naming the first missing item and never a button (a game action's label
names its record's first preflight issue as a sentence, without the `missing <type> <name>` prefix).
A game click opens the launched game session as a game tab. A script click opens
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
