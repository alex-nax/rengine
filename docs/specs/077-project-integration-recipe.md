# Project integration recipe (runbook, wizard, templates)

Date: 2026-09-06. Owner direction: "for next rengine integrations or new projects we should have
this recipe stored and later adapted in the orchestrator interface." nolf-improved integrated
rEngine on 2026-09-06 (its F1610, F1613, F1614, F1615) and vtmb-vr is being integrated along the
same path. The steps both projects took are the product — rEngine's stated base is a quality
library base **and its integration knowledge** — so they are stored as a runbook, a wizard that
scaffolds the mechanical part, the templates it copies, and a test that proves the scaffold
validates. Nothing here changes the service, the native desktop or a contract; specs 074 (formats,
contract 1), 075 (dashboard, contract 2) and 078 (game targets, contract 3) remain their
authorities. When a contract those specs own changes, this recipe follows it — the owner replaced
the single `game` object with a `games` array on 2026-09-06 and every artifact below was retargeted.

## Scope

- `docs/runbooks/project-integration.md` — the ordered recipe with runnable commands, the two
  worked instances (reLith/nolf-improved, reSource/vtmb-vr) and what the orchestrator UI will
  automate later.
- `orchestrator/actions/integrate-project.sh` — a wizard in the `lib/wizard.sh` conventions
  (explicit arguments first, `re_ask` only in a human terminal, stage logs on stderr) that
  scaffolds a consumer: submodule pin, `editor.sh`, `.rengine/project.json`, declaration test.
- `orchestrator/templates/project/` — the copied artifacts (`editor.sh`, `project.json`,
  `test_rengine_project_decl.py`) plus a README naming each one's destination. Templates are
  project-agnostic: no game, engine or archive format is named in them.
- `orchestrator/tests/integrate-project.test.mjs` — scaffolds a temporary git repository and
  asserts the result validates, never overwrites, and writes nothing under `--dry-run`.

Out of scope: running a consumer's gates, bumping a pin, native controls for any of it, and the
two contract shapes themselves. The wizard writes a declaration; it never edits a project's build
system, CLAUDE/AGENTS files or test runner registration, because those are project decisions with
project-specific syntax.

## The recipe

1. **Prerequisites**: git, CMake at least the pinned tree's minimum, a C compiler, Node ≥ 22.12,
   SDL2 at the exact version the pinned tree demands, Python 3.9+ for the declaration test.
   `editor.sh --check` reports all of them from the pinned tree, so a pin bump moves the check.
2. **Pin rEngine as a submodule** at `third_party/rengine`, at a commit that exists on the
   remote. The pin is the contract version the project's bindings were written against. Never
   edit inside the submodule; findings go back through `report_integration`.
3. **`editor.sh` as the launching point**: bootstrap the pinned tree (submodule init, `npm ci`,
   `npm run build:surface`, `npm run build`) and `exec` its launcher on the project root, with
   `--check`, `--dry-run`, `--bootstrap-only` and `--rebuild` modes and forwarded launcher
   options. Everything it installs lands inside the submodule's ignored directories.
4. **Declare the project** in `.rengine/project.json`: `formats` over the project's own CLI with
   the `${file}`/`${entry}` placeholders (contract 1), plus `dashboard` (contract 2) and the
   `games` array of launch targets (contract 3).
5. **Keep tests in the consumer**: a structural declaration test that always runs, a pinned-schema
   tier that skips until the pin carries the contract, a behavioural tier that executes the
   declared commands exactly as rEngine does, and an `editor.sh` dry-run/`--check` test.
6. **Wire the project's agents**: `.agents/skills` symlink where the project keeps skills, and one
   line in CLAUDE.md/AGENTS.md naming `./editor.sh` as the launching point.
7. **Review gate**: a cross-vendor read-only review of the rEngine side of the integration, its
   verdict recorded in the consumer (nolf-improved keeps
   `docs/findings/rengine-format-registry-codex-review-2026-09-06.md`).
8. **Open the project window** with the retained agent (`orchestrator/actions/project-window.sh`),
   then keep rEngine current with layered `update_workspace` runs.
9. **Consumer gates** are owner-verified in the real window; a pin bump re-runs the binding tests.

## Ownership split

| rEngine owns | The project owns |
| --- | --- |
| The contracts (`contracts/project-v1.schema.json`), their versions and their rejection rules | Its `.rengine/project.json`, and every value in it |
| The editor modes, hex view, preview/dashboard/game tabs and the execution boundary | The executables and scripts the declaration names, and their output shapes |
| The launcher, the layered update path and the window/report transport | Its `editor.sh` copy, its build system, and its test-runner registration |
| The runbook, the wizard and these templates | The choice of formats, dashboard groups, game targets and their surfaces, and pin cadence |

The relationship is one-directional: rEngine references a consumer only as an external `--project`
path, and a consumer never becomes a build input of rEngine.

## What the wizard automates, and what stays a decision

Automated: verifying the project is a git repository and that the pin is advertised by the remote,
adding and pinning the submodule, copying `editor.sh` (mode 755), writing a valid
`.rengine/project.json` skeleton (a `games` array of one record at `contract: 3` when the game
arguments are supplied, and a dashboard whose one action runs `editor.sh --check`), copying the
generic declaration test, and printing the follow-ups. Existing files are reported and skipped,
never overwritten, so the wizard is safe to re-run on a partially integrated project.

Decisions the wizard must not make: which formats a project registers and which CLI produces them;
what belongs in the dashboard groups; how many game targets one engine exposes and whether each
runs `external`, `embedded` or `cooperative`; how the declaration test is registered with the project's own runner
(ctest, pytest, a make target); the pin bump cadence; and the wording of the CLAUDE/AGENTS line.
The wizard prints each of these as a follow-up instead of guessing. The game arguments are
single-valued for the same reason the placeholder format is: the wizard scaffolds one of each and
the reference template carries the multi-record array to copy further targets from.

The skeleton carries one inert placeholder format (`match: ["*.example"]`, `modes: ["raw"]`, no
command) rather than an empty `formats` array, because every contract requires at least one format
record (`minItems: 1`): an empty array would make rEngine settle the root as declared-with-error on
the first open. A project whose only surfaces are a dashboard and its games therefore still declares
one placeholder until the contract relaxes that bound (KI-042).

## Acceptance criteria

1. The runbook contains the ordered recipe with runnable commands for every step above, the two
   worked instances as tables, and the "what the orchestrator UI will automate" close.
2. `orchestrator/actions/integrate-project.sh` follows the wizard conventions (`re_wizard`,
   `re_stage`, `re_run`, `re_finish`, `re_ask` only on a TTY), accepts
   `--project/--name/--rengine-url/--pin/--contract/--game-*/--dry-run/--no-submodule`, rejects
   unknown options and missing values with exit 2, rejects the retired `sdl2-interpose` surface by
   naming `embedded`, and prints its follow-ups on completion.
3. Templates exist for `editor.sh`, `project.json` and `test_rengine_project_decl.py` with a
   README naming each destination; none of them names a specific game or file format.
4. `orchestrator/tests/integrate-project.test.mjs` scaffolds a temporary git repository and
   asserts: the declaration exists and satisfies the rules this checkout ships, checked by calling
   `validateSchema` over the committed contract plus the shared cross-rule modules rather than by
   restating them (while the committed schema predates contract 3 the core is validated with the
   `games` array removed and that tier is reported as uncovered); the scaffolded declaration is
   `contract: 3` with a one-record `games` array and no singular `game` key; the same skeleton at
   `contract: 1` without `games`/`dashboard` passes the shipped `readDeclaration` with no error;
   the retired `sdl2-interpose` surface, an unknown surface and a game at `--contract 2` are each
   refused with exit 2 and write nothing; `editor.sh --dry-run --rebuild --bootstrap-only` prints
   the three bootstrap commands and no launch line; the copied Python test passes with `--root` on
   the contract-1, contract-2 and contract-3 scaffolds; existing files are skipped; `--dry-run`
   writes nothing. A submodule stage runs against a local `file://` clone when this git allows it,
   and asserts the dry-run command list otherwise.
5. `npm test`, `./init.sh`, `python3 tools/design.py check` and sidecar validation pass; the
   inventory row, roadmap graph, known issue, README paragraph and AGENTS row are updated.

Boundaries: no new dependency, no native code, no contract change, no network access in the tests,
and no modification of any consumer checkout from this repository.
