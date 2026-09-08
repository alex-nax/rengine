# Library adoption into the suite (charter D44)

Date: 2026-09-08. Status: **design interview complete; nothing implemented.** Asked for by the owner:
*"we need to design a mechanism for library adoption to our suite"*. Continues
[spec 107](107-pack-manifest.md), which gave a pack its `library` facet and a `poweredBy` flag, and
answers the half [KI-003](../../known-issues.md) has held open since the first day: *"Powered-by
minimum is confirmed as verified pinned capability adoption; **its record format remains proposed**"*.

## What already exists, and what was actually missing

- **The declaration exists.** Since F109 a project declares a pack with a `library` facet, a two-part
  pin (`version` said, `revision` checked) and an optional `poweredBy`. That shipped today.
- **The claim is not the proof.** D24 requires adoption "at a pinned version **with passing game
  integration checks**". The pack lane said it plainly in its own report: *"`poweredBy` in a
  declaration is a subject, not a proof."* A declaration is a sentence a project writes about itself.
- So the missing mechanism was never the manifest. It is **who holds the evidence, and what counts as
  evidence.**

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| D44 | **The adopting project holds the evidence; rEngine reads it and never asserts it.** The game runs its own integration checks in its own checkout and records the result beside its own declaration. This is not a new rule so much as an existing one applied: `AGENTS.md` already says *"A local task cannot mark another project's feature done"*, and a curator that recorded "VtMB passed" would be doing exactly that from outside the checkout where it happened. | Owner, 2026-09-08, confirming the recommendation |
| D44b | **The proof is an owner's sign-off recorded in a spec**, not a command rEngine runs. An adoption becomes real when the owner records it — pack, pin, project, what was seen — in a spec under `docs/specs/`, the same place every other decision of consequence lives. `poweredBy` in a manifest remains the project's claim; the badge is earned by the recorded sign-off. | Owner, 2026-09-08, **overruling the recommendation** of a declared check command |

## Why the recommendation lost, and what it costs

The recommendation was a **declared check command** in the pack entry — a command the project runs to
prove the adoption, under the declared-command boundary that already runs previews, dashboard actions
and language servers. Its appeal was reproducibility: anyone with the checkout could re-run the proof.

The owner chose sign-off, and the honest reading is that it is more truthful about who is deciding. A
green command proves a command went green; it does not prove the adoption is *good*, and D24's bar —
a curated capability actually carrying a game — is a judgement, not an exit code. Recording that
judgement in the place judgements already live is consistent with how every other decision here works.

Two costs, named now rather than discovered later:

1. **It does not scale past the projects the owner personally watches.** Two games and one business
   project is exactly the scale where this is right; a curated library with outside adopters is not.
   The successor is not a different idea — it is this one with a command attached — so the sign-off
   record should carry enough detail that a command could later re-derive it.
2. **A sign-off is a dated statement about a pin.** When the pin moves, the sign-off does not follow
   it. A record that does not name the exact `revision` it was given is worthless six months later,
   which is precisely why F109's pin has a checked revision and not only a spoken version.

## What a sign-off record must contain

Not a schema — a spec is prose — but a sign-off that omits any of these cannot be checked later:

- the **pack** and the exact **pin**, both halves: the version that was said and the revision that
  was checked;
- the **project** that adopted it, and the checkout it was verified in;
- **what was actually run and seen**, in the project's own terms — its gates, its game, its evidence
  document — rather than "the checks passed";
- the **date and the owner's own words**, as the charter's decision rows already carry.

## What this does not decide

- **Whether `poweredBy` should stay in the manifest at all.** It is a claim, and D44b makes the spec
  the proof. Leaving both means two places say something about adoption. Worth revisiting once one
  real sign-off exists and the duplication is concrete rather than theoretical.
- **The first adoption.** F61 — the renderer as a curated capability with one game adopting it — is
  still open, and it is the obvious first candidate. Nothing here starts it.
- **Anything about acquisition.** KI-008 stands: where a pack's bytes come from is still unresolved,
  and D38's no-hidden-downloads boundary constrains whatever answers it.
