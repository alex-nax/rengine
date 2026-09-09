# Steering the dev suite: agents, tests, and a game-driven harness (D46–D48)

Date: 2026-09-09. Status: **research complete, decisions taken, feature rows proposed.** Asked for by
the owner: *"we want to steer development of dev suite"* — an agent lane, a testing lane, and a
game-driven testing harness — with a comprehensive research pass behind it.

Three research lanes ran in parallel on Fable. Every load-bearing claim below was re-verified
directly before it was written down; where a lane's claim did not survive that check, the correction
is here rather than the claim.

## What the research actually found

Three findings changed the plan. Each is measured, not inferred.

**1. The task↔test link already exists in our data, and we throw it away.** Every `features.json`
row carries an `evidence` array — `"<path>: <claim>"`, naming the test and what it proves. But
`localRows` (`orchestrator/server/tracker.mjs:104-116`) maps `acceptance_criteria → criteria` and
**never maps `evidence`**. No surface in the workspace shows it. The Tasks tab cannot answer "what
test backs this" because the field is dropped one function before the UI.

Also found, and shipped drift: the schema says `local` reads features.json *"through
tools/features.py"* (`contracts/project-v1.schema.json`, `tracker.provider`). It does not —
`tracker.mjs:94` reads the file directly and re-implements the readiness rule. Spec 083's own prose
is correct; the schema description is wrong.

**2. An agent could drive a game today; only the tool is missing.** `surfaces.mjs:63-82` accepts
input from *any* authenticated `/surface` viewer as `{kind, values}` — key, motion, button, wheel,
focus, release — and the interposer turns them back into SDL events inside the game's own queue
(`adapters/sdl2/surface.cpp:215-257`). The native pane is merely one such viewer. **No MCP tool,
HTTP route or CLI sends game input.** The transport is shipped and proven; the gesture is absent.
One real constraint in that code: taking focus **evicts the previous owner** (`surfaces.mjs:72-76`),
so an agent would yank the pane from a person mid-session unless refused first.

**3. Headset-free VR automation is closed to both games, by graphics API.** Meta XR Simulator's
own requirements page (fetched 2026-09-09, page updated 2026-09-04) states verbatim: *"Vulkan works
on Windows and macOS. Direct3D 11 and Direct3D 12 work on Windows. Metal works on macOS. **OpenGL
and OpenGL ES are not supported.**"* Both games request `XR_KHR_OPENGL_ES_ENABLE` on Quest and
`XR_KHR_OPENGL_ENABLE` on Windows (`nolf-improved/src/vr/vr_session.cpp:363-366`,
`vtmb-vr/src/vr/vr_session.cpp:228-234`). So the Simulator is unavailable, and with it its **Session
Capture** — the VRS record/replay that would have given deterministic VR repro. Operator-on-Simulator,
Meta's own recommended desktop loop, is closed for the same reason. AutoDriver does not support
OpenXR at all. VR automation needs real hardware, or a Vulkan binding in the games.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| D46 | **The suite invests in agent *protocol* first; embedding an agent is a later, separate step.** Our agent layer is already protocol-shaped rather than agent-shaped — PTY sessions, a per-launch private MCP config, an `/ide` server, hooks — and that is the right shape while every vendor ships a better harness than we would write. Two slices: one declared **agent recipe registry** (today the registry F39 asks for exists only implicitly, spread across `config.mjs:12,16-18`, `ide-connect.mjs:41`, `tasks.mjs:34-43` and `agent.sh:41-57`), then an **ACP session kind** for the agents that speak it natively. Embedding is revisited when a business customer needs an agent in the box; it is not abandoned, and ACP is the transport it would use anyway. | Owner, 2026-09-09: "Both, protocol first" |
| D47 | **rEngine reads a project's test evidence, never asserts it — but it may *file* a judgement as a task.** The Tasks tab shows what the project recorded. On top of that, a person or an agent can **flag a test as bad** or **propose a new one**, and that verdict is written back through the project's own `tracker.write` command as a task in the project's own inventory. This keeps D44 exactly as written — rEngine still asserts nothing about another project's tests — while making the judgement actionable where it belongs. Running a project's tests from the Tasks tab remains out of scope. | Owner, 2026-09-09: "first it will be read only, but we need to be able to flag bad tests and propose new (maybe through agent) also be able to better judge test runs and results" |
| D48 | **The flat game-driven harness comes first; the Vulkan path that reopens VR is a later pack candidate.** Ship agent-driven input, frame capture and recording over the surface transport that already works, closing KI-024. The graphics-API abstraction that would give the games a Vulkan OpenXR binding — and with it the Simulator, and headset-free VR testing — is a genuine candidate for a bundled rEngine library pack, and this is the **consumer need** that D30 and the roadmap's "expansion requires a consumer need" rule have been waiting for. It is sequenced after the flat harness, not instead of it. | Owner, 2026-09-09: "1 -> 3 (rendering api abstraction is a good candidate for including in rengine bundled library pack)" |

## A correction D48 needs, before anyone plans on it

The instinct is right that our rendering work is a pack candidate — D30 and F61 already say so. But
**it is not a drop-in for a game's OpenXR Vulkan binding**, and the roadmap should not pretend
otherwise:

- `render/draw_list.h` is a **2D UI** contract — `RECT`, `RRECT`, `FRAME`, `SHADOW`, `RING`, `TEXT`,
  `ICON`, `TEXTURE`, `GRADIENT`, in logical pixels. Nothing in it touches 3D.
- `render/backend_vk.c` (750 lines) *does* carry real instance/physical-device/device/queue/
  swapchain/submit plumbing with a dynamic loader — but it is **SDL-window-bound**
  (`SDL_Vulkan_LoadLibrary:553`, `SDL_Vulkan_GetDrawableSize:179`, a `VkSurfaceKHR` from an SDL
  window), and OpenXR replaces precisely that half: images come from `xrCreateSwapchain`, and the
  HMD path has no `VkSurfaceKHR` at all.

So what is reusable is the **device/dispatch/allocation layer**, not the swapchain half and not the
draw list. Making it adoptable means *extracting* a device-and-context layer that does not exist as a
separate thing today. That is real work, worth doing under F61, and it should be scoped honestly
rather than described as "the games adopt our renderer".

## The three lanes

### Lane O2 — agent protocol (extends the existing milestone, does not replace it)

F39–F41 are already the right rows and are `blocked` on F36. This adds the two slices D46 names.

| Row | What |
| --- | --- |
| **F113** | One declared **agent recipe registry**: package, install, model flag, conversation flags, MCP overlay, hooks overlay, ACP command — consumed by `config.mjs`, `tasks.mjs`, `ide-connect.mjs` and `agent.sh` instead of four private tables. Carries two measured repairs found in the research: `ideDirectory()` (`runtime/ide.mjs:27`) ignores `CLAUDE_CONFIG_DIR`, which Anthropic documents as moving the lock directory; and Codex now ships `SessionStart` hooks carrying `session_id`, so `handoff.mjs`'s rollout-directory scan can become "ask the CLI" like the Claude path already is. |
| **F114** | An **ACP session kind** for agents that speak it natively (`gemini`, `opencode`, `kimi acp`; Codex via `codex-acp`). `session/new` takes exactly the stdio MCP shape our per-launch `mcp.json` already writes (`config.mjs:140-141`). **Claude deliberately stays PTY + `/ide` + hooks**: its Agent SDK forbids third-party products offering subscription login, so an ACP adapter routed through it would force API-key auth on the owner's own workspace. |

Deliberately not done: forking a harness (contradicts D33's "never a fork" and D40), and embedding
one now. If embedding becomes the goal, `@cline/sdk` is the single npm-pinnable candidate on our
runtime — Codex's core is not published as a library and needs a Rust toolchain we do not have,
OpenHands is Python — and it forces the model-provider decision the charter defers at P05.

### Lane T0 — tests attached to tasks (new branch)

| Row | What |
| --- | --- |
| **F115** | Carry **`evidence`** through to the neutral task row and draw it, plus a detail block on `task_row` showing each criterion with the evidence that backs it. No contract change; the field already exists in the data. Also corrects the `tracker.provider` schema description that claims a `tools/features.py` path the code does not take. |
| **F116** | Contract 10 **`tests`**: the project produces a manifest keyed by task key (`F123` / `BAS-1020` / `#42`); rEngine reads it and runs nothing. Each entry carries identity (path + selector), the claim in prose, which criteria it backs, tier and preconditions, **the sabotage rows that prove it bites**, and the last result with its commit and age. The sabotage field is the one that answers "is this test correct" — `AGENTS.md` defines correctness as *observed failing for its own reason*, and a format that cannot carry that cannot answer the question. |
| **F117** | **Flag a bad test, propose a new one.** A verdict on a test — from a person or an agent — becomes a task written through the project's own `tracker.write` (contract 6, already shipped: `server/tasks.mjs:53-90`). rEngine files; the project owns. This is what D47 buys over read-only, and it reuses the write path rather than inventing one. |

The model to steal is **hirebase-v2's `e2e/t2/registry.ts`**, which describes itself as *"the contract
between the runbook (the human procedure), the spec that automates it, and the Linear issue it
guards"* — three pointers, one status (`active`/`gated`/`manual-only`/`pending`), one preconditions
list. That is the shape, already proven in one of the owner's own projects. Keep its vocabulary
collision out of our specs: hirebase's capital-T **Tier** is the *autonomy class* of a change
(Green/Yellow/Red by paths touched); its *test* tiers are T1/T2a/T2b.

### Lane H0 — the game-driven harness (new branch)

| Row | What |
| --- | --- |
| **F118** | **`game_input`** (a bounded script of kind-1..6 packets with `atMs`, delivered as a second `/surface` viewer, **refused while a person holds the pane** rather than evicting them), **`game_frame`** (return `item.latest` as PNG with its sequence — the server already holds it), and **`recording_toggle`/`recording_commit`** (the desktop has the functions; expose the gesture). Verified by scripting NOLF to a loaded world and asserting **both** the `LoadWorld` line in `session_output` and a rising keyframe sequence in a committed segment. That closes **KI-024**, which records this exact gap: the existing check *"did not assert a menu transition"* and asks for *"a meaningful menu-state oracle"*. |
| **F119** | A **scenario as evidence**: script + expected log facts + a human checklist, producing a recording manifest and a verdict document in the shape NOLF's `in-headset-review-*.spec.json` already uses. Recorded as evidence, never as `passes` — `AGENTS.md` and the training boundary both forbid a machine run standing in for a pending visual/headset criterion. |

External prerequisite, owned by each game and not by us: a **game-owned state oracle** — an on-demand
line naming world, player pose, menu id — using seams that already exist (`RELITH_AUTOSTART`,
VtMB's `--map`/`--fire`/`--fixed-dt`). Without it F118's oracle stays "a pixel changed and a log line
appeared", which is worth shipping and is not enough for long.

### VR: F46/F47 stand, with two corrections

`docs/features.proposed.json` already carries F46 (Operator compatibility for a native host profile)
and F47 (XR inspection/control on one session) under milestone O4, proposed and never built. The
primary Meta docs confirm their shape — a standalone OpenXR API layer, custom tools for native
concepts, capture on demand rather than a viewport. Two corrections:

1. Their "native host profile" can only be **Quest-on-device or SteamVR-on-Windows**, never
   headset-free, until the Vulkan work of D48 lands. The Simulator is not an option.
2. They sit **downstream of the flat harness**, not beside it: the session-bound adapter, the
   input-ownership rules and the evidence artifact F47 asks for are the same objects F118 and F119
   build. O4 should depend on H0.

## What this roadmap does not decide

- **The model provider** (charter P05) stays deferred. D46's protocol slices need no provider; an
  embedded agent would force the decision, which is a reason to take them in this order.
- **Where a pack's bytes come from** (KI-008) is still open and still constrains D48's rendering pack.
- **Whether the games want the rendering pack at all.** D48 makes it a candidate with a consumer
  need; each game owns its own runtime and its own answer, and `AGENTS.md` is explicit that a local
  task cannot decide another project's adoption.
- **Windows**, for all three lanes. KI-014 and KI-038 are open, and the desktop suite's Windows
  repair is unfinished.
