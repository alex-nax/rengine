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

## The first slice, as it should be done in the host's own repo

`~/nolf-improved` has its own workflow (`AGENTS.md`, `CLAUDE.md`, `docs/harness-workflow.md`) and its
own inventory, and rEngine's own rule is that **a local task cannot mark another project's feature
done**. So this spec stops at the seam and the work happens there, under those rules:

1. Vendor `ik_lithtech.{h,cpp}` and add iklib at the pin above, consumed by `add_subdirectory` —
   the path its own CMakeLists is written for (it builds the library only when it is not the top
   project, and exposes `include/` publicly while keeping `src/` private).
2. Replace the block at `vr_body_solve.h:236` with `ikRetargetArmLithTech(...)`, mapping NOLF's
   `arm` to the preset's `shoulder/upper/lower/hand`.
3. Prove it **behaviour-preserving** against the tests that already exist — `test_vr_body.cpp` and
   `test_vr_arm_latch.cpp` — with old/new pose comparison, which is what spec 001 asks for and what
   iklib's own F130 says it verifies ("whether NOLF's arm constants match").
4. Record the result in NOLF's own evidence, and only then the owner's sign-off here (D44).

## What is not established

- **Whether the numbers agree.** iklib F130 is open and its own verification note asks whether NOLF's
  arm constants match. Nothing here has run a solve, and the two implementations having the same
  *shape* says nothing about them producing the same *pose*. That is what step 3 is for, and it is
  the step that can still say no.
- **`playerReach`, `rollGain`, `twistFollow`, damping and the abort thresholds.** NOLF's call passes
  none of them; the preset takes them. Which NOLF values map, and which are new behaviour that must
  be defaulted to preserve today's, is unread.
- **VtMB.** iklib F131 is the other half of D09's two-game proof and is untouched here.
