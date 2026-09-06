# Reproducible project skills

Date: 2026-09-06. The owner requests measuring llm-sidecar efficiency, bundling it if useful,
and adapting the explicitly selected wizard skill for orchestrator shell actions.

Evaluate sidecars using representative existing source/notes, reproducible context-byte and
latency measurements, and an explicit qualitative usefulness rubric. Do not equate byte counts
with exact model tokens or claim agent accuracy without a controlled model trial. Measure the
installed tool against the real workspace as well as a small source corpus; identify incidental
cache scanning separately. Bundle only if the notes and maintenance checks justify their cost.
Retain provenance, record local modifications, and validate any bundled tooling with its tests.

Adapt only the selected wizard entry point and its needed helper/template. Use explicit paths,
terminal-compatible stages and useful logs, distinguish interactive human inputs from supplied
agent arguments, preserve project/session bindings, quote argv, return reliable nonzero failures
and never source generated state as shell code. No automatic browser/provider/secret installation
or unrelated skill recommendations. Preserve legally required attribution. Stable reusable scripts
live in the repository; disposable scripts are not a prerequisite for ordinary agent work.

Document the chosen skill discovery locations for Codex and Claude without global configuration
changes. Validate frontmatter, shell syntax and meaningful failure/cancel/noninteractive paths.
Use the project-window routine as a concrete shell consumer of the chosen conventions.
