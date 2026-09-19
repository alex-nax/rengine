# Spec 153 — Jev flows: a library a project enables a subset of

Owner, 2026-09-19:

> *"So we have a standalone integration with JEV in ~/nolf-improved, also there in
> docs/jev-cookbooks.md there are some other examples of integration — we would like to have them
> all implemented, so that projects can have their own subset of flows enabled"*

Status: **built.** All 18 cookbooks are accounted for by the table below, every flow in the
registry has a runner, and rEngine runs six of them. F236–F240. Builds on spec 151 (the typed
judgement) and spec 152 (the service facet). Charter D74/D75 unchanged.

## What exists to draw on

`~/nolf-improved` runs four Python tools against the same service: `tools/prior_art.py` (506 lines,
and the de-facto shared client the other three import), `tools/prior_findings.py`,
`tools/assert_check.py`, `tools/ki_sweep.py`. `docs/jev-cookbooks.md` in that repo records all 18
vendor cookbooks read on 2026-09-18 and judged against problems that repo actually has: nine in
use, nine declined with a reason each, and a section on three that were built, measured and thrown
away.

**That file is evidence and this spec does not overturn it.** What it records is nine cookbooks
with no consumer *in a game port*. A library of flows that many projects draw on is a different
question, and the owner answered it: all 18.

Two things from it survive as constraints rather than opinions:

- **Every flow keeps working when Jev is unavailable.** Missing key, missing service, refused
  request: the flow says so and exits 0. Nothing in this workspace gates on a judgement.
- **`llm_guardrails` is not a security control**, on the vendor's own page: *"an attacker can talk
  that one past too."* It is built here as an advisory flag a person reads, and the flow is named
  for what it does rather than for the protection it does not give.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **A flow is a named judgement task; a cookbook is a technique.** The 18 cookbooks do not map one-to-one onto 18 tasks — `parallel_questions` is how every flow batches, and three of them are routing rules that several flows apply. So "all 18 implemented" is checkable per cookbook against the table below, where each is either a flow or a named shared mechanic with the flows that use it. Claiming a cookbook with nothing pointing at it is the failure mode this table exists to prevent. | Recommended |
| 2 | **A project declares its flows in `plugins/jev/flows.json`, beside a manifest of its own.** Per project root, because that is the unit that has a corpus: one project has `docs/antipatterns.md` and 1,394 features, another has neither. No change to the project contract, and the plugin architecture is used exactly as it stands. A project that pins rEngine points its manifest at the built binary in its submodule rather than carrying a second copy. | Owner, 2026-09-19, choosing per-project declaration |
| 3 | **A flow declares its surface: `tool` or `action`.** A per-item flow an agent calls is a tool. A corpus sweep is an action the owner starts and watches — `ki_sweep` is 2,477 requests and $0.95 a run, `assert_check` 130. An agent that can spend a dollar on a whim will. | Owner, 2026-09-19, choosing the split |
| 4 | **The tool cap binds the subset, and is not routed around.** Spec 152 decision 3 allows four tools per plugin; a project enabling five agent-callable flows is refused by name. Collapsing N flows behind one dispatcher tool would defeat the cap's purpose rather than respect it — the cost the cap exists to bound is the description text an agent reads, which a dispatcher carries just the same. Raising it is a decision with evidence, not a workaround. | Recommended |
| 5 | **A flow reads its own sources; the caller names them.** Spec 151's rule, kept: a flow's parameters are identifiers — a path the project declared, a feature id, a query — never a document the caller supplies. State is built inside the plugin by reading declared files and scrubbing them, so a tool call cannot be used to send arbitrary content to a third party. | Spec 151, unchanged |
| 6 | **Sources are declared per flow, not discovered.** `flows.json` names the files a flow reads, relative to the project root, and a path that leaves the root is refused. A flow with no declared source is not enabled, rather than falling back to a guess about where a project keeps its lessons. | Recommended |
| 7 | **The service computes the tool list from the flows a project enabled.** `service.tools` may be a subcommand NAME instead of an array; core then asks the plugin what it offers, and caps and namespaces the answer exactly as it does a declared one. Without this, `flows.json` and `plugin.json` are two lists that must agree, and they will not. | Recommended |
| 8 | **Every gate is named, shared, and tested once.** The routing rules are the part most likely to be quietly reimplemented per flow with a different constant. They live in one module with their thresholds and the measurement behind each. | Recommended |
| 9 | **A threshold carries where it came from.** NOLF's file distinguishes the ones it measured (`CONFIDENT = 0.60`, on a 339-row sweep run twice) from the ones taken from a cookbook unvalidated (`AUTO_ACCEPT = 0.80`, `ESCALATE = 0.70`). That distinction travels with the constant, because a number nobody measured should not be quoted as though somebody did. | NOLF's own file |
| 10 | **The autoresearch loop is built to its useful edge and stops there.** Proposing questions and turning free text into numeric columns is built. The CatBoost regressor is not: it needs a labelled numeric target this workspace does not have, and a gradient-boosting dependency in a plugin that currently has none. The flow emits the matrix; fitting it is somebody's own business. | Recommended |
| 11 | **A caller names a file INSIDE a directory the project declared, never a bare path.** The flows that read a document take a filename from whoever calls them, and a flow that read whatever it was told to would read any file in the project — including the one the API key lives in. So the project declares a directory per flow, the caller names something inside it, and anything resolving outside is refused by name. Same rule as a declared source, one level down. | Recommended; the hazard was found while building `reformat` |

## The 18 cookbooks, and what each one is here

| Cookbook | Realised as | Consumer |
|---|---|---|
| `parallel_questions` | **mechanic** — one request carries a map of questions | every flow |
| `consistency_noul` | **gate** `band` — 0.30/0.70 rather than a cut at 0.5 | `prior-art`, `find` |
| `consistency_choice` | **gate** `abstain` — below 0.60 answer "unsure" | `prior-art`, `classify` |
| `classification_using_confidence` | **gate** `back_off` — name the broader level instead | `prior-art`, `ki-sweep` |
| `sde_cascade` | **gate** `escalate` — true means escalate, aggregate with `max` | `evidence-check`, `hazards` |
| `entity_alignment` | flow **`align`** — the 3-level Score whose levels are the outcomes | `prior-art`, `ki-sweep` |
| `semantic_find` | flow **`find`** — Choice over a corpus plus a presence Noul | `prior-findings` |
| `citation_check` | flow **`evidence-check`** — does the cited evidence support the claim | `assert-check`, features.json evidence |
| `classifying_rag_passages` | flow **`passage-triage`** — keep / flag / drop, and the injection question | report intake |
| `rerank_typesafe` | flow **`rerank`** — one Noul per candidate, sorted | any shortlist |
| `hierarchical_classification` | flow **`classify`** — beam search, K=3, geometric-mean edges | a declared taxonomy |
| `skill_suggestion` | flow **`skill-pick`** — rank the roster, then read the top three | `.claude/skills/` |
| `function_calling` | flow **`action-intent`** — a sentence to a declared dashboard action and its args | `dashboard_actions` |
| `autoformat` | flow **`reformat`** — stitch lines, classify blocks, assemble in code | a pasted log or report |
| `pre_parsed_value_extraction` | flow **`extract`** — regex candidates, Choice picks the span verbatim | ids and paths out of a run |
| `date_extraction` | flow **`dates`** — seven Choices, the calendar maths in code | progress and report text |
| `llm_guardrails` | flow **`hazards`** — four Nouls and a severity Score, **advisory** | report intake |
| `autoresearch_feature_discovery` | flow **`featurize`** — questions to numeric columns; no regressor | an experiment of one's own |

And the composites NOLF already runs, each built from the above rather than beside it:
**`prior-art`** (sweep, align, and the report's own three judgements), **`prior-findings`** (`find`
over lessons and antipatterns), **`assert-check`** (`evidence-check` swept over a tests tree,
surface `action`), **`ki-sweep`** (`prior-art` over known-issues rows, surface `action`), and
**`triage`**, which already exists.

## The shape on disk

```
plugins/jev/
  plugin.json       service.tools is the name of the subcommand that lists them
  flows.json        THIS PROJECT's enabled flows and the sources each reads
  instructions.md   what every agent is told while the plugin is on
  server/           one binary, shared by every project that pins this checkout
```

## Two projects, two subsets

rEngine's own declaration, which is what it runs on:

```json
{ "flows": [
  { "name": "triage" },
  { "name": "find",           "sources": { "corpus": "known-issues.md" } },
  { "name": "prior-art",      "sources": { "features": "features.json" } },
  { "name": "prior-findings", "sources": { "corpus": "docs/lessons-learned.md" } },
  { "name": "assert-check",   "sources": { "tests": "tests" } },
  { "name": "ki-sweep",       "sources": { "issues": "known-issues.md",
                                           "features": "features.json" } }
] }
```

Four tools and two actions. An action does not count against the tool cap, because it is never
offered to an agent.

**NOLF's is a different subset over a bigger corpus.** It was written here first, as a proposal,
and then corrected by running it — spec 154 and F241 carry the adoption. What it runs on is:

```json
{ "flows": [
  { "name": "prior-art",      "sources": { "features": "features.json" } },
  { "name": "prior-findings", "sources": { "corpus": "docs/lessons-learned.md",
                                           "antipatterns": "docs/antipatterns.md" } },
  { "name": "assert-check",   "sources": { "tests": "tests" } },
  { "name": "ki-sweep",       "sources": { "issues": "known-issues.md",
                                           "features": "features.json" },
                              "settings": { "only": "OPEN" } }
] }
```

Two corrections the run made to the proposal, both recorded in spec 154. **`passage-triage` is not
in it**: this spec proposed it because that project's reports come from strangers at release, but
the flow takes a `claim` that is an id IN a corpus, so it triages a passage already on file rather
than an incoming report — and the injection question NOLF wanted is inside `prior-art` already. And
**`ki-sweep` declares `only`**, because "open" is a word in that project's own document rather than
a concept this plugin has, and a sweep that does not know it spends most of $0.95 on closed rows.
rEngine's own list marks the opposite — nothing when open, `**Closed` when done — so it declares
`except`, which is why this is a declaration rather than a constant.

It sits beside a manifest whose `service.command` is
`["third_party/rengine/plugins/jev/server/target/debug/red-jev"]` — one binary, shared by every
project that pins this checkout, rather than a second copy of it.

The difference between the two files is the whole point: NOLF declares `antipatterns`, which
rEngine has no document for, and a marker for which of its issues are open. rEngine declares `find`
and `triage`, which NOLF has no use for. Neither list is the plugin's idea of what a project should
want.

## What this does not do

- It does not gate anything on a judgement, and does not change that nothing is acted on
  automatically.
- It does not let a caller put a document into a request; a flow reads its own sources.
- It does not raise the tool cap, or hide a tool list behind a dispatcher to avoid it.
- It does not make `llm_guardrails` a security control, and says so where the flow is declared.
- It does not fit a model. `featurize` produces columns and stops.
