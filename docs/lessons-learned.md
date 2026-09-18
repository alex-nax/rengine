# Lessons learned

Approaches this repository tried and rejected, and the antipatterns that keep coming back. A rule
here earns its place by having cost something once already; each entry says what it cost.

---

## ANTIPATTERN — one file that knows every agent

**The shape.** A capability that must behave differently per agent CLI gets written as one module
with a function or a branch per agent: `claude_flags`, `kimi_flags`, `codex_resume` side by side; or
`if agent == "kimi" { … }` in the middle of shared logic. It reads fine. Every agent's behaviour is
visible at once, the file is short, and nothing is obviously wrong.

**Why it is wrong.** The project's stated design is one adapter per agent — spec 137 gives memories
a per-agent slot, spec 140 says "one adapter per CLI", and `registry.toml` exists precisely so a
recipe is data rather than code. A single shared file inverts that: adding an agent becomes an edit
to a file every *other* agent also depends on, and removing one means finding its pieces scattered
through functions named for it. The knowledge that belongs to one CLI ends up owned by all of them.

**What it cost.** 2026-09-15, F210: the conversation-store adapters for claude, codex and kimi were
written into one `conversations.rs` — by an agent that had, in the same session, written the spec
saying one adapter per CLI. The owner caught it on read:

> *"we combine all codex_, claude_ and other methods in one file conversations.rs — that STRONGLY
> CONTRADICTS the design decision for agent abstractions, each agent should be described in its own
> adapter"*

It was split into `conversations/{claude,codex,kimi}.rs` over a shared `mod.rs` that owns the return
shapes and the list of who to ask, and knows nothing about any CLI's insides. Nothing was lost in
the split; the cost was the rework, and the fact that a spec did not prevent it.

**How to tell you are doing it.** Any of these in a file whose name is not the agent's:

- a function named after an agent (`kimi_flags`, `claude_title`)
- `if agent == "…"` or `match cli { "claude" => … }` outside a registry lookup or a module dispatch
- a string literal naming one agent in logic every agent runs through
- an enum variant named for one agent (`IdShape::KimiSession` in the *store*, which has no business
  knowing what kimi's ids look like)

**What to do instead.** One file per agent, exporting the same entry point. A shared module owns the
shapes, the helpers and the roster; the dispatch is a lookup, not a branch. Where the difference is
a *capability* rather than an identity — "this CLI needs an MCP overlay written for it" — declare
the capability in the recipe and let the shared code ask the recipe, never the name.

**Why it needed a guard, not a rule.** This entry did not exist when F210 was written, but the specs
it violates did, and they did not stop it. `design.py check` fails the build on a hand-written
product name; nothing comparable existed for an agent name in shared code.

**The guard: `python3 tools/agent_names.py check`** (F217), run by `init.sh` with the other gates.
It reads the roster from `registry.toml`, so a CLI added as data is guarded the day it is added, and
it reports the name and the line. Comments, `#[cfg(test)]` modules, tests directories and a file
whose own name is the agent's are all allowed — prose explaining why code is shaped a way may name
the CLI that motivated it, a fixture naming one deliberately is the point of the fixture, and an
adapter is the prescribed answer. Everything else is a finding.

Two things that guard learned the hard way, both worth keeping in mind for any check like it:

- **`\b` is the wrong word boundary.** `_` is a word character, so `\bkimi\b` does not match
  `kimi_flags` — the exact function name this check exists to catch. It passed the F210 shape the
  first time it was tried. The boundary is "not a letter or digit".
- **Stripping `//` comments naively hides code.** `"https://claude.ai/code"` truncates at the
  slashes and takes the name with it. The strip has to know it is inside a string.

**Exceptions are declared in one list**, in the checker, each with a reason and the feature that
will remove it — so widening it is a visible decision in a diff. A check whose exceptions are
inferred teaches nothing; one with no exceptions at all gets deleted the first time it is in the way.

**Open cleanup:** none. F213–F220 worked the list down from 21 exceptions to 5, and all five are
marked PERMANENT: three adapter rosters (a module dispatch keyed on a declared KIND is the
prescribed shape), one frozen record's vocabulary, and one design-source name that is not a CLI.

A word boundary is the wrong tool for this check, twice over: `\b` does not break at `_`, so
`\bkimi\b` misses `kimi_flags`; widening it to "not a letter or digit" then misses `codexModels`,
because JavaScript spells the same violation in camelCase. Split identifiers into words instead.

## ANTIPATTERN — a route table copied into the server that calls it

`red_project::serve` owns the routes about a project, and it exists for one reason: the door and the
worker both answer them and neither may forward them, so a second implementation would be a second
answer to "what does this project declare". It states the set as a function — `owns(method, path)` —
precisely so there is one list.

The door then re-listed those paths in its own dispatch, as a hand-written `matches!` that happened
to agree. Adding a route to `owns` therefore made it answerable at the worker and 404 at the door —
and the door **is** the whole workspace whenever nothing is behind it, which is what the desktop
talks to in every test and in a directory with no backend. The page was written, the routes were
written, the unit tests passed, and the feature was dead at the address people use.

The transferable rule: **when a module publishes a predicate for its own routes, calling it is not
optional — a copy that agrees today is drift waiting for the next row.** The copy is invisible
because it is correct at the moment it is written, and a guard cannot see it either: both lists were
valid code that compiled. What caught it was the first test that drove the desktop against the door.

The corollary is about where a feature's first test points. Every check on the new routes ran against
the worker, because that is where the handlers had been written; the one thing none of them asked was
whether the surface a person actually opens could reach them.
