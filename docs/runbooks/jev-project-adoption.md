# Adopt the Jev flows in a project

The recipe `~/nolf-improved` followed on 2026-09-19, generalised. It takes a project from "no
judgements" — or from its own hand-written integration — to a declared subset of flows answering
in its own corpus, with the old implementation retired on evidence rather than on faith.
Spec: `154`. Everything it measured: `docs/evidence/jev-migration-2026-09-19.md`.

rEngine owns the flows, the gates and the thresholds. The project owns which flows it enables,
which of its documents each one reads, and what its own words mean.

## What you get

Eighteen cookbooks' worth of judgement as a library, of which you enable a subset. A flow is
either a **tool** an agent calls with the plugin switched on, or an **action** a person starts and
watches. At most four tools per plugin; an action does not count, because it is never offered to an
agent. Nothing is gated on a judgement and nothing is acted on automatically.

## 1. Pin the checkout and build the service

```sh
git submodule add git@github.com:alex-nax/rengine.git third_party/rengine    # if not already pinned
git -C third_party/rengine checkout --detach <revision on origin/main>
git -C third_party/rengine submodule update --init --recursive
( cd third_party/rengine/plugins/jev/server && cargo build )
```

One binary, shared by every project that pins this checkout. Do not copy it.

## 2. Declare the subset — `plugins/jev/flows.json`

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

Paths are relative to the project root and a path that leaves it is refused by name. A flow with
no declared source is not enabled, rather than guessing where you keep your lessons.

`red-jev flows --state DIR` lists what the registry offers, each flow's sources and its surface.

**`settings` is where your own words go.** `ki-sweep`'s `only` is the marker your document uses for
an issue that is still open — `OPEN`, `status: open`, whatever you actually write. The library does
not have a concept of open, and a sweep that guesses spends most of a dollar on closed rows.

## 3. Declare the manifest — `plugins/jev/plugin.json`

```json
{
  "name": "jev",
  "title": "Jev · typed judgements",
  "description": "…",
  "service": {
    "command": ["third_party/rengine/plugins/jev/server/target/debug/red-jev"],
    "describe": "status",
    "configure": "configure",
    "instructions": "third_party/rengine/plugins/jev/instructions.md",
    "config": [{ "name": "key", "label": "API key", "kind": "secret", "detail": "…" }],
    "state": "jev",
    "tools": "flows"
  }
}
```

Every path is from the **project root**, including `instructions` — which is why a project that
pins the plugin points at the prose in the pinned checkout rather than keeping a second copy of
it. `"tools": "flows"` is the important line: it is the NAME of a subcommand, so the tool list is
computed from `flows.json` rather than being a second list that has to agree with it.

## 4. Switch it on and give it the key

Plugins page → Jev → Set → paste → Save. The key is written to the workspace state directory,
never to the checkout, and is never shown again. By hand, if you must:

```sh
red-jev configure --state "$(pgrep -lf 'red-worker --state' | sed 's/.*--state //')/plugins/jev" \
        --key "$KEY"
```

That `pgrep` is also how you find the state directory for the two actions below: it is the
`--state` the running workspace was started with, plus `/plugins/<plugin name>`.

## 5. Verify, in this order

```sh
red-jev corpus  --state DIR --flow prior-findings --source corpus   # contacts nothing
red-jev flows   --state DIR
red-jev prior-findings --state DIR --query "something this project has decided"
```

**Run `corpus` first and read the count.** It is the cheapest check here and the one that catches
the failure that does not announce itself: a reader that made 145 entries out of 75, or 3 out of
600, still answers, and the answer reads exactly like a correct one. Check the count against what
you believe is in the file, and read a sample entry's `says` — it should be the text a person would
want, not a heading or a one-line index row.

Then confirm an agent can actually reach it. Listing a tool and calling it are different paths:

```sh
red-jev <flow> --state DIR --<argument> …      # the plugin's own path
```
and, for the path an agent takes, switch the plugin on and call `<plugin>.<flow>` from a pane.

## 6. Before you delete what it replaces

If the project already asks these judgements some other way, **do not delete it on the strength of
a code review.** Four defects in the rEngine flows survived a careful reading of both
implementations and were found in an afternoon by running them side by side.

1. **Fix a comparison set before you start, and write down why each input is in it.** Six to eight
   inputs is enough. At least two must be negative controls — questions the corpus cannot answer.
   An implementation that raises every answer looks like an improvement until you ask it something
   it should decline.
2. **Run both on the same inputs. Record the numbers, not an impression.**
3. **Treat every difference as a defect until it is explained.** Three outcomes are allowed: fix
   the library, record the difference as deliberate with a reason, or track the capability as not
   surviving. "Close enough" is not one of them.
4. **Then delete.** Two implementations of one judgement is two answers to it, and the one nobody
   is measuring is the one that drifts.

### The five traps, so you can check for them instead of finding them

Each of these was real, and each looked right in the source:

- **A question's instructions must name what is being asked.** Putting the query in the state and
  asking a generic question about it cost 0.21 of probability on a true hit. State is what the
  question is about; instructions are the question.
- **Give a set of options as a map keyed by id**, not a list of `{id, says}` objects. Worth another
  0.07–0.14.
- **Criteria carry the signal.** Cutting each criterion to its first clause cost 0.06–0.17, and it
  compounds with the one below.
- **A summary must carry the entry's body, not just its heading.** A Choice over documents whose
  summaries are headings ranks headings.
- **An id names one entry.** A document that carries an index table and the sections that table
  indexes yields each entry twice unless something says otherwise — and a Choice then ranks each
  entry against its own summary.

### When a flow disagrees with what you had

Isolate one variable at a time against the live service; each probe is a fraction of a cent and
the answer arrives in seconds. The four-condition grid in the evidence document took eight requests
and about $0.006, and it turned "the new one seems worse" into two numbered causes.

Check the negative controls under every condition. A change that lifts the true answer and the
false ones equally has changed nothing.

## What a project keeps for itself

- The subset, and what each flow reads.
- Its own words, in `settings`.
- The record of which cookbooks are worth asking here and which are not, with the measurement —
  NOLF's is `docs/jev-cookbooks.md` and it outlived the code it described.
