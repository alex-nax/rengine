# Consumer project templates

What `orchestrator/actions/integrate-project.sh` copies into a project that is adopting rEngine,
and what a person copies by hand when doing it without the wizard. The recipe around them is
`docs/runbooks/project-integration.md`; the contract they encode is spec 077 plus specs 074
(formats, contract 1), 075 (dashboard, contract 2) and 078 (game targets, contract 3).

| Template | Copied to | Purpose |
| --- | --- | --- |
| `editor.sh` | `<project>/editor.sh` (mode 755) | The project's launching point: bootstraps the pinned rEngine in `third_party/rengine` (submodule init, `npm ci`, `npm run build:surface`, `npm run build`) and `exec`s its launcher on the project root. Modes `--check`, `--dry-run`, `--bootstrap-only`, `--rebuild`; launcher options are forwarded. |
| `project.json` | `<project>/.rengine/project.json` | The complete contract-3 reference declaration: `formats` over the project's own CLI, a `games` array of launch targets (two records, one `embedded` and one `external`, showing `args`, `env`, `cwd` and `requires`) and a `dashboard` of grouped actions. The wizard **generates** a minimal version of this shape (project name, one inert placeholder format, a one-record `games` array when game arguments are given, a dashboard whose one action runs `editor.sh --check`); this file is the fuller reference to copy sections from — including further game targets. |
| `test_rengine_project_decl.py` | `<project>/tests/test_rengine_project_decl.py` | A generic declaration test: structural rules that always run, a pinned-schema tier that validates with rEngine's own `validateSchema`/`readDeclaration` and skips until the pin carries the declared contract, and a behavioural tier that executes the declared commands as rEngine does. Runnable standalone with `--root DIR --rengine DIR`; register it with the project's own runner. |

Rules for these files:

- They name no game, engine or file format. Every project-specific value is a placeholder the
  consumer replaces (`PROJECT_NAME`, `build/project-cli`, `example-*`).
- `project.json`'s placeholder format matches `*.example` and declares no command it needs to run,
  so a scaffolded declaration is valid on the first open. Every contract requires at least one
  format record, so the placeholder stays until the project declares a real one (KI-042).
- `editor.sh` reads its CMake and SDL2 requirements out of the pinned tree, so a pin bump moves
  the prerequisite check with it. Do not hard-code versions here.
- The wizard never overwrites an existing file; a project that already owns one of these keeps it.

Titles you declare (formats, dashboard groups and actions, games) are drawn as text in the desktop's own faces. A glyph those faces lack falls back to another loaded face and then to a small substitution table, so a symbol outside that set draws as a box. Expect the fallback rather than relying on it: a title that must show a symbol should say it in words, because icons are chosen by the desktop rather than by a declaration.
