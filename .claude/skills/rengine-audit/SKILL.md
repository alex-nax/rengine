---
name: rengine-audit
description: Run a comprehensive health audit of the rEngine repository — gates, inventory accuracy, spec coverage and numbering, design-system sync, progress-log integrity, documentation freshness, architecture and layering compliance, roadmap alignment and known-issue triage. Use instead of harness-audit in /Users/alex/rengine. Trigger on "rengine audit", "/rengine-audit", "audit", "check project health", or when documentation drift is suspected.
---

# rEngine Audit — breadth health check

Run every category, report findings before changing anything, then fix in priority order. The
audit never marks a feature passing and never edits the other session's uncommitted files.

## 1. Gates

```bash
./init.sh
python3 tools/design.py check
npm run build && ctest --test-dir .cache/desktop --output-on-failure
npm test
```

Report warnings from owned sources (`-Wall -Wextra -Wpedantic`), failing tests, and whether the
native desktop suite was run (`npm run test:desktop`, about a minute, opens windows — run it when
native code changed since the last recorded suite pass).

## 2. Inventory accuracy

```bash
python3 tools/features.py validate && python3 tools/features.py status
python3 tools/features.py graph > /tmp/graph.md && diff /tmp/graph.md docs/roadmap-graph.md
```

For each passing feature: evidence files exist and describe every criterion. For each
non-passing feature with evidence: is the evidence still current? Flag rows whose descriptions
or criteria were reworded (compare with `git log -p features.json`).

## 3. Spec coverage and numbering

```bash
ls docs/specs; git status --short docs/specs
```

Every implemented behaviour has a spec; no two specs share a number (the parallel session creates
untracked specs — a collision means one must be renumbered with every reference updated).

## 4. Design-system state

`design/` mirrors the Claude Design project “rEngine native workspace”. Check `tokens.css` parses
(`python3 tools/design.py resolve teal`), the mirror and manifest are fresh, cards link
`../../styles.css`, and whether the remote project has files the repo lacks (an interactive
`/design-login` is needed to list them; note "not checked" otherwise).

## 5. Progress log integrity

Newest entry first in `Codex-progress.md`; every header machine-tagged
(`## Session N (<machine>) — YYYY-MM-DD — …`); each entry records commands, results, evidence,
remaining work and a commit; follow-up paragraphs stay inside their session. Numbering may
collide across machines; flag only same-machine duplicates.

## 6. Documentation freshness

- `AGENTS.md`: boundaries match the charter decisions (D-rows) and list the project skills.
- `docs/architecture.md`: constraints and the placement table match the tree
  (`find orchestrator/native -type d`, `ls tools design`).
- `docs/roadmap.md`: milestones match `features.json`; the expansion rule matches D29.
- `docs/specs/056-native-desktop.md`: checkpoint paragraph reflects landed specs.
- `design/README.md` and `docs/specs/064`: match `tools/design.py` commands.
- Codex parity: every `.claude/skills/<name>` has an `.agents/skills/<name>/SKILL.md` adapter.

## 7. Architecture and layering

- `python3 tools/design.py check` already guards colour literals, layout-row literals and
  rendering-API symbols above the draw list; report any exemption added.
- Owned files under 1,000 lines: `wc -l orchestrator/native/*.c orchestrator/native/render/*.c tools/*.py | sort -n | tail`.
- `git diff --stat HEAD -- third_party/` is empty and `third_party/sources.json` hashes match.
- Sidecars valid: `for f in orchestrator/native/*.c orchestrator/native/render/*.c; do python3 ~/.claude/skills/llm-sidecar/scripts/validate_sidecar.py $f; done`.
- No `~/...` paths, hidden downloads or umbrella runtime introduced by new components.

## 8. Roadmap alignment

Milestone rows in `docs/roadmap.md` cover every feature; dependency order still makes sense;
owner decisions since the last audit are reflected (charter revision record).

## 9. Known issues

Each `KI-NNN` row: still true, resolved (say what fixed it), or promotable to a feature. Use
`/rengine-ki-promote` for a batch; here just list verdicts.

## Report

```markdown
# rEngine audit — YYYY-MM-DD

## Score: X/9 categories clean
### 1 Gates … ### 9 Known issues (PASS/FAIL with one line each)

## Recommended actions (priority order)
## Harness improvements (how each finding stops recurring)
```

Fix order: gates, inventory accuracy, spec gaps, layering, doc freshness. Log the audit as a
session entry in `Codex-progress.md` and commit only the files you touched.
