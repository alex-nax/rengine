# Project integration recipe (F70) — macOS, 2026-09-06

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
  carries an inert `*.example` placeholder rather than an empty `formats` array (KI-042).
- The wizard writes nothing under `--dry-run`; the test asserts the scaffolded repository still
  contains only `.git` after such a run.

## Update — contract-3 retarget and the KI renumber, 2026-09-06

The owner replaced the sibling lane's "contract 2 + optional `game` object" with a multi-game
array on 2026-09-06, and this recipe was retargeted at it. Everything above is the original
contract-2 run and is left as recorded; the gates below re-run on the retargeted tree.

| Gate | Result |
| --- | --- |
| `npm test` | 47/47 pass, exit 0 (6.4 s), 9 checks in `orchestrator/tests/integrate-project.test.mjs` |
| `node --test orchestrator/tests/integrate-project.test.mjs` | 9/9 pass; red on 4 of them before the wizard and template moved |
| `bash -n` | clean on `orchestrator/actions/integrate-project.sh` and `orchestrator/templates/project/editor.sh` |
| `./init.sh` | harness checks pass, 30 features validated |
| `python3 tools/design.py check` | clean |
| `python3 tools/features.py validate` | 30 features, no dependency cycle |
| sidecar repair/review/stamp/check | clean on the touched sidecars (`--index .cache/sidecars-recipe-drift.sqlite`) |

Verified against the sibling lane rather than assumed: `origin/feat/project-game` at `3440ef5`
carries `contract` enum `[1, 2, 3]`, a `games` array (1–16, `additionalProperties: false`), per
record `id` (kebab, ≤64, unique), `title` (1–32), `executable` (1–8 candidates sharing the format
`argv[0]` definition), literal `args`, UPPER_SNAKE `env` with `RENGINE_`/`DYLD_`/`LD_` rejected,
root-relative `cwd`/`requires`, and `surface` `embedded`|`external`, with the tools
`game_preflight(gameId?)`/`launch_game(gameId?)` and no deprecated NOLF-named aliases. The schema
agreed with the brief on every point.

Cross-checked against that landed schema rather than only against this branch's: the sibling's
`contracts/project-v1.schema.json` and `orchestrator/server/game-rules.mjs` were read out of
`origin/feat/project-game` (read-only, `git show`; the sibling worktree was never touched) and run
over both artifacts through this checkout's `validateSchema`:

```
wizard scaffold    schema: []  gamesRules: []
reference template schema: []  gamesRules: []
```

Notes:

- The committed schema on this branch is still contracts 1 and 2, so the test's helper validates
  the core with the `games` array removed and reports that tier as uncovered. It takes the full
  path automatically once the game lane's schema and `game-rules.mjs` merge; no edit is owed.
- The copied Python test now skips its pinned tier with
  `pinned rEngine supports contract [1, 2]; this declaration is contract 3` on a contract-3
  scaffold, which is the same intended skip as before, one contract further on.
- Pre-existing and unrelated: the repo-wide sidecar check reports drift in
  `orchestrator/native/{automation,bootstrap,draw,game,layout,main,scroll,terminal}.c`,
  `orchestrator/native/render/*` and `orchestrator/tests/native-client.mjs`. All of it is present
  at `ccbb29e` before this session and belongs to the native/design lanes.
