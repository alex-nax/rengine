# Metal adapter on macOS behind the draw list (F58)

Date: 2026-09-06. Status: started after a `/grill-me` interview. Parent: [GPU rendering](066-gpu-rendering.md),
[draw-list contract](067-draw-list-contract.md), [OpenGL adapter](068-opengl-adapter.md), charter D29–D30.

## Decisions from the interview

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The adapter is one Objective-C file, `render/backend_metal.m`, compiled with ARC behind the same C ops table; Objective-C stays confined to that file and the C rule holds above the adapter boundary. | Recommended, owner confirmed |
| 2 | Once the adapter passes the same gates OpenGL did, Metal becomes the macOS default; OpenGL stays selectable and remains the Windows path. | Recommended, owner confirmed |
| 3 | OpenGL's Windows evidence moved to the new F62; F57's criteria and description narrowed to macOS with the rationale recorded in the charter revision record, so F57 and F58 can pass on macOS evidence. | Recommended, owner confirmed (accepted-criteria correction) |
| 4 | F56 has no inventory dependencies: its former dependencies on F34 and F42 were qualification gates, not code the contract needs, and no desktop feature passes yet. | Recommended, owner confirmed (accepted-dependency correction) |
| 5 | Shaders are Metal Shading Language compiled from an embedded source string at startup, mirroring the OpenGL adapter; no build-time Metal toolchain. | Recommended, owner confirmed |
| 6 | Comparisons gate against the SDL reference with the spec 068 tolerances and budgets; Metal-versus-OpenGL numbers are recorded as information only. | Recommended, owner confirmed |

Inherited from spec 068 without a new decision: a selected backend that cannot initialise exits
non-zero with the reason (decision 8 there); budgets are relative to the SDL baseline with the same
ceilings (decision 6); anti-aliased signed-distance shapes (decision 7).

Codebase-derived choices: the window carries `SDL_WINDOW_METAL` and the adapter takes its
`CAMetalLayer` from `SDL_Metal_CreateView`/`SDL_Metal_GetLayer`, with the drawable size from
`SDL_Metal_GetDrawableSize`; the layer is BGRA8 with `displaySyncEnabled`, matching the other
adapters' vsync, and `framebufferOnly` off so snapshots can read the drawable; one render pipeline
with the same six modes, vertex layout reordered so the two `float4` attributes sit on 16-byte
offsets; blending `srcAlpha/oneMinusSrcAlpha` with separate alpha `one/oneMinusSrcAlpha`; a 2048² R8
atlas and RGBA8 game textures with `replaceRegion`; scissor rectangles clamped to the drawable; the
vertex batch is uploaded per flush as a shared buffer the command buffer retains; snapshots commit,
wait for completion and read the drawable back before it is presented. No deployment target is
introduced; the verified configuration is recorded in the evidence.

## Verification

- `orchestrator/tests/native-render.spec.mjs` captures `sdl`, `opengl` and `metal` from separate
  server state, gates each GPU backend against the SDL reference under the spec 068 tolerances and
  budgets, and records Metal-versus-OpenGL numbers per scene.
- The committed native desktop suite passes on `RENGINE_RENDERER=metal`; CTest passes; the SDL
  reference stays byte-identical to its F56 baseline; the OpenGL comparisons keep passing.
- After the gates pass, the macOS default flips to Metal and the default smoke snapshot matches the
  explicit `--renderer metal` snapshot.
- Evidence: `docs/evidence/metal-adapter-macos-2026-09-06.md`.

## Deferred

Vulkan (F59) reuses the same batching and atlas design. Windows OpenGL evidence is F62. Precompiled
Metal libraries and a deployment-target policy are not part of this feature.
