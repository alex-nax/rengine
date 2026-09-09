# A task carries the evidence that backs it (F115)

Date: 2026-09-09. Status: **implementing.** First slice of lane T0 (charter D47, spec 114), chosen by
the owner: *"I think we would want to start testing integration lane first"*.

## The defect, in one sentence

Every `features.json` row already carries an `evidence` array naming the test and what it proves, and
`localRows` maps `acceptance_criteria` and **never maps `evidence`** — so the field dies one function
before the UI, and no surface in the workspace can answer *"what test backs this task?"*

Measured at `orchestrator/server/tracker.mjs:104-116`. The neutral row (`:67-82`) has carried
`criteria` since spec 103 for exactly this kind of reason; `evidence` was simply never added beside
it.

## Why this slice first

D47 says rEngine reads a project's test evidence and never asserts it. Everything else in T0 — the
contract-10 manifest (F116) and filing a verdict as a task (F117) — is built on a person being able
to *see* what backs a task. This slice needs no contract change, no new declaration key and no
producer in any project: the data is already there and already read.

## What changes

**The row.** `row()` gains `evidence: value.evidence ?? []`, beside `criteria` and for the same
reason. `localRows` maps `feature.evidence` when it is an array of strings. Providers with nothing to
give answer `[]`, exactly as they already do for `criteria` — a Linear issue body is prose, not an
evidence list, and guessing at one would be worse than an honest empty.

**The pane.** A third chooser kind. `RE_CHOOSER_SPAWN` and `RE_CHOOSER_HOLD` already open inline rows
under their task, for the reason `tracker.c` records: the pane is a scrolled list, an overlay would
cost one of the root containers the panes fill, and *"a chooser that scrolls with its row cannot end
up describing a different task than the one under it."* Evidence wants the same treatment, so
`RE_CHOOSER_TESTS` joins them behind a **Tests** caret.

The block pairs each criterion with the evidence recorded for it. Criteria are drawn in the Spawn
chooser today because that is where the prompt is composed; they are drawn here too because *"what
does this task claim"* and *"what proves it"* are one question, and reading them apart is what makes
the Tasks tab unable to answer it.

**The caret is drawn on every row, including remote ones.** A row with nothing to show says so rather
than hiding the control, following the rule the agent list already applies — an uninstalled CLI *"is
shown and named rather than hidden, so 'why is codex not there' has an answer on the surface instead
of in a log."* The same argument holds here, and more strongly: an absent Tests caret would read as
*"this task has no tests"* rather than *"this provider cannot say."*

**One shipped drift corrected.** `contracts/project-v1.schema.json` describes the `local` provider as
reading features.json *"through tools/features.py"*. It does not — `tracker.mjs:94` reads the file
directly with `readFile` and re-implements the readiness rule. Spec 083's own prose is right; only
the schema description is wrong, and it has been wrong since contract 5.

## What this slice does not do

- **It does not carry sabotage evidence, tiers, preconditions or last results.** Those need a
  structured entry, which is F116's contract-10 manifest. An `evidence` string is identity and claim
  collapsed into prose, so this slice answers *"where is the test"* and not yet *"is it correct"*.
- **It does not open the test.** A gesture that opens the named file from the Tasks tab is worth
  having and is not this slice; the strings are shown as written.
- **It does not touch `tools/features.py show`**, which also omits evidence. Same field, different
  surface, and the tool is not what the owner asked about.

## Evidence

**RED first, for its own reason.** With the row mapping absent, the new case reported *"the evidence
reaches the row verbatim, the way criteria already do"* — the field undefined, which is the defect
itself and not an earlier failure. GREEN after: `tracker.test.mjs` 8/8, `native-tracker.spec.mjs`
2/2, `native-tasks-controls.spec.mjs` unchanged, `npm test` 227/227.

Five sabotages, each applied, run, and the file restored and compared:

| Sabotage | Expected | Observed |
| --- | --- | --- |
| S1 — drop the `localRows` mapping | the local row loses its evidence | *"the evidence reaches the row verbatim"* fails alone |
| S2 — accept a non-array verbatim (drop the filter) | a malformed field reaches the row | *"a non-array is refused into an empty list"* fails alone |
| S3 — drop `row()`'s default | the **remote** row loses its empty list | *"a GitHub row carries no evidence, and says so with a list"* fails, with the local case |
| S4 — draw the Tests caret only on local rows | the caret disappears from remote rows | **stayed green — see below** |
| S5 — drop the empty-case line | an empty block instead of a sentence | *"a task with no evidence says there is none"* fails alone |

**S3 needed a second assertion before it could bite.** With only the local cases, removing `row()`'s
default failed on the *first* assertion, because the field vanished for everyone at once — the
remote-provider default was never isolated. The GitHub row test now asserts `evidence: []` explicitly,
which is the only place that default is load-bearing, since no remote path sets the field.

**S4 stayed green, and that is a coverage gap rather than a pass.** Every row in the native fixture
comes from a `local` provider, so gating the caret on `local` changes nothing the harness can see.
The design decision — draw the caret on every row, because an absent control reads as *"this task has
no tests"* rather than *"this provider cannot say"* — is therefore **implemented but unverified in the
native suite**. The data half is covered (`tracker.test.mjs` asserts a GitHub row answers `[]`); the
rendering half needs a native fixture with a remote provider that returns rows, which the desktop
harness cannot inject today because the binary makes its own requests. Recorded rather than papered
over; a native remote-row fixture would close it and is worth its own slice.
