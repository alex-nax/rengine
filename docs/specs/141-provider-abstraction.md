# Spec 141 — the provider abstraction: a recipe declares, shared code implements

Owner goal, 2026-09-15: *"design abstraction interface and achieve complete provider split"*, after
catching an agent-per-function file that contradicted the project's own stated design
(`docs/lessons-learned.md`).

Status: **design, with F213–F217 as the work.**

## The rule, in one line

**Shared code asks the recipe what a CLI can do. It never asks who the CLI is.**

A file that is not an agent's own may contain no agent name — not in a function name, not in a
branch, not in an enum variant. Where behaviour differs per agent, either a recipe key describes the
difference, or the agent gets an adapter file of its own. There is no third option.

## What the survey found

The registry is already a strong declaration: `conversation.ids` is a regular expression,
`normalize`, `resumeLine`, `start.args`, `resume.args`, `short.length` and `short.stripPrefix` are
all data. The gap is not that rEngine lacks an abstraction — it is that **code was written beside
the abstraction instead of through it**.

| where | what it knows that it should not |
|---|---|
| `red-agents/parsers.rs` | `claude_flags`, `kimi_flags`, `codex_resume`, and hand-rolled `uuid_shape` / `ulid_shape` / `kimi_id_shape` |
| `red-agents/main.rs` | a match arm per agent, dispatching to those |
| `red-agents/bind.rs` | `if agent == "kimi"` deciding where MCP wiring goes |
| `red-agents/launch.rs` | a kimi-named key in a shared plan |
| `red-store/store.rs` | `IdShape::KimiSession`, plus a **third** hand-rolled copy of the id shapes |
| `red-host/panes.rs`, `handoff.rs` | a resume path gated on the agent literally being codex |

**The id shape exists in three places**: declared as a regex in the registry, hand-rolled in
`parsers.rs`, and hand-rolled again in `red-store`. `launch.rs:103` already matches the declared one
with a real engine, and both crates already depend on a regex library — so the two hand-rolled
copies are not even a dependency saving. `parsers.rs`'s comment claiming a regex "would be the
crate's first" is stale; `red-agents/Cargo.toml` has carried `regex` since `ids_match` was written.

## Decisions

| # | Decision |
|---|---|
| 1 | **The declared pattern is the only id shape.** `conversation.ids` is matched with a real engine wherever a shape is checked. Both hand-rolled copies are deleted, not refactored. |
| 2 | **A parser becomes a declared spelling.** The three parsers are two algorithms with different data: claude and kimi are the same flag scan with different flag lists, codex is a positional subcommand. A new `conversation.read` block names which spelling and its data; shared code implements the spellings, named for what they do (`flags`, `subcommand`) and never for who uses them. |
| 3 | **The store stops judging shape by identity.** `record_conversation` takes the declared pattern from its caller rather than an enum naming an agent. The store still refuses an id that does not match — the refusal is the point — but it learns the rule instead of containing it. |
| 4 | **An identity check that stands for a capability becomes a capability.** `if agent == "kimi"` for MCP placement, and codex-only handoff, are capabilities the recipe declares. A fourth agent needing the same treatment declares it and works, with no shared-code edit. |
| 5 | **The roster is data.** Dispatch is a lookup over declared recipes, not a `match` with an arm per agent. An unknown agent is refused by name, as today. |
| 6 | **A guard, not a rule.** The specs this violated already existed and did not prevent it — the writer who broke the rule had written it, the same day. A check fails the build when an agent name appears outside its adapter, the registry, or a declared exception list, the way `design.py check` already does for the product name. |

## What this does not do

- It does not change what any agent does today. Every existing behaviour is preserved and its
  current evidence path re-run; this moves knowledge, it does not redesign launching.
- It does not remove `provider` from a conversation record. A conversation belongs to the CLI that
  can resume it, and saying which is data, not an identity check in shared logic.
- It does not forbid an agent's name in that agent's own adapter, in the registry, or in a fixture
  that names one deliberately. Those are where it belongs.

## What implementation found: the projection is frozen, so a new declaration needs its own view

F213 hit a wall worth writing down, because the next declared capability will hit it too.

`red-agents::project()` is not a general projection — it is **frozen evidence**. It emits exactly
the shape `registry.mjs`'s `resolvedRecipes()` emitted, and `agent-registry-toml.test.mjs`
deep-compares it against a record taken before that module was deleted, which by its own terms must
never be regenerated. So a capability declared *after* that module died cannot appear in its answer:
adding `read` to `project()` fails the parity test, and regenerating the record to make it pass
would turn a parity proof into a comparison against itself.

The resolution: `conversation_read()` projects the declared block on its own, and `launch::talk_of`
carries it alongside the projected conversation. `project()` stays byte-identical to the record, the
crate's own view of a conversation gains the new declaration, and **both the launch path and `parse`
read that one view** — which is what `conversation_of` promised all along and briefly did not
deliver: for one build the two read different views, the launch minted its own id, and five tests
said so.

**The rule for the next declaration:** new capability data goes in its own projection, never into
`project()`. A frozen artifact stays frozen or it stops being evidence.

## What F214 found: a KIND is rEngine's, every SPELLING is the CLI's

The identity check F214 names (`if agent == "kimi"`) turned out to be the small half. The capability
it stood for was **already declared** — `mcp.kind = "project-file"` — and the code simply did not
ask. But the overlay arms that implement those kinds were full of one CLI's spellings applied to
every CLI that declared the kind:

| the arm | what it imposed on everyone |
|---|---|
| `flag` | claude's `--mcp-config`, and claude's `--settings` for the hook file |
| `project-file` | kimi's `.kimi-code/mcp.json` |
| `env-defaults` | gemini's `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` and `gemini-defaults.json` |

A second CLI declaring `kind = "flag"` was silently handed claude's flag. The registry's own
end-to-end proof showed it: `testcli`, a recipe added as pure data, asserted `['--mcp-config', …]`.
It now declares `--servers` — nobody's real flag — and gets it.

So the line is: **rEngine implements the KIND; the recipe spells it.** `flag`, `path`, `pathVar` and
the hooks `flag` are declarations, a recipe naming a kind without its spellings is refused at cook
time by name and by missing key, and `claude_settings` is `per_launch_settings`, named for the
capability it serves.

Two frozen artifacts shaped this and are worth knowing about before touching a recipe:

- `project()` freezes the *shape*, so a new key must live in `declared_since` (F213 above).
- The frozen record also freezes the *shipped document's projected atoms*, so a new declaration may
  not reuse a key `project()` already emits. That is why the `env-defaults` variable is `pathVar`
  rather than the existing `envVar` — and the two genuinely differ: `envVar` carries configuration
  text inline, `pathVar` carries a path.
- The frozen *launch* record pins `gemini-defaults.json`, so the filename moved into the recipe
  rather than being renamed. Declaring it kept the evidence intact and removed the name from code.

**Still open:** `bind.rs` prints a per-CLI catalogue of start hints for a custom agent, which now
duplicates the spellings the registry declares — change a recipe's flag and the hint lies. That is
**F218**, and F217's guard must list it as a declared exception until it lands.

## What F215 found: the store could not have learned a declared shape even if it asked

The store's `IdShape::KimiSession` went, along with the third hand-rolled copy of the uuid and ULID
rules; `record_conversation` takes the pattern its caller reads from the CLI's own recipe, matched
through `red_agents::id_matches` — now the single matcher, with `launch` and `parsers` asking it too
rather than keeping a copy each. What stays in the store is `minted_shape`, rEngine's own id, which
is the store's to know because rEngine writes it when no CLI has named a conversation.

Underneath that sat a quieter bug: the store's registry lookup read the shipped document and passed
`None` for the extra one. **A recipe added as data could never have had its conversation shape
reach the store** — the central promise of the registry, broken in the one component that persists
what a recipe declares. It reads the extra document now, and the evidence is a CLI called
`shoutycli` whose ids are `CONV-nnnnnn`: no code anywhere in the tree mentions it, its ids are
accepted, and everything else is refused with the message unchanged.

## A spec that drives a Rust binary must build it

Not a provider question, but it nearly cost this work its evidence. Twenty-four specs drive a Rust
service and never built one. Under `npm test` the `pretest` step covers them; run alone — which is
exactly how a sabotage is checked — they judge whatever binary happens to be on disk. The F214
fixture *passed against its own sabotage* for that reason, and only a second look caught it.

They all call `built('--bins')` now (a no-op under the suite), and the same sabotage that silently
passed fails on its own. A regression checked against a stale binary is not a regression.

## What F216 found: the gate, the reader and the probe were three identity checks, in three languages

`red-host` refused a handoff unless the agent was literally `codex`; `agent.sh`'s `check-resume`
refused every agent but codex by name; the JS door did the same. Three copies of one question.

The question is a capability, so the recipe answers it: `conversation.handoff` declares `kind` — how
this CLI stores its conversations — and `ready`, what "ready to resume" means for it, as probes run
with the CLI's own executable. `red-host` implements the kinds and dispatches to an adapter;
`handoff.rs` became `handoff/mod.rs` (the manifest, which is rEngine's format) and `handoff/codex.rs`
(the rollout store, which is codex's). The shared half names no CLI, and a kind rEngine has no
reader for is refused **by the kind**.

Three things fell out of it:

- **A fourth copy of the id shape.** The manifest carried its own `is_uuid`, so a CLI whose recipe
  declares a different shape would have had its own ids refused. It uses the declared pattern now.
- **The same extra-registry bug as F215**, in `red-host`'s `recipes()`: it read only the shipped
  document, so a CLI added as data was invisible to the door.
- **`agent.sh`'s probe loop ran in a subshell** as first written here, where a failing probe would
  have exited the subshell and left `check-resume` reporting success. It reads from a here-document
  instead, and that is checked.

**One observable string changed**, deliberately: `Handoff requires the Codex workspace launcher.` is
now `Handoff requires a workspace launcher for a CLI that can be handed a conversation.` The refusal
means something different than it did — not "you are not codex" but "this CLI declares no handoff" —
and leaving the old wording on the new meaning would be worse than changing it.

`orchestrator/agents/handoff.mjs` still reads codex's rollouts in JavaScript. That is the JS half of
the `rollout-jsonl` kind, retiring under D57 with the rest of the JS host; its gate and its probe now
ask the recipe, so the two halves agree about *who* can be handed a conversation.

## Where the implementation departs from F213's written criteria — for the owner

F213's row says *"each agent's flag parsing lives in a file named for that agent"*: three adapter
files. What landed has **no per-agent parser file at all**, because the survey found the difference
between claude and kimi was not code — it is the same flag scan with different flag lists. Three
files of identical code around different constants would be duplication wearing an abstraction's
clothes, and the constants belong where every other per-agent datum already lives: the registry.

So each agent's flag parsing does live in exactly one place that names it — `registry.toml` — and
shared code implements two spellings named for what they do. The row's third criterion ("the shared
module contains no agent name") is met more completely this way than by the route the first
criterion describes. **The criteria are left as accepted and the row is not marked passing on this
reading; the owner's call.** Where an agent genuinely differs in *code* rather than data — the
conversation stores of F210 — the per-agent file stands, and this does not weaken that.

## Sequence

F213 (parsers to declared spellings) unblocks F215 (the store's shape) and F216 (codex handoff),
because all three stop at the same place: a declared pattern and a declared capability. F214 follows.
**F217 lands last and proves the rest** — it is the row that makes this stay true.
