# The first library adoption: iklib in NOLF (F19 / iklib F130)

Date: 2026-09-08. Status: **seam established by reading both sides; nothing changed in either repo.**
The owner: *"let's go on ~/iklib adoption and integration in into ~/nolf-improved"*.

This is the first exercise of [spec 110](110-library-adoption.md) / charter D44, and the first
adoption D24's "Powered by rEngine" was ever defined against. Spec 001's delivery sequence puts a
contract recheck before any migration; this is that recheck, done by reading rather than assuming.

## The pin

```
iklib  HEAD 620bff1a44904e441c44b588c3339c57d73bb9bc  (no tags; version is the revision today)
```

A pack entry for it, in the shape F109 shipped this morning — written here as the worked example and
**not yet placed in NOLF's declaration**, because the adoption is not done:

```json
{ "name": "iklib",
  "pin": { "version": "0.0.0-620bff1", "revision": "620bff1a44904e441c44b588c3339c57d73bb9bc" },
  "library": { "path": "third_party/iklib", "target": "iklib" } }
```

Two corrections to earlier guesses fall out of reading the real thing:

- The CMake target is **`iklib`**, not the `iklib::ik` that spec 107's illustration invented. There
  is no namespaced alias in `~/iklib/CMakeLists.txt`.
- iklib carries **no version and no tags**. F109's pin has a spoken half and a checked half, and the
  spoken half has nothing to say yet. Recorded rather than invented: a placeholder derived from the
  revision is honest; a `0.4.0` would not be.

No `poweredBy` in that entry. Under D44 the flag is a claim and the badge is an owner's sign-off; the
claim should be written when the adoption is real, not when the pack is first named.

## The two sides of the seam, read

**NOLF today** — `~/nolf-improved/src/engine/vr_body_solve.h:236`, the one production call:

```cpp
const vr::TwoBoneIkResult ik = vr::SolveTwoBoneIk(S, target, l1, l2, pole);
// then: RotationBetweenVectors(animU, ikU, dU) / (animL, ikL, dL)
// then: three absolute overrides written into out.entries[] — upper, lower, hand
```

`vr/vr_ik.h` is a header-only geometric solve with a stated invariant, reached from
`src/engine/app_vr_body.cpp` and `src/engine/vr_body_solve.h` and covered by `tests/test_vr_body.cpp`
and `tests/test_vr_arm_latch.cpp`.

**iklib today** — `ikSolveArm(pose, poseCount, chain, targetModel, handQuatModel, sideSign, params,
frame, state, out, maxOut)`, which writes up to four **absolute** overrides and returns the count.

At the abstraction level these look mismatched — a bare two-bone solve against a full arm retarget.
At the *seam* they are the same shape, which is the finding that matters: NOLF already holds a node
transform array, an arm chain of node indices, and an absolute-override output with a count. It is
doing by hand what `ikSolveArm` does.

## iklib already ships the LithTech preset, and it cites NOLF

`~/iklib/integrations/lithtech/ik_lithtech.h` is not a generic example. It declares:

- `ikFrameLithTech()` — X=right, Y=up, Z=forward;
- `ikConfigLithTech()` — that frame, 64 units/m, no optional subsystems, "NOLF today";
- `ikRetargetArmLithTech(pose, arm, targetModel, playerReach, handQuatModel, sideSign, rollGain,
  twistFollow, out)` — a **template over the host's own types**: the host's `NodeTransform`, its
  `ArmNodes` with `shoulder/upper/lower/hand`, its `BodyOverrides`.

Its header comment cites `~/nolf-improved/CLAUDE.md:87` for the unit scale, and that line says
exactly what the preset claims: *"LithTech: X=Right, Y=Up, Z=Forward (right-handed) … Unit scale:
~1 LT unit ≈ 1.5625 cm."* Verified on 2026-09-08 — the citation is real and current.

So the frame and unit questions spec 001 demanded be declared before migration are **already
declared, by the library, against this host**. The adoption is not a port; it is replacing a
hand-rolled block with a call the library already shaped for it.

## Where iklib's bytes come from, decided 2026-09-08

The owner: *"iklib should be referenced in rengine repo, so when we connect our ~/nolf-improved repo
to rengine - we have code checked out"*. Two decisions, both taken against shapes this repository
already uses rather than invented:

**rEngine carries iklib as a git submodule at `third_party/iklib`, pinned.** That is the shape
`integrate-project.sh` already uses to put rEngine into a host project, and it is right for a
repository the owner develops: bumping the pin is a commit, and the history stays in iklib rather
than being copied. The alternative considered and rejected was vendoring with per-file sha256 into
`third_party/sources.json`, the way microui, stb and libvterm are carried — that convention is built
for upstream code we do not own, and iklib is ours and moving, so every change would become a
re-vendor. A fetch-on-demand reference was rejected outright: it is the one shape the boundaries
forbid, because it is a hidden download.

**rEngine's pin is the truth; a project's declared pack pin must match it.** The bytes that build are
the submodule's, so that is what actually built. A project still declares the pack — that is how the
powered-by claim of D24 and D44 is made — but a declared revision disagreeing with what is checked
out is a refusal rather than a preference. One artifact, one truth, and a disagreement is caught
instead of averaged.

**The consequence that had to be chased into two more files.** A submodule of a submodule does not
arrive with a plain `submodule update --init`. `integrate-project.sh` now recurses when it pins
rEngine into a project, and so does the `editor.sh` the project is scaffolded with — the second one
was found by its own test asserting the exact non-recursive command, which is what a test naming a
command string is for. Without both, a connected project gets an empty `third_party/iklib` and a
build that fails on a missing header rather than on a missing dependency.

**Enforced on the consumer side, 2026-09-08.** The outstanding check was written where it bites:
NOLF's `cmake/iklib.cmake` holds the pin as a literal, and when the tree it is pointed at is a git
checkout whose `HEAD` is not that revision, the configure **fails** and names both revisions. The
build refuses rather than prefers, which is what "one artifact, one truth" was asking for.

Both refusals were **run, not read**, on 2026-09-08 from a scratch build directory, because a check
nobody has seen fire is an assertion: pointed at a clone of iklib one commit off the pin, `cmake -S .
-B <scratch>` exits **1** with *"is 2140f244…, not the pinned 620bff1a…"*; pointed at a path that
does not exist, it exits **1** naming the recursive command an existing checkout needs. Neither the
NOLF tree nor `~/iklib` was modified to produce them. rEngine
still has no check of its own — a project could declare a pack revision in `.rengine/project.json`
that disagrees with both — so the gap is narrower than it was, not closed.

**And the recursive fix was wrong about existing checkouts.** The paragraph above assumed a
connected project only needed `submodule update --init --recursive` to pick iklib up. Measured in
NOLF: its rEngine pin was `562b195`, which **predates `6e88a5c` and therefore has no `.gitmodules`
at all**. At that pin iklib does not exist in rEngine and no `--recursive` can fetch it. An existing
checkout needs the rEngine pin *bumped* first; the recursion is the second step, not the fix. The
scaffold change stands for projects connected from now on.

## The first slice, as it should be done in the host's own repo

`~/nolf-improved` has its own workflow (`AGENTS.md`, `CLAUDE.md`, `docs/harness-workflow.md`) and its
own inventory, and rEngine's own rule is that **a local task cannot mark another project's feature
done**. So this spec stops at the seam and the work happens there, under those rules:

1. ~~Vendor~~ **compile** `ik_lithtech.{h,cpp}` **from the pinned tree** (nothing is copied; the
   preset is host-side by design but has exactly one source) and add iklib at the pin above,
   consumed by `add_subdirectory` —
   the path its own CMakeLists is written for (it builds the library only when it is not the top
   project, and exposes `include/` publicly while keeping `src/` private).
2. Replace the block at `vr_body_solve.h:236` with `ikRetargetArmLithTech(...)`, mapping NOLF's
   `arm` to the preset's `shoulder/upper/lower/hand`.
3. Prove it **behaviour-preserving** against the tests that already exist — `test_vr_body.cpp` and
   `test_vr_arm_latch.cpp` — with old/new pose comparison, which is what spec 001 asks for and what
   iklib's own F130 says it verifies ("whether NOLF's arm constants match").
4. Record the result in NOLF's own evidence, and only then the owner's sign-off here (D44).

## The sign-off this adoption is ready for (D44b)

Spec 110 says an adoption becomes real when the **owner** records it. Every slot that record needs
is now filled except the owner's own words, so it is set out here rather than asserted:

- **pack**: `iklib`, both halves of the pin — version `0.0.0-620bff1` (spoken; iklib still carries no
  tag), revision `620bff1a44904e441c44b588c3339c57d73bb9bc` (checked, and now checked by the build).
- **project and checkout**: `~/nolf-improved`, branch `f1706-iklib-arm-retarget`, reaching iklib
  through rEngine `6e88a5c` at `third_party/rengine/third_party/iklib`.
- **what was run and seen**, in NOLF's own terms: `RetargetArm` delegates to
  `ikRetargetArmLithTech` and `vr_body_solve.h` drops from 456 to 204 lines; the deleted solve is
  kept verbatim as the test's oracle; equivalence over 20 240 scenes at 2.7e-5 worst deviation; the
  inherited `test_vr_body` (17/17) and `test_vr_arm_latch` (8/8) unchanged; four sabotages applied,
  observed failing for their own reasons, and restored — one of which first reproduced the previous
  sabotage's output byte for byte because `make` had not rebuilt, and was rerun with the binary's
  mtime checked. Evidence lives in NOLF's `docs/specs/feature-1706-iklib-arm-retarget.md`, which is
  where D44 says it belongs.
- **date and the owner's words**: *awaiting the owner.* This is the one thing no agent can supply,
  and D44b exists precisely so that it is not supplied by one.

Under D24 the powered-by minimum — one curated capability at a pinned version with passing game
integration checks — is met on the evidence side. `poweredBy` is not yet written into NOLF's
declaration, and should be written by the same hand that signs.

## What is not established

- ~~**Whether the numbers agree.**~~ **Answered 2026-09-08 by the adoption itself**, in
  `~/nolf-improved/docs/specs/feature-1706-iklib-arm-retarget.md`. Over 20 240 scenes — iklib's own
  240-record generator plus a 20 000-scene sweep across reach, side, roll gain, twist and clavicle
  presence — the worst position deviation is **2.7e-5 LT (0.42 µm)** and the worst quaternion
  component deviation **2.7e-5 (0.003°)**, with **zero** disagreements in entry count or node index.
  One *functional* disagreement exists and is measure-zero: on an exactly antiparallel shortest-arc
  input (within ~0.08°) the two libraries pick different 180° axes, so the bone points the same way
  but its roll can differ; no random scene reached it, and a constructed one pins it. The finding is
  recorded as a delta rather than tuned away.
- ~~**`playerReach`, `rollGain`, `twistFollow`, damping and the abort thresholds.**~~ **Read, and
  the premise was wrong**: NOLF's `RetargetArm` already takes `playerReachLT`, `rollGain` and
  `twistFollow`, and both production call sites already pass them — the seam matched the preset
  parameter for parameter. Every `IkArmParams` field is classified mapped / defaulted / matching in
  F1706's spec, and the only numeric difference in the whole set is a 1e-6 rad flare constant.
- **VtMB.** iklib F131 is the other half of D09's two-game proof and is untouched here.
