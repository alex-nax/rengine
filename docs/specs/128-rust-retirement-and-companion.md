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
Filing these into `features.json` is the next owner-approved step; this spec is the plan of
record until then.

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
