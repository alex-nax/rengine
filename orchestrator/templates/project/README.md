# Consumer project templates

What `orchestrator/actions/integrate-project.sh` copies into a project that is adopting rEngine,
and what a person copies by hand when doing it without the wizard. The recipe around them is
`docs/runbooks/project-integration.md`; the contract they encode is spec 077 plus specs 074
(formats, contract 1), 075 (dashboard, contract 2) and 076 (game surface).

| Template | Copied to | Purpose |
| --- | --- | --- |
| `editor.sh` | `<project>/editor.sh` (mode 755) | The project's launching point: bootstraps the pinned rEngine in `third_party/rengine` (submodule init, `npm ci`, `npm run build:surface`, `npm run build`) and `exec`s its launcher on the project root. Modes `--check`, `--dry-run`, `--bootstrap-only`, `--rebuild`; launcher options are forwarded. |
| `project.json` | `<project>/.rengine/project.json` | The complete contract-2 reference declaration: `formats` over the project's own CLI, a `game` block and a `dashboard` of grouped actions. The wizard **generates** a minimal version of this shape (project name, one inert placeholder format, the `game` block when game arguments are given, a dashboard whose one action runs `editor.sh --check`); this file is the fuller reference to copy sections from. |
| `test_rengine_project_decl.py` | `<project>/tests/test_rengine_project_decl.py` | A generic declaration test: structural rules that always run, a pinned-schema tier that validates with rEngine's own `validateSchema`/`readDeclaration` and skips until the pin carries the declared contract, and a behavioural tier that executes the declared commands as rEngine does. Runnable standalone with `--root DIR --rengine DIR`; register it with the project's own runner. |

Rules for these files:

- They name no game, engine or file format. Every project-specific value is a placeholder the
  consumer replaces (`PROJECT_NAME`, `build/project-cli`, `example-*`).
- `project.json`'s placeholder format matches `*.example` and declares no command it needs to run,
  so a scaffolded declaration is valid on the first open. Contract 1 and 2 both require at least
  one format record, so the placeholder stays until the project declares a real one (KI-040).
- `editor.sh` reads its CMake and SDL2 requirements out of the pinned tree, so a pin bump moves
  the prerequisite check with it. Do not hard-code versions here.
- The wizard never overwrites an existing file; a project that already owns one of these keeps it.
