# `poweredBy` leaves the manifest (charter D45)

Date: 2026-09-08. Status: **decided and implemented.** The owner, on being asked to sign the first
adoption off and write `poweredBy` into NOLF's declaration:

> "poweredBy" is just an abstract no need to brand it

## What this closes

[Spec 110](110-library-adoption.md) left exactly one question open and named the condition for
answering it:

> **Whether `poweredBy` should stay in the manifest at all.** It is a claim, and D44b makes the spec
> the proof. Leaving both means two places say something about adoption. Worth revisiting **once one
> real sign-off exists and the duplication is concrete rather than theoretical.**

Both halves of that condition came true the same week. The first adoption is real and measured
([spec 111](111-iklib-adoption-nolf.md): 20 240 scenes, worst deviation 2.7e-5 LT), and its sign-off
record sits in that spec with every slot filled. So the duplication stopped being theoretical: the
adoption was about to be stated in two places, and the owner was asked to write the second one.

The answer is that the second place should not exist. Powered-by is a **bar**, not a **badge**.

## Decision

| # | Decision | Attribution |
| --- | --- | --- |
| D45 | **`poweredBy` is removed from the pack manifest. Adoption is recorded, never claimed.** D24's definition — one curated capability at a pinned version with passing game integration checks — stays exactly as written and stays the bar. What goes is the idea that a project *announces* having met it. A declaration says what a project **consumes**: a pack, its pin, its facets. Whether that consumption amounts to an adoption worth the name is a judgement, and D44b already put judgements in a spec signed by the owner. | Owner, 2026-09-08: *"'poweredBy' is just an abstract no need to brand it"* |

**This revises D44 in one clause and leaves the rest standing.** D44 said *"A `poweredBy` flag in a
pack manifest stays the project's claim; the D24 badge is earned when the owner records the pack, the
exact pin, the project and what was seen."* The second half is untouched and is now the whole
mechanism. The first half is withdrawn — there is no flag, so there is no claim to keep separate
from the proof.

**D44b is untouched.** The owner's words were about branding, not about evidence. The sign-off record
of spec 110 — pack, both halves of the pin, project and checkout, what was actually run and seen,
date and the owner's own words — is unaffected, and spec 111 still waits on it.

## Why removing beats keeping-and-ignoring

Contract 9 is hours old and **no declaration anywhere carries a `packs` block yet** — checked on
2026-09-08 across `~/nolf-improved/.rengine/project.json`, `~/vtmb-vr/.rengine/project.json` and
Kohai's external `~/.local/share/redit/hirebase-v2/project.json`. Nothing breaks, and this is the
cheapest hour the removal will ever cost. A key kept "for compatibility" with zero users is a key
kept for nobody.

The alternative — leave it in the schema and stop meaning anything by it — was rejected because it
produces the worst artifact of the three: a declaration that can still say `poweredBy: true` while
nothing reads it, which is a claim with no reader and no refuser. Spec 107 was explicit that the key
existed so *"D24 becomes legible"*. If it no longer carries that, it carries nothing.

## What changes

- **The schema** loses `packs[].poweredBy`. With `additionalProperties: false` already in force on
  `$defs/pack`, a declaration carrying it is now **refused** rather than ignored.
- **The cross-field rule** in `orchestrator/server/formats.mjs` inverts its purpose rather than
  disappearing. It no longer asks *which facet earns the key*; it says the key is gone and where the
  record went. This follows the pattern that file already documents for a key in the wrong facet:
  the schema says *unknown*, and the rule says *what to do about it*. Only the second is any use to
  a person, and only the first survives if the key sets change, so neither is redundant.
- **The refusal names the successor**, because a removal that only says "no" teaches nothing. Both
  layers report through `packsError`, joined — measured, not assumed:

  ```
  .rengine/project.json: $.packs[0] has unknown key poweredBy;
  $.packs[0] (iklib).poweredBy was removed: an adoption is recorded by the
  owner's sign-off in a spec (charter D45), not claimed in a declaration
  ```

  The first sentence is the schema refusing a key it does not know; the second is this rule saying
  what happened to it. Deleting the rule leaves only the first, which is true and useless.

## What does not change

- **D24's bar.** A pinned curated capability with passing game integration checks is still what
  "powered by rEngine" means, and `AGENTS.md` still says so. Only the announcement is gone.
- **The `library` / `plugin` facet distinction (D39).** It was doing real work independently of this
  key — it says how a pack is consumed — and D24's clarification that an editor plugin is not an
  adoption survives as prose in that decision rather than as a validation rule.
- **Every other pack refusal.** A pack with no facet, a repeated name, a facet key under the wrong
  facet, a non-digest revision and an escaping path are all untouched.

## The cost, named

**F109's acceptance criteria assert behaviour that no longer exists.** Two of them describe the
`poweredBy` refusal by name. `AGENTS.md` forbids rewriting an accepted requirement to make it pass
and requires a recorded rationale and an owner decision for a necessary correction; this spec is that
rationale and D45 is that decision. F109's criteria are therefore left **exactly as written** — they
record what was true when they passed, and F111 records the removal that superseded them. Editing
them would erase the fact that the key ever shipped, which is precisely the history a decision table
exists to keep.

**A sabotage in the evidence document is now unreachable.** `docs/evidence/pack-manifest-2026-09-07.md`
S9 inverted D24's facet condition and was caught by the acceptance test rather than a refusal test —
a genuinely instructive case. The evidence document is a dated record of a run that happened, so it
is not edited; this spec is the note that S9's subject is gone.

## Evidence

RED first: with the rule still reading `poweredBy !== undefined && library === undefined`, the new
case reported *"onLibrary: no refusal was reported at all; the declaration was accepted"* — the
library facet accepting the key, which is exactly the behaviour D45 removes, and not some earlier
failure. GREEN after: `node --test orchestrator/tests/packs.test.mjs` 4/4.

Three sabotages, each applied to `formats.mjs`, run, restored, and byte-compared with `cmp`:

| Sabotage | Expected | Observed |
| --- | --- | --- |
| S1 — restore D24's old condition (`&& pack.library === undefined`) | only the library-facet case fails; the plugin one still refuses | `onLibrary` alone fails, 3 pass |
| S2 — check truth instead of presence (`if (pack.poweredBy)`) | only `poweredBy: false` fails | `denying` alone fails, 3 pass |
| S3 — delete the named rule, leaving the schema's unknown-key refusal | the document is still refused, but the message no longer says where the record went | `onLibrary` fails on the message, 3 pass |

S3 is the one worth keeping: it proves the rule is not redundant with the schema. Without it the
declaration is still rejected — so a test asserting only *"is it refused"* would stay green — and
the person reading the error is told the key is unknown and nothing else.
