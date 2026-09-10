# The rendering library: one seam, two backends, two games (D51–D52)

Date: 2026-09-10. Status: **designed; nothing implemented.** Asked for by the owner:

> we want to plan the rendering library - we need to create an abstraction in which we can switch
> between opengl/vulkan. This solution should be later integrated into vtmb-vr and nolf-improved (we
> will keep switch to opengl to catch regression and performance issues)

## What is already there, measured before designing

| | GL symbols | Files touching GL | Behind a seam |
| --- | --- | --- | --- |
| `~/vtmb-vr` | 125 | 62 | **13** (`src/renderer/gpu/device.h`, F801/D14) |
| `~/nolf-improved` | 102 | 39 | 0 |
| `~/rengine` | — | — | 2D UI draw list with SDL, GL, Metal and Vulkan backends (R0/R1, all passing) |

**VtMB has already written most of the thing this was going to design.** `src/renderer/gpu/device.h`
carries F801's decisions with their reasoning:

- **D14** — *"renderer code talks to this, never to GL directly."*
- **D14b** — selection is **compile-time**: *"Quest is the constrained target, several of these calls
  are per-draw, and we never ship two backends in one binary."*
- **D14c** — granularity is **resource + draw**: buffers, textures, programs, vertex layouts, a small
  pipeline state, a draw. Explicitly **not** command buffers, render passes or barriers, because *"a
  Vulkan backend can build those internally; forcing GL 4.1 to emulate them would be a rewrite of all
  19 files for no present gain."*

F801 is open and migrating file by file. That measurement changes what this plan is: the expensive
part is not writing a Vulkan backend, it is that **a backend only serves files that go through the
seam** — 13 of 62 in VtMB, none in NOLF.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| D51 | **The switch stays compile-time; two binaries, not two paths in one.** VtMB's D14b is upheld rather than revised: Quest is the constrained target and several of these calls are per-draw, so the frame path keeps zero indirection. "Switch to OpenGL to catch regressions and performance issues" therefore means *build both and compare*, which is the discipline rEngine already runs on its own backends (`native-render.spec.mjs` and `tools/render_compare.py` compare adapters under a recorded tolerance and measured budgets). The cost is real and named: catching a regression on a headset means a rebuild and a redeploy, and no in-session A/B. | Owner, 2026-09-10, choosing compile-time over a runtime table |
| D52 | **The pack's design starts from VtMB's `device.h`, and its first proof is a Vulkan backend behind the surface already migrated.** rEngine generalises the shape VtMB earned in a real renderer rather than inventing one in the suite — curation as D01 and D08 describe it — and VtMB adopts the pack by deleting its own copy. The first Vulkan backend is written against VtMB's **13** already-migrated files, because that is the cheap test of D14c's central and still-untested bet: that resource+draw granularity can carry Vulkan with command buffers, render passes and barriers built inside the backend. If it cannot, we learn it at 13 files rather than after migrating 49 more onto a seam that cannot hold it. | Owner, 2026-09-10 |

## The library is two layers, and a game needs both

Spec 115 already recorded that our reusable part was never the draw list. The rendering pack has two
distinct layers, and conflating them is what made the earlier plan wrong:

**1. The device and context layer (F120).** Instance, physical-device selection, device and queues,
memory, command submission — with **render targets supplied from outside**. The desktop hands it
images made from an SDL surface; an OpenXR host hands it images from `xrCreateSwapchain` and there is
no `VkSurfaceKHR` at all. This is what makes VR possible and is why KI-072 closes.

**2. The resource-and-draw seam (from VtMB's `device.h`).** Buffers, textures, programs, vertex
layouts, pipeline state, draw. This is what renderer call sites talk to. VtMB's version is the
starting design; generalising it means little more than removing `vtmb::` and deciding which of its
handle types the other engine needs.

The seam sits **on** a device. VtMB's `device.h` has no layer 1 — it never needed one, because SDL
made its context. A game that wants VR needs both, which is precisely why F120 comes first.

## The order, with the gate D50 already set

```
F120  extract the SDL-free device layer from rEngine's Vulkan backend      (rEngine)
F123  package it — plus the seam generalised from VtMB's device.h, with
      GL and Vulkan backends, compile-time selected                        (rEngine; the D50 gate)
F126  VtMB adopts the pack for its 13 already-migrated files and deletes
      src/renderer/gpu/ — this is the D14c verdict                         (vtmb-vr)
F127  migrate VtMB's remaining 49 GL files behind the pack                 (vtmb-vr)
F128  retrofit the seam into NOLF's 39 GL files                            (nolf-improved)
F61   the adoption recorded with the owner's sign-off                      (rEngine)
```

D50 is unchanged and needs no revision: the Vulkan backend lives **in the pack**, not in a game, so
"a game's Vulkan work starts once rEngine ships a pack" still holds. What a game does at F126 is
adopt, not author.

## What the comparison harness has to be

D51 makes the switch a build flag, so the regression and performance story is two artefacts and a
comparison — not a runtime toggle. Three things it needs, and rEngine has all three already for its
own backends:

- **A reference to compare against.** GL is that reference, exactly as `SDL_Renderer` is for the
  desktop (D29). It stays shipped and stays correct; it is not a legacy path.
- **A recorded tolerance.** Pixels will not be bit-identical across APIs. `tools/render_compare.py`
  already compares under `--max-fraction`/`--max-delta` with an edge band, and that tolerance is
  written down rather than argued each time.
- **A measured budget, per backend, on the target.** This is the half the first library adoption
  missed — see spec 110's cost field and NOLF's KI-526. Frame time and allocations per frame, on
  Quest, for both backends, recorded before either is called done.

## What this does not decide

- **Metal.** D29 orders OpenGL, then Metal, then Vulkan for rEngine's own desktop; the games target
  Quest (GLES) and Windows (GL), so Metal is not on either game's path and nothing here adds it.
- **Which of VtMB's handle types generalise.** `device.h`'s handles are `std::uint32_t` GL names
  today, described as opaque. Whether a Vulkan backend can keep that shape, or needs a wider handle,
  is the first real question F123 has to answer — and it may be the first place D14c strains.
- **Shader dialects.** VtMB generates dialect strings (F800) and NOLF does not. A pack that takes
  `ShaderProgram` has to say what it takes, and nothing here says it.
- **Whether NOLF wants this at all.** D50 gives the abstraction a shippable form and F128 is written
  as a plan, not a commitment; `AGENTS.md` is explicit that a local task cannot decide another
  project's adoption.
