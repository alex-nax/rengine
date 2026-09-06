---
name: llm-sidecar
description: Read and maintain rEngine file-local design notes in adjacent ._llm.json files. Use when editing an annotated file or recording non-obvious implementation rationale; validate anchors and review fingerprints with the bundled tooling.
---

# File-local notes

Read an existing sidecar before editing its source. Add a new one only when non-obvious,
file-local rationale warrants it. Keep public API docs, licenses, pragmas and short essential
warnings in source. Cross-file decisions belong in specs. Do not create empty notes or require
a sidecar for an ordinary declaration, generated file or trivial wrapper.

Use the bundled standard-library tool with a project-local disposable index:

```sh
python3 .claude/skills/llm-sidecar/scripts/sidecar_tool.py --root . --index .cache/sidecars.sqlite query --path path/to/source --line 40 --radius 8
```

For a known symbol, `rg` and a small source excerpt are still the cheapest code lookup. Load
notes when they answer a rationale/maintenance question. The query tool adds validation and
context, but JSON output and all file notes can cost more than a targeted source excerpt.
Evaluation and scope: `docs/evidence/sidecar-efficiency-2026-09-06.md`.

A sidecar appends `._llm.json` to the complete source filename. It has `version: 1` and `entries`.
Each entry needs a stable kebab-case `id`, `kind`, `anchor` and `note`. Anchors use 1-based inclusive
`start`/`end` and the exact trimmed source line at `start` as `snippet`; choose a distinctive
signature. Optional `refs` link to specs. Useful kinds include rationale, constraint, history,
edge-case and perf. A critical constraint can have a one-line source breadcrumb naming its ID.

After editing, batch the affected paths:

```sh
python3 .claude/skills/llm-sidecar/scripts/sidecar_tool.py --root . --index .cache/sidecars.sqlite check --fix-anchors path/to/source
# Review every affected note against the new source; resolve missing/ambiguous anchors.
python3 .claude/skills/llm-sidecar/scripts/sidecar_tool.py --root . --index .cache/sidecars.sqlite stamp path/to/source
python3 .claude/skills/llm-sidecar/scripts/sidecar_tool.py --root . --index .cache/sidecars.sqlite check path/to/source
```

`stamp` records review, not automatic correctness. Exit 0 means clean; 1 needs review/repair;
2 means invalid usage. Missing source/format fingerprints are review prompts. Rename, split or
delete notes with their source, retaining IDs for notes that still apply. Never stamp another
session's changing file without reviewing its current contents.

The project adaptation excludes `.cache` and pinned `third_party` sources from discovery: build trees, runtime descriptors and
captured sessions are not source knowledge. The SQLite index is expendable; committed sources
and sidecars are authoritative. Do not use `--require-sidecars` as the normal gate. Tool provenance
and the single discovery change are recorded in `provenance.json`; run the bundled unittest suite
when changing the tool itself. Repository rules and owner authorization take precedence.

Run sidecar repair, review, stamp and check sequentially. When another agent is active, choose
a separate disposable `--index .cache/sidecars-<session>.sqlite` to avoid SQLite writer contention.
Use `rg` to inspect pinned upstream code; do not copy its contents into owned-source notes.
