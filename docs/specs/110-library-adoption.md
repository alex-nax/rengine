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
- the **date and the owner's own words**, as the charter's decision rows already carry;
- **what it costs on the path it took over** — a measured number, not a reassurance. See below.

## The field this list was missing, found by the first adoption (2026-09-10)

The four items above are all about **correctness**, and the first real adoption proved correctness to
an almost excessive standard: F1706 compared 20 240 scenes and reported a worst deviation of 2.7e-5
LT. Its spec mentions allocation, frame time, budget and profiling **zero times**.

The defect that surfaced afterwards was a *cost* defect, on exactly the path the adoption had taken
over. NOLF's `ApplyArmEntriesToPose` — the applicator that consumes the solve's output — constructed
**three `std::vector`s per invocation**, on a path called from the display-time late-latch
(`app_vr_arm_latch.cpp:263`) and the PV-hands path (`vr_pv_hands.cpp:222`): per arm, per frame, in
VR. It is now fixed with retained `static thread_local` buffers, and NOLF's KI-526 is closed.

**The adoption did not cause it.** The allocations were F715's, pre-dating iklib. That is what makes
it worth writing down rather than filing as a bug: the adoption reviewed that seam more carefully
than anything else in the repository, and never looked at what it cost, because nothing asked it to.

**The requirement already existed — in the wrong document.** `docs/roadmap.md`'s M2 exit condition
says *"integration cost, resource behavior and rollback are recorded"*, and M1 asks for *"resource
requirements"*. This list, which is what an adoption is actually judged against, did not carry it. So
the roadmap and the record format have disagreed since D44b was written, and the first adoption fell
straight through the gap.

**And it recurred the next day, in a different lane.** [Spec 115](115-gpu-device-layer-and-simulator.md)
records that extracting the GPU device layer moves a per-frame solve from a header-only inline into a
linked library, and says plainly that nobody has measured it. Same class of gap, one day later — which
is the argument that this is systematic rather than a single oversight.

A cost line does not need to be elaborate. For F1706 it would have been one sentence: *allocations per
solve, before and after; the two call sites; the frame budget it sits in.* That sentence would have
found KI-526 during the adoption instead of two features later.

**This adds a field to D44b's record; it does not reverse it.** D44b remains that the proof is the
owner's sign-off in a spec rather than a command rEngine runs — a measured number is part of what the
owner is signing, not a check that replaces the signature. Worth the owner's explicit confirmation at
the next sign-off, since the record format is theirs.

## What this does not decide

- ~~**Whether `poweredBy` should stay in the manifest at all.**~~ **Answered the same week, and it
  does not**: charter **D45**, [spec 112](112-poweredby-removed.md). The condition this question set
  for itself came true — the first adoption is real and measured (spec 111) and its sign-off record
  is written — and at that moment the owner was asked to state the adoption a second time in a
  manifest and declined the premise: *"'poweredBy' is just an abstract no need to brand it"*. The key
  is gone from the schema and refused by name. **D44b is untouched**: the sign-off record below is
  now the whole mechanism rather than half of it.
- **The first adoption.** F61 — the renderer as a curated capability with one game adopting it — is
  still open, and it is the obvious first candidate. Nothing here starts it.
- **Anything about acquisition.** KI-008 stands: where a pack's bytes come from is still unresolved,
  and D38's no-hidden-downloads boundary constrains whatever answers it.
