## Jev is available in this workspace (typesafe.ai)

A judgement service is switched on here. You do not need to install anything to use it — no skill, no
marketplace, no `npx`. The capability is already on your tool list, namespaced `jev.*`, and the
workspace holds the credential.

**What Jev is.** A "System One" model: you send it *state* and *typed questions*, and it returns
machine-readable answers with probabilities instead of prose. You do not parse its output — you read
fields. It is fast (~600 ms here) and very cheap (~$0.00002 a call), which makes it suitable for
judgements you would otherwise guess at or ask a person about, and unsuitable for anything on a
keystroke.

**The three question types.** `noul` asks a yes/no and returns a probability — and **no confidence
field**. `choice` picks one of a set you define and returns the pick, the full distribution and a
confidence. `score` rates against ordered levels and returns a level, the distribution and a
confidence. All three can be mixed in one call against one shared state, evaluated in parallel.

**Read the distribution, not the scalar.** Every answer here carries a `margin` — the gap between the
best and second-best outcome — and that is what to judge on. The service's own `confidence` is
reported beside it and is *not* what you should gate on: it was measured collapsing from 0.69 to 0.29
on the same decision when a clause was reworded, and it has returned 1.00 on judgement calls. For a
`noul`, distance from 0.5 is not a confidence proxy — it measures how decisively the model picked,
and a model forced to answer an ill-posed question answers extremely.

**Nothing is acted on automatically.** Every judgement is recorded and returned to you; the workspace
gates no decision on one. Deciding what to do is yours. If you use a judgement and later learn what
was actually true, that outcome is worth recording — an unrecorded outcome makes the whole experiment
unscoreable.

**What it is good at, from this project's own use:** deciding whether a test failure is a flake or
real, ranking or routing among options you define, verifying a claim against evidence, and scoring
something against a rubric you supply. It is not a general assistant and it does not write code.

**How to ask well.** Give it the state and one narrow question per judgement rather than one large
compound one; keep non-semantic logic in your own code; define the options or levels explicitly with
a short description each. If you are composing a request yourself: `choice` takes its criteria as a
**map** of option to description, `score` takes an **ordered list** of levels, and sending the wrong
shape is a 422.

The authoritative documentation is <https://docs.typesafe.ai/>, indexed at
<https://docs.typesafe.ai/llms.txt> — append `.md` to any page for its Markdown. Do not install a
skill to use what is already here.
