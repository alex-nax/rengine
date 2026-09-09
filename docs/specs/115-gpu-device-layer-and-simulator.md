# SDL, a GPU device layer, and the road to the Simulator (D49)

Date: 2026-09-09. Status: **decided; the Simulator plan is staged and gated on work we do not own.**
The owner asked two things: *"What are your takes of ditching SDL at all?"* and *"plan integration
with simulator once proper rendering abstraction and vulkan renderer are implemented"*.

They turn out to be one question. The only part of SDL worth removing is the part standing between us
and OpenXR, and removing it is what makes the Simulator reachable.

## Ditching SDL: measured, then answered

`orchestrator/native/` uses **172 distinct SDL symbols**:

| Area | Symbols | Would we have to write it ourselves? |
| --- | --- | --- |
| window and graphics-API binding | 37 | Yes, per platform |
| events and input | 32 | Yes, per platform |
| `SDL_Renderer` (the 2D reference backend) | 26 | No — already slated to stop being the shipping path (D29) |
| threads, mutexes, condition variables, atomics | 20 | Yes, per platform |
| cursors, timers, `SDL_OpenURL`, video-driver query, file load | ~49 | Yes, per platform |
| clipboard | 2 | Yes, per platform |

**The answer is no, with one sharp exception.** Three reasons the wholesale version is a bad trade:

1. **It is the work SDL exists to do, on the platform we are weakest.** Windows support is already
   unfinished (KI-014, KI-038). Hand-writing window creation, input, threads, cursors and clipboard
   for macOS *and* Windows would enlarge exactly the gap we have not closed.
2. **The games are SDL games, and the embedded pane works by interposing SDL inside the game's
   process.** `adapters/sdl2/surface.cpp` turns our input packets back into `SDL_Event`s in the
   game's own queue, and the wire protocol in `surface-protocol.mjs` is SDL-shaped — kinds and
   scancodes. Dropping SDL from the desktop would not remove SDL from the integration; it would
   leave us speaking two input vocabularies across one seam.
3. **It buys nothing the adapter boundary has not already bought.** D29 put rendering behind an
   adapter; GL, Metal and Vulkan backends exist and pass. Window and input were never the constraint.

**The exception, and it is the whole point: SDL has to leave the device-creation path.** In
`render/backend_vk.c` — 750 lines — SDL appears **23 times**, and they are concentrated in
`SDL_Vulkan_GetDrawableSize` (three sites), surface creation, `SDL_SetError`, and a BMP screenshot
helper. Everything else — instance, physical-device selection, device and queues, memory allocation,
command buffers, `vkQueueSubmit2` — is already SDL-free.

That matters because **OpenXR takes over exactly the part SDL owns there**: the runtime dictates
instance and device creation (`xrGetVulkanGraphicsRequirements`, `xrCreateVulkanInstance`,
`xrCreateVulkanDevice`) and hands the application swapchain images from `xrCreateSwapchain`. There is
no `VkSurfaceKHR` and no window in the HMD path at all. So the 23 references are not incidental —
they are precisely the coupling that makes our Vulkan backend unusable for VR, and they are thin.

## Decision

| # | Decision | Attribution |
| --- | --- | --- |
| D49 | **SDL stays as the platform layer and leaves the device layer.** rEngine keeps SDL for windowing, input, threads, clipboard, cursors and timers, on both desktop platforms — replacing it is the work SDL exists to do and would widen the Windows gap. What is extracted is an **SDL-free GPU device layer**: instance, physical-device selection, device and queues, memory, command submission, with no windowing symbol in it. The desktop backend drives it with an SDL-created surface; an OpenXR host drives the same layer with runtime-supplied swapchain images and no surface at all. `SDL_Renderer` remains the reference oracle that other backends are compared against (D29) and stops being a shipping path. This is the concrete form of the pack candidate D48 named, and the correction spec 114 recorded — the reusable part was never the draw list. | Owner asked whether to ditch SDL, 2026-09-09; measured at 172 symbols overall against 23 in the Vulkan backend |

## The device layer, concretely

One owned interface — call it `ReGpuDevice` — carrying what both hosts need and nothing either
host's windowing system supplies:

- instance creation that accepts **required extensions from its caller** (the desktop passes what
  SDL asks for; an OpenXR host passes what the runtime demands);
- physical-device selection that accepts a **caller-supplied constraint** (OpenXR names the adapter
  the headset is on, and it is not always the one a desktop heuristic would pick);
- device, queues, memory allocation, command pools, submission — the parts already SDL-free;
- **render targets supplied from outside**, so the desktop hands it swapchain images it made from an
  SDL surface and an OpenXR host hands it images from `xrCreateSwapchain`.

What stays out: window creation, surface creation, present, drawable size. Those are the host's.

This is a refactor with an existing consumer and an existing oracle: the desktop must keep rendering
identically, and `SDL_Renderer` plus the reference comparisons of R0/R1 already say what identical
means. It is not a rewrite, and its first slice does not need a game.

## The Simulator, once the device layer and a game's Vulkan binding exist

Meta XR Simulator is an OpenXR **runtime on the development machine**. It is the only route to VR
testing without a headset, and it is closed today for one reason recorded as KI-072: it requires
Vulkan, D3D11/12 or Metal, and both games bind OpenGL or OpenGL ES. Everything below is gated on a
game gaining a Vulkan OpenXR binding — **work each game owns, not us**.

### Why it is worth the gate

The Simulator brings something no other route offers: **Session Capture**, a VRS recording of head
and input motion that *"reproduces the same head and input motion every run"*. That is deterministic
VR repro — the thing the flat harness cannot give and a headset cannot give either.

### The stages

**S1 — the game runs under the Simulator at all.** Set the Simulator as the active OpenXR runtime,
launch, and confirm the session reaches focus with a Vulkan binding. Windows first: it is the games'
PCVR platform, and NOLF's `vr_session.cpp` states plainly that macOS has no VR runtime and will fail
at `xrCreateInstance`, so a macOS route needs a macOS OpenXR path as well as Vulkan. Evidence: an
OpenXR session reaching `XR_SESSION_STATE_FOCUSED`, not a screenshot.

**S2 — record a session by hand.** The Simulator's own **Record session** control writes a `.vrs`.
This proves capture works for our app before anything is automated.

**S3 — automated replay, driven by the harness.** Replay is automated by writing a `session_capture`
block to the Simulator's `persistent_data.json` — on macOS
`~/Library/Application Support/MetaXR/MetaXrSimulator/persistent_data.json`, on Windows
`%APPDATA%\MetaXR\MetaXrSimulator\persistent_data.json` — naming `exec_state: "replay"`, the
`record_path` to replay, an optional `replay_path` for the output, and the timing keys
(`delay_start_ms`, `quit_buffer_ms`, `quit_when_complete`).

Two hazards, both from Meta's own page, and both must be designed for rather than discovered:

- **The block persists.** *"A `session_capture` block left from an earlier run triggers another
  replay on the next launch. Remove the block when you finish."* This is global mutable
  configuration owned by someone else, and our own boundaries forbid our components relying on such
  a thing. The harness must therefore treat that file as an **acquired resource**: read it, merge the
  block, run, and restore the original on every exit path including a crash — the discipline
  `/tmp/relith-gate.lock` already uses for the ctest gate. A harness that leaves the block behind
  turns the developer's next manual launch into a surprise replay.
- **Completion only *asks* the app to quit.** *"the runtime asks your application to exit its OpenXR
  session. It does not close the simulator window and does not terminate your application: your
  application has to act on the request."* So each game must honour the session-exit request and
  actually leave. Whether either game does today is **unverified**; if it does not, an automated run
  hangs rather than fails, which is the worse outcome. Verify before building CI on it, and give the
  harness its own frame or wall budget regardless.

**S4 — a `.vrs` becomes a versioned test fixture.** A recorded capture is a deterministic VR input
fixture and belongs beside each game's other reference data, the way NOLF's 134 archived saves
already work. F119's scenario gains a VR variant: the script is a `.vrs`, the expected facts are log
lines, and the checklist is the human verdict — the replay output being reproducible is what makes
the human's answer meaningful across runs.

**S5 — Operator on top of the Simulator.** With Vulkan in place, Meta's own recommended desktop loop
opens: the Operator OpenXR API layer over the Simulator, giving pose and controller injection and
image capture through its MCP endpoint, on the development machine with no headset. This is F46/F47
delivered without hardware, and it is the reason spec 114 said O4 should depend on the harness rather
than the other way round.

### What each stage needs from whom

| Stage | rEngine owns | The game owns | Needs hardware |
| --- | --- | --- | --- |
| S1 | nothing | Vulkan OpenXR binding; Windows or a macOS XR path | no |
| S2 | nothing | — | no |
| S3 | the replay harness and the `persistent_data.json` acquire/restore | honouring the session-exit request | no |
| S4 | the scenario variant and the evidence shape | storing and versioning its own `.vrs` fixtures | no |
| S5 | the Operator client and its session binding | bundling the API layer | no |

Nothing above needs a Quest. The hardware path (Operator on device) stays as F46/F47 describe it and
is not replaced by this — a headset still tests things a simulated runtime cannot.

## What this does not decide

- **Whether either game will do the Vulkan work.** Games own their runtimes and their roadmaps;
  `AGENTS.md` is explicit that a local task cannot decide another project's adoption. D48 gives the
  abstraction a consumer need; it does not give it a consumer.
- **Whether the device layer ships as a pack.** KI-008 still holds: where a pack's bytes come from is
  unresolved, and F61's library-quality record is unwritten.
- **macOS VR at all.** NOLF says outright it has no macOS runtime. The Simulator does run on macOS
  ARM with Vulkan or Metal, so a macOS route exists on paper and would need a game to want it.
- **Whether `SDL_Renderer` is eventually removed as the oracle too.** D29 keeps it as the reference;
  nothing here changes that, and a reference backend that never ships is still doing a job.
