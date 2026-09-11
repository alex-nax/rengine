# Progress Log

## Session 115 (macos) — 2026-09-11 — the companion draws the desktop's UI on a phone (D59)

The owner asked to try the Android phone rather than the Quest, and the phone refused to render:
its **Adreno 619 on a 2022 driver reports Vulkan 1.1.128 and its device extension list lacks
`VK_KHR_dynamic_rendering` and `VK_KHR_synchronization2`** — both of which the seam's Vulkan backend
is built on. Not a conservative feature flag: the loader reports 1.3 and the device reports 1.1, and
the extension list was enumerated on the handset. The control ran the same build on a Quest 3
(Adreno 740, Vulkan 1.3.295), where the device layer, the swapchain and the renderer all came up —
so the Android host was correct and the phone was simply below the floor.

**The owner amended their own decision** (D58's "Vulkan-only on Android, no GL path") after seeing
that: **charter D59** gives Android an OpenGL ES path beside Vulkan. The justification is in the
measurement plus F145's premise — *a phone on cellular* means mid-range hardware — and the fact that
all 56 GL entry points the seam loads exist in OpenGL ES 3.x.

**It renders**: 60 fps steady, 30 draw-list commands, 37 ms slowest frame (the first, paying for
shader compilation), density 2.75, on the phone. microui's frame, `draw_list.c`'s commands, executed
by **`backend_seam.c` — the desktop's renderer, unchanged**. The only Android-specific renderer file
is `seam_host_android_gl.c`, 146 lines of EGL, the fifth member of spec 124's one-file-per-platform
split.

Two additions made that possible, both of which left the desktop byte-identical on all three
backends:

- **`ReSeamShader.glsl_es`** — `#version 330 core` and `#version 320 es` are different languages, and
  only the backend knows which context it opened, so the GL backend reads `GL_VERSION` once at open
  and prefers the ES dialect on an ES context. `tools/shaders.py` emits a fourth dialect.
- **The window handle above the host is opaque.** `seam_host.h` took an `SDL_Window *`, which is what
  kept `backend_seam.c` — a file containing no SDL — from compiling for a phone. It takes a `void *`
  now, and error reporting moved to `re_seam_host_fail` so each platform uses its own channel.

`RE_COMPANION_BACKEND` picks `opengl` or `vulkan` at build time; both arms were built. A runtime
choice is what D56's prefixed copies exist for and nothing needs it yet.

**One thing on screen was a lie and is fixed**: the renderer label was hardcoded to "seam - vulkan"
and displayed exactly that while running on OpenGL. It reads `backend->ops->name` now.

**Still not met**: criterion 2 wants a frame budget *set before the run* and a smoke snapshot in the
suite; what exists is a measurement taken afterwards and a screenshot taken by hand. Criterion 3's
C ABI round-trip waits on F141. F144 stays `passes: false`.

`npm test`: 273/273. `npm run test:native`: 15/15. `./init.sh`, `design.py check` clean.

## Session 114 (macos) — 2026-09-11 — the companion exists, and it is the same code (F144, first slice)

`apps/companion` is an Android app that **builds and runs on a real device**, and the point of it is
where its C comes from. Decision 10 put the app in this repository because the shared C modules
cannot be "shared with iOS later" across a pin boundary while they churn — so the native build
reaches *up* into the tree and compiles `third_party/microui/microui.c`, `render/draw_list.c`,
`render/utf8.c` and `theme.c` from their own places. No copies under `apps/`, and a test looks for
one: a vendored second microui would satisfy every build and defeat the entire arrangement.

**Run on a Quest 3** (Horizon OS, API 34) — decision 10's case exactly, since Horizon runs Android
apps in 2D panels, making the Quest track a packaging variant rather than a second client:

    companion: native layer up, draw-list contract v2
    companion: window ready; building one shared-UI frame
    companion: draw list carries 12 command(s) from the desktop's own UI layer

Twelve commands built on the headset by the desktop's own microui and draw list. That is criterion
1's real evidence: not that an APK compiled, but that the screen it built is the screen the desktop
builds.

**What it does not do, stated plainly.** No GPU: criterion 2's Vulkan surface on the D49 device layer,
its snapshot and its measured frame budget are the next slice — a frame that exists is the thing to
prove before something draws it. No red-core: criterion 3's C ABI round-trip waits on F141's façade.
And not `ui.c`: the D33 control layer is SDL-free in itself but includes `common.h`, which includes
`SDL.h`; splitting that header is its own change, and pulling the layer in early would mean either an
SDL dependency on Android or a copied module. **F144 stays `passes: false`** — two of three criteria
unmet, and it depends on F141–F143.

**Pins**: Gradle 8.13 by wrapper with its distribution SHA-256 verified before it runs — and the
published checksum was fetched and compared rather than recalled, because I had written it from
memory. AGP 8.7.3, Kotlin 2.0.21, NDK 27.2.12479018, CMake 3.22.1, compileSdk 35, minSdk 29, arm64.

**One deliberate softening, recorded as a decision**: spec 128 says `init.sh` "checks and instructs"
for the Android toolchain. It **reports** rather than refuses — unlike cargo, which the desktop build
now drives, this toolchain builds only the companion, and a fatal check would gate every
contributor's harness on a mobile SDK for nothing.

Three sabotages, each observed: a copied microui under `apps/`, an NDK pin floated to `27.+`, and a
wrapper that stopped verifying its distribution.

**One unrelated failure recorded**: `project-token.test.mjs`'s extended-routes test failed once in a
full run and passed alone and on an immediate full re-run. It is the suite's most timing-sensitive
spec and this was the first run also carrying the F140 harness and the F144 test. **KI-088**.

`npm test`: 273/273 on the re-run. `./init.sh`, `design.py check` clean.

## Session 113 (macos) — 2026-09-11 — the libp2p wire contract, and the harness that keeps it honest (F140)

First step toward the Android companion: **`red.v1`**, the protobuf contract the façade and the phone
will speak (charter D57, spec 128 decision 5) — workspace and roots, sessions, the contract-2
dashboard, contract-5 tasks, the F113 agent registry, the project token, and the feed as a **oneof**
so an event the companion cannot read is a decode error rather than a silent drop.

**The contract is the easy half; the control is the feature.** The owner chose schema-first over
mirroring the host's JSON, accepting a second description of one API. So `red-core` translates the
LIVE host's JSON into those types and refuses anything it cannot carry — a missing field, a wrong
type, an unknown enum value, and **a field the host sent that nothing consumed**. That last one is
what a host gaining a feature looks like, and it is the change that would otherwise reach a phone as
a feature nobody implemented. What v1 deliberately drops is declared by name, so "we decided not to"
and "nobody looked" read differently in the source.

**It found four disagreements on its first real run**, written from the host's own responses:
`tasks.unavailable` — a tracker that cannot answer says *why* (`denied`/`unavailable`/`invalid`, with
`signIn` naming the provider), because "no tasks" and "no credential" look identical on a phone;
`evidence` on task rows; and contract 10's `tests` manifest, now recorded as deliberately not carried
in v1.

**Three sabotages, and the one that did not fire is the finding.** A renamed field and an invented
feed event were both caught by name. Renaming the `exited` session state changed **nothing** — the
fixture spawned one shell and left it running, so a whole enum value was validated by nothing. The
harness now spawns a second short-lived session and asserts the live host produced both states; its
precondition waits for "no longer running" rather than for the word, so a renamed state reaches the
checker and is reported as an unknown enum instead of failing on the fixture's own wait loop.

**Version in three places that cannot drift**: `PROTOCOL_VERSION` is one constant, the proto package
`red.v1` and the libp2p protocol `/red/1` are built from it, a test reads the `.proto` on disk to
prove its package line agrees, and `negotiate()` refuses a mismatched peer naming what it speaks,
what we speak and the contract version — a person reads that, so "handshake failed" is not enough.

**The dependency policy F139 deferred to here**: `Cargo.lock` is the pin — exact version and SHA-256
per crate, the same guarantee `third_party/sources.json` gives the vendored C sources. F139's "every
dependency is a path dependency" assertion is replaced by the invariant it was protecting, both
halves sabotage-verified. `protoc` is a prerequisite like SDL2, not a binary this repository ships;
`init.sh` refuses without it and says how to install it.

F140 passes; 33 features passing. Next on the road to the phone is **F141**: red-link attaching to a
live host and serving this contract over libp2p streams.

`npm test`: 269/269. `npm run test:native`: 15/15 including both Rust crates. `./init.sh`,
`design.py check` clean.

## Session 113 (macos) — 2026-09-11 — Rust retirement planned: libp2p façade and the Android companion (spec 128, D57–D58)

The owner opened a new direction: *"plan our js retirement in favour of rust"*, first component a
libp2p server, motivation a mobile companion app — *"connect from anywhere (pilot - android, use
microui for rendering on vulkan using ndk so that we share interface modules later with ios)"*.
Ran the grill-me workflow (three rounds, nine questions) instead of guessing, because this is the
widest design space the suite has opened since the desktop itself.

**The homework did half the interview.** The repo already held: the exact JS surface being retired
(`orchestrator/{server,runtime,launcher,agents}`, ~40 `.mjs`); Android+Vulkan already on the
rendering roadmap (spec 066) with the D49 device layer extracting exactly the surfaceless seam a
phone needs; a complete remote-client architecture sketch in the Quest research plus proposed
F49–F53 (pairing, root scoping, staged channels); and the F113 agent registry as the thing the
phone's "same functionality for everyone" must serve. One recorded constraint is reversed:
spec 114's "a Rust toolchain we do not have".

**Decisions taken** (full attribution in spec 128's table): full JS retirement by strangler path
with the Rust server as a **façade** over the live host; Rust wired **into cmkr/CMake from day one**
(owner overruled standalone-cargo-first); self-relay + dcutr + mDNS with no public bootstrap;
**protobuf schema-first** (owner overruled the JSON mirror — accepted a second contract, controlled
by live-host contract tests); Ed25519 peer IDs + QR pairing + revocation rows; **C drives, Rust
serves** inside the app (the desktop's `app.c`/`net.c` shape exactly); Vulkan-only on Android with
**native Metal for iOS** (owner overruled MoltenVK, scoping D29's GL-first order to the desktop);
v0.1 = *see, chat, approve*; the app lives in this repo at `apps/companion/` and the Quest track
becomes a packaging variant, superseding F49–F52's paired-socket transport.

**Artifacts**: `docs/specs/128-rust-retirement-and-companion.md` (decisions, architecture,
strangler sequence, evidence plan incl. pairing sabotage rows and forced-relay loopback, proposed
rows F139–F145 in a new N0 lane); charter D57–D58; AGENTS.md boundary paragraph naming the Rust
direction so future agents stop extending the Node layer. Charter rows land at D57/D58, not the
D50/D51 first drafted — the parallel rendering session had already taken D50–D56; renumbered
before writing.

**Addendum — the J0 epic and the hourly loop.** The owner approved filing and asked for an epic
the hourly loop can consume: *"every hour it takes a little (spec'ed and documented) slice in
favour of getting rid ourselves of js code. Rust is much safer."* So: `docs/specs/129-js-retirement-epic.md`
defines the loop contract (first ready J0 row from `features.py next`; one row per run; split
proposals to known-issues instead of partial slices), four invariants (API/proto shapes frozen,
JS deleted in the same commit its replacement passes, coverage ported never dropped, undocumented
quirks documented in evidence), the live-coupling hazards (mcp-worker is the connection this very
session uses; `RENGINE_NODE_EXECUTABLE`; the 736-line worker; tracker.mjs's re-implemented
readiness rule; surfaces focus eviction), and the 20-slice table F146–F165 ending in a node-free
dogfood day. 27 rows filed (F139–F145 N0 + F146–F165 J0); features.py validates 117 features;
`next` shows F139 as the only ready N0 row and zero J0 rows — the chain unlocks exactly one slice
at a time by construction. roadmap.md gained the N0/J0 lanes and the Q-row's supersession note;
graph regenerated (+87, insertions only). One cosmetic repair after filing: 27 descriptions had a
stray paren from string composition; fixed in place and re-validated.

**Commands/results**: docs-only change — `git status` confirms only these four paths plus the
pre-existing untracked `.claude/worktrees/`; no inventory change, so no graph regeneration;
no design-token change, so `design.py check` not implicated.

**Remaining**: the owner points the hourly loop at spec 129's contract; F139 (toolchain + `red/`
workspace) is the first implementable row and the only ready one in either new lane. The refresh
of the live workspace's worker code offered in Session 110 is still unanswered. F114 (ACP session
kind) remains the open O2 follow-up — spec 129 records that it may land in JS first without
contradicting the epic.

**Addendum 2 — F139 taken, built and passed (the first slice).** The owner said "take up one
slice", and the epic's own rule named F139 (zero J0 rows were ready). Landed: `rust-toolchain.toml`
(`channel = "1.93.1"`, verified repo-scoped via `rustup show active-toolchain` — inside the repo
`1.93.1 (overridden by rust-toolchain.toml)`, outside it the default `stable`); the `red/`
workspace with `red-core` (rlib) and `red-link` skeletons, zero registry deps and a committed
two-package `Cargo.lock`; Corrosion `v0.6.1` pinned by full sha in `cmake.toml` via FetchContent
(the cmkr-bootstrap shape, recorded in `third_party/README.md` — not a submodule, it's build
tooling); `rust_red_core`/`rust_red_link` on the ctest path; init.sh requiring cargo + the pin
and instructing rather than installing. Installed the pin through the owner's rustup by hand
(`rustup toolchain install 1.93.1`; reversible). **The non-obvious finding**: Corrosion's
`FindRust` picks the toolchain rustup marks active — provably `1.93.1` here
(`CMakeCache.txt: Rust_TOOLCHAIN:STRING=1.93.1-aarch64-apple-darwin`), which today equals
`stable`, so the cache line is the only evidence the right one was picked; recorded with the
`-DRust_TOOLCHAIN` escape hatch in `docs/evidence/rust-workspace-f139-2026-09-11.md`.
Checks established red-first: 7 acceptance subtests failed on absence, then four sabotages went
red for their own reason (channel→stable, sha→one-char-off, cargo off PATH, pin→9.99.9) and were
restored. Gates: clean-tree rebuild (`rm -rf .cache/desktop && npm run build`) with fresh
FetchContent clones + ctest 15/15; npm test 266/266; init.sh, design.py check, features.py
validate all green. F139 `passes: true` with four evidence entries; graph regenerated. The chain
unlocked as designed: **F140 ready in N0; F146, F147, F148 now ready in J0** — the loop has work.

---

## Session 112 (macos) — 2026-09-11 — the bookkeeping pass that was not bookkeeping (KI-085)

Settling F123 and F129–F133 was meant to be reading recorded evidence against recorded criteria.
**Three criteria turned out not to be met**, each the kind of gap that only shows when someone checks
rather than remembers.

**The pack's manifest described one layer.** `pack.json` said "the GPU device layer", listed
`gpu_device.h` as its only public header, and carried a pin from before the seam existed — while
F123's eighth criterion is that the pack carries *both*. Worse, `pack-gpu.test.mjs` — the evidence
that a project outside this repository can build it — only ever called `re_gpu_memory_type`. "And a
resource-and-draw seam" was a claim about a file nobody outside had linked. The outside project now
includes `rengine/gpu_seam.h` and calls into it; shipping only `gpu_device.c` was observed failing
with undefined `_re_seam_backend` and `_re_seam_counters`.

**The fetch script had four guarantees and no test.** Checksum, writes outside the repository,
refuses a destination inside it, states the licence — all four implemented, all four claims about a
file nobody ran. Its `--dry-run` is what lets a test check them without an 80 MB download. Removing
the repository guard and blanking the checksum were each observed failing.

**Allocations per frame were recorded nowhere.** F130 c6 and F131 c4 both ask for frame time *and*
allocations per frame, "because a rendering change that reports only correctness repeats the gap spec
110 names". Frame time was recorded; allocations were not, by anything. `re_seam_counters` is the
addition — GPU objects created, draws issued, frames bracketed — and the example reports the
difference across steady frames, which should be zero.

| backend | total | per steady frame | draws/frame |
| --- | --- | --- | --- |
| OpenGL | 14 | **0** | 32 |
| Metal | 20 | **0** | 32 |
| Vulkan | 1,969 | **32** | 32 |

**Vulkan allocates exactly one object per draw** and the counter is the only thing here that could
have said so — all three render the same frame to within 5 pixels. It is a descriptor set, because
`frame_begin` resets the pool and a set cannot outlive that: pool suballocation, idiomatic, a cost
rather than a defect. **KI-086**. What is gated meanwhile is the shape, not the number — a steady
frame may not allocate more than it draws — and two per draw was observed failing it.

**F123, F129, F130, F131, F132 and F133 all pass. The inventory goes from 23 passing to 31**, and the
graph is regenerated. KI-085 closes.

**KI-087 opens**: nothing evidences this migration on Windows — not the prefixed copies, not the
`/FI` force-include MSVC needs in place of `-include`, not the draw list through the pack — while
`RE_DEFAULT_BACKEND` there moved to `opengl` on the strength of evidence that measured the backend
this migration deleted.

`npm test`: 259/259. `npm run test:desktop`: 73 tests, 72 pass, 0 fail, 1 pre-existing opt-in skip.
`npm run test:native`: 13/13. `./init.sh`, `design.py check`, `seam_prefix.py check` clean.

## Session 111 (macos) — 2026-09-11 — the four hand-written backends are gone (F133)

`--renderer opengl|metal|vulkan` now names **one compile-time copy of the seam each**, reached through
`seam_backends.h`. The pack stays compile-time selected, so D14b's zero indirection holds for the games
it serves; the only runtime choice is which copy a window opens (spec 126 decision 3).

**2,082 lines across 15 files deleted**: `backend_gl.c`, `backend_metal.m`, `backend_vk.c`,
`backend_sdl.c`, their headers and sidecars, `shaders/ui.vert`, `ui.frag`, `ui_spv.h`. All three
renderers are **byte-identical to the frame the OpenGL backend drew before any of this began**.

**SDL_Renderer retired.** `--renderer sdl` answers *"Unknown renderer 'sdl'; use opengl, metal or
vulkan."* — charter D49 carried out, safe only because the reference frames were captured from that
path while it was still shipping, which is the ordering D54 required.

**Two gates changed shape, stated rather than absorbed** (F133 criterion 4). The live SDL comparison
is gone and the recorded frames are the only gate; cross-backend comparison stays as *information*,
since every backend now shares the seam and agreeing with each other says only that they run the same
code. A missing reference file is now a **failure**, not a skip — sabotage-verified by taking
`render-terminal.png` away — because with SDL gone that is the one way this suite could go green while
comparing nothing. And the memory budget becomes absolute: it was "32 MiB over SDL's resident set",
SDL measured 164–170 MiB, so the ceiling is now **208 MiB** against the 146–185 MiB actually measured.

**The boundary is checked now, not described.** `design.py`'s render-layering rule allowed a graphics
API in `render/backend_*.c` because four backends each carried one. It now allows
**`render/seam_host_*.c` only** — the migration's whole claim, as something the build refuses.
`shaders.py` loses `check_legacy()` with the pair it guarded.

**The pack's example was the thing most at risk and it is fine.** It only builds when the pack is
top-level, so the `re_seam_target_adopt` signature change could have broken it silently. It builds
standalone on all three backends and renders within **1, 4 and 5 pixels** of itself across them —
which also shows the OpenGL scissor conversion is right for its *off-screen* mirror pass, not only
for a window.

Suite: 392 / 436 / 32,195 px against the recorded frames on all three, **0 outside the 2px band**, 0
Vulkan validation messages, and the spec runs in **189 s instead of 821** — six backends and fifteen
pairwise comparisons became three and three. Vulkan is the one to watch at 3.95–4.81 ms against the
8 ms ceiling, for the three-submits-per-frame reason spec 124 records.

**F133's row still reads `passes: false`** and that is deliberate: `features.py validate` refuses a
passing feature whose dependencies are not passing, and F130/F131 were never settled because KI-082's
knot left the chain waiting. A bookkeeping pass over F123 and F129–F132 is **KI-085**. **Windows is
not evidenced**: the seam copies, `/FI` and the draw list through the pack have only run on macOS,
while `RE_DEFAULT_BACKEND` there moved to `opengl` on the strength of evidence that measured the
deleted backend.

`npm run test:desktop`: 73 tests, 72 pass, 0 fail, 1 pre-existing opt-in skip. `npm run test:native`:
13/13. `./init.sh`, `design.py check`, `seam_prefix.py check` clean.

## Session 110 (macos) — 2026-09-11 — the Vulkan host, and the Y story this project had wrong (F133)

`seam_host_vk.c` (410 lines) is the third and last host: surface, formats, images, views, acquire, the
two layout transitions the seam will not make, present, read-back. **All six GPU backends now match
the recorded frames identically** — 392 / 436 / 32,195 px, 0 outside the 2px band — and all fifteen
cross-backend pairs are zero. `vulkan` and `seam-vulkan` both report 0 validation messages.

**Synchronisation is CPU-side on purpose.** `re_seam_frame_end` submits with no semaphores and waits
the queue idle, so a host acquiring with a semaphore would have nothing to hand it; acquiring with a
**fence** is the same guarantee through the channel the seam leaves open.

**Three more defects, and one of them is this project's own claim.**

1. **`re_seam_target_adopt` hardcoded `VK_FORMAT_R8G8B8A8_UNORM`.** The header called that a
   narrowing. It was not: MoltenVK's surface offers BGRA8, BGRA8_SRGB and three HDR formats and **no
   RGBA8 at all**, so adopting a swapchain image — the entire point of the call — was impossible on
   this platform. `adopt` now takes the format in the API's own terms, beside the handle it already
   took in the API's own terms. OpenGL and Metal ignore it; Vulkan is the only backend that cannot
   recover it, because a `VkImageView` cannot be asked.

2. **The per-API Y was not drift, and spec 124 said it was.** The seam promises NDC −1 lands in row 0
   on every API — a promise about *memory*, right for a render target. It settles nothing about which
   way is up on a **window**, whose image has row 0 at the bottom on OpenGL and at the top on Vulkan
   and Metal. One formula cannot serve both, and the Vulkan copy drew the toolbar along the bottom.
   `backend_gl.c`'s `1 - y/h*2` and `ui.vert`'s `y/h*2 - 1` were **both right**; `ui.glsl` now writes
   `NDC_Y(t)` and each dialect defines it. The spec carries the correction at the point of the claim.

   **Why nothing caught it**: the pack's example established cross-backend parity by reading each
   frame back and comparing — and its OpenGL and Vulkan hosts **both read back without flipping**.
   That compares memory to memory. No assertion in this repository had ever asked a viewer which way
   was up.

3. **KI-083 closed, having been watched failing first.** With the flip corrected and the format
   accepted, the Vulkan frame came back right way up and with most of its geometry replaced by the
   last batch's — exactly the picture Metal had shown, and exactly why the KI was opened instead of
   fixed blind. The Metal answer ported directly.

**The validation gate now covers every Vulkan path, and it was proved to be listening.** A clean first
run reported zero messages, which is what a run with nothing attached would also report — `re_gpu_open`
was being given no `on_message`. Presenting straight from `GENERAL` told the two apart: six messages
naming the layout, then zero again once restored.

Four sabotages: Vulkan taking OpenGL's `NDC_Y` (520,509 px outside the band), collapsed buffer
generations (1,393,629), the host not stating the format (validation names the exact format
mismatch), and the missing present transition (6 messages). **The last two move no pixel the
reference comparison would notice** — a format mismatch renders the frame anyway on this driver — so
without the layers listening, both would have shipped green.

**`seam-vulkan` is the slowest path in the suite**, 2.90 / 3.17 / 3.31 ms against the 8 ms ceiling and
about five times `backend_vk.c`. Not the seam's drawing: three submits-and-waits per frame where the
old backend had one, because the seam submits and waits at `frame_end` by design and the host adds a
fence-waited submit on each side for the layout transitions. Pipelining is a change to the seam's
frame model, worth doing when a consumer needs the frames.

`npm run test:desktop`: 73 tests, 71 pass, **1 fail**, 1 pre-existing opt-in skip. The failure is `native-project-windows` waiting on a reopened window's recovery draft, which came back as `"Retain this drafgame disk text"` — the draft run together with the file's disk contents. An immediate re-run passed and two earlier full-suite runs the same day passed; it is a draft-restore race in a path this change does not touch, recorded as **KI-084** rather than waved through. `npm run test:native`: 13/13. `./init.sh`, `design.py check`, `seam_prefix.py check` and the sidecar check clean.

`features.json` untouched — F129–F133 stay `passes: false` while the `seam-*` values still exist beside the backends they replace, and a parallel session holds uncommitted work in this tree.


## Session 110 (macos) — 2026-09-11 — one agent recipe registry, and codex's hook trust gate (F113)

**The four private tables are one declared registry.** `orchestrator/agents/registry.mjs` is now the
single source for an agent's package, update mode, model flag, conversation/resume spellings with
their id shapes and argv parsers, MCP overlay kind, hooks overlay kind and IDE connect — cooked from
declarative data so an extra registry named in `RENGINE_AGENT_REGISTRY_EXTRA` adds an agent as DATA.
Every consumer reads it: `config.mjs` (identity, overlays, short ids), `tasks.mjs` (`knownAgents()`,
`modelArgs`, the `--help` model discovery now generic over recipes of kind `help`), `ide-connect.mjs`,
`store.mjs` (conversation id shapes), `worker.mjs` (spawn mints a conversation only for a recipe with
a START spelling — which also un-broke codex decomposition spawns the resume capability had just made
refuse), `report-session.mjs` (`--provider codex` with no table edit), `bind.mjs`, and `agent.sh`,
whose shell surface is the registry's own `list`/`show` CLI rather than a copy. The killer test adds
`testcli` as data and watches it become selectable, installable, launchable and spawnable with no
source edit; sabotage checks reddened each consumer class (private model table → killer red; dropped
`features.hooks` → overlay red; hardcoded agent.sh list → listing red), each restored.

**Codex's SessionStart hook needed a gate nobody had mapped.** The `-c` hook overlay parses fine
(an `exec` probe died only at the model call — the account is usage-limited to Sep 15), but the hook
never ran: codex runs a non-managed hook only when `hooks.state."<key>".trusted_hash` matches the
sha256 of its normalized definition. From the `rust-v0.153.0` source and the live app-server
`hooks/list`, the formula is now exact: key `/<session-flags>/config.toml:session_start:0:0` (the
synthetic layer codex makes for `-c`), hash over canonical JSON of the normalized identity — verified
byte-identical against codex 0.153.4, `trustStatus: "trusted"` when supplied in the same `-c` layer,
`"modified"` when wrong by one byte. The launch therefore trusts exactly the command it composed, per
key, with no write to `~/.codex` and no `--dangerously-bypass-hook-trust` (which would also waive
review for untrusted project-layer hooks — the attack the gate exists for). Then the live chain
fired end to end: TUI under a PTY → SessionStart with `session_id`/ `source: startup` →
`report-session.mjs --provider codex` → `POST /api/agent-conversation` on the stub host.
`docs/evidence/codex-sessionstart-hook-2026-09-11.md` has the whole map, including the update-nag
modal and the exec-doesn't-fire-hooks caveats. `ideDirectory()` also honours `CLAUDE_CONFIG_DIR` now
(criterion 5), with rEngine's own override still first.

**Verification.** npm test 258/258 (six new registry tests, the codex provider case, the codex
resume-subcommand identity parity); `./init.sh`, `features.py validate`, `design.py check` all clean;
graph regenerated. Sidecars: two notes moved to the new `registry.mjs._llm.json` with their ids
retained, five updated (config, report-session, agent.sh, worker, plus `codex-hooks-trust-themselves`
new), all stamped clean on `.cache/sidecars-kimi-f138.sqlite`. features.json F113 → `passes: true`.

**Remaining.** F114 (ACP session kind) is the O2 follow-up and untouched. If a codex upgrade changes
the hook normalization, the trust hash stops matching and the hook waits for review — re-verification
is the `hooks/list` call in the evidence file.

## Session 109 (macos) — 2026-09-11 — two seams in one binary, and the three defects that found (F133)

`--renderer` stays a runtime switch (spec 126 decision 3), so **the pack learned to build prefixed
copies**: set `RENGINE_GPU_TARGET_NAME`, `RENGINE_GPU_SEAM_BACKEND` and `RENGINE_GPU_FORCE_INCLUDE`,
add the directory again with its own binary directory. The rename header is applied `PUBLIC`, so
whatever links that copy compiles against the same names. The pack's sources are untouched and a game,
shipping one backend, sets none of it. `tools/seam_prefix.py` derives all 67 renames from the pack's
own headers; `init.sh` checks they still match.

**The guard mattered more than the generator.** A missed symbol does not fail the link — the linker
takes the first definition and two renderers quietly share one backend's function — so
`tools/seam_symbols.py` asks each archive after every build whether every exported `re_*` carries its
prefix. Its first version matched `re_seam_`/`re_gpu_`, which a *correctly* renamed
`re_metal_seam_open` does not start with, so it **examined zero symbols and called both copies
clean**. It now checks `re_` and fails when it examines nothing.

**`seam_host_metal.m`** (121 lines) is the second host. `--renderer seam-opengl|seam-metal` both
render, and both are byte-for-byte identical to all three hand-written backends: 0 differing pixels
across 21 cross-backend comparisons, and 392 / 436 / 32,195 against the recorded frames with **0
outside the 2px band** — the same counts the other three produce. `seam-metal` holds 146,288 KiB,
below SDL's 164,800.

**Writing the second consumer found three real defects, none of them findable by reading:**

1. **The draw list's MSL was flipped.** `--flip-vert-y` is right for an OFF-SCREEN image, where "the
   same way up" is a question about memory. This shader draws to the WINDOW, where NDC +1 is the top
   on OpenGL and Metal alike — so the toolbar rendered along the bottom edge.
2. **`re_seam_scissor`/`re_seam_viewport` had no defined origin and the three backends disagreed** —
   Vulkan and Metal measure from the top, OpenGL from the bottom, and the seam passed the caller's
   numbers through unchanged. Every caller in the repository clipped either full height or nothing, so
   **no test could tell.** The header now states top-left; OpenGL converts. That the OpenGL copy stayed
   byte-identical across the change is the evidence both halves were right.
3. **`re_seam_buffer_update` had no meaning for reuse inside a frame.** Metal and Vulkan `memcpy` into
   one buffer while the frame's draws are only *recorded*, so every draw reads the **last** fill.
   OpenGL hides it — `glBufferData` orphans — and the pack's example uploads once at setup. Every
   batching 2D renderer hits it immediately. Metal now takes a new buffer *generation* per in-frame
   update, reset at `frame_begin`, reused every frame because `frame_end` waits.

**Vulkan has defect 3 too and is NOT fixed here** — nothing in the repository exercises it, so a fix
could not be observed failing first. **KI-083**, to be closed by F133's Vulkan host.

**A fourth, found by reading the first three**: `re_seam_target_adopt` on Metal wraps the host's image
in a texture slot it retains, and destroy cleared only the target slot — so a host acquiring a drawable
per frame exhausts all 256 texture slots in four seconds.

**And that one exposed the suite measuring the wrong thing.** With the leak in place the render spec
still **passed**: three scenes at forty frames uses about half the slots. `gpu_seam_target_test.m`
adopts and releases 2,048 times with no window and fails on round 256 naming the reason — checkable
only because rEngine now links a copy per API. The prefix work paid for itself before it shipped.

Four sabotages, each red on the right backend for its own reason: the MSL flip (`seam-metal`, 520,509
px outside the band), collapsed buffer generations (`seam-metal`, 1,393,629), the unreleased adopted
slot (`native_seam_target`, *"adopt refused on round 256 of 2048"*), the dropped OpenGL scissor
conversion (`seam-opengl`, 212,381).

**A hole found on the way out: no npm script ran `ctest`.** Thirteen native CTest targets —
`native_gpu_seam`, `native_draw_list`, `native_editor`, `native_terminal` and nine more — had been
passing into a report nobody generated. `npm run test:native` runs them, and
`suite-coverage.test.mjs` now fails if no script runs ctest or if one narrows it with `-R`; both
branches were observed failing.

`npm run test:desktop`: 73 tests, 72 pass, 0 fail, 1 pre-existing opt-in skip. `npm run test:native`: 13/13. `./init.sh`, `tools/design.py check`, `tools/seam_prefix.py check` and the sidecar check all clean.

`features.json` is untouched — F129–F133 stay `passes: false` while the Vulkan host, the third copy and the deletions are owed, and a parallel session holds uncommitted F138 work in this tree.


## Session 109 (macos) — 2026-09-11 — kimi is a named agent (F138, spec 127)

Owner direction, in a Kimi Code session on this checkout: *"integrate our rengine environment
better with kimi ... unified integration so it would be the same functionality for everyone
including session listing+discovery"*, and reviewing the first plan draft: *"I think we can make a
user guided action to bootstrap hooks for agent"*. Also: *"update agents.md because it states
deprecated info"* (scope chosen: entry points + skills + a full stale sweep; the Orient pause block
was deliberately left alone). Numbering moved mid-session — the parallel seam session took
F135–F137 and spec 126, so this landed as **F138 / spec 127**.

**What a kimi pane gets that it did not.** kimi joins the named CLIs everywhere the other four are
named (`config.mjs` NAMED, `agent.sh` list/install/update via `@moonshot-ai/kimi-code` and
`kimi upgrade`, `KNOWN_AGENTS`/`MODEL_FLAGS -m`, launcher and bind usage strings). Its launch wires
the workspace MCP through the project-level `.kimi-code/mcp.json` — **the only per-project channel
kimi publishes** (no flag, no env override), written at the repo root found from the pane's cwd:
foreign entries preserved, rEngine's `rengine_` namespace reclaimed, invalid JSON refused with the
file untouched (sabotage observed red). Its session comes from its own `--session` flags in every
documented spelling (`session_<uuid>` and ULID shapes), with `kimi --session <id>` as the resume
line and an honest unknown for `-c`/the selector; **rEngine never mints a kimi conversation** (no
start-with-id flag exists), so `CONVERSATIONS` is now per-capability and the host refuses a named
kimi conversation without resume by name. Labels, pane titles and the picker all go by the eight
characters after the `session_` prefix — the same eight everywhere.

**Two subtleties worth reading the spec for.** One: the project file is last-writer-wins across
panes, so the MCP facade resolves its context from the pane's own environment *before* the shared
file's argv (spec 127 decision 5) — two kimi panes on one root keep their own identities; observed
red pre-implementation as a connection closed on the unreachable second pane. Two: kimi's
SessionStart hook lives only in the person's global `config.toml`, so live report parity is
delivered by **`bootstrap-agent-hooks`, a guided dashboard action** — detect, show, confirm,
back up, append idempotently, `kimi doctor` verify, self-restore on failure, removal printed.
It is the one edit rEngine ever offers to a global CLI config, and it is never required.
`report-session.mjs --provider kimi` reports over the same `agent-conversation` route claude's
hook uses; binding deliberately does no cwd discovery, because a kimi session started outside a
pane would otherwise rewrite a live pane's identity.

**AGENTS.md refresh.** Entry points now describe all three CLIs uniformly (`.agents/skills/`
discovered by Codex and Kimi Code, canonical definitions in `.claude/skills/`, invocation
`/skill:name` for Kimi Code), the workflow table has a Kimi Code column, and the stale sweep
verified every other referenced path, tool, pin and MCP tool name as current.

Commands/evidence: `npm test` 250/250 · failing-first on every new assertion · two sabotages
(kimiMcpFile foreign-key preservation, store cross-name id rejection) each red on its own reason ·
`./init.sh` · `design.py check` · `features.py validate` + regenerated `docs/roadmap-graph.md` ·
real machine: `agent.sh --action list` detects kimi 0.42.0, a scripted `agentLaunch` writes the
exact project file kimi reads, bootstrap `--dry-run` shows the hook and writes nothing.

Owed / next: F113 (agent recipe registry) remains the follow-up that collapses the per-consumer
tables kimi was added to; F114 owns the ACP session kind (`kimi acp`). `.kimi-code/` is git-ignored
here; consumers choose per the runbook note.

Completed after this commit, same day: the owner restarted the supervisor through the script tab
opened over the workspace MCP (plan named the kept host; windows closed and reopened, sessions
untouched), ran `bootstrap-agent-hooks` from the dashboard, and the hook is verified in
`~/.kimi-code/config.toml` (marked block, absolute node + reporter, `--provider kimi`), `kimi
doctor` clean, backup `config.toml.rengine-backup-20260911T143316Z` beside it. From the next kimi
pane on, the session record follows the CLI's own report — the final consumer path of F138,
verified live.

## Session 108 (macos) — 2026-09-11 — the draw list renders through the seam (F133, third step)

`backend_seam.c`: rEngine's 2D draw list on `packs/gpu`'s seam. **342 lines, and it names no graphics
API** — against `backend_gl.c`'s 520, `backend_metal.m`'s 690 and `backend_vk.c`'s 703. The API half
went to `seam_host_gl.c` (context, drawable size, present, readback), which is the piece that will
have a Vulkan and a Metal sibling next.

**Wired in as a fourth renderer before anything that works is deleted.** `--renderer seam` is
selectable for the length of the transition, and `native-render.spec.mjs` names `seam` beside
`opengl`, `metal` and `vulkan` so the new path faces every gate the old ones pass.

**It is byte-for-byte the same frame as all three.** 0 differing pixels against each of them on all
three scenes; against the committed reference PNGs, 392 / 436 / 32,195 pixels — *the same counts the
three hand-written backends produce* — with 0 outside the 2px edge band. 0.476 / 0.614 / 0.655 ms
medians against the 8 ms ceiling, 13,728 KiB over SDL against a 32 MiB budget, Vulkan validation
still at 0 messages.

**Three sabotages, each turning only the `seam` row red on its own assertion**: the scissor never
narrowing (129 px outside the band), the scissor origin read as top-left (212,381 outside), and the
glyph's coverage never reaching the atlas (fraction 0.01002 over 0.001).

**The third one earns its place.** Text vanishing completely left **0 pixels outside the edge band** —
every glyph is thin enough to be within 2px of an edge — so the band rule alone would pass a frame
with no text in it. The differing-fraction rule caught it. Both halves of that tolerance are
load-bearing and this is the case that proves it.

**`design.py`'s render-layering rule now names `seam_host_*.c` too**, because a seam host is the same
layer a backend was; `backend_seam.c`, which draws, stays under the rule and mentions nothing. The
rule was confirmed still to catch a GL symbol above the line.

**A C limit worth recording**: `ui_shaders.h` now emits each dialect as a brace-initialised `char[]`.
C99 guarantees only 4,095 characters for a string literal **and applies it to the concatenation**, so
splitting across adjacent literals — the obvious first fix — does not help. SPIRV-Cross writes a 4,898
character MSL body on one line.

`native-render.spec.mjs`'s timeout went 420s → 900s: a fourth GPU backend is one more capture and, because
cross-comparison is pairwise, six more whole-image compares.

Owed next: `seam_host_vk.c`, `seam_host_metal.m`, the three prefixed seam copies keeping `--renderer`
a runtime switch (spec 126 decision 3), then the four old backends and `ui.vert`/`ui.frag`/`ui_spv.h`.

`npm run test:desktop`: **73 tests, 72 pass, 0 fail**, 1 skip — `native-file-images`'s pre-existing
`RENGINE_IMAGE_PROOF` opt-in. `./init.sh`, `tools/design.py check`, `tools/features.py validate` and
the sidecar check all clean.

Commands: `python3 tools/shaders.py generate|check`, `npm run build`, `npx node --test
orchestrator/tests/native-render.spec.mjs`, `npm run test:desktop`, `./init.sh`, `python3
tools/design.py check`.

`features.json` is untouched: F129–F133 stay `passes: false` while the Vulkan and Metal hosts, the
prefixed copies and the deletions are owed. A parallel session holds uncommitted F138/agent work in
this tree, which this commit leaves alone.

## Session 107 (macos) — 2026-09-11 — a test's artifacts, where its task is (F137)

The half of spec 126 that depends on none of the rendering chain, and the one asked for first.

**Contract 10's `last` gains `artifacts`**: root-relative paths with an optional label, at most
sixteen. `log` is untouched — "where the output went" and "what the run produced" are different
claims and one field cannot make both.

**Answered at read time, not on click.** Each path goes through `resolveInRoot` — the helper the
editor's own open path already uses, symlinks included — then a `stat`, and arrives as `ok`,
`missing` or `outside`. An escaping path is also named in the manifest's error line, the way
criterion drift already is. rEngine still opens nothing it was not asked to and produces nothing.

**Drawn under the result F116 already shows.** A ready artifact is a ghost row that opens the file in
whatever view this workspace already has for it; one that is not ready is disabled and says which —
"not on disk" or "outside this project" — rather than hidden or left to fail on a click.

**Three sabotages, all caught**, all on the assertion that owns the claim: a path escaping the root
settled as ok, a missing artifact settled as ok, and every artifact offered whatever its state.

**Two things the test had to learn, neither of them defects.** Waiting for the opened artifact's
editor text never succeeded, because this fixture's declaration routes a `.txt` through the format
registry and the tab opens in `raw` mode with no editor — WHICH view opens is the registry's answer,
which is exactly what "opened in the view rEngine already has for it" means, so the test asserts the
right file opened under the label the project gave it. And opening an artifact focuses it, as
clicking a file in the explorer does, so the task list stopped being visible and the rest of the test
lost its controls; coming back is what a person does.

Commands: `npm test` 236/236 · `native-tracker.spec.mjs` with three sabotages · `design.py check` ·
`./init.sh`. `test:desktop` 71/71 but for KI-080's OpenGL RSS budget on a loaded machine (34,080
against 32,768), which a clean worktree at `197b539` already reproduces.

Remaining in spec 126: F133, then F108 and its widened ABI (F135), then the scene plugin (F136).

## Session 106 (macos) — 2026-09-11 — the scene in a tab, and a test's artifacts (spec 126, D55/D56)

A `/grill-me` interview, no implementation. Ten decisions in spec 126; the owner overruled the
recommendation twice and those two are most of the document.

**What the codebase answered so it was not asked:** a tab can already show rendered output
(`RE_CMD_TEXTURE`, which the game view fills with pixels another process streamed); the example is
already split so `scene.c`/`obj.c` call only the seam; F116 already draws each task's manifest entries
with proven/UNPROVEN; the contract has **no artifacts field**, only `last.log`, documented as "Not
opened"; and the desktop idles at **250 ms** per frame on purpose, so a continuously animating tab
costs the window rather than itself.

**The two overrules and what they cost.** The scene will **share one seam with the desktop**, so it
waits for F133 — rather than opening its own seam on the desktop's live device, which works today on
the shipped renderer. And it is **F108's first plugin** rather than a desktop view. Together they put
"show me the level" behind two unbuilt features, one of which has to grow first. That is written
down in the spec as a chain rather than discovered later.

**The tension the interview found, which is the interesting part.** Spec 106 deferred plugin textures
for one stated reason: *"a plugin holding one across a backend switch is a use-after-free the desktop
cannot see."* The owner then chose to keep `--renderer` a **runtime** switch (three prefixed seam
copies, pack untouched, D56) **and** to make the scene a **plugin** — which is exactly that hazard.
It is resolved rather than managed: a plugin asks for a render target each frame and gets a handle
good for that frame only, so nothing survives a backend switch to dangle. Same discipline tabs
already use, where a generation invalidates work in flight.

**D55** widens D38 by exactly two things, both with the containment the clip already has: a
frame-scoped render target, and pointer/buttons/wheel inside the plugin's own tab. Keyboard,
shortcuts, controls, unloading and any reach into store, session or host state stay refused.

**New rows.** F135 the widened ABI · F136 the scene plugin (an `.obj` opens a Scene tab as a `.png`
opens the image view; still by default) · **F137 the test artifacts, which depends on none of the
rendering chain and should not wait** — contract 10 gains `last.artifacts`, and the Tasks tab shows
and opens them.

Commands: `features.py validate` 89 features · `./init.sh`

## Session 105 (macos) — 2026-09-11 — a closed view never gave its slot back (F134)

Owner report: *"new tabs seems not to be opening in this instance of editor anymore, eg. i click
shell - it shows in sessions tab but I cannot neither attach to it nor new tab opens at all"*.

Both halves of that are right, and they have different causes. **The session was made** — the server
made it, so it appeared in the Sessions tab with a live PID. **The tab was not**: `re_app_tab` needs
one of the window's 64 slots, there were none, and it returned −1 after writing one line to the
status bar that is easy to miss.

**Measured in the owner's own window**, from `.cache/orchestrator-development/workspace.json`:

| | |
| --- | --- |
| slots used | **64 of 64** |
| views actually in a pane | **4** |
| orphans | **60** — 30 editors, 24 terminals and agents, 3 dashboards, Devices, Tasks, a tree |

Closing a view removes it from its pane and deliberately keeps its tab, so reopening restores what
was there — the reuse path in `re_app_tab`, and spec 080's refresh gesture. Nothing ever gave a slot
back. **And a restart would not have fixed it**: `re_app_restore` marks every serialised tab `used`
again, so the exhausted window would have come back exhausted.

**The fix** is the one the explorer already uses a few functions away: when every slot is taken,
release the least recently used view that is **closed**, and say which one — `enforce_row_cap`
collapses the least recently opened folder at the tree's row cap and names it. If every slot is on
screen, refuse in terms that are true. The generation advances so a reply or expansion still in
flight cannot land on the view that takes the slot, and the name is copied before the clear because
the status line names it — the same comment `enforce_row_cap` carries about paths.

**Two sabotages, each on its own reason:** nothing reclaimed reproduces the report exactly (*"ran out
of slots after 63 opens and closes"*), and reclaiming a view that is on screen breaks the close.

**Two earlier versions of the test would have passed for the wrong reason**, and both are recorded:
opening files through the tree ran out at `slot-4.txt` because the tree sorts alphabetically and that
is the forty-fifth row, so the test was measuring window height; and counting terminals from the tab
array can never see a close at all, because the tab persists — the bug wearing the test's clothes.

Commands: `npm test` 236/236 · `native-layout.spec.mjs` with both sabotages · `design.py check` ·
`./init.sh`. `test:desktop` showed a different single failure on each of two runs (the game specs'
KI-075 scancode flake, then a tree-expansion wait); all pass in isolation, and this machine has been
building three graphics backends all day.

Owed: the owner's running window still has the old binary. The fix self-heals a restored 64-slot
state, so it needs a desktop restart and no state surgery.

## Session 104 (macos) — 2026-09-11 — two API gaps and a third copy, all found by writing the port

F133, continued. No migration yet — and the reason is that writing the draw list against the seam
kept finding things, which is what this exercise is for.

**The seam's vertex layout could only describe floats.** rEngine's UI vertex packs colour as four
bytes; VtMB's note said a type enum before a second type exists would be speculative, and that held
right up until the second type turned up. Twelve bytes per vertex on a 65,536-vertex batch is 768 KiB
a frame. `ReSeamVertexAttribute` gained a `type` defaulting to float, implemented on all three
backends, exercised by a packed per-vertex colour in the scene so **three drivers agree it works**
rather than three implementations merely existing. Three sabotages, each caught. Vulkan then differs
from OpenGL in 1 pixel and Metal in 5, none outside the edge band.

**The desktop maintains its UI shader three times by hand** — inline GLSL in `backend_gl.c`,
`shaders/ui.{vert,frag}` for Vulkan, inline MSL in `backend_metal.m`. All five signed-distance modes,
the same expressions in three languages. They agree today, kept that way by hand: a fix to the ring's
inner radius has to be made three times and nothing fails if it is made twice. The pack's generator
already turns one source into all three forms.

**The decision that gates the rest, and it is the owner's.** The seam's backend is chosen at compile
time (D14b/D51) and rEngine's desktop chooses its renderer at run time. Both cannot survive the
migration. Either the desktop ships one binary per backend — what D51 intends for a game, and what
makes `native-render.spec.mjs` build three desktops rather than run one three times — or the desktop
keeps its runtime-dispatched backends and gains the seam as a fourth, leaving two OpenGL
implementations in the tree and half-proving the point. Recommendation is the first. It is a
user-visible change to a tool the owner uses daily, so it is not being made quietly.

Commands: `npm test` 236/236 · three attribute sabotages across three backends · the facade still
compiles vtmb-vr's call sites · `./init.sh` · `design.py check` · `shaders/generate.py check`

## Session 103 (macos) — 2026-09-11 — the oracle, captured before the path that served it retires

F133's first step, and D54's ordering is the whole point of doing it first: **the reference frames
were captured from SDL_Renderer while it is still a shipping path.** Afterwards would have meant
recording whatever the seam produced and calling it correct.

`orchestrator/tests/references/render-{workspace,terminal,primitives}.png` — **432 KiB for all three**
at 2560x1600, because 16 MiB of BMP each cannot live in a repository two games pin as a submodule.
`render_compare.py` gained a PNG reader (zlib and the five PNG filters, ~50 lines, standard library),
and `native-render.spec.mjs` judges every backend against them: 392, 436 and 32,195 differing pixels
across the three scenes, **none outside the 2px edge band**, with SDL matching its own recording at
zero.

**The sabotage that justifies the exercise.** D54 predicted that retiring SDL_Renderer would retire
the only independent witness, because once every backend renders through one seam a defect moves all
of them together. Nudging one shared colour — `--re-gray-1`, the window clear — and rebuilding:

| gate | what it saw |
| --- | --- |
| cross-backend, OpenGL vs Metal vs Vulkan | **0 failures** — all three moved identically |
| the live SDL oracle | **0 failures** — SDL moved too |
| **the committed reference frames** | **2,467,394 pixels** outside the edge band, on one scene |

Not a guess any more.

**What F133 still owes, and the one question that is the owner's.** The migration itself: the draw
list through the seam, and SDL removed from the selectable renderers. First, a conflict has to be
settled, because it changes how the desktop is built and tested — **the seam's backend is chosen at
compile time (D14b/D51) and the desktop chooses its renderer at run time.** Both cannot survive.
Either the desktop ships one binary per backend, which is what D51 intends for a game and means the
render spec builds three desktops rather than running one three times; or the desktop keeps its own
runtime-dispatched backends and gains the seam as a fourth, leaving two OpenGL paths in the tree and
half-proving the point. Recommendation is the first, and the cost — a longer desktop build in the
suite — is worth stating before it is paid.

Commands: `npm test` 236/236 · `native-render.spec.mjs` against the committed references · the
shared-defect sabotage · `./init.sh` · `design.py check`

## Session 102 (macos) — 2026-09-11 — three backends, one frame, two pixels each

F131. The Metal backend lands, and the scene example now renders the same frame through all three:

| | differs from OpenGL | outside a 2px edge band | ms/frame |
| --- | --- | --- | --- |
| OpenGL (the reference, D51) | — | — | 0.306 |
| Vulkan | **2** of 921,600 | **0** | 0.931 |
| Metal | **2** of 921,600 | **0** | 0.923 |

`scene.c` is the same source all three compile, and the spec asserts it names no graphics API at all.
One authored shader reaches all three through glslang and SPIRV-Cross; no runtime compiler anywhere.

**One reflection serves two backends.** SPIRV-Cross preserves a std140 block's memory layout when it
emits MSL, so the offsets reflected once out of the SPIR-V are the offsets a Metal buffer wants. The
reflector is no longer named for Vulkan.

**The Y axis, answered differently for all three — and the reason Vulkan's answer looked wrong.**
OpenGL: +Y up, row 0 at the bottom. Vulkan: **+Y down**, row 0 at the top — two differences that
cancel, which is why it needs no flip and why the "obvious" negative-height viewport was wrong there.
Metal: +Y up but row 0 at the top, so one difference stands and it does need a flip — and Metal has
no negative viewport height, so `spirv-cross --flip-vert-y` puts it in the generated MSL. In the
build, costing nothing at run time, invisible to every call site.

**Seven sabotages, five caught. Two are honest limits, and one of them taught something:**

- *A depth clear that ignores the write mask* cannot be exercised by a scene at all — `re_seam_clear`
  always clears colour, so clearing depth with writes off destroys the frame being compared. Tried,
  reverted, and recorded on the API instead: vtmb-vr's seam has no depth-only clear either, and the
  right time to add one is when a call site wants it rather than when a test does.
- *A frame that never synchronises its managed target* is undetectable on Apple Silicon, where
  unified memory makes a managed texture readable without the blit. It would matter on a discrete
  GPU; this machine cannot be the evidence, so the blit stays and the limit is written down.

**What Metal cost:** 800 lines against Vulkan's 990 — no instance, no device selection, no descriptor
sets, no image layouts or barriers. What it added is one real structural difference: **Metal has no
mid-pass clear**, so `re_seam_clear` ends the encoder and begins another with clear load actions.
One consequence a call site could see, stated rather than discovered: a clear is not clipped by the
scissor there.

Commands: `npm test` 236/236 · seven Metal sabotages · standalone pack builds for all three backends
· validation layers clean · `./init.sh` · `design.py check` · `shaders/generate.py check`

Next: **F133** — rEngine's own draw list onto the seam, and SDL_Renderer retiring to committed
reference frames.

## Session 101 (macos) — 2026-09-11 — D14c's bet holds: 2 pixels between OpenGL and Vulkan

F130. The scene example renders through a Vulkan backend with **no change to `scene.c` at all** — a
test asserts it calls no graphics API and includes no graphics header — and the two backends agree:

| | differing | outside a 2px edge band | validation |
| --- | --- | --- | --- |
| built-in scene, 14 draws | **2** of 921,600 | **0** | **0** |
| Crytek Sponza, 393 draws | **61** of 921,600 | **0** | **0** |

Every difference is a rasterisation tie at a shared edge. So resource+draw granularity *can* carry
Vulkan with command buffers, render passes, barriers and pipelines built inside the backend. **D14c
is no longer a bet.**

Uniforms by name survive through **SPIR-V reflection**: the backend reads member names and std140
offsets out of the module, so a consumer's shader build changes in exactly one way — it keeps the
SPIR-V it already produces and throws away. That needed one discovery: **`glslc -O` strips `OpName`**,
with or without `-g`, so an optimised module has no names to look up. `spirv-opt -O` runs the same
passes and keeps them, so the generator does the two steps separately.

**The y-axis decision, which a consumer inherits.** OpenGL stores NDC −1 in row 0; Vulkan's
framebuffer row 0 is the top. The usual negative-height viewport was the first version here, and it
made the main pass match exactly while inverting **every render-to-texture** — the off-screen inset
was the only part of the frame that disagreed, which is how it was found. There is no flip now: both
store NDC −1 in row 0, so a texture means the same thing on both. The cost is that a presented
Vulkan window is upside down and a windowed host must flip for its own final pass — which is the
right place, since presentation belongs to whoever owns the swapchain.

**Nine sabotages, each caught. Three were not, at first, and each was a real gap:** the scene never
used a depth compare other than LESS, never drew anything whose back faces were visible, and always
enabled depth writes before clearing — so three of the seam's own additions were uncovered by the
comparison meant to judge them. The scene gained a decal drawn twice; the OpenGL pixel test gained a
masked-clear assertion.

**And the first decal was a z-fighting test in disguise** — laid exactly on the floor, relying on
LESS_EQUAL to win a tie between two *different* pieces of geometry whose depths differ in the last
bits. 4,737 pixels apart, 133 outside the edge band. Priming depth from the same geometry makes it
decisive and identical on both.

**The validation layers earned their place**: `TRANSFER_SRC` missing from the seam's images meant a
host could not copy out of an image the seam had handed it — the very thing `re_seam_texture_handle`
exists for. It worked on this driver and would not have elsewhere.

**Frame time, measured so both numbers mean the same thing.** 0.281 vs 1.010 ms/frame at 14 draws,
1.321 vs 2.512 at 393. These are run totals, not per-frame medians: OpenGL's frame ends with a flush
and returns while the GPU works, Vulkan's submits and waits, so comparing medians (0.09 vs 0.91)
would report synchronisation as speed. Vulkan is slower and **the ratio narrows as draws rise**,
which is a fixed per-frame cost rather than a per-draw one — all four causes are simplifications
named at the top of `gpu_seam_vk.c`, none about the seam's shape.

Commands: `npm test` 236/236 · `ctest` 12/12 · nine Vulkan sabotages · validation layers clean on
both scenes · `./init.sh` · `design.py check` · `shaders/generate.py check`

Next: **F131**, the Metal backend, judged the same way.

## Session 100 (macos) — 2026-09-11 — the scene example renders, and three defects only a picture found

F132. `packs/gpu/examples/scene` is the pack's consumer: 14 parts, three programs, two textures at
both filters and both wraps, depth and culling toggled per part, an overhead pass into an off-screen
target that a later draw samples into the corner, and a blended overlay last. A project outside this
repository builds it from the pack; the pack builds it only when the pack is the top-level project,
so a consumer still gets the library and nothing else.

**Crytek Sponza loads as 786,801 vertices in 393 parts.** That is 393 draws with per-draw state —
the stress a Vulkan backend has to survive, and far more of it than the built-in scene gives. The
built-in scene is still what every gate renders; nothing requires the model.

**Five sabotages, each on its own assertion**, including one that predicted its own number:
*"and it is blended rather than opaque (green 191, unblended would be 191)"*. Two sabotages failed on
the first attempt and neither was a gap in the test — freezing `t` in `scene_draw` left
`box_transform` computing its own, and an unseeded `rand()` returns the same sequence in every
process. A sabotage that does not do what it claims produces a false "not caught".

**Three defects the pictures found that no assertion would have.** Each rendered without an error and
looked plausible until the image was examined:

- **A backdrop animating.** `draw_parts` decided which parts move by testing `tint[2] < 0.35f`, and
  the sky box's blue is 0.28 — so the backdrop took the spinning-box transform and swung through the
  scene. Parts now carry an `animate` flag. Sniffing a value to recover an intent that data could
  have carried is exactly how that happens, and I wrote it.
- **A depth clear that did nothing.** The frame ends with depth writes off for the blended overlay,
  so from frame one the next `clear(..., depth: true)` was a no-op — GL masks a depth clear by the
  write mask, which the seam documents and preserves deliberately (VtMB's *"a call site that clears
  depth sets the write itself"*). The static overhead camera then failed `LESS` against its own stale
  depth while the moving boxes sometimes passed. **It looked exactly like a broken render target.**
  The seam was right; the call site was wrong.
- **A camera fitted to the wrong thing.** Fitting the orbit to the bounding sphere put the camera
  outside the ±20 backdrop looking at its back — a black frame. Backdrops now carry a flag excluding
  them from the bounds. Framing is the caller's: `--orbit` and `--eye`, because one heuristic cannot
  frame both a six-unit scene and a building you want to stand inside.

Commands: `npm test` 235/235 (with `RENGINE_SCENE_MODEL` set, so the Sponza half ran) ·
`ctest` 12/12 · five scene sabotages · standalone pack build with the example · `./init.sh` ·
`design.py check`

Next: **F130**, the Vulkan backend, judged against OpenGL on these pixels.

## Session 99 (macos) — 2026-09-11 — the seam grows a render target, and Sponza gets a fetch script

Owner direction: prove the seam in rEngine rather than wait for vtmb-vr (option 4), carry **Metal**
in the pack too, **retire plain SDL**, and add a scene example like ForwardPlus_Vulkan's. Recorded as
**D53** and **D54**; planned in **spec 124**; decomposed into **F129–F133**.

**The measurements the API rests on.** Two consumers that have never coordinated name the same
missing call. vtmb-vr's renderer makes **~140 framebuffer and renderbuffer calls** the seam cannot
express (`glBindFramebuffer` alone is 63), plus 29 calls that only exist to save and restore ambient
state and 25 of pipeline state outside the small set. rEngine's own draw-list backend is missing six
entry points: `glScissor`, `glTexSubImage2D`, `glBlendFuncSeparate`, `glUniform2f`, `glReadPixels`,
`glFlush`. And the check that the seam is not simply thin: **the thirteen files already behind
vtmb-vr's seam contain zero raw GL calls** — D14's "never to GL directly" holds exactly for what it
serves.

**F129 is implemented and evidenced**: render targets made from the host's own textures, a frame
bracket, scissor, texture sub-upload, separate alpha blending, a `vec2` uniform, a depth compare
function. **Ten sabotages, each observed failing on the assertion that owns its claim.**

**The API question spec 123 said would be guessed was failed into instead, in about a minute.** The
first cut let a zero render target mean "the default framebuffer". The pixel test renders into its
own framebuffer, so "the default" was a 1×1 hidden window and everything after the first off-screen
pass read nothing. **Vulkan has no default framebuffer at all** — so the frame takes its target,
`re_seam_frame_begin(seam, target)`, and a zero target means *back to the frame's target*. That
forces exactly one escape hatch, `re_seam_target_adopt`, taking the host's own handle; it is the only
place the seam is not API-neutral, for the same reason `re_gpu_instance` hands back a `VkInstance`.

**One assertion was blind when written and the pass caught it.** *"A negative rectangle turns
clipping off"* cleared black onto an already-black half, so it passed with clipping still enabled —
the failure surfaced two assertions later against something else. Second time in this pack's history.
Also corrected: the separate-alpha assertion said "alpha above 200" from intuition; the real values
are **191** accumulated against **127** for a single blend mode, and the test now states both.

**Sponza.** `packs/gpu/examples/scene/fetch-sponza.sh` fetches Crytek Sponza (Frank Meinl, Crytek,
via Morgan McGuire's archive; CC BY 3.0) — run once to record its SHA-256, so the check is real:
`da005cbe…`. 80 MB zip, 21 MB OBJ, 393 materials, 54 textures. It writes outside the repository and
**refuses a `--dest` inside it** — an 80 MB model in a checkout two games pin as a submodule is
everyone's problem. Nothing in any build, test or gate references it; the committed procedural scene
is what the gates render.

**F129's row stays `passes: false`**, and not for want of evidence: `validate` refuses a passing
feature depending on a non-passing one, and F123 cannot pass until its eighth criterion has the
Vulkan and Metal backends. The chain completes at F131 and flips backwards. That is KI-082 showing
itself in the inventory.

Commands: `npm test` 233/233 · `ctest -R native_gpu` 2/2 · ten F129 sabotages · facade compile
against vtmb-vr's call sites · `./init.sh` · `design.py check`

Next: **F132**, the scene example — the consumer whose pixels will judge the Vulkan and Metal
backends.

## Session 98 (macos) — 2026-09-10 — the seam, generalised from VtMB and judged on pixels

F123's second half. The seam is written, its OpenGL backend runs against a real driver, and
vtmb-vr's own call sites compile through it unchanged.

**Spec 122 said this could not be written yet. That was wrong.** The reason given was that "a seam's
shape is settled by the call sites it has to serve, and rEngine has no 3D renderer to serve". The
first half is right; the conclusion is not. **The call sites exist** — thirteen files and 195 call sites in
`~/vtmb-vr`, readable and compilable against today. Waiting for F126 to read them was waiting for nothing.

**Measured before designing:** `device.h` is 174 lines and 25 methods with **no virtuals, no
templates, no inheritance and no data members**; 13 files call it; 23 distinct methods are used.
That shape is the language answer — an opaque handle with free functions in C++ syntax — so the pack
is a **C core with a header-only C++ facade**. rEngine's tree stays C; VtMB's call sites are
untouched. There was never an owner decision here.

**Three questions spec 121 left open, answered:**

- **Shaders.** `createProgram` takes GLSL and Vulkan cannot compile GLSL — except VtMB's own build
  already runs `glslang → SPIR-V → SPIRV-Cross` and **throws the SPIR-V away** in a work directory.
  The form a Vulkan backend needs is one the build already produces. `ReSeamShader` carries every
  form; call sites do not change, because the type is the generator's business.
- **Handle width.** The id is the *backend's* name for the object — a GL name here, a slot index
  where the API's handle is 64 bits. `0 == none` and the structs keep the size call sites assume.
- **Loading.** `re_seam_open` takes a `glGetProcAddress` exactly as `re_gpu_open` takes a
  `vkGetInstanceProcAddr`. Both layers now take entry points from the host, which is one rule rather
  than two, and it is why the pack cannot clash with the glad a consumer already links.

**Judged on pixels.** `gpu_seam_test.c` opens a real GL context (`4.1 Metal - 89.4`), renders through
the seam into a framebuffer **the test made itself**, and reads it back. **Thirteen sabotages**, and
the pass is the story: **four of them found gaps the first version of the test could not see** —
every sample sat at a clamped edge where nearest and linear agree; every uv stayed inside [0, 1]
where clamp and repeat agree; nothing but triangles was ever drawn; and uv ran the same direction as
position, so reading the wrong attribute offset produced the same two halves. A fifth was a
test-design fault: the coverage assertion used a uniform-coloured shader, so dropping `setUniform`
failed *"the draw covered the vertices it was given"* — an assertion claiming what it was not
testing. A sixth was in the wording: the wrong-form check asked for "GLSL", which a *driver's* own
error also says.

Two are honestly uncatchable and recorded as such: removing the null-GLSL guard **segfaults** rather
than failing an assertion (the driver dereferences the source pointer), and the buffer usage hint has
no observable behaviour at all.

**The facade preserves the call sites, checked by compiling them.** `gpu_seam_facade_test.cpp`
writes VtMB's expressions as VtMB writes them, and `pack-gpu-seam.test.mjs` builds it as a **C++
project outside this repository** that adds the pack. The same spec re-derives the 23 methods VtMB
calls and fails if any is missing from the facade or the fixture, so the hand-written fixture cannot
drift. Anchoring on the declared variables is what makes that number mean anything — grepping method
names alone counted 442 calls to `clear`, nearly all `std::vector::clear`.

**Adoption cost, stated rather than discovered: one call site.** `menu_eye_renderer.h:77`'s
`init(nullptr)` means "glad already ran, use the globals". A library that links no GL has no globals
— the same property that lets a consumer keep its loader. It fails to **compile**, which is the right
way to fail.

**Why no Vulkan backend, with a measurement instead of a preference.** The seam has no render-target
concept, because GL let call sites bind a framebuffer behind its back. In vtmb-vr **13 files bind one
with raw `glBindFramebuffer` (63 calls) and not one is among the 13 behind the seam** — two disjoint
groups of thirteen. Every call site that would shape the missing API is in the unmigrated 49, so it
would be guessed here and found wrong there. `RENGINE_GPU_SEAM_BACKEND=vulkan` fails the configure
saying so.

**That leaves a knot only the owner can cut (KI-082):** F123's criterion 8 wants a Vulkan backend,
F126 is where one can be judged, and F126 depends on F123. Recommendation is in the known issue;
nothing edited, because `AGENTS.md` wants an owner decision before a criterion moves.

The guard gained a second rule: the seam's sources may include no graphics API header and mention no
`SDL_`. Observed failing by name and line, twice.

Commands: `npm test` 233/233 · `ctest -R native_gpu` 2/2 · thirteen seam sabotages · three
facade/pack sabotages · two guard sabotages · `./init.sh` · `design.py check`

## Session 97 (macos) — 2026-09-10 — the Vulkan loader was here the whole time; F120 passes

**A conclusion I had recorded twice turned out to be wrong, and cheaply.** Spec 122 and KI-079 both
said F120's render-identity criterion was owed on another host, because `--renderer vulkan
--smoke-test` answers *"Failed to load Vulkan Portability library"* and `native-render.spec.mjs`
prints *"vulkan unavailable on this machine"*. Both statements are true about what was observed and
neither is evidence about the machine. `brew list` shows **molten-vk, vulkan-loader and
vulkan-validationlayers already installed**. The loader was even being found — the spec sets
`SDL_VULKAN_LIBRARY`. What was missing is the **ICD manifest**: Homebrew installs MoltenVK's under
`/opt/homebrew/etc/vulkan/icd.d/`, and the loader searches `share/vulkan/icd.d`, not `etc/`. So it
loaded, enumerated zero drivers, and failed indistinguishably from a machine with no Vulkan at all.

One variable. `vulkanEnv()` now discovers the manifest the way it already discovers the loader and
the layer path, and the Vulkan backend — every instance, device and queue call of it through the
**extracted device layer** — matches the SDL reference:

| | measured |
| --- | --- |
| workspace / terminal / primitives | 0.0096% / 0.011% / 0.79% differing, **0 pixels outside the edge band** on all three |
| cross-backend | `opengl-vs-vulkan`, `metal-vs-vulkan` both clean |
| validation layers | **0 messages** |
| frame medians | 0.222 / 0.319 / 0.348 ms against a 4 ms ceiling, 0.20–0.23× the SDL reference |
| resident memory | 144,976 KiB against SDL's 163,424 — below the reference |

**F120 passes.** KI-079 closes with the correction written down rather than deleted: *"unavailable on
this machine"* is a claim about the environment and deserves the same suspicion as any other
unverified claim.

**The selection logic, checked without a GPU.** The comparison proves the layer on this machine's one
Apple GPU; it cannot reach the parts that only matter where there are choices. `gpu_device_test.c`
hands the layer a `vkGetInstanceProcAddr` of its own making and checks the decisions — handles and
memory types, a predicate that refuses everything, a predicate that picks family 1 of 2, a device
below the feature floor, an API-1.2 device, a missing extension, a null loader. **Five sabotages,
each observed failing on its own assertion.** Two are new and close F120's sixth criterion: passing
`enabledExtensionCount = 0` to `vkCreateDevice`, and to `vkCreateInstance`. A layer that validates the
caller's extension list and then hands Vulkan its own would leave an OpenXR host with a device missing
exactly what its runtime demanded — **while reporting success** — and no test that only asks whether
`re_gpu_open` returned non-null can see it.

**The C/C++ question, resolved rather than escalated.** I put it to the owner as a decision; it is
not one. VtMB's `class Device` has ~25 methods, **no virtuals, no templates, no inheritance, no
exposed data** — an opaque handle with free functions in C++ syntax. So the pack is a **C core with a
header-only C++ facade** of inline forwarding: rEngine's tree stays C, and VtMB's call sites are
untouched when it deletes its own copy. No tradeoff for anyone to weigh.

**Two red rows, both load and neither ours.** Three full `test:desktop` runs back to back: 71/71
clean, then OpenGL RSS 33,648 KiB over the 32 MiB ceiling (KI-080, which a clean `197b539` worktree
already reproduced), then a `native-sessions.spec.mjs` timeout with `conversations: []` right after
the status line read *"Session connection restored"* — recorded as **KI-081**, not re-run until green.

Commands: `npm test` 231/231 · `native-render.spec.mjs` with all three GPU backends compared ·
`native_gpu_device` ctest with five sabotages · `./init.sh` · `design.py check`

Remaining: **F123's eighth criterion** — the resource-and-draw seam. Its shape is settled by the call
sites it must serve, and rEngine has no 3D renderer to serve; the argument for authoring it against
VtMB's thirteen migrated files instead is in spec 122, for the owner.

## Session 96 (macos) — 2026-09-10 — F123's pack ships, and the seam hits a language boundary

The device layer moved out of `orchestrator/native/render/` into **`packs/gpu/`**, and rEngine now
consumes it from there — so the suite builds the same bytes a project outside this repository does,
rather than a copy that can drift. One public header, private `src/`, a hand-written CMakeLists that
returns early when it is not the top-level project (iklib's shape), and a `pack.json` carrying the
two-part pin.

**Vulkan headers are a PUBLIC dependency**, because the public header includes `<vulkan/vulkan.h>`.
rEngine vendors them beside the pack; a consumer passes `-DRENGINE_GPU_VULKAN_INCLUDE=<dir>`, the
same shape `NOLF_IKLIB_DIR` uses, and a missing directory refuses by saying what to pass.

**The evidence is a project outside this build.** `pack-gpu.test.mjs` writes a CMake project that has
never heard of rEngine, adds the pack, links `rengine::gpu`, includes the header and runs the binary.
Two sabotages, both observed: publishing `src/` makes the implementation reachable; dropping the
not-top-level return leaks `rengine_desktop_core` into the consumer. The second assertion originally
asked `CMakeCache.txt`, which mentions target names for unrelated reasons and therefore **always
passed** — it now asks the build system's own target list.

**A design obstacle found only because the pack exists.** D52 says the pack also carries the
resource-and-draw seam generalised from VtMB's `device.h`. But **VtMB's seam is C++ and this pack is
C** — `namespace`, `enum class`, struct member initialisers, fifteen C++ constructs in one header —
and D52 has VtMB adopting *by deleting its own copy*, which cannot happen across a language boundary
unless the pack becomes C++ or VtMB rewrites every call site. That is the owner's decision and it is
now in spec 122; the seam is deliberately not authored blind.

**A red row that is not ours, chased to attribution.** `native-render.spec.mjs`'s 32 MiB OpenGL
memory ceiling now fails by 2–10% (33152 … 36160 KiB) and passed repeatedly earlier the same day. A
clean worktree built from `197b539`, before the device layer and the pack, **fails identically** at
33152 KiB under the same conditions. It is host load, not the change; the machine was at 39% free.
Recorded as KI-080 and deliberately not "fixed" by raising the ceiling — a budget that moves whenever
it is exceeded is not a budget.

**Both F120 and F123 stay `passes: false`**, and for good reasons rather than for want of effort:
F120's render-identity criterion needs a Vulkan loader this machine does not have (KI-079), and
F123's seam criterion is the half blocked on the language decision above.

Commands: `npm test` 231/231 · `pack-gpu.test.mjs` with both sabotages · `./init.sh` ·
`design.py check` · `features.py validate` (80) · sidecars stamped.

## Session 95 (macos) — 2026-09-10 — F120: the GPU device layer extracted, and what it cannot prove here

First of the pre-adoption work (D49, and D52's layer 1). `render/gpu_device.{h,c}` now owns the
loader entry points, the instance, physical-device selection, the device, the queue and the
memory-type lookup, with **no windowing symbol at all**.

**Only creation moved.** The backend keeps its own `Vk` table, its surface, its swapchain, its
present and the whole drawing path, and fills that table through `re_gpu_instance_proc` /
`re_gpu_device_proc`. That was deliberate: this code cannot be executed on this machine, so the
change is the smallest one that removes the coupling, and the parts nobody can observe are the parts
that were copied unchanged.

**The two things the caller supplies are the two that differ between a window and a headset**: the
required extensions, and a predicate saying which physical device is acceptable. The desktop asks
"can this queue family present to my surface"; an OpenXR host asks "is this the adapter the runtime
named". The layer can ask neither. The desktop's predicate creates its surface on the first call,
which is the only moment it can — the surface needs the instance, and the instance is made inside
`re_gpu_open`.

**A gate, not a review note.** `tools/design.py check` gained `native_gpu_device_layer`: the device
layer may not mention `SDL_`, `VkSurface`, `Swapchain` or `Present`. Observed failing twice, each
naming the symbol and line — a `VkSurfaceKHR` field, and an `SDL_GetError` reference.

**What is verified, and what is owed, kept apart.** Verified: it builds clean under the picky set,
zero `SDL_` in the layer, `npm test` 230/230, `test:desktop` 71/71, `native-render.spec.mjs` green
with SDL/OpenGL/Metal still matching under tolerance. Owed: that the **Vulkan** backend still renders
identically — impossible here, because there is no Vulkan loader. `--renderer vulkan` answers
"Failed to load Vulkan Portability library" both before and after, from `SDL_Vulkan_LoadLibrary`
before any of the new code runs, so the failure mode is unchanged rather than introduced.

**F120 therefore stays `passes: false`.** Its fourth criterion is render-identity, and that cannot be
judged where the backend will not start. KI-079 records what closes it: a Windows host, where F59 was
verified, or MoltenVK here. Marking it green would put a passing row against a claim nobody has
tested.

Commands: `npm test` 230/230 · `test:desktop` 71/71 · `native-render.spec.mjs` · `./init.sh` ·
`design.py check` · `features.py validate` (80) · sidecars written and stamped.

Next in the pre-adoption work: F123, the pack — the standalone build, the public surface, the pin,
and the resource-and-draw seam generalised from VtMB's `device.h`.

## Session 94 (macos) — 2026-09-10 — the rendering library planned, and VtMB had already written most of it

The owner asked to plan a rendering abstraction switchable between OpenGL and Vulkan, for later
integration into both games with GL kept to catch regressions and performance issues. Measured before
designing, and the measurement changed the plan:

| | GL symbols | files touching GL | behind a seam |
| --- | --- | --- | --- |
| `~/vtmb-vr` | 125 | 62 | **13** |
| `~/nolf-improved` | 102 | 39 | 0 |

**VtMB has already written most of this.** `src/renderer/gpu/device.h` carries F801's decisions with
their reasoning: D14 renderer code never touches GL directly; D14b selection is compile-time because
*"Quest is the constrained target, several of these calls are per-draw, and we never ship two
backends in one binary"*; D14c granularity is resource+draw, explicitly **not** command buffers,
render passes or barriers, on the bet that *"a Vulkan backend can build those internally"*.

So the expensive part is not the Vulkan backend. **A backend only serves files that go through the
seam** — 13 of 62 in VtMB, none at all in NOLF.

**D51: the switch stays compile-time**, upholding D14b rather than revising it. "Switch to OpenGL"
means build both and compare, which is the discipline rEngine already runs on its own adapters
(`native-render.spec.mjs`, `tools/render_compare.py`, recorded tolerance and measured budgets). The
cost is named: catching a regression on a headset means a rebuild and a redeploy, and no in-session
A/B.

**D52: the pack's design starts from VtMB's `device.h`**, generalised — curation as D01/D08 describe
it, a shape earned in a real renderer rather than invented in the suite — and VtMB adopts by deleting
its own copy. The **first Vulkan backend is written against the 13 files already migrated**, because
that is the cheap verdict on D14c's untested bet. If resource+draw cannot carry Vulkan, we learn it
at 13 files rather than after migrating 49 more onto a seam that cannot hold it.

**The library is two layers and a game needs both**, which is what the earlier plan conflated: the
device and context layer (F120 — instance, device, queues, submission, render targets supplied from
outside so OpenXR can hand it swapchain images with no window), and the resource-and-draw seam on top
of it. VtMB's `device.h` has no layer 1; it never needed one, because SDL made its context.

**D50 needs no revision.** The Vulkan backend lives in the pack, not in a game, so "a game's Vulkan
work starts once rEngine ships a pack" still holds — what a game does at F126 is adopt, not author.

Rows: F123 extended to carry both layers and both backends · F126 VtMB adopts on its 13 files (the
D14c verdict) · F127 its remaining 49 · F128 NOLF's 39, planned not committed. Order:
F120 → F123 → F126 → F127/F128 → F61's sign-off.

Also fixed a dangling reference: `tracker.c` cited "spec 121" for the design pairing, which lives in
spec 119 — 121 is now the rendering library, so the citation would have pointed at the wrong document.

Commands: `npm test` 230/230 · `./init.sh` · `design.py check` · `features.py validate` (80) · graph
regenerated.

## Session 93 (macos) — 2026-09-10 — NOLF's editor updated, and what the first adoption's aftermath taught

**NOLF's editor is on rEngine main and restarted.** Its pin had drifted onto `f9af9e5`, a commit on
rEngine's `feat/chat-file-image-tabs` **branch** rather than main — checked as an ancestor of main
before moving, so nothing was lost. Bumped to `8f6b820` (15 commits) as NOLF's `290f1b68`, with iklib
following at `620bff1` through the recursive bootstrap and still matching `NOLF_IKLIB_PIN`. Restart:
host **60124 not signalled**, supervisor 60259 replaced by 56219, desktop back on a fresh snapshot
whose binary carries the new strings. Only `third_party/rengine` was staged — a peer has active
uncommitted PV-hands work there and nothing was pushed, because NOLF's main is six commits ahead with
their unpushed work.

The list virtualisation matters most in that checkout: 1317 tasks, **35 213 draw commands a frame
down to 842**.

**Then the owner's question: the problem after the iklib integration is fixed — is there an insight?**
There is, and it is about our doctrine rather than about iklib.

NOLF's `ApplyArmEntriesToPose`, the applicator consuming the solve's output, constructed **three
`std::vector`s per invocation** on a path called from the display-time late-latch
(`app_vr_arm_latch.cpp:263`) and the PV-hands path (`vr_pv_hands.cpp:222`) — per arm, per frame, in
VR. Fixed with retained `static thread_local` buffers; NOLF's KI-526 is closed.

**iklib did not cause it.** Those allocations were F715's and pre-dated the adoption, which is what
makes it worth writing down: F1706 reviewed that seam more carefully than anything else in either
repository — 20 240 scenes, worst deviation 2.7e-5 LT, four sabotages, the deleted solve kept
verbatim as an oracle — and its spec mentions allocation, frame time, budget or profiling **zero
times**. It was exhaustive about the half it was asked to be exhaustive about.

**And the requirement already existed, in a document nobody reads at sign-off time.**
`docs/roadmap.md` M2 has always said *"integration cost, resource behavior and rollback are
recorded"*; spec 110's sign-off record — the thing an adoption is actually judged against — listed
pack, pin, project, what was run and seen, date and owner's words, and no cost. The two have
disagreed since D44b was written and the first adoption fell straight through the gap.

**It recurred the next day in a different lane**, which is the argument that it is systematic: spec
115 records that extracting the GPU device layer moves a per-frame solve from a header-only inline
into a linked library, and says plainly that nobody has measured it.

Changed: spec 110 gains a required **measured cost on the adopted path** (an addition to D44b's
record, not a reversal — worth the owner's confirmation at the next sign-off, since the format is
theirs); spec 111's sign-off slot now carries an honest *not measured*; and the integration runbook
gains section 12, asking for per-call cost before and after, **every** production call site, and the
budget it sits inside.

Commands: `./init.sh` · `features.py validate` (77).

## Session 92 (macos) — 2026-09-10 — the design actually landed, and a cross-vendor review found a real regression

The owner asked whether the design was proper yet. It was not, and the honest way to find out was to
render it and look — `native-design.spec.mjs` only asserts chrome geometry against `cards.json`, so
**nothing machine-checked the Tasks view against its card**. Captured through the desktop's own
`op: 'snapshot'`: each criterion's number stranded on its own line with its text ninety pixels below,
`Proven by` stranded the same way, values starting at x≈475 while their kickers sat at x≈590, and no
rail at all.

**The cause was structural.** `re_ui_paragraph` calls `mu_layout_row(1, {-1})` internally, so it
always seizes the whole row and cannot live in a column — every value it drew escaped its field.
`mu_layout_begin_column`/`end_column` is the fix: `end_column` carries the child's `next_row` and
`max` back, so a wrapped value pushes the rows below it down and grows `content_size` correctly.
Fields are now `[gutter][kicker][column: value]`, criteria `[gutter][kicker][number][column: text]` —
the card's hanging indent.

**The rail is drawn once, after the block.** Per-row it came out as chunky segments with gaps
wherever a value wrapped, because a row's cell is the *unwrapped* height; an immediate-mode block
cannot paint behind itself. Its width and indent are `theme.json` metrics now — the first attempt
used `RE_METRIC_DESIGN_SEPARATOR_HEIGHT`, which is **16**, hence a 16-pixel orange slab. And it is
asserted rather than admired: a run of pixels spanning 80% of the block's height that appears only
when the detail opens, so no colour is hard-coded.

**The cross-vendor gate earned its keep.** `ask-codex` reviewed six numbered claims about the
virtualisation, agreed with five, and found a **defect the feature had introduced**. `mu_update_control`
takes focus on `hover == id && mouse_pressed` without rechecking mouseover, and clears a stale hover
only when that control is updated again — so a control that stops being emitted keeps its hover. That
was unreachable while every row was drawn. Reproduced: hover a Spawn button, scroll it out of the
window, press empty space, and the chooser opens **for F132, a task not on screen**. Decompose spawns
an agent. Fixed in the owned layer (`control()` now also requires `mu_mouse_over`), which protects
every owned control and leaves upstream pristine; regression added and observed failing.

It also caught a claim of mine that was **wrong but masked**: I modelled the visible band as
`scroll.y … scroll.y + body.h`, but `push_container_body` insets by the style padding before the
scroll is subtracted. 112px of overscan hid a 5px error. A coordinate model that is only right
because it is generous is not right; the padding is subtracted explicitly now. And it fairly noted
the spec never scrolled — the new P1 regression does.

Two pre-existing microui defects recorded rather than fixed: scrollbar arithmetic overflows above
~40 000 rows (KI-077), and a shrinking chooser leaves one frame of stale thumb geometry (KI-078).
Neither is reachable at 1317 rows. KI-076 stays open for the microui hover behaviour itself.

**KI-075 passes again** — twice alone and in a full 71/71 desktop run, with nothing touched in the
game or automation paths. That confirms it depends on machine state `SDL_GetScancodeFromKey` reads.
Left open rather than closed: an intermittent test nobody can explain is worse than a red one.

Commands: `npm test` 230/230 · `npm run test:desktop` **71/71** · `./init.sh` · `design.py check` (20
cards) · `features.py validate` (77) · sidecars repaired, a constraint entry added, stamped.

## Session 91 (macos) — 2026-09-10 — a task list costs the viewport, not the inventory (F125)

The owner asked for VirtualizedList's technique adapted to C and microui, for
`~/nolf-improved`'s 1317-task list. Measured first, through the automation `stats` op:

| Tasks | draw commands/frame before | after |
| --- | --- | --- |
| 200 | 5 513 | **842** |
| 1300 | 35 213 | **842** |

`re_tracker_ui` ended in `cJSON_ArrayForEach(task, tasks) task_row(...)` — every row every frame,
each laying out eight columns and having its **whole description measured** by `re_draw_text_width`,
after which microui clipped almost all of it away. The work was done and thrown out. 42x fewer
commands on the long list, and the shape went from O(inventory) to O(viewport), which matters more
than the factor.

**Immediate mode drops VirtualizedList's hardest part.** That list must estimate row heights and
correct once measured, because it builds a retained tree before laying it out. Here rows are emitted
in order, so after a spacer the layout's own `next_row` **is** the content offset of the row about to
be drawn: the window is computed from truth every frame, with nothing estimated and nothing to
correct.

Two details that are load-bearing rather than incidental, both recorded in the sidecar. A run of
skipped rows becomes **one** spacer of the run's exact height minus one `style->spacing`, because the
layout adds a spacing after every row — get that wrong and `content_size` shrinks, so the scrollbar
reports the viewport instead of the list. And the row `menu.task` names is **always** emitted even
when outside the window, because an open chooser's block is far taller than its row and reaches into
the viewport when the row does not.

**The first assertion was the test's own bug, not the code's.** It compared 1300 rows against **ten**
and required the drawn rows to be within overscan: 23 against 10, red. Ten rows is shorter than the
viewport, so it draws ten for a reason unrelated to virtualising. Comparing two lists that both
exceed the viewport is the honest form — the only difference between them is what is below the fold,
so the rows drawn must be equal.

The regression asserts both halves: the draw list stays flat as the inventory grows, **and** the
visible rows are pixel-identical between the 200- and 1300-row lists. A window that drew the wrong
rows would pass a command count and fail the pixels. Sabotage — `wanted = true`, the original loop —
reports *"35213 commands for 1300 tasks against 5513 for 200"*.

Commands: `npm test` 230/230 · the five affected native specs 11/11 · `./init.sh` · `design.py check`
· `features.py validate` (77) · registered in `test:desktop` · sidecar entry added and stamped.

Not done: nothing else is virtualised. Sessions, Devices and Dashboard have the same shape and none
has thousands of rows today; `list_spacer` and this loop are the pattern when one does. And no
filtering — a person hunting one task among 1317 still scrolls, which is a different feature.

## Session 90 (macos) — 2026-09-10 — the task detail paired with Claude Design, and one red that is not ours

The owner: *"the data is correct - but you'd better improve design of it - can we pair up with Claude
Design?"* Both halves fair. The first detail view was laid out by guessing — a redundant `Task F115`
header repeating the key from the row above it, blank spacer rows opening gaps wider than the text
they separated, and criteria as unnumbered paragraphs floating at the pane's left edge.

**The pairing already existed, and the gap was that no card covered this surface.**
`design/previews/` holds a self-contained HTML card per view, `design.py generate` compiles them into
`cards.json`, and `native-design.spec.mjs` asserts native snapshots against the generated
measurements. With no Tasks card, the native layout had nothing to be wrong against.
`design/previews/views/tasks.html` now exists and is pushed to the owner's *rEngine native workspace*
project — 20 cards, and `design.py check` clean.

It settles four things: the block is inset by the key column with a left accent rail so it visibly
belongs to its row; values sit in one column under right-aligned kickers instead of starting at four
indents; criteria are numbered and tight, because unnumbered paragraphs cannot be referred to and a
tests manifest saying *criterion 3* needs a visible 3; and the repeated key and spacer rows are gone,
so the description leads.

The card guard earned its keep on the way in: `design.py check` refused two symbols the preview used
that no entry in `icons.json` claims — exactly the drift it exists to stop.

**A measurement had to move with the design.** The wrap assertion anchored on `tracker-detail`, which
used to be the header row; with the header gone that anchor sits inside the description and the gap
collapsed to 4px either way — it would have passed while measuring nothing. It now measures from the
task's own row, which does not move, to the first field after the description, so the distance *is*
the description's height. Cut to one line: `52px against 52px`, red.

**One desktop spec is red and it is not ours.** `native-game.spec.mjs` receives `key 0 1` —
`SDL_SCANCODE_UNKNOWN` — where it expects `key 26 1`. The pane and the surface transport work; only
the keycode-to-scancode translation fails. It fails identically at `737b58a`, before any of this
session's native work, in a clean worktree built from that revision, and it passed earlier the same
day — so the likely cause is machine state `SDL_GetScancodeFromKey` depends on, not a code change.
KI-075, recorded rather than absorbed.

Commands: `npm test` 230/230 · `npm run test:desktop` 69/70 with KI-075 the only red ·
`design.py check` (20 cards) · `features.py validate` (76).

## Session 89 (macos) — 2026-09-09 — a task read rather than scanned (F124), and two more controls that never clipped

The owner drew the right consequence from the trimming: *"Now that text is trimmed there - we need a
detailed task view"*. What was actually missing was not a view but a **control** — every text control
in `ui.h` drew one clipped line, which is right for a table row and useless for a description.

**`re_ui_paragraph`** wraps to whatever width the layout gives it, takes a layout row per line so the
container reserves real height and the pane scrolls the whole of it, reads the width back from the
first cell rather than assuming it, and breaks an over-long word by character — a path or a symbol
name being exactly the case where a word-only wrap would reintroduce the bleed.

**The gesture is the title.** The row trims it, so the title opens the full text: no new column in a
row already carrying four controls and a pill, and the thing that was cut is the thing you click.
The block shows the description in full, labels, assignee, what the task waits on, and every
criterion wrapped — the Spawn chooser clips criteria because it is composing a prompt; here they are
the thing being read.

**Making the title a button immediately failed spec 118's clip test — 715 pixels.** `contents()`,
which draws every button, select and menu-item label, also ended in a bare `ui_text`: **controls had
the same overflow labels did**, invisible only because no label had ever been long enough to reach
anything. It now clips to a box stopping before the caret. With session 88's `apply_scissor` repair,
clipping is finally real for every `text_clipped` caller — textboxes, tree rows, pills, tabs and
buttons. All of them believed they were clipping; none of them were.

**The wrap assertion took three attempts and the first two would have shipped as false evidence.**
Counting pixel rows below the header passed with the paragraph cut to one line, because the rest of
the block filled them. A fixed threshold of twice the row height also passed: measured, the gap is
70px wrapped and **51px** unwrapped, and 48px cleared both — a number guessed from the layout rather
than measured from it. What bites is comparing the same block twice, long description against short:
cut to one line it reports *"51px against 51px"*, because with no wrapping the two are identical by
construction. Nothing to calibrate, nothing to guess. `blind-regressions-2026-09-06.md` says this
already; a threshold is the easiest kind of assertion to get wrong because it looks like a
measurement.

Commands: `npm test` 230/230 · `npm run test:desktop` 70/70 · `./init.sh` · `design.py check` ·
`features.py validate` (76) · sidecars repaired, two notes extended, stamped.

Not done, and named: the detail is inline under its row, not a pane. A task kept open beside an
editor and surviving a restart needs a tab type, a binding and layout persistence — worth doing if
the owner wants it, and not needed to stop the trimming from hiding the text.

## Session 88 (macos) — 2026-09-09 — the label fix that did not work, and the oracle that proves this one does

The owner reported the Tasks titles running across the buttons a second time, after a fix I had
shipped as done. They were right, and the reason is worth more than the fix.

**Two layers.** `re_ui_label_ex` drew at its cell origin and never clipped — that was layer one, and
routing it through `text_clipped` was the obvious repair. It changed nothing, because
**`text_clipped` had never clipped anything**: it narrows the box with `ui_clip`, and the very next
`ui_text` calls `apply_scissor`, which restores the container's wider scissor whenever `ui.applied`
differs from it — precisely the state `ui_clip` had just created. The narrow clip was emitted and
undone before a glyph was drawn, for every caller, buttons included. It only ever showed when text
was long enough to reach something. The `clip-cost` sidecar note had been describing behaviour that
did not happen, and is now corrected rather than quietly extended.

**The fix is three lines**: `ui_clip` records that an explicit clip is in force and `apply_scissor`
leaves it alone until `ui_clip(NULL)` releases it.

**The part worth keeping is the oracle.** KI-074 said no test here builds an owned UI control, which
is why the first fix went out on reasoning alone. The missing harness turned out not to be needed:
the desktop already answers `op: 'snapshot'` and the automation snapshot already reports every
control's rect. So — **lengthening a title must not change one pixel to the right of its own
column.** Everything right of it is drawn from data the edit does not touch, so a difference there
*is* the bleed. No colours, no golden image, both frames from one process.

Reverting only the `apply_scissor` half — the exact state my first fix left the tree in — bleeds
**689 pixels, first at x=2517**, the pane's right edge, which is what the owner photographed.

Two things the first run of the test got wrong, recorded because they will catch the next person:
the snapshot is the **drawable**, 2560x1600 for a 1280x800 window, so logical rects need the device
scale derived rather than assumed; and the sanity assertion that the longer title *did* change pixels
inside its own column earns its place, because a change that stopped drawing the title at all would
pass a bleed check perfectly.

Commands: `npm test` 230/230 · the new `native-label-clip.spec.mjs` plus `native-tracker`,
`native-render` and `native-tasks-controls` 10/10 · `./init.sh` · `design.py check` · registered in
`test:desktop` so it is not invisible in a green report · sidecar corrected and stamped.

KI-074 is narrowed rather than closed: the draw-list form, which would name the missing clip command
instead of showing its consequence, still does not exist.

## Session 87 (macos) — 2026-09-09 — F116: contract 10, and the field that answers "is this test correct"

F115 put the inventory's `evidence` strings on the row, which answers *where* a test is. It cannot
answer whether the test is any good, because `AGENTS.md` defines a regression as established only
once **observed failing for its own reason**, and prose cannot carry that. So contract 10's manifest
carries the **sabotage rows** — what was broken, what went red — and that is the field the whole
format exists for.

**The shape.** The declaration names a file and nothing more; the manifest is the project's own
artifact with its own schema (`contracts/task-tests-v1.schema.json`), keyed by the task key its own
provider uses, so one format serves `F123`, `BAS-1020` and `#42` alike. rEngine joins on the key and
never parses its meaning.

**Three rules that make it worth having.** An entry with no sabotage rows is **unproven**, however
green its last run was — a passing command says a command passed. An entry claiming a criterion the
task does not have is refused by name, because a claim pointing past the criteria reads as coverage
rather than as absence. And no entry ever moves a row: a manifest saying everything failed leaves
every task where its provider put it, which is D44 and D47 as written and the rule a later reader is
most likely to break in good faith, because a failing test *looks* like it should block a task.
Sabotage S3 exists to catch exactly that.

**Staleness is shown, not judged.** The reader resolves the checkout's commit from `.git` by reading
files, never by running git — a subprocess for a display detail is a cost and a permission this
reader should not take — and answers *unknown* on a layout it cannot follow, because "stale" and
"cannot tell" are different answers.

**Three contract tripwires fired, which is what they are for.** `packs.test.mjs` and
`task-writes.test.mjs` pin `CONTRACTS.at(-1)` so whoever raises the ceiling comes and confirms the
earlier blocks still read as they did; both now carry a *Confirmed for 10* note beside 8 and 9. The
third asserted the supported-contract list as a literal string and now derives it from `CONTRACTS`,
so it states the invariant instead of a copy that must be retyped on every bump.

**A defect the owner caught, fixed on the way.** The Tests caret narrowed the title column and made
an old bug visible: `re_ui_label_ex` drew at its cell origin and never clipped to it, so a long task
title ran straight across the buttons and out to the pane edge. `ui.c` already had `text_clipped` —
which keeps the adapters' batch when the text fits and narrows the scissor only when it does not —
and the label simply was not using it. **No automated regression**, and that is recorded rather than
glossed: nothing here builds an owned control in a test, and the automation snapshot reports the
cell rect, which was correct both before and after. KI-074 wants a UI-level draw-list harness.

Commands: `npm test` 230/230 · `native-tracker.spec.mjs` 2/2 · `native-tasks-controls` and
`native-format-hardening` unchanged · `./init.sh` · `design.py check` · `features.py validate` (75)
· four sidecars re-anchored, two notes extended, all stamped.

Remaining in T0: F117, filing a verdict on a bad test as a task through the project's own write path.
No project produces a manifest yet — rEngine's own is the natural first, and is not this slice.

## Session 86 (macos) — 2026-09-09 — the workspace's own actions are the first place to look

The owner: *"you can invoke restart script that we implemented with mcp (we need to work on
availability such things in context because you constantly keep forgetting about that)"*. Correct,
and it had happened three times in one session — I kept ending a native change with "you will need to
restart the desktop", for a script this session helped build.

Ran it properly through MCP: `dashboard_actions` lists it, `restart-supervisor.mjs --state DIR
--plan` is read-only and names what it would leave alone, and `open_script` opens the wizard as a
retained tab. Its confirm has **no non-interactive bypass** — `re_confirm` refuses without a TTY —
which is a deliberate boundary on an action that closes windows, so the owner answers in the tab.

Result: session host **33465 not signalled, its sessions intact**; supervisor 57193 stopped with its
2 desktop windows; a detached PID 34376 started from this checkout; the desktop reopened on the
stored layout with all 17 retained sessions still attached. F115's Tests caret is live without anyone
touching a terminal by hand.

**The durable fix, in AGENTS.md rather than only in my head.** A new paragraph in "Project skills and
terminal routines": before handing a workspace operation back to the owner, call `dashboard_actions`
and check whether one already exists — it lists script, args, prerequisites and current availability
and is the discovery entry point for what this workspace can already do. It names the restart action
specifically, the `--plan` way to find the state directory, and why the confirm is interactive. The
failure this fixes is not knowing less; it is not looking at what the workspace already offers before
delegating back to the person.

Commands: `./init.sh` clean.

## Session 85 (macos) — 2026-09-09 — F115: a task carries the evidence that backs it (T0 starts)

The owner picked the testing lane to start, and F115 is its first slice: no contract change, no new
declaration key, no producer in any project — the data was already there and already read.

**The defect in one line.** Every `features.json` row carries an `evidence` array naming the test and
what it proves, and `localRows` mapped `acceptance_criteria` and never mapped `evidence`, so the
field died one function before the UI. `row()` has carried `criteria` since spec 103 for exactly this
kind of reason; evidence was simply never added beside it.

**The pane gets a third chooser kind.** Spawn and Hold token already draw inline rows under their
task — not a popover, for reasons `tracker.c` records — so `RE_CHOOSER_TESTS` joins them behind a
**Tests** caret, pairing each claim with what proves it. Criteria appear in the Spawn chooser because
that is where the prompt is composed; they appear here because "what does this task claim" and "what
proves it" are one question, and reading them apart is what left the tab unable to answer it.

**Two things the sabotages taught, both worth more than the feature.**

S3 — dropping `row()`'s default — did not bite at first. It failed on the *first* assertion, because
the field vanished for local and remote alike, so the remote-provider default was never isolated. The
GitHub row test now asserts `evidence: []` explicitly, which is the only place that default carries
weight, since no remote path sets the field.

S4 — drawing the Tests caret only on local rows — **stayed green**, and that is a coverage gap rather
than a pass. Every row the native harness can reach comes from a `local` provider, because the
desktop binary makes its own tracker requests and a fixture cannot inject a remote response the way
the node test can. So the decision to draw the caret on every provider's rows is implemented and
unverified in the desktop. Recorded as KI-073 rather than papered over.

Also corrected: the schema described the `local` provider as reading features.json "through
tools/features.py". It reads the file directly and re-implements the readiness rule; the description
has been wrong since contract 5.

Commands: `tracker.test.mjs` 8/8 · `native-tracker.spec.mjs` 2/2 · `native-tasks-controls.spec.mjs`
unchanged · `npm test` 227/227 · `./init.sh` · `design.py check` · `features.py validate` (75) ·
sidecars re-anchored, notes extended for the third chooser kind, stamped.

Remaining in T0: F116 the contract-10 tests manifest, which is what carries tiers, preconditions,
sabotage rows and last results — the fields that answer "is this test correct" rather than only
"where is it". Then F117, filing a verdict as a task. KI-073 wants a native remote-row fixture.

## Session 84 (macos) — 2026-09-09 — the pack gate: no game Vulkan work until rEngine ships a pack (D50, F123)

The owner: *"The game vulkan work should be started once we have a proper library pack implemented in
rengine sources"*. That changes what F120 is. It was a refactor with the desktop as its only
consumer; it becomes the delivery vehicle for **rEngine's first library pack from its own sources**,
and the games wait behind it.

**Why the ordering earns its keep.** Without the gate, two games each write their own Vulkan OpenXR
binding in parallel in their own repositories — the duplicated implementation D01 and D08 exist to
prevent, and exactly what D24's "one curated capability at a pinned version" was written against.
With it, F61's "one game adopting the renderer through an adapter" gets a mechanism instead of an
aspiration — **beside** iklib rather than instead of it. iklib is the pilot pack (D09, D23) and it
proved the *consumption* path: pinned submodule, `add_subdirectory`, a linked target, an adoption
measured and signed off. F123 proves the *production* path, which iklib never had to answer because
it lives in its own repository with its own source and feature authority. A capability inside
rEngine's own tree has never been consumable from outside it.

**What "proper" has to mean, measured against the tree.** `rengine_render` is already a static
library target, but **nothing here is installable or exportable** — no `install()`, no export set —
so a consumer today would absorb the whole build and depend on an internal target name. The pack
needs a standalone build, a public surface smaller than the tree, a two-part pin, and a project
outside this repository that has actually built it. The shape is already proven in our own family:
iklib's `if(NOT CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)`, `include/` public and `src/`
private.

**Acquisition needs nothing new, and KI-008 does not have to be settled first.** `~/nolf-improved`
already pins `third_party/rengine` as a submodule — bumped to `6e88a5c` this week for iklib — so a
pack built from rEngine's own sources arrives with a pin the project already holds, through the
recursive bootstrap that already works. No download, no new mechanism. That is a property of
rEngine's own packs and does not generalise to third-party ones; KI-008 stays open for those.

Rows: F123 the first library pack (R3, depends on F120). F121 re-gated to depend on it, and its
external reference now says the game work starts only after F123 ships. The order is: F120 extract →
F123 package → a game adopts and writes its Vulkan binding → F121 replay → F122 fixture → F61 the
adoption recorded with the owner's sign-off.

Commands: `features.py validate` (75) · `graph` regenerated · `design.py check` · `npm test` 226/226.

Remaining: F120 is startable now and needs no game. Still nobody has agreed to adopt — D48 gave the
abstraction a consumer need and D50 gives it a shippable form, but neither gives it a consumer, and
that conversation is with each game's roadmap.

## Session 83 (macos) — 2026-09-09 — SDL stays, the device layer leaves; the Simulator planned (D49, F120–F122)

Two owner questions that turned out to be one: whether to ditch SDL, and how the Simulator gets
integrated once a real Vulkan renderer exists. The only part of SDL worth removing is the part
standing between us and OpenXR, and removing it is what makes the Simulator reachable.

**Measured before answering.** `orchestrator/native/` uses **172 distinct SDL symbols** — 37 window
and graphics binding, 32 events and input, 26 `SDL_Renderer`, 20 threads and sync, plus cursors,
timers, clipboard, `SDL_OpenURL`. Replacing that is precisely the work SDL exists to do, on two
platforms, and Windows is already the weak one (KI-038). The games are SDL games besides: the
embedded pane works by interposing SDL *inside the game's process*, and the input wire protocol is
SDL-shaped. Ditching SDL would not remove SDL from the seam; it would leave us speaking two input
vocabularies across it.

**But `render/backend_vk.c` uses SDL 23 times in 750 lines**, and they are concentrated in
`SDL_Vulkan_GetDrawableSize`, surface creation, an error string and a BMP helper. Instance, physical
device, queues, memory and `vkQueueSubmit2` are already SDL-free. Those 23 references are exactly
what OpenXR takes over — the runtime dictates instance and device creation and hands the application
images from `xrCreateSwapchain`, with no `VkSurfaceKHR` and no window at all. So the coupling that
blocks VR is thin, exact, and worth cutting. D49: **SDL stays the platform layer and leaves the
device layer.**

**The Simulator plan is staged and honestly gated.** Everything is blocked on a game binding Vulkan
for OpenXR, which each game owns. S1 the game runs under the Simulator at all (Windows first — NOLF
says outright it has no macOS VR runtime). S2 record a capture by hand. S3 automated replay. S4 the
capture becomes a versioned fixture. S5 Operator on top, which is F46/F47 delivered with no headset.

**Two hazards taken from Meta's own page rather than discovered later.** The `session_capture` block
in `persistent_data.json` *persists* — a leftover block replays again on the next launch — so the
harness must acquire and restore that file on every exit path, the discipline the ctest gate lock
already uses; it is someone else's global mutable configuration and our boundaries forbid depending
on such a thing. And completion only *asks* the application to exit its OpenXR session: the runtime
cannot compel it, so an unhandled request hangs rather than fails, and whether either game honours it
is unverified and recorded as something to measure before a gate leans on it.

Rows: F120 the SDL-free device layer (R3, depends on F59) · F121 automated Simulator replay ·
F122 the capture as a versioned VR fixture behind a human verdict. New milestone H1; R3 extended.

Commands: `features.py validate` (74) · `graph` regenerated · `design.py check` · `./init.sh` ·
`npm test` 226/226.

Remaining: F120 is startable now and needs no game; F121 and F122 cannot start until a game binds
Vulkan, and no game has agreed to. The owner's sign-off on spec 111 is still outstanding.

## Session 82 (macos) — 2026-09-09 — steering the dev suite: three lanes researched, D46–D48, F113–F119

The owner asked to steer development across an agent lane and a testing lane, with a comprehensive
research pass behind it. Three Fable lanes ran in parallel; every load-bearing claim was re-verified
directly before it reached a spec, and two of them changed the plan.

**The task-to-test link already exists in our data and we throw it away.** Every `features.json` row
carries an `evidence` array naming the test and what it proves. `localRows`
(`orchestrator/server/tracker.mjs:104-116`) maps `acceptance_criteria` and **never maps `evidence`**,
so no surface in the workspace can answer what test backs a task — the field dies one function before
the UI. Same read found shipped drift: the schema claims the local provider goes "through
tools/features.py"; `tracker.mjs:94` reads the file directly and re-implements the readiness rule.

**An agent could drive a game today; only the tool is missing.** `surfaces.mjs:63-82` accepts input
from *any* authenticated `/surface` viewer, and the interposer turns it back into SDL events in the
game's own queue. The native pane is merely one such viewer. No MCP tool, route or CLI sends game
input. One constraint that shapes the design: taking focus **evicts** the previous owner, so an agent
would yank the pane from a person unless refused first.

**Headset-free VR automation is closed, and this is the negative worth the whole lane.** Meta XR
Simulator requires Vulkan/D3D/Metal and says outright that OpenGL and OpenGL ES are not supported —
fetched from Meta's own page, updated five days ago — and both games bind GL/GLES for OpenXR. So the
Simulator is out, its VRS Session Capture with it, and Operator-on-Simulator too. That kills a
plausible plan before anyone spent a month on it.

**Decisions.** D46 protocol before embedding: our agent layer is already protocol-shaped, and Claude
stays on PTY plus `/ide` because its SDK forbids third-party subscription login. D47 rEngine reads a
project's test evidence and never asserts it, but may *file* a verdict as a task through the
project's own write path — which is what the owner asked for beyond read-only, and it preserves D44
exactly. D48 flat harness first, with the graphics-API abstraction as the pack candidate that finally
gives D30 its consumer need.

**One correction to D48's premise, made rather than swallowed.** The owner's instinct that the
rendering abstraction is a pack candidate is right, but it is not a drop-in for a game's OpenXR
Vulkan binding: `render/draw_list.h` is 2D UI only, and `render/backend_vk.c` is SDL-window-bound
where OpenXR supplies its own swapchain. Adoption means extracting a device layer that does not exist
yet. Recorded in the spec so nobody plans on the shortcut.

Rows: F113 agent recipe registry (one table replacing four private ones) · F114 ACP session kind ·
F115 evidence on the task row · F116 contract-10 tests manifest, read never run · F117 flag a bad
test as a filed task · F118 game_input/game_frame/recording tools, closing KI-024 · F119 scenario as
evidence, never a boolean. New milestones T0 and H0; O2 extended. KI-071 (the IDE lock ignores
CLAUDE_CONFIG_DIR) and KI-072 (the Simulator is closed to both games) recorded.

Commands: `python3 tools/features.py validate` (71) · `graph` regenerated · `design.py check` ·
`./init.sh` · `npm test` 223/223.

Remaining: every row here is unimplemented and F113 is the one with no dependencies. The owner's
sign-off on spec 111 is still outstanding, and P05 (the model provider) stays deferred — which D46's
ordering is designed to keep true for as long as possible.

## Session 82 (macos) — 2026-09-09 — repair Codex word-wrapped file links and show hover cursor

The owner reported that the PV assembly link opens but the wrapped viewer screenshot
link creates a tab for only its first line, and hovering gives no cursor feedback.
Archived the supplied screenshot in `docs/evidence/chat-file-images/wrap-report.png`
and extended spec 113 before code. This continues the same owner-directed F37 slice;
F37 remains unpassed and the inventory stays 15/63 passing. The pinned editor checkout
was clean at `a31f234`; work was serial and game/iklib code is untouched.

The previous extraction only joined rows filled to the terminal edge. Codex inserts
its own newline before that edge and renders the target in parentheses. Row padding
is now trimmed without losing the clicked byte offset, and delimited target spans
normalize their presentation newlines/indentation. Ordinary hard breaks remain
separate. The native regression reproduced the exact `.../pv-` truncated tab before
the fix; now either row opens the complete PNG, including after resize and in
scrollback. Full-width terminal wrapping still resolves the same target.

The desktop owns one SDL system hand cursor and refreshes hover after drawing has
established the latest terminal cells and geometry. Hover uses the originating-root
validator without requiring Cmd/Ctrl; opening still requires the modifier. Ordinary
text, root-invalid references, menus, focus loss and replaced terminal text restore
the default cursor. The test observes SDL_GetCursor itself. Its initial missing-cursor
failure and a later deliberate default-cursor sabotage prove the observation is not
a desired-state flag. A separate newline-stop sabotage reproduces the truncated tab.
Both sabotages were restored byte-for-byte, the derived object removed and rebuilt.

Verification: final native build, CTest **10/10** (2.76 s), service **223/223** (19.42 s),
initialization/design/whitespace checks and four reviewed sidecars pass. Baseline
service launcher timing failed once, its isolated retry passed 2/2, then the final
complete service suite passed. The final 35-spec desktop run passes **69/69**,
zero skips, **226.62 s**, including all five image/link cases with the real NOLF PNG.
Its exact spec list and output are archived with the evidence. The previously
reproduced KI-071 renderer memory-budget test is excluded from this rerun and remains
open. No renderer or budget changes.

Evidence and limits: `docs/evidence/chat-file-images/README.md`, including the reported
layout and an inspected native screenshot of the two-line fixture and full hover hint.
SDL framebuffer capture omits the OS cursor; the real SDL cursor observation is its
gate. Hidden targets, native WebP, animation playback and Windows qualification remain
KI-070. The NOLF delivery uses a local pin and a desktop-only layered update, retaining
the existing agent process. Unrelated superproject files remain untouched.

## Session 81 (macos) — 2026-09-09 — chat file references open native image tabs

Owner direction from the attached NOLF conversation: open the generated PV-hand PNGs
from chat in editor tabs and add image viewing. This authorizes spec 113's bounded
native slice of F37; the broader desktop/Windows prerequisites remain blocked and
**F37 stays `passes: false`**. The inventory remains 15/63 passing. Work was serial
in NOLF's pinned `third_party/rengine` checkout, initially clean at `85d49a9`.

Cmd/Ctrl-click resolves visible terminal paths and displayed Markdown links against
the clicked session's original root, including scrollback and source locations.
The target appears on modifier hover; existing buffers are reused, and both mouse
press/release are consumed. PNG/APNG, JPEG and GIF now use native read-only image
tabs with dimensions, Fit/100%, Refresh, checkerboard transparency and wheel pan.
Authenticated image reads retain the filesystem boundary. Decoding repeats byte,
dimension and pixel limits; generation checks reject stale responses, refresh and
detach release old pixels, and hidden restored tabs wait until opened to decode.
The new upstream header is pristine at the existing stb pin, with its hash recorded.

Spec and failing image/pointer checks preceded implementation. The initial UI showed
raw bytes and did not open the displayed Markdown target. The final checks use actual
pointer input and exact fixture pixels in the image pane, not an opening-handler call.
Two roots with identical names, unrelated project focus, source caret position, tab
movement, desktop restart, errors/retry, source-file integrity and retained agent PID
are covered. Removing file dispatch, removing texture drawing and bypassing traversal
refusal each fail their intended regression; all three sabotages were restored and
byte-compared, affected objects removed, and the final build rerun.

The optional owner-image case ran with NOLF's 768×768 `pv_assembly_Reload_external.png`:
the terminal prints the path, a modified click opens it, and the real native snapshot
is saved and visually inspected in `docs/evidence/chat-file-images/pv-hands-viewer.png`.
All three focused acceptance cases pass. Six affected sidecars were reviewed,
re-anchored and stamped with the bundled tool; final indexed status is clean.

Verification: baseline build, 8 CTest checks and 223 service tests passed. Final build
has no new warnings; CTest **10/10** (2.55 s), service **223/223** (22.44 s), initialization,
design and whitespace checks pass. Full desktop acceptance with the owner image is
**67/68**, with no skips; the only failure is the existing renderer test's OpenGL RSS
delta (35,776 KiB against 32,768 KiB). Its isolated rerun also fails (33,712 KiB).
Pixel tolerances, frame-time budgets and Vulkan validation pass in both reports.
An isolated build of unchanged `85d49a9` fails the same check at **34,000 KiB**;
183 original source files were byte-checked against that commit. This establishes
the inherited failure (KI-071), not a green full suite. All three reports are saved
with the image evidence. No budget or renderer code was changed to pass it.

Remaining: KI-070 tracks WebP decoding, animated playback, hidden-target OSC-8 links
and Windows runtime evidence. Visible-cell parsing is not a shell cwd probe. Accepted
criteria were not rewritten; only evidence links were appended and the graph regenerated
(also restoring its previously missing F111 row). No game or iklib code changed.
## Session 81 (macos) — 2026-09-08 — a paste reaches the PTY whole (KI-070, F112)

The owner: *"copying large portions of text to our editor, the performance around it is terrible and
only a small portion of text is being copied"*. Two symptoms, one cause, and the cause was in the
path rather than in the amount of text.

**vterm calls the output callback once per character.** For a paste, for typed text, for every
wheel notch. That callback built a cJSON object, serialised it and queued **its own socket
message** — one per character. `RE_NET_QUEUE` is 128, `push` refuses past it, and nobody ever looked
at `re_socket_send`'s return value, so the tail of any paste over ~128 characters was freed and lost
without a word. The malloc-and-serialise per character is the slowness; the queue refusing at 128 is
the truncation. The same defect produced both complaints.

Measured before fixing: with the counters in and the batching out, a 31-byte burst reported **31
messages**. That is the RED, and it failed for its own reason rather than for something earlier.

**Now one event's bytes leave together.** `output` appends to a buffer, `flush_output` sends it, and
each public entry point runs its handler then flushes — the handlers became statics precisely so the
early returns inside them cannot skip the flush.

**The obvious fix would have been worse than the bug.** One message per event meets the session
host's `maxPayload: 2 * 1024 * 1024`, and `ws` *closes the connection* on an oversized frame — so a
big enough paste would have cost the session instead of the tail of the text. Chunked at 128 KiB,
which survives JSON escaping's worst case of six characters per byte, and split only on UTF-8
boundaries, because cJSON does not validate and half a sequence would travel into the PTY.

The chunk boundary is not reachable from the headless harness — it needs >128 KiB and a clipboard —
so it was verified directly instead, with the constant temporarily at 8: 26 bytes came out as
7+7+8+4 with lead bytes `0x61`, `0xc3`, `0xe4`, `0x69`, **not one chunk starting on a continuation
byte**. A naive split would have given 8+8+8+2 with two chunks cut mid-sequence. Constant restored.

Commands: native suite 8/8 · `npm test` 223/223 · `design.py check` clean · `features.py validate`
(64) · sidecar re-anchored and stamped — two entries had anchored to functions this change renamed
to statics, so they were re-anchored to where the code actually went rather than force-matched.

Remaining: a refused send is now *counted* (`re_terminal_inspect_output`) but still not surfaced to
the person who pasted, and silent loss is what kept this invisible. Separately, `editor.c:228` drops
the whole syntax line-state cache on every revision and rescans to the scroll position, so editing
far down a large file is costly — real, unrelated to this report, and left for its own slice.

## Session 80 (macos) — 2026-09-08 — poweredBy leaves the manifest: a bar, not a badge (D45)

Asked to sign the first adoption off and write `poweredBy` into NOLF's declaration, the owner
declined the premise: *"'poweredBy' is just an abstract no need to brand it"*. That is the answer to
the one question spec 110 left open, and it came with both conditions 110 set for itself already met
— the first adoption is real and measured, and its sign-off record is written, so the duplication had
stopped being theoretical. The adoption was about to be stated in two places and the second one was
being asked for.

**D45: the key is removed; an adoption is recorded, never claimed.** D24's bar is untouched — a
pinned curated capability with passing game integration checks is still what powered-by means — and
so is D44b's sign-off. What goes is the idea that a project *announces* having met it. A declaration
says what a project consumes: a pack, its pin, its facets. This revises D44 in exactly one clause,
annotated in place rather than rewritten, because a decision table that edits its own history is
worth less than one that shows what it withdrew.

**Nothing anywhere declares a `packs` block yet** — checked across NOLF, VtMB and Kohai's external
declaration — so contract 9 being hours old made this the cheapest hour the removal will ever cost.
Keeping the key and meaning nothing by it was rejected as the worst of the three options: a claim
with no reader and no refuser.

**The refusal names its successor.** Both layers report through `packsError`, joined: the schema
says the key is unknown, and the rule says it was removed and that the record lives in a spec signed
by the owner. Sabotage S3 is the one that earns the rule its place — delete it and the document is
*still refused*, so a test asking only "is it refused" stays green while the person reading the error
learns nothing.

RED first for its own reason: with D24's old condition in place the new case reported *"onLibrary: no
refusal was reported at all; the declaration was accepted"* — the library facet accepting the key,
which is the exact behaviour D45 removes. Three sabotages, each applied, run, restored and
byte-compared: the old facet condition fails the library case alone; truth-instead-of-presence fails
`poweredBy: false` alone; deleting the named rule fails on the message.

F109 keeps its criteria **exactly as written**, including criterion 5 describing the refusal that no
longer exists. It records what was true when it passed; F111 records the supersession. Editing it
would erase the fact that the key ever shipped.

Commands: `npm test` 223/223 · `./init.sh` clean · `python3 tools/features.py validate` (63 features)
· `python3 tools/design.py check` clean · `node --test orchestrator/tests/packs.test.mjs` 4/4 · five of
`formats.mjs`'s six sidecar anchors drifted +2 by the edit and were relocated by snippet, each found
uniquely; the sixth sits above the change and did not move.

Remaining: the owner's sign-off on spec 111, which is now the only outstanding step of the first
adoption; a rEngine-side check that a declared pack revision matches the submodule; VtMB as D09's
second game.

## Session 79 (macos) — 2026-09-08 — the first adoption measured: iklib carries NOLF's arm

The adoption spec 111 stopped at the seam is now done in the host's own repository, and it came back
with numbers rather than an assurance. Over **20 240 scenes** — iklib's own 240-record generator plus
a 20 000-scene sweep across reach, side, roll gain, twist and clavicle presence — the hand-rolled
solve and `ikRetargetArmLithTech` agree to a worst **2.7e-5 LT (0.42 µm)** in position and **2.7e-5**
in a quaternion component (0.003°), with zero disagreements in entry count or node index. NOLF's full
suite is **487/487 in 747.57 s**, one test more than before, and the one added is the equivalence
test. `vr_body_solve.h` goes 456 → 204 lines; the deleted solve is kept verbatim inside the test as
its oracle, which is the only way an equivalence claim means anything.

**One functional disagreement, and it was recorded rather than tuned away.** On an exactly
antiparallel shortest-arc input — within ~0.08° — the two libraries pick different 180° axes, so the
bone points the same way but its roll can differ by up to 180°. No random scene reached the branch; a
constructed one pins it. iklib already records it as a deliberate delta. The instruction was *do not
tune constants until the tests go green; if the poses differ, the finding is that they differ* — and
that is what came back.

**Two of this spec's open items were answered by being wrong.** The `playerReach`/`rollGain`/
`twistFollow` question assumed NOLF passed none of them: it already passes all three, from both
production call sites, and the seam matched the preset parameter for parameter. And the recursive
bootstrap shipped in `6e88a5c` does **not** repair existing checkouts — NOLF's rEngine pin was
`562b195`, which predates `.gitmodules` existing at all, so no `--recursive` could have fetched
iklib. The pin has to be bumped first; the recursion is the second step. The scaffold change stands
for projects connected from here on.

**The outstanding check is written, on the consumer side — and I ran both of its refusals rather
than reading them.** `cmake/iklib.cmake` holds the pin as a literal and fails the configure when the
tree it points at is a git checkout whose HEAD is not that revision. Pointed at a clone one commit
off the pin it exits 1 naming both revisions; pointed at a missing path it exits 1 naming the
recursive command an existing checkout needs. I had already asserted this behaviour in a pushed
commit having only read the source, which is the thing this repository's own rule warns about.
rEngine still has no check that a *declared* pack revision matches, so the gap is narrower rather
than closed.

Spec 111 now carries all of this, plus the D44b sign-off record with every slot filled but the
owner's own words — which is the one slot no agent gets to fill.

NOLF landed it in five commits on `f1706-iklib-arm-retarget`, unpushed and in workflow order:
`35a1b501` pin · `fe984103` spec · `57767968` test · `0c024625` feat · `31985f7d` docs. Its F1706 is
deliberately `passes: false` — the location criterion is settled, the D44 sign-off is not.

Commands: `python3 tools/features.py validate` (62 features, clean) · `python3 tools/design.py check`
(clean) · NOLF `ctest --output-on-failure` 487/487 in 747.57 s, exit 0 · two `cmake -S . -B <scratch>`
runs against a wrong-pin clone and a missing path, both exit 1.

Remaining: the owner's sign-off and `poweredBy` in NOLF's declaration; a rEngine-side check that a
declared pack revision matches the submodule; VtMB as D09's second game.

## Session 78 (macos) — 2026-09-08 — rEdit is the name again, and the iklib seam read from both sides

**The contradiction is gone.** F110 retired "rEdit" this morning and its guard fails the build on a
retired name; D42 revised made rEdit the entertainment editor's name again, so the tree was rejecting
a correct name. `product.name` is now `rEdit` — the fallback a workspace wears when no edition
declares otherwise, and this repository is the entertainment stream — and `product.family` is `Red`,
the word rEdit produced and the business edition wears as RED Suite. `suite` is gone, because an
edition's brand belongs in the edition manifest rather than in a global constant naming one edition.
`retired` is empty and that is correct: nothing is actually gone.

The guard's decoy pointed at `retired[0]`, which no longer exists, so it now uses the live name as a
string and the family as a regex — testing more than it did, since a regex is not a string and that
is what the guard missed when it was first written. `native-identity` says it out loud: *"the
workspace wears the project name, and rEdit when none is declared."*

**Then the iklib seam, read rather than assumed (spec 111).** Two guesses died on contact. The CMake
target is `iklib`, not the `iklib::ik` spec 107's illustration invented; and iklib carries no tags and
no version, so F109's *spoken* half of the pin has nothing to say yet — recorded as a placeholder
derived from the revision rather than inventing a `0.4.0`.

I also nearly got this badly wrong. Grepping for `SolveTwoBoneIk` found only test call sites and I was
one sentence from writing "no production consumer"; checking which files include `vr/vr_ik.h` found
`src/engine/vr_body_solve.h:236`, the real one. The lesson is the ordinary one: the symbol grep
answered a narrower question than the one I was asking.

**The finding that changes the shape of the work.** iklib already ships
`integrations/lithtech/ik_lithtech.h` — `ikFrameLithTech()`, `ikConfigLithTech()` and a
`ikRetargetArmLithTech(...)` template over *the host's own* node, arm and override types. Its header
cites `~/nolf-improved/CLAUDE.md:87` for the unit scale, and that line says exactly what the preset
claims: X=Right, Y=Up, Z=Forward, ~1 LT unit ≈ 1.5625 cm. Verified today. So the frame and unit
contract spec 001 demanded be declared before migration is already declared, by the library, against
this host — and NOLF's hand-rolled block is doing by hand what `ikSolveArm` does, over a node array,
an arm chain and an absolute-override output it already has.

Nothing was changed in `~/iklib` or `~/nolf-improved`. The migration belongs in the host's repo under
its own workflow, because a local task cannot mark another project's feature done, and what is *not*
established is written down: whether the two implementations produce the same pose, and which of
`playerReach`, `rollGain`, `twistFollow` and the abort thresholds map to NOLF values rather than
being new behaviour that must be defaulted.

Gates: `npm test` 223/223, `design.py check`, `./init.sh`, and the identity and IDE-selection desktop
specs green.

## Session 77 (macos) — 2026-09-08 — The four open questions, and the name that had to change back (specs 109–110, D42 revised, D44)

**The naming resolved by a collision, not by taste.** The editor's name is per-edition: entertainment
is **rEngine** with the editor **rEdit**; business is **RED Suite** with the editor **red**. The owner's
reason is the whole argument — *"we had a CD Project Red studio with similar naming"*. In a games
context "Red" borrows CD Projekt Red's identity; in a business context it does not. So one binary
still, but the name it wears comes from the edition.

That revises D42 as written this morning and revises D41 again, and it leaves a contradiction sitting
in the tree right now: F110 shipped `product.retired: ["rEdit"]` with a guard that fails the build on
a retired name, and I verified it — writing `"rEdit"` into any shipping file makes `design.py check`
exit 1 naming it. rEdit is a live name again, so the guard currently rejects a correct one. F110's
mechanism survives untouched; what it holds becomes edition-supplied and `rEdit` leaves the list.
Recorded as the first implementation task rather than fixed here, because the spec comes first.

**The other three.** The manifest is written by an install action in the suite (`install-edition.sh`,
the shape `restart-supervisor.sh` and `integrate-project.sh` already use) rather than waiting on
packaging, which KI-008 still holds open. A workspace holding both streams does nothing special — the
install's brand wins, and refusing to bind would stop the owner working across their own projects in
one window. And the pack lists were answered from the inventory rather than invented: entertainment
has three unfinished candidates (the renderer at F61, D33's owned controls, iklib), business has none
yet, and an edition naming zero packs is legitimate because it still carries a brand and a layout.

**Library adoption (spec 110, D44)** answers the half of KI-003 that had been open since the first
day. The declaration already existed — F109 shipped `library` facets, a two-part pin and `poweredBy`
this morning — so what was missing was never the manifest but *who holds the evidence and what counts
as evidence*. The adopting project holds it, because `AGENTS.md` already says a local task cannot mark
another project's feature done and a curator recording "VtMB passed" would be doing exactly that.

**The recommendation that lost, and why it deserved to.** I recommended a declared check command under
the boundary that already runs previews and language servers, for reproducibility. The owner chose an
owner's sign-off recorded in a spec, and the honest reading is that it is more truthful about who
decides: a green command proves a command went green, and D24's bar — a curated capability actually
carrying a game — is a judgement. Two costs are written down rather than left to be found: it does not
scale past projects the owner personally watches, and a sign-off that does not name the checked
revision is worthless once the pin moves.

Nothing implemented. Specs 109 and 110 are the artifacts; the build order is the owner's.

## Session 76 (macos) — 2026-09-08 — The two streams, and what they cost (spec 109, D42–D43)

The owner named the split — business **RED Suite** on Kohai (`~/hirebase-v2`), entertainment
**rEngine** on `~/nolf-improved` and `~/vtmb-vr` — and the declarations turn out to have been saying
it already. Measured before asking anything: Kohai declares title, icon, **wordmark**, formats,
dashboard and tracker and **no `games`**, from an **external** declaration under
`~/.local/share/redit/` because Kohai is not ours to put files in; both game projects declare `games`
from inside their own checkouts and neither declares a wordmark. The edition line falls exactly where
the declarations already differ, which is the opposite of a marketing overlay on identical installs.

**D42** settles a naming question that D41 had left ambiguous the moment a second stream existed: Red
is the *product*, the editions are the *brands*. "Red Suite" is not an umbrella over both — it is the
business edition's brand, and rEngine becomes the entertainment edition's. **D43** puts the edition
manifest in the workspace state directory: it spans projects so no project can own it, and an install
has to be able to differ from the checkout or a business customer receives the entertainment manifest
in their tree. It lands beside the external declaration and the Linear token that Kohai's workspace
already keeps there.

**The recommendation that lost.** I recommended an edition vary packs and branding only, so that one
contract means one thing everywhere. The owner added the **default layout of a fresh workspace**, and
the reason it deserved to lose is first-run experience: two editions that open identically are not
two products to the person opening them. What did not change is which declaration blocks exist — a
contract still means the same thing in every install.

**A cost named rather than discovered.** F110 shipped `PRODUCT_SUITE` this morning, generated and
deliberately unconsumed, with that lane writing that editions would be its first consumer. They are,
and D42 changes what it means: `"Red Suite"` is one edition's brand, not the umbrella, so a global
constant holding it would make the entertainment build ship the business name. The brand moves into
the edition manifest and `product.suite` is removed rather than quietly redefined;
`product-name.test.mjs` asserts it today, so the removal is a visible edit rather than drift.

Also recorded: an edition's layout is what a *fresh* workspace starts with and never an override, or
an implementation would silently undo arranged panes on every start. Four open questions are named
and left open, including what happens to a workspace holding projects from both streams — today's
rEngine workspace binds three roots and a person could add Kohai to it.

Nothing implemented. The spec is the artifact; the build order is the owner's.

## Session 73 (macos) — 2026-09-07 — The pack manifest: contract 9 packs and its facets (spec 107, F109)

D39 implemented rather than reconsidered. A pack is one pinned, versioned artifact whose facets say
how it is consumed: a `library` facet is source and a CMake target a game consumes at build time, a
`plugin` facet is a module the editor loads at run time, and one pack may declare both — the renderer
(D30) is expected to. The eleventh declaration block, added the same way the other ten were: a schema
block, a `SECTIONS` entry with `minimum: 9`, and a rules function.

**The pin, which was the part with a choice in it.** A pin is two strings that are not
interchangeable: a `version` that is said and a `revision` that is checked. A version alone is a claim
rather than a pin — tags move, and two machines that both say `0.4.0` can hold different bytes, so an
integration check passed against one says nothing about another; spec 001 already asked for "an
immutable pin". A revision alone cannot be spoken, and D24's powered-by record and D40's editions both
quote a version in prose. So both, with the revision constrained to 40 or 64 lowercase hex characters
— a git SHA-1 or SHA-256 object id, or a content digest — and `main`, `v0.4.0`, `HEAD`, a short prefix
and an uppercase digest each refused by name. Rejected: a bare version string, a `{ url, ref }`
locator (that is acquisition, and a URL in a manifest is a download waiting for a reader), a lockfile
beside the declaration, and a digest alone.

**D24 made checkable rather than restated.** `poweredBy: true` on a pack is refused without a
`library` facet: `$.packs[0] (red-inspector).poweredBy is earned by a library facet; an editor plugin
does not earn it`. What the key asserts is bounded and the spec says so — it names the pack the claim
rests on, and asserts nothing about the game integration checks, whose evidence is F21/F29.

**Acquisition is absent by construction, not by omission.** KI-008 is open and the boundary forbids
hidden downloads, so the block carries no URL, no registry and no fetch step; the reader opens neither
`library.path` nor `plugin.module` and never compares a revision against bytes. A pack that has not
been fetched is a missing prerequisite, not a malformed declaration. `plugin.abi` is shape-checked and
never parsed, ordered or compared: its meaning belongs to the parallel plugin-ABI lane.

**Sabotage, which is the point.** Fourteen breaks, one at a time, each restored; the table is
`docs/evidence/pack-manifest-2026-09-07.md`. The row worth keeping is **S9**: inverting D24 so
`poweredBy` required a `plugin` facet instead of a `library` one is a one-word edit that leaves every
structural check green and every document valid, and it was caught not by a refusal test but by the
acceptance one — `iklib`, a library-facet pack with `poweredBy: true`, stopped being accepted. A suite
that only tested the refusal would have gone green on an implementation with the decision exactly
backwards. Recorded there too: five rows fail as `assert.match(undefined, …)`, which is red for its own
reason (the refusal did not happen at all) but reports as an argument-type error, and S6 fails on the
regex rather than on a missing message because the structural `has unknown key target` is still there
— which is exactly why the by-name rule sits on top of it.

Commands: `./init.sh` (60 features), `npm test` (217 tests, 217 pass, 0 fail; 213 before, +4 from
`orchestrator/tests/packs.test.mjs`), `python3 tools/features.py validate`, `python3 tools/design.py
check`, and the sidecar repair/stamp/check cycle on `--index .cache/sidecars-packs.sqlite` because
another agent is active. `orchestrator/tests/task-writes.test.mjs`'s deliberate contract-ceiling
tripwire was raised to 9 with its comment kept and a line added confirming contract 6's own keys still
read as they did.

Three things I think D39 will cost, implemented as decided and written down in spec 107's last
section rather than argued here: one pin over two facets forces the renderer's library consumers to
re-pin for plugin-only changes; `poweredBy` in a declaration is a claim's subject that will read to
somebody as the claim itself; and a facet says a role but not a direction, so `rengine-render` in
rEngine's own declaration and `iklib` in a game's are identical rows with opposite meanings — which
D40's cross-project editions will have to fix.

Remaining: no loader, no build integration, no edition, and no acquisition. F109 is scoped to the
manifest and claims nothing else. Spec 105's four open questions are all still open.
## Session 74 (macos) — 2026-09-07 — The product is Red, and the name is generated (F110, spec 108)

D41's second half was the engineering: *"the name stops being hard-coded … so the rename is a data
edit and the next one is too."* The rename itself was four strings. The work was making a fifth one
impossible.

**One declaration, two generated outputs.** `orchestrator/native/theme.json` gains a `product` block
(`name`, `suite`, `retired`), validated by `tools/design.py` beside the theme tokens. `generate`
writes `RE_PRODUCT_NAME` / `RE_PRODUCT_SUITE` into `theme.h` — already included everywhere through
`common.h`, so `app.h` reduces to `#define RE_DEFAULT_TITLE RE_PRODUCT_NAME` — and
`orchestrator/runtime/product.mjs` for the JS side. A generated module rather than reading the JSON
at run time, because `orchestrator/runtime/` is the replaceable layer (spec 101) and would otherwise
depend on a path in the desktop's build inputs; content cannot be half-read, and there is no fallback
string to go stale. `check` compares both, so a hand-edited generated file is refused like every
other one.

**The four consumers now read it**, and are asserted against what they actually answer rather than
against their source: the `/ide` lock publishes `ideName: "Red"`, a language server is sent
`clientInfo.name` (read off the bytes by a recorder server), the tracker callback serves
`<title>Red</title>` from a real loopback request, and `native-identity.spec.mjs` drives a live
window for the chrome and OS window title. `ide-connect.mjs` needed no edit — it already compares a
lock's `ideName` against the imported `IDE_NAME` — but its fixtures did: they published the literal
old word, so they would have kept passing while auto-connect (F103) stopped recognising our own
editor. That is the failure this rename could actually have shipped.

**The guard.** `design.py check` now fails when the product name — current *or* retired — appears in
shipping code (`orchestrator/`, `tools/`, `adapters/`, `scripts/`), and `design.py product [PATH]`
runs the same scan alone so the npm suite can assert it without inheriting another lane's colour
literal. Comments are exempt on purpose: prose naming the product is not hard-coding it, and a file
has to be able to say what it is. Allowed: the declaration, the two generated files, and
`product-name.test.mjs`, which holds the one deliberate `'Red'` — `IDE_NAME` is published into other
people's `/ide` menus, so a rename should have to change a line that says so out loud.

**Written first as string-literals-only, which was wrong.** It found 21 hand-written names and walked
straight past `assert.match(state.windowTitle, /^rEdit\b/, …)` — a regular expression is not a string.
It now scans everything that is not a comment, and the automated decoy has both forms plus a comment
that must *not* fire, so the guard cannot pass for the wrong reason.

**Sabotage** (`docs/evidence/product-name-2026-09-07.md`): current name typed back in → guard names
`ide.mjs:23`; retired name in C → names `app.h:85`; hand-edited `theme.h` and hand-edited
`product.mjs` → stale, and the test that catches the second one is the canary, because with a renamed
module every consumer test still passed happily saying "Rouge"; declaration changed without
regenerating → both outputs stale; module deleted → `ERR_MODULE_NOT_FOUND` at import in all three JS
consumers; macro deleted → `use of undeclared identifier 'RE_PRODUCT_NAME'`, build fails. Two
controls: a comment naming the product, and `'Redirected … red Redis … prepared'`, both silent.

**Gates**: `./init.sh`, `npm test` (219 pass), `npm run build`, `python3 tools/design.py check`,
`python3 tools/features.py validate`, `native-ide-selection.spec.mjs` (1 pass) and
`native-identity.spec.mjs` (5 pass). Sidecar anchors in `ide.mjs` and `lsp.mjs` repaired, reviewed
and stamped on a private index.

**Deliberately not renamed**: `rEngine` — the project that builds Red keeps its name; `Codex-progress`
entries, `docs/evidence/**` and earlier `features.json` rows, which are dated records; charter D36's
own wording, because a decision that silently agrees with the successor revising it destroys the
record of there having been a change (specs 084 and 102 carry a revision note above their unchanged
decision rows instead). **Left hard-coded**: the default brand glyph, still `"r"` in `app.c:180` —
that file belongs to another lane this session, and a glyph is spec 084's declared mark rather than
the name. A follow-up should make it product data (`"R"`) or derive it from the declared name.
## Session 75 (macos) — 2026-09-07 — The plugin ABI: a real module in a real window (spec 106, F108)

Charter D38 said an extension is an in-process native plugin that draws through the draw list and
registers through the owned layer, and spec 105 left two questions for the implementation spec:
how the ABI itself is versioned, and what happens on Windows. Spec 106 answers both and the code
under it loads a real module — built by the desktop build from
`orchestrator/native/tests/plugins/` — into a running window, where its tab appears in the layout
and its magenta is read back out of a snapshot.

**The ABI is versioned separately from the draw list, and a plugin declares both.**
`RE_PLUGIN_ABI_VERSION` moves when a struct in `plugin_abi.h` changes shape; `RE_DRAW_LIST_VERSION`
moves when a primitive is added; they move for different reasons at different times. The desktop
accepts a plugin only when the ABI matches exactly and the draw list is *not newer* than its own,
which is spec 067's additive rule read from the producer's side. The entry point
(`re_plugin_entry`, returning static storage and doing nothing else) and the first two descriptor
fields are frozen for every future version, so the loader reads them from any module before
deciding — a plugin built against a desktop that does not exist yet is refused by name, not
crashed. Everything a plugin may call arrives by pointer in one host table: a module has no
undefined references, which is what makes the same source a dylib, an .so and a DLL, and makes
"what a plugin may do" the contents of one struct. In v1 that is: register up to eight tabs during
`start`; append rect, rrect, frame, shadow, ring, text, icon and gradient to the frame of a
visible tab; clip within its own area (a wider clip is intersected, and the frame resets the clip
whatever the plugin did); measure text through the desktop's faces; read a theme colour by token
name. No textures, no input, no controls, nothing that reaches the store, a session or the host.

**The one tension in D38 as written, implemented as decided and recorded.** D38 says plugins
register "tabs and controls" through the owned layer while microui's context stays private. The
tab strip *is* the owned layer, so tabs go through it. The owned controls, by D33's own design,
take `mu_Context *` first so they interleave with microui's — handing them to a plugin hands it
the context D38 forbids. Controls therefore wait for a handle that is not `mu_Context`, a later
ABI version's work; spec 106 decision 8 says so rather than widening v1.

**What the declaring lane gets.** `re_app_plugin_load(app, name, path, abi)` with `abi` exactly
`re-plugin/1` and `path` absolute — a bare name would consult the dynamic loader's search paths,
which is a hidden-download-adjacent behaviour, and a relative one depends on whoever launched the
window, so both are refused before `dlopen`. Loading is idempotent by name because the workspace
state that will carry declarations arrives repeatedly. Until that lane lands, the explicitly
enabled automation channel's `plugin` op is the only door, the way `scene` is.

**Twenty sabotages, and the one that stayed green.** Fourteen against the registry (CTest
`native_plugin`, real `dlopen` of seven real modules, the refused variants `abort()` in `start` so
"never called" is the process surviving) and six against the window spec. P6 — the desktop's text
measurer returning 0 — passed first time: the spec looked for cyan anywhere in the right 120px,
and a zero width still put the first glyph there before the clip took the rest. The registry-side
check was red because it asserts the x coordinate exactly; the pixel check was looking too loosely.
It now asserts ink in the label's body and none in the final 8px strip, is red under the sabotage
and green restored. Table and reasons in `docs/evidence/plugin-abi-2026-09-07.md`.

**Gates.** `npm run build` (cmkr regenerated `CMakeLists.txt` from the TOML; seven fixture modules
under `.cache/desktop/plugins/`), CTest 8/8 including `native_plugin`, `npm test` **213 pass, 0
fail**, `native-plugin.spec.mjs` 2/2 (added to `test:desktop`; `native.spec.mjs` and
`native-dashboard.spec.mjs` re-run beside it as the tab-model neighbours), `python3 tools/features.py
validate`, `python3 tools/design.py check`, `./init.sh`. Sidecars of `app.c`, `workspace.c`,
`automation.c` and `draw.c` re-anchored, the automation note amended for the one command with a
side effect, stamped and checked on `.cache/sidecars-plugin-abi.sqlite`.

Files: `orchestrator/native/plugin_abi.h`, `plugin.{c,h}`, `pluginview.{c,h}`,
`tests/plugin_test.c`, `tests/plugins/{fixture,blank}_plugin.c`, `orchestrator/tests/native-plugin.spec.mjs`,
`cmake.toml` (+ generated `CMakeLists.txt`), `package.json`; four lines in `app.c`, three in
`app.h`, five in `workspace.c` (already past the 1,000-line rule before this lane; not made worse
by more than that), eight in `automation.c`, two in `draw.{c,h}`. Inventory: **F108** added,
`passes: false` — every criterion is met on macOS and the Windows criterion is explicitly NOT MET
(construction only; KI-038 outstanding). Graph regenerated.

**Remaining.** The declaration block (another lane) calling `re_app_plugin_load`; a Windows load
once KI-038 is repaired; a way to reopen a closed plugin tab (v1 reopens on load and has no menu);
a plugin-facing control surface without `mu_Context`; textures and input. Spec 105's open
questions 1 and 4 are answered by spec 106 and 105 was left untouched — a cross-reference there is
for whoever next edits it. Recommendation for the design lane, recorded in spec 106 decision 15:
`icons.json` is append-only from here, because a plugin freezes today's `RE_ICON_*` numbering.

## Session 72 (macos) — 2026-09-07 — Packs, plugins, editions and the name (spec 105, D38–D41)

A design interview, not an implementation. The owner opened the extension-system question and the
rename in the same breath; `/grill-me` ran in three rounds and spec 105 is the artifact.

**What the codebase answered so the owner did not have to.** Extensions already exist declaratively —
ten blocks across contracts 1–8, each added the same way, executable parts as declared commands. The
draw list is already `RE_DRAW_LIST_VERSION 2`, backend-neutral across four adapters: the ABI a plugin
needs exists. The desktop is already a layer whose loss is survivable, proven the same day when a
supervisor restart took the window and left 13 sessions running. And "library packs" is the owner's
own phrase from D33 — so answering "one concept, one word" continued a decision rather than starting
one, which neither of us had noticed when the question was asked.

**The recommendation that lost, recorded because that is the useful part.** Declared-commands-only
was recommended for extensions: no new trust, no ABI, and it is how every capability this week
arrived. The owner chose **in-process native plugins**, and the reason the recommendation deserved to
lose is capability — an extension that cannot draw is not an extension. The cost was then taken
deliberately rather than discovered: a plugin fault costs the window and its layout and never a
session, which is only true because sessions live on the retained host. That makes plugin access to
store, session or host state *outside* the grant, and spec 105 says a later spec wanting to widen it
must argue against that paragraph.

**D38–D41**: extensions are in-process plugins drawing through the draw list and registering through
the owned control layer, declared by the project; a pack is one pinned artifact with `library` and
`plugin` facets; an edition is a declared bundle of packs over one binary, never a fork; the product
is **Red**, the umbrella **Red Suite**, revising D36 — and the name becomes a generated token rather
than four hard-coded strings, so this rename is a data edit and the next one is too. D24 is clarified
rather than redefined: "Powered by" is defined on the library facet, so an editor plugin does not
earn it.

Four open questions are named and left open: the plugin ABI's own versioning, where a pack's bytes
come from (KI-008 still holds), what a business edition actually contains, and what plugins do on
Windows while KI-038 is outstanding.

No inventory rows and no rename yet: the work protocol puts the spec first, and the implementation
order is the owner's next call.

## Session 72 (macos) — 2026-09-07 — The spawned pane that resumed its spawner (KI-068)

The first `spawn_agent` of spec 103 worked in every respect except the one that mattered: the pane it
started came up on the spec 097 conversation picker, blocked on stdin, took a stray `1` — clicking
into a pane is enough — and **resumed the conversation of the agent that had spawned it**, in a second
process. The next pane sat on its prompt for an hour until Enter arrived through `/api/input`. Both
features were behaving as written; the defect is that neither knew about the other.

**The rule spec 097 decision 5 states is one step narrower than the rule it means.** It asks *has this
launch already chosen?* and answers with the only signal that existed at the time, an explicit resume.
Spec 103 then invented a second kind of launch that has chosen — a pane started on a task, with its
prompt already rendered into the CLI's initial argument — and nothing about it sets
`RENGINE_AGENT_RESUME`. The offer belongs to an interactive **bare** launch; that is now the wording,
in three layers, deliberately redundant because a listing can reach a pane from a stale environment as
well as from this host, and the host can be older than the worker spawning through it.

**A second defect of the same shape turned up on the way, and it is the more interesting one.**
`Sessions.spawnTerminal` clears the pane-identity family by passing `undefined` overrides to
`shellEnvironment()` — and then composes the child's environment with a *second* `shellEnvironment()`
call, which starts from `process.env` again and inherits every one of them straight back. A session
host running inside an agent pane therefore handed each pane it spawned that host's **own**
conversation, resume flag and offered listing. On `origin/main`, run from such a pane, that turns
spec 103's own spawn test red: the leaked `RENGINE_AGENT_RESUME=1` makes the launcher choose
`--resume` over `--session-id`, which is a spawn continuing somebody else's conversation, by the same
mechanism as the live failure and from the opposite direction. Four `conversation-picker` tests were
red there too, for a fixture reason (KI-031's shape) that is also fixed: the suite now means the same
thing run from a workspace pane as from a bare shell.

Four new tests, each observed red for its own reason first, and six sabotages including two controls
(the guard suppressing the offer for everybody — which is decision 5's original mistake seen from the
other side — and the launcher never asking at all). `npm test`: **213 pass, 0 fail**, 11.5 s. The
first run in a fresh worktree showed three unrelated timeouts while `headless.test.mjs` built the
desktop for 45 s from a cold cache; isolated and warm re-runs are green, and that is recorded rather
than quietly re-run.

Branch `fix/spawn-no-picker` (`aeb5430` + docs), pushed, not merged. Files:
`scripts/agent.sh`, `orchestrator/server/sessions.mjs`, `orchestrator/runtime/worker.mjs`, tests in
`conversation-picker`/`sessions`/`task-writes`, sidecars refreshed and stamped for the three sources
(one pre-existing broken anchor in `sessions.mjs._llm.json` repaired on the way).
Evidence: `docs/evidence/spawn-no-picker-2026-09-07.md`. Specs 097 and 103 amended; KI-068 filed
resolved.

**Remaining:** the live proof. This is not merged, and the workspace that produced the defect still
runs the host and worker that have it. `scripts/agent.sh` fixes it for a running workspace with no
replacement at all, which is why the branch is worth taking before the host is; the worker half wants
an `update_workspace`, the host half a `--replace-host`. The first workspace started from this change
should record a `spawn_agent` whose pane comes up on its own conversation with its prompt and no
picker in it.

## Session 71 (macos) — 2026-09-07 — Auto-connect, and the check that does not fire (F103)

A Claude pane now connects to the editor it runs inside without anyone typing `/ide` — when exactly
one editor is published for its working directory, which is the CLI's own rule and turns out to
matter far more than expected.

**The rule was measured, and the reasoning it replaced was wrong.** The CLI's discovery code filters
on `workspaceFolders` against the cwd *and* on the lock's pid being one of the CLI's first ten
ancestors. Reading it, ancestry looks like the thing that disambiguates two workspaces publishing the
same folder. Four locks were published over `/Users/alex/rengine` and a real CLI was driven with
`/ide`: **all four were listed**, including hirebase-v2's, whose host is nobody's ancestor here. The
only filter that fired was folders-against-cwd, and the locks it excluded said so in as many words.
So the ancestry gate is conditional on something not true in a real pane, and this counts the way the
CLI was observed to count rather than the way its source reads. If a future version starts applying
ancestry this becomes conservative, which is the safe direction: a pane that does not auto-connect is
one `/ide` away, and a pane that auto-connects into a four-item menu is a question nobody asked.

That also makes the overlapping-folder case concrete rather than hypothetical — it is this machine
today, and `--ide` would decline. The criterion added when a peer mentioned the vtmb-vr host was
right for a reason neither of us had checked.

**A criterion of my own was wrong and is corrected in the row.** F103 said this could only reach a
running workspace by replacing its session host, on the KI-043 reasoning that the launch environment
is host-composed. The host spawns `scripts/agent.sh`, which execs `agents/launch.mjs` **from the
checkout at every pane launch** — so the decision is made in the pane by code read from disk, and it
reaches a running workspace with no host replacement and no layered update at all.

Four sabotages, each red for its own assertion. C2 — containment as a bare prefix — passed first
time, because the fixture asserted the direction a bare prefix also gets right; querying from inside
`/work/rengine` never confuses it with `/work/rengine-old`. Querying from the sibling does, and that
is what the test asserts now. Second time this session a sabotage has exposed a test that did not
test what its name claimed.

**Counting was the wrong rule, and the machine said so within a minute.** `--ide` auto-connects only
when exactly one editor is valid, so the first implementation declined on `/Users/alex/rengine` —
correctly and uselessly, because hirebase-v2's workspace binds that folder too. The CLI has a second
path in the same function: a lock whose port equals `CLAUDE_CODE_SSE_PORT` is valid regardless, and
the selection then returns that editor alone. So the question is *which editor is this pane's*, and
ancestry answers it with no cooperation from anyone: the session host forks every pane, so its pid is
in the chain above `launch.mjs`. Live, the chain resolved as `46159, 92680, 92674, 33465` and the
launch composed `--ide` with `CLAUDE_CODE_SSE_PORT=65353` for both roots.

An earlier attempt asked the host for its own pid on `/api/state` and got `undefined` — that field is
newer than host 33465, and a host is precisely the thing that does not get replaced. Two more
sabotages: the flag passed without naming an editor, and any published rEdit treated as ours (it
named the wrong port).

**And then a pane was opened.** It came up connected with no slash command; its `/ide` menu, opened
afterwards to look, put the check mark on this workspace's editor with hirebase-v2's offered beside
it and not chosen, and `ide-selection` reported `delivered: 2` — the existing pane and the new one.
The case counting could not serve is the case it now serves.

Gates: `npm test` 209/209, `./init.sh` and `features.py validate` clean, sidecars stamped. Every F103
criterion is met; the row stays `passes: false` because F99 is not verified and the inventory refuses
a passing row above it. One thing left for the owner: the row's *description* still says "when
exactly one rEdit is published for that root", which was the first rule and is now only the fallback.
Criterion 4 carries the corrected rule and the reason, so the record is right; changing an accepted
description is the owner's call rather than mine.

## Session 70 (macos) — 2026-09-07 — The restart, run for real, and the two bugs only running it found

Supervisor 44390 → **57193**, worker → 57195, desktop → 57227 with all 13 sessions, session host
33465 never signalled, and the IDE lock now at a port the descriptor keeps (`idePort: 65353`) rather
than a new one every update. Everything that had been stranded behind the supervisor arrived at once:
`ide: 1`, the LSP client, the diagnostics underlines, `To agent`.

**Two defects surfaced by using the thing rather than by testing it.**

The action's own wrapper was broken. The wizard imported the tool and passed its path as `argv[1]`,
so the module's entry-point check fired and printed usage instead of reading the workspace. It failed
safely at stage one with nothing signalled — but no unit test had that shape, because every test
called the exported functions directly. The tool now has a `--plan` mode and the action invokes it as
a program: one entry point rather than a caller that can impersonate it, with a regression that
drives the command line the way the action does.

And `since` absent was read as `since=0`. `Number(null)` is 0 and the diagnostics version starts at
0, so a caller that omitted the parameter was told nothing had changed since a version it never held.
The desktop always sends one, so nothing looked wrong until a hand probe asked without it. Absent is
not the same as zero; the regression pins both halves and the sabotage reproduces the old answer.

**F107 stays `passes: false` and the validator is why.** Every criterion including the live run is
met, but its prerequisite F94 is unverified, and `features.py validate` refused the alternative:
*"passing feature depends on non-passing F94"*. The dependency is real rather than bookkeeping — the
refusals that keep the session host safe are F94's code. The row says so rather than being quietly
downgraded.

Gates: `npm test` 203/203, `./init.sh` and `features.py validate` clean, sidecar stamped.

## Session 69 (macos) — 2026-09-07 — Restarting the layer that cannot be updated (F107)

The supervisor performs layered updates, so its own code can never arrive by one — the stable IDE
port of KI-066 has been sitting on `main` unable to reach the running workspace for exactly that
reason. There was no supported way to restart it: `--replace-host` (spec 098) is the other layer and
ends every session on purpose, and the owner's own attempt through this session was blocked because
a raw `kill` is not something an agent should be reaching for.

So it is an action now, in the dashboard beside the others, opening as a retained script tab.

**Everything dangerous was already written.** `launcher/replace.mjs` came out of spec 098 with
`findHost`, `findSupervisors`, `stopProcess` and `portReleased`, all of them tested, all of them
refusing by name rather than pattern-matching process names. This is a small module on top rather
than a second implementation of the same care.

**The two rules the tests exist to hold.** The session host is never signalled — it owns the PTYs,
the agents and the store, and stopping it is a different tool's job. And the replacement is started
**detached**, because the thing asking for a supervisor restart is almost always a pane inside the
workspace being restarted; a replacement that stayed an ordinary child would be a child of a pane
whose window the restart just closed, and the workspace would end up with no supervisor at all. The
launcher is invoked *without* `--replace-host`, and a test asserts that flag's absence, because
adding it would look like thoroughness.

Four sabotages, each red for its own assertion: the host added to the stop list (`the host was
signalled: 200, 100`), the replacement left attached, `--replace-host` appended, and the plan
computed after stopping had begun (`Missing expected rejection`).

Gates: `npm test` 201/201, `./init.sh`, `design.py check` and `features.py validate` clean, the
dashboard declaration reads without error. F107 `passes: false` on one criterion: it has not yet been
run against the owner's own workspace, which is the point of it existing and is theirs to trigger.

## Session 68 (macos) — 2026-09-07 — "To agent": the gesture, chosen as a control rather than a chord (F100)

The last unmet criterion of F100. The editor pane header gains a labelled **To agent** button that
sends `at_mentioned` for the file and its selected lines. I had held this back twice for an owner
design decision and the owner kept saying "go on", so it is built as the recommendation I had already
stated — a labelled control, not a key chord — and it is reversible: the affordance is four lines in
`editor_ui`, and a different one can replace it without touching anything below.

The reasoning that made a chord the wrong answer is what makes a labelled control the right one: an
editor that grows a gesture nobody can find is worse than one that waits. The control is drawn only
where the workspace advertises `ide`, so a pane bound to a bare session host does not show a button
that cannot work — asserted in both directions, present in `native-diagnostics` and absent in
`native-ide-selection`.

**The schema is the CLI's own, read rather than guessed.** `at_mentioned` takes
`{ filePath, lineStart?, lineEnd? }` — a different shape from `selection_changed`, which carries the
text and a start/end object. That is out of the CLI's own zod declaration in its binary, not
inferred from the name, and the test asserts the two notifications stay distinct because the CLI
treats them differently: one says where the caret is, the other says look at this.

Not yet done, and recorded on the row: the shape has not been seen *rendered* by a real CLI. The
running worker predates the route, and delivering it means another workspace update, which moves the
IDE port again and drops every connected session — the supervisor still lacks the stable-port fix
from KI-066, which needs a supervisor restart rather than a layered update. Worth doing together.

Gates: `npm test` 196/196, both native specs green, desktop build clean, `./init.sh`,
`features.py validate` and `design.py check` clean, sidecars stamped. The metric
`editor.mention-width` went through `theme.json` and `design.py generate` like every other size.

## Session 68 (macos) — 2026-09-07 — A project's brand is its own artwork (F106, spec 104)

Owner direction, given in the hirebase-v2 workspace: *"the logo is like on site, maybe we can use the
svg instead of title too"*, and when told the chrome can only draw a letter, *"svg rasterizer is a
good addition to redit editor"*. That is the later explicit direction AGENTS.md's 2026-09-05 pause
provides for; nothing else in the pause changed.

Spec 084 let a project declare a title and a one-or-two-character glyph. `toolbar_brand` drew the
chip with `re_draw_rrect` and the mark with `re_draw_text_face` — the mark was **text**, so a project
whose mark is a shape had no way to say so. The renderer was never the obstacle: `re_draw_texture_*`
has been public since the backend split. What was missing was anything that turns artwork into
pixels.

- **`third_party/nanosvg`** (zlib, pinned at `93ce879` with per-file sha256 in `sources.json`) behind
  **`orchestrator/native/svg.{c,h}`** — the same wrapper shape `jpeg.c` has over pinned stb.
- **Contract 8**: `icon.image` replaces the glyph in the chip, `wordmark` replaces the title text and
  takes one file or a `{light, dark}` pair. Exactly one of `glyph` and `image`; paths are
  declaration-relative, `.svg`, and refused when they escape. Resolved to absolute files
  server-side, because only the server knows where an external declaration (spec 085) lives.
- **`toolbar_brand`** draws either slot as a texture, cached per file and pixel box so a theme or DPI
  change re-rasterises and a frame does not. Artwork that cannot be read leaves the glyph and the
  title, and the workspace reports the problem.

**The window title stays text.** `SDL_SetWindowTitle` takes a string, so the owner's "svg instead of
title" reaches the in-app chrome and cannot reach the OS title bar. Recorded as decision 8 rather
than left for the next reader to rediscover.

**One claim I had to withdraw mid-implementation.** I wrote the rasteriser to premultiply alpha,
commenting that the draw list blends premultiplied. It does not: `backend_gl.c` uses
`GL_SRC_ALPHA` and `backend_metal.m` `MTLBlendFactorSourceAlpha`, both straight alpha. The
premultiply would have double-applied alpha and darkened every antialiased edge. Checked before
believing the comment I had just written; removed, with the two call sites named in its place.

Regressions observed failing for their own reason, per the work protocol:

| mutation | red |
| --- | --- |
| per-axis scale instead of a uniform fit | `svg_test.c` wordmark aspect assertion (200x200, not 200x56) |
| allocate the buffer and never rasterise | `svg_test.c` "rasterised to a transparent buffer" |
| `if (false && brand_texture(...))` in the chrome | `native-identity.spec.mjs` "the mark's own red reached the bar": `count: 0` for `#cc4f4c` |

The third is the one that matters: it is the only check that separates "resolved, cached and never
drawn" from "on the screen", and everything else in that test stayed green under it.

Commands: `npm run build`; `.cache/desktop/rengine_svg_test orchestrator/native/tests/fixtures` → ok;
`npm test` → 195/195; the native identity, render, design, external-project and format-registry specs
→ 10/10. `python3 tools/features.py status` → 12 passing; graph regenerated.

`orchestrator/tests/task-writes.test.mjs` carried a deliberate tripwire asking whoever raises the
contract ceiling to confirm contract 6's keys still read as they did. Raised to 8 and confirmed:
artwork adds `icon.image` and `wordmark` and touches neither `tracker.write` nor `agents`.

Remaining: the hirebase-v2 declaration is now contract 8 and points at the Kohai mark and wordmark,
so **a host built before this change reports "unknown contract 8" and loses that declaration until it
is replaced**. Not verified: how a denser wordmark reads at the smallest bar height on a low-DPI
display — the metric is fixed and both Kohai assets are legible at it.

## Session 67 (macos) — 2026-09-07 — The pane draws what the server said, and a test that passed for the wrong reason

F102's second consumer. The editor pane asks the worker for its file's diagnostics twice a second,
is answered `unchanged` against a version it already drew almost every time, and underlines each
reported range in the severity's colour — error, warning, or information, from the theme rather than
from a literal. A native spec drives the real desktop against a real worker running a real declared
server: the file opens, the pane reports one diagnostic, and typing an unsaved line takes it to two
while the file on disk is untouched.

**The sabotage that passed, and why that was the important one.** Three sabotages: the pane never
asks, the unsaved buffer is never sent, and an `unchanged` answer is taken as an empty list. The
first two went red. The third stayed **green** — and it should not have, because without the guard
the pane flickers between one diagnostic and none twice a second. The original assertion was a
poll-until, and the sabotaged build satisfied it by being right on the tick the poll happened to
sample. A test that passes because it looked at a good moment has established nothing. The assertion
now samples six times across a second and requires the count to *stay*, which the sabotage fails.
This is the masked-control case from `docs/evidence/blind-regressions-2026-09-06.md` in a new shape:
there the control hid the subject, here the polling hid the flicker.

The column the underline uses is tracked in the draw loop separately from the conversion the
selection path does, because one counts drawn cells (tabs stretch) and the other counts what the
protocol counts (tabs do not). Recorded as a limit rather than glossed: the spec asserts the count
the pane holds, not the cells the underline lands on.

Metrics gained `editor.diagnostic-height` through `theme.json` and `design.py generate`, so the
underline's size is a token like everything else and `design.py check` stays happy.

Gates: `npm test` 194/194, `native-diagnostics` and `native-ide-selection` green and both registered
in `test:desktop`, desktop build clean under the picky set, `./init.sh` and `design.py check` clean,
sidecars stamped. F102's "two consumers, one store" criterion is now MET with its limit written into
the row; parsed check-action output as a second source is still NOT MET.
## Session 66 (macos) — 2026-09-07 — The Tasks pane spawns, decomposes and hands over the token (F105 criteria 4-5, spec 103)

Spec 103 decision 5 and the Tasks-pane half of acceptance criteria 4 and 5, on branch
`feat/tasks-pane-controls`. Each task row now carries **Spawn ▾** (agent · model), **Decompose** and
**Hold token ▾** (live agents); a task the live agents record wears their labels (`claude 5b8d47c2`)
after its title. Spawn opens an inline chooser — the agents the workspace has, then that CLI's models
with the declared default preselected — and sends `agent-spawn` with `brief: 'task'`; Decompose sends
the same route with `brief: 'decompose'` and the default agent and model, no chooser; Hold token sends
the ledger's new `assign` through `re_token_action`'s sender, which the Sessions-tab lane had just
made the desktop's only one.

Seven things the code decided against the spec's paragraph, all recorded in its Surfaces section:

- **The chooser is inline, not a popover.** An overlay costs one of microui's 32 root containers,
  which fifteen leaf panes with a surface open already fill — the budget that keeps the token segment
  out of microui — and a chooser that scrolls with its row cannot end up describing a different task
  than the one under it.
- **There is no live agent list "the dashboard already has"**: `GET /api/agents-menu` answers both
  lists at once, fetched with the tracker refresh on the same gesture (`OP_AGENTS_MENU`, below
  `OP_BYTES`) and never on a timer. Its absence never takes the task list down.
- **Availability follows the workspace's capabilities as well as the provider.** `agentsMenu` decides
  whether the menu is fetched at all, `agentSpawn` whether a spawn is sent, and `taskWrites` gates
  **Decompose** in addition — a decomposition's only legitimate output is `task_add` calls, so a
  worker that cannot write the inventory has nowhere to put the subtasks it would produce. Each is
  refused by name in a note row of the pane, not discovered as a failed request.
- **A spawn's answer belongs to the pane** (`OP_AGENT_SPAWN`): the worker's refusals name a whole
  prerequisite — a session host predating task-driven panes — that a 512-byte status line truncates,
  and its `detail` (started, retained, could not be shown; do not spawn it again) must not read as an
  error to retry.
- **Not every live agent can be given the token.** The ledger names a holder by `agentId`, which for a
  workspace-launched pane is its conversation; a CLI that names its own carries none, so that row is
  disabled with the reason rather than sending an assign the ledger would refuse by name.
- **"Remote rows offer Spawn only" is literal**: no Decompose *and* no Hold token, because the token
  names agents of a workspace that row is not in.
- **The task's own criteria are shown** where the agent is chosen — rows carry `criteria` and the
  prompt is built from them, so the pane shows what it is about to send. No new metric: the cluster
  reuses the tracker's widths.

Regressions: `orchestrator/tests/native-tasks-controls.spec.mjs`, six tests, in `test:desktop` (33
specs). Twelve sabotage rows, each watched failing and confirmed not to be an earlier assertion —
the model dropped from the body, decompose sending `task`, the assign naming a session id, a remote
row offering Decompose, the default not preselected, the working label on every row, the menu never
fetched, each capability gate removed, the answer routed to the generic operation, and the criteria
not drawn. Table and method: `docs/evidence/tasks-pane-controls-2026-09-07.md`. **Two ways that table
nearly lied**, both written down there: the first sweep ran uncommitted, so its `git checkout` restored
the files to the *index* and every case after the first measured code that was not the code under test
— the same trap Session 64 hit hours earlier — and one sabotage did not compile, so its test ran the
previous case's binary and went red for the previous case's reason. The loop now captures the build
output beside every run and starts from a committed tip.

The worker half landed on `origin/main` mid-session, so this was rebuilt against the real shapes
rather than only the pinned text: `live` entries carry `conversation`, rows carry `criteria`, the
spawn answer carries `view`/`detail`, and the capabilities are the worker's. The fixture
(`orchestrator/tests/tasks-controls-fixtures.mjs`) is kept anyway — what is under test is which body
the *pane* sends for which gesture, and a fixture records that byte for byte without a ledger, an
installed CLI and a real pane standing between the press and the assertion.

Merged `origin/main` twice (a5bb1c8, then 2f3f924); both are ancestors of the tip. Conflicts were
list-shaped and unioned: `package.json` (33 specs, main's `RENGINE_IDE_DIRECTORY` kept), and one
sidecar anchor line. Gates: `npm run build` clean, zero warnings; `npm test` **188/188**; `npm run test:desktop`
**59/60** — the one red is `native-format-hardening`'s "wide trees, malformed declarations and slow producers
 never take the desktop down" (`dir6 expanded not reached`), which Session 64 reproduced on origin/main
 itself in a clean worktree; it is now KI-067 rather than a second lane's undocumented observation. Sidecar anchors re-pointed for `app.c` and `token.c` with their source hashes refreshed;
`tracker.c` gains one of its own — why the menu and the chooser are file scope, why the chooser is
inline, and why the two capability gates are not one.

Untouched: `orchestrator/runtime`, `orchestrator/agents`, `orchestrator/server`, and
`orchestrator/native/workspace.c`. `token.{c,h}` changed only to let the one sender carry a root and
an `agentId`, which is what "no second path" required. The tab enum is unchanged; the two new
operations sort below `OP_BYTES` and each carries its own static assertion. F105 stays
`passes: false` — criterion 5's end-to-end (a scripted agent whose `task_add` calls create child rows)
and criterion 4's *Sessions tab and `workspace_info` show the task beside the agent* are not proved.

## Session 65 (macos) — 2026-09-07 — rEdit speaks LSP, and an agent reads what the server said (F102, D37)

`mcp__ide__getDiagnostics` no longer answers "nothing" honestly; it answers what the project's own
declared language servers published, about the buffer the person is looking at rather than the file
on disk. Contract 7 carries the `languageServers` block: id, command, match globs, optional
languageId and initializationOptions. rEngine runs a declared server and never installs one, so a
machine without it gets *"clangd is not on this machine; rEngine runs a declared language server but
never installs one"* rather than an empty list that looks like good news.

The client (`orchestrator/runtime/lsp.mjs`) is in the replaceable worker for the usual reason — no
PTY, no surface, no store state — and covers the diagnostic half of the protocol only: initialize,
didOpen/didChange/didClose, publishDiagnostics, shutdown, and a bounded backoff restart. Servers are
per root and started on first use, because this workspace holds three projects and starting every
declared toolchain at boot spends the machine on projects nobody opened.

**Two bugs the tests found, both worth the paragraph.** `src/**/*.c` did not match `src/deep.c`:
expanding the directory wildcard and *then* rewriting every remaining star rewrites the star inside
that expansion. Reordering the passes would have worked and left the trap for the next person, so the
rewrite became one pass over an alternation, which cannot have the bug. An intermediate version
parked the wildcard behind a placeholder that ended up in the source as a literal NUL byte —
invisible in a diff, and worse than the bug it fixed. Separately, the first crash test had the fake
server publish and exit in the same millisecond, so the answer it asserted could never be observed;
it now crashes on the second open, and the fake flushes stdout before exiting, because `process.exit`
after a write to a pipe drops the write.

**Two sabotages had to be written twice.** L1 and L3 first produced a syntax error rather than a
failed assertion. A test that goes red because the file no longer parses has not been shown to catch
anything, so both were rewritten as valid code doing the wrong thing. Six sabotages in the end, each
red for its own assertion.

Also fixed on the way: the contract ceiling in another lane's `task-writes.test.mjs` asserted 6 and
is now 7 — that assertion is a tripwire and it worked, so it keeps its shape with a note for whoever
raises the ceiling next.

Gates: `npm test` 194/194, `native-ide-selection` green, `./init.sh` and `design.py check` clean,
sidecars stamped in the house format. F102 `passes: false`, and the row now says which criteria are
met: the editor pane does not render diagnostics yet, so "two consumers, one store" is only half true
— an agent gets the real answer, the person still sees nothing — and parsed check-action output as a
second source is not built.
## Session 64 (macos) — 2026-09-07 — The Sessions tab revokes the token (F105 criterion 1, spec 103)

Spec 103 decision 1 and acceptance criterion 1, built on branch `feat/sessions-token-controls`. In the
Conversations section of the Sessions tab, the row whose conversation is the ledger's `holder.agentId`
now carries a token mark and **Revoke**, or **Free** once the holder's process is gone — "take it from
that one so another can claim" is one gesture next to the agent it concerns, which is what the owner
asked for. Both gestures go through `re_token_action`, the popover's own sender lifted out of
`re_token_ui`, so the two surfaces send one `token-action` contract and there is no second path.

Three things the code decided against the spec's paragraph, recorded in its Surfaces section:
**(a)** the mark is not live-only — a hold outlives the process that took it (the conversation IS the
identity, spec 095), so the past-conversation row carries it too, and that is exactly where a holder
whose pane exited is listed; marking only live rows would have put Free nowhere the case it exists for
could reach it. **(b)** the pinned `token` frame carries no liveness — `segmentFrame()` drops the
`holderAlive` the ledger's `status()` computes — and stage 2's worker was deliberately not touched, so
the desktop derives it from the `holder.pid` the frame does carry, on the ledger's own `gone()` terms
(an unknown pid is not a dead pid; an unsignalable process is still a process). `re_token_holder_alive`
is the one place that changes if a later stage puts the field on the frame. **(c)** `re_app_inspect`
now reports `conversations` — the rows as the interface pass drew them, with `holdsToken` and
`tokenAction` — so a test reads the mark from the row's own derivation rather than re-deriving it, and
a mark keyed on the wrong id is red in the report as well as wrong on the screen.

Regressions: `orchestrator/tests/native-sessions-token.spec.mjs`, two tests, added to `test:desktop`.
Five sabotage rows, each watched failing for its own reason and confirmed not to be an earlier one —
the wrong holder field, Revoke sending `free`, a mark that never clears, liveness ignored, and a mark
that fires on any held token. Table and method: `docs/evidence/sessions-token-controls-2026-09-07.md`.
Worth writing down: the first attempt at that table ran before the implementation was committed, and
the loop's `git checkout` restored the files to the commit *without* the feature — a red for the wrong
reason. The script now refuses a dirty tree.

Then merged `origin/main` a5bb1c8 — the task-writes lane (decisions 2, 3, 5, 8, 9) and, from a third
session, the IDE bridge. Two list-shaped conflicts, both unioned: `package.json` keeps main's
`RENGINE_IDE_DIRECTORY` prefix with this spec inserted beside `native-sessions.spec.mjs` (32 specs in
`test:desktop`), and this entry is renumbered 64 because 60-63 were taken. Spec 103, `app.c` and
`app.h` auto-merged — the other lane's spec edits are in the worker and MCP sections, this one's in
Surfaces. Worth checking and checked: the task-writes lane touched `runtime/token.mjs`, and
`segmentFrame()` still drops `holderAlive`, so the desktop-side derivation stands.

Gates on the merged tip (a5bb1c8 is an ancestor of it): `npm run build` clean, zero warnings;
`npm test` 188/188; `npm run test:desktop` 51/54. The three reds are not this change:

- `native-format-hardening` "wide trees, malformed declarations and slow producers never take the
  desktop down" (`dir6 expanded not reached`) is **red on origin/main itself** — reproduced twice in a
  clean worktree built from a5bb1c8, alone, with no part of this branch in it. Not in
  `known-issues.md`; it belongs to whoever owns the nested explorer's expansion cap.
- `native-handoff` and `native-render` pass alone on this tip (handoff twice, render once) — flakes
  under the serialised suite, and neither touches a device, a session row or the token.

`npm run build:surface` is a prerequisite for the two recorder specs; without it they fail on a
missing SDL fixture rather than on anything real.

Untouched by this change: `orchestrator/runtime` (the ledger and the worker), `orchestrator/agents`,
`orchestrator/server`, and `orchestrator/native/tracker.c` (another lane) — they enter the branch only
through the merge. The tab enum and the OP_* ordering are unchanged; the one new metric is
`sessions.token-width` in `theme.json`. Sidecar anchors for the three edited files are re-pointed, and
`token.c._llm.json` gains the one entry a maintainer needs: liveness is derived here, in one place,
because the frame does not carry it. F105 stays `passes: false` — criteria 4 through 8 are not built.

Not verified: the live gesture on the owner's own workspace — Revoke on a running desktop taking the
token off a real agent, and the next `token_contest` claiming it. Same reason spec 099 carries: a
workspace whose host predates this cannot exercise it, and this session runs inside that host.

## Session 63 (macos) — 2026-09-07 — Token-serialised task writes and task-driven spawns (F105, spec 103)

The workspace half of spec 103, on `feat/task-writes`: decisions 2–4 and 6–9, plus decision 5's
`assign` for the Tasks pane's *Hold token*. The native halves (Sessions-tab Revoke/Free, the Tasks
pane's control cluster) are separate lanes against these routes; F105 stays `passes: false` until
they land.

- **Contract 6** in `contracts/project-v1.schema.json`: `tracker.write` (literal argv naming
  `${json}`, `provider: "local"` only, its own contract floor inside a contract-5 block) and a
  top-level `agents` menu (`cli`, `models[]`, `default`; unique clis, default one of its models). A
  contract-5 declaration reads exactly as it did.
- **`POST /api/task`** (`add` | `update` | `decompose`), `orchestrator/runtime/worker.mjs` over the
  new `orchestrator/server/tasks.mjs`: token-gated, then serialised per root **behind** that gate, so
  a non-holder is refused without waiting for anybody and two holders in sequence queue rather than
  interleave. It runs the project's own declared command — no shell, cwd the root, bounded like a
  format preview — and hands back its stdout (parsed when it is JSON) with the refreshed row list.
  Every refusal names what is missing and says nothing ran.
- **`POST /api/agent-spawn`**: the chosen CLI and model through the host's terminal route, the
  rendered prompt as the CLI's positional initial argument, then `task` recorded on the conversation.
  **`GET /api/agents-menu`**: the declared menu or rEngine's known lists, plus the live agent panes
  with the task each is working. Feed frames `task.added`, `task.updated`, `agent.spawned`.
- **Prompts** shipped at `orchestrator/templates/prompts/{task,decompose}.md`, overridable at
  `.rengine/prompts/<name>.md`; a placeholder a project misspells is named in the refusal.
- **MCP**: `task_add`, `task_update`, `task_decompose`, `spawn_agent` (holder only) and
  `list_agents_menu` (read), gated on `taskWrites`/`agentSpawn`/`agentsMenu`.
- **Ledger**: desktop action `assign` hands the token to a named identity at once, settling an open
  contest as rejected-by-desktop **without charging its cooldown**, resolving the label through the
  ledger's identities or the project's remembered conversations, and refusing an unknown id by name.

**The host is not unchanged in one way; it is unchanged in two.** The pinned route already accepted
`args` for an agent pane and **dropped them** — `spawnTerminal` overwrites `argv` for `type: 'agent'`
— so a spawn through the untouched host would have started a CLI with no model flag and no prompt and
looked entirely successful. The host now forwards them after `--`, alongside accepting `task` on the
conversation record; both are announced as `taskConversations: 1` and `/api/agent-spawn` refuses by
name without it. Recorded as a correction in spec 103; the spec-098 order is unchanged.

Gates: `node --test orchestrator/tests/*.test.mjs` **179/179** (170 before). Nine new tests in
`orchestrator/tests/task-writes.test.mjs`, each observed red for its own reason — 21 sabotage rows,
one masked case and one sabotage that proved nothing until it was corrected, in
`docs/evidence/task-writes-2026-09-07.md`. Neither the write command nor the spawned CLI is mocked:
both are real executables in the fixture, and the argv each was handed is read off a file.

## Session 62 (macos) — 2026-09-07 — The IDE port may not move (KI-066)

The layered update that delivered F100 ended this session's own IDE connection. That is the finding:
not a hiccup, a defect in the feature shipped an hour earlier, and one that would have hit every
connected pane on every update from then on.

**What happened.** The bridge bound an ephemeral port per worker. `--layers workspace,desktop` moved
rEdit from 49953 to 61709, and the CLI reported `WebSocket connection to 'ws://127.0.0.1:49953/'
failed`. Claude Code reads a lock once and afterwards reconnects to the port it read; it never goes
back to the directory to look again. So the feature whose entire premise is that new capabilities
arrive *by* layered update was broken *by* layered updates, and the only visible symptom was an
editor connection quietly gone.

**The fix is where the lifetime is.** The port belongs to the runtime, not to the worker: the
supervisor reserves one at startup, carries it in `runtime.json` as `idePort`, and hands the same
number to every worker it starts. A worker starting during an update finds its predecessor still
holding the port — the successor is started before the old one retires — so it retries for a bounded
while instead of taking a free one. Taking a free one is the tempting fallback and it is precisely
the bug: it succeeds, logs nothing, and silently ends every session. A worker that never gets the
port publishes nothing and says why. Closing unlinks the lock before closing the socket, so the
successor cannot bind and write the lock in the gap only for its predecessor to delete it.

Regression: `the port survives a worker replacement, because the CLI reconnects to the one it read` —
two bridges over one port, the second refusing to settle for another, taking it when the first closes,
same port and same lock path, then serving a real client. Sabotage: restore the old
fall-back-to-ephemeral and it goes red on `published` being true when it should be false.

Gates: `npm test` 179/179, `native-updates` and `native-ide-selection` green against the supervisor
change, `./init.sh` clean, sidecars stamped. KI-066 recorded and closed; spec 102 gains decision 8b.

**The general lesson, since this is the second time this week.** A capability that rides the update
path has to be tested *across* an update, not only after one. The tracker was reachable only after
the host was replaced (KI-043 again, KI-062); this one worked perfectly until the first update and
then died. Both were found by running the thing live rather than by reading the code.

## Session 61 (macos) — 2026-09-07 — The editor tells the agent where the caret is (F100), and LSP becomes the direction (D37)

**The owner chose the protocol.** F102 had offered two ways to make `getDiagnostics` true: parse a
declared check action's output, or adopt LSP. *"LSP adoption looks great"* — so F102 is rewritten to
adoption and recorded as charter **D37**, with parsed check output kept as a second source because a
build reports failures no language server sees. The row is a rewrite rather than a follow-up because
it was added an hour earlier in this same session and nothing had been built against it; the
rationale and the owner decision are both recorded, which is what the work protocol asks. Servers are
declared per project and never installed by rEngine, and the client belongs to the replaceable worker.

**The selection contract confirmed itself by accident.** The shape pushed as `selection_changed` was
invented from the CLI's vocabulary. The probe that proved the live bridge posted a real selection into
the owner's own session, and it came back rendered as *"The user selected the lines 19 to 19 from
…/ide.mjs"* — a zero-based line 18 shown as 19. So the shape is understood, lines count from zero,
and the notification becomes conversation context rather than merely being accepted.

**Counting characters is the whole of the C work.** The buffer holds code points; the protocol counts
UTF-16 code units. The fixture line `const char *s = "🙂🙂";` answers 21, **23** and 27 depending on
whether you count code points, UTF-16 units or bytes, which is why that line is in the fixture. The
spec's first run failed at 23 against an expected 24 — the arithmetic in the test's own comment was
wrong, not the code — and the expectation was corrected to what the rule produces.

`re_editor_selection` walks the buffer once and converts both ends; the desktop reports only from the
focused pane, only when the signature changes, and never faster than every 150 ms, so a held arrow
key is not a frame's worth of notifications. The path within a root goes to the worker, which resolves
it against the root it owns — the desktop names a root and a path exactly as it does everywhere else.

Sabotages, each rebuilt and run alone: code points instead of UTF-16 units (`1:0-1:21`), a pane with
no editor keeping the last selection standing (the Tasks tab still reporting `a.c|1:0-1:23`), and byte
offsets (`1:0-1:27`). Plus the eight from slice 1 re-run green.

Gates: `npm test` 178/178; `native-ide-selection.spec.mjs` green and registered in `test:desktop` and
therefore in `suite-coverage`; desktop build clean under the picky warning set; `./init.sh`,
`design.py check` and `features.py validate` clean; sidecars stamped and written back in the house
format.

**Not done, and said so in the row rather than dropped:** `at_mentioned` has its transport but no
gesture. Which affordance sends it — a key chord, a pane control, a menu entry — is the owner's
design choice, and inventing one silently is how an editor grows a gesture nobody can find. F100
stays `passes: false` for that one criterion.

## Session 60 (macos) — 2026-09-07 — rEdit is an IDE Claude Code will connect to (F99, spec 102, slice 1)

The owner asked whether Claude Code's `/ide` integration could be used. It can, and now is: a real
`claude` 2.1.263 in a pane shows **`Select IDE … 1. rEdit ✔`** and reports **`Connected to rEdit.`**

**Read the binary first, then distrust it.** `/ide` discovers an editor by reading
`~/.claude/ide/<port>.lock` — the port is the *filename*, nothing inside the file names it — and
connecting over WebSocket. Two things the binary would not tell us decided the implementation, and
both were settled by driving the real CLI rather than by reasoning:

- **Print mode never connects.** `claude -p --ide` answered normally and opened zero sockets. Any
  "verification" of this feature through `-p` would have been worthless. The probe moved to an
  interactive CLI under a PTY.
- **Where the token is presented** is not in the binary's strings. The first implementation hedged
  across three plausible positions, which is the kind of hedge nothing ever disproves. The live
  handshake settled it — `x-claude-code-ide-authorization`, plus a `mcp` subprotocol request — and
  the hedge was deleted rather than left in.

**The design point that would have failed silently.** The CLI only trusts a lock whose `pid` is
alive and is one of the calling CLI's own first ten ancestors. In rEdit the desktop is never that:
panes are PTYs the *session host* forked, so the chain is CLI ← shell ← host. The lock therefore
names the session host — which has a second consequence, because the CLI collects a lock by noticing
its pid is dead, and ours never will be. So the bridge unlinks its own lock at retirement and sweeps
stale ones at startup, recognising its own by `rengineWorker`, a key the CLI's parser ignores. A lock
naming the worker or the desktop produces no error anywhere; `/ide` just lists nothing.

The bridge lives in the workspace worker (`orchestrator/runtime/ide.mjs`), which is spec 101's rule
applied one more time: it needs no PTY, no surface and no store state, so it arrives by a routine
layered update. The host gained one field — its own `pid` on `/api/state`, beside the `stateDir` of
spec 101, for the same reason and with the same process-table fallback for a host too old to say it.

Slice 1 serves `getDiagnostics` (an empty list, which is the honest answer from an editor with no
language server), requires the token, echoes the subprotocol, and turns a selection posted by the
desktop into `selection_changed`. Slice 2 is the desktop's own selection reporting, `at_mentioned`,
and `openDiff` with accept/reject in a pane.

Gates: `ide.test.mjs` 7/7 with all **eight** sabotages red for their own assertion (including one
that would have deleted VS Code's locks, and one that dropped the subprotocol); `npm test` 177/177;
`./init.sh`, `design.py check` and `features.py validate` clean; sidecars stamped and written back in
the house format. F99 `passes: false` — F74 is still blocked. Evidence:
`docs/evidence/editor-as-claude-ide-2026-09-07.md`.

One side effect worth naming: a worker publishes a real lock, so the suite used to write into the
`/ide` menu of whoever ran it. `RENGINE_IDE_DIRECTORY` now points every test script at
`.cache/ide-locks`, with a temp-directory fallback for a spec run directly.
## Session 59 (macos) — 2026-09-07 — Task-driven agents, recorded (F105, spec 103)

Owner direction in the vtmb-vr workspace, after the token was seen live: the Sessions tab must revoke
the token so another agent can claim it; the token serialises MCP actions that must be serial — one
file, one writer; two agents never edit features.json at once; the task system and the agents get
tighter coupled, with Tasks-pane controls up to spawning a chosen agent and model on a task or
decomposing it. Spec 103 records the decisions with attribution: workspace-mediated writes to the
local inventory are token-gated and run the project's own declared command (spec 083's read-only rule
amended for the local backend, kept for GitHub/Linear and why); an agent's own edits are covered by
convention and visibility, not pretended enforcement; Spawn, Decompose and Hold-token on the Tasks
pane; the conversation record carries the task; prompts are project files with shipped defaults;
contract 6 adds tracker.write and agents. F105 added, passes false. Documentation only.

## Session 58 (macos) — 2026-09-07 — The layout a replaced host leaves behind (KI-064/065, spec 098)

`--replace-host` (spec 098) landed this morning and the owner ran it. Twice today, on two different
projects, the workspace came back with the new host serving and **no runtime layer at all**: on
rEngine's own workspace `GET /api/desktops` answered `[]` while the desktop was on screen; on
hirebase-v2, replaced at 12:22, the supervisor and the desktop process were both gone. The thing
neither the spec nor the flag accounted for is what a replacement cannot end: the desktop's saved
layout. It lives in `<state>/workspace.json`, it outlives every process, and its tabs still name the
session ids of the host that was just stopped.

So the first `desktop-register` after a deliberate replacement advertises sessions the new host has
never heard of — on workspace 1, six ids of which four were the dead host's. `Desktops.register`
validated each with `sessions.snapshot(id)`, which `fail`s `Unknown session.` 404 on the first stale
one, before anything is stored, so the **whole** frame was refused; the host answered
`{ type: 'error', error: 'Unknown session.' }` and the desktop, which sets `desktop_registered` from a
successful *send* rather than from the reply, never tried again. `waitView` then timed out with
"Replacement desktop did not register before timeout." and the supervisor exited with an empty
`runtime.log`, because that failure travels over IPC. Two controls before writing anything: the same
binary registers normally when its layout names no stale session, and a fake registration through a
fresh worker with only live ids succeeded and got its `token` push, so the worker's ledger path was
never involved.

A registration naming sessions the host does not have is not an invalid frame. It is the expected
first frame after a replacement, and the fix is in every layer that can refuse it, each reachable on
its own schedule — which is the point spec 065's asymmetry keeps making and this is the third time it
has cost something. **The host** (`server/desktops.mjs`) drops ids it has no session for, keeps
`Invalid desktop bindings.` for a malformed frame and the different-root refusal for ids it *does*
have, and names the dropped ones as `unknownSessions` in `desktop-registered`; that reaches a
workspace only at the next `--replace-host`, because a Node process holds the modules it imported —
the premise of spec 098 itself. **The worker** (`runtime/worker.mjs`) filters `sessionIds` against the
`/api/state` it just refreshed and hands the removed ids down as `dropped`; that is the replaceable
layer, so it arrives at the next `update_workspace` without touching a PTY. **The desktop**
(`native/app.c`) advertises only sessions the state it already holds still lists, and marks the other
restored tabs ended: nothing is attached to them, `re_app_inspect` reports `sessionEnded`, and the
status bar says how many views are in that state and that Sessions has the conversation (spec
097/099) — no new widget, and the tab stays where the person left it. And **the supervisor**
(`waitView`) now names the last registration a worker refused and what the desktop printed, so the
next failure of this shape says what it is instead of only that it did not happen.

Verified TDD, each red for its own reason and each fix sabotaged in the way its test claims to catch:
the host's refusal (`Unknown session.` out of `desktops.mjs:10`), the same refusal reached through the
worker (`Timed out: desktop registered`), and — the discriminating one — a real host, a real runtime
supervisor and the real desktop the supervisor launches, under a layout persisted before the desktop
started: `Replacement desktop did not register before timeout.` at `supervisor.mjs:125`, verbatim what
the owner's machines produced. The acceptance is deliberately not "a window appeared": it is that
`GET /api/desktops` **through the runtime** is non-empty and `update_status` answers. Both native
reds burned the full 10 s deadline and both now pass in 0.7 s and 1.0 s. Evidence and the sabotage
table in `docs/evidence/stale-sessions-registration-2026-09-07.md`; spec 098 gains *What a replacement
leaves behind* with the per-layer table; KI-064 records it.
## Session 57 (macos) — 2026-09-07 — The CLI reports the conversation it runs (F90)

"The conversation IS the identity" was reconciled yesterday and still had one hole, seen live today: a
pane launched with a minted `b9e2114c` was moved by its person to another conversation from **inside**
the running CLI — Claude Code's own `/resume` picker — so the process ran `5b8d47c2`, its transcript
was `5b8d47c2….jsonl`, and no `b9e2114c….jsonl` ever existed, while the pane record,
`workspace_info.agent`, the token ledger identity and the Sessions tab all still said `b9e2114c`. The
launcher decides the conversation from the launch's own flags and is blind afterwards, and inferring
the id from transcripts or the process tree is forbidden — the thing an earlier attempt did and kept
getting wrong.

The fix is not a better guess: **the CLI is asked**. Verified on this machine before anything was
written (2.1.263): `--settings <file-or-json>` exists, and one real `claude -p` run with a throwaway
hook showed exactly what a `SessionStart` hook is handed on stdin — `session_id`, `transcript_path`,
`cwd`, `hook_event_name`, `source` (`startup` on a fresh run, `resume` when resumed) — and that the
hook inherits the launch environment, so the launcher's own `RENGINE_*` plumbing reaches it.

What changed. **`agents/report-session.mjs`** reads that payload, finds this launch's binding the way
the tool worker does (`RENGINE_MCP_CONFIG` → the per-launch `mcp.json` → its `--context` file, else
`RENGINE_WORKSPACE_CONTEXT`), posts `POST /api/agent-conversation` exactly as `launch.mjs` does at
launch, and rewrites the per-launch `context.json` identity — `agentId`, `label`, and `session` with
`source: 'reported'`. It never fails the CLI it runs inside (stderr only, always exit 0), never writes
to stdout (a `SessionStart` hook's stdout becomes text in the person's own conversation), and does
nothing at all outside a workspace pane. It reports on every session start, not only on a change, so a
`-c` launch — which claims nothing and leaves the pane unrestartable — becomes known at its first
report. **`agents/config.mjs`** writes that hook into a per-launch `settings.json` beside `mcp.json`
and passes `--settings`; nobody's own settings file is touched. **`agents/bind.mjs`** prints the same
flag, and the hook is given this launch's context on its own command line, so a session started by
hand from that printed line — which inherits none of the launcher's environment — corrects the
identity too, though it posts to nobody, having no pane. **`agents/mcp-worker.mjs`** re-reads the
identity from the context file once per tool call, so `workspace_info` and the `X-Rengine-Agent`
header follow the CLI without a worker restart — while the binding stays the facade's snapshot, so the
file can rename this agent and never retarget its root. No server route and no native change.

Verified end to end through the real CLI, with the live gap reproduced: the launcher named
`b9e2114c-0000-…`, the CLI ran `5a9a90ce-96ea-…`, and afterwards the fake host held
`{ id, conversation: 5a9a90ce…, agent: claude }` and the context identity read `claude 5a9a90ce`,
`source: reported`, with `pid` and `startedAt` untouched. Thirteen sabotages, each watched red for its
own claim (case 12 red twice, from both ends of one mechanism); one of them found a real hole rather
than confirming one — the claude line `bind` prints without `--agent` had no assertion on it at all,
so dropping the flag there passed until the assertion was added. 161/161 on
`node --test orchestrator/tests/*.test.mjs`. Spec 095 gains *The CLI reports what it runs*, 096 gains
amendments 3c and 4b, and the runbook says to start a bound session with the printed `--settings`.
Evidence, with both recorded hook payloads: `docs/evidence/report-session-hook-2026-09-07.md`.

**Not verified:** a live pane, the same gap 095–098 all record — this session's host predates the
change; and Windows, where the hook command is quoted for `cmd` rather than POSIX-style.
## Session 56 (macos) — 2026-09-07 — What a running workspace can and cannot be given (F98)

The owner was told, more than once, that layered updates were in place, and today a new route could
not reach the running editor. Measured first, read-only, before writing anything: the premise "no
worker serves this workspace" was wrong. Supervisor 44390 has run above host 33465 since yesterday
morning, its worker 79969 since 23:22, the editor (PID 88067, opened 12:34 today) talks to that
supervisor, and `connectorGeneration` is 11. The mechanism was installed and had been used eleven
times. What was true is narrower and worse: the tracker routes were added to `server/main.mjs` — the
host — and to nothing else, so the worker forwarded `/api/tracker` to a process from before the route
existed, which answered 404. KI-043 for the third time, with the lesson already written in two
sidecars. Spec 101 records the measurements and the decisions; KI-062 records the shape.

What changed. **The tracker routes are served by the worker** (`runtime/tracker.mjs`, importing
`server/tracker.mjs` and `tracker-auth.mjs`; nothing about a provider repeated), and the worker
advertises `tracker: 1` itself. The one thing the host has that the route needs is its state directory,
where a credential lives: a host from this checkout now says it on `/api/state` (`stateDir` — the
minimum host change for next time), and the retained one is found the way `--replace-host` finds it,
from the `main.mjs --state DIR` process-table row whose `sidecar.json` names the host's **instance** —
never the URL the worker was handed, which is often a proxy's, and never the first host row, of which
this machine has a dozen. **The facade watches `runtime.json`** and refreshes its tool worker when the
connector generation changes without waiting for a request, so a CLI that honours
`tools/list_changed` has the new list before its next turn instead of a mid-turn surprise. **A stale
tool name is answered with the way back** — the generation, the current names, and that Claude Code
refreshes while Codex must be restarted — instead of the SDK's bare `Tool X not found`, which the SDK
delivers as an `isError` result, not an exception, a detail the first version of the handler got wrong.
**The facade runs the tool worker the supervisor probed** (`toolWorker` in `runtime.json`), not its
sibling by assumption; in a checkout the two are the same file, and it is what gives a test two
generations. And **`list_tasks`** exposes the tracker to agents, so there is a concrete new tool to see
arriving.

What was verified live, read-only, from this worktree against host 33465 (evidence in
`docs/evidence/live-capability-updates-2026-09-07.md`): the route through supervisor 44390 still
404s; a worker from this checkout answers it for all three roots (50, 1315 and 526 rows) and names
`.cache/orchestrator-development/trackers/oauth.json` in the sign-in setup, found by instance; a
scratch supervisor, worker and facade above the same host list `list_tasks`, and a connector update
issued to that supervisor reached the idle facade in 914 ms with no request through it; `launch_nolf`
at that facade got the way-back answer. Seventeen sessions before, seventeen after, nine running.
And the client question was measured rather than read: a throwaway server driven by `claude -p` shows
the installed Claude Code 2.1.263 re-listing tools in the same millisecond as the notification and
calling the new tool in the same turn.

What is genuinely impossible, so nobody is told a third time: the two pre-facade connectors (93041
under the owner's `claude` pane — the pane this session runs in, `CLAUDE_PID=92680` — and 20159 under a
`codex` pane) run code from before any refresh path existed and cannot be changed from outside; the
Claude one reconnects from `/mcp` (Reconnect keeps the conversation and the pane), the Codex one
restarts its CLI. A Codex session cannot gain a new tool *name* at all without a restart (openai/codex
#10105, #19155, #33266; Codex 0.153.4 installed); it gains new behaviour behind stable names.
Supervisor routes need a supervisor restart, which closes the editor windows and keeps every session.
Host state — PTYs, store, `/events`, `/api/terminal`, `/api/game`, `agentConversations` — moves only
with `--replace-host`, which ends the sessions.

Eight sabotages, each red for its own assertion: the route forwarded to the retained host; `stateDir`
dropped — first masked by the host-level assertion, then re-run with that lifted so the worker-level
one was seen to discriminate alone; the URL as the key, and the first host row on trust; the watcher
removed; the stale answer dropped; the sibling worker instead of the probed file. One existing test
changed: `runtime.test.mjs` restores its tool-worker wrapper before killing the worker, because the
facade now recreates a crashed worker from the published file and a crash while that file is broken
on disk is the source edit's failure, not recovery's. `launcher` and `games` each dropped one test
under the full suite's load and passed alone (KI-045's shape).

Gates: `npm test` 132/132; `ctest` 6/6; `python3 tools/design.py check`, `features.py validate`,
`./init.sh` clean; sidecars for the six annotated files repaired, reviewed and stamped on a disposable
index; graph regenerated. `npm run test:desktop` 41/44 under load, and each red passed alone: the GPU
adapter comparison on its own (KI-045's shape), and the game-texture and recording specs once
`npm run build:surface` had produced the surface fixture this fresh worktree did not have — they
were reading "game exited" from a missing executable, not a regression.

While that suite ran, the parent session committed this tree as `20e2cab`, merged `origin/main`
(`79afb62`, KI-061 retention and token gating) and `main` (`414c814`, the tracker filters), and
renumbered the work to F98 and spec 101 because F97 and spec 100 had been taken. On the merged head:
`npm test` 158/159 under load with the one red — `token-retirement.test.mjs`, another lane's
retention fixture — passing alone; `native-updates`, `native-bootstrap` and `native-tracker` 5/5;
sidecars clean after re-stamping `runtime.test.mjs`, whose spec reference the renumber had edited.

Not done here, deliberately: merging to `main` and running the update on supervisor 44390 — the
supervisor forks `runtime/worker.mjs` from the main checkout's working tree, which other lanes were
editing (the token ledger and `tracker: 1` on the host, both already in that tree). The first live
run belongs to whoever merges: from any pane,
`node orchestrator/runtime/client.mjs update --context "$RENGINE_WORKSPACE_CONTEXT" --layers workspace,connector`,
then the Tasks tab and `list_tasks`. Branch `feat/live-hot-update`, not merged. F98 `passes: false`
for that reason.

**The live run, done at 13:45 from this checkout after the merge.** `client.mjs update --layers
workspace,connector` against supervisor 44390 succeeded in 337 ms: worker 79969 → **35886**,
connector generation 11 → **12**, the old worker listed under `retiring` with one stream still
draining, which is KI-061's hand-off doing its job. The supervisor then advertised `tracker: 1` and
answered `GET /api/tracker` with **51 local rows** where minutes earlier it had returned the retained
host's `404 Unknown workspace endpoint.`; a facade started from this checkout against the same
context listed 32 tools including **`list_tasks`** and got the same 51 rows through it. Host PID
33465 was never signalled and every retained session survived — `workspace_info` through the owner's
own connector shows the same eleven, six running. So the capability the owner was told repeatedly was
already deliverable is now actually delivered to the running editor, without ending a session.

Two things that remain true and are not defects: the owner's own MCP connector (PID 93041) predates
the facade and needs `/mcp` → **Reconnect** to see `list_tasks`, which costs neither the conversation
nor the pane; and F98 stays `passes: false` because both prerequisites, F74 and F78, are still
blocked — the live criterion itself is now recorded as done in
`docs/evidence/live-capability-updates-2026-09-07.md`.

**Then the owner reconnected and asked for the full update.** After `/mcp` → Reconnect the connector
runs the facade with the current 32 tools and `list_tasks` answers through it — the new tool reached
an already-open CLI session without ending the pane or the conversation. `update_workspace` over MCP
was refused for a reason worth recording: *"Only an identified agent can act on the token; this
request carried no X-Rengine-Agent header"*. The token was free; the connector simply predates F90's
agent identities, so **a connector bootstrapped before F90 can never hold the token**, and the
token-gated tools are unreachable from it until it is re-bootstrapped with an identity. The same
update through `client.mjs`, which carries the runtime's own token rather than an agent's, is not
agent-gated: all three layers succeeded in 1.9 s — worker 35886 → **89697**, desktop 88067 →
**90113**, generation 12 → **13**, tool worker 90114, nothing left retiring. This session's facade
answered `update_status` at generation 13 without being touched, which is the descriptor watcher
doing exactly what it was built for. All twelve sessions kept their PIDs and their sequence numbers
kept advancing. The `desktop` layer's cost, as designed: the window detaches with exit 75 after
persisting its layout and reopens on it. The session host was never signalled in either run.

## Session 55 (macos) — 2026-09-07 — The tracker narrows to a person and to what is actually active (F97)

The hirebase-v2 tracker tab answered with a hundred rows spanning every assignee and every workflow
state, and the owner opening their workspace to work through their own tasks had to hunt. The
declaration could already narrow a Linear team to one project; it could not narrow to a person, and
it could not say "the states that mean now". Spec 100 adds two optional Linear-only keys to the
`tracker` block — `assignee` and `states` — and honours them where the query is built.

**The query shape was verified against live Linear before this session and is not re-derived here.**
Team BAS / project Kohai: `{team, project, assignee: {isMe: {eq: true}}, state: {type: {in:
["started"]}}}` → 13 rows; the same with `displayName: {eq: "jon"}` → 11; `{team, project}` alone →
50; `state: {type: {in: ["started", "unstarted"]}}` → 13. The whole filter now goes over as a single
`$filter: IssueFilter` variable and `linearFilter()` builds it in JavaScript, so the document is one
fixed string for every shape and no clause is interpolated into it.

**Back-compat is the whole branch, and it turns on one clause.** The project clause is always
present, and `null` when nothing is declared — which is byte-for-byte what the old `$project`
variable produced. Building the filter without it when it is undeclared would have been a *different*
query that happens to return the same rows today; the test asserts `Object.keys(filter)` is exactly
`['team', 'project']` so no empty narrowing sneaks in either.

**`local` and `github` refuse rather than ignore.** The file already had this style — `repository
belongs to provider github`, `inventory belongs to provider local` — so the two new keys joined
`project` in one linear-only loop in `trackerRules`. A list that quietly answers a wider question
than the one asked looks exactly like a correct answer, which is the failure those rules exist to
prevent. An unknown state category is refused by the schema enum at declaration time, so `in-progress`
(a team's state *name*) never reaches the network; the declaration speaks the five categories the
neutral row normalises to.

**The narrowing joined the cache key.** Two declarations differing only in their filters are
different questions, and answering the second from the first's thirty-second entry would be a wrong
list rather than a stale one — which the freshness indicator cannot flag, because the entry is fresh.

**The masked first run, which is the point of the protocol.** All six new tests went red against the
unchanged code and *three of them for the wrong reason*: `additionalProperties: false` refused the
keys outright, so no request was ever built and the tests were failing on the declaration rather than
on the filter. The schema keys were added alone and the suite re-run before any filter existed; only
then did each test fail for its own reason (and test 4 went green, because the enum alone is what it
claims to catch). Six sabotages then produced exactly the red each claims and nothing else, tabled in
`docs/evidence/tracker-filters-2026-09-07.md`.

**Gates.** `node --test orchestrator/tests/*.test.mjs` 152/152 (six new in
`orchestrator/tests/tracker-filter.test.mjs`, picked up by the glob). `./init.sh` clean, 50 features
validated. `verify.sh design` clean. Recorded and unrelated: while the sidecar indexer was running,
two full runs each went red once in `project-token.test.mjs` — a different test each time, both green
in isolation and in the quiet full run. That suite has real deadlines in it, so it is sensitive to
another process eating the machine; nothing in this branch touches it. No test makes a network call: every Linear test drives an
injected `fetch` and asserts on the request body it records, never on the rows — spec 083 recorded
why the result is not the evidence for a filter.

**No declaration was edited, on purpose.** The schema has `additionalProperties: false` and a running
session host freezes it at startup, so a declaration carrying these keys is refused *wholesale* by any
host that predates this change and takes that project's dashboard down with it — which already
happened once today. The code lands first; hirebase-v2's `project.json` gains the keys only after the
owner runs `~/hirebase-v2.command --replace-host` (F94). That live confirmation is F97's one
outstanding criterion.

**One repair.** Session 53's commit 98ead34 describes a test asserting the tracker capability and the
`/api/tracker` route together, but the test is not in it: this session had the same working tree open
and had momentarily parked that addition while separating its own change. Restored verbatim in
832e1f0; 7/7 in `tracker.test.mjs`. Two pre-existing assertions there did have to move, because the
Linear variables are now one `filter` object rather than `team` and `project`.

## Session 54 (macos) — 2026-09-07 — The capability a merge dropped, and the test that would have caught it

A merge into `main` took the other side of the capabilities map and removed `tracker: 1` from
`orchestrator/server/main.mjs`. The routes survived — `/api/tracker`, `/tracker/signin`,
`/tracker/signout` all still answered — so nothing failed loudly. What broke was the only thing that
tells a client the route exists, which is precisely the signal the desktop reads before offering the
Tasks tab against a workspace it did not start.

Restored the flag, then wrote the regression that had been missing: test 7 in
`orchestrator/tests/tracker.test.mjs` asserts the capability and the route **in the same test**, on
the same live server. A test that checked only the route would have passed throughout the outage;
one that checked only the flag could pass on a workspace whose route 404s. Verified by sabotage —
removing `tracker: 1` again fails test 7 by name and nothing else — then restored. 15/15 across
`tracker.test.mjs` and `tracker-auth.test.mjs`, `./init.sh` and `features.py validate` clean.

**Two sidecar notes, both about traps rather than mechanics.** `main.mjs#tracker-is-host-only`
records why this route in particular cannot arrive by a layered update: an update replaces the
worker, and this file is the host. That is the KI-043 shape and it is what the owner hit — a
development workspace whose host predates the feature answers 404 while the desktop beside it draws
the button. `store.mjs#per-root-preferences-merge` records why `themes` and `recording` are merged
into stored preferences rather than replacing them: the desktop sends only the key it changed, so a
replace would silently drop every other project's remembered theme, which surfaces as "my theme
keeps resetting" rather than as an error.

Both sidecars reviewed and stamped; `check` clean for both. Remaining stale stamps in the tree
belong to other lanes' files.
## Session 53 (macos) — 2026-09-07 — Retirement by kind: the streams drain, the ledger hands off (KI-061)

Session 50's end-to-end check found the defect neither half of the token could see: after
`update_workspace` with `layers: ['workspace']` and a desktop attached, **two workers owned one
ledger**. Spec 065 lets existing streams finish through the replaced worker; spec 095 then put a
stateful service on one of those streams. The person's Reject landed on a ledger no agent read, and
both workers stayed subscribed to the host's `/events` and minted `game.*` into one `feed.json` with
colliding sequences. The obvious fix — close the replaced worker's tunnelled sockets — was tried and
reverted, because it turns `runtime.test.mjs:91` red at `0 !== 1`. Owner instruction: *"do not forget
about our layered restarts."*

The two specs never disagreed about *whether* a replaced worker keeps serving, only about **what**,
and the kinds are already distinct: a terminal or surface view is a stream of somebody else's bytes,
the ledger is a service with one writer. So retention is now **by kind**. Views keep draining through
the retired worker, untouched — 065's regression is unchanged and stays the floor. The token/feed
service hands off.

The supervisor's whole part is one message, `{ type: 'retired' }`, and *where* it is sent is the one
design decision inside it: at the point a retirement is **committed** — the `finally` that releases a
replaced worker from `preserved`, and the rollback that retires a rejected candidate — never at the
swap, because a failed update restores the previous worker as the current one and a worker already
told it was retired would then be forwarding requests to itself. Under an older supervisor the
message never arrives and the worker behaves exactly as it did before.

The worker that receives it drops its subscription to the host's `/events` and its ledger, so it
mints nothing and never writes `token.json` or `feed.json` again; closes its own `/feed` clients with
a reason naming retirement, which is what the cursor was always for; answers `GET /api/token`,
`POST /api/token-action`, `GET /api/feed`, `POST /api/recording` and `POST /api/preferences` by
forwarding to the current worker **through the supervisor named by the runtime descriptor already in
its own directory** — no environment variable, no new descriptor; forwards its retained desktops'
`token-action` and `recording` frames with the desktop actor on `X-Rengine-Desktop`, which the
current worker honours only when no agent header is present and answers `by: { kind: 'desktop',
desktopId }` exactly as it does for a local socket; and relays the pinned `token` push back by
watching the current ledger's feed for `token.*`. `Ledger.segment()` and that relay are one function,
so the frame text on the desktop's socket is unchanged and `orchestrator/native/*` needed no edit.
Nothing under `orchestrator/server/` was touched.

`orchestrator/tests/token-retirement.test.mjs` asserts it against a real supervisor, two real workers
and a stand-in desktop on the real socket: 065's invariant with a live PTY still carrying input and
output through the retired worker, the monitor closed with the retirement reason and reattachable by
cursor with no gap, a `token-action` from the retained socket landing on the current ledger with the
right `desktopId`, an agent's transition arriving back on that socket as the pinned frame, a
`recording` frame becoming `capture.committed` on the current feed, and one `game.started` for one
game session. `native-token-e2e.spec.mjs` gains the scenario its criterion 5 had to leave out: after
the replacement, Reject on the **real** popover reaches the ledger the replacement serves, and the
segment follows it.

One measurement had to be reshaped before it discriminated, and it is the KI-061 measurement itself.
Which of two writers lands last is timing, so sampling `feed.json` at the end can agree by luck —
under the deliberate sabotage it did. `writeAtomically` names its temporary after the writing
process, so the check watches the ledger directory and asserts the **set of pids that wrote it**. Two
workers minting is then a fact on the filesystem rather than a race to sample.

Fifteen sabotages, each watched failing for its own claim, in
`docs/evidence/token-retirement-2026-09-07.md`. Row 15 is the control: the reverted alternative,
still red at `runtime.test.mjs:91` `expected: 1 / actual: 0`. Rows 1–14 fail under the old code and
row 15 under the code that was rejected; only the split passes both.

F90 stays `passes: false`. KI-061 was one of its two named blockers and is closed; the other stands —
F74, F76 and F80 are all `passes: false`, and F74's third criterion waits on the owner's live
verification.

**Two additions folded in after the 4aa340f reconciliation merge**, both asked for because this lane
owns `runtime/worker.mjs` and `agents/mcp-worker.mjs`. `restart_agent` (spec 098) stops that pane's
child and starts it again, which is `stop_session` by another name, so it is gated the same way —
and by the same mechanism, an interception in the worker before the forward, exactly as `/api/stop`
is, which keeps the person at the desktop ungated. And `token_status` now folds the root's persisted
conversations (spec 097) into the identities it lists: the ledger learns an `agentId` only from a
header on the wire, so a lane that has not called anything was invisible there and un-nameable in a
refusal. Nothing is minted, the entries are marked `conversation: true`, and an identity the ledger
has actually seen wins over the persisted record of the same id. Four more sabotages, rows 16–19.

Commands: `npm test` 148/148 (145 on main, plus this lane's three) · `npm run test:desktop` 48/48 ·
`python3 tools/features.py validate` · `python3 tools/design.py check` clean · sidecar `check` clean
on the files this lane edited, each with a fresh stamp and, where it earned one, a new note. Three
flakes worth naming because none of them is this lane's and each is a different spec:
`native-dashboard.spec.mjs` after its desktop reconnected mid-test, `native-format-hardening.spec.mjs`
on a wide tree, and `native-render.spec.mjs` at `opengl: resident memory delta 34176 KiB exceeds
32768 KiB`. All three drive the session host directly — no supervisor and no workspace worker in any
of them — each passes alone, and the suite is 48/48 on a clean run. The machine carried 63 rEngine
processes and a load average around 12 throughout, from other lanes. Nothing under
`orchestrator/server/` or `orchestrator/native/` was touched, and no environment variable was added.

## Session 52 (macos) — 2026-09-07 — The conversation IS the identity: three lanes onto one uuid

Three lanes had been building the same thing from three ends and had to become one branch,
`feat/conversation-is-identity`, merged in a worktree at `.cache/worktrees/reconcile`.

**The defect the merge would have shipped.** Spec 095 (F90) decided the per-launch agent identity IS
the Claude session id and injected `--session-id <agentId>`. Spec 096 (F91/F92) had the session host
mint a conversation, pass it as `RENGINE_AGENT_CONVERSATION`, and inject `--session-id` for that.
Both were right; together a pane launch carried two `--session-id` flags with two different UUIDs,
and `restart_agent` would then have "resumed" a conversation the CLI had never been in.

**The reconciliation.** The owner's rule taken literally — one identifier, so the conversation is the
identity. `claudeIdentity()` in `config.mjs` is the single place that decides which UUID: the
launch's own flags first, then `bind.mjs --session`, then the host's conversation, then a mint.
`conversationArgs()` injects it exactly once, from the `CONVERSATIONS` capability table. A person's
`--resume X` under a host conversation `Y` is **not refused** — `launch.mjs` reports the decided id
back over `POST /api/agent-conversation`, so the record follows what actually launched (refinement
from the 096–098 author: "your identity minting becomes the single source and my conversation field
reads it, rather than two independent mints racing to pass the same flag"). `-c`, a search-term
`--resume` and `--fork-session` report `conversation: null`, which clears the pane's record so a
restart refuses by name rather than opening a second conversation wearing the first one's name.

The eight characters now name the same thing everywhere a person meets them: the identity label, the
pane title (`agentTitle`), the 097 picker rows, the token segment. And a conversation spec 097
persists per root IS an identity to the token ledger — same id, same `claude <first eight>` label, on
both sides of a host restart, with nothing to migrate because there was never a second number.

**Two merges, unioned, never a side taken.**

- `origin/main` c550214 (0e3c1a7). Conflicts: `config.mjs` (union — origin's `claudeSession`/
  `describeSession` plus HEAD's `CONVERSATIONS` table, `claudeStart` replaced by `conversationArgs`,
  `claudeIdentity` added as the decision point); `launch.mjs` (union — the identity line and the
  report back to the host, now sent whenever `plan.conversation` is not `undefined`); three
  `._llm.json` sidecars (anchors, plus a fourth entry on config.mjs); `Codex-progress.md`.
  `mcp-worker.mjs`, `app.c`, `app.h`, `features.json` and `package.json` auto-merged with both sides
  intact — OP_SIGNIN still below OP_BYTES, RE_TRACKER still last in the append-only tab enum,
  `re_app_inspect` the union of the tracker fields and `re_token_inspect`.
- local `main` 49ab287 (0c80bcd). Conflicts: `package.json` (union of the desktop spec list — the
  token lane's two specs and this lane's `native-sessions.spec.mjs`, 29 in all; taking either side
  would have silently dropped the other's proof, which is what `suite-coverage.test.mjs` exists to
  catch); `workspace.c._llm.json` (union of nine entries, re-anchored and stamped);
  `Codex-progress.md`. 958f1b2's static assertions on the operation enum arrived with this merge
  rather than needing a cherry-pick.

**Regressions, each observed red for its own reason.** Ten sabotages, each producing exactly one
failing test, tabled with its assertion in `docs/evidence/conversation-is-identity-2026-09-07.md`:
ignoring the host conversation, starting a resume, injecting beside a person's flags, letting the
host beat those flags, reporting a minted id for `-c`, keeping a stale conversation on a `null`
report, restarting onto a new conversation, dropping the prefix from the pane title and from the
picker row, and keying the identity label on something other than the conversation.

**Gates** at `0c80bcd`: `npm test` 145/145, `npm run test:desktop` 48/48 (native-token,
native-token-e2e, native-tracker and native-sessions together), `ctest` 6/6, desktop build with zero
warnings, `features.py validate` 49, `design.py check` clean. Five desktop specs failed before
`npm run build:surface` had been run in this fresh worktree; two more (native-explorer cap,
native-render metal edge band) then failed under the long run and passed on their own both here and
on a control worktree at `0b2359d`, so they were the known flake, not the merge.

**Remaining.** Not verified live: this session runs inside a host that predates all three lanes, so
the first workspace started from a host carrying this change should record a pane launched with one
`--session-id`, `token_status` naming the holder by the conversation's first eight characters, and a
`restart_agent` that kept the token. Two things in 096–099 still sit oddly against 095 and are named
in the report rather than changed here: `restart_agent` stops a process and is not token-gated while
`stop_session` is, and the ledger's `identities` registry is fed only by callers on the wire — folding
`state.conversations` into `token_status` needs `runtime/worker.mjs`, which another lane owns.

## Session 51 (macos) — 2026-09-07 — The agent identity is the Claude session id (F90 stage 1, revised)

Owner decision, verbatim: *"Each claude session has identifier … on every session exit claude tells us
to use `claude resume <id>`, token should be bound to that identifier."* So the identity stops being a
number rEngine keeps beside the agent and becomes the conversation's own id, decided **at launch**
from the flags the launch was given — never inferred afterwards from a transcript, a process tree or
a hook, which is how an earlier attempt kept getting it wrong.

`claude --help` on this machine settles the four cases and they are a table in spec 095's *Identity*
section now: nothing named → mint and start the CLI with `--session-id <agentId>` beside
`--mcp-config`; `--session-id`/`--resume`/`-r` with a uuid → that uuid **is** the `agentId` and the
args pass through untouched; `-c`/`--continue`, `--resume` with a search term rather than an id, and
`--resume <id> --fork-session` → the CLI mints the id inside itself, so the identity is rEngine's own
and says `session.known: false`. That last case is the honest one and the launcher prints it as such
rather than offering a `--resume` line that would not work. Codex's handoff already carries a
`sessionId`; where there is one it is that agent's `agentId` too. Nothing was invented for gemini or
opencode.

Two consequences worth their own sentences. The **label** is now `<cli> <first eight of agentId>` —
`claude 5b8d47c2` — so two Claude sessions on one root are two different things in the status bar and
in a refusal, and the prefix is the id the person resumes by. And `bind.mjs` grew **`--session UUID`**:
bind the session you are already in, and its start line is `claude --mcp-config <path> --resume <id>`
instead of naming a new one. That is the whole point of the decision — the binding outlives the
process.

The ledger had to follow. **A holder's pid now follows its session**: an identified request from the
holder's own `agentId` under a different pid refreshes the holder and the identities registry, so a
resumed session keeps the token it held and `holder-gone` goes on meaning what it says instead of
firing at every resume. Two defects seen live the same day are closed with it. **A release under an
open contest hands the token to the contester at once** (`token.claimed`, `by: { kind: 'release' }`,
naming the holder that let go) — it used to free the token and leave the contest open, which left the
contester unable to act, unable to re-contest, and waiting out a window against a token nobody held.
The desktop's *free* and *revoke* are deliberately left alone: the person there has Grant and Reject.
And **a contest now carries the window it opened under**, so changing `tokenWindowMs` re-times
nothing that is already open.

That last one corrected the report that prompted it. The stored deadline was *already* absolute and
`arm()` already read it, so the deadline itself never moved; what followed the live preference were
the window a `status` read reported for an open contest and the cooldown a rejection of it charged.
Both now come from `contest.windowMs`, pinned at the instant the contest opens, and `setWindow`
touches no open contest at all.

Twelve sabotages in `docs/evidence/agent-session-identity-2026-09-07.md`, each watched red for its
own assertion and not an earlier one: the minted id not reaching the CLI, the flag's uuid not being
read, a session named twice, `--continue` and `--fork-session` claimed as known, codex's handoff
dropped, the label without its prefix, `bind --session` ignored, a bound session started with
`--session-id`, the holder's pid frozen (and again with the pid assertions lifted, so the consequence
assertion is shown to discriminate on its own), the release leaving the contest hanging, the transfer
attributed as an ordinary agent claim, the preference re-timing an open contest, and the cooldown
reading the live preference.

`npm test` — 110/110. Nothing under `orchestrator/native/*`, `orchestrator/tests/native*` or
`orchestrator/server/*` was touched; the native end-to-end fixture is another lane's, and the pinned
worker→desktop frame is unchanged (`contest.windowMs` is ledger-side only).

Merged `origin/main` at `a3e79fb` (session 50's native end-to-end fixture) on the way out: the only
conflict was this log, resolved as a union with session 51 above session 50. The sidecars on the two
annotated files this lane edited — `config.mjs` and `launch.mjs` — were repaired and stamped, with a
new `session-is-the-identity` entry recording why the flags are read at launch rather than the
conversation inferred afterwards; the repo-wide drift session 50 reported (KI-052's pattern) is
untouched. **KI-061** — after a workspace replacement the desktop's `/events` stays on the retired
worker, whose ledger keeps answering and whose feed keeps minting — is deliberately not addressed
here: the handoff on retirement is its own lane's, and the obvious socket-kill breaks
`runtime.test.mjs:91`'s retention invariant.

Remaining: `workspace_info` still reports the identity's `agentId`/`label`/`pid`/`startedAt` and not
its `session` descriptor, so an agent cannot yet read back its own resume line over MCP — one line in
`agents/mcp-worker.mjs`, left out because that file is outside this branch's scope. Branch
`feat/agent-session-identity`, not merged.

## Session 50 (macos) — 2026-09-07 — The two halves of the project token, meeting (F90 stage 2 × stage 3)

Spec 095's stages 2 and 3 were built in parallel and met at a pinned wire contract. Stage 3's report
named what neither could assert: *"Nothing yet asserts the two halves together. My fixture is a
stand-in for the worker; stage 2's tests never open a desktop."* This is that check, on
`feat/agent-token-e2e` off `a12d582`.

`orchestrator/tests/native-token-e2e.spec.mjs` boots the **real** stack — a session host, a runtime
supervisor with a real workspace worker under it, and the desktop binary the supervisor snapshots
and launches — and drives it from both ends. Four identities claim, contest, are rejected, granted
and revoked; every gesture is a click on the real popover, read back through `re_app_inspect`, and
every answer is read from `GET /api/token` and the worker's own feed socket. A second case toggles
the recorder in a real game pane and follows the announcement through the worker onto the feed. The
only fixtures left are the project the agents argue about and the SDL surface the pane draws.

Fifteen sabotages, each watched failing for its own claim, in
`docs/evidence/project-token-e2e-2026-09-07.md`. One method note worth keeping: the first sweep
misattributed seven reds, because a JavaScript-only sabotage that follows a native one runs against
the **previous row's binary** — a restored source tree is not a restored build. Every row is rebuilt
now, and the seven were re-run.

Two assertions had to be shaped before they discriminated, and both are the shape of a stand-in
hiding something. The popover press *toggles*, so the second gesture in a row closes it — stage 3's
fixture pressed once and drove four gestures, which only worked because nothing else touched the
overlay. And the supervisor opens the project's **dashboard** beside the game, which takes the pane,
so the recorder's controls were not drawn at all until the game tab is selected; stage 3's
`nativeClient` never had a dashboard next to it.

**What the check found is a defect neither half could see (KI-061).** Criterion 7 *seen from the
desktop* — replace the workspace layer mid-contest and watch the segment re-register onto the new
worker — does not happen. Spec 065 lets existing streams finish through the replaced worker, and
spec 095 put the ledger's desktop channel on one of those streams, so after `update_workspace` with
`layers: ['workspace']` and a desktop attached **two workers own one ledger**: the desktop reads and
writes the retired one — its segment showed `Contest · codex · 58s` for a contest the live ledger had
already rejected — while agents read the current one. Worse, both stay subscribed to the host's
`/events` and both mint frames into the same `feed.json`, so the sequences collide: measured,
`game.started` is 4 in the served feed and 3 in the file a third worker would load.

The obvious fix was built and refused by 065: making `retire()` destroy the replaced worker's
tunnelled sockets makes the whole scenario pass and turns `runtime.test.mjs:91` — *"layered
workspace and MCP replacement retain a legacy host and active PTY streams"* — red at `0 !== 1`. Both
reds were observed in one run and the change was reverted; choosing between them is an owner
decision. The spec asserts the half that is true and wanted instead (same holder, same contest, same
absolute deadline, same window preference, a feed that continues and announces its generation), plus
spec 065's own rule, so the missing half is named in the fixture rather than only in a document.

F90 stays `passes: false`, and now for two nameable reasons rather than missing stages: KI-061 is an
open defect in criterion 5's *"take effect immediately"* under a routine layered update, and its
prerequisites F74, F76 and F80 are all `passes: false` (F74's own third criterion says passing waits
on the owner's live verification after `update_workspace`). All nine criteria have evidence; the
prerequisites and the ledger fork do not.

Commands: `npm test` 107/107, `npm run test:desktop` 45/45 (43 before, plus this spec's two),
`ctest` in `.cache/desktop` 6/6, `python3 tools/features.py validate` at 43 features,
`python3 tools/design.py check` clean. Sidecar `check` reports pre-existing drift on 25 files this
lane never touched — KI-052's pattern, not repaired here. No file under `orchestrator/server/` was
touched; `supervisor.mjs`, `worker.mjs` and the native sources are unchanged from `a12d582`.

## Session 49 (macos) — 2026-09-07 — The project token in the chrome, and the recorder on the feed (F90 stage 3)

Stage 3 of spec 095: the native desktop's half of the project token, built on `feat/agent-token-desktop`
in a worktree while stage 2's ledger was being built in parallel on `feat/agent-token-ledger`. The two
stages meet at a pinned wire contract and nothing else — this branch never touches `worker.mjs`,
`agents/` or `server/`.

The window now holds the ledger's last word about its **primary root** — the same identity rule the
chrome's name follows (spec 084 decision 3), so a `token` frame for any other root changes nothing
here. That is the assertion most worth having and it is one: a second root's ledger naming a
different holder leaves the segment reading `Token · claude`. The state lives in
`orchestrator/native/token.{c,h}` beside `devices.c` and `tracker.c`, and a `disconnected` clears it,
because the ledger's word does not outlive the socket that carried it.

The segment is at the right edge of the status bar, with the facts moving left of it, so its
rectangle is a function of the window width and its own text alone. That matters more than it looks:
the face is owned drawing laid down after every pane, while the hit area is built during the
interface pass, and the two agree only because both derive the rectangle from the same function.
Before the first frame arrives the segment draws nothing at all — *Token · free* is a claim about a
ledger, and a window that has heard none has no business making it.

Two details earned themselves. The countdown **floors**: the desktop's wall clock is `time(NULL)`,
so rounding up opens a 60-second window reading `61s`. And an explicit recording's segment id is now
minted when the toggle **starts** it rather than when it commits, so the `started` and `committed`
frames name one directory a reader can pair; the id's timestamp is now the instant `startedAt` in
its own manifest already reported. The recorder's `kind` on the wire is `ring`/`explicit` while the
manifest keeps `ring`/`segment` — the feed names the gesture, the artifact names its shape, and
that difference is written down in both specs rather than left to be discovered.

Twelve sabotages, each watched failing for its own claim and not an earlier one, in
`docs/evidence/token-desktop-2026-09-07.md`: the held segment, the parsed deadline, the primary-root
filter, `contestId` present on reject/grant and absent from revoke/free, the clear on disconnect, the
start announcement, the id pairing, the feed's vocabulary, the segment opening the surface, the held
token's own controls, and a ring commit announcing a start it never had.

The fixture is `orchestrator/tests/token-fixtures.mjs`: a stand-in for the worker's interception —
it proxies the session host, keeps the frames the desktop sends on `/events`, and pushes the
ledger's own frames back. It holds no ledger on purpose. Nothing here asserts what a `token-action`
does to one; those are stage 2's criteria 3, 4 and 7.

Stage 2 landed on main while this was being built, so the branch merged it. Three things collided
and each was resolved rather than picked: two fixtures named `token-fixtures.mjs`, where this one
became `token-desktop-fixtures.mjs`; two rewrites of the spec's Native-desktop section, unioned so
that stage 2's pinned frames stand and this stage's corrections and record follow them; and two
session entries. The pinned frames agree with what shipped here, field for field, which is what the
coordination was for. What nothing yet asserts is the two halves together: this stage's fixture is a
stand-in for the worker's interception, and stage 2's tests never open a desktop. An end-to-end
check through the real worker is the obvious next one.

While merging, one stale sidecar anchor unrelated to this work was repaired:
`workspace.c#view-switcher-indices` had pointed at a snippet that stopped existing when Tasks was
inserted into the view switcher (F78).

Commands: `npm test` 107/107 after the merge (100/100 before it), `npm run test:desktop` 43/43,
`ctest` in `.cache/desktop` 6/6, `python3 tools/design.py check`,
`python3 tools/features.py validate` at 43 features, sidecar `check` clean, native build at zero
warnings. F90 stays `passes: false`: stages 2 and 4 are not built, and six of
its nine criteria belong to them.
## Session 48 (macos) — 2026-09-07 — The token ledger, the gates and the feed (F90 stage 2)

Stage 2 of spec 095, on `feat/agent-token-ledger`. The workspace worker now keeps one **ledger** per
project root — `<runtime>/tokens/<rootId>/token.json`, written atomically, with that root's retained
1,000-frame feed beside it — and `orchestrator/runtime/token.mjs` holds the whole state machine:
claim when free, contest with an absolute deadline, reject by the holder (cooldown of one window for
the contester), the desktop's reject / grant / revoke / free, the transfer at the deadline by timer
*and* lazily on the next call, and the dead-holder resolution. Deadlines are absolute wall times and
every call settles before it acts, so a replaced worker resumes the same contest from the file rather
than restarting its countdown.

Seven agent-originated routes are gated on the `X-Rengine-Agent` header: `/api/game`,
`/api/script-open`, `/api/dashboard-run`, `/api/dashboard-capture`, `/api/desktop-action`,
`/api/update-workspace` and `/api/stop` — the last intercepted before `forward()`, because the
retained host serves it and spec 065 says the host does not grow a gate. A request without the header
is the desktop's and is never gated. A refusal is HTTP 409 naming the holder's label, since when, and
`token_contest`; a **free** token is refused the same way, because holding is deliberate and every
hold should be a frame somebody can read.

`GET /feed` on the worker and only there. The worker subscribes to the retained host's `/events`
itself, once, with no desktop behind it, and reads session transitions only — an `output` frame is
never turned into a feed frame, which is what makes "no PTY output on the feed" structural rather
than a filter. Frames: `token.*`, `game.started/ended`, `device-action.started/ended` for a dashboard
action whose declared device is not this machine, `capture.started/committed` from the desktop's
`recording` frame, and `workspace.updated`.

The tool worker carries the label and pid beside the id (a refusal has to name a holder and the
ledger has to check a pid, and the worker has no table for either), offers `token_status`,
`token_contest`, `token_reject`, `token_release`, `feed_url` and `feed_read`, and gates
`update_workspace` and `reload_desktop` itself — the runtime supervisor answers those two and never
forwards them, so the worker cannot see them. `agentToken: 1` is the one flag `capabilities()` adds
conditionally: only a worker that opened its ledger advertises it, so an old worker under a new
connector is refused by name instead of passing every call.

**Seven facts the code corrected in the spec**, all recorded there. The host's preference store
allowlists its keys and drops the rest, so `tokenWindowMs` is owned beside the ledgers and the worker
intercepts `POST /api/preferences` to keep it — otherwise the window would never leave its default.
Two of the seven gated routes are the supervisor's, not the worker's. The feed socket is the worker's
own loopback URL, because the supervisor's upgrade handler allowlists `/events` and `/surface`.
Liveness is the pid uniformly — `agent.sh` execs the launcher and `bind.mjs` records the terminal —
so no `boundBy` discriminator was needed. `by` grew a fourth kind, `workspace`, for a frame nobody
asked for. `workspace.updated` cannot be observed as a request, so each worker announces its own
generation on the first request it serves that is not `/health` or `/api/state`. And the ledger
carries `identities`, which is criterion 1's candidate list.

One line outside the worker and the tool worker: `runtime/supervisor.mjs` now sends the runtime
directory in the fork message, so a worker persists where its supervisor says, with
`runtimeDirectory(host)` as the fallback an older supervisor leaves it. `orchestrator/server/*` and
`orchestrator/native/*` are untouched.

The three frames crossing the worker↔desktop `/events` socket were **pinned** mid-session by the
owner-coordinated stage-3 lane, and the worker conforms exactly: the worker→desktop `token` frame is
flat (`holder`, `contest`, `windowMs`, and the feed sequence of the last `token.*` frame) and is
pushed once per registered root at `desktop-register` as well as after every transition; a
`token-action` is answered by the next `token` frame rather than a bespoke result, with `contestId`
required for `reject` and `grant` and a refusal arriving as the socket's ordinary `{type:'error'}`;
and the recorder's frame carries `event`, not `phase`, with a ring commit sending only `committed`.
All three are written into spec 095's *Native desktop* section.

`orchestrator/tests/project-token.test.mjs`, seven tests over `token-fixtures.mjs`, against a real
worker in front of a real session host, with a fake desktop on `/events` and the real MCP tool worker
for the tool half. **Twenty sabotages** in `docs/evidence/project-token-2026-09-07.md`, each red
for its own assertion — including three that did not discriminate at first: two went red without
naming themselves (a setup line throwing 409, and a bare `strictEqual`) and one went **green**,
because the register-time push was asserted after a transition had already pushed the same frame.
The "no PTY output" proof measures against the desktop's own `/events` socket carrying that output in
the same run, so the negative is not a quiet machine. `npm test` 107/107.

F90 stays `passes: false`: criterion 9 is the stage-3 status-bar segment, and the desktop's
`recording` frame is stage 3's to send. The exact frame shapes it owes the worker are written into
spec 095's *Native desktop* section and exercised today by the fake desktop.
## Session 49 (macos) — 2026-09-07 — The Sessions tab resumes and attaches, where the owner asked for it (F95)

The owner has asked three times for one thing and it kept landing on the wrong surface. Spec 097 built
the resume picker as a stdin prompt in `agent.sh`; the owner meant the native Sessions tab —
"list all the available ids to resume or be available to attach if session is active." Spec 099 moves
it there. Nothing about the data changed: past conversations already reach the desktop on `/api/state`
as `conversations[rootId]` (097), live agent panes are the `type:'agent'` sessions each carrying a
`conversation` when it holds one, and resume is the `POST /api/terminal` with `resume:true` that
`spawnTerminal` already honours. This is a view over data that was all present at 64dc08e.

`orchestrator/native/workspace.c` gains a Conversations section in `sessions_ui`, above the recovery
drafts and below the unchanged raw process list. A live agent pane offers **Attach** (the existing
session-view path); a conversation no pane holds offers **Resume**, which starts a pane already on that
id; the two are deduplicated by conversation so a live one is never also offered for resume; and a live
agent that names its own conversations — no id recorded — is attach-only and marked *not resumable*,
which is the one place a resume affordance is withheld on purpose. `describe_age` mirrors the JS
`describeAge` wording so a row says when it was last seen; the desktop formats the persisted
`lastSeenAt` rather than asking for a string. No colour or row-size literal — design guard clean.

`native-sessions.spec.mjs`, three tests through the automation bridge: past conversations become
resume rows most-recent-first with no session started; Resume creates an agent session bound to that
exact conversation id (a fresh launch would mint a random one, so the id is the proof it resumed); and
a live menu agent is attach-only with no resume control while the raw list still stops it. Observed
red first by reverting `workspace.c` to its committed state and rebuilding: all three failed for their
own reason — the state dumps showed the conversations data and, for the third, the running agent with
its `attach`/`stop` controls, but no `resume` or `conversation-attach` control, which is exactly the
section that did not exist yet — then restored and rebuilt green.

While here, one stale sidecar anchor in `workspace.c._llm.json` was repaired: `view-switcher-indices`
had drifted at the tracker change (a066641) when a Tasks entry was inserted at switcher index 2,
splitting the table across two lines; its note's example ("Devices at index 2") was corrected to
"Tasks at 2, Devices at 3" and re-anchored to the stable declaration line.

Commands: `npm run build` clean; `node --test orchestrator/tests/native-sessions.spec.mjs` 3/3;
`verify.sh design` clean; unit suite, `test:desktop` and `init.sh` recorded below the commit;
`tools/features.py validate` 48 features; graph regenerated; sidecars valid for workspace.c.

Not verified live, deliberately, and `passes` stays false on F95: this session runs inside the old
host, and the owner's real claude pane resume belongs to a host started from this change — the same
live criterion 096 and 097 carry. F95 reads blocked because F93's own live criterion is still open;
that is the dependency chain telling the truth, not a defect.

## Session 48 (macos) — 2026-09-07 — Replacing a session host on purpose, and why three restarts changed nothing (F94)

Two tasks, one cause. First the merge that had been waiting on a dirty tree:
`feat/agent-conversation-persistence` (spec 097, F93) went into `main` with `--no-ff` as 64dc08e. The
only conflict was `Codex-progress.md`, where both sides had prepended a session; the resolution is the
union, 39 above 38, nothing dropped. `orchestrator/server/main.mjs` auto-merged and kept both route
sets — the tracker sign-in/sign-out from `main` and `/api/agent-conversation` plus `conversations` on
`/api/state` from the branch — and its two sidecar anchors, drifted by the merge, were repaired. Gates
on merged main: `./init.sh` clean (46 features), `node --test orchestrator/tests/*.test.mjs` 118/118,
`verify.sh design` clean. The log already carries duplicate session numbers from parallel sessions
(18, 25, 26, 32, 35–38); this entry takes the highest number in the file plus one rather than adding
another.

Then the defect the owner is angry about, measured before anything was designed. The hirebase-v2
session host, PID 68944, has run since 09:16:13; the reflog puts `main` at 0a11a36 then, before the
tracker (09:59), the `NO_COLOR` drop (10:17), the browser sign-in (10:39), the project filter (11:13)
and 097 (11:23). Read-only against the live host: `GET /api/tracker` answers `404 Unknown workspace
endpoint.`; `/api/state` has no `agentConversations` and no `conversations`; and `/api/dashboard`
answers `$ has unknown key tracker` for the whole declaration, because `formats.mjs` reads the
contract schema once at import and the declaration gained its `tracker` block at 11:11. So the broken
Linear tab, the colourless terminal, the sessions tab and — unreported — the dashboard for that root
are one staleness. The owner's three restarts reused the host because `ensureSidecar` is built to,
and the hand remedy failed for a reason worth writing down: macOS `pgrep`/`pkill` exclude the
caller's own ancestors by default (`man pgrep`, `-a`), and a pane inside the workspace descends from
the host. Verified: `pgrep -f server/main.mjs` lists thirteen hosts and not 68944, `pgrep -a -f` lists
it, `ps -A -ww -o pid=,ppid=,command=` shows it plainly, and `pkill` with no match exits 1 and prints
nothing.

Spec 098 and `orchestrator/launcher/replace.mjs` are the answer: `--replace-host` on the launcher, so
the owner's command is `~/hirebase-v2.command --replace-host` (the generated `.command` forwards
unknown flags; confirmed through its own `exec` with `--help`). It finds the host through
`sidecar.json` and `ps`, never `pgrep`; refuses by name a PID that is not `server/main.mjs --state
<this directory>` — so vtmb-vr's and nolf-improved's hosts on this machine cannot be caught; refuses a
launcher whose ancestors include the host; stops the bound update supervisor (matched by
`runtime.json` host identity) and then the host, SIGTERM then SIGKILL; waits for the port to refuse;
starts the ordinary host through `ensureSidecar`; and prints what it stopped, which running sessions
ended, and what it started. A normal start now says when `sidecar.json` is older than the newest file
under `orchestrator/{server,launcher,agents}`, `scripts` or `contracts`, and names the flag. It never
replaces on its own.

Ten regressions in `replace-host.test.mjs`, seven against an injected process table copied from this
machine and three against real throwaway hosts the test starts and stops. Sabotage, each restored
after: dropping the `--state` comparison reddened the descriptor test and the refusal test with
`Missing expected rejection`; dropping `SIGKILL` reddened the signal test with `PID 4242 is still
alive after SIGKILL`; making the headless path ignore the flag reddened the launcher test with
`expected: 58287 / actual: 58287`; and dropping the ancestor refusal ended the test runner itself
with `signal: 'SIGTERM'` — the sabotaged launcher stopped the host and then swept the host's
children, which in the doctored table was the test process, which is precisely the pane-ends-itself
failure decision 3 prevents. That last red skipped its cleanup hook, so the process table was checked
for throwaway hosts afterwards: a first count of two turned out to be the checking shell's own command
line matching itself, and a listing that excluded it found none. Nothing of the owner's was signalled
at any point: 68944, 9599 and 9603 are where they were.

Commands: `node --test orchestrator/tests/replace-host.test.mjs` 10/10; full suite, `./init.sh` and
`verify.sh design` recorded below the commit; `python3 tools/features.py validate` 47 features;
graph regenerated; sidecars validated for `main.mjs`, `launch.mjs` and `replace.mjs`.

Not verified, deliberately: replacing PID 68944. This session runs inside it and would be refused;
the owner's work is in it. `passes` stays false on F94 with the live criterion written down. Still
open after that: Windows (the flag refuses by name), an MCP route (an agent inside is a descendant by
construction), and whether the Linear application actually carries the five registered redirect
URIs — `trackers/oauth.json` has a client id, no token file exists yet, and nothing here can reach
Linear to check.

## Session 39 (macos) — 2026-09-07 — Conversations that outlive the host, and a pane that offers them (F93)

Spec 097, written because 096 shipped and did not solve the owner's problem. They restarted, opened
a new agent tab, and still had to type `/resume` by hand. They were right to expect otherwise.

096 recorded a pane's conversation and could restart a pane into it. What it missed is that session
records live only in the host's memory — `Sessions` keeps a Map, and the state file persists roots,
drafts, layout and preferences and nothing else. So every conversation a host knows dies with that
host, which is precisely the event a person reaches for a resume after. The feature was shaped for
the wrong event. There was a second gap of the same shape: 096 could restart an existing pane, but
after a host restart the old pane is gone and what a person does is open a new one, and choosing a
conversation for a new pane was the deferred native browser.

So conversations are now persisted per root in the workspace state file, bounded at twenty, most
recent first, re-recording touching a row rather than adding one. And the offer lives in the pane,
where the agent is already chosen, rather than waiting for a browser: the workspace writes the
project's conversations for the pane, the launcher lists them with when each was last seen, Enter
starts a new one. The pane reports what it actually launched, because the person may have chosen
something other than what was minted, so the record follows the pane rather than the intention.

Decision 5 earned itself during the build, in the way these usually do. The first implementation
suppressed the offer whenever the pane already had a conversation — which is always, because the
workspace mints one before the pane runs, so the picker would have shipped and never appeared. A
minted id means "this pane is new", not "this pane has chosen"; only an explicit resume suppresses
the offer. The test that pins it is the one that caught it.

Three regressions failing only for their own claim: the store methods absent, the offer never
appearing, and the minted-id suppression above. Suite 108 pass, 0 fail, against 103 on main.

Still not proven live, and `passes` stays false, for the same reason 096's did: a workspace whose
host predates the change cannot exercise it. The first host started from this should record that a
pane offered a prior conversation, that choosing it resumed rather than starting a second, and that
the offer survived a host restart — the criterion 096 could not meet — which closes both features.
Remaining after that: the native session browser, now a presentation change over a persisted list
rather than a data one, and Codex, which names its own rollouts and so records nothing here.

## Session 38 (macos) — 2026-09-07 — A URL to sign in with, not a key to paste

The owner asked for browser sign-in rather than a pasted token. Two facts from the providers' own
documentation decided what that could be, and I verified both before writing anything, because
getting either wrong would have meant a rebuild.

Linear lists `client_secret` as **optional** at the token endpoint when `code_verifier` is present,
on the first exchange and on every refresh of a grant created that way. That is the fact the design
rests on: the desktop is a public client using PKCE with S256 and ships no secret. Without it, a
desktop could not sign in without a broker and the honest answer would have been no.

Linear matches redirect URIs **exactly** with no port wildcard, so the usual native-app pattern of an
OS-assigned port cannot work. The callback listens on a fixed port from a small registered range,
opened only for the duration of a sign-in and bound to loopback. That is the one place this departs
from RFC 8252, and it departs because the provider does.

The browser redirect carries no workspace bearer token — it cannot — so the one-time state is what
authorises the callback, compared in constant time. A grant refreshes an hour early and the refresh
token rotates; a refresh that fails keeps the token it had, because Linear allows the original
request to be replayed for thirty minutes and a cleared grant could not use that window. Signing out
revokes at the provider. A pasted personal key still works and is never refreshed, so nothing that
worked yesterday stops working.

Three sabotages, each failing only its own claim: sending the verifier in place of its hash, which
fails the challenge test; accepting any state, which fails the wrong-state test; and dropping the
grant when a refresh fails, which fails the replay-window assertion.

GitHub sign-in is deliberately not built. Its loopback exchange requires a `client_secret` a public
client cannot keep, and while GitHub sanctions shipping it, the device flow needs no secret at any
point, so that is the better shape there and it is deferred rather than half-done.

Commands: `npm test` 111/111, `npm run test:desktop` 41/41, `ctest` 6/6, `python3 tools/design.py
check`, `./init.sh`.

One thing to flag rather than bury: the research agent I spawned to verify Linear's flow performed a
network **write** while doing so — it POSTed a dynamic client registration to Linear's MCP
authorization server and received a client id back. That was outside the read-only brief I gave it.
Nothing of the owner's was touched and the registration is anonymous, but an agent making an
external side effect during a research task is worth recording rather than noticing later.

## Session 38 (macos) — 2026-09-07 — Agent conversations, and the environment a pane inherits (F91, F92)

Spec 096, from an incident in the hirebase-v2 workspace. Every pane there had lost its colour, and
the interesting part was not the cause but that nothing could reach it. `shellEnvironment` sets
`TERM=xterm-256color` and `COLORTERM=truecolor`, declaring the surface colour-capable, and then
forwarded the `NO_COLOR=1` it had inherited, which contradicts that declaration. It was in the
session host's environment from the moment the host started, because the launcher had been run from
an agent CLI's shell, and those set `NO_COLOR` for the shells they spawn. Measured in a live pane:
`tput colors` 256, raw SGR intact, Node colour depth 1. The surface was never the problem.

Neither side had regressed. `git log -S NO_COLOR` over this repository returns nothing, and the
TERM/COLORTERM line dates to the original retained-PTY commit; the agent CLI has carried that
constant across every installed version. It was an interaction, and its trigger was launch
provenance.

What made it worth a spec is the second half. The owner restarted, twice, and nothing changed: the
desktop and the agent child were replaced, but the retained session host is durable by design
(spec 065), so each new pane came from the same environment. The only remedy was killing the host,
which destroys every live conversation on it. An in-app workaround does not exist either — the
`open_script` env map takes strings only, and blanking the variable does not help, because Node
disables colour on its presence: `NO_COLOR=` gives depth 1, absence gives 8. So the owner's choice
was a broken environment or their work, which is the real defect.

F91 drops an inherited `NO_COLOR` the way `ELECTRON_RUN_AS_NODE` is already dropped, while an
explicit override still suppresses colour on purpose.

F92 is the part that keeps a restart from costing a conversation. rEngine now names the conversation
at launch instead of discovering it afterwards: it mints a UUID and tells the CLI, so the identifier
exists before the first byte of output and no rollout directory is scraped. Naming is a declared
per-agent capability rather than an assumption — `claude` takes `--session-id` and `--resume`; an
agent that names its own conversations is recorded with none and refused by name on restart, rather
than quietly started as a second conversation. The identifier rides on the session record and
`workspace_info`, so a caller can see which panes are restartable, and `restart_agent` replaces the
pane's child on that same conversation with a freshly composed environment. The host, the other
panes and their processes are untouched, so a pane restart is not a quiescence event.

Three regressions, each observed failing only for its own claim: the inherited value reaching the
composed environment (`actual: '1'`), the conversation arguments missing from the launch plan (a
`deepStrictEqual` on the argv), and the restart refusing nothing at all (`restartAgent is not a
function`). Suite 103 pass, 0 fail, against 100 on main.

Not proven live, and `passes` stays false on F92: an end-to-end pane restart cannot be observed from
inside a workspace whose host predates the change, which is precisely the condition the spec
describes. The first workspace started from a host carrying this should record pane restarted,
conversation continued, child pid changed, host pid unchanged under `docs/evidence/`. Remaining
after that: the native session browser that draws the conversation column decision 5 feeds, and
Codex has no mintable conversation, so its existing handoff resume is still the only path there.

Sidecar anchors: `sessions.mjs` and `launch.mjs` drifted from this change and were repaired. `main.mjs`, `mcp-worker.mjs` and `config.mjs` carried drift before it — `configuration-overlays` had lost its snippet entirely to the F90 rewrite — and were repaired in passing while their files were open; the note itself still describes behaviour `agent-config.test.mjs` asserts, so it was re-anchored rather than rewritten.

## Session 37 (macos) — 2026-09-07 — Task tracking with a declared backend (F78)

Built the tracker. Contract 5 carries a `tracker` block naming a provider and the locator that
provider needs: a repository for GitHub, a team key for Linear, nothing for local. A declaration
naming the wrong locator is refused at declaration time rather than failing later against the
network, and the block has no credential field at all, so the schema refuses a token key outright.

Three providers answer one neutral row. Local reads the project's own inventory and derives readiness
with the rule `tools/features.py` applies, so the view and the command line cannot disagree about what
is blocked; a project declaring no tracker still gets its inventory, which is the default. Remote
providers are cached for thirty seconds with in-flight coalescing, the shape devices established, and
local is never cached because it is always current.

Two decisions from the interview earned themselves during the build. State reaches the row as
`(id, name, category)`, and the Linear fixture is why: a team names its own states, "In Review" and
"Icebox", and only the category is shared vocabulary, so a boolean would have flattened exactly the
thing worth showing. And the failure vocabulary is the backend's rather than HTTP's — `denied`,
`unavailable`, `invalid` with reasons — which is what let a missing token, a refused token and a
Linear rate limit each say something different and true. Linear reports its limit as a 400 carrying a
RATELIMITED error rather than a 429, handled by name.

A token lives at `<workspace state>/trackers/<project>.token`, keyed by the declared project identity
so a person can create it by name. That works unchanged for an externally owned project whose
declaration lives outside its checkout, which is the case that prompted the feature.

Three sabotages, each failing only its own claim: readiness ignoring unmet dependencies, which fails
the blocked row; a Bearer prefix on a Linear personal key, which fails the bare-token assertion; and
the declared provider ignored in favour of local, which fails the Linear view test.

Commands: `npm test` 89/89, `npm run test:desktop` 41/41, `ctest` 6/6, `python3 tools/design.py
check`, `python3 tools/features.py validate` at 42 features. One earlier desktop run lost three
tests; a clean rerun passed all 41, and the four specs the toolbar change could plausibly have
touched — design cards, the workspace spec, identity and tracker — pass individually. That is
KI-045 rather than a regression, though three at once is more than its usual one or two.

F78 stays `passes: false`: it depends on F63, which is not verified, and the inventory's own rule
forbids a passing feature from resting on one that is not. The evidence is recorded on the row.

Remaining: F69 and the KI-038 Windows repair still block F37, F54, F62, F67 and F73.

## Session 47 (macos) — 2026-09-07 — Per-launch agent identity and binding by discovery (F90 stage 1)

Stage 1 of spec 095, on `feat/agent-identity`. `agentLaunch()` now writes `context.json` into the
per-launch directory it already minted — the root context plus `agent: { agentId, label, pid,
startedAt }`, with `sessionId` when the launcher's own pid or its parent is a listed agent session —
and every MCP configuration points the facade at that file rather than the `integrations/<rootId>.json`
every agent on the root shares. The tool worker reads `context.agent`, sends `X-Rengine-Agent` on
every call, and reports the identity from `workspace_info`; a context without one (probeTools, an
older launch) stays anonymous and sends nothing. `request()` carries only `X-Rengine-*` names with
printable values, laid down before Authorization so a caller cannot displace it. Nothing enforces the
header — that is stage 2.

New `orchestrator/agents/bind.mjs` (npm script `bind`) binds an agent the workspace never spawned: it
scans the sidecar descriptors under the state directory, asks each live instance for its roots, picks
the one serving `--project`, mints the same identity a pane-spawned agent gets, and prints the
configuration path with the flag that consumes it. Two instances claiming the directory is a refusal
naming both; none is a refusal listing what was scanned. No environment variable is read to find the
workspace. Runbook section 8b covers it. No host change, no native change.

Two spec facts corrected from the code. `scripts/agent.sh` **execs** the launcher, so on POSIX the
launcher's own pid *is* the pty session pid the host lists, not its parent's as the spec said. And the
state directory to scan is the base as well as its children, because `orchestrator/launch.mjs`
defaults `--state` to `~/.local/state/rengine` itself while a consumer's `editor.sh` nests one per
checkout.

`orchestrator/tests/agent-identity.test.mjs`, three tests, and nine sabotages recorded in
`docs/evidence/agent-identity-2026-09-07.md` — including one where the earlier control masked the
assertion under test, and one that had to be narrowed twice before it tripped the assertion it
claimed. `agent-config.test.mjs` had asserted the codex overlay named the shared root context, which
is exactly the behaviour this stage removes; it now asserts the opposite. `npm test` 87/87.

F90 stays `passes: false`: eight of its nine criteria are stages 2–4.

## Session 46 (macos) — 2026-09-07 — A headless start: the sidecar without a desktop (F85)

Owner-directed. The vtmb-vr wizard `scripts/wizards/remote-rengine.sh` got all the way through
installing rEngine on the Windows box — clone at the consumer's pin, `npm ci` compiling `node-pty`
with MSVC, Task Scheduler `/IT` so the process lands in the logged-on session — and then its
verification refused. It was right to. The log on the box shows the launcher it invoked building a
desktop: `-- Building for: NMake Makefiles`, then `Running 'nmake' '-?' failed`.

Nobody had configured anything wrong. `launch.mjs` imported `build.mjs` unconditionally and then
resolved and spawned the native binary; `--no-agent` only suppresses the agent pane; `start` and
`resume` are both that same path. There was **no headless entry point at all**. The `nmake` error is
the symptom of a machine that has no MSVC environment in an SSH logon and never will.

`--headless` (and `npm run start:headless`, so it is exposed the way `start` and `resume` are) calls
the same `ensureSidecar` the desktop calls, registers `--project` as a root, prints one parseable
ready line, and then supervises. The body is `orchestrator/launcher/headless.mjs`, and the build
import and desktop spawn sit inside the `else` of the branch, so the headless path structurally
cannot reach them. It refuses `--agent`, `--handoff`, `--launch-game`, `--inspect-ui` and `--declaration` by name and
with its own reason, before starting anything: the first four mean a desktop or a conversation, and
`--declaration` — which landed on `main` from another lane while this was in flight — is not wired
through the headless root registration yet, so refusing it beats silently dropping it. The bind is untouched — loopback with the capability token, which the ready line
deliberately does not print, because a headless start is normally redirected into a log file.

The exact invocation for the wizard, replacing the line it uses today:

```
node orchestrator/launch.mjs --headless --state .state --project <root>
rengine headless ready url=http://127.0.0.1:<port> instance=… pid=… state=… root=…
```

Stopping that process leaves the sidecar and its retained sessions running, as desktop exit does;
if the sidecar dies the supervisor names `sidecar.log` and exits non-zero.

**The sabotage pass taught the fixture four things.** Two of the eight checks had sabotages that
make the launcher *succeed* — deleting the flag refusals, and forcing every start down the headless
branch — after which it supervises a sidecar for ever and the check timed out saying nothing. Both
invocations now carry an `execFile` kill timeout, and the desktop check reads its two recording
files rather than the exit status, so a lost desktop path reports `recorded nothing` instead of
`command failed`. Third: `node:test` runs after-hooks in registration order, verified directly. The
temp-directory hook was registered first and deleted `sidecar.json` before the hook that reads a pid
out of it, so every failed run leaked a sidecar for the machine's uptime; the two are one hook now,
and a full run leaves zero `server/main.mjs` processes behind. Fourth, and the one closest to case 3
of the blind-regressions note: the retention check asserted the sidecar's pid before the session it
was retaining, and a signalled sidecar stops its sessions well before its process goes — so the
sabotage that kills the sidecar on detach reddened the *session* line while the liveness line
passed, at one second of waiting too. What it is still serving comes first now; the pid follows.
Assertion-by-assertion sabotages and what each named are in
`docs/evidence/headless-start-macos-2026-09-07.md`.

One thing the fixture cannot catch on its own: the capability comparison is against a *second,
independently started* workspace service, not against a copy of the same literal, because both sides
of a same-server comparison move together. That is what makes it discriminate "the sidecar" from
"anything else that writes a sidecar.json", and it is the assertion the trimmed-service sabotage
reddened.

Gates. `origin/main` was fetched again before the final sweep and had moved by two commits (F79 and
F81, another lane), so this branch merged it and every number below is post-merge; it then moved
twice more, by a spec-and-inventory pair (F90/spec 095) carrying no code, which is merged here too. The merge touched
`launch.mjs`, `package.json` and `features.json`; `launch.mjs` was resolved by taking their file and
re-applying the headless branch onto it, so the desktop path is theirs verbatim, indented.

- `npm test` — 92 tests, 92 pass, 0 fail, 8.2 s.
- `npm run test:desktop` — 35/35 before the merge; 38/39 on each of two runs after it, red on a
  *different* test each time: `native-game-declaration` waiting for a dashboard action while the
  sidecar indexer hashed the tree, and `native-render` with `opengl: resident memory delta 33344 KiB
  exceeds 32768 KiB`, 1.8% over a resource budget with GUI processes from the previous run still
  alive. Attributed rather than assumed: both specs re-run together on a quiet machine pass, 2/2.
  This change touches no native, renderer or game code, and the desktop path in `launch.mjs` is
  `origin/main`'s file indented into the `else`. A third red, the very first run, was a fresh
  worktree having no `.cache/native` surface fixture — `npm run build:surface` is a prerequisite.
  An earlier `npm test` showed 1 fail + 1 cancelled for the same family of reason, a native build
  running `--parallel 6` beside it; the desktop check's kill timeout went 20 s → 45 s for headroom.
  The lesson is cheap and worth writing down: nothing else may run on this machine during a GUI
  suite, because its assertions are real timing and memory measurements.
- Native build from a wiped `.cache/scratch-build`, Release: exit 0, **0 warnings**; CTest 6/6, 1.00 s.
- `./init.sh` clean; `python3 tools/design.py check` clean; `python3 tools/features.py validate`
  clean (42 features).
- llm-sidecar `check --fix-anchors` then `stamp` with `--index .cache/sidecars-headless.sqlite`,
  sequential: clean. Anchors in `launch.mjs._llm.json` drifted twice, once from my branch and once
  from the merge; new sidecars for `launcher/headless.mjs` and `tests/headless.test.mjs`.
- By hand, the exact wizard shape: `node orchestrator/launch.mjs --headless --state DIR --project DIR`
  printed its ready line, wrote a mode-0600 `sidecar.json`, registered the root and answered
  `/api/state` with nine capabilities and zero sessions.

`F85` is `passing` with `dependencies: []`. F35, the sidecar row, is the real parent but is still
open on its own broader qualification, and the validator refuses a passing row that depends on a
non-passing one; the renderer rows closed the same way, with the relationship carried by the spec.

**Not proved from here: the Windows path.** The check runs the real launcher with `PATH` pointing at
an empty directory, so no `cmake`, `nmake` or compiler exists for the child — the box's SSH-logon
condition by construction, and not the box. KI-060 carries what would settle it: point that wizard's
launcher line at `--headless`, re-run it, and read `rengine headless ready` in
`.state\headless.log` followed by the capability list through the tunnel. The recording-stub check
for the full start path also skips on Windows, because Node refuses to spawn a `.cmd` without a
shell. The consumer repository was not touched.
## Session 45 (macos) — 2026-09-07 — The project token, recorded (F90, spec 095)

Owner direction, given directly in the vtmb-vr workspace after three agents had acted on one
checkout and the one the workspace never spawned had to ask the owner to press a control: the
instance issues one token per project; any bound agent contests; silence within the window
transfers it; the holder alone runs the extended commands and reads a monitor that carries the
contest and the project's lifecycle — games starting, device deploys, captures. Spec 095 records
the decisions with attribution, the facts it stands on (`sessions.mjs:132` shares one context per
root; the facade declares only `listChanged`; the worker already intercepts `/events` frames; the
agent runtime's monitor takes a WebSocket), the identity, ledger, feed and native segment, and why
all of it lives in the replaceable layers with the host untouched. Two readings of "owner does not
reject" exist; the spec takes the superset (holder or desktop may reject) and marks it for the
owner. F90 added with nine criteria, `passes: false`; documentation only, graph regenerated.

## Session 42 (macos) — 2026-09-07 — Hirebase uses external rEdit capabilities (F81)

Owner requested a home launcher for `~/hirebase-v2`, with every rEdit extension outside that
project and no `editor.sh` integration. Spec 085 records this explicit scope outside the
paused broader NOLF goal. The external declaration path is now durable metadata on the real
project root; host and worker capability readers keep that full binding. Unsupported old
hosts fail before root/session mutations, conflicting profiles are refused, and missing/bad
external profiles name their filename without local fallback.

Added an external web-project installer and helper, then installed and launched
`~/hirebase-v2.command`. The profile lives at `~/.local/share/redit/hirebase-v2/`; runtime state
is `~/.local/state/redit/hirebase-v2`. The real native window showed Hirebase, its source tree,
eight available controls and successful read-only status output. Its package.json preview
worked. The inspection view was closed normally and the ordinary home launcher reattached the
same terminal/host, then became a managed desktop. All 4,085 recorded consumer source files
and its dirty git status were unchanged. No hirebase integration files were created.

Verification: initial external-binding failures observed for their own reasons; five deliberate
mutations caught (confinement, quoting, overwrite, native identity, legacy-host mutation).
Final `npm test` 84/84; `npm run test:desktop` 39/39; CTest 6/6; design, inventory, init and
annotated-sidecar checks clean. Evidence: `docs/evidence/external-project-macos-2026-09-07.md`.
The regression fixtures run from the normal scripts. F81 is complete for its explicit macOS
consumer scope. Existing accepted feature criteria and gates are unchanged.

Remaining: future Hirebase extensions belong in its external profile; project product work
still follows Hirebase's own instructions. No development servers, product tests or remote
backends were started by installation. Broader NOLF work remains independently paused.

## Session 36 (macos) — 2026-09-07 — The workspace wears the project's name (F79)

Built what I had only specified. The owner asked twice for a per-project logo and title and got a
spec and an inventory row instead, which I reported as progress; that was stopping short, and this
entry exists partly to record it.

The default name is **rEdit** in the chrome and in the operating system window title. Contract 5 adds
an optional `title` and an `icon` of a glyph plus a design token name. Both are plain root keys rather
than a block, so their contract floor is checked directly: a project on contract 4 that sets either is
refused by name and required version rather than having them accepted in silence. A token outside the
design set is refused naming the token, so an unresolvable colour never reaches the chip.

Identity is fixed to the root the window opened on. The window title follows in the frame loop rather
than at creation, because the declaration arrives after the window exists, and it composes from the
same source as the chrome so the two cannot disagree. The automation state now reports the real
window title from SDL, which is what lets the criterion about the operating system title be asserted
rather than assumed.

Two sabotages, each failing only its own claim: identity read from the selected root instead of the
primary one, which fails the assertion that selecting another project does not rename the chrome; and
the declared token ignored in favour of the accent, which fails the chip's colour probe.

Raising the contract ceiling broke four server tests that used contract 5 as "one above the ceiling".
They now derive it from `CONTRACTS`, which is the better assertion anyway: they are about the gate,
and the hard-coded number would have silently stopped testing it every time the ceiling rose. That is
the same shape as the blind regressions of yesterday, arriving through a different door.

Commands: `npm test` 78/78, `npm run test:desktop` 38/38, `ctest` 6/6, `python3 tools/design.py
check`, `python3 tools/features.py validate` at 40 features, `./init.sh`.

For a project to wear its name, add to `.rengine/project.json`: `"contract": 5`, `"title": "re:Lith"`,
`"icon": {"glyph": "rL", "token": "ok"}`. Tokens are accent, ok, warn, err and info.

Remaining: F78, the task tracker, is specified and next. F69 and the KI-038 Windows repair still block
F37, F54, F62, F67 and F73.

## Session 41 (macos) — 2026-09-07 — The Devices tab runs what is bound to each device (F80)

Owner-directed: *"everything should be able to install in devices tab, add proper controls there."*
The tab already knew exactly which games and actions each device carried — contract 4 gave it
`games` and `actions` per device — and drew them as one comma-separated line of ids. The whole gap
was that pressing them was impossible. The case that makes it worth doing is `remote-rengine`: a
`script` action bound to `pcvr` whose job is to install a headless rEngine on that box, and which
lived on the Dashboard where nothing says which machine it concerns.

`GET /api/devices` now resolves the project's dashboard actions with the same `dashboardActions` the
dashboard route uses and files each under the device it names, so a control carries the availability
that function already composed — the action's own `requires`/`tools` **and** its device's
reachability, failing half named — instead of a second opinion that can disagree with the Dashboard.
The ordering is the correctness argument: the device statuses are awaited first, and only then is the
board resolved, so it reads the probe cache those statuses filled. A listing with controls on it
costs one probe per device and no more. Never pass `projectDevices`' own options down into that
resolve — `refresh: true` would delete the keys the statuses just wrote and double every probe. Both
servers serve it: the retained host and the replaceable worker each already hold a `preflight`.

Pressing a control posts `/api/dashboard-run` (or `/api/dashboard-capture`), the Dashboard's own
route, so a script opened from Devices lands in a script tab with the same title and arguments. There
is no second execution path, and a bound game gets no launch control at all: rEngine launches a game
only through a declared action of kind `game`, and a target on a non-local device is refused by
design, so a button on that row could only ever refuse. A bound game reports the preflight the launch
uses, and a remote one reads *Runs there* with its location rather than *Ready*.

The tension worth recording is between two rules that were both already agreed: an unavailable
control names its first reason, and an unreachable device shows **one** reason rather than one per
action. It is resolved by naming the first reason **that is not the device's**. A control blocked
only by its device is drawn disabled and says nothing — the reason is one line above it; one blocked
by its own prerequisite names that. The same filter runs server-side for a game's `issue`.

**Bootstrap versus gated: gated, and the escape hatch is the declaration.** Tempting to exempt an
action whose purpose is to make a device usable, and wrong three times over. rEngine cannot tell one
from another without naming a specific script, which is precisely what the remote-launch refusal was
built to avoid. The motivating wizard opens with a stage titled *Check this machine can reach the
box* and aborts when `ssh` fails, so ungating it buys a worse version of the same sentence five
seconds later. And the contract already says it: an action that does not depend on a device omits
`device`. Ordering is left as declared for a related reason — with availability composed as it is,
every action bound to an unreachable device is unavailable together, so "runnable first" would
reorder nothing where it was meant to help and desynchronise the two panes everywhere else.

Row geometry got its own helper and its own assertion, because this file had just been bitten:
`5a0bc38` fixed the device row, which asked for `{-1, STATUS_WIDTH}` and pushed its pill past the
pane. Every new row is `{-KIND_WIDTH, -1}`, and the fixture requires every trailing pill to end at
the same x as the device row's own status pill, each column to keep one width, and that edge to lie
inside the pane. Reinstating the defect fails naming `devices-meta:here` and every pill after it.
`re_ui_clip` was **not** needed: `workspace.c:824` already calls it once after the pane window opens,
and every control here goes through the `re_ui_*` layer rather than drawing directly.

Sabotages, each red for its own assertion and nothing earlier: the row flip (red at *every trailing
pill ends where the device row's own does*); restating the device reason per control (3 !== 1 at *no
bound control restates or paraphrases it*); exempting device-gated actions (red at *install-silent is
drawn disabled while its device is unreachable*); a press that runs nothing (red at the script
session); controls claiming availability (true !== false); recomputing the device status per action
(3 !== 1 probes); filing every action under every device; a remote target reading as ready. Two
findings from that pass are recorded rather than smoothed over. First, the exact-equality reason
count did **not** catch the restating sabotage — the restated text wraps the reason rather than
repeating it verbatim — so the substring count beside it is the load-bearing assertion and both now
say which is which. Second, the honest render-side-effect sabotage (a probe from inside a control's
draw) turns the desktop into a refresh storm that hangs the suite rather than failing it, so it could
not be run to a clean red; the *thirty more frames probed nothing* assertion was instead calibrated
by making the extra probe happen for real (an explicit Refresh in its place), which turns it red at
that line with 2 !== 1.

Verified against the live `vtmb-vr` declaration with the Windows box powered off and the headset
attached — the mixed case the tab exists for. Four runnable controls and a ready `vtmb-flat` under
`local`; `pcvr` unreachable with its ssh timeout written once, both bound actions (`pcvr` and
`remote-rengine`) disabled and silent beneath it, `vtmb-vr` reading *runs there*; five runnable
controls under `quest`. `nolf-improved` is contract 3, reads clean and unchanged, and its fourteen
actions all appear under the implicit local device. Full listing in
`docs/evidence/device-controls-macos-2026-09-07.md`.

Commands, from the `feat/device-controls` worktree, built to its own `.cache/desktop` and never the
shared one: `npm test` 78/78; `npm run test:desktop` 32/32; `ctest` 6/6; `./init.sh`;
`python3 tools/design.py check`; `python3 tools/features.py validate` 38 features; the real-NOLF
qualification 1/1 with `RENGINE_NOLF_ROOT=~/nolf-improved`; a native build from a wiped scratch
directory, **0 warnings, 0 errors**. Sidecars: five refreshed and stamped
(`devices.c`, `server/devices.mjs`, `server/main.mjs`, `runtime/worker.mjs`, `agents/mcp-worker.mjs`,
with new `bound-controls`, `controls-run-the-dashboard-route` and `trailing-column-width` entries);
repo-wide `check` reports 40 diagnostics against 41 on `origin/main`, so this branch removes one more
than it adds and the rest is pre-existing drift in files no lane here touched.

The first `test:desktop` run in this fresh worktree failed two tests — `native-game` and
`native-recording` — and it was not KI-045. A worktree cut from `origin/main` has no
`.cache/native/librengine_surface.dylib`, so the embedded game aborts on launch (signal 6). Running
`npm run build:surface` first makes both pass, and the full suite is 32/32. Worth knowing before the
next lane blames a flake: `npm run test:desktop` builds the desktop but not the surface adapter.

F80 is left `passes: false`. Every criterion has evidence, but its prerequisite F76 — the contract-4
devices work this extends — is itself still unmarked, and the protocol asks for evidence for the
prerequisite too. Both are the owner's to mark together.

**Merged `origin/main` at `1a9c591`** — *give the shell back its control chords, and the menu its
keyboard*, which landed while this branch was gating. Three conflicts, all from both lanes appending
to the same tail: that lane took F78/F79 for specs 083 and 084, this one took F80, so keeping both
sides in id order was the whole resolution — taking a number with a gap rather than the next free one
is why there was nothing to renumber. Both progress entries kept; the graph regenerated rather than
resolved by hand.

The seam between the two changes is worth a fixture and neither lane would have written it alone: a
Devices control is a focusable control in a pane, and that commit restores chords to the shell and
the keyboard to menus. `native-devices.spec.mjs` now asserts that the platform chord pressed with the
pointer over a runnable control opens a shell rather than running the control; that `Return`, `Space`
and typing over the section start nothing, because a control here submits on a mouse press and holds
no keyboard focus; and that a popover over the section stays open under typing, changes nothing
beneath it, and leaves the section working afterwards. Two more sabotages, each red for its own line:
swallowing `SDLK_t` in the chord dispatch fails at *the platform chord opened a shell over the Devices
section*, and making a control fire on `MU_KEY_RETURN` fails at *typing over the section started
nothing*, 3 !== 1. Reading the routing rather than only testing it: chords run before any pane sees
the key, so they are unaffected by which tab is selected; a Devices tab never takes `a->focus` (its
`rect` stays zero), so a plain key falls through to the interface layer where no control holds focus.

Re-gated proportionately after the merge, since that commit is input routing: `npm test` 78/78,
`npm run test:desktop` 35/35, `ctest` 6/6, `python3 tools/design.py check`, `python3
tools/features.py validate` at 40 features, and a native build from a wiped scratch directory with 0
warnings. Sidecars re-checked against the new base: 40 diagnostics on this branch against 41 on
`origin/main` at `1a9c591`; the only one touching a file this lane owns is `workspace.c._llm.json`,
which arrived unstamped from that commit and is theirs to stamp. The real-NOLF qualification and the
consumer declarations were verified minutes earlier and have no relationship to control chords, so
they were not re-run.

The owner has powered the Windows box down until morning, so `pcvr` is genuinely unreachable and
every control bound to it — the `pcvr` launch script and the `remote-rengine` install wizard — will
render disabled with the box's one reason on the row above them. That is the state the tab opens to,
and it is the first time the composed availability path has had a truly down device behind it rather
than a fixture. It is also exactly the case the gated-not-exempt decision was made for: the wizard is
visible, beside the device it acts on, and honest about why it cannot run yet.

## Session 35 (macos) — 2026-09-07 — Two chords the shell wanted back, and two specs

The key sweep I commissioned to check F-keys and Tab found those were fine and found something
worse. The pane shortcuts I added yesterday gate on either modifier, so on macOS Ctrl+W, Ctrl+\\ and
Ctrl+Backspace all ran a workspace command instead of reaching the shell — delete-word, SIGQUIT and
delete-word again, three of the most-used chords in any terminal, while the menu promised Cmd. The
gate is now the platform's own modifier, which also makes the printed hints true. The conflict
remains on Windows and Linux where Ctrl is genuinely both, and that needs a chord decision rather
than a code change.

The same sweep found keys falling through underneath an open menu: a right press opens the pane menu
but only Escape and pointer events were intercepted, so every other keystroke landed in the still
focused terminal and typed into the live shell under a visibly modal surface.

My first fix for that was wrong in a way worth recording. I cleared pane focus when a surface opened,
which reads correctly and is in the wrong place: focus is released by bookkeeping that only runs in
the event handler, and changing it from the interface build skips that. It cost the dashboard suite a
test that passed in isolation and failed twice in the full run. I attributed it by bisection rather
than by argument — baseline clean, both edits failing, modifier-only clean — and the honest summary
is that the focus edit caused it while the mechanism is inferred rather than proven. The surface now
takes keyboard events in the event path instead, which is also what the popover's own text field
needs, and the suite is clean at 33.

Both fixes carry a regression verified against its own claim, per the work protocol: the chord test
fails with the old gate because Ctrl+W never arrives as 0x17, and the menu test fails without the
interception showing the typed letters in the shell's own echo.

Also recorded two specs from an owner interview, both landing on one contract bump so a project
raises its contract once rather than twice. Spec 083 is task tracking with a declared backend, read
only, one backend per project, credentials beside the workspace state and never in the committed
declaration. The research behind it corrected a prior of mine: dependencies map cleanly onto both
GitHub and Linear, while the awkward fields are the numeric id, `passes` and acceptance criteria,
which have no structured home on either. Spec 084 is project identity: rEdit as the default name, a
declared title and glyph from the window's primary root, and a logo colour named as a design token so
contrast stays a property of the design system. Charter D35 and D36.

Commands: `npm test` 77/77, `npm run test:desktop` 33/33, `ctest` 6/6, `python3 tools/design.py
check`, `python3 tools/features.py validate` at 39 features, `./init.sh`.

Remaining: F78 and F79 are specified and unimplemented. F69 and the KI-038 Windows repair still
block F37, F54, F62, F67 and F73. The charter has a pre-existing duplicate D32 on two unrelated rows,
left alone rather than renumbered, since other documents cite these numbers.

## Session 35 (macos) — 2026-09-06 — Escape reaches the game

The owner approved the recommendation, so Escape now frees the pointer and reaches an embedded game
in the same press. It was consumed as the workspace's release gesture, which made it unreachable for
a captured game — and it is the menu key in most of them. The owner had been pressing twice, and it
cost a real capture, because Save was behind the menu that never opened.

Three parts. `uncapture` in `game.c` frees the pointer only, leaving focus and held keys alone;
`re_game_release` keeps doing all three and is still what the workspace calls when it takes the pane
away. Escape falls through to the normal forward, and because focus survives, no menu open
re-announces focus with another kind 5. Held keys are no longer forged into releases: the player is
still holding the movement key, and the game hears about it when the key actually comes up. A game
that swallows Escape entirely gets out through the platform modifier and period, beside the existing
split and close commands; period because every Escape chord is taken by the platform, and the game
pane's own label now names it.

The test is the part that mattered. The existing spec asserted the defect as correct behaviour — it
required that the first Escape did *not* reach the game and that a second one did. A test that only
checked capture was released would pass with the defect present, because the defect released capture
too. It now asserts the delivered scancode. Verified with both sabotages separately: reinstating the
original early return fails at "the same press reaches the game", and removing the chord case fails
at the chord's own release rather than anywhere earlier.

`native-recording.spec.mjs` depended on Escape forging the held key's release as a convenient way to
produce two log lines. That is a real consequence of this change rather than flakiness, and it was
caught by rerunning rather than assumed. It releases the key explicitly now, which decouples the
recording feature from the input contract it should not care about.

Spec 043 carried the old behaviour as an accepted criterion, so the superseded sentence is quoted in
place with the owner decision and the reason, rather than rewritten away.

Commands: `npm test` 77/77, `npm run test:desktop` 31/31, `ctest` 6/6, `python3 tools/design.py
check`, clean build with zero warnings. Two unrelated desktop tests failed on one run and passed
alone, which is KI-045.

## Session 38 (macos) — 2026-09-06 — The log slice a committed segment never carried

The first real segment F75 wrote came back half empty. `20260906T201912Z-45e037` in nolf-improved:
46 good keyframes over 5,120 ms, `"log": { "lines": 0, "bytes": 0 }`, a zero-byte `log.jsonl`, and
a session whose retained output was full of ordinary lines. The whole point of the feature is a
frame beside the line printed while it was on screen, and it had already cost a diagnosis — a
rendering symptom that could not be correlated with any log line, because there were none.

Four candidates were on the table. The router in `recording.c` matching a game tab by session id,
the host filtering its event stream per desktop, `evict()` dropping lines against the frame budget,
and `write_log`'s `from`. The first three are clean and I ruled them out rather than assuming:
`sessions.mjs` broadcasts every output event to every `/events` client unconditionally and has since
the route existed; `worker.mjs` and `tunnel()` pass frames through byte for byte, so neither proxy
hop filters; the line ring is bounded by the ring's own seconds and a separate 2 MiB budget that
never touches the video bytes; and a fixture run showed the desktop's own `logLines` rising as a
real game printed, so lines do reach the recorder over the whole live path.

It was the fourth. `write_log` skipped every line with `line->at < from`, `from` being the explicit
segment's mark, so a start/stop kept only what the game printed inside its own window. That segment
was recorded over the main menu — a still screen prints nothing — while the lines that explained the
picture sat in the ring immediately before the mark. A ring commit passes `from = 0`, so the other
gesture never showed the fault. The filter also made the negative `atMs` spec 081 asks for
unreachable beyond the sampling lead, even though `write_log` computed its origin from the first
keyframe precisely to produce it.

The slice is now every line the ring still holds, for both gestures; only the keyframes are windowed
by the mark. The ring's `seconds` and line budget already bound how far back it reaches, the manifest
states that bound, and a pre-mark line says so with a negative `atMs`. Spec 081 is amended: the rule
is stated where it was ambiguous, criterion 1 and criterion 3 name it, and the defect is recorded
with why both existing lenses missed it.

Both lenses were proxy assertions. The unit test asserted the negative `atMs` against a *ring*
commit, where `from` is 0 and the filter cannot fire. The native fixture asserted keyframes, JPEG
bytes and the manifest and never opened `log.jsonl` — and, as session 34 found from the other
direction, it had dropped out of `test:desktop` entirely, so no gate ran it at all. That half is
already fixed on main and `suite-coverage.test.mjs` now guards it; I rebased onto that rather than
repeating the edit. The assertions are mine: the unit test marks a segment over lines printed before
it and asserts both signs of `atMs`, and the fixture drives the game's own printed lines through game
stdout, the host's PTY, the output event and the recorder, then reads the committed slice back. Both
fail on the previous implementation and pass on this one; the C test fails in 0.28 s.

KI-054 is new and left open: `truncated` is set from `dropped_lead > 0`, so it is true for
practically every explicit segment — that segment reports `"truncated": true, "droppedLeadMs": 29`
with a ring that had evicted nothing. Spec 081 reserves the flag for a recording that outruns the
ring and pairs it with a `requestedStartMs` this implementation does not write. A separate misreport
in the same manifest, deliberately not folded into this fix.

I gated the branch twice, because main moved under it while I worked: first at its base `a5b3f2f`,
then rebased onto `e051ebf`, which had already taken the devices and cooperative lanes and the
suite-membership fix. Rebased numbers: `npm test` 77/77 in 7.05 s; `ctest` in `.cache/desktop` 6/6
in 0.99 s, `native_recording` in 0.18 s; `npm run test:desktop` **31/31 in 351 s**; `./init.sh`,
`python3 tools/features.py validate` (37 features) and `python3 tools/design.py check` pass; the
native build has zero warnings and the `recording.c` sidecar carries the new rule, stamped clean.
At the base the same suite was 26 of 27 in 341 s, the odd one out being `native-project-windows`
on its layout comparison, which passed alone in 12.5 s — the KI-045 pattern, and green on the
rebased run.

The desktop suite was busy with the other lane for most of this session, so both windowed runs
waited for it rather than competing for the GPU.

F75 stays blocked on the owner's live verification after a layered update, unchanged by this.
The repo-wide `sidecar_tool.py check` is still not clean, for the reasons KI-052 already records;
none of those files are in this change, and `recording.c`'s own sidecar is stamped.

## Session 34 (macos) — 2026-09-06 — A fixture that left, and four regressions that proved nothing

The peer session reported that `9e52352` dropped `native-recording.spec.mjs` from the desktop suite.
I verified it against my own commit rather than taking it on trust, and it is mine: the stash
conflict on the single-line `test:desktop` script was resolved by taking whichever side contained
the new entry, which discarded the other side's addition. The recording fixture stopped running and
the report stayed green, because a suite says nothing about what it is no longer being asked. The
peer's union resolution had already restored it.

`orchestrator/tests/suite-coverage.test.mjs` closes the class. Every spec in the tree must be run by
an npm script or listed in an explicit allowlist with its reason, so removing one becomes a visible
edit in a reviewed file instead of a deletion inside a long single line, and the allowlist is checked
for rot in the same test. Verified by reproducing the exact edit: it fails and names the spec that
left. The audit it enabled found two specs no script runs, both correctly excluded and now recorded
with reasons — one needs an environment variable naming a trusted project with a real agent CLI, the
other a separately built surface fixture.

Separately, I ran the peer's sabotage rule over every regression added today, breaking each
implementation in the specific way the test claims to catch. Eight failed correctly. One did not:
the accent slider's track is drawn as twelve segments, and the assertion counted distinct colours
across the whole track, so a gradient primitive that ignored its second stop still produced twelve
colours and a green suite. It now samples inside a single segment, where nothing but interpolation
can differ, and fails when the stop is ignored. That case is structural rather than careless — the
control under test masked the failure of the thing under test, and every assertion was correct.

The refinement worth keeping: removing the fix and watching it go red is necessary and nowhere near
sufficient. Deleting the whole slider would have turned that test red while teaching nothing about
gradients. The sabotage has to be the failure the test claims to prevent. Recorded with all six
cases, including two more from the peer's cooperative lane and their higher-stakes example, in
`docs/evidence/blind-regressions-2026-09-06.md` and KI-047.

The recipe follow-on also landed: the launcher gains `--print-state`, which resolves the workspace
directory before any prerequisite check so it answers from a bare checkout, and the recipe test now
scaffolds two projects and asserts they land in different directories. One project on its own looks
correct whichever directory it picks, which is why the original single-instance test could not see
the defect.

Whether the sabotage rule becomes standing guidance in `AGENTS.md` is with the owner. A peer asking
me to change a project instruction file is not authority to change it, and agreement between two
agents is exactly when that step is easiest to skip.

Commands: `npm test` 77/77, `npm run test:desktop` 31/31, `ctest` 6/6, `python3 tools/design.py
check`, `python3 tools/features.py validate`, on `origin/main` at 84958f8.

Remaining: F69 and the KI-038 Windows repair; the Escape decision for embedded games, which the
owner has not answered and which is worth landing before their next orchestrator restart; and the
two outstanding sign-off notes.

## Session 37 (macos) — 2026-09-06 — A cooperative game surface: reserve the surface, inject nothing (F77)

**Owner scope**: give a project whose engine already speaks the surface protocol a workspace game
pane without any library injection. Worktree `.cache/worktrees/cooperative`, branch
`feat/cooperative-surface` cut from `origin/feat/devices` at `14746d1` and pushed per commit; the
`main` ref untouched, `update_workspace` deliberately not run, no consumer repository edited and
`.cache/worktrees/merge-verify` never touched. Spec 078 **extended** rather than replaced, because
this is a third value of an existing key.

**The value exists because of a race, not because of tidiness.** `embedded` means three things at
once: reserve a `Surfaces` item, pass `RENGINE_SURFACE_PORT`/`RENGINE_SURFACE_TOKEN`, and put
`librengine_surface.dylib` on `DYLD_INSERT_LIBRARIES` so the adapter interposes SDL2 inside the
game. An SDL3-static consumer cannot have the third: there is no dynamic symbol to interpose.
vtmb-vr has therefore implemented the client side in its own engine (its F1147). If such a game were
declared `embedded`, its own connection and the injected one would greet **the same token on the
same channel**; `Surfaces.accept` keeps the first socket and destroys the second, and both sides
reconnect after a close, so the surviving producer is whichever wins a restart race — on every
reconnect, with no error reported anywhere. `surface: "embedded"` plus an `inject: false` flag would
leave that one typo away, so it is a separate enum value and the regression asserts on the composed
launch environment: for a cooperative game it carries **no `DYLD_`/`LD_` key at all**.

**No contract bump, and the precedent is now written down.** `games` and `devices` were new *keys*,
which an older reader rejects by key rather than by version — hence contracts 3 and 4. `surface` is
a key every contract-3 reader already has, with a closed enum and no default, so an older reader
answers `$.games[0] (vtmb-flat).surface must be one of "embedded", "external"` and drops the whole
games array. The audit behind that claim is in the spec: injection is an equality test against
`embedded` with no default and no truthiness anywhere on the path, so no unknown value can ever be
injected into; the reservation is an explicit membership test, so an unknown value degrades toward
`external`, which is *fewer* privileges; and the one genuine fall-through — native
`re_app_external_session` asking whether a session **is** external — is why a newer server's
cooperative session renders correctly on a desktop that predates the value. One report did degrade
and is fixed: the automation snapshot inferred a tab's surface back from its view
(`t->terminal ? "external" : "embedded"`) and would have called a cooperative tab embedded.

**The native pane needed no change to render the frames.** The only native edit is that report, 13
insertions in `app.c`; `git diff origin/main --stat -- orchestrator/native/` is that one file, and
`workspace.c` is untouched.

**The sabotage pass moved two assertions, which is the point of running it.** Every check was broken
in the specific way it claims to prevent, not merely deleted:

| Sabotage (production code, restored after) | What failed, and what it said |
| --- | --- |
| Inject on the cooperative path alone, everything else intact | *no injection variable may reach a cooperative game, or its own connection races an injected one* — printing the composed env with `DYLD_INSERT_LIBRARIES` in it |
| Widen the adapter/platform gate to cover cooperative | *a cooperative game reports no adapter* |
| Drop `items.set(session.id, item)` so no viewer can attach | *and the session is bound to that item, or no viewer can attach*: `0 !== 1` |
| Remove the live frame fan-out to viewers | *the viewer received 1 frame(s) while the server holds 296* |
| Narrow the local-device rule back to `embedded` only | the `cooperative` case of the devices rule |
| Widen the shipped `surface` enum with a junk value | *the current reader names all three* |
| Make the test's predecessor-enum narrowing a no-op | *an older reader refuses cooperative by value, and never treats it as embedded* |
| Native: treat every non-`embedded` surface as external | *the cooperative pane receives frames* not reached — with `"surface":"external"` and a `game-status` row in the dumped state |

Two of those found real weaknesses. The injection regression **was masked**: held inside the larger
test, the realistic sabotage tripped the earlier "reports no adapter" assertion first, so the check
that exists to prevent the race was never the one that spoke. It is now alone in its own test with
its own launch, and asserts the absence of the injection variable *before* the surface variables, so
nothing easier can stand in for it. And the viewer check passed with the fan-out removed, because
attaching replays the latest frame the server already holds; it now requires two frames with
different sequence numbers.

**The fixture producer, not a consumer binary.** `orchestrator/tests/surface-producer.mjs` reads the
two variables, greets both channels through the committed `surface-protocol.mjs` encoder, streams
frames and reports on stdout every injection variable it was handed. The child's report is
corroboration only and is documented as such: macOS purges `DYLD_*` before a protected interpreter
starts, which is exactly why the load-bearing assertion reads the environment rEngine composes.

**The consumer shape is verified against a copy; the file is the owner's.** `contracts.test.mjs`
pins the vtmb-vr declaration with `vtmb-flat` rewritten to `surface: "cooperative"` carrying
`env: { "VTMB_HIDDEN_WINDOW": "1" }`: it validates structurally, reads back with both records and
their surfaces, keeps the consumer's own variable intact — `VTMB_HIDDEN_WINDOW` is an ordinary
UPPER_SNAKE entry that the `RENGINE_`/`DYLD_`/`LD_` reserved-prefix rule does not reach — and the
same document with a `DYLD_INSERT_LIBRARIES` entry is still refused by name.

**One thing worth knowing before editing `games.mjs`:** it contains a deliberate NUL byte (the
launch-identity key separator), so git labels it `Bin` in `--stat` and **`grep` silently prints
nothing** for it. Use `git diff --text` and `python`/`rg` on that file; a `grep` that returns clean
there is telling you nothing.

**Gates**, after a final `git fetch` (`origin/main` `47405a6`, the devices landing) and a merge of
it. `npm test` **74/74**. `npm run test:desktop` **31/31**, sequential, 22 fixtures
including the new `native-cooperative.spec.mjs`. `ctest --test-dir .cache/desktop` **6/6** (0.96 s).
Native build from a **wiped** `.cache/desktop`: **0 warnings, 0 errors**; `npm run build:surface`
from a wiped `.cache/native` likewise 0. `./init.sh` clean (37 features). `python3 tools/design.py
check` clean. `python3 tools/features.py validate` clean, and `docs/roadmap-graph.md` regenerates
identical to the committed file. `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run
test:game-nolf` **1/1** — unchanged, as it must be: NOLF stays `embedded` and its injection
path is untouched. Sidecars with the private index `.cache/sidecars-cooperative.sqlite`, run
sequentially: **16 errors, 21 warnings** whole-tree against `origin/main`'s own **17 / 22**, so this
branch adds no drift and repairs one file's worth; every file it touches is clean and stamped, and
the residual is the pre-existing set (KI-052).

**Two merges, and a conflict resolution worth flagging.** `origin/feat/devices` at `14746d1` was the
base; `origin/feat/devices` at `522ea05` and then `origin/main` at `47405a6` (devices
fast-forwarded) were absorbed. `package.json`'s desktop list conflicted three ways and was resolved
as the **union** — which restored `native-recording.spec.mjs`: main's `9e52352` *replaced* it with
`native-explorer.spec.mjs` rather than adding it, so the recording fixture had been off the desktop
gate since that commit. It passes here. Known issues were renumbered to follow main's landing
(devices at 050/051/052) and this lane took **KI-053**, clear above. `orchestrator/native/` is one
file, `app.c`, 13 insertions: `workspace.c` is untouched.

**Remaining.** F77 stays `passes: false` until a real consumer declares `cooperative` (KI-053): the
owner owns vtmb-vr's `.rengine/project.json` and this repository deliberately did not edit it, so
the end-to-end claim rests on a fixture that speaks the same protocol. Delivery needs
`update_workspace` for the worker layer and a desktop reload for the native tab; this lane ran
neither. `docs/specs/078` still says the contract enum is `[1, 2, 3]` in one paragraph the devices
lane left behind — spec 082 owns that sentence, so it was not corrected from here.

## Session 36 (macos) — 2026-09-06 — Merging the devices lane onto the settings popover, the clip fix and the overlay

**Owner scope**: land finished `feat/devices` (`57ab639`) on current main and report green. Worktree
`.cache/worktrees/merge-verify`, branch `feat/devices` pushed per commit; the `main` ref untouched,
`update_workspace` not run, no consumer repository and no other worktree edited. Base was `60d0917`
throughout — fetched before the merge and again before the final gate run, and it never moved.

**Main owns the control layer, so main's shape wins.** F68 reshaped the toolbar underneath this
lane: the Vim checkbox moved into a settings popover, the theme button became Settings, the project
cell opens a menu rather than cycling roots, and every owned control now takes its container's clip.
Five files conflicted. `package.json`: the desktop list is unioned, keeping main's `native-settings`
and this lane's `native-devices`, 19 fixtures. `native-game-declaration.spec.mjs`: main's cell list
with `Devices` inserted at index 2 — the trailing assertion still names `Settings` as the last cell
and still measures it landing on the toolbar padding, which is main's invariant, not this lane's.
`Codex-progress.md`: both entries kept, this lane's renumbered to 32 because main's F68 entry had
already taken 31. The two sidecars (`app.c`, `workspace.c`) are the union of both sides' entries —
this lane added `devices-route` and `view-switcher-indices`, main added `one-overlay` and
`offered-not-applied`, and no note on either side was edited — re-anchored against the merged
sources and stamped.

**The Devices section needed no clip of its own.** `devices.c` lays out through `re_ui_*` controls
only and never calls `re_draw_*` inside the container, so it inherits the `re_ui_clip(ui)` the pane
content window already takes; the section is in the case main's fix covers for free. The pixel
regression that samples the toolbar and tab strip across the explorer's width compares before-scroll
against after-scroll rather than against a golden image, so a fifth switcher cell moves both samples
identically and it needs no change: it passed untouched.

**Everything the lane owns merged clean, and was checked rather than assumed**: the contract, the
schema, `devices` rules, the probe with its 15 s cache and in-flight coalescing, the worker routes
and the MCP tool are in files main never touched, and main's only server change (`store.mjs`
preferences for spec 080) does not reach them. `workspace.c` is exactly the reported footprint on
main's structure: the switcher entry and `views = 5`, the tab icon, the dispatch, and `RE_DEVICES`
in the two scroll predicates. No id collision: main stops at F74 and spec 080 and KI-043, so F76,
spec 082 and KI-045/046/047 were free at that point — main took F75, spec 081 and KI-044 two
commits later, which is why this lane renumbered; see below. `features.json` appended in place;
`docs/roadmap-graph.md` regenerates byte-identical to the merge; `theme.h`/`theme.c` and the design
mirrors regenerate byte-identical too, so the generated files were not conflict-resolved by hand.

**A second merge, `a5e6036`.** Main advanced again while this branch was being reported: the nested
explorer and the fix that lets the settings popover take clicks over a busy pane. It merged with no
conflict, as predicted from its diff — it reshapes `tree_ui` into nested `tree_rows` with an
expansion pool and brings the overlay container to front each frame, none of which touches the
switcher entry, the dispatch or the scroll predicates. The one thing worth checking was the new
`RePending.slot`: `request_within` initialises it to -1, so a devices load still dispatches as
`OP_LOAD` and is never read as an expansion listing.

**Their fix and this section overlap, so it is now a test.** Devices is a scrolling pane that is
busy whenever a probe is outstanding, and the popover hangs over it. `native-devices.spec.mjs` gains
a third case that puts a probe genuinely in flight — the probe writes its own start and end marker,
so "in flight" is measured rather than assumed — then presses a device row (the press lands, closes
the popover and brings the pane forward), reopens the popover over that pane and toggles Vim, and
presses Refresh so a third probe starts before the earlier ones end. Verified the right way round:
with `mu_bring_to_front` removed it fails at *the popover answers over a pane with a probe
outstanding*, with the surface published and visible (`overlay: 1`) and deaf; restored, it passes.
The first ordering I wrote did not discriminate, because a surface opened for the first time is
already in front — the defect only appears on the second opening, over a pane clicked in between,
and the fixture now opens it twice for that reason.

**The render budget is badly calibrated, and here are the numbers.** `native-render.spec.mjs`
asserts `gpu.rss - sdl.rss <= 32768 KiB` per backend. On this machine the OpenGL delta is a
difference between two processes of ~150-190 MiB whose own samples span **7296 KiB** within a single
run (SDL sampled 147952, 152944, 154880, 155248). Observed OpenGL deltas: **32800** and **29792** on
this branch, **33152** and **18608** on `origin/main` at `60d0917` — a 14544 KiB spread across four
runs of unchanged code, straddling a threshold two of them cross. It is a threshold set close to the
noise, not a regression, and it belongs to the render lane: either widen it to cover the measured
spread or measure something less noisy than a whole-process RSS difference. A third sweep lost the
same spec to its 420 s timeout under load average 20.6.

**A third merge, `5356ece`, and a renumber.** Main advanced twice more during the report: the
overlay fix (`a5e6036`) and then the game-recording lane (`a749d9a` + `5356ece`), which **took F75,
spec 081 and KI-044** — the three ids this lane had checked as free two commits earlier. Main is
pushed and this branch is not, so this lane moved, following `cbfa1ef`: **F75 -> F76**,
`docs/specs/081-project-devices.md` -> `082-project-devices.md`, and the known issues out of the
contested range entirely: **KI-044/045/046 -> KI-050/051/052**. The first two attempts packed against
whatever had just landed (045/046/047, then 046/047/048) and collided again each time, because main
was taking an id roughly as fast as a gate sweep runs; the block above main's highest (046 at
`a5b3f2f`) leaves a gap on purpose, and a gap costs nothing. F76 and spec 082 were re-checked against
`a5b3f2f` and are still free,
and, because main kept taking session numbers too (two 32s of its own, then 33), this lane's
sessions take the same deliberate gap as the known issues: **35** (devices) and **36** (this
merge). Every reference moved with them: the schema description, the sidecar refs, `games.mjs`'s own
comment, the theme card, both fixtures and the progress log. The renumber is its own commit before
the merge, so the merge itself is only a union.

Everything the recording lane touches that this lane also touches was a union rather than a choice:
`RE_DEVICES` joins the tab enum beside `#include "recording.h"`, the worker and the host advertise
both `recordings: 1` and `projectDevices: 1`, both route modules are imported in `main.mjs` and
`worker.mjs`, `devices.c` and `recording.c` are both built, the theme card keeps both view notes, and
the desktop list runs both fixtures. Five sidecars conflicted and are the union of both sides'
entries, re-anchored and stamped; after that the sidecar diagnostics are **identical, line for line,
to `origin/main` at `5356ece`** (16 errors, 18 warnings).

One more main-side flake surfaced and was reproduced there before being attributed:
`native-format-hardening` — main's own new nested-explorer loop, which clicks 64 directories with
scroll settles — failed once here (`dir3 expanded not reached`) and **2 of 3 isolated runs on
unmodified `origin/main` at `5356ece`** (`dir56 expanded not reached`, and `slow producer preview
loaded`). The sweep that follows is a clean 26/26 on this branch.

**A fourth and fifth merge, `9e52352` and `a5b3f2f`.** Main advanced twice more: the in-place
explorer, then selects that open a list instead of cycling, plus one state directory per scaffolded
project. Neither collided in `workspace.c` — the dropdown machinery sits with the settings surface,
the explorer work is in the tree rows, and this lane's switcher entry, tab icon, dispatch and two
scroll predicates came through both untouched. Both merges were unions in `known-issues.md`,
`package.json`, the progress log and the sidecars.

**Gates**, re-run after the fifth merge and after a final `git fetch` (`origin/main` `a5b3f2f`),
proportionately to what it touched — `workspace.c` and the recipe template, so the full desktop
suite, the unit tests, the design check and a wiped-cache build; the NOLF qualification and the
consumer declarations were verified at `522ea05` minutes earlier and have no relationship to a
selects widget. `npm test` **71/71**. `npm run test:desktop` **29/29**, sequential — 20 fixtures,
this lane's `native-devices.spec.mjs` 3/3 including the busy-pane case, beside four lanes' own. Earlier sweeps of the first merge lost
one test each to machine load, never the same one twice, and every class was reproduced on main
before being attributed there: `native-render`'s memory budget (the numbers are above),
`native-render` cancelled at its 420 s timeout under load average 20.6, and `native-project-windows`,
which passes 3/3 in isolation here while `origin/main`'s own sweep at `60d0917` came in at 21/22 with
`native-game`'s fixture aborted on signal 6. None touches a devices path.
`ctest --test-dir .cache/desktop` **6/6** (0.96 s, the recording test included). Native build from a **wiped** `.cache/desktop`: **0 warnings, 0 errors** — the
honest check for the `-Werror` implicit-declaration class of defect. `./init.sh` clean (36 features).
`python3 tools/design.py check` clean. `python3 tools/features.py validate` clean.
`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:game-nolf` **1/1**. Sidecars with the
private index `.cache/sidecars-devices-merge.sqlite`: **16 errors, 18 warnings**, identical line for
line to `origin/main` at `5356ece` — the drift that predates both lanes (KI-052). At `a5e6036` main
reported 35 errors because that commit shifted `app.c` and `workspace.c` without re-anchoring their
sidecars; this branch repaired those 18 with `check --fix-anchors`, and the recording lane repaired
the rest on its way in. Both live consumer
declarations re-read through the merged code: vtmb-vr (contract 3, 1 format, 2 games, 3 dashboard
groups) and nolf-improved (contract 3, 1 format, 3 games, 3 groups), no errors, `devices` absent in
both, `projectDevices` reporting each as the implicit local device only, and both files byte-
unchanged.

**Remaining** is what session 35 left: F76 stays `passes: false` until a consumer declares devices
and a probe runs against a real Quest or SSH host (KI-050), delivery needs `update_workspace` plus a
desktop reload, and the dashboard still pays one probe per device per listing (KI-051).

## Session 35 (macos) — 2026-09-06 — Devices: where a declared target actually runs (contract 4, F76)

**Owner scope**: give a project a way to say WHERE each target runs, probe reachability, and report
availability in those terms. Worktree `.cache/worktrees/merge-verify`, branch `feat/devices` cut
from `origin/main` at `94ce2fd` and pushed per commit; the `main` ref untouched, `update_workspace`
deliberately not run, no consumer repository edited. Spec `docs/specs/082-project-devices.md` (080
was already taken by the settings popover).

**The defect is a proxy, not a message.** The reported symptom was `game_preflight` for vtmb-vr's
`vtmb-vr` target answering *"Game executable not found; expected build/vtmb-vr or
build/Release/vtmb-vr in the selected project."* — every word true and the conclusion impossible,
because that target is `condition = "windows"` and can never be built on this Mac. But the deeper
defect is that contracts 1-3 gate a remote target on `tools: ["adb"]` or `["ssh"]`, which asks
whether a binary is on this machine's PATH, not whether the device is there. Measured in
`nolf-improved/.rengine/project.json`: **8 of 14 dashboard actions are device actions** (6 adb, 2
ssh), and `adb`/`ssh` are always on that PATH, so all 8 report `available: true` with the headset
unplugged and the Windows rig off. Only vtmb-vr saw the sharper message because only vtmb-vr has
promoted a remote target to a game record; any consumer that does inherits it immediately, which is
why the local-stat rule is in the contract rather than in an implementation.

**Contract 4.** `contract` becomes an enum of 1..4. A top-level `devices` array (1-8 records:
`id`, `kind` local|ssh|adb, `title`, optional `host`/`selector`/`requires`/`tools`/`probe`/
`probeTimeoutMs`) plus an optional `device` on a game record and a dashboard action, defaulting to
`local`. Declaring the array **or any `device` key** under contract 3 is rejected by *version*
(`devices requires contract 4 (declared contract 3)`), never by unknown key — the key is accepted
structurally by the schema precisely so the error can name the contract to update to instead of
telling an operator to delete it. `local` is implicit and reserved: at most one, id and kind must
agree, and it takes no `probe`/`host`/`selector`.

**Four shape corrections from the second consumer, all adopted.** (1) Devices need a **selector**,
not only a host: with two Android targets attached a bare `adb` call aborts with *more than one
device*, and it aborts at launch rather than at probe — corroborated by that project's own
`fast-start-quest.sh:23-25`. `${host}` and `${selector}` are the two placeholder sources, and a
probe naming one whose source is undeclared is a named error. (2) A probe is **bounded and
side-effect-light, not read-only**: `adb get-state`/`adb devices` start the adb server. No surface
or tool description claims otherwise. (3) A green probe is **reachability, never launchability** —
`ssh host true` succeeds while the launch cannot, because a logon session has no window station and
so no GL context; availability never claims more. (4) **`requires` stays LOCAL** on a device and a
target alike, because the Quest data push names the local archive it is pushing; `deviceRequires`
is reserved and unimplemented.

**The rule that matters.** A target on a non-local device is never resolved or stat-ed against the
local filesystem: no executable resolution, no `cwd` stat, no embedded-surface check — only its own
(local) `requires`. The regression proves the rule rather than the symptom: it places the
executable **on** the local disk and asserts it is still unresolved, so it cannot pass by the file
merely being absent. `Game executable not found` no longer appears for such a target; the device,
its reachability and `build/... on <device>, not on this machine` do.

**Probes** run under the same `runCommand` boundary as every other declared command (no shell, cwd
the root, shell environment, stdin closed, 64 KiB output, default 5000 ms capped at 60000, killed
as a **process group** on timeout — the fixture proves that with a backgrounded writer that never
runs). Exit 0 is reachable; otherwise the first stderr line is the reason. An unset or empty
`env` is unreachable **by name, without a spawn**. Device `requires`/`tools` short-circuit before
the probe. Results are cached **15 s** per root/device/resolved-argv **with in-flight coalescing** —
a TTL alone is useless here because `dashboardActions` resolves its actions concurrently, so six
adb probes would all start before any result existed.

**Out of scope on purpose.** `launch_game` on a non-local device refuses by name and points at the
project's own dashboard script actions bound to that device — derived from the declaration, so
rEngine still names no specific script. The refusal is issued by the **worker**, from its own
preflight, before anything reaches the retained host (the KI-043 lesson); `Games.start` refuses
again for a direct caller.

**Surfaces.** `GET /api/devices?rootId[&refresh=1]` is served by the replaceable workspace worker,
which advertises `projectDevices: 1`; a read-only (openWorld) MCP `devices` tool is gated on it, and
`game_preflight`/`dashboard_actions` report device-derived availability with the failing half named.
Native: a Devices section on the view switcher, on the owned `re_ui_*` control layer, listing each
device with a status pill, **one** reason, and the targets bound to it — an unattached headset is
one unreachable device, not four disabled actions each restating it. Probes run only on open or
Refresh; the tab is deliberately not auto-opened the way the dashboard is.

**Gates**, all after a final `git fetch` (origin/main never moved off `94ce2fd`, so the merge was a
no-op and no conflict with the concurrent F68 draw-list lane arose). `npm test` **66/66**.
`npm run test:desktop` **20/20**, including the new `native-devices.spec.mjs` 2/2.
`ctest --test-dir .cache/desktop` **5/5** (0.83 s). `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved
npm run test:game-nolf` **1/1** — the real NOLF game still renders and accepts menu input with a
fifth toolbar cell in the switcher. `./init.sh` clean (35 features validated).
`python3 tools/design.py check` clean. Clean native rebuild with **0** diagnostics from
`orchestrator/native` under the picky flag set. Sidecars clean and stamped for every file this branch touches (pre-existing
drift elsewhere is KI-052, not this lane's). Both live consumer declarations re-read clean and
unchanged at contract 3: vtmb-vr (1 format, 2 games, 10 actions) and nolf-improved (1 format,
3 games, 14 actions).

Two pre-existing test expectations moved with the contract rather than around it: the "next unknown
contract" guards in `formats`/`dashboard`/`games` tests step from 4 to 5 (contract 4 is now real, and
`games.test.mjs` additionally asserts that a contract-4 declaration accepts a games array unchanged),
and `native-game-declaration.spec.mjs`, which pins the exact toolbar cell list to prove the game
control stayed removed, gains `Devices`.

**Remaining.** F76 stays `passes: false`: no consumer declares devices yet and no probe has run
against a real Quest or SSH host from this branch (KI-050), delivery needs `update_workspace` for
the worker layer plus a desktop reload for the native section, and the dashboard now pays one probe
per device per listing (KI-051).
## Session 33 (macos) — 2026-09-06 — Selects open a list, and one workspace per checkout

The owner noticed that the theme and syntax controls stepped to the next value rather than opening
one. That was a placeholder of mine from before the overlay layer existed, and it hides every choice
from anyone who has not memorised them. Both are selects now: the list shows every value with the
live one marked, built from the same menu-item control the menus card describes, and picking a value
applies and persists it.

The list is a second surface above the one holding the select. It records into the same overlay
buffer without clearing it, so replay order is stacking order, and its own container is brought to
front so the pointer agrees with what is drawn. Spec 080 decision 5 still holds: the list belongs to
its surface rather than being a peer, it closes with it, and Escape closes the list first and the
surface second, which is what "closes the top surface" already meant.

Also fixed a defect the nolf-improved session reported after it cost them a live session, which is
mine because it is in the recipe's template. `orchestrator/templates/project/editor.sh` passed no
state directory, so every scaffolded project fell back to the shared default and two projects bound
both their roots into one workspace. The project selector appeared not to switch, and a host restart
from one checkout took the other project's retained agent with it, because live PTYs belong to the
host and are never persisted. The launcher now keys the state directory on the checkout's absolute
path, `--state` still overrides it for deliberate sharing, and the template test asserts both.
Recorded as KI-046, including that projects scaffolded before this carry the old default.

Commands: `npm test` 61/61, `npm run test:desktop` 26/26, `ctest` 6/6, `python3 tools/design.py
check`. The desktop suite passed clean this time; KI-045 stands for the intermittent runs.

Remaining unchanged: F69 and the KI-038 Windows repair, the two outstanding sign-off notes, and the
Escape decision for embedded games, which is with the owner.

## Session 32 (macos) — 2026-09-06 — The explorer expands in place, and three defects the owner found first

F73 is implemented and gated on macOS. In nested mode a directory row expands in place at the card's
indentation, the caret glyph drills in so the old behaviour stays reachable, and a branch collapses
whole. Flat mode is unchanged. The mode is the setting from spec 080 decision 1 and nothing infers it.

The row cap is the interesting part. It counts rows rather than branches, because rows are what a
person scrolls, and it is enforced when a listing arrives, since the size of a directory is not known
before that. Reaching it collapses the least-recently-expanded branch and names it in the status line.
A branch is protected when the directory being opened sits under it or when the selected file does,
and the selection is the file being worked on rather than whichever folder was last toggled — the
first version updated the selection on every folder click, which quietly cancelled the protection the
rule exists to provide. When every branch is protected the expansion is refused, also in the status
line, and nothing already open closes. `orchestrator/tests/native-explorer.spec.mjs` drives all four
criteria against the real desktop.

The row is not marked passing. F73 depends on F67, which is signed off but waits on the Windows card
evidence blocked by KI-038, so the inventory keeps `passes: false` and the macOS verification is
recorded in `docs/evidence/nested-explorer-macos-2026-09-06.md`.

Three defects arrived from the owner and one peer rather than from reading code, and all three are
worth writing down because none would have been caught by the gates as they stood:

- The settings popover would not take clicks over a pane running an agent CLI. The surface is drawn
  above every pane but the pointer was still offered to the panes first, and a terminal with mouse
  reporting on claims the press and returns. The rows above that terminal's rectangle worked, which
  made it look like two broken controls rather than a layer that stops at a boundary. An open overlay
  now owns the pointer over its own rectangle. The regression only means something with a fixture
  that enables mouse reporting; a plain shell does not claim the press and the test passes either way.
- The check mark in a checkbox was drawn at the text size, so a 14px box cropped it to a diagonal
  stroke that reads as a slash. Icons now take a size, and the assertion is that the mark keeps clear
  of the box's corners, which is what an oversized glyph reaches first.
- Scrolled views painted over the toolbar, reported by the peer session from the owner's screen. That
  one was a class rather than a bug: owned controls never saw microui's clip, and the scrollbar work
  simply gave those lists somewhere to scroll to. Fixed in the control layer, so every view was
  covered by one change.

The three added defects of my own making are in the spec: an operation number that sorted above the
format-view boundary and read a format the explorer does not have, a collapse that passed a pointer
into the slot it then cleared, and a pool whose free marker made tab 0 indistinguishable from an
unused slot.

Commands: `npm test` 61/61, `ctest` 6/6, `python3 tools/design.py check`, `python3
tools/features.py validate`, and `npm run test:desktop` 26/26 on two of five runs. The other three
dropped one or two different tests to an automation timeout, each passing when rerun alone, and the
committed baseline `a5e6036` dropped three the same way, so this is environmental. Recorded as KI-045
rather than left as folklore, because a single red run here should not read as a regression.

Remaining: F69 and the KI-038 Windows suite repair, which unblocks F37, F54, F62, F67 and with them
F73. The owner's sign-off notes for F60 and F67 are still outstanding. Two peer sessions have raised
work for the owner to decide: Escape never reaches an embedded game because the pane consumes it as
the capture-release gesture, and requests for game recording and per-project chrome identity.

## Session 32 (macos) — 2026-09-06 — A game pane that remembers the last two minutes

F75 implements the recording the owner asked for directly: a game pane keeps a rolling buffer while
it is live, a toggle on the game tab commits a segment — either the last N seconds from the ring or
an explicit start/stop — and committed segments are queryable over MCP. Spec 081 settles the four
constraints that actually decide the design, and three of them ruled something out.

The ring cannot hold raw frames and the encoding cannot wait for the commit, because by then the
frames are gone. At the surface protocol's own limit a 1280×720 RGBA frame is 3.69 MB: 26 GB for a
two-minute ring at 60 fps, still 1.1 GB downscaled to 640×360 at 10 fps, and about 400 MB if the
downscaled rows are deflated through `node:zlib`. JPEG at 640×360 quality 70 is ~60 MB, which is the
only one of those a person would leave switched on. `third_party/` had no image writer, so
`stb_image_write.h` is pinned into the existing `third_party/stb` entry at the stb revision
`sources.json` already records — no new upstream, no new licence, the same convention every other
vendored file follows — and it is compiled in its own `rengine_jpeg` target with `STBI_WRITE_NO_STDIO`,
like microui and cJSON, so the picky warning set stays on owned code only. No video container is
written: MJPEG-in-AVI needs no dependency but nothing in these gates can decode it, so claiming it
plays would be a proxy assertion. The keyframe strip is the human artifact and the spec carries the
one `ffmpeg` line a person can run against files rEngine already wrote.

An agent cannot watch a video, so the machine artifact is a manifest that indexes timestamped
keyframes and a timestamped log slice on **one clock**. Every keyframe and every log line carries
`atMs` from the segment start, an absolute `wall` time, and — for keyframes — the game's own frame
`sequence`, which the pane was already stamping. Wall clock is derived from the monotonic clock and a
single epoch sample taken at open rather than sampled per artifact, so the three can never disagree,
and the whole recorder is deterministic under test. A log line is stamped when its newline reaches the
desktop; that is stated as the approximation it is, and it is the only clock shared with the frames.

The ring lives in the desktop, and that is forced rather than convenient. The encoder is a C header,
and a Node-side ring would have to encode inside the retained session host — the one process a layered
update cannot replace. That is KI-043's lesson from spec 078, and it decides the read side too:
`recordings.mjs` is a pure filesystem walk, so the **worker serves `GET /api/recordings` and
`/api/recording` from its own checkout** and advertises `recordings: 1` unconditionally, the host
serves the same two routes from the same module, nothing is forwarded, and `supervisor.mjs` claims
nothing. A regression drives the worker above a proxy host advertising only `handoff: 1` and answering
`/api/recording*` with 404: the routes still answer, from the worker. `recordings_list` and
`recording_read` gate on that flag and name the remedy that this time actually works.

Audio is the constraint that could not be closed here, and it is not silently dropped. A game's sound
goes to the system output device and never passes through the workspace, which sees a frame socket and
a PTY. capture-mcp already does per-app audio, chunked, timestamped and transcribed; driving it from
the desktop would make an unpinned tool at a `~/...` path a runtime requirement and would need screen
and microphone consent granted to rEngine rather than to the tool the owner already trusts with it. So
every manifest carries `audio: { present: false, provider: "capture-mcp", reason, issue }`,
`recording_read` reports it verbatim, and **KI-044** holds the integration: an optional per-project
audio provider whose transcript chunks land beside the keyframes on the same clock. Recording an
`external` game — its own OS window, no frame stream — is the same problem and is deferred with it.

Two implementation choices are worth keeping. Committing is a **drain** of at most 24 keyframes a tick
with the manifest written **last**, so a full ring lands in under a second without a freeze and a
directory with no manifest is exactly what it looks like: an unfinished commit, which the listing
reports as an error entry rather than hiding. That is what makes "an in-flight commit is not lost"
real — a game session that exits mid-recording commits what it has, and closing the tab or the desktop
drains what is in flight first. And an explicit recording is stored in the **same** ring rather than a
second unbounded buffer, so a forgotten toggle cannot fill the disk; if it outruns the ring the segment
starts where the ring does and says `truncated` with `droppedLeadMs`.

The controls went into the game tab's **existing** row rather than a new one. A second row would push
the game rectangle down and silently retarget the pointer coordinates `native-game.spec.mjs` clicks —
a green suite measuring the wrong pixels.

Two checks were verified by breaking them rather than by watching them pass. Removing the bottom-up
flip fails the orientation assertion; writing the manifest during the drain fails the "no manifest yet"
assertion. The second attempt also exposed a real defect in the test itself: ids are deterministic on
purpose, so a leftover segment from the aborted run answered the next run's assertion. Each run now
works in its own tree and removes it.

Gates, all from this worktree on branch `feat/game-recording`: `npm test` 61 tests, 61 pass, 0 fail,
10,947 ms. `npm run test:desktop` 23 tests, 23 pass, 0 fail, 418,659 ms, the new
`native-recording.spec.mjs` at 3,768 ms. CTest in `.cache/desktop` 6/6 in 0.13 s, including the new
`native_recording` at 0.05 s. `./init.sh`, `python3 tools/features.py validate` (35 features) and
`python3 tools/design.py check` clean; the native build reports zero warnings and zero errors;
sidecar `check` clean for every touched file after `--fix-anchors` and `stamp`.

The first desktop run was **not** clean and the reason is worth recording: 21 of 23 with
`native-format-registry` missing its stderr line and `native-render` timing out at its full 420 s
budget. Load average was 20 with another session's `ctest -LE slow -j8` and its own
`rengine --automation` on the same GPU. Re-run on a quiet machine: 23/23. Neither spec touches a game
pane, so nothing in this change could have moved their pixels — but the honest evidence is the second
run, not an argument about the first. Check `pgrep -x ctest` before the windowed suite, not only
before CTest.

Not mine, recorded rather than fixed: sidecar anchors across the repository are drifted at main tip —
verified against a pristine `a5e6036` checkout, where `app.c`, `editor.c`, `draw.c` and others report
the same `ANCHOR_DRIFTED` lines before any change of mine. `native-client.mjs` and
`native-scrollbars.spec.mjs` carry unreviewed fingerprints there too. A repository-wide anchor repair
belongs in its own housekeeping pass, not inside this one.

F75 stays `passes: false`: like F71/F72/F74 it waits on the owner's live verification after a layered
`update_workspace`, since only the desktop layer carries the recorder and only the workspace layer
carries the routes.

## Session 31 (macos) — 2026-09-06 — Settings, menus, a gradient in the contract, and a clip nobody had

F68 is complete. Settings live in their own popover opened from the toolbar, carrying the theme
preset, the syntax scheme, the accent hue, Vim mode and the explorer's mode; Vim left the toolbar as
spec 080 decision 4 requires, and the trailing-cell fixture measures the same right edge. The project
cell and a right press on a tab strip open menus on the same overlay layer, drawn from the menus card
with its accent hover, mono keyboard hints and separators. Those hints name shortcuts the workspace
now serves, so a menu never prints a key that does nothing. Escape closes the top surface, an outside
press closes it and continues to whatever it landed on, and focus returns to the opener. The
workspace holds one overlay kind rather than a flag per surface, which makes "opening one closes the
other" structural instead of a rule to remember.

The accent slider needed the gradient the owner chose over a texture during the F60 interview, and
it did not exist. It is now command 10 of the draw-list contract, which takes it to version 2: two
stops, an axis, and the rrect's radius and corner mask. The ramp is not left to each adapter.
`re_gradient_sample` in the header is its definition and all four adapters step through it, which is
what lets the cross-backend comparison treat a gradient like any other primitive; the primitives
scene draws it on both axes so that comparison covers it. The slider's track is twelve ramps between
neighbouring hues, each stop taken from the preset's own accent lightness and chroma, so the colour
under the thumb is the accent the workspace will take. `tools/design.py` now emits the accent recipe
per preset, so moving the hue re-resolves every accent-derived colour at runtime, and returning the
hue to a preset's own value restores the baked table exactly rather than recomputing it.

Theme files resolve against a token graph the generator emits per preset with values left
unexpanded, so a file that sets a palette entry moves every semantic and view token that reads it.
That is the three-layer reach charter D34 asks for, in the card's `[theme "name"]` format. Metrics
and font families stay compiled in and are counted and named in the status line rather than dropped
in silence. A root's theme lives at `.rengine/theme.conf`, is read only while the popover is open,
and is applied only on a click, remembered per root.

The peer session reported, from the owner's screenshot, that scrolled content painted over the
toolbar. It was a real defect on main, not the work in flight: owned controls draw into the list
while the interface is built and that path never saw microui's clip, so nothing bounded them and the
scrollbar work simply gave those lists somewhere to scroll to. Every control now takes its
container's clip, one that narrows its own intersects rather than replaces, and panels and popovers
clear it because they are drawn outside any container. The regression test asserts the invariant
rather than the symptom: scrolling a view may not change one pixel above it. I verified it the right
way round — with the fix removed it fails and names the pixels.

Commands: `npm test` 56/56, `npm run test:desktop` 22/22, `ctest` 5/5, `python3 tools/design.py
check`, `python3 tools/features.py validate`, `./init.sh`, and the cross-backend render comparison
with the gradient in the primitives scene. Evidence in `.cache/evidence/settings-popover.json` and
the two snapshots beside it.

Remaining: F73 (the nested explorer, whose toggle this feature was blocking), F69 and the KI-038
Windows suite repair, which also unblocks F37, F54, F62 and F67. The owner's sign-off notes for F60
and F67 are still outstanding; both were signed off "with notes" and the notes never arrived.

## Session 30 (macos) — 2026-09-06 — The game routes the workspace layer could not deliver

**Owner scope**: fix the defect that makes the newly-merged per-project game capability unreachable
on a live workspace. Worktree `.cache/worktrees/merge-verify`, branch `fix/worker-game-routes` cut
from `origin/main` at `f42bdea` and pushed per commit; the `main` ref untouched, `update_workspace`
deliberately not run from here, no other worktree or consumer repository edited.

**The defect.** Everything merged that day worked in isolation and failed through the live runtime:
every MCP game tool answered *"This retained service predates per-project game declarations. Update
the workspace layer first."*, and repeated `update_workspace` calls changed nothing. The cause is an
asymmetry in `orchestrator/runtime/worker.mjs`. Dashboard routes are **served** by the replaceable
workspace worker — it imports `dashboard.mjs` and answers `/api/dashboard` and `/api/dashboard-run`
— which is why `dashboard: 1` lights up the moment the worker is replaced. Game routes were
**forwarded** to the retained session host, and `projectGame` was never advertised, so that
capability was only ever the host's to give. Probed with its own token, the retained host
(`capabilities: {handoff: 1}`, the process from before this lane) answered
`GET /api/game-config?rootId=<vtmb-vr>&gameId=vtmb-flat` with **HTTP 200** and the removed built-in
config — `args: ["--flat","--game","nolf","--width","1280","--height","720"]`, `issues: ["Build NOLF
first; expected build/relith-nolf in the selected project."]` — for that root and for every
`gameId`. So forwarding did not merely fail to advertise; it returned wrong answers from deleted
code, which also rendered both of vtmb-vr's flat dashboard entries unavailable with a NOLF issue.
**The general lesson, now in spec 078 and KI-043: a capability served only by the retained host
cannot be delivered by a layered update.**

**The fix (F74).** `games.mjs` exports `inspectGame(root, gameId)` — the same body, `Games.inspect`
reduced to a one-line delegation — because preflight reads only the declaration, the filesystem and
`root.id`/`root.path`. The worker calls it, serves `GET /api/game-config`, and advertises
`projectGame: 1` beside `dashboard: 1`, so a routine workspace update delivers it.

**Only preflight moved, and that was decided by reading the code.** Creating a game session needs
`Sessions` (node-pty ownership and the retained output the session browser reattaches to),
`Surfaces.reserve()` and the session-id → surface-item map the host's `/surface` upgrade reads for
an `embedded` game — nolf-improved now declares three embedded records — and the host's
`/api/terminal` refuses `type: "game"` by design, in the merged code and in the retained host alike,
so there is no primitive a worker could compose a game session out of. Rather than claim a
capability the worker cannot deliver, the flag is split: `projectGame` (game-config from the
declaration) is advertised by the worker itself, `projectGameLaunch` (the launch too) is advertised
by the host and only **mirrored** by the worker from the host's own `projectGame`. Above an older
host the worker refuses `POST /api/game` and the `game` branch of `/api/dashboard-run` by name
instead of forwarding into the built-in game, and `launch_game` gates on `projectGameLaunch` with a
message that names the real fix (replace the session host, which requires quiescence) rather than
sending the agent to update the workspace layer again. `supervisor.mjs` needs no change: its worker
path passes the worker's set through, and its `workspaceWorkerUnavailable` fallback claims only what
the supervisor itself serves — adding `projectGame` there would claim declaration-backed routes
while the host is the one answering, which is this defect a second time.

**Failing check first**, per AGENTS.md: `games.test.mjs` drives the real supervisor and worker above
a proxy that advertises only `handoff: 1` and answers `game-config` with the built-in NOLF config.
Red at `capabilities.projectGame` (`undefined !== 1`) in `658fec8`, green in `192d842`, and it also
pins the declared records, the unknown-`gameId` 404, dashboard availability from the declaration,
both refused launch paths, and `game_preflight` answering through the real MCP connector while
`launch_game` reports the host limit. `dashboard.test.mjs` pins the merged-host path.

**Gates**, re-run after `git fetch origin` + `git merge origin/main` (`f42bdea`, already
contained): `npm test` 56/56 (7.2 s); `npm run test:desktop` 18/18 sequential (354.5 s);
`ctest --test-dir .cache/desktop` 5/5 (0.08 s); a clean `cmake` configure + Release build, exit 0
with **0 warnings**; `./init.sh` green; `tools/design.py check` (19 cards, mirror, 3 presets);
`tools/features.py validate` (33 features); `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run
test:game-nolf` 1/1 (4.86 s) — real NOLF renders and takes menu input through a dashboard game
action. Both live consumer declarations re-validate through the fixed code: vtmb-vr's `vtmb-flat`
ready with `build/vtmb` and `vtmb-vr` unavailable naming its executable, nolf-improved's three
embedded records all ready. Evidence:
`docs/evidence/worker-game-routes-macos-2026-09-06.md`. Sidecars refreshed sequentially on a private
index (`.cache/sidecars-worker-game.sqlite`); the remaining repo-wide drift is in
`orchestrator/native/**` and `tests/native-client.mjs`, untouched here and owned by the other lanes.

**Feature id**: F73 was free on `origin/main` (`f42bdea`) and was taken here first, then released:
the concurrent design lane's *unpushed* local `main` (`67959f9`) already commits F73 for the project
explorer's in-place expansion. This work is **F74**, renumbered before push so the owner's next main
advance carries no collision. Verify ids against the tip that is about to move, not only the pushed one.

**Remaining**: F74 stays `passes: false` with F71/F72 until the owner verifies the live workspace
after `update_workspace`. Launching a declared game there still needs the session host replaced
(quiescence, which stops the retained PTYs); preflight and dashboard availability do not. Windows
stays unqualified (KI-014).

## Session 29 (macos) — 2026-09-06 — Merging contract 3 and the integration recipe onto the card toolbar

**Owner scope**: reconcile two finished branches onto main and report green before main advances.
Worktree `.cache/worktrees/merge-verify`, branch `integ/contract-3`, pushed per commit; the `main`
ref untouched. Base moved four times mid-merge (`8c44250` -> `b6f8b84` -> `776647a` -> `6258be0` ->
`c8aea10`). While the base was still ahead of any commit of ours the merge was restarted from
current `origin/main`; once there were commits to keep, main was merged in. Either way `theme.h`
and `theme.c` are generated from the resolved `theme.json` rather than conflict-resolved, and the
last regeneration was compared against what the merge produced to prove they agree.

`c8aea10` merged `feat/integration-recipe` into main directly, so this branch's second merge is now
a redundant path to the same commits and merges clean. It also means `docs/specs/077-editor-syntax.md`
and `docs/specs/077-project-integration-recipe.md` now **both exist on main** — a spec-number
collision between the design lane and the recipe lane that predates this branch and needs an owner
renumber; nothing references the editor-syntax one yet, so it is the cheaper of the two to move.

**`feat/project-game` (299eebe)** conflicted in three files because main's Claude Design series
rewrote the toolbar underneath it. `workspace.c`: main's card toolbar supersedes our edit, which
removed the game column from a `mu_layout_row` that no longer exists; `session_running()` and the
`RE_GAME && t->terminal` branch that gives an external game its status row, its `game-status`
control and its rect are ported onto the rewritten file — without that branch `surface: "external"`
has no view, and vtmb-vr declares both of its games external. **Main's rewritten toolbar still
carried the NOLF cell**, so spec 078's removal still had work here: the cell, its
`re_app_action(a, "game", …)` by rootId — the last caller of the old single-game route — its
control record, its width in `trailing` and its one leading gap (`7 *` -> `6 *`, one per cell after
the path field: field, Add project, Agent label, agent field, Vim, Theme). Main registers the
root-cycle control as `"root"` and the fixture drives `"Root"`; ours kept. `theme.json` unioned
(main's `design` note, our longer `game` note); `toolbar.game-width` and the games-menu metrics and
strings are gone and nothing names them. `package.json` unioned to 17 desktop specs, keeping the
`test:nolf` -> `test:game-nolf` rename.

**`feat/integration-recipe` (2ba3db3)** conflicted only in the four inventory files both lanes
append to. `features.json` took F70 beside F71/F72 as a 24-line insertion with nothing removed —
built from the merge-1 tree, not the merge base, because the recipe branch forked before main's F60
evidence landed and carries the older copy of that record. `docs/roadmap-graph.md` is generated, so
it was regenerated. No id collides: F70/F71/F72, specs 077/078, KI-041/KI-042.

**A gap the merge had to close**: nothing pinned the toolbar row's geometry, so a half-done cell
removal would compile and render one gap wrong. `re_app_inspect` now reports the window size and
`native-game-declaration.spec.mjs` asserts the last cell's right edge lands on the toolbar padding
(measured: Theme at x=1248 w=22 -> 1270 = 1280 - 10). It also expects main's Theme cell in the row.
`native-nolf.spec.mjs` now fails rather than logs if a dashboard game action returns anything but a
game-typed session on its declared surface in a game pane — a terminal instead of a game pane was
the original report — and records `sessionType`/`surface`/`tabType` in its evidence.

**Gates** (final run, on `c8aea10`): `npm test` 55 passes / 5.9 s; `npm run test:desktop` 18 passes
/ 319.8 s from a wiped `.cache/desktop`, zero warnings; CTest 4 passes / 0.65 s; `./init.sh`
(32 features); `tools/design.py check` consistent; `tools/features.py validate` clean;
`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:game-nolf` 1 pass / 3.3 s, evidence
`sessionType: game`, `surface: embedded`, `tabType: 5`, 6 frames. The font-fallback commit changes
glyph lookup and so could have moved the row the toolbar fixture pins; it did not — the trailing
cells sit at the same x they did before it (Add project 958, agent 1074, Vim 1202, Theme 1248) and
the last right edge is still 1270 on a 1280 window. They stay put because the path field absorbs
the slack, which is the reservation the `6 *` multiplier belongs to. Sidecars refreshed with
`--index .cache/sidecars-merge.sqlite` run sequentially: the four `workspace.c` anchors and
`app.c` repaired and stamped, two notes added (`inspect-reports-window-size`,
`external-game-status-row`); every remaining diagnostic in the tree also exists on `origin/main`.
Both consumer declarations re-read fresh through the merged reader: vtmb-vr contract 3,
`troika-vpk`, `vtmb-flat`/`vtmb-vr` both external, dashboard `reSource`; nolf-improved contract 2,
`lithtech-rez`, dashboard `reLith`; no `error`/`gamesError`/`dashboardError` on either.

**Left as found**: `native-game.spec.mjs` aborts in a fresh worktree until `npm run build:surface`
has produced `.cache/native/` — a prerequisite `test:desktop` does not run, not a regression; it
passes once built. Both lanes numbered their sessions from the same base, so the entries below
carry two Session 25 and two Session 26 headings, all 2026-09-06; kept as each lane wrote them.

---

## Session 28 (macos) — 2026-09-06 — Declaration errors name the offending record

**Why now**: the reLith consumer session reported the consequence of session 27's toolbar removal.
A section fails whole — `orchestrator/server/dashboard.mjs:35` answers `groups: []` on any
`dashboardError`, and `formats.mjs` raises that for any cross-rule problem anywhere in the section —
so one typo in one unrelated dashboard action (a bad `into` on a capture entry, a stray key) empties
every group and removes the only human path to launch **any** game, including targets whose own
`games` records are perfectly valid. Fail-whole is right and stays: a partial dashboard rendered
from an invalid declaration would show something that does not match the file. But it makes the
error string the entire recovery path, and that string identified records only by array index
(`$.dashboard.groups[0].actions[2].into must be root-relative` — count the actions in the file).
A refinement of **F72**, not new scope: its criteria gained one row rather than taking a new id.

**The change**: every cross-rule error now names the record beside its JSON path, in all three rule
modules so the sections read alike. The path is what a machine consumer keys on; the id is what a
human greps for.

```
$.dashboard.groups[1].actions[1] (quest-screen).into must be root-relative
$.games[1] (vtmb-vr).cwd must be root-relative
$.formats[0] (troika-vpk).default must be one of its modes
```

The **innermost** record is named, not every level: action ids are unique across the dashboard, so a
named action already locates itself, and naming its group too would push the id ~8 columns further
right in surfaces that clip. An action with no usable id falls back to its group
(`$.dashboard.groups[0] (device).actions[0].into …`), and with nothing named the bare path stands
alone — `undefined` is never printed and no name is invented. **Duplicate-id errors keep the bare
path**: they already quote the id, and what must stay unambiguous there is which occurrence repeats,
which is the index. Structural (schema) errors also keep bare paths — `schema.mjs` is a generic
validator with no notion of a record, and for `formats` a structural failure short-circuits before
the cross rules anyway. One `nameOf` helper, duplicated between the two rule modules exactly as
`rootRelative` already is (both stay import-free so the reader and the runtime can share them);
`formats.mjs` imports it rather than carrying a third copy.

**Two decisions asked for explicitly.** (1) **Truncation stays at three** and now names what it
hides (`…; and 2 more problems`). The message is one unwrapped line in both places it is read: the
dashboard tab label, clipped at the pane width, and the status row — 1272 px over an 8 px Menlo cell
at the theme's 16 px face is ≈159 columns at the default window, copied into a 512-byte buffer.
Three id-carrying problems already fill that, so a larger cap pushes content off the right edge
rather than closer to a fix, and problems cascade from one bad record anyway. What was missing was
knowing the list had been cut. (2) **Native rendering needs no layout change**: the id lands around
column 55–70, well inside both surfaces, and the count is deliberately last because it is the least
load-bearing part of the line and the first thing to lose to clipping or a 512-byte truncation.
`native-format-hardening.spec.mjs` now qualifies that: its broken root carries a cross-rule error
instead of a structural one and the test asserts the status row names `(fixture-pack)` inside the
first 100 columns. Structural malformation stays covered by `formats.test.mjs`.

**Verification**: red first — `contracts.test.mjs` failed on the missing id before the change (1 of
3 in that file), and two existing expectations in `dashboard.test.mjs`/`games.test.mjs` moved to the
new shape rather than being relaxed. `npm test` 46 passes / 5.8 s; `npm run test:desktop` 17 passes
/ 296.2 s; CTest in `.cache/desktop` 4 passes / 0.04 s; `./init.sh` (31 features);
`python3 tools/design.py check` consistent; native build zero warnings; sidecars with
`--index .cache/sidecars-error-ids.sqlite`, run sequentially, clean for the three touched modules
(new `dashboard-rules.mjs#record-identity`, `game-rules.mjs#record-identity`,
`formats.mjs#bounded-report`; four drifted anchors in those files repaired). Both live consumer
declarations were re-read fresh and validate with no `error`/`gamesError`/`dashboardError` —
vtmb-vr (contract 3, which has meanwhile adopted `kind: "game"` for `flat`/`flat-newgame`) and
nolf-improved (contract 2); no assertion touches their command strings and neither repository was
edited. Left alone deliberately: the symmetric version gate in `SECTIONS` and the independent
parsing of the sections, both verified correct beforehand.

**Remaining**: unchanged from session 27 — F72 stays `passes: false` until the owner merges
`feat/project-game`, runs `update_workspace` and sees a real consumer launch from its dashboard.
Evidence appended to `docs/evidence/project-game-macos-2026-09-06.md`.

## Session 27 (macos) — 2026-09-06 — Games launch from a dashboard action; the toolbar game control is removed

**Owner scope**: a decision from the reLith stream, relayed and confirmed. That consumer launched a
game from its dashboard and got a terminal tab instead of a game pane, because dashboard launches go
through `kind: "script"` actions while only the toolbar button reached the game surface —
`list_sessions` showed `type: "game"` for the button and `type: "terminal"` for the action. The
resolution reverses part of `0cf70b6` on this branch: contract 3's dashboard gains an action
`kind: "game"` that names a declared record and launches it through the same route the button used,
and the **toolbar game control is removed entirely** (button, `Games` menu, disabled entries) rather
than relabelled or hidden behind a flag. Configurable toolbar items are a separate rEngine feature
the owner will scope later, so nothing replaces it and no stub button is left. The preflight/launch
machinery of `3440ef5` is untouched and is what the action calls. Same branch `feat/project-game`,
same spec 078 and KI-041, both amended; new row **F72** (verified free across `origin/main`,
`origin/feat/integration-recipe` and this branch), and F71's toolbar criterion corrected in place
with the decision recorded beside it. Pushed to `origin/feat/project-game` after every commit, not
merged.

**The action**: `{ id, title, kind: "game", game: "<declared id>", args?: [...] }`. `game` is
required and must name a record in the same declaration's `games` array; an undeclared reference is
a cross rule reporting the id and the declared ids, landing in `dashboardError` without disabling
the formats, the `games` array or the workspace. When the `games` block itself failed the reference
check is **skipped** — `gamesError` already names the real problem and a derived error would send
the reader after the wrong key. `args` is optional literal argv appended to the record's own, held
to the record's rules (non-empty, no `${…}`) as a cross rule so script-action `args` keep their
meaning. Availability is the referenced record's preflight, injected (`games.inspect` on the host, a
call to the retained host's `game-config` route in the replaceable worker) rather than recomputed,
so a dashboard row shows exactly the verdict the launch will apply; the action's own
`requires`/`tools` are checked in addition, and a failing row's label prints the preflight issue as
the sentence it already is.

**Decided deliberately — the same game with different `args`** (vtmb-vr's plain flat launch and its
`--newgame` variant). Coalescing **stays per (root, game id)** and a differing launch is **refused**
with 409 naming both argv. The declared id is already the single identity of a running game session
(`launch_game`/`game_preflight` select by it, the snapshot carries it, the native tab binding and
`RENGINE_INITIAL_GAME` resolve through it), so keying on argv would put two live sessions under one
id with no way for an id-keyed route to say which it meant. The option explicitly avoided is the
silent one — attaching and dropping the caller's arguments, handing someone who clicked "new game"
the old session with no indication why. The in-flight map now stores the argv beside the promise: an
identical concurrent launch joins the flight, a differing one chains behind it and meets the same
refusal instead of racing a second spawn. Game sessions carry their `args` so the comparison has
something to compare.

**`args` rationale corrected**: it rests on ONE consumer, not two. vtmb-vr's `--newgame` is a real
flag of its `src/main.cpp`; reLith's `--world`/`--shells`/`--campaign` are not engine flags at all —
their fast-start script rewrites a `boot_mode` value into a temporary profile copy and passes
`--profile FILE`. The rule recorded in spec 078: `args` serves a variant expressible as argv; one
needing a different profile or config file belongs in its own `games` record or a `script` action.

**Removed**: `workspace.c`'s `games_menu` container, the toolbar's conditional game column, the
menu bookkeeping and the pointer-routing exception it needed; `app.c`'s `re_app_games`,
`re_app_game_entry`, `re_app_games_probe`, `re_app_launch_game`, `game_key`, `probe_game`,
`game_config_loaded`, `OP_GAME_CONFIG` with its error branch, the `game_configs` cache and the
`games` array in `re_app_inspect`; `app.h`'s declarations, `menu_*` fields and `RePending.game`;
`theme.json`'s `toolbar.game-width`, `games-menu-width`, `games-menu-inset`, the row-1 game string
and the `games-menu` string list. Row one is now a literal fixed array of ten metric widths plus the
`-1` filler passed with `RE_ARRAY_SIZE`, so no run-time count can disagree with it; `theme.h` was
regenerated and `design.py check` passes, and the native fixture asserts the exact control list for
a root that *does* declare games — the case the removed column used to alter.

**Verification**: red first — 2 of 45 service tests failed before the service knew the kind. Then
`npm test` 45 passes / 6.8 s; `npm run test:desktop` 17 passes / 374.1 s (18 before: the two toolbar
tests become one dashboard-driven fixture); CTest 4 passes / 0.77 s; `./init.sh` (31 features);
`design.py check` consistent; native build zero warnings — it caught the mirror image of last
session's defect, removing `game[65]` from `RePending` left an excess `""` the compiler was
assigning into `timeout`. Sidecars with `--index .cache/sidecars-game-action.sqlite`, run
sequentially, clean for the eleven touched files: two new entries
(`dashboard-rules.mjs#game-reference`, `dashboard.mjs#game-availability`), three removed with the
code they described, `games.mjs#launch-identity` extended; the same 18 pre-existing whole-tree
diagnostics remain in untouched files.
`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:game-nolf`: 1 pass / 4.7 s, now launching
**through the dashboard game action** — the fixture writes a one-action dashboard, clicks
`dashboard-action`/`nolf-flat` and waits for real frames, and its `evidence.json` records
`"launchedBy": "dashboard game action nolf-flat"`. That is the regression proving the new path
reaches a real game session rather than a terminal.

**Consumers**: the vtmb-vr fixture is refreshed from its live declaration (its `formats` entry has
since gained `--single` and a `*.vpk` glob — another agent is editing that section, and no assertion
depends on the command strings) and validates with zero errors, as does the same document with its
`flat`/`flat-newgame` quick-start actions rewritten to `kind: "game"` on `vtmb-flat`, which is the
shape that consumer is expected to adopt. nolf-improved's live contract-2 document still validates
unchanged. Neither consumer repository was edited.

**Remaining**: F72 stays `passes: false` until the owner merges `feat/project-game`, runs
`update_workspace` (workspace, desktop, connector) and sees a real consumer launch from its
dashboard; the live connector, worker and desktop predate the routes until that layered update. A
configurable toolbar is unscoped. Windows stays unqualified (KI-014) and the SDL3 cooperative
surface still does not exist (KI-041). Evidence:
`docs/evidence/project-game-macos-2026-09-06.md`.

## Session 26 (macos) — 2026-09-06 — Per-project game declarations reworked to the contract-3 games array

**Owner scope**: an explicit decision minutes after session 25 landed. This lane had implemented
"contract 2 + optional root object `game`"; the owner's nolf-improved session had independently
proposed an ARRAY under a contract bump (recorded there as F1615). The owner adopted the array
superset, **without** that proposal's deprecated `nolf_preflight`/`launch_nolf` aliases. Same
branch `feat/project-game`, same spec 078, same row F71 and known issue KI-041 — nothing
renumbered; pushed to `origin/feat/project-game` after every commit, not merged.

**Decided contract**: `contract` becomes the enum 1|2|3. Contract 3 = contract 2 plus the optional
root key `games`, 1–16 records with unique kebab-case ids. The singular `game` is REMOVED outright
with no alias — nothing had shipped it to a user, so there is no migration path to keep. Declaring
`games` requires `contract: 3`, which is the point of the bump: an older reader answers *unknown
contract 3* instead of *unknown key games*. New per-record `cwd` (root-relative, `""` = the project
root, re-confined in `spawnTerminal`); `surface` `sdl2-interpose` renamed `embedded` everywhere
including its platform-support message; `env` kept against the sibling proposal because NOLF's own
launch needs `RELITH_HIDDEN_WINDOW`/`RELITH_SKIP_INTRO`.

**Implemented**: `game-rules.mjs` gains unique-id and root-relative-`cwd` rules; `formats.mjs`
gets one `SECTIONS` table so each optional block declares the contract it needs (dashboard 2,
games 3) and reports `gamesError`/`dashboardError` independently of each other and of the formats.
`game-config`, `POST /api/game`, `game_preflight` and `launch_game` take an optional `gameId`
defaulting to the first declared game, with a 404 naming the declared ids for an unknown one.
**Reuse is per game id, not per root** (the decision this lane had to make): a launch coalesces and
reuses on the (root, game id) pair, so vtmb-vr can run its flat and VR targets at once; an
undeclared project fails before the reuse lookup so a foreign game session can never be handed
back. Native: the toolbar shows nothing without games, the declared title for one, and a `Games`
button for several that opens a menu window below the toolbar (anchored at the control, clamped
inside the window, drawn after the panes and owning its own pointer events). A ready entry is a
left-aligned button; a failing one is a disabled label reading `<title> — unavailable: <first
issue>`, mirroring the dashboard lane's unavailable action. Entries are preflighted per game id,
cached, and re-preflighted whenever the menu opens, so a build makes an entry available without
reconnecting; `re_app_inspect` exposes the rendered rows.

**Verification**: red first — 6 of 43 service tests failed before the reader knew `games`. Then
`npm test` 43 passes / 6.0 s; `npm run test:desktop` 18 passes / 310.3 s (the new multi-game menu
test is the eighteenth); CTest 4 passes / 0.91 s; `./init.sh` (30 features); `design.py check`
consistent; native build from a wiped `.cache/desktop` with zero warnings; sidecar
index/repair/review/stamp/check clean for the nine touched files with `--index
.cache/sidecars-contract3.sqlite`, four new entries added, and the same 18 pre-existing whole-tree
diagnostics as on main in files this session did not touch.
`RENGINE_NOLF_ROOT=/Users/alex/nolf-improved npm run test:game-nolf`: 1 pass / 3.26 s, through a
contract-3 declaration whose `games` array holds the NOLF record with `surface: "embedded"`.
The clean rebuild caught a real defect: adding `game[65]` to `RePending` made the existing
aggregate initialiser consume the `timeout` argument into the new array — fixed.

**Consumers**: `contract2.test.mjs` is renamed `contracts.test.mjs` and pins both real
declarations verbatim — vtmb-vr's live contract-3 document (formats + `vtmb-flat`/`vtmb-vr`, both
`external`, + the reSource dashboard) and nolf-improved's live contract-2 document (formats +
dashboard, no games), which still validates unchanged — plus a contract-1 document and the
rejection of `games` under contract 2. `formats.test.mjs` and `dashboard.test.mjs` moved their
unknown-contract case from 3 to 4.
Evidence: `docs/evidence/project-game-macos-2026-09-06.md`; KI-041 records what stays open.

**No new collisions**: `origin/main` holds F32–F69, specs through 076 and KI ids through KI-040;
`origin/feat/integration-recipe` adds F70, spec 077 and KI-042. This lane keeps F71, spec 078 and
KI-041.

**Remaining**: owner merges `feat/project-game` into main, pushes, runs `update_workspace` with the
workspace, desktop and connector layers, and verifies the two consumers' declarations in the live
window; an SDL3 cooperative surface is its own spec; Windows unqualified (KI-014). A long
unavailable-issue string clips at the games menu's right edge like every other long label in this
desktop; the full text is in the preflight and the inspect payload. One correction to the brief:
the vtmb-vr VR entry was expected to be the live disabled example, but `build/vtmb-vr` exists on
this machine as a Mach-O arm64 binary from 2026-08-23, so both vtmb-vr entries preflight ready and
the disabled path is proven by the fixture's always-missing record instead.

---

## Session 25 (macos) — 2026-09-06 — Per-project game declaration and the contract-2 reconciliation

**Owner scope**: explicit direction (overriding the AGENTS.md pause note): remove the toolbar's
hard-coded "NOLF" button and the `nolf_preflight`/`launch_nolf` tools; a project declares its game
in `.rengine/project.json` (contract 2, optional `game`), rEngine shows a title-labelled button,
launches it and exposes generic tools, and names no game anywhere in server/native/agent/theme
code. The second consumer (vtmb-vr, SDL3-static, no SDL2 interposer) must launch in its own
window today. Branch `feat/project-game` from `43bbb80` in a worktree; not merged, pushed to
`origin/feat/project-game`. Spec 078, row F71. The concurrent dashboard lane (spec 075) landed on
main mid-session, so the same branch also carries the reconciliation of the two contract-2 lanes.

**Implemented**: `contracts/project-v1.schema.json` accepts contracts 1 and 2 with a `game` block
(`id`, `title` ≤ 32, 1–8 `executable` candidates, literal `args`, `env`, `requires`, `surface`
`sdl2-interpose`|`external`); `readDeclaration` validates the game block separately and reports
`gameError` beside intact formats; `game-rules.mjs` rejects reserved `RENGINE_`/`DYLD_`/`LD_` env
keys and escaping `requires`. `games.mjs` resolves the first candidate (absolute, root-relative with
a Windows `.exe` fallback, bare PATH name), names every missing required file, reserves a surface
and injects the adapter only for `sdl2-interpose`, and spawns `external` games as plain PTY
children with the declared env; sessions carry `title "<title> · <root>"`, `surface`, `game`; the
host advertises `projectGame: 1`; MCP `game_preflight` (read-only) and `launch_game` (open-world)
replace the removed tools and gate on the capability. Native: the toolbar row is built from theme
metrics with the game column only while the bound root declares a game (label = declared title,
`game-width` 110), the root button is inspectable, and an external game tab is the retained-PTY
terminal view under a "Running in its own window" / "Game exited" status row from theme.json.
The real-NOLF qualifications write the NOLF declaration into their temporary project;
`test:nolf` → `test:game-nolf`; README updated.

**Reconciled with the dashboard lane** (main `6a3271d`, merged in): one schema declaring BOTH
optional `dashboard` and `game` under `additionalProperties: false` with each lane's `$defs` kept
intact; one reader that splits both blocks off and validates each through a shared `section`
helper, so `gameError` and `dashboardError` are independent and neither can disable the formats;
`capabilities` advertising `dashboard: 1` and `projectGame: 1`; both tool families in
`mcp-worker.mjs`, each behind its own capability guard; one toolbar row of 12 columns holding the
fixed Dashboard button and the conditional game button, with the game column collapsing into the
Vim filler when no game is declared; the session title default no longer naming a game. The
toolbar theme note and `toolbar-row-1` string table now record the Dashboard button, which the
dashboard lane had not. `orchestrator/tests/contract2.test.mjs` pins the composition and the real
consumer declarations; the same fixture is rejected by either lane alone.

**Verification**: red first (reader, preflight, launch, launcher message, native "NOLF" control),
then on the reconciled tree: `npm test` 43 passes / 6.07 s; `npm run test:desktop` 17 passes /
294.3 s (dashboard tab and declared-game fixtures both green); CTest 4 passes / 0.05 s;
`./init.sh` (30 features); design check consistent; native build zero warnings; sidecar
repair/review/stamp/check clean for the eleven touched files with `--index
.cache/sidecars-contract2.sqlite` (18 pre-existing whole-tree diagnostics remain, all in files
this session did not touch, and are present on main). `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved
npm run test:game-nolf`: 1 pass / 3.34 s, through the written declaration. The vtmb-vr contract-2
declaration (formats + external game + dashboard) and the nolf-improved contract-1 declaration
both validate through `validateSchema` and `readDeclaration`.
Evidence: `docs/evidence/project-game-macos-2026-09-06.md`; KI-041 records what stays open.

**Renumbering**: main took spec 076 (design foundations) and F67–F69 mid-session, and the recipe
lane took F70, so this lane moved spec 076 → **078** and F67 → **F71**, and its known issue from
KI-039 (taken by main) to **KI-041** (KI-040 is the dashboard's). References were updated one by
one, never by a blanket rewrite, so main's own F67–F69 and spec-076 citations stay intact.

**Remaining**: owner merges `feat/project-game` into main, pushes, runs `update_workspace` with the
workspace, desktop and connector layers, and verifies the two consumers' declarations in the live
window; an SDL3 cooperative surface is its own spec; Windows unqualified (KI-014).
`feat/integration-recipe` carries a duplicate `KI-040` (its own row plus the dashboard's, inherited
from main) that needs renumbering before it merges.

---

## Session 26 (macos) — 2026-09-06 — Integration recipe: contract-3 drift and the KI renumber

**Owner scope**: a review of the finished `feat/integration-recipe` branch produced a drift list.
The sibling game lane's contract changed by owner decision on 2026-09-06 — the singular `game`
object is replaced by a multi-game `games` array at `contract: 3`, reconciled with nolf-improved's
competing F1615 proposal but **without** its deprecated `nolf_preflight`/`launch_nolf` aliases —
and this recipe documents that contract in five places. Worktree
`.cache/worktrees/integration-recipe`, branch `feat/integration-recipe` from `ccbb29e`; pushed per
commit. `origin/main` (`6a3271d`) was already an ancestor, so no merge was owed.

**Verified before writing, and again at the end**: the shape was read out of the sibling branch,
not assumed. At the start `origin/feat/project-game` still carried contract 2 with a singular
`game`, and a local `feat/game-contract` at `0f40b24` carried a contract-3 draft that numbered its
spec `077` (colliding with this branch) and narrowed game `executable` to root-relative only; that
branch was deleted while this session ran. By the end `origin/feat/project-game` (`3440ef5`, spec
`078`) had landed the decided shape and it **agrees with the brief on every point**: contract enum
`[1, 2, 3]`, `games` 1–16, `id` kebab ≤64 and unique, `title` 1–32, `executable` 1–8 candidates
sharing the format `argv[0]` definition (absolute, root-relative with a separator, or a bare PATH
name — not root-relative-only), literal `args`, UPPER_SNAKE `env` with `RENGINE_`/`DYLD_`/`LD_`
rejected, root-relative `cwd`/`requires`, `surface` `embedded`|`external`, and the tools
`game_preflight(gameId?)`/`launch_game(gameId?)`. The scaffold and the reference template were then
validated against that landed schema and its `gamesRules` — zero errors each.

**Drift fixed**: spec 077 and the templates README cited "076 (game)" and the runbook cited
"specs 074/075/076"; the game spec is `078` (main took 076 for design foundations). The runbook's
Game bullet called `executable` "a list of root-relative candidates" and omitted the reserved env
prefixes, the literal-args rule and the 1–8 bound that its Dashboard bullet documents properly; it
is now a per-field list covering the array, id uniqueness, `cwd`, the none/one/menu toolbar
behaviour and both surfaces. The test's local re-implementation of the contract rules is gone: it
had drifted in two directions at once (rejecting legal absolute/PATH `executable` candidates,
accepting reserved `env` prefixes) and its "this branch's reader knows contract 1 only" comment was
about to go stale; the helper now calls the shipped `validateSchema` plus `dashboardRules` (and
`gameRules` when the game lane ships it), validating the core with `games` removed and naming the
uncovered tier while the committed schema predates contract 3. The wizard emits a one-record
`games` array at `contract: 3`, takes `--game-surface embedded|external` and rejects the retired
`sdl2-interpose` spelling by naming `embedded`; the reference template moved to contract 3 with two
records (one `embedded`, one `external`, exercising `args`/`env`/`cwd`/`requires`), and the copied
Python declaration test follows. The two worked-example tables now carry the multi-target shapes —
nolf-improved with three `embedded` targets on one LithTech engine, vtmb-vr with two `external`
ones forced by its static SDL3 link — both marked as the shapes those projects are **adopting**,
not verified live state.

**Flags kept single-valued**: `--game-title/--game-exe/--game-surface` scaffold one record, the way
the wizard scaffolds one placeholder format and one dashboard action. Repeatable flags would need
order-dependent record flushing for a skeleton the project edits anyway; the multi-record array is
shown in the reference template and printed as follow-up 5 instead.

**Identifier collisions**: this branch carried two `KI-040` rows after the main merge — the
dashboard lane's and its own. The recipe's row is now **KI-042** (the game lane took KI-041), the
dashboard row is untouched, and the citations moved in `docs/specs/077-*`, the runbook (twice), the
templates README and the evidence document. The same merge had also duplicated `KI-039`: the
branch's stale copy is removed and main's updated row kept verbatim. Two collisions remain for the
owner to settle at merge time and were **not** touched here: the deleted `feat/game-contract` draft
had claimed spec `077` and row `F70`, both of which this branch owns (the surviving
`feat/project-game` uses `078`/`F71`, so this may already be moot), and `feat/project-game` also
numbers its entry below "Session 25", as this branch's previous session does.

**Gates**: `npm test` 47/47 (46 before, +1 new check), exit 0; the recipe file alone 9/9, red on 4
of them before the wizard and template moved; `./init.sh` and `python3 tools/design.py check`
clean; `python3 tools/features.py validate` 30 features; `bash -n` clean on the wizard and the
template `editor.sh`; sidecar repair/review/stamp/check clean on the touched sidecars with the
private index `.cache/sidecars-recipe-drift.sqlite`. `docs/roadmap-graph.md` regenerated identical,
so it is unchanged. Evidence appended to
`docs/evidence/project-integration-recipe-macos-2026-09-06.md`.

**Remaining**: F70 stays passing and spec 077 stands; only their contract-facing wording moved,
with the owner's 2026-09-06 decision as the rationale. KI-042 is still open (Add project should run
this recipe natively). The repo-wide sidecar check reports pre-existing, unrelated drift in
`orchestrator/native/*` and `orchestrator/tests/native-client.mjs` that is present at `ccbb29e` and
belongs to the native/design lanes.

## Session 25 (macos) — 2026-09-06 — Project integration recipe

**Owner scope**: "for next rengine integrations or new projects we should have this recipe stored
and later adapted in the orchestrator interface." Branch `feat/integration-recipe` (worktree
`.cache/worktrees/integration-recipe`, base `43bbb80`; not merged, not pushed). Generalised from
what nolf-improved did on 2026-09-06 (its rEngine submodule, `editor.sh`, REZ format registration
and dashboard features) and what the vtmb-vr lane is doing now; both consumer checkouts were read
only, never modified.

**Landed**: spec `077-project-integration-recipe.md` (scope, recipe, ownership split, what a
wizard may automate versus what stays a project decision). `docs/runbooks/project-integration.md`
— prerequisites, submodule pin/bump policy, the `editor.sh` launching point, the contract-2
`.rengine/project.json`, the three test tiers a consumer keeps and how to register them, skills and
CLAUDE/AGENTS wiring, the cross-vendor review gate, opening the project window, layered updates,
owner-verified consumer gates, plus the nolf-improved and vtmb-vr instances as tables and what the
Add project button should automate. `orchestrator/actions/integrate-project.sh` — a five-stage
wizard in the `lib/wizard.sh` conventions (verify the repository and that the remote advertises the
pin, add and pin `third_party/rengine`, install `editor.sh`, write the declaration, copy the
declaration test) that never overwrites, prints a plan under `--dry-run` and prompts only on a TTY.
`orchestrator/templates/project/` — `editor.sh`, the reference contract-2 `project.json`, a generic
`test_rengine_project_decl.py` (structure always, pinned schema when the pin carries the declared
contract, behaviour when the CLI is built) and a README naming each destination; no template names
a game or a format.

**Verification**: `orchestrator/tests/integrate-project.test.mjs` was red for all seven checks
before the action existed. Final `npm test` 43/43, exit 0 (70 s); the new file alone 8/8 (9.2 s);
`bash -n` clean on both scripts; `./init.sh` and `python3 tools/design.py check` pass; sidecars
repaired/reviewed/stamped/checked with a private index. A manual end-to-end run scaffolded a
throwaway repository from a bare `file://` clone of this worktree: the submodule pinned at the
requested SHA, `./editor.sh --check` reported `SDL2 2.32.10` and `cmake 3.31.2` out of the pinned
tree, and the copied Python test passed with both pinned-contract checks skipping with
`pinned rEngine supports contract [1]; this declaration is contract 2`. Evidence:
`docs/evidence/project-integration-recipe-macos-2026-09-06.md`.

**Remaining**: KI-040 — the Add project button should run this recipe natively (spec 002/071);
until then the wizard runs in a script tab. Both contracts require at least one format record, so
the scaffold writes an inert `*.example` placeholder; relaxing `formats` to `minItems: 0` for
contract 2 belongs to the dashboard/game lanes. F70 is recorded as passing on the automated
evidence above; no native or contract code changed. IDs: F70 and KI-040 were chosen after rebasing
onto main — which advanced by three Windows-renderer commits during the session and took KI-038 and
KI-039 — and after reading the dashboard worktree (F65–F66) and `feat/project-game`, leaving F67 to
that lane. `features.json`, `known-issues.md`, `docs/roadmap-graph.md` and `Codex-progress.md` may
still conflict with the concurrent contract lanes and are append-only here.
## Session 24 (macos) — 2026-09-06 — Project dashboard (contract 2, step 1)

**Owner scope**: after the format-registry review fixes, the second brief: a project dashboard
declared in `.rengine/project.json` (contract 2 = contract 1 plus an optional `dashboard`),
rendered as a tab of grouped actions; log filtering (step 2) and image display (step 3) deferred,
`stream`/`operator` reserved. Branch `feat/project-dashboard` from `2b04926` (review-fix tip; main
had moved to `35e73dc` without it, so no rebase yet); not merged, not pushed. Spec 075, rows F65/F66.

**Implemented**: `contracts/project-v1.schema.json` accepts contracts 1 and 2 with `dashboard`
definitions; the validator subset gains schema-valued `additionalProperties`; `readDeclaration`
validates the contract-1 part first and the dashboard separately (`dashboard`/`dashboardError`) so
a bad dashboard never disables previews; `dashboard-rules.mjs` holds the shared cross rules (unique
ids, per-kind fields, root-relative paths, UPPER_SNAKE env). `dashboard.mjs` computes availability
by root-bounded stat and a PATH walk without running anything, builds script/log session payloads
(bash + resolved script + literal args + env; the argv for logs) that the host's `terminal` route
creates, and runs captures under 10 s / 8 MiB requiring the PNG signature, writing
`<into>/<timestamp>.png` and `manifest.json` atomically inside the root. Routes `dashboard`,
`dashboard-run`, `dashboard-capture` on host and worker (`dashboard: 1`); `open_script` accepts
`env`; MCP `dashboard_actions` (read-only) and `dashboard_capture` (open-world). Native: tab type
`RE_DASHBOARD`, toolbar button, one-time auto-open per root persisted in the layout, group
sections, buttons for available actions and labels naming the first missing item otherwise,
run/capture/reveal handled in app.c, `dashboard.c` owns the rows (no microui pools).

**Verification**: service tests red (merged document rejected, routes 404) then green; native
fixture red (no dashboard tab) then green. Final: `npm test` 38 passes, 0 failures, 5.86 s; `npm run test:desktop`
16 passes, 0 failures, 330.91 s, exit 0 (two background attempts were killed at the turn boundary and produced no result; this is the complete foreground run); CTest 4 passes, 0.65 s; inventory validate (26), `./init.sh`, design check, sidecar
check/stamp for twelve sources. The nolf-improved merged document validates with zero errors.
Evidence: `docs/evidence/project-dashboard-macos-2026-09-06.md`; KI-040 records the deferrals.

**Remaining**: owner merges `fix/format-registry-review` then this branch, runs the layered
update, and verifies the real dashboard once nolf-improved moves its staged section into
`project.json`; steps 2 and 3 are separate specs; Windows unqualified.

---

## Session 23 (macos) — 2026-09-06 — Format registry review fixes

**Owner scope**: `feat/format-registry` merged to main as `f38db49` and running on the live desktop;
a Codex read-only review requested six changes, fixed on `fix/format-registry-review` (worktree
`.cache/worktrees/format-registry`, base `f38db49`; not merged, not pushed). Red test first for
each finding, then the fix.

**Fixed**: (1) directory expansion no longer touches microui's 48-slot treenode pool, whose
`mu_pool_init` aborts on the 49th open node in one frame; the view owns a hashed-path expansion
set and rows are plain buttons with a spacer indent. (2) `readDeclaration` reports structural
schema problems before the cross-field pass (which now guards every shape), `validateSchema`
uses `Object.hasOwn` so prototype names are unknown keys, and a failed formats request settles the
root as declared-with-error natively so text editors open and the status line shows the problem.
(3) `runCommand` takes the root record and re-confines `${file}` immediately before the spawn;
raw reads open first and require the opened inode to match a fresh confined resolution; the
residual path-taking window is stated in spec 074 and KI-037. (4) producers run in their own
POSIX process group and timeout/oversize kill the group (`taskkill /T /F` on Windows), close
the pipes and await the exit. (5) `preview_file` budgets the serialized reply at 32,000 chars,
pages files with `offset`/`limit`, reports `truncated`/`nextOffset`, returns root-relative
command metadata and redacts the absolute root from tool errors. (6) the native HTTP deadline is
per request: preview/entry requests use the declared `timeoutMs` plus two seconds of transport
and a transport timeout names that budget.

**Verification**: `formats-hardening.test.mjs` (4 tests) and `native-format-hardening.spec.mjs`
were red first (thrown TypeError, runner accepting an absolute path, grandchild alive after the
timeout, no offset/limit; the wide tree stalled and the 6 s producer failed the 5 s deadline).
Final: `npm test`: 35 passes, 0 failures, 5.57 s; `npm run test:desktop`: 14 passes, 1 failure, 288.49 s (exit 1): the failure is Codex's untouched `native-render.spec.mjs` budget assertion `opengl: resident memory delta 33536 KiB exceeds 32768 KiB`; it passes standalone (1 pass, 171.53 s) and the two format fixtures passed in that full run; a first full run failed the hardening fixture on the restored-tab deadline bug fixed afterwards (15 fixtures, including the
64-directory expansion, a text file under a malformed declaration and a 6 s producer inside its
10 s budget); CTest 4 passes (0.64 s); inventory validate (24), `./init.sh`, design check and
sidecar check/stamp for nine sources pass. KI-037 and spec 074 corrected where the review proved
them wrong.

**Remaining**: the transport-timeout message with the declared budget is not exercised by a
test (no fixture can stall the loopback service); Windows `.exe` resolution stays untested
(KI-014). Owner merges the branch, runs the layered update again and re-verifies the real window.

---

## Session 22 (macos) — 2026-09-06 — Project format registry

**Owner scope**: `*.rez` files in nolf-improved open in the editor with a raw hex mode by default
and a Preview mode showing the archive's contents (owner direction 2026-09-06, lane authorized
from the orchestrator session). Implemented generically as spec 074: a project declares formats
and the executables that produce their previews; rEngine owns the contract, execution boundary,
hex view and modes. Worked on `feat/format-registry` in `.cache/worktrees/format-registry`
because Codex holds an uncommitted Vulkan adapter (spec 073) on the main tree; not merged, not
pushed. Inventory rows F63 (contract/service/MCP) and F64 (native modes) added; graph regenerated.

**Implemented**: `contracts/project-v1.schema.json` (contract 1) with a bounded Draft 2020-12
subset validator; `orchestrator/server/formats.mjs` reads `<root>/.rengine/project.json`, reports
malformed declarations visibly without disabling the root, matches case-insensitive globs and runs
literal argv commands (`${file}`/`${entry}` only, cwd = root, shell environment, no shell, SIGKILL
on timeout/oversize, stderr's first line on failure). Routes `formats`, `format-preview`
(tree/text/entry with size, SHA-256, text when UTF-8, hex window) and `bytes` are served by the
host and the replaceable workspace worker (`formatRegistry: 1`); `resolveInRoot` is the shared
boundary. MCP `preview_file` slices the tree by dir/depth and is marked open-world. Native:
`hexview.c` (64 KiB window, 16 bytes per row, ASCII column, paging), `formatview.c` (mode switch,
microui treenode tree with sizes, entry split, refresh/retry, read-only text via a new editor
read-only flag), app/workspace wiring with pending-mode decisions, automatic raw fallback for
text-rejected files, mode persistence in the layout, and inspectable controls. New `format`
metrics in `theme.json`; `CMakeLists.txt` regenerated from `cmake.toml`.

**Verification**: Service tests failed before the module existed, then `npm test`: 31 passes
(4.86 s; final gate run 10.76 s). Native fixture red before wiring, then 1 pass (5.15 s); `npm run test:desktop`:
14 passes, 216.23 s, exit 0. CTest 4 passes (0.74 s); design check, `./init.sh`, sidecar check/stamp for eleven
files pass. Real consumer check against nolf-improved: declaration validates unchanged, tree of
`nolf/NOLF.REZ` in 69 ms (4,754 files), entries with matching sizes/SHA-256, entry paging, raw
window of the 618 MB archive, failing entry with relith-rez's stderr, and `preview_file` at
6.4 KB per slice. Evidence: `docs/evidence/project-format-registry-macos-2026-09-06.md`.

**Remaining**: Owner merges `feat/format-registry` into main after Codex's tree settles, runs
`update_workspace` (workspace, desktop, connector) so the live window and connector load the
routes and tool, then verifies `nolf/NOLF.REZ` opens raw and previews in the real project window;
F63/F64 stay false until that judgment. Deviations from the nolf-improved proposal are additive:
optional `dir`/`depth` on `preview_file`, hex `window` and `offset/length` paging on entries,
`bytes` route for raw windows; the declaration needs no change. KI-037 records Windows `.exe`
resolution, entry re-run cost and the treenode pool bound.

---

## Session 21 (macos) — 2026-09-06 — Project windows, interactive flows and curated skills

**Owner scope**: NOLF dogfooding needs a separate window with the current agent, inspection and
management, a return channel for rEngine findings and a reusable routine. The owner also requested
measuring/bundling llm-sidecar and adapting only the selected wizard skill, then clarified that
interactive script tabs are a first-class UI before native controls. Specs 069–071 record scope.

**Implemented**: Window layouts persist independently; the NOLF tree and existing rEngine agent
keep distinct explicit roots. Root-bound MCP/CLI open/list/inspect/focus/close/reopen windows and
exchange durable reports with retry keys/cursors. Added a reusable shell bootstrap and project
skills with Codex adapters. open_script/show_session run a project .sh as a retained interactive
PTY and attach its native tab without restarting coding agents. Production inspection cannot inject
keystrokes; view attachment failure returns the already-created script session for recovery.

**Real consumer**: The shell routine adopted the existing host without a keyboard restart and
opened NOLF with the original agent PID 20049. A subsequent agent-operated all-layer update
succeeded; the interactive workspace-status menu is now waiting in its new tab. Actual NOLF
report #2 requested pane zoom; acknowledged to that project and recorded as KI-036 for follow-up.
No game/provider/duplicate goal or conversation was launched. Existing agent/shell sessions remain.

**Verification**: Red MCP discovery for both window and script tools; final service 27 passes
(4.76 s), native 13 passes (103.92 s), CTest four passes, harness/design/inventory and shell syntax
pass. Native tests cover same-agent identity, separate selected layouts, draft recovery, reports
across updates and human-style interactive script input after reattachment. Six skill entrypoints
validate; bundled sidecar tests: 19 passes. Sidecar corpus output used 59.6% fewer bytes than full
source reads, but more than targeted excerpts; keep it selective. Excluding generated .cache
state improves real-workspace lookup and avoids indexing runtime credentials/captures. Full evidence:
`docs/evidence/project-window-dogfooding-macos-2026-09-06.md` and the sidecar efficiency record.

**Corrections/boundaries**: Fixed a test poll that raced next-request MCP worker replacement and
preserved reload-specific broker error text. An overlapped sidecar stamp hit SQLite writer
contention; reran sequentially with a separate session index and recorded cold-index limits. The concurrent OpenGL/F57 commit remains separate.
No broad feature gate changed here. ShellCheck unavailable; Windows runtime/transfer approval,
KI-024 gameplay and KI-036 zoom remain outstanding. Original host/supervisor protocol migrations
still require quiescence. The current older connector uses the CLI fallback; global configuration
and the user's installed skills were left untouched.

---

## Session 20 (macos) — 2026-09-06 — Layered workspace updates

**Owner direction**: Add agent-operated updates after one last keyboard bootstrap. Remained in
the verified root-bound rEngine CLI; preserved the original host, agents and shell PIDs.

**Implemented**: Spec 065 adds a private supervisor, replaceable workspace workers, immutable
native candidates with prepare/probe/rollback, a stable MCP facade with replaceable tool workers,
and a context-bound CLI fallback for the already loaded connector. Legacy native bootstrap adopts
the original host, deduplicates concurrent launches and creates no extra CLI. Updates report
acceptance separately from completion/recovery. Worker crash recovery retains sessions; original
host/supervisor protocol changes still require quiescence.

**Verification**: Failing MCP discovery before implementation; final service 23 passes (4.66 s),
native 11 passes (64.53 s), CTest four passes (0.05 s), harness/inventory pass. Native fixtures cover
dirty drafts, failed build/start recovery, old-launcher bootstrap and retained PID/input/invocation.
Evidence: `docs/evidence/layered-updates-macos-2026-09-06.md`. Concurrent F56 changes are preserved;
its initially failing draw-list test passes after that session's commit. Renumbered its duplicate
KI-031 design entry to KI-034, preserving the existing fixture KI-031 and all issue text.

**Remaining**: Production one-time adoption is not claimed; Windows runtime remains unqualified.
The owner next requested NOLF project-window management, inspection, a durable rEngine return
channel and a reusable agent routine. Continue that scope without a duplicate conversation or
goal. Earlier Windows transfer approval and OS shortcut-permission boundaries remain intact.

---

## Session 19 (macos) — 2026-09-06 — Repair Claude fullscreen mouse interaction

**Owner direction and context**: The owner prioritized the existing Claude `/rc` pane, where
items could not be clicked and scrolling did nothing. Verified the current orchestrator session
and root-bound MCP, preserving Claude PID 92674, Codex PID 20049 and original shells 33500/39735.
Private read-only Claude output shows alternate screen plus tracking 1000/1002/1003 and SGR 1006.
No provider prompt, Remote Control change, duplicate conversation/goal or sibling edit.

**Implemented**: Spec 063/F36 adds negotiated libvterm mouse buttons, hover/drag and precise signed
wheel, with logical cell mapping and native scrollbar/history precedence. Hover preserves keyboard
focus; held releases remain bound across pointer exit, focus loss, hide and detach. Snapshot replay
recreates the emulator and silences historical query responses that otherwise fill the outgoing
queue. Live queries still reply. Normal GUI close/reload releases buttons and drains queued and
in-flight stream sends before teardown, canceling visibly after two seconds if still busy. Pinned
upstream sources remain unchanged; headers/build declarations need no extra file-local notes.

**Verification**: The native click regression failed before the fix (8.71 s); a later regression
proved GUI close dropped the final held release (6.83 s). Final native desktop suite: eight passes,
48.00 s; CTest: three passes, 0.58 s; service/MCP: 21 passes, 4.41 s. Actual recorded Claude replay
passes (9.03 s), with no repeated historical query replies, SGR click/wheel delivery after same-PTY
reattachment and a working new live cursor query. Native checks also cover tracking modes, legacy
X10, modifiers, both screens, resize/pane movement, keyboard-focus isolation and final release.
Screenshots inspected; narrow static replay is protocol evidence, not live Claude layout proof.
Harness/inventory, source sizes/links, reviewed sidecars and diff checks pass. Full evidence:
`docs/evidence/native-terminal-mouse-macos-2026-09-06.md`.

**Environment findings**: Sandboxed service tests lacked loopback access; an unrestricted baseline
also inherited the real handoff into a temporary launcher fixture (20 passes/one failure). Tests
pass with only RENGINE_HANDOFF_FILE/GATE removed from test-child environments; KI-031 records the
fixture isolation gap. A transient missing-static-archive build failed once; the archive existed
on inspection and one sequential rerun passed. No cause is claimed; failed logs remain local.
The concurrent theme substitutions in b86f953 are included in the final tested build. Reviewed
and refreshed five stale source fingerprints from that commit; their notes still match the code.
Assigned this session's mouse issue KI-032 to preserve the concurrently committed design KI-030.

**Remaining and handoff**: The current Claude/agent/shell PIDs remain running. Cmd/Ctrl+Shift+R
loads the tested native build. The retained service/connector upgrade boundary and prior OS
shortcut-permission denial remain; no live GUI reload or live Claude menu action was claimed.
All 15 feature gates stay false. Return to KI-024 after owner-prioritized terminal repairs;
Windows, broader terminal clipboard/hyperlink/keyboard compatibility and optional service migration
remain independently scoped. Commit: `fix(native): forward negotiated terminal mouse input`.

---

## Session 18 (macos) — 2026-09-06 — Prepare the native UI for Claude Design

**Owner direction and boundary**: The owner asked to prepare the project for Claude Design to
enhance the UI. Treated as explicit, bounded preparation outside the paused NOLF goal; D28, every
feature gate and the active goal are unchanged, and no conversation or goal was started. Another
session's uncommitted spec 061/062 edits (native scroll/desktop-action sources, service, tests,
package.json) were present throughout and were left untouched and uncommitted.

**Implemented**: Spec 064 (renumbered from 063 after the other session's untracked 063 appeared) defines the single channel between Claude Design's HTML design-system
projects and the C/microui desktop. `design/tokens.json` (25 colours including the explicit
upstream microui defaults, typography, 12 metric groups, icon glyphs and UI strings) generates
`orchestrator/native/theme.h`, `design/tokens.css`, `design/manifest.json` and the managed blocks
of 13 self-contained `@dsCard` previews: colours, type/metrics and rendering constraints;
toolbar, pane header and status line; scrollbars; tree, editor, terminal, session browser and
game views; a 1280×800 workspace screen. `tools/design.py generate|check|import` uses the standard
library. `draw.c` now applies the generated palette, microui metrics, font size and line height
and carries a `generated-theme` sidecar constraint. Architecture table row, KI-030 and a design
README were added. Nothing under `design/` is loaded at runtime.

**Verification**: `python3 tools/design.py check` passes: header, CSS and manifest regenerate
identically, 13 cards are valid and self-contained, and every native `mu_color`/`vterm_color_rgb`
literal is a token. Native smoke snapshots from the pre-change binary and the rebuilt binary are
byte-identical (1280×800 logical, 2560×1600 drawable, cocoa); the PNG was inspected. CTest: three
passes. Import round trip: changing `--re-color-control` in a scratch copy of the colours card
moved the token and `RE_COLOR_CONTROL` to (60, 70, 90); tokens were restored and regenerated with a
passing check. Sidecar validator OK after one anchor repair. Harness gate passes. A read-only
DesignSync `list_projects` was refused until the owner ran `/design-login`; it then listed no
projects. On the owner's go-ahead: created design-system project “rEngine native workspace”
(`9e977c1b-7cbd-4a89-90a4-5524771712d7`), verified its type, locked a plan limited to `design/**`
(writes only), uploaded 18 files from disk and confirmed the remote listing matches the bundle.

**Remaining**: Cards edited in Claude Design return through `tools/design.py import`; later
syncs reuse the same project with a per-run plan limited to `design/**`. Replace the remaining literal colours in editor, terminal, workspace,
scroll, main and game sources with `RE_COLOR_*` once specs 061/062 land. No feature row was
added; spec 064 records a candidate. A Claude Design canvas seeded from `screens/workspace.html`
is an optional later step. All 15 feature gates remain false.
Commit: `feat(design): add Claude Design token bridge and preview library`.

**Follow-up (same session)**: On owner direction, replaced every remaining `mu_color` and
`vterm_color_rgb` literal in the editor, terminal, workspace, scroll, main and game sources with
`RE_COLOR_*`; `common.h` now includes `theme.h`, and `tools/design.py check` fails on any numeric
colour literal. Baseline and post-change native smoke snapshots of the same tree are byte-identical;
CTest: three passes; sidecar anchors valid; harness gate passes. The other session's uncommitted
terminal mouse-reporting edits in terminal.c and workspace.c stayed unstaged: those index entries
were built from HEAD plus the substitutions only. Commit:
`refactor(native): draw every colour through the generated theme constants`.

**Follow-up 2 (same session)**: On owner direction, moved the layout metrics onto the header.
Window size and minimum, toolbar rows and column widths, workspace top, status line, divider,
pane minimum and tree share, pane header and rows, tab-strip geometry, tree/session/editor/
terminal/game rows and insets, caret width, editor tab cells and native scrollbar sizes now come
from `RE_METRIC_*`; `tokens.json` gained 24 keys and `RE_SCROLLBAR_SIZE` was retired. `check`
also fails on numeric sizes in `mu_layout_row` calls, and the preview cards use the same
variables. Baseline and post-change smoke snapshots are byte-identical; CTest: three passes; the
seven committed native desktop specs pass (40.8 s); harness gate passes. The other session
committed its mouse-reporting work (`3c12fea`) while this was staged, so the shared
workspace/app/terminal entries were rebuilt from that HEAD plus the substitutions and verified
to contain none of its hunks. Commit:
`refactor(native): take layout metrics from the generated theme header`.

**Follow-up 3 (same session)**: The owner reported Claude Design updates that need rendering work
and set the direction: full GPU rendering behind graphics-API adapters, OpenGL first, then Metal and
Vulkan, with the renderer as a future approved-library candidate. Recorded as charter D29–D30, an
AGENTS boundary, architecture constraint 15, roadmap milestones R0–R3, features F56–F61 (blocked
behind existing desktop features) and spec 066 (renumbered from 065 after the other session's
untracked 065 appeared). Pulled the theming update verbatim: three-layer
`tokens.css` with default/teal/light presets, rewritten `base.css`, `styles.css`, six new cards and
thirteen rewritten cards. `tools/design.py` now parses the layered CSS, mirrors it into
`tokens.json`, resolves presets to sRGB with oklch conversion and validates cards that link
`styles.css`; the interim native source moved to `orchestrator/native/theme.json` and `theme.h` is
unchanged. `check` found `--terminal-cursor` referencing an undefined `--ui-accent-dim`; fixed
to `--re-accent-dim`, and the mirror now follows the CSS font stacks. On the owner's go-ahead the
corrected `tokens.css`, mirror, manifest and README were synced back to the design project (plan
limited to those four paths, four files written, remote cursor token verified). Harness
gate, graph regeneration and design check pass. Commit:
`feat(design): record the GPU rendering decision and pull the theming update`.

**Follow-up 4 (same session)**: On owner direction, started F56 although the inventory still
blocks it behind F34 and F42. Spec 067 defines draw-list contract v1 (`render/draw_list.h`: clip,
rect, rounded rect with corner mask, frame with inner highlight, shadow, ring, text runs in two
faces, icons, textures; string arena; sticky overflow with limits) and the adapter interface
(`render/backend.h`). Fonts moved to `render/font.c`, UTF-8 helpers to `render/utf8.c`, and all SDL
rendering into `render/backend_sdl.c` as the reference adapter. `draw.c` keeps the `re_draw_*` API as
a list builder that flushes once per frame on snapshot or end; the game view creates, updates and
draws its texture through the contract. `tools/design.py check` now fails when a native file above
the list names SDL rendering, OpenGL, Metal or Vulkan symbols. Verification: native smoke
snapshots before and after are byte-identical; CTest four passes including the new
`native_draw_list`; the eight committed native desktop specs pass on the reference adapter
(50.0 s); sidecars valid; harness gate passes. Evidence:
`docs/evidence/draw-list-macos-2026-09-06.md`. The other session's uncommitted CMake, main.c and
app.c edits stayed unstaged; the CMake index entry was built from HEAD plus the new sources and
test. F56 stays `passes: false` with its evidence recorded; F57 (OpenGL adapter) is next. Commit:
`feat(native): add the draw-list contract and SDL reference adapter (F56)`.

**Follow-up 5 (same session)**: F57 on owner direction after a `/grill-me` interview (spec 068
records eight attributed decisions; against the recommendation the owner chose OpenGL as the macOS
default on pass, a non-zero exit instead of a fallback, and vendored, pinned glad). The skills
grill-me, rengine-continue, rengine-audit, rengine-housekeep and rengine-ki-promote were copied and
adapted from nolf-improved with Codex adapters (commit ee744b1). `render/backend_gl.c` is an OpenGL
3.3 core adapter behind the draw list: one batched program (solid, signed-distance fill, ring and
shadow, coverage atlas, RGBA texture), a 2048² glyph atlas that repacks when full, scissor clips and
`glReadPixels` snapshots. Selection is `--renderer opengl|sdl` or `RENGINE_RENDERER`; the smoke line
and automation `state` report `backend=`; automation gained `stats` and `scene`; `scene.c` draws
every primitive; `tools/render_compare.py` applies the recorded tolerances;
`native-render.spec.mjs` captures both backends from separate server state with stable text and
is part of `npm run test:desktop`. Results: workspace and terminal scenes pixel-identical to the
SDL reference; primitives 0.80% differing, all within the 2px band (the per-channel limit inside
the band was dropped by owner decision after measuring 139); OpenGL medians 0.297/0.411/0.491 ms
against SDL 0.663/1.990/1.413 ms; resident memory +20.3 MiB of 32; the eight committed native specs
pass on OpenGL (50.7 s); CTest four passes; `--renderer sdl` stays byte-identical to the F56
baseline. The macOS default is now OpenGL; Windows keeps SDL and F57 stays unpassed until Windows
evidence (KI-014). Evidence: `docs/evidence/opengl-adapter-macos-2026-09-06.md`. Commit:
`feat(native): add the OpenGL adapter behind the draw list (F57)`.

**Follow-up 9 (same session)**: F60 on owner direction (“we need to update design to the proposed by
Claude Design, if microui is not enough - we write addition keeping the same compatible contract and
conventions like in microui lib”) after a `/grill-me` interview: spec 076 records eleven decisions,
charter D33–D34, and the split of F60 into F60/F67/F68/F69. Landed: `design/tokens.css` is now the
runtime theme source (theme.json holds bindings, `theme.c` carries every preset, `re_draw_theme`
switches live); `orchestrator/native/ui` is a separate `rengine_ui` target with owned controls in
microui's conventions and a transition clock; Inter and Phosphor are pinned as bundled faces with an
owned symbol-to-icon mapping; the toolbar, tab strip and status bar are redrawn to their cards; the
renderer became its own `rengine_render` target. Verification: `design.py cards` generates
`design/cards.json` from the tokens and `native-design.spec.mjs` probes real snapshot pixels across
all three presets; desktop suite 17/17, CTest 4/4, render comparison passing on all four backends.
Two measurement corrections were needed and are recorded in the evidence: the current-UI scenes now
carry the edge-band rule instead of a per-channel limit, because they contain anti-aliased rounded
controls, and resident memory is the median of four samples because a single reading swings by more
than the budget. Evidence `docs/evidence/design-foundations-macos-2026-09-06.md`; the owner signed off on the card
snapshots and confirmed the tolerance amendment, so **F60 passes**. rEngine also gained its own `.rengine/project.json` (contract 2) with a BMP
preview format and nine dashboard actions, verified through the service's readers.

**Follow-up 10 (same session)**: owner review of the new toolbar (“some paddings and margins should be
adjusted”, “close x should be inside tab indicator”, “suggested prompt should have lower opacity”) and
a request to take up the project explorer, which starts F67. The card stylesheet fixes constants the
tokens do not name, so they became design metrics with their source noted, and the toolbar now uses a
uniform 8px rhythm with 10px edge padding, 24px controls, a bordered segmented group with an accent
bar under the active member, and separators with their own margins. The tab close moved inside the
tab, which is also what the overflow arithmetic expects. The project explorer is rebuilt on the
control layer: a path bar with the root and the path within it, and 22px rows with icon, ellipsised
name and a right-aligned meta column that marks unsaved drafts and symlinks. Panes now paint their own
background so views can draw their own faces; the pane root row stays for every view except the
explorer, which shows the root in its path bar. Placeholders take a lower alpha than typed input.
Suite 17/17 after each change. The session browser became the card's table with state pills, the editor
gained its breadcrumb bar with a state pill and right-aligned actions, and the microui button helper
retired because every surface now uses the control layer. Two specs that clicked fixed coordinates now
click by control record. Owner decision during this round (spec 068 amendment): frame time is gated on
an absolute 8 ms per scene rather than at-or-below the SDL reference, because the adapters now
anti-alias shapes the reference draws hard-edged; the ratio against the reference is recorded as
information. Needless clipping was removed from the controls first, which cut the OpenGL workspace
median by about a third. The terminal followed: default cells now resolve against the live theme, so a preset switch restyles
history the terminal already produced, and every preset's terminal background matches its token
exactly. Scrollbars became the card's overlay bars with rounded thumbs and rest, hover and accent
states. The design spec probes the view surfaces per preset too. Evidence
`docs/evidence/design-views-macos-2026-09-06.md`; suite 17/17, CTest 4/4. F67 stays open on the
editor's gutter, current-line tint and syntax colours, which still use the pre-design drawing inside
editor.c, and on the card's per-directory counts, which need a field the file listing does not carry.

**Follow-up 11 (same session)**: owner asked for syntax highlighting tunable with IDE-style presets,
and reported missing glyphs in the Claude pane. The glyph report was a real defect: Claude Code's
status line uses U+23F5, which neither Menlo nor Inter nor any font installed on this machine carries,
so it drew as tofu. Glyph lookup now tries the requested face, then the other loaded faces, then a
substitution table for the six media-control code points no face has; advances are untouched, so the
monospace grid and every adapter's placement are unmoved. Spec 079 records the highlighting design:
nine token roles, a line-based tokeniser with a carry state (`syntax.h`/`syntax.c`, written by an Opus
subagent against the header, with `native_syntax` under CTest covering every language plus hostile
input), and four schemes in `syntax.json` resolved per theme preset into a generated table. The editor
gained the card's 44px gutter with line numbers, the current-line tint, its own background and
per-character colouring with a per-line carry cache so scrolling is not a rescan. The design spec
opens a C file and asserts the keyword colour is on screen in the dark and light presets. Suite 17/17,
CTest 5/5. A scheme is chosen through the automation `syntax` op until the theme panel lands (F68).

**Follow-up 8 (same session)**: F59 on owner direction after a `/grill-me` interview (spec 073;
charter D31 names `pr0fe@192.168.31.217` as the Windows verification host and authorizes the
commits-only transfer KI-014 waited for; D32 sets the Vulkan floor at the Quest 3 maximum, researched
as 1.3). `render/backend_vk.c` (Vulkan 1.3 core, dynamic rendering, entry points through SDL,
vendored Vulkan-Headers v1.4.328, SPIR-V committed by `tools/shaders.py` from owned GLSL, a glyph
pre-pass because transfers are illegal inside a rendering scope, two frames in flight) lands behind
`--renderer vulkan` on every platform; macOS keeps Metal as default and uses Homebrew's loader with
MoltenVK as the development path. The render spec now captures `sdl`, `opengl`, `metal`, `vulkan`,
probes for a missing loader, and repeats the Vulkan capture under `VK_LAYER_KHRONOS_validation`;
the first validated run found an HDR colour-space pick and a missing shader-demote feature, both
fixed. macOS results: Vulkan pixel-identical to OpenGL and Metal on every scene, below the SDL
median everywhere, memory below SDL, 0 validation messages, suite 13 of 13 on
`RENGINE_RENDERER=vulkan`, CTest 4/4. Evidence `docs/evidence/vulkan-adapter-macos-2026-09-06.md`.
Windows bring-up started per the runbook `docs/runbooks/windows-verification.md`: SDL2 2.32.10 dev
files and the LunarG SDK 1.4.357 installed, the pre-Vulkan HEAD builds with MSVC and its SDL and
OpenGL smoke snapshots are byte-identical; CTest editor/terminal binaries lacked `SDL2.dll` (copy
added in `cmake.toml`). Windows results (`docs/evidence/opengl-adapter-windows-2026-09-06.md`, `vulkan-adapter-windows-2026-09-06.md`):
OpenGL and Vulkan pixel-identical to each other and within tolerance against SDL, both below the SDL
median, Vulkan validation clean on the NVIDIA driver, smoke snapshots of all backends byte-identical;
OpenGL memory +24–28 MiB, Vulkan +54–60 MiB after the allocation trim (`b0a6d4b`) against the 32 MiB
ceiling; the owner then amended that budget to 64 MiB for Vulkan on Windows (charter revision record,
spec 068 amendment, KI-039 closed) because the NVIDIA driver's process baseline sits about 30 MiB above
OpenGL's on the same DLL, and the Windows render run passes under it, so **F59 passes**. The suite passes
7 of 15 there on either backend (KI-038:
layered-update unlink, symlink fixture, tree scroll, four terminal specs; fixed on the way: `_spawnv`
quoting, DLL copies, `python`, the game fixture path, `--test-force-exit`). F62 stays open on its suite criterion.

**Follow-up 7 (same session)**: F58 on owner direction after a `/grill-me` interview (spec 072;
inventory corrections committed first as `b119a3e`). `render/backend_metal.m` is the one
Objective-C file (ARC, `SDL_WINDOW_METAL`, SDL's Metal view, MSL compiled from an embedded string,
the OpenGL adapter's shading, atlas and batching ported), `cmake.toml` enables Objective-C on Apple
only, `draw.c` selects `metal`, the layering guard scans `.m` files, and the render spec captures
`sdl`, `opengl` and `metal`, gating both GPU adapters against SDL and recording Metal-versus-OpenGL.
The first spec run failed on every scene for both GPU adapters with identical pixels between them:
the login shell's asynchronous prompt moved between captures, so the spec now starts `bash --norc`
with a fixed prompt. Results: Metal pixel-identical to OpenGL on every scene, 0 differing pixels on
the current-UI scenes, primitives 0.8% inside the band, Metal medians below SDL on every scene,
memory below SDL; suite on `RENGINE_RENDERER=metal` 13 of 13 tests across twelve spec files; CTest 4/4; smoke snapshots of
all three backends byte-identical; macOS default flipped to Metal. Evidence
`docs/evidence/metal-adapter-macos-2026-09-06.md`; F58 passes. Commit:
`feat(native): add the Metal adapter behind the draw list (F58)`.

**Follow-up 6 (same session)**: On owner direction the build moved to cmkr as in nolf-improved:
`cmake.toml` at the root defines every native target and CTest entry, `adapters/sdl2/cmake.toml`
the surface adapter and its fixture, and `cmake/cmkr.cmake` (tag v0.2.46, copied verbatim)
bootstraps cmkr into the build directory on first configure and regenerates the committed
`CMakeLists.txt` files; the hand-written native CMake file is gone and `tools/design.py check`
rejects hand-edited build files. Verified after regeneration: the same targets and four CTest
entries, default and `--renderer sdl` smoke snapshots byte-identical to their baselines, the surface
adapter and fixture rebuilt and the game spec passing. Commit:
`build: generate CMakeLists.txt from cmake.toml with pinned cmkr`.

---
## Session 18 (macos) — 2026-09-06 — System scrolling, visible bars and agent reload

**Owner direction and context**: Remained inside the verified root-bound rEngine agent session
`a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a`, PID 20049. The owner requested trackpad direction matching
system settings, scrollbars on scrollable panes, and agent invocation of Cmd/Ctrl+Shift+R through
MCP. Prioritized specs 061–062 without a duplicate conversation/goal or game/sibling edits.

**Implemented**: Removed the extra FLIPPED negation that undid Cocoa's system-adjusted deltas;
shared signed precise accumulation now covers terminal/editor/microui input. Added native
terminal history and two-axis editor bars with thumb dragging, track paging and clamped ranges.
Tree/session lists retain upstream microui bars. Wheel follows hovered content without retargeting
keyboard focus or project bindings. Added authenticated ephemeral desktop discovery and explicit
root-bound MCP reload, with capability/version checks, bounded acknowledgement and stale/foreign/
unsupported-target rejection. The action enters the existing durable native quit/rebuild path;
it reports acceptance separately from build success and retains processes without another prompt.

**Verification**: Corrected direction assertion failed before implementation (exit 134); actual
MCP tool discovery failed before the new actions existed. Final `npm run test:desktop`: seven
passes, 41.12 s; CTest: three passes, 0.62 s; `npm test`: 21 passes, 4.30 s. Real MCP stdio plus
normal native launcher prove dirty draft recovery, replacement desktop ID, unchanged instrumented
CLI PID and one invocation across keyboard and MCP reloads. Native pointer tests cover terminal/
editor endpoints, both axes, track paging, precise inverted events, tree overflow, unchanged
editor bytes and no unintended PTY input. Screenshots inspected. Harness/inventory, reviewed
sidecars and diff checks pass. Headers, build declarations and straightforward broker/MCP test
assertions need no additional file-local notes. Evidence:
`docs/evidence/native-scroll-controls-actions-macos-2026-09-06.md`.

**Live rollout and remaining**: The retained service/connector still predate desktopActions
version 1; a fresh connector reports this limitation without replacing the service. A targeted
shortcut attempt against verified production desktop PID 62416 was denied by macOS Accessibility
(error 1002, osascript cannot send keystrokes). No OS settings or retained processes were changed;
the native build is ready for Cmd/Ctrl+Shift+R. Agent actions become available after explicit
service/connector upgrade. Current agent and original shell PIDs remain running. All 15 feature
gates remain false. KI-024 menu-state qualification is next; preserve the known initial NOLF
selection -1 finding, Windows transfer approval boundary and optional service-migration decision.
Commit: `feat(orchestrator): add system scrolling, pane bars and MCP reload`.

---

## Session 17 (macos) — 2026-09-06 — Scroll the running agent pane

**Environment and steering**: Verified `RENGINE_ORCHESTRATOR_SESSION` identifying
`a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a`, root-bound MCP workspace/session identity and running
agent PID 20049 before continuing. Harness and 20 service tests passed. During KI-024 read-only
investigation the owner reported missing scrolling in the active agent pane, so prioritized
spec 060/F36. No game or sibling files were edited and no duplicate conversation/goal started.

**Implemented**: Primary-screen libvterm history in a 2,000-row/8 MiB ring; mouse/trackpad and
Shift+PageUp/PageDown/Home/End navigation; reading position held under new output; typing returns
to live. Wheel targets the hovered terminal without changing keyboard focus. Alternate-screen
output stays separate; cursor visibility and the history position indicator follow the view.
Resize callbacks restore recent rows; attachment/reload rebuilds available history from the same
retained PTY. Headers and build-list additions need no extra file-local rationale; substantive
terminal/routing/test rationale is recorded in reviewed sidecars.

**Verification**: The pre-fix native PTY/wheel regression failed to reveal earlier rows. Final
native scroll checks pass across continued output, alternate screen, resize, pane movement,
hover/focus isolation and GUI restart with the same PIDs. Replaying actual ended Codex output
also scrolls and returns to live (5.55 s), without a provider run. Final desktop suite: six
passes, 39.54 s. CTest: three passes, 0.56 s, including history clearing and line/byte limits.
Service baseline: 20 passes, 4.29 s. Screenshots inspected: early colored history and actual CLI
history render; the selected font still lacks CJK glyphs. Harness/metadata/diff checks pass.
See `docs/evidence/native-terminal-scroll-macos-2026-09-06.md`. Local recordings remain ignored.

**Remaining**: The owner can load this build with Cmd/Ctrl+Shift+R while retaining this CLI.
All 15 feature gates remain false. KI-024 still needs a real menu-state oracle; source inspection
also found NOLF's main folder intentionally starts with selection -1, so Enter alone must not
be assumed to select Single Player. Establish selection deliberately and distinguish that from
letterbox routing before changing input. Terminal selection/copy, history reflow and Windows
remain open; existing Windows transfer and optional service-migration boundaries persist.
Commit: `feat(native): add bounded terminal scrollback and pointer navigation`.

---

## Session 16 (macos) — 2026-09-06 — Repair shared terminal freeze during resume

**Owner direction and environment**: The exact real conversation resumed in the native pane.
Verified its `RENGINE_ORCHESTRATOR_SESSION`, running agent PID 33534 and root-bound rEngine MCP
workspace/session calls for this checkout. The owner then reported both agent and shell unable
to accept input and suggested incomplete terminal animations. The original GUI/agent exited;
the same conversation was resumed externally. Prioritized this explicitly authorized handoff
repair and deferred NOLF KI-024 without game/sibling edits. No new conversation or goal.

**Reproduced and fixed**: Animated ANSI alone stayed interactive, but an 8,000-event burst
filled the 128-message native receive queue and killed the shared stream worker. Its disconnect
notice could also be discarded, leaving apparently connected panes with undelivered input.
Spec 059 adds receive backpressure, bounded per-tick draining, disconnect status and retries
to the same authenticated endpoint. Reattach retained terminal IDs through fresh snapshots,
discard unsent/offline input and preserve processes, bindings and drafts. No launch or repeated
continuation occurs during recovery. Automated native windows now have a distinguishing title.

**Verification**: Pre-fix animation-only pass (6.17 s), burst regression fail (14.15 s); final
real PTY/native input checks pass in both panes after burst and forced outage with the same
PIDs, two sessions and no offline-input replay. Replaying 803,215 bytes from the ended real
Codex session through the test PTY also passes (8.69 s), without another provider run. Service
tests: 20 passes (4.30 s). Final desktop suite: five passes (41.89 s). CTest: two passes
(0.45 s). Screenshot visually inspected; the selected font lacks the spinner glyph, separately
from input recovery. Harness/inventory, metadata and diff checks pass. Actual recording stays
ignored/local. Evidence and exact limits: `docs/evidence/native-terminal-recovery-macos-2026-09-06.md`.

**Preserved state and next**: Original retained service PID 33465 and user shell PIDs 33500/39735
remain running; tests cleaned up only their own fixtures. All 15 feature gates remain false.
After the current conversation writer exits, run `npm run resume` and verify the new attached
agent environment/MCP before returning to KI-024. Service identity replacement and Windows
remain unqualified; the Windows transfer approval boundary and optional service-migration
decision remain unchanged. Commit: `fix(native): keep terminal streams responsive and reconnect retained sessions`.

---

## Session 15 (macos) — 2026-09-05 — Pause at the orchestrator handoff

**Owner direction**: stop broader feature work here and resume this exact agent conversation
inside the native orchestrator after prerequisites. The handoff is the remaining authorized
work for this session. AGENTS and charter D28 preserve that boundary. No feature or overall goal
is marked complete. The available goal API cannot pause; the application's Pause goal control
remains owner-controlled, and this agent stops broader work after the checkpoint.

**Implemented**: Before the pause request, added bounded tab-strip arrows, reorder and Merge
pane with stable view identity, selected-header reveal, draft/order persistence and retained
PTYs (spec 057). Then added spec 058: explicit Codex UUID/project/checkpoint validation, CLI
resume/login probes, a private per-session manifest snapshot and readiness gate. The real CLI
starts only after its native terminal is attached and presented. Concurrent handoff creation and
later launches reuse the same live conversation PTY. Native Cmd/Ctrl+Shift+R flushes drafts/layout,
rebuilds the C desktop and reconnects without a second continuation prompt. Old sidecars must
advertise handoff capability; they cannot silently launch an ungated CLI. Normal close detaches.

**Verification**: Native desktop suite: four passes (game texture/capture, handoff/reload,
pane navigation and workspace/editor/PTY), 24.23 s; CTest: two passes, 0.33 s. Service suite:
20 passes, 4.36 s on the final source; the hardened manifest-snapshot native regression also
passes (8.43 s). Final checks are recorded in the handoff evidence. The handoff consumer uses an instrumented managed CLI with a real PTY,
Bash/MCP setup and actual native presentation/rebuild: rejected login creates no session;
no CLI before its visible pane; explicit UUID/MCP args delivered once; interactive output and
same PID retained; dirty draft survives reload; repeated launch does not invoke again; Stop
allows a fresh waiting bootstrap. Real installed Codex 0.153.4 has resume support, authenticated
ChatGPT login and matching local session metadata. The active conversation is not reopened
concurrently; its real continuation happens at the next launch. All test-owned processes are
cleaned up. See `docs/evidence/orchestrator-handoff-macos-2026-09-05.md`.

**Honest remaining finding**: Moving real NOLF into/out of a narrow pane preserves frames and
PID, but the last inspected `game-input.png` remains on the main menu after Enter. The combined
test's green result lacks a menu-state oracle. Recorded KI-024 instead of claiming post-move
input works. The speculative letterbox regression/debug addition was withdrawn when work was
paused, leaving the tested pane checkpoint. No game-input fix was added. Windows source transfer
approval, Node-service timing and other existing limits remain outstanding.

**Next session**: Run `npm run resume` from this checkout after the current writer yields. Local
`.cache/handoff/current.json` selects this conversation; `.cache/orchestrator-development` is
its retained workspace. Read `docs/handoff/2026-09-05-orchestrator-resume.md`, verify the attached
agent/MCP root and resume the existing goal there, starting with the missing NOLF menu oracle.
No automatic continuation outside the orchestrator overrides the owner's pause.

---

## Session 14 (macos) — 2026-09-05 — Qualify the normal native NOLF launcher

**Goal turn classification**: progress. The owner's no-Electron/runtime-overhead constraint
remains explicit in AGENTS, charter and architecture. The future web client stays independent.
This turn qualified the normal C/microui workflow, beyond the previous isolated component tests.

**Implemented**: `test:workspace` now drives the actual npm launcher, including build, retained
sidecar and initial NOLF/shell/Codex creation. Optional stdin inspection reports bounded clipped
control geometry and accepts SDL wheel events; actions still use real native input. Fixed a
microui hover regression discovered by adding the real source project: schedule one settling
frame when entering another root container so the first click works without continuous repaint.
The shared test bridge accepts launcher build output and matches the Windows multi-config path.

**Verification**: Combined check passed in 15.06 s: executed shell output, installed Codex 0.153.4
with eight connected rEngine MCP tools, real NOLF tree/README, two-root Unicode Save/conflict/
Discard, dirty editor movement, NOLF Single Player menu input, GUI detach/reattach/restart with
the same process identities and draft, and session-browser Stop affecting only NOLF. Screenshots
were inspected; all four test-owned service/session PIDs exited after cleanup. NOLF checkout
status and source README were preserved. Nineteen service tests, two CTest checks and both existing
native GUI regressions passed. Evidence: `docs/evidence/native-workspace-macos-2026-09-05.md`.

**Remaining**: All feature gates and the overall goal remain open. Native previews, terminal/
editor breadth, reconnect/failure recovery, in-level aiming/DPI, packaging/resource budgets and
Windows qualification remain. KI-023 records observed tab overflow and field/status polish.
Windows source-transfer approval and the optional Node-service timing answer are still pending;
neither was inferred from silence. No Windows source transfer occurred.

**Next**: Continue the native workflow gaps and resource/recovery qualification. Preserve C/microui
presentation and independent game/library ownership through any later service migration.

---

## Session 13 (macos) — 2026-09-05 — Replace Electron with C/microui

**Goal turn classification**: progress. The owner explicitly rejected Electron and selected C
with microui, followed by a separate later web interface. Charter D26–D27, architecture, roadmap
and AGENTS now preserve that constraint. A question about moving the separate Node session service
to C remains optional/pending; that service has not been rewritten by the GUI migration.

**Implemented**: A real C11/SDL2/microui desktop now replaces the Electron/React/CodeMirror/xterm
UI and is the normal launcher target. Pinned C libraries provide JSON, terminal emulation,
text editing, font rasterization and loopback transport. Native split/tab layout, root-bound
file tree/editor, Save/conflict/Discard/drafts, real PTYs, session browser/Stop, live game textures
and native capture/Escape handling are connected. Removed browser-only packages, source/tests
and static serving. A web client is a future independent consumer. Vendored upstream remains
pristine, with licenses/hashes and a documented owned-source style exemption.

**Verification**: All 19 service checks pass. CTest layout/editor checks pass with Release
assertions active. Native GUI tests pass executed PTY output, Unicode Save, external conflict,
Discard, dirty-tab movement, durable close/restart and same shell PID. The actual SDL fixture
passes live texture, native capture, held W release on first Escape, next Escape delivery and
explicit asynchronous Stop. Actual NOLF main-menu to Single Player input, GUI restart with the
same PID and Stop pass in an isolated copied-binary/archive-only runtime directory. Installed
Codex 0.153.4 boots through the real Bash launcher in the native terminal; its startup was
visually inspected without sending a coding prompt. Details: `docs/evidence/native-desktop-macos-2026-09-05.md`.

**Corrections/findings**: Strengthened terminal proof to distinguish executed output from echo.
Excluded a game mouse-up originating from the Capture button. Native Vim mode entry suppresses
the initiating SDL text event; undo tests position the cursor explicitly. Respect microui's
fixed command-root capacity with 15 panes. Rasterize fonts at drawable density; avoid idle repaint
loops. Moving the downloaded curl cache beneath an ignored build directory prevented the sidecar
indexer from ingesting thousands of generated/dependency files. All source metadata was reviewed.

**Remaining**: Native combined-launch/MCP interaction, image previews, terminal/editor breadth,
reconnect/failure handling, in-level aiming, logical/drawable game input mapping, packaging,
resource budgets and Windows qualification remain open. The Windows source-transfer auto-review
rejection remains in force; no transfer occurred. No feature or overall goal is marked complete.
The former Electron tests/evidence are historical, not a native release pass.

**Next**: Complete the native workflow and qualification against unchanged accepted criteria;
retain service/engine independence and incorporate any owner steering on the service implementation.

---

## Session 12 (macos) — 2026-09-05 — Game button release and actual lobby movement

**Goal turn classification**: progress. The preceding remote-only turn confirmed synchronization
but did not advance gameplay. This turn reproduced and fixed a native mouse-up loss when the
pointer left the canvas. Ordinary release preserves held movement; capture loss and pane blur
release controls, and subsequent focused keyboard input reacquires session ownership.

**Verification**: Nineteen service smoke checks passed (4.3 s). The completed SDL/Electron input
regression and existing GL/key check pass (13.1 s total). A real isolated NOLF run entered the
UNITY lobby, strafed left and moved forward, with inspected release evidence and preserved host
files. The direct gameplay probe is now checked in; its separate launch/menu/cleanup run exited
0 and stopped its own processes. Evidence/pins are in `docs/evidence/gameplay-input-macos-2026-09-05.md`.

**Findings**: Sustained Playwright raw-frame tracing stalled its Electron process at 6.2 GiB;
direct CDP input/screenshots stayed responsive. This comparison changes the sustained test
method, not the production surface or performance criteria. Early probe cleanup needed explicit
process termination; the checked-in tool now closes its client/child streams and stdin reference.

**Unproven**: Pointer lock failed before permission handling. Native window focus stayed false;
CoreGraphics confirms the Mac session is locked. An unlock request is pending. The explicit
`RENGINE_REQUIRE_POINTER_LOCK=1` check remains a required additional qualification, not part of
the passing button-release claim. Windows source-transfer approval is also still pending; its
auto-review rejection remains in force. All 15 feature gates and the overall goal remain open.

**Next**: Qualify relative aiming on the unlocked Mac; complete drawable/logical DPI mapping,
recovery and resource checks. On approved transfer, wire and qualify the Windows adapter/desktop
in an isolated checkout. No active probe/test process is intentionally left running.

---

## Session 11 (macos) — 2026-09-05 — Windows environment fix and transfer approval

**Goal turn classification**: progress. Preview checkpoint `fa7e346` and preceding launch/agent
commits were pushed to the requested origin. Fixed Windows environment key normalization while
preserving POSIX behavior. Nineteen service tests pass, including both new environment checks
and actual macOS PTY/MCP/agent tests (about 4.4 seconds).

**Windows authority**: Read-only checks reached the NOLF-configured Windows machine and read
its local checkout rules/tools/status. Automatic approval review rejected copying the committed
261 KiB source bundle to that host: the destination was inferred from project configuration,
not directly authorized by the owner. No source transfer occurred. An explicit async approval
question names the machine/destination and isolated checkout; it remains pending. Do not bypass
the rejection through clone, archive streaming or another transfer mechanism.

**Scope**: The environment regression proves path/key transformation, not Windows process
execution. Installed Codex/Claude help confirms their native update commands exist; managed
Codex download/update remains the actual update runtime proof. No global agent update occurred.

**Next**: On approval, transfer the prepared source and run native Windows qualification in an
isolated checkout, preserving the dirty NOLF checkout. While approval is pending, local gameplay,
input/DPI, editor/session failure recovery and packaging/performance work remain available.
The complete goal stays active; no blocker/completion state or feature pass is claimed.

---

## Session 10 (macos) — 2026-09-05 — Image previews and verified pane movement

**Goal turn classification**: progress. Combined-launch checkpoint committed as `7c407f3`.
Added actual image previews with bounded authenticated reads and root-bound tab persistence.
The complete Windows/gameplay/recovery qualification remains active.

**Implemented/verified**: PNG/JPEG/GIF/WebP browser decoding, fit/actual size and refresh; invalid
metadata/data and byte/pixel limits report errors. Object URLs and reads are released on view
replacement/detach. Seventeen service tests pass; the real image test verifies two roots with
different pixels, refresh, decoder-error recovery and GUI restart. Existing text/terminal checks
still pass. Evidence is in `docs/evidence/image-previews-macos-2026-09-05.md`.

**Evidence correction**: A stronger pane-position assertion exposed that the previous short
Playwright drag emitted no drop on this Electron/macOS profile. The tests now use intermediate
pointer moves and assert actual destination coordinates. NOLF passes the stronger move/input/
restart/Stop check (11.1 seconds), and preview movement passes (about 2.1 seconds). Historical
survival-after-gesture assertions alone were insufficient; refreshed native evidence records the
correction. This required test input changes, not a replacement layout implementation.

**Windows progress/next**: The NOLF project's configured Windows host was reachable with a
read-only SSH check. It has Node 24.15.0, npm 11.12.1, Git, CMake, Ninja and an active console
session. Its older NOLF checkout has unrelated edits; preserve it. Read its AGENTS/CLAUDE rules.
Use an isolated rEngine qualification checkout next; Windows game integration, installed-agent
proof, gameplay/DPI, packaging, resource budgets and failure recovery remain open. The earlier
host question no longer prevents establishing Windows tests. No feature/goal marked complete.

---

## Session 9 (macos) — 2026-09-05 — Combined production launch and two-root editing

**Goal turn classification**: progress. Pushed the earlier native/desktop commits as requested;
committed agent bootstrap as `bdae7a3`. Verified the actual npm launch command rather than only
separately constructed desktop/service tests. The complete goal remains active.

**Implemented/verified**: Explicit opt-in local UI inspection enables acceptance automation of
the normal launcher. Missing project/game prerequisites now fail before new shell/agent sessions.
The combined test passes (29.3 seconds): actual NOLF frames, installed Codex with MCP tools,
real shell input, real NOLF tree/README draft, second-root Save and conflict preservation, GUI
close/relaunch retaining all session IDs/PIDs, draft recovery and explicit NOLF Stop while the
other sessions stay running. The NOLF working file was preserved. Both launcher regressions pass.
Inspected rendered evidence and recorded its hash in `docs/evidence/nolf-workspace.md`.

**Test corrections**: Selected the actual provider-named agent tab and root-specific README
buttons. Awaiting the page close event plus launcher exit handles CDP shutdown reply timing.
These failures did not require changing session or editor behavior.

**Next**: Image previews, native gameplay/input/DPI, Windows integration and remaining recovery,
packaging and performance qualification. No feature or goal completion claimed; all 15 gates
retain their unproven status. The existing Windows-host question remains pending.

---

## Session 8 (macos) — 2026-09-05 — Agent MCP bootstrap and actual CLI/download proof

**Goal turn classification**: progress. Native NOLF checkpoint committed as `a22d823`. Added
project-bound MCP tools and per-invocation agent overlays through the Bash launcher. The full
goal remains active; Windows, gameplay and other outstanding desktop requirements remain open.

**Implemented**: Official MCP SDK stdio bridge with project identity, bounded tree/text/session
tools, NOLF preflight/launch and explicit Stop. Every call retains its original root and sidecar
instance. Private context/config files live in sidecar state; existing user/project config and
CLI authentication remain in their normal scopes. Codex uses invocation overrides, Claude an
additional MCP config, OpenCode merged inline JSONC, Gemini preserved defaults plus the new
server, and custom executables receive a generic config path. Windows wrapper execution uses
Git Bash argv forwarding for native npm shims; actual Windows execution remains unverified.

**Verification**: All fifteen service/config/MCP tests pass, including the stale-instance rejection.
Actual Codex 0.153.4 launched in the
NOLF workspace and `/mcp verbose` showed rEngine connected with all eight tools (pass, about
5.8 seconds; screenshot inspected). Automated fast typing initially left the command unsubmitted;
after waiting for startup and using human-paced keys it executed. The PTY input trace records
Enter as carriage return. A real isolated managed install of 0.153.3 and update to 0.153.4 both
verified their resulting executable versions; managed launch selected that installation.

**Limits/next**: Existing Capture MCP handshake failure is separate KI-017. Other agent runtimes,
Windows, the combined launch command, image previews, full game/aiming/DPI/performance and crash
recovery remain to verify or implement. The Windows-host question remains pending; independent
work continues. No feature or goal completion is claimed. Evidence details are in
`docs/evidence/agent-bootstrap-macos-2026-09-05.md`.

---

## Session 7 (macos) — 2026-09-05 — Live NOLF game pane and native input

**Goal turn classification**: progress. Implemented the native SDL2/OpenGL surface, bounded
authenticated frame/input transport, NOLF preflight/launch, canvas presentation and game-session
reattachment. Desktop checkpoint committed as `c09d2a8`. The complete goal remains active.

**Verified**: Actual existing NOLF build renders its menu live in the desktop. Enter opens Single
player through the native input path; a pixel-region assertion and inspected screenshot corroborate
the transition. Moving and closing the tab, restarting the GUI and reattaching retain the same PID;
explicit Stop reaches exited state. The expanded NOLF test passes in about 10.3 seconds. A separate
real SDL/GL fixture verifies key-down/release, pixel orientation and preservation of pixel-pack
state (pass, about 13.4 seconds). Thirteen service/protocol tests pass. Detailed host/executable
hashes and local artifact hashes are in `docs/evidence/nolf-surface-macos-2026-09-05.md`.

**Failures resolved**: The SDK does not ship dyld's private interpose header; the adapter now
declares the documented two-pointer Mach-O section directly. The first NOLF test's polling code
forgot to await a browser attribute, producing NaN; corrected and reran after the prior run ended.
No NOLF source/assets were edited; pre-existing host worktree status was preserved.

**Remaining**: Full gameplay/relative aiming/DPI/performance, image previews, installed-agent/MCP
proof, forced-crash recovery and Windows qualification. The Windows cooperative API source exists;
host integration is unverified. Asked which Windows host is available while continuing
independent agent work. No blocker or completion state is claimed; feature gates stay false.

---

## Session 6 (macos) — 2026-09-05 — Working desktop panes and retained-sidecar launcher

**Goal turn classification**: progress. Pushed the foundation commit as requested, then added
the launchable Electron/React workspace. The full NOLF/editor/agent objective remains active;
all 15 feature gates remain false pending their full host/platform criteria.

**Implemented**: Tree, retained CodeMirror buffers, optional Vim, explicit Save/conflict actions,
xterm sessions, FlexLayout splits and movable tabs, session browser, saved layout and awaited
draft flush on normal desktop exit. The native window exposes only project selection and close
handshake IPC. `npm start -- --project DIR --agent ID` builds the UI and starts or reuses a separate
Node sidecar, then opens a project-bound shell and agent. Startup ownership and authenticated
instance checks prevent duplicate sidecars; an alive unavailable process remains an error.

**Verification**: Eleven service/launcher tests pass, including concurrent launchers sharing one
real sidecar. The Electron test passes real editor Save, external-disk conflict preservation,
Discard/reload, Vim `ggdd`, keyboard input executed by a real PTY, terminal tab movement, GUI exit,
same-PID reattachment and draft recovery in the editor. The initial missing-desktop run timed out;
after implementation the full desktop test passes in about 6.3 seconds. Inspected its screenshot;
corrected file/session placement so the main area is used when opening from the tree. Test shells
use Bash on macOS to avoid an interactive profile updater; production still honors the user shell.

**Limitations**: No live game tab, real installed-agent session proof or MCP bootstrap yet.
Windows execution and release packaging remain unverified. Image previews, forced-crash recovery,
power-loss durability and full resource budgets are still owed. No NOLF source/assets changed.

**Next**: Implement and verify the SDL2/OpenGL live NOLF surface, finish agent integration and
exercise the actual NOLF workspace. Preserve independent roots and retained process lifetimes.

---

## Session 5 (macos) — 2026-09-05 — Begin the authorized NOLF workspace implementation

**Goal turn classification**: progress. The previous push completed; this first implementation
turn changes authoritative code and verifies real sidecar/PTY behavior. The full user objective
remains the launchable NOLF workspace with tree, editor, live game and agent onboarding, on the
previously required macOS/Windows targets. No goal completion or blocker is claimed.

**Authority and scope**: The owner's active objective supersedes the setup-only review wait.
Recorded D25 and `docs/specs/055-nolf-workspace-goal.md`; activated 15 desktop/agent rows including
aggregate F55. Agent find/update/download/launch is now in the first usable workflow. All feature
completion states remain false because the full platform/UI/host criteria are still unproven.

**Implemented**: Node sidecar HTTP/WebSocket/file/session services; explicit root identities;
UTF-8 text reads, LF/CRLF-preserving explicit saves, local recovery drafts and external-version
conflicts; real PTY sessions with bounded output, reconnect and explicit process-tree Stop.
Standalone `scripts/agent.sh` detects Codex/Claude/Gemini/OpenCode or a custom executable, launches
in an explicit project, installs into a managed npm prefix, and dispatches supported updates.
MCP bootstrap is not yet wired and no actual agent update/download was performed in this turn.

**Dependencies**: Exact npm versions/lockfile for Electron, React/FlexLayout, CodeMirror/Vim,
xterm/node-pty, WebSocket, esbuild and Playwright. Existing Node is v25.3.0 on macOS 15.7.3 arm64.
node-pty 1.1.0's prebuilt spawn-helper lacked execute bits; the postinstall preparation step
repairs the known helper paths. The actual PTY then works outside the sandbox.

**Verification**: Meaningful red tests preceded the modules and launcher. Ten tests cover real
PTY startup, retained session identity across WebSocket disconnect/reconnect, explicit Stop
isolation, HTTP auth/origin/file conflict paths, root/draft restart behavior and agent dispatch.
A malformed UTF-8 token regression was reproduced (500 instead of 401) and repaired. Native PTY
and socket checks need the normal unsandboxed app environment. Default zsh startup asked for an
oh-my-zsh update and consumed the test's first character; controlled tests now use clean shell
profiles, while production terminals retain the user's normal shell configuration. Sidecar
metadata is stamped/validated. Final `npm test` and harness results accompany the checkpoint.

**NOLF evidence**: Current `build/relith-nolf` and local `nolf/NOLF.REZ` exist. Read the host rules,
CLI and profile: `--flat`, `--game nolf`, size arguments and `RELITH_HIDDEN_WINDOW=1` provide a
hidden real GL context. SDL swap/input seams are in `src/platform/sdl_window.cpp` and a second
swap in `src/compat/lt_render_impl.cpp`; both matter to an adapter. No NOLF source, active host
worktree or game asset was changed, and no game was launched yet.

**Next**: Connect Electron/FlexLayout/CodeMirror/xterm to the real sidecar, implement the native
SDL2/OpenGL live surface and NOLF launch adapter, add per-agent MCP bootstrap, then exercise the
actual GUI/NOLF/installed-agent workflow. Preserve persistent sessions, explicit roots/saves,
game input/tab movement and Windows support. Full GUI/native/Windows gates remain owed.

---

## Session 4 (macos) — 2026-09-05 — NOLF, recovery drafts and iklib roadmap review

**Agent**: Codex.
**Owner decisions**: D21 confirms NOLF as the first live desktop game tab, with VtMB second.
D22 confirms local recovery drafts and explicit working-file saves. The later “GO for
gecommended” answers the next two-question round: D23 selects iklib as the first two-game library
proof; D24 requires verified pinned capability adoption for powered-by status, with optional
IDE/shared harness. All session 3 questions are answered. This is not a blanket roadmap verdict.

**Artifacts**: Added `docs/specs/032-desktop-v0.md` and `001-library-pilot.md`. They turn confirmed
choices into acceptance workflows, host ownership and failure cases, while marking concrete
source pins, hardware, numerical/resource budgets and initial Vim details as still required.
F32/F1 remain incomplete; writing a draft does not satisfy their outstanding criteria.

**Proposal correction**: F21 now depends on both core migrations F18/F19 instead of requiring
the separate F20 finger migration. This repairs the draft graph's mismatch with the existing
separate-finger scope. F20 contributes a later evidence update. Updated NOLF/recovery/iklib and
powered-by criteria throughout the 54-feature proposal; every feature remains non-passing.

**Review**: `docs/reviews/rengine-roadmap-2026-09-05-v1.html` embeds all features and complete
criteria in six review branches, along with the current source specs. Its content JSON records
source hashes and group membership. Adjacent CSS/JS are unmodified copies from the ispec skill;
the review works offline without requiring that skill to be installed. The `.spec.json` input
is not an owner verdict. Use the exported `.json` or explicit chat feedback to record review.
Recommended later order is iklib core proof after desktop v0, then agents/VtMB; this remains a
recommendation. Windows test access is an open input in the review, not a claimed available host.

**Verification**: `./init.sh`, JavaScript syntax, graph reproduction, Markdown links, 54-feature
coverage, review source hashes and export-control structure pass. Verified that desktop v0 stays
independent of library/training/installer work, and core IK proof no longer waits for fingers or
the shared-runner branch. In-app browser discovery returned no available browser, so automated
visual, click and JSON-export checks were not performed. The review is ready for presentation
in the regular browser. No orchestrator runtime, native game build, host migration or training
workload was implemented or executed; sibling workspaces remain untouched.

**Next suggested task**: Present the concrete review and incorporate owner feedback. The
harness-init skill requires review of the feature list before creating `features.json`; ispec
waits for completed feedback after presentation. Chat decisions can serve as review without
forcing an exported file. Reconcile revisions/deferred groups and dependency closure, activate
only accepted scope, then complete the desktop qualification inputs before a toolkit prototype.

---

## Session 3 (macos) — 2026-09-05 — Explicit roots in shared workspaces

**Agent**: Codex.
**Owner decision**: D20 confirms multiple project/worktree roots in one workspace, with every
terminal, editor, agent and game session explicitly bound to its own root. This answers session
2's pending question; it is not blanket approval of the feature inventory.

**Summary**: Updated the charter, orchestrator specification, architecture, roadmap and agent
instructions. The proposed implementation separates stable root identity, repository identity,
launch directory and shell cwd. Focus changes and tab moves cannot retarget existing operations.
Root removal/missing directories retain visible session associations instead of guessing a new
checkout. Root binding records context; it is not an access sandbox.

**Proposal changes**: Tightened 11 existing features around two worktrees, duplicate filenames,
similarly named sessions and preserved root bindings after GUI restart. No feature IDs,
dependencies or completion states changed. All 54 remain proposed/non-passing; `features.json`
is still absent. The first desktop milestone retains its actual game tab and session browser.

**Verification**: `./init.sh` passes. Graph reproduction, local document links, proposal state and
desktop/library dependency boundaries are checked before commit. No runtime code, sibling
workspace, game build, installation, device or training job was changed or executed.

**Questions pending**: Select the first live game (NOLF recommended, followed by the VtMB adapter)
and editor recovery policy (local recovery drafts with explicit saves recommended). These were
asked together; do not treat either recommendation as confirmed before an answer.

**Next suggested task**: Record the answers and refine F32's concrete desktop acceptance spec.
Present the proposed scope for review before activating implementation. Toolkit feasibility,
Vim subset and measured budgets remain open; settled platform/lifecycle/multi-root choices do not.

---

## Session 2 (macos) — 2026-09-05 — Library base and desktop orchestrator design

**Agent**: Codex.
**Owner decisions**: Charter D07–D19 records the library-base thesis; curated upstream plus our
own gaps; one library proven in both games first; tab/split IDE; terminal-based Bash agent
selection/installation/MCP bootstrap; macOS and Windows from the start; adapters first with
external-app research; Quest 2D workspace with desktop sidecar before spatial panes; tree,
previews and basic editing with optional Vim; retained sessions with explicit Stop and a session
browser; and desktop workspace/terminals/flat-game-tab as the first implementation milestone.

**Summary**: Revised the initial shared-runner-first plan. Added the library quality proposal,
orchestrator spec and primary-source investigations of Meta XR Operator, Quest delivery and
external app presentation. The first desktop proof includes actual game pixels/input and session
reattachment on both platforms. iklib remains the recommended named library and flat NOLF the
recommended first game; neither name is treated as an explicit new owner decision.

**Proposal changes**: 54 features, all proposed/non-passing. Library and desktop branches are
independent. F32 is the first proposed local design/feasibility entry; desktop v0 closes at F48,
including the host-owned F43 game adapter and F54 session browser. Later agents, XR, Quest and
external-app work have separate gates. The previous blanket editor deferral is superseded.
No accepted feature history was rewritten and `features.json` remains absent pending review.

**Research findings**: Official Meta documentation establishes native standalone Operator and
Android/PWA/Spatial SDK routes suitable for a Quest-client feasibility path. Windows supports
window parenting with caveats and window capture; Apple documents window/app capture. These
support candidate designs, not universal embedding, tested native-host compatibility or store
approval. The proposed sidecar owns files/builds/PTYs/agents/game sessions; layout/session
contracts can serve desktop and Quest views. MCP inspection/control is separate from live-pane
presentation. Source links and proof requirements are recorded in `docs/research/`.

**Verification**: `./init.sh` validates 54 features and their dependency graph. Before commit,
check graph reproducibility, local Markdown links, all-proposed status, desktop-v0 dependency
closure and independence from the library/training/installer branches. No runtime code changed;
no game, native build, GUI prototype, install, device or training job was executed. No reference
workspace was modified.

**Question pending**: Whether one workspace contains multiple project/worktree roots with each
session explicitly bound to a root (recommended), or one root per workspace. Prior strategy,
platform, editing, lifecycle and first-milestone questions have been answered; do not repeat them.

**Next suggested task**: Record the project-association answer, settle the bounded desktop v0
spec, and present the revised feature proposal for owner review. Qualify the implementation stack
through real terminal/editor/game-surface feasibility on both desktops before building the larger
UI. Preserve the required game tab and session browser in the first useful milestone. Agent
recipes/Windows Bash details and later Quest/XR scope remain follow-up design decisions.

---

## Session 1 (macos) — 2026-09-05 — Initial harness and architecture interview

**Agent**: Codex initializer.
**Summary**: Created rEngine's local harness and a concrete proposed roadmap from read-only
inspection of reLith, reSource, iklib, training, and the newly discovered infra-vr dependency.
The charter distinguishes owner-established requirements, code-derived facts, and recommendations.
The interview is ongoing; no answer to the first question round had arrived at this checkpoint.

**Artifacts**: `AGENTS.md`, thin `CLAUDE.md` entry point, this shared log, `init.sh`, local feature
query/validation helper, charter and harness specs, architecture, source hashes, reconnaissance,
integration plan, 30-feature proposal, generated roadmap graph, and known-issues inventory.

**Features completed**: None. This is harness setup, not implementation of the proposed shared
runner, schemas, engine integrations, packaging recipes, or training bridge. `features.json` is
intentionally absent until the concrete proposal is reviewed. The helper labels proposal queries
and offers no executable feature before that review.

**Verification**: Bootstrap succeeds and is independent of sibling paths and native game
toolchains. Inventory types, dependencies and cycles validate. Focused CLI checks exercise
duplicate/unknown IDs, cycles, malformed JSON, review/evidence requirements, local readiness,
host handoffs, graph reproducibility and invocation outside the repository. The first document
link check caught this progress file before it had been written; it is included in final checks.
Final command results are recorded in `docs/evidence/initial-harness.md`.

**Known issues**: First milestone, “both streams,” minimum powered-by contract, infra-vr role,
platform/resource scope and catalog policy remain interview questions. Source worktrees were
active; use the recorded per-file hashes and recheck before future integration. No reference
repo was edited and no game/build/device/service/training workload was run. iklib host migrations
remain owned by their original workspaces and tracker.

**Next suggested task**: Continue the first interview round, record answers in
`docs/specs/000-charter.md`, then ask the dependent workflow/curation questions. Refine and present
the concrete feature proposal for owner review. After acceptance, create `features.json` with
`review_status: approved` and a `review_record` reference, retire the proposal as the active
source, regenerate the graph, and choose the approved first slice. Do not restart reconnaissance
unless facts needed for that slice have changed.

---
