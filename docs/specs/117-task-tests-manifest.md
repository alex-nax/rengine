# Contract 10: a project declares the tests behind its tasks (F116)

Date: 2026-09-09. Status: **implementing.** Second slice of lane T0 (charter D47, spec 114), after
[spec 116](116-task-evidence.md) put the `evidence` strings the inventory already held onto the row.

## What F115 could not answer

F115 answers *"where is the test"*. It cannot answer *"is the test correct"*, because an `evidence`
string is identity and claim collapsed into prose — and `AGENTS.md` defines correctness as something
prose cannot carry:

> A regression counts as established only once it has been **observed failing for its own reason**.

So the field that decides the owner's question is the **sabotage record**: what was broken, and what
went red because of it. A format without it is a bibliography, not evidence.

## The shape

**The declaration names a file; it does not contain the data.** Contract 10 adds a `tests` block
whose only required key is `manifest`, a root-relative path (declaration-relative for an external
project, like every other declared path). The project produces that file with its own tooling. This
keeps D44 intact — the project holds the evidence, rEngine reads it — and keeps the declaration
small enough that a person can still read it.

**The manifest has its own schema**, `contracts/task-tests-v1.schema.json`, because it is a different
artifact with a different producer and a different lifetime from the declaration. It carries a
version, when and at which commit it was produced, and its entries.

**An entry is keyed by the provider's own task key**, so the same format serves all three providers:
`F123` for a local inventory, `BAS-1020` for Linear, `#42` for GitHub. rEngine joins on `row.key` and
never parses the key's meaning.

```json
{ "version": 1, "at": "2026-09-09T12:00:00Z", "commit": "0dd8c66…",
  "entries": [{
    "task": "F115",
    "test": { "path": "orchestrator/tests/tracker.test.mjs", "name": "a task carries the evidence…" },
    "claim": "the evidence reaches the row and a remote provider answers with an empty list",
    "criteria": [1, 2],
    "tier": "gate",
    "preconditions": ["node"],
    "sabotage": [{ "break": "drop the localRows mapping", "red": "the evidence reaches the row verbatim" }],
    "last": { "result": "pass", "at": "2026-09-09T12:00:00Z", "commit": "0dd8c66…", "host": "macos", "log": ".cache/evidence/…" }
  }]}
```

## The rules that make it worth having

**An entry with no sabotage rows is `unproven`, not passing.** This is the whole point of the format.
`last.result: "pass"` says a command went green; the sabotage rows say the test can go red for its own
reason. rEngine reports the distinction and never collapses it.

**An entry that claims a criterion the task does not have is refused by name.** A manifest drifts
from its inventory the moment a criterion is renumbered, and a claim pointing at criterion 7 of a
five-criterion task is worse than no claim: it reads as coverage. Local rows know their criteria, so
the join is checkable; remote rows do not, and there the index is carried without a claim about it.

**rEngine runs nothing and derives nothing.** No entry changes a task's state. A manifest that says
everything failed leaves every row exactly where the provider put it. This is D44 and D47 as written,
and the first thing a later reader will be tempted to break.

**Staleness is shown, not judged.** The manifest states the commit it was produced at; the reader
resolves the project's current commit from `.git` **by reading files, never by running git**, and
reports whether they match. When it cannot tell — a packed ref, an unusual layout, no `.git` at all —
it says *unknown* rather than guessing, because "stale" and "cannot tell" are different answers and
only one of them is a reason to distrust the record.

## What this slice does not do

- **It does not run tests, and it does not offer to.** That needs a charter revision of D44 first.
- **It does not write anything.** Filing a verdict about a bad test is F117.
- **It does not produce a manifest for any project.** rEngine reads; each project's own tooling
  writes. rEngine's own manifest is a natural first producer and is not part of this slice.
- **It does not resolve packed refs.** `.git/HEAD` → a loose ref file is handled; a packed-refs
  lookup is a follow-up, and until then those checkouts report *unknown*.

## Evidence

**RED first, three cases, each for its own reason.** With nothing implemented: the join case failed
on `byKey.F1.tests` being absent; the drift case on an empty `testsError`; the contract case on
`tests requires contract 10` never being said. GREEN after: `tracker.test.mjs` 11/11,
`native-tracker.spec.mjs` 2/2, `npm test` 230/230.

Four sabotages, each applied, run, and the file restored and compared:

| Sabotage | Expected | Observed |
| --- | --- | --- |
| S1 — `proven` from `last.result === 'pass'` | a green run passes for a test that bites | *"no sabotage rows means unproven, however green its last run was"* fails alone |
| S2 — drop the criterion-drift check | a claim past the task's criteria is accepted | *"reads as coverage it does not have"* fails alone |
| S3 — let an unproven entry move the row to `blocked` | a manifest changes a task's state | *"not even one whose test is unproven"* fails alone |
| S4 — the pane reads `proven` from the last result | the pane fakes proof the reader refused to | *"an entry with no sabotage rows says UNPROVEN"* fails alone |

S3 is the one worth keeping: D44 and D47 both rest on rEngine never asserting anything about another
project's tests, and it is the rule a later reader is most likely to break in good faith — a failing
test *looks* like it should block a task.

**Three contract tripwires fired, which is what they are for.** `packs.test.mjs` and
`task-writes.test.mjs` each pin `CONTRACTS.at(-1)` so that whoever raises the ceiling must come and
confirm the earlier blocks still read as they did. Both now carry a *Confirmed for 10* note beside
the existing ones for 8 and 9. The third was a refusal message asserting the supported list as a
literal string; it now derives the list from `CONTRACTS`, so it states the invariant rather than a
copy of it that has to be re-typed on every bump.

## A defect found and fixed on the way

The Tests caret narrowed the title column, which made an old bug visible: `re_ui_label_ex` drew at
its cell's origin and **never clipped to the cell**, so a long task title ran straight across the
buttons beside it and out to the pane edge. The owner reported it from the Tasks view.

`ui.c` already had the right helper — `text_clipped`, which keeps the adapters' batch when the text
fits and narrows the scissor only when it does not — and the label simply was not using it. One line.

**It has no automated regression, and that is worth saying plainly.** No test in this repository
builds owned UI controls: `draw_list_test.c` works below the UI layer, and the automation snapshot
reports a control's *cell* rect, which was correct in both the broken and the fixed version — the bug
was the text drawn beyond it. A regression needs a UI-level harness that can render a control and
inspect the emitted draw list for the clip. That is genuinely useful beyond this fix and is its own
slice; until it exists, this change rests on the render suite staying green and on the owner's eye.
