# Project dashboard — macOS, 2026-09-06

Spec 075 implements contract 2, step 1 (F65 service/contract/MCP, F66 native tab) on branch
`feat/project-dashboard` (base `2b04926`, the review-fix tip) in the format-registry worktree.
No game, conversation or goal was launched; the live orchestrator, sidecar and agents were not
touched; the nolf-improved repository was only read.

## Consumer document

`orchestrator/tests/fixtures/nolf-merged-project.json` is nolf-improved's `.rengine/project.json`
merged with its staged `.rengine/dashboard.json` (contract 2, 3 groups, 12 actions). It validates
with `validateSchema` and zero errors, and `readDeclaration` reads `lithtech-rez` plus the
dashboard (`reLith`, groups quick-start/distribution/device) without any error — the shape the
consumer's `PinnedContract` test expects once its pin moves to this branch.

## Fixtures

Service tests (`dashboard.test.mjs`, red first as three failures: `$.contract must equal 1` on
the merged document and 404 on the routes) cover: contract 1 unchanged, contract 2 accepted, a
dashboard under contract 1 reported as `dashboardError` with formats intact, sixteen precise
rejections (unknown kind naming the three kinds, unknown key, mixed-kind field, missing kind
field, `format` other than png, lowercase env key, duplicate action and group ids, escaping
`requires`, absolute `into`, script outside the root or not `.sh`, shell `command[0]`, tool with
a path, empty filter, no groups), unknown contract 3, availability (missing file, missing tool,
present tool), script sessions receiving `--fast`, `BUILD_TYPE=RELEASE` and cwd = root, refusal
of unavailable/unknown/capture actions and undeclared roots, log sessions, two captures writing
PNGs and a two-entry manifest, non-PNG output, a failing command carrying stderr, an `into`
symlinked outside the root, capture on a non-capture action, a broken dashboard leaving formats
working, and the same routes through the replaceable worker plus `dashboard_actions`,
`dashboard_capture` and `open_script` env through MCP.

The native fixture (`native-dashboard.spec.mjs`, red first: no tab of type 6 ever appeared)
drives auto-open, groups, the unavailable action as a label naming `missing.env`, the script
action opening `Script · hello.sh` with `HELLO ARG=--fast ENV=RELEASE PWD_OK=yes`, the capture
action reporting `Captured .cache/captures/<timestamp>.png` with the file and one-entry manifest
on disk, artifact reveal selecting the tree at `dist`, close, GUI restart without automatic
reopen, and the toolbar's Dashboard button. Snapshot `.cache/evidence/dashboard.bmp` inspected:
group headings, action buttons with kind/description lines, unavailable labels, artifact button.

## Gates

- `npm test`: 38 passes, 0 failures, 5.86 s.
- `npm run test:desktop` (16 fixtures): 16 passes, 0 failures, 330.91 s, exit 0 (two background attempts were killed at the turn boundary and produced no result; this is the complete foreground run). Dashboard fixture alone: 1 pass, 2.84 s.
- CTest: 4 passes, 0.65 s. `python3 tools/features.py validate`: 26 features. `./init.sh`, design check
  and sidecar check/stamp for twelve sources pass.

Windows stays unqualified (KI-014). Steps 2 (log overlay) and 3 (image display) are deferred
by owner decision (KI-040).
