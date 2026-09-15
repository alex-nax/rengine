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

**Why it needs a guard, not a rule.** This entry did not exist when F210 was written, but the specs
it violates did, and they did not stop it. `design.py check` fails the build on a hand-written
product name; nothing comparable exists for an agent name in shared code. F217 is that guard.

**Open cleanup:** F213–F217 carry the places this shape already exists.
