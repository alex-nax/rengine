# Retiring the Node orchestrator to Rust, and the mobile companion (D57–D58)

Date: 2026-09-11. Status: **decisions taken, feature rows proposed.** Asked for by the owner:
*"we need to plan our js retirement in favour of rust and the first thing that rust will be used —
is libp2p integration (rust-libp2p on server) — I want to have a mobile companion app so I can
connect from anywhere (pilot - android, use microui for rendering on vulkan using ndk so that we
share interface modules later with ios)"* — plus the standing goal from the kimi integration
sessions: *"unified integration … the same functionality for everyone including session
listing+discovery"*, and the closing direction: *"total interoperability"*.

The design was settled in a grill-me interview (three rounds: migration shape, libp2p server,
companion app). Two recommendations were overruled; both overrulings are recorded where they land.

## What the repo already decided that this leans on

Nothing here starts from zero. Each load-bearing seam existed before this spec:

- **The JS surface being retired is exactly the Node orchestrator** — `orchestrator/{server,
  runtime, launcher, agents}` (~40 `.mjs` modules; deps: MCP SDK, `ws`, `node-pty`, `zod`). The
  native desktop is C/microui and **stays C** (charter; D49 keeps SDL as the platform layer). The
  Python tools stay Python. "JS retirement" names the Node layer, nothing else.
- **Android + Vulkan was already on the rendering roadmap** — spec 066: "Vulkan starts on Windows
  and extends to Linux and Android." **D49** commissioned an SDL-free GPU device layer (spec 115;
  the seam work of specs 121–126 is in flight now) whose render targets are supplied from outside —
  an `ANativeWindow` on Android is exactly such a target.
- **The remote-client architecture was already sketched** — `docs/research/quest-and-app-surfaces.md`
  and the proposed F49–F53 rows: a paired, versioned, root-scoped client where the desktop owns
  files, credentials, PTYs and agents, and clients receive structured channels (text/state first,
  video last). The companion app is that architecture's first client, with libp2p as the transport
  in place of the sketched bespoke paired socket.
- **The unified agent layer the phone must expose is the one F113 just shipped** — one declared
  agent recipe registry behind `agent.sh`/`agents menu`/spawn. "Same functionality for everyone"
  on the phone means serving *that* registry and its sessions, not a second mobile-specific list.
- **One recorded constraint is reversed**: spec 114 (lane O2) noted embedding Codex "needs a Rust
  toolchain we do not have." D57 introduces that toolchain; the note stands corrected here.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **Rust is the orchestrator's target language; JS retires fully, by strangler path.** The libp2p server lands first; then JS modules retire one feature row at a time behind the façade's stable protocol, each with its own evidence, while the JS host keeps serving daily dogfooding until its replacement proves out. | Owner, 2026-09-11 (recommended option confirmed) |
| 2 | **The Rust server is a façade over the existing session host.** It speaks libp2p to clients and the existing internal HTTP/WS API (`/api/*`, `/feed`) to the host — the same surface the worker and MCP connector already use. Zero changes to running workspaces; when a JS module later retires, the façade's backend swaps invisibly to clients. This is also the "desktop sidecar" shape the Quest research proposed. | Recommended; owner-confirmed |
| 3 | **Rust is wired into cmkr/CMake from day one** via a pinned Corrosion, with `rust-toolchain.toml` pinning the toolchain. The workspace lives at `red/` (`red-core` = protocol/types, `red-link` = libp2p façade/relay). This **overrules the recommendation** (standalone cargo first, CMake integration deferred): the owner wants one build entry point immediately, accepting that `init.sh` gains a toolchain check and cmkr's generated-file discipline absorbs Corrosion now rather than later. | Owner, **overruling the recommendation** |
| 4 | **Reachability: self-relay + hole-punch + mDNS, no third-party infrastructure.** `red-link` runs attached to a session host, as `--relay` on any always-on machine the owner controls (VPS, home server, infra-vr host), and discovers LAN peers by mDNS. Clients rendezvous through the pinned relay (circuit-relay v2) and attempt a direct dcutr upgrade, so the relay carries setup traffic only in the common case. Public libp2p bootstrap/relay networks are not used — an admin channel does not ride untrusted third parties. | Recommended; owner-confirmed |
| 5 | **The wire contract is protobuf, schema-first.** `red-core` holds the `.proto` definitions (prost codegen for Rust; Swift/Kotlin codegen when the platforms arrive). This **overrules the recommendation** (mirror the host's JSON shapes). The cost the owner accepted: a second contract describing the same API. The control that makes it safe: **contract tests that run the façade against the live host and validate every translated shape**, so JSON↔proto drift fails CI instead of the phone. Protocol versioning rides on the proto package + libp2p protocol name together. | Owner, **overruling the recommendation** |
| 6 | **Trust: static Ed25519 peer identities, QR pairing, row-level revocation.** A dashboard action on the desktop displays a QR carrying its peer ID, relay multiaddr and a one-time PIN; the phone proves the PIN over Noise and presents its own peer ID; the desktop persists the allowed-phone set in the workspace state directory (beside the D43 edition manifest). Revocation deletes a row. This is the Syncthing model and satisfies the pairing/revocation/root-scoping criteria the proposed F50 already records. | Recommended; owner-confirmed |
| 7 | **The app's C layer drives; Rust serves.** The shared C modules (microui interface modules, the D33 owned control layer, the spec 066/067 draw list, the D49 device layer) own the frame loop and call a small C ABI into the `red-core` cdylib: `connect`, `poll_events`, request/response. rust-libp2p's async runtime stays inside the library on its own threads. This mirrors the desktop exactly (there `app.c` owns the loop and `net.c` is plumbing; here `red-core` is the plumbing), and iOS later consumes the identical C ABI from Swift. | Recommended; owner-confirmed |
| 8 | **GPU: Vulkan-only on Android; native Metal for iOS later.** This **overrules the recommendation** (one Vulkan backend, iOS via MoltenVK). Mobile follows the desktop's per-platform backend pattern instead: Vulkan on Android through the D49 device layer with `ANativeWindow` targets; a native Metal backend for iOS when that platform ships — the device-layer seam was built for exactly this multiplication. **D29's GL→Metal→Vulkan order is hereby scoped to the desktop renderer roadmap**; the mobile app has no GL path. | Owner, **overruling the recommendation** |
| 9 | **Companion v0.1: see, chat, approve.** Roots/workspaces and session listing (the F113 unified registry), agent conversation view + send input, token contests and permission approvals, dashboard action invocation with its confirm prompts. No terminal emulator and no video on the phone yet: terminal attach lands v0.2 (libvterm is already pinned), game frame/recording viewing follows the staged channels the Quest research proposed. The phone client holds desktop-class power only through the same project-token semantics the native desktop uses. | Recommended; owner-confirmed |
| 10 | **The app lives in this repo at `apps/companion/`; the Quest 2D-client track becomes a packaging variant of it.** The shared C modules cannot be "shared with iOS later" across a repo pin boundary while they are churning. Horizon OS runs Android apps in 2D panels (already in the research), so F49–F52's client halves collapse into a packaging/input variant of this app; their bespoke paired-socket transport is **superseded** by decisions 4–6 here. The F49–F53 rows stay proposed until then, re-pointed at this spec. | Recommended; owner-confirmed |

## Architecture

```
            ┌──────────────────────────── owner desktop ────────────────────────────┐
            │  session host (Node, today)   ── /api/* + /feed (unchanged)           │
            │        ▲                                                                │
            │        │ internal HTTP/WS (same as worker/MCP connector)               │
            │        ▼                                                                │
            │  red-link (Rust) ── façade: JSON host API ⇄ protobuf (red-core)         │
            │        │          identity store, pairing, revocation (state dir)       │
            └────────┼────────────────────────────────────────────────────────────────┘
                     │ libp2p: Noise(Ed25519) · circuit-relay v2 · dcutr · mDNS
        ┌────────────┼─────────────────────────────┐
        ▼            ▼                             ▼
  red-link --relay (owner infra)        apps/companion (Android pilot)
  rendezvous only, no termination       Kotlin shell → ANativeWindow Vulkan surface
                                        C UI layer (microui modules, control layer,
                                        draw list, D49 device layer) drives frame loop
                                        └── C ABI → red-core cdylib (libp2p client)
```

- **`red/`** — cargo workspace, built through cmkr/CMake via pinned Corrosion;
  `rust-toolchain.toml` pins the toolchain. `red-core`: `.proto` contract, prost types, pairing
  and trust, the client library exported as a cdylib with the C ABI of decision 7. `red-link`:
  the façade and the `--relay` mode, one binary.
- **Contract discipline**: for every proto shape the façade emits, a test runs the real session
  host (the same fixtures the JS suite uses) and validates the translation. A host change that
  the façade has not absorbed is a red test, not a phone bug.
- **Strangler sequence after F139–F145** (each its own future row, façade protocol stable
  throughout): the MCP connector, then runtime client/discovery, then server routes, then the
  worker/feed, and the supervisor/launcher last. The phone and the desktop must never learn which
  side of the façade answered.
- **Android build**: Gradle wrapper and NDK pinned side-by-side (no hidden downloads — `init.sh`
  checks and instructs), `externalNativeBuild` pointing at this repository's CMake so the app
  compiles the same C modules the desktop compiles, not a forked copy.
- **Edition branding** follows D42/D43: the companion's name and artwork come from the edition
  manifest when editions reach mobile; the binary target is neutral until then.

## Evidence plan (per phase, established before implementation)

- **Façade**: loopback with the relay path *forced* (no mDNS shortcut) — a client on the same
  machine still traverses circuit-relay v2, so NAT code paths are exercised before any phone
  exists. Then LAN over mDNS. Then one real cellular run through owner infra, with the dcutr
  upgrade observed in logs.
- **Pairing**: sabotage rows before any success claim — wrong PIN refused, revoked peer refused,
  unknown peer refused, QR with a tampered multiaddr refused. Pairing that has never refused
  anyone is an assertion with no evidence behind it (the AGENTS.md regression rule applied to
  security).
- **Reconnect**: the F50 criteria, inherited — reconnect is not a second process launch;
  duplicate requests, client revocation and wrong-session commands fail explicitly; protocol
  version mismatch fails explicitly.
- **App**: the same native evidence discipline as the desktop — smoke snapshot on a real device,
  measured frame budget set before the run, and the shared C modules proven by compiling the
  desktop and the app from one source in one build.

## Proposed feature rows

New lane, milestone **N0** (remote access). Numbers continue the inventory (max is F138).
**Filed in `features.json` on 2026-09-11** (owner approved the same day: "plan new features"),
together with the JS-retirement epic — lane **J0**, rows F146–F165, documented in
[spec 129](129-js-retirement-epic.md), which the owner's hourly retirement loop consumes.

| Row | What |
| --- | --- |
| **F139** | Rust toolchain + `red/` workspace in cmkr via pinned Corrosion; `rust-toolchain.toml`; `init.sh` toolchain check; empty `red-core`/`red-link` crates with a smoke test built through the CMake entry point. |
| **F140** | `red-core` protobuf contract v1 (sessions, tasks, agent registry/conversations, token contests, dashboard actions, feed events) + the live-host contract-test harness. |
| **F141** | `red-link` façade: attach to a session host, serve the contract over libp2p streams, map `/feed` to a long-lived stream; forced-relay loopback evidence. |
| **F142** | Identity + pairing: Ed25519 identities, QR dashboard action, one-time PIN over Noise, revocation rows in the state directory; the four refusal sabotage rows. |
| **F143** | Reachability: `red-link --relay`, dcutr direct upgrade, mDNS LAN discovery; real cellular run on owner infra with reconnect evidence. |
| **F144** | `apps/companion` Android skeleton: pinned Gradle/NDK, `externalNativeBuild` → repo CMake, Kotlin shell, `ANativeWindow` Vulkan surface through the D49 device layer, C UI layer driving a shared screen, `red-core` C ABI linked. |
| **F145** | Companion v0.1 end-to-end from a phone over the relay: roots/sessions list (F113 registry), agent conversation + input, token contests/approvals, dashboard actions. |

Follow-ons named now, rows later: v0.2 terminal attach (libvterm, shared terminal module); game
frame/recording viewing (staged channels per the Quest research); iOS target with the native
Metal backend (decision 8); Quest packaging variant (decision 10); the strangler retirement rows
for the MCP connector, runtime client, server routes, worker/feed and supervisor, in that order.

## Boundaries touched

- Charter **D57** (Rust target language, strangler retirement, toolchain) and **D58** (remote
  access + companion shape) added to `docs/specs/000-charter.md`.
- `AGENTS.md` boundary list names the Rust direction so future agents stop extending the Node
  layer with new subsystems.
- **D29 scoped**: GL-first rendering order is the desktop roadmap; mobile is Vulkan/Android and
  Metal/iOS (decision 8).
- Spec 114's "a Rust toolchain we do not have" is corrected by D57; the embedding reconsideration
  it gated stays deferred until a business-edition customer needs it (D46 unchanged).
- F49–F52's transport half superseded (decision 10); their criteria this spec inherits are cited,
  not dropped.

## F140: the wire contract, and the harness that keeps it honest

Decision 5 chose a schema-first contract over mirroring the host's JSON, overruling the
recommendation and accepting a second description of one API. **The control that makes that safe is
the whole of this feature**, and it is worth being precise about what it does: `red-core` translates
the live host's JSON into the `red.v1` types and refuses anything it cannot carry —

- a field the contract expects and the host did not send,
- a field whose type is not what the contract says,
- an enum value the contract does not know, and
- **a field the host sent that nothing consumed.**

The last one is the case worth the trouble. It is what a host *gaining* a feature looks like, and it
is exactly the change that would otherwise reach a phone as a feature nobody implemented. A field v1
deliberately does not carry is declared with `Fields::ignore`, so "we decided not to" and "nobody
looked" are different things in the source: the terminal's live output buffer (attach is v0.2),
contract 10's per-task test manifest, and the token route's caller-specific answers are all ignored
by name.

### It found four disagreements on its first real run

Written from the host's actual responses, and still wrong in four places the moment it met a live
workspace with a declared project:

| What the host sent | What it turned out to be |
| --- | --- |
| `tasks.unavailable` | a tracker that cannot answer says **why** — `denied`, `unavailable` or `invalid`, with `signIn` naming the provider. "No tasks" and "no credential" look identical on a phone otherwise. |
| `tasks.rows[].evidence` | the local inventory's evidence lines, now carried |
| `tasks.rows[].tests` | contract 10's test manifest — **deliberately not carried** in v1, recorded as such |

That is the harness doing its job before it was ever asked to, which is the best evidence it works.

### Version, in three places that cannot drift apart

`PROTOCOL_VERSION` is one constant. The proto package `red.v1` and the libp2p protocol name `/red/1`
are both built from it, `negotiate()` refuses a peer that names anything else, and the refusal says
what the peer speaks, what this build speaks and the contract version — a person reads it, so
"handshake failed" is not good enough. A test reads the `.proto` **on disk** and asserts its
`package` line agrees with the constant, because a contract whose version is a comment is a contract
nobody can check.

### The sabotages, and the one that did not fire

Criterion 2 asks for a deliberate host-side shape change observed turning the test red. Three were
run, one per thing criterion 1 names:

| Sabotage | Observed |
| --- | --- |
| the host renames `rootId` to `root` | *"workspace.sessions[0].rootId: expected a string, the host sent nothing"* and *"…root: the host sends this and the contract does not carry it"* |
| the host renames the `exited` session state to `finished` | *"the host sent the session state \"finished\", which the contract does not know"* |
| the host emits a `telemetry` feed event | *"the host sent the feed event \"telemetry\", which the contract does not carry"* |

**The enum sabotage did not fire the first time, and that is the finding.** The fixture spawned one
shell and left it running, so `exited` never occurred and the contract's knowledge of it was never
tested — a whole enum value validated by nothing. The harness now spawns a second, short-lived
session and asserts the live host produced **both** states before judging anything.

Its precondition waits for "no longer running" rather than for the word `exited`, so a host that
renames the state reaches the checker and is reported as an unknown enum, instead of failing on the
fixture's own wait loop. A test that goes red for the wrong reason is only accidentally a test.

The harness also refuses a bundle carrying no shape it knows, and names every section it must
capture rather than judging whatever happens to be there — the same failure the `seam_symbols.py`
gate had on the day it was written, and not one worth repeating.

### The dependency policy F139 deferred to here

`red/Cargo.toml` said the vendoring policy would arrive with the first real dependency. It is:
**`Cargo.lock` is the pin.** It records an exact version and a SHA-256 for every crate, which is the
same guarantee `third_party/sources.json` gives the vendored C sources, and it is committed. F139's
"every dependency is a path dependency" assertion is replaced by the invariant it was protecting —
nothing enters the tree without a pin a reader can check — and both halves were sabotage-verified.

`protoc` is a prerequisite like SDL2 rather than a binary this repository ships: a vendored compiler
would be a compiled third-party artifact with none of the provenance the rest of `third_party`
records. `init.sh` refuses without it and says how to install it.

## F144, first slice: the companion exists and is the same code

`apps/companion` is an Android app that **builds and runs on a real device**, and the point of it is
where its C comes from. Decision 10 put the app in this repository for one reason — the shared C
modules cannot be "shared with iOS later" across a pin boundary while they are churning — so the
native build reaches *up* into the tree and compiles `third_party/microui/microui.c`,
`render/draw_list.c`, `render/utf8.c` and `theme.c` from their own places. There are no copies under
`apps/`, and a test looks for one, because a vendored second microui would satisfy every build and
defeat the entire arrangement.

Run on a **Quest 3** (Horizon OS, API 34), which is decision 10's case exactly — Horizon runs Android
apps in 2D panels, so the Quest track is a packaging variant of this app rather than a second client:

```
companion: native layer up, draw-list contract v2
companion: window ready; building one shared-UI frame
companion: draw list carries 12 command(s) from the desktop's own UI layer
```

Twelve commands, built on the headset by the desktop's own microui and draw list. That is criterion
1's real evidence: not that an APK compiled, but that the screen it built is the screen the desktop
builds.

### What it does not do yet, stated plainly

- **No GPU.** Criterion 2 — a microui screen rendered through the D49 device layer on an
  `ANativeWindow` Vulkan surface, with a snapshot and a frame budget set before the run — is the next
  slice. A frame that *exists* is the thing to prove before something draws it.
- **No red-core.** Criterion 3's C ABI round-trip waits on F141's façade; there is nothing to connect
  to yet. `Companion.kt` carries the protocol string and nothing else.
- **Not the owned control layer.** `ui.c` (D33) is SDL-free in itself — it draws through the draw
  list and nothing else — but it includes `orchestrator/native/common.h`, which includes `SDL.h`.
  Splitting that header is its own change. Pulling the layer in before it is split would mean either
  an SDL dependency on Android or a copied module, which are the two things this arrangement exists
  to avoid, so the CMake says so where the source list would otherwise look incomplete.

**F144's row stays `passes: false`**: two of its three criteria are unmet, and it depends on
F141–F143, none of which are done. This is the skeleton the integration wires into, which is what was
asked for.

### Pins, and one deliberate softening

Gradle 8.13 by wrapper **with its distribution SHA-256 verified before it runs** — the same guarantee
`third_party/sources.json` gives a vendored archive, and the published checksum was fetched and
compared rather than recalled. AGP 8.7.3, Kotlin 2.0.21, NDK 27.2.12479018, CMake 3.22.1, compileSdk
35, minSdk 29, arm64 only. Each is exact; a floating `27.+` was sabotage-verified as a failure.

Spec 128 says `init.sh` "checks and instructs" for the Android toolchain. It **reports** rather than
refuses, and that is a decision rather than a slip: unlike cargo, which the desktop build itself now
drives, this toolchain builds only `apps/companion`. A fatal check would gate every contributor's
harness on a mobile SDK to no purpose. The message names the pin it read from the build file and the
`sdkmanager` line that installs it.

### Decision 8 amended: Android gets a GL ES path (D59)

Decision 8 said Vulkan-only on Android and had no GL path. **Measurement on the owner's own phone
reversed it**, and the measurement is the point:

| | phone — Adreno 619, 2022 driver | Quest 3 — Adreno 740 |
| --- | --- | --- |
| Vulkan device version | **1.1.128** | 1.3.295 |
| `VK_KHR_dynamic_rendering` | **absent** | present |
| `VK_KHR_synchronization2` | **absent** | present |
| the seam's Vulkan backend opens | no | yes |

That is the device's own extension list, not a conservative feature flag: the loader reports 1.3 and
the *device* reports 1.1. The seam's Vulkan backend is built on dynamic rendering and
synchronization2 throughout, so on this handset it cannot run at all — and F145's premise is "a phone
on cellular", which means exactly this class of hardware.

The pack already has an OpenGL backend, and **all 56 GL entry points it loads exist in OpenGL ES
3.x** — none of the desktop-only ones (`glPolygonMode`, `glDrawBuffer`, `glMapBuffer`,
`glGetTexImage`) are among them, and the backend has no hard 3.3 gate, only a `glGetString` it
reports. What was missing was a shader dialect and a host.

This is not D29's GL-first order returning to mobile. It is one backend the pack already carries
reaching one more class of device, and Vulkan stays the path wherever the device offers it — proved
on the Quest before this was written.

### What the phone actually draws

`--` the companion renders the desktop's UI on a Xiaomi 22111317PG (Android 14, Adreno 619) through
OpenGL ES 3.2: **60 fps steady, 30 draw-list commands, 37 ms slowest frame** (the first, paying for
shader compilation) at density 2.75.

What makes it worth more than a screenshot is what is *not* in `apps/`. The frame is microui's, the
commands are `draw_list.c`'s, and the thing that executed them is `backend_seam.c` — the desktop's
renderer, compiled from its own place in the tree and unchanged, running on the pack's OpenGL
backend. The only Android-specific file in the renderer is `seam_host_android_gl.c`, 146 lines of
EGL, which is the fifth member of the one-file-per-platform split spec 124 established.

Two additions made that possible:

- **`ReSeamShader.glsl_es`.** `#version 330 core` and `#version 320 es` are different languages, and
  only the backend knows which context it opened — so the GL backend reads `GL_VERSION` once at open
  and prefers the ES dialect when it is an ES context. A desktop consumer sets `glsl` alone and meets
  exactly the behaviour it always had; the three desktop renderers are byte-identical across this
  change.
- **The window handle above the host is opaque.** `seam_host.h` took an `SDL_Window *`, which is what
  kept `backend_seam.c` — a file with no SDL in it — from compiling for a phone. It now takes a
  `void *` that each host casts back, and error reporting moved to `re_seam_host_fail` so the
  platform's own channel is used (`SDL_SetError` on the desktop, the log on Android).

`RE_COMPANION_BACKEND` selects `opengl` or `vulkan` at build time — one binary, one backend, as D14b
has it for a game. Both arms were built. A runtime choice between them is what the desktop's prefixed
copies (D56) exist for, and nothing needs it yet.

**Still not met**: criterion 2 asks for a frame budget *set before the run* and a smoke snapshot in
the suite; what exists is a measurement taken after the fact and a screenshot taken by hand.
Criterion 3's C ABI round-trip still waits on F141.

### The companion uses the desktop's control layer, not microui's defaults

Three things were wrong with the first rendering companion, and the third is the one that mattered:
it was not clickable, it did not adjust on rotation, and it drew raw microui rather than the
product's own look.

**Input.** Touch is microui's mouse — microui was built for a pointer and one finger is a pointer.
The move has to land before the press, because microui resolves hover before it resolves a click and
a finger arrives already pressed; without that the first tap goes to whatever was hovered last, which
on a touch screen is nothing. On release the pointer is parked off-screen, because a touch UI has no
hover and a button that stays lit after a tap looks stuck.

**Rotation.** microui remembers a window's rect by name after the first frame — right for a desktop
where a person moves it, wrong for a phone where the display decides. A rotation gave a new surface
and the same remembered rect. The container's rect is now written every frame.

**The look.** The D33 owned control layer is the product's appearance, and the companion now compiles
it: `re_ui_button_ex`, `re_ui_label_ex`, `re_ui_separator`, with the generated theme's palette and
metrics, driven through `re_draw_begin` / `re_draw_commands` / `re_draw_end` — the same frame flow
`main.c` runs.

Reaching it meant finishing the portability work D59 started, because `ui.c` was SDL-free all along
and only its header's include chain kept it on the desktop:

- **`draw.h` stopped including `common.h`.** That header pulls SDL, and `ui/ui.h` leans on `draw.h`.
  It now takes the three helpers it actually needs, and the desktop headers that had been getting
  SDL transitively through it (`editor.h`, `formatview.h`, `hexview.h`, `imageview.h`, `scroll.h`)
  include it themselves — which they should, since they name `SDL_Event`.
- **`draw.c` lost its four SDL uses.** The window handle is opaque; the open-time `SDL_GetWindowSize`
  was redundant because density is recomputed every `re_draw_begin`; the performance counter became a
  portable monotonic clock; and the font failure is reported by the caller, which has somewhere to
  put it, rather than by reaching for the seam host's reporter and coupling the draw glue to whichever
  backend the binary linked.
- **The companion reuses the desktop's prefix mechanism (D56)** rather than gaining an `#ifdef`:
  `draw.c` dispatches to the prefixed entry points, so the one backend this binary carries is
  compiled under the matching rename header, and the backends it does not carry answer with a refusal
  in the app's own file — which is where "this binary has one backend" is true.

The desktop is byte-identical on all three renderers across every step of this, and the render spec
still passes against the recorded frames.

## The phone's two defects, and what each one was really about

The owner ran the companion on an Android phone and reported the same two things twice: the buttons
could not be tapped, and they were not in the IDE's style. Both are now fixed, and neither was where
the recorded diagnosis said it was — which is the part worth keeping.

### Touch: a handler nobody registered, and a command that proved nothing

`android_main` set `onAppCmd` and never set `onInputEvent`. The NDK's glue reads the input queue in
`process_input` and then does `if (app->onInputEvent != NULL) handled = app->onInputEvent(...)`, so a
null handler is an event nobody wanted rather than an error: the app kept drawing at 60 fps and threw
every touch away in silence.

KI-090 had recorded the opposite — "assigned in `android_main` and never called, verified by logging
on entry while tapping with `adb shell input tap`". The handler and its registration had in fact been
lost in the revert to the direct-backend file, so there was nothing to call. **And the verification
was empty:** this phone answers `adb shell input` with `SecurityException: INJECT_EVENTS`, and
SELinux refuses `sendevent` on `/dev/input` to the shell domain even though `shell` is in the `input`
group. The command that "proved" the handler was never entered had never delivered a tap. A device
observation is only evidence once the stimulus is confirmed to have happened.

One finger is a mouse, which is all microui knows. A tap whose press and release both land between
two frames still submits: `mu_input_mouseup` clears `mouse_down`, but `mouse_pressed` survives until
`mu_end`, and `mu_update_control` sets hover precisely when the pointer is over the control and
`mouse_down` is clear. The pointer is parked off-screen after a release because a finger has no
hover and a control should not keep the look a mouse would have earned by staying there.

### Style: a units contract, not a renderer defect

The owned control layer needs `ReDraw` — `re_ui_begin` takes one — and the ReDraw path was blocked by
KI-089, "rects render, glyphs do not". It rendered glyphs the whole time. `re_draw_begin(draw, w, h)`
asks the backend for the density by dividing the drawable it owns by the `w` it is handed, so passing
the phone's physical 1080×2400 reports a density of **1.0** and draws the entire interface at 1/2.75
scale: 12-pixel text on a 1080-wide panel, which looks exactly like no text at all next to a
full-screen probe rect.

The bisect had already measured this and it was read as a symptom instead of the cause:
`text_width("HELLO")=40` is a cell width of 8, which is the mono advance at density 1.0 — at 2.75 it
is 20 and the string is 100. The number that identified the bug was in the issue for a day.

`re_draw_begin`'s header now says the size is logical pixels and that the backend derives density
from it, because a function whose density depends on the units of an `int` argument is a contract,
not a detail.

### What the phone draws now

`re_ui_button_ex`, `re_ui_label_ex`, `re_ui_row_ex` and `re_ui_pill` — the IDE's own controls, not a
phone stylesheet and not upstream microui's widgets. Two consequences worth naming:

- **The bundled faces ship in the APK.** `re_font_open` found neither Inter nor Phosphor on Android,
  because their paths were a compile-time `RENGINE_FONT_DIR` concatenation and every face fell back
  to the system mono. `re_font_bundle_dir` makes that directory a run-time value; Gradle stages the
  repository's vendored faces into the APK's assets (the repository stays the one origin, F144
  criterion 1) and the native layer unpacks them where `fopen` can reach them. The desktop keeps the
  compiled-in default and its reference frames are unchanged.
- **The panel is fullscreen.** Without `AWINDOW_FLAG_FULLSCREEN` the status bar sits on top of the
  first row, and the native layer has no way to ask how tall it is.

`companion-build.test.mjs` gates both defects as properties rather than as fixes — the entry must
register an input handler and feed `mu_input_*`, and the frame must not call `mu_button`, `mu_label`
or their siblings. Each was observed failing for its own reason: the registration deleted, and one
`re_ui_button_ex` swapped back to `mu_button`.

Touch targets are the desktop's metrics — a 26 dp row, a 26 dp button — which is below Android's
48 dp guidance. That is deliberate for now: the owner asked for the desktop's styling, and a phone
scale factor is a design decision rather than a bug to fix quietly.
