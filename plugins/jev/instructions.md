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

**The tools you can see are the flows THIS project enabled.** The plugin holds a library of them —
searching a corpus, aligning two records, checking whether cited evidence supports a claim, ranking
a shortlist, placing something in a taxonomy, reading a value verbatim out of a document — and each
project switches on the subset it wants. So do not reason from what Jev could do in general: read
your own tool list, and if something you want is not there, it was not enabled here rather than not
built. The expensive ones are corpus sweeps and are deliberately not tools at all; somebody starts
those and watches them.

Every flow answers with the full distribution, a `margin`, and `acted: false`. The parameters are
identifiers — an id in a corpus, a filename inside a directory the project declared, a question
somebody typed — never a document you paste. That is what makes them safe to call: a flow reads its
own sources, so a tool call cannot be used to send this project's files anywhere.

**What it is good at, from this project's own use:** deciding whether a test failure is a flake or
real, ranking or routing among options you define, verifying a claim against evidence, and scoring
something against a rubric you supply. It is not a general assistant and it does not write code.

**How to ask well.** One narrow question per judgement rather than one compound one, and keep the
non-semantic logic in your own code. You do not compose requests here — the flows do, and they carry
the question shapes and the thresholds that were measured for them.

The authoritative documentation is <https://docs.typesafe.ai/>, indexed at
<https://docs.typesafe.ai/llms.txt> — append `.md` to any page for its Markdown. Do not install a
skill to use what is already here.
