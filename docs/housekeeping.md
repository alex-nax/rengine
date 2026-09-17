# Housekeeping ledger

One row per spec reconciled against the code, lowest number first. A spec with a row here is
skipped by later batches; a spec without one is in the queue. The routine is
`.claude/skills/rengine-housekeep/SKILL.md`.

| Spec | Date | Note |
| --- | --- | --- |
| 077 | 2026-09-16 | The launcher it execs is `red-launch`; the template now builds the Rust binaries every launch (the pin-bump hole) and resolves a bare `RENGINE_NODE`; the external half is `red-project install-external` with a Python helper. Consumer divergence confirmed intentional. |
| 098 | 2026-09-16 | Decisions unchanged; host is `red-host`, launcher is `red-launch`, action is `actions/posix/`. Recorded the deleted-module defect fixed the same day, and that `CODE_AREAS` still names the JavaScript tree (under-reports; KI-120). The POSIX-only detach is still open under D71's no-bash rule. |
| 129 | 2026-09-16 | Status was "rows filed"; the retirement is finished and production JavaScript is zero. `red-client` and `red-util` were never built — recorded where that work actually went. **KI-128 filed: nine rows carry evidence and read `passes: false`.** |

## Batch 1 also ran a guarded path sweep (2026-09-16)

Charter D71 moved five directories, and 53 specs named the old paths. The sweep rewrote only the
paths of things that **moved** — `orchestrator/{native,tests,actions,templates}` and
`orchestrator/agents/registry.toml`, plus `scripts/agent.sh` — and deliberately left
`orchestrator/{server,runtime,launcher,build,launch,prepare,external-project}` alone: those name
retired JavaScript, and the old path IS the correct name for a thing that no longer exists.

Spec 147 was excluded: its mapping table's left column is the old paths.

Measured: spec file paths that did not resolve went **48 → 7**. The seven are pre-existing and not
this restructure's:

| Path | What it is |
| --- | --- |
| `actions/posix/install-edition.sh` | planned by the editions specs (105/109), never built |
| `editor/curl.c` | the desktop has `curl.cmake`, not a `curl.c`; the spec named a file that never existed |
| `tests/gpu_*.c`, `tests/test_vr_*.c` | CTest names planned by specs 115/122/124 and not written |

`known-issues.md` and the three project skills (`rengine-audit`, `rengine-continue`,
`rengine-housekeep`) were swept by the same rule — the skills instruct future sessions, so a stale
path there is an instruction that does not resolve. `.agents/skills/*` are thin pointers and carry
no paths.
