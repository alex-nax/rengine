# Project integration recipe (F68) — macOS, 2026-09-06

Branch `feat/integration-recipe` off `43bbb80`, worktree `.cache/worktrees/integration-recipe`.
Documentation and shell/JS tooling only: no native code, no service route, no contract change.

## Gates

| Gate | Result |
| --- | --- |
| `npm test` | 43/43 pass, exit 0 (70 s), including the 8 new checks in `orchestrator/tests/integrate-project.test.mjs` |
| `node --test orchestrator/tests/integrate-project.test.mjs` | 8/8 pass (9.2 s) |
| `bash -n` | clean on `orchestrator/actions/integrate-project.sh` and `orchestrator/templates/project/editor.sh` |
| `./init.sh` | harness checks pass, 25 features validated |
| `python3 tools/design.py check` | clean |
| sidecar repair/review/stamp/check | clean (`--index .cache/sidecars-integration-recipe.sqlite`) |

No native GUI test: nothing under `orchestrator/native/` changed.

## Manual end-to-end run

A throwaway git repository scaffolded from a bare `file://` clone of this worktree, pin = its HEAD:

```
[1/5] Verify the project and the rEngine pin      pin advertised by the remote
[2/5] Pin rEngine as a submodule                  cloned, checked out detached, gitlink recorded
[3/5] Install the editor.sh launching point       installed: editor.sh
[4/5] Write the .rengine/project.json declaration installed (contract 2)
[5/5] Copy the declaration test                   installed: tests/test_rengine_project_decl.py
```

`git submodule status` reported the requested SHA with no `+`/`-`. In that scaffold:

- `./editor.sh --check` → `ok git`, `ok cmake 3.31.2`, `ok cc`, `ok node 22.23.1`,
  `ok SDL2 2.32.10` (read out of the pinned tree's `find_package(SDL2 … EXACT)`), the three build
  outputs `pending`, exit 0, no command run.
- `python3 tests/test_rengine_project_decl.py --root <scaffold>` → 8 tests, OK, 3 skipped:
  the behavioural tier (no built CLI, no matching file) and both pinned-contract checks with
  `pinned rEngine supports contract [1]; this declaration is contract 2` — the intended skip while
  contract 2 lands on the dashboard/game branches.

## Notes

- The file:// submodule stage runs in this environment with
  `protocol.file.allow=always` supplied through `GIT_CONFIG_*`; the test falls back to asserting
  the printed plan where a git refuses it.
- Contract 1 and contract 2 both require at least one format record, so the scaffolded declaration
  carries an inert `*.example` placeholder rather than an empty `formats` array (KI-039).
- The wizard writes nothing under `--dry-run`; the test asserts the scaffolded repository still
  contains only `.git` after such a run.
