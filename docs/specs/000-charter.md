# rEngine charter and design interview

Date: 2026-09-05. Status: **interview in progress; recommendations are not owner decisions**.

## Owner-established requirements

| ID | Decision | Source |
| --- | --- | --- |
| D01 | Create rEngine, eventually called realEngine, as a harness, curated library and tool collection for the AI era. | Initial project brief |
| D02 | Both reLith and reSource should be considered powered by rEngine. | Initial project brief |
| D03 | Projects remain individual; a game's framework choice, including potentially flecs, must remain possible. | Initial project brief |
| D04 | Use the referenced projects' harness patterns and plan future integrations precisely. | Initial project brief |
| D05 | Conduct a probing design interview while setting up the repository. | Initial project brief |
| D06 | NOLF works; AVP2 and NOLF2 are in progress. iklib and agent-training work already exist. | Owner's status report; not a new runtime verification |
| D07 | Prioritize a quality library base for AI-assisted, purpose-built implementations. The owner sees NOLF and VtMB as evidence that individual engines can be written from scratch and questions the need for large all-in-one engines. | Owner's answer to interview question 1, 2026-09-05 |
| D08 | Curate upstream libraries and implement our own demonstrated gaps. | Owner confirmed the library-ownership recommendation, 2026-09-05 |
| D09 | Prove one library in both games before expanding the collection broadly. | Owner confirmed the first-proof strategy, 2026-09-05; D23 later names iklib |
| D10 | Include a tab-based IDE/orchestrator to improve the current Zed-plus-terminal workflow: start empty, split/resize panes and populate them with project tree, terminals, rendered tools and game output. Game views can open as tabs and move into panes. | Owner's workspace description, 2026-09-05 |
| D11 | Initially an agent tab runs a terminal with a Bash launcher that selects or installs a CLI coding agent and bootstraps integrations such as custom MCP servers. | Owner's workspace description, 2026-09-05 |
| D12 | Consider integration with tools such as Meta XR Operator. | Owner's integration suggestion, 2026-09-05; compatibility and implementation remain unverified |
| D13 | Support macOS and Windows from the first desktop release. | Owner's platform answer, 2026-09-05; supersedes the macOS-first recommendation |
| D14 | Use adapters for initial game/tool integration; also investigate support for unmodified external apps. | Owner's surface answer, 2026-09-05; arbitrary app compatibility is not guaranteed |
| D15 | Research a Quest distribution with a desktop sidecar. | Owner's research request, 2026-09-05 |
| D16 | Quest starts with the shared 2D workspace; independent spatial panes follow later. | Owner's Quest-layout answer, 2026-09-05 |
| D17 | Include project tree, previews, a basic text editor with optional Vim mode, and terminals in the initial IDE scope. | Owner's editing answer, 2026-09-05; supersedes the preview-plus-external-editor recommendation |
| D18 | Closing views detaches them; sessions persist until explicitly stopped. Include a session browser for managing and reopening sessions. | Owner's lifecycle answer, 2026-09-05 |
| D19 | Implement the desktop workspace and terminals first, including a flat game rendered into a new tab in that first useful milestone. | Owner's execution-priority answer, 2026-09-05 |
| D20 | A workspace supports multiple project/worktree roots; each terminal, editor, agent and game session is explicitly bound to its own root. | Owner's “Yes, just as you recommend” to the project-scope recommendation, 2026-09-05 |
| D21 | Use flat NOLF for the first live game tab on macOS and Windows; VtMB follows as the second game adapter. | Owner's “Yes, that's what I was thinking about” confirming the two recommendations, 2026-09-05 |
| D22 | Preserve unsaved edits as local recovery drafts; write working files only on explicit Save. | Same owner confirmation as D21, 2026-09-05 |
| D23 | Select iklib as the first library to prove in both games. | Owner's “GO for gecommended” answering the iklib/adoption round, 2026-09-05 |
| D24 | “Powered by rEngine” requires adoption of at least one curated capability at a pinned version with passing game integration checks. Use of the IDE and shared harness is optional. | Same owner confirmation as D23, 2026-09-05 |
| D25 | Implement the launchable NOLF orchestrator with proper game launching, tree, editor and a preferred CLI agent booted through a find/update/download/launch shell script. | Owner's active implementation goal, 2026-09-05; authorizes the scoped desktop/agent inventory and supersedes the setup-only review wait |
| D26 | Use microui with C for the desktop GUI; remove Electron. | Owner: “no electron, use microui with c instead for gui”, 2026-09-05; supersedes the earlier implementation stack |
| D27 | Avoid heavyweight application runtimes such as Electron. A web interface follows later as a separate client. | Owner: “We never use such overhead in runtime such as electron … later we would have web interface though”, 2026-09-05 |
| D28 | Pause broader development here; resume the same agent conversation through the native orchestrator after prerequisites, with desktop reload retaining the agent. | Owner's 2026-09-05 orchestrator handoff/pause request; implementation and limits in spec 058 |
| D29 | The desktop renderer moves to full GPU rendering behind a graphics-API adapter boundary: OpenGL first, then Metal, then Vulkan. The theming update designed in Claude Design is implemented on that renderer, not on SDL_Renderer. | Owner: “For the future - we want full gpu rendering. We will have adapters for different graphical APIs, - first OpenGL, then Metal and Vulkan”, 2026-09-06; requirements and phases in spec 066 |
| D30 | The rendering implementation is a candidate approved rendering library for the curated base once it meets the library-quality record and the D24 adoption rules; games adopt it through adapters and are never required to. | Owner: “This rendering implementation can be our approved rendering library in future”, 2026-09-06 |
| D31 | The Windows verification host for rEngine is `pr0fe@192.168.31.217`; source transfer to it is authorized as commits only, into an isolated checkout, never the working tree. This resolves the approval KI-014 waited for. | Owner: “for windows verification use ssh pr0fe@192.168.31.217 machine”, 2026-09-06; method in spec 073 |
| D32 | The Vulkan adapter's floor is the maximum Vulkan version Quest 3 supports, which is Vulkan 1.3 (Quest 3 driver v837 reports 1.3.295). | Owner: “We need to have the same maximum that Quest 3 supports”, 2026-09-06; research in spec 073 |
| D33 | Controls the design needs beyond pinned microui are owned additions written in microui's conventions, never a fork, and they join the curated library packs as their own capability. | Owner: “if microui is not enough - we write addition keeping the same compatible contract and conventions like in microui lib - these extensions will be also part of our library packs”, 2026-09-06; design in spec 076 |
| D34 | A theme file may override all three token layers and a project root may carry one, but a project's theme is offered rather than applied: the workspace's appearance never changes because a repository was opened. | Owner decisions during the F60 interview, 2026-09-06 (spec 076 decisions 8–9) |
| D35 | The workspace shows task tracking from one declared backend per project: the git-checked-in inventory by default, GitHub Issues or Linear where declared. The view reads and does not write, because neither provider offers concurrency control on an issue write. A credential never lives in the committed project declaration. | Owner decisions during the F78 interview, 2026-09-07; spec 083 |
| D36 | A project may name the workspace: the default title is rEdit, and a declared title and glyph logo come from the window's primary root rather than the focused tab, with the operating system window title following the same rule. A logo colour is a design token name, never a raw value, so contrast stays a property of the design system. | Owner decisions during the F79 interview, 2026-09-07; spec 084 |
| D37 | rEdit adopts the Language Server Protocol rather than deriving diagnostics only from parsed build output. The proposal on the table was the narrower one — run a project's declared check action and parse its output — and the owner chose LSP over it. A language server is an external program, so it is *declared* per project like every other command rEngine runs (D26 boundary: explicit inputs, no hidden downloads, no required `~/...` paths); rEngine never installs one. Parsed check output remains a second diagnostic source, not the primary one, because a build sees failures no server does. The client is owned by the replaceable workspace worker, not the retained session host and not the C desktop, so it ships by a layered update and the desktop stays a renderer of what it is told. | Owner, 2026-09-07: *"LSP adoption looks great"*, choosing between the two sources offered on F102; spec 102 |
| D38 | An extension is an in-process native plugin: it draws by appending to the draw list (already `RE_DRAW_LIST_VERSION 2`, backend-neutral across SDL, OpenGL, Metal and Vulkan) and registers tabs and controls through the owned control layer of D33, never through pristine microui's context. Plugins are declared by the project, with an external declaration file for a project that cannot hold them; no installed registry, no required `~/...` path, no hidden download. A plugin fault costs the desktop window and its layout and never a session, because sessions, drafts and agents belong to the retained session host — so a plugin reaching store, session or host state is outside this grant. | Owner, 2026-09-07, choosing in-process over the recommended declared-commands-only during the spec 105 interview |
| D39 | A pack is one pinned, versioned artifact whose manifest declares facets: a `library` facet is source and a CMake target a game consumes at build time, a `plugin` facet is a module the editor loads. One word and one pinning story for iklib, for editor extensions and for the renderer, which is expected to declare both. D24's "Powered by" claim is defined on the **library** facet, so an editor plugin does not earn it. | Owner, 2026-09-07; spec 105 |
| D40 | An edition is a declared bundle of packs over one binary — a manifest naming packs and branding, not a fork and not a build flag. No build matrix, no per-edition gate runs, and moving between editions changes what is declared. | Owner, 2026-09-07; spec 105 |
| D41 | The product is **Red** and the umbrella is **Red Suite**. This revises D36, which made `rEdit` the default workspace title. The name stops being hard-coded and becomes generated the way theme tokens are, so the rename is a data edit; `IDE_NAME` is externally visible in other people's `/ide` menus, so it is a published change. | Owner, 2026-09-07: "naming rEdit -> red, integrated tool suite, like 'Red suit'"; spec 105 |
| D42 | Red is the product; the **editions are the brands**. The binary keeps the single generated name of D41 and F110; an edition carries its own brand on top — **RED Suite** for the business stream, **rEngine** for entertainment. This refines D41: Red Suite is not an umbrella over both, it is the business edition's brand, and rEngine becomes the entertainment edition's. The generated `PRODUCT_SUITE` that F110 shipped unconsumed therefore moves into the edition manifest rather than staying a global constant naming one edition. | Owner, 2026-09-08: "business stream(RED Suite) - kohai … entertainment(rEngine) - ~/nolf-improved, ~/vtmb-vr"; spec 109 |
| D43 | An edition is declared in the **workspace state directory** — not in any project, which cannot own something that spans projects, and not in the rEngine checkout, which would put a business customer's manifest in the entertainment tree. It sits beside the state a workspace already keeps there, including the external declaration and credential that the business project already uses because it is not ours to write files into. A project stays ignorant of which edition opened it. An edition varies packs, branding and the **default layout of a fresh workspace**; it never varies which declaration blocks exist, because a contract must mean the same thing in every install, and it never overrides a layout a person has arranged. | Owner, 2026-09-08, extending D40; spec 109 |
| D42 (revised) | The **editor's name comes from the edition**, not from one global constant. Entertainment is **rEngine** and its editor is **rEdit**; business is **RED Suite** and its editor is **red**. The reason is a real collision rather than taste: in a games context "Red" borrows CD Projekt Red's identity, and in a business context it does not. This revises D42 as first written and revises D41 again — rEdit was never retired, it is the entertainment editor's name, and `Red` is the family word it produced. F110's mechanism survives; what it holds becomes edition-supplied, and `rEdit` must leave the guard's retired list, which today rejects a name that is correct again. | Owner, 2026-09-08: "rEdit is the name for EDITOR in entertainment, RED Suite - business edition, red - editor", "we had a CD Project Red studio with similar naming"; spec 109 |
| D44 | **Library adoption is evidenced by the adopting project and proven by the owner's sign-off in a spec.** The game runs its own integration checks in its own checkout and records the result beside its own declaration; rEngine reads that and never asserts it, because a local task cannot mark another project's feature done. A `poweredBy` flag in a pack manifest stays the project's *claim*; the D24 badge is earned when the owner records the pack, the exact pin, the project and what was seen. **(The `poweredBy` half was withdrawn the same day by D45; the sign-off half is unchanged and is now the whole mechanism.)** A declared check command was recommended and rejected: a green command proves a command went green, and D24's bar is a judgement. | Owner, 2026-09-08: "we need to design a mechanism for library adoption to our suite"; spec 110 |
| D45 | **`poweredBy` is removed from the pack manifest: an adoption is recorded, never claimed.** D24's definition — one curated capability at a pinned version with passing game integration checks — stays exactly as written and stays the bar; what goes is the idea that a project *announces* having met it. A declaration says what a project **consumes** — a pack, its pin, its facets — and whether that amounts to an adoption worth the name is a judgement, which D44b already placed in a spec the owner signs. This **revises D44** in one clause: there is no flag, so there is no claim to keep separate from the proof. D44b is untouched. Taken at the moment the duplication became concrete — the first real adoption measured, its sign-off record written, and the owner asked to state it a second time in a manifest. | Owner, 2026-09-08: "'poweredBy' is just an abstract no need to brand it"; spec 112 |
| D46 | **The suite invests in agent *protocol* first; embedding an agent is a later, separate step.** Our agent layer is already protocol-shaped rather than agent-shaped — PTY sessions, a per-launch private MCP config, an `/ide` server, hooks — and that stays right while every vendor ships a better harness than we would write. Two slices: one declared **agent recipe registry** (the registry F39 asks for exists today only implicitly, spread across four private tables), then an **ACP session kind** for the agents that speak it natively. Claude stays PTY + `/ide` because its Agent SDK forbids third-party products offering subscription login. Embedding is revisited when a business edition customer needs an agent in the box, and ACP is the transport it would use anyway. | Owner, 2026-09-09: "Both, protocol first"; spec 114 |
| D47 | **rEngine reads a project's test evidence and never asserts it — but it may *file* a judgement as a task.** The Tasks tab shows what the project recorded. On top of that a person or an agent can flag a test as bad or propose a new one, and that verdict is written back through the project's own `tracker.write` as a task in the project's own inventory. This keeps D44 exactly as written while making the judgement actionable where it belongs. Running a project's tests from the Tasks tab stays out of scope. | Owner, 2026-09-09: "first it will be read only, but we need to be able to flag bad tests and propose new (maybe through agent) also be able to better judge test runs and results"; spec 114 |
| D48 | **The flat game-driven harness comes first; the Vulkan path that reopens VR is a later pack candidate.** Agent-driven input, frame capture and recording ship over the surface transport that already works. Headset-free VR automation is closed to both games because Meta XR Simulator excludes OpenGL and OpenGL ES and both games bind them, so the graphics-API abstraction that would give them a Vulkan OpenXR binding becomes the **consumer need** D30 and the roadmap's "expansion requires a consumer need" rule were waiting for. It is a pack candidate sequenced after the flat harness — and not a drop-in: our draw list is 2D UI and our Vulkan backend is SDL-surface-bound, so adoption means extracting a device layer that does not exist yet. | Owner, 2026-09-09: "1 -> 3 (rendering api abstraction is a good candidate for including in rengine bundled library pack)"; spec 114 |
| D49 | **SDL stays as the platform layer and leaves the device layer.** rEngine keeps SDL for windowing, input, threads, clipboard, cursors and timers on both desktops — measured at 172 distinct symbols, and replacing them is the work SDL exists to do on the platform we are weakest (KI-038). What is extracted is an **SDL-free GPU device layer** — instance, physical-device selection, device and queues, memory, command submission — with render targets supplied from outside, so the desktop drives it with an SDL surface and an OpenXR host drives the same layer with runtime-supplied swapchain images and no surface at all. The coupling being cut is thin and exact: 23 SDL references in `render/backend_vk.c`'s 750 lines, which are precisely what OpenXR takes over. `SDL_Renderer` stays the reference oracle (D29) and stops being a shipping path. This is the concrete form of D48's pack candidate. | Owner asked whether to ditch SDL, 2026-09-09; spec 115 |
| D50 | **A game's Vulkan work starts only once rEngine ships a proper library pack from its own sources.** Without the gate, two games each write their own Vulkan OpenXR binding in parallel — the duplicated implementation D01 and D08 exist to prevent, and what D24's "one curated capability at a pinned version" was written against. With it, F61's "one game adopting the renderer through an adapter" gains a mechanism instead of an aspiration. This stands **beside** the pilot rather than above it: iklib is the selected first two-game library proof (D09, D23) and it proved the **consumption** path — pinned submodule, `add_subdirectory`, a linked CMake target, an adoption measured and signed off. F123 proves the **production** path, which iklib never had to answer because it keeps its own repository and its own source and feature authority: a capability living in rEngine's own tree has never been consumable from outside it. A proper pack means a standalone build (the `NOT CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR` shape iklib already proves), a public surface smaller than the tree, a two-part pin, and a consuming project that has actually built it. Acquisition needs nothing new here and KI-008 need not be settled first: a project that already pins `third_party/rengine` receives the pack with a pin it already has — a property of rEngine's own packs that does not generalise to third-party ones. | Owner, 2026-09-09: "The game vulkan work should be started once we have a proper library pack implemented in rengine sources"; spec 115 |
| D51 | **The renderer's backend switch stays compile-time: two binaries, not two paths in one.** This upholds VtMB's D14b rather than revising it — Quest is the constrained target, several of the seam's calls are per-draw, and the frame path keeps zero indirection. "Switch to OpenGL to catch regressions and performance issues" therefore means build both and compare, which is the discipline rEngine already runs on its own adapters through `native-render.spec.mjs` and `tools/render_compare.py`. The cost is named rather than discovered: catching a regression on a headset needs a rebuild and a redeploy, and there is no in-session A/B. | Owner, 2026-09-10, choosing compile-time over a runtime dispatch table; spec 121 |
| D52 | **The rendering pack's design starts from VtMB's `src/renderer/gpu/device.h`, and its first proof is a Vulkan backend behind the surface already migrated.** rEngine generalises a shape earned in a real renderer instead of inventing one in the suite (D01, D08), and VtMB adopts the pack by deleting its own copy. The first Vulkan backend is written against VtMB's **13** already-migrated files, because that is the cheap test of D14c's central and untested bet — that resource+draw granularity can carry Vulkan with command buffers, render passes and barriers built inside the backend. If it cannot, we learn it at 13 files rather than after migrating 49 more onto a seam that cannot hold it. Measured first: VtMB has 125 GL symbols across 62 files with 13 behind the seam; NOLF has 102 across 39 with none. | Owner, 2026-09-10; spec 121 |
| D53 | **The rendering pack carries all three graphics APIs rEngine ships, Metal included, and rEngine proves the seam on itself rather than waiting for a game.** D52 sequenced the Vulkan backend at VtMB because the seam's missing render-target API is shaped by call sites rEngine did not have; the answer is to give rEngine those call sites — a scene example in the pack, and the desktop's own draw list moved onto the seam — so GL, Vulkan and Metal are compared here, on pixels, through one set of call sites. Measured first: ~140 framebuffer calls in VtMB and six missing entry points in rEngine's draw-list backend both name the same addition, and the 13 files already behind VtMB's seam contain zero raw GL calls. One authored shader still serves every backend, through glslang and SPIRV-Cross, with no runtime compiler. | Owner, 2026-09-11: "I like option 4, we can also write a small app for integration testing"; "also do this for metal"; spec 124 |
| D54 | **SDL_Renderer stops being a selectable renderer, and the oracle it served becomes committed reference frames.** This carries out D49, which already said it stays the reference and stops being a shipping path. The consequence is named rather than discovered: once GL, Vulkan and Metal all run through one seam, a seam defect that moves pixels identically in all three is invisible to cross-comparison, and SDL is the only path sharing no code with the others. So its frames are captured before it stops shipping and committed, and the comparison judges against data that cannot drift with the code it judges — the reference-image gate vtmb-vr already runs. | Owner, 2026-09-11: "retire plain sdl"; D49, spec 124 |
| D55 | **A plugin may render, and may be pointed at — within its own tab and within one frame.** D38 granted "registration, drawing, clipping, measurement and colour lookup and nothing else", and spec 106 deferred textures because "a plugin holding one across a backend switch is a use-after-free the desktop cannot see", and input because "v1 is an extension that can draw". Both move, and the first moves in a shape that removes the stated hazard rather than policing it: a render target is requested by size each frame and returned as a handle good for that frame only, so nothing survives a backend switch to dangle — the discipline tabs already use, where a generation invalidates work in flight. Input is pointer, buttons and wheel while the pointer is inside the plugin's own tab, with the containment the clip already has. Keyboard, shortcuts, controls, unloading and any reach into store, session or host state stay refused. | Owner, 2026-09-11, choosing a plugin over a desktop view for the scene; spec 126 |
| D56 | **rEngine keeps `--renderer` as a runtime switch by linking three prefixed copies of the seam; the pack stays compile-time.** D14b and D51 chose compile-time selection because Quest is constrained and several seam calls are per-draw, and that holds for the games the pack serves — one backend per game binary, unchanged. rEngine's desktop is a development tool whose job includes comparing backends, so it compiles the seam three times with its public symbols prefixed and dispatches through a table. SDL_Renderer stops being a selectable renderer and the committed reference frames become the oracle it served (D49, D54). | Owner, 2026-09-11; spec 126 |
| D57 | **The orchestrator's target language is Rust; the Node layer retires fully, by strangler path.** The first Rust component is a libp2p server (`red-link`) standing as a façade over the existing session host's unchanged `/api/*` + `/feed` surface — the shape the Quest research already called the desktop sidecar — and after it the JS modules (`orchestrator/{server,runtime,launcher,agents}`) retire one feature row at a time behind the façade's stable protocol, never mid-row, while the live host keeps serving daily dogfooding until each replacement proves out. Rust enters the build from day one through `rust-toolchain.toml` and a pinned Corrosion inside cmkr — the owner overruled the standalone-cargo recommendation, wanting one build entry point immediately. The native C desktop and the Python tools stay what they are. This reverses spec 114's recorded "a Rust toolchain we do not have"; the agent-embedding reconsideration that note gated stays deferred with D46. | Owner, 2026-09-11: "we need to plan our js retirement in favour of rust and the first thing that rust will be used - is libp2p integration(https://github.com/libp2p/rust-libp2p on server)"; spec 128 |
| D58 | **Remote access is a libp2p façade on owner-pinned infrastructure, and the mobile companion is its first client.** Reachability is self-relay (`red-link --relay` on owner-controlled machines) + dcutr hole-punch upgrade + mDNS on LAN — never the public bootstrap network, because an admin channel does not ride untrusted third parties. Trust is static Ed25519 peer identities, QR pairing with a one-time PIN over Noise, and row-level revocation in the workspace state directory. The wire contract is protobuf, schema-first in `red-core` — the owner overruled the JSON-mirror recommendation and accepted a second contract, controlled by contract tests that validate every translated shape against the live host. The companion app lives in this repo at `apps/companion/`: Android pilot, where the shared C interface modules (microui, the D33 control layer, the draw list, the D49 device layer) drive the frame loop over Vulkan/`ANativeWindow`, and `red-core` serves them through a small C ABI — C drives, Rust serves, exactly as `app.c`/`net.c` already arrange it. iOS later reuses the same modules and ABI with a **native Metal** backend — the owner overruled MoltenVK, extending the desktop's per-platform backend pattern to mobile and scoping D29's GL-first order to the desktop. v0.1 is *see, chat, approve* (sessions, agent conversations, token contests, dashboard actions). The Quest 2D-client track becomes a packaging variant of this app; F49–F52's paired-socket transport is superseded. | Owner, 2026-09-11: "I want to have a mobile companion app so I can connect from anywhere(pilot - android, use microui for rendering on vulkan using ndk so that we share interface modules later with ios)"; spec 128 |
| D31 | Support opening/managing a separate integration-project window with the current retained agent, inspection and a return channel for rEngine findings, with a reusable agent routine. | Owner's NOLF dogfooding request, 2026-09-06; spec 069 |
| D32 | Measure llm-sidecar usefulness before bundling it as a project skill; adapt only the selected wizard skill for orchestrator terminal actions without references to unselected skills. | Owner's skill evaluation and wizard-selection requests, 2026-09-06; spec 070 |

D07 establishes the product direction. The claim that engines are becoming obsolete is the owner's
thesis, not a verified industry-wide conclusion. The implementation question here is how rEngine
can make a project's selected components dependable and straightforward to compose.

## Code-derived constraints

- The engines have separate compatibility seams and different platform/math conventions.
- Both engines already compile portions of `infra-vr` from a local sibling path.
- iklib exposes a portable core and host presets, but its tracked host migrations are pending.
- Training owns frozen evaluation splits, isolated grading, export auditing, and a readiness GO.
- Existing feature counts and old README status blurbs are not playability measurements.
- Engine worktrees were active during inspection. Commit IDs alone do not identify every file
  observed; the source inventory records working-file hashes.

Evidence and limitations: [reconnaissance](../reconnaissance.md).

## Recommendations awaiting confirmation

| ID | Recommendation | Why / consequence |
| --- | --- | --- |
| P01 (superseded) | First prove one shared verification/evidence workflow in both engines. | Replaced after D07: this would put supporting tooling ahead of the requested library base. Retained as a later harness proposal. |
| P02 (confirmed by D03/D24) | Projects selectively adopt pinned capabilities and remain independently buildable. | Games retain their architecture and can meet the adoption minimum without the IDE or shared harness. |
| P03 (minimum confirmed as D24) | Use an optional project manifest and capability-specific conformance to make adoption measurable. | Verified pinned adoption is confirmed; the exact record/manifest format remains proposed. |
| P04 | Keep iklib, infra-vr, and training independently maintained; curate and integrate them. | Existing ownership, APIs, and roadmaps already exist. |
| P05 | Keep model/provider selection outside core contracts; interchange tasks, commands, and evidence. | A model choice should not require a game integration rewrite. |
| P06 (revised) | Keep reusable tooling usable independently of the orchestrator; use text/JSON artifacts where useful. | D10 now supplies an explicit IDE use case. The earlier deferral of an editor/workspace product is superseded. |
| P07 | Use native game behavior as the authority for parity; distinguish it from deliberate modernization. | A shared package's unit tests cannot prove that a game still behaves correctly. |
| P08 (confirmed as D08) | Curate upstream libraries and author/extract our own libraries for demonstrated gaps. | Owner confirmed. Whether any specific wrapper adds value is still a per-boundary decision. |
| P09 (confirmed as D09/D23) | Prove iklib in both engines first. | Strategy and named library confirmed; exact revision, target profiles and parity measures remain feature-spec work. |
| P10 | Library quality includes contract clarity, correctness, composition, measured resource behavior, maintenance and executable integration knowledge. | Detailed proposal: library-quality.md. A README link alone is insufficient evidence. |
| P11 (lifecycle confirmed as D18) | Model the workspace as resizable splits containing tab groups; tabs refer to sessions with independent lifetimes. | Moving a tab preserves terminal/game identity. D18 settles close/detach/stop and GUI-exit behavior; D20 settles explicit root binding. |
| P12 (partly superseded/confirmed) | Use explicit game/tool adapters first. | D14 confirms adapters. D13 supersedes macOS-first with macOS and Windows from the start. |
| P13 (layout confirmed as D16) | A Quest client uses a desktop sidecar for filesystem, build, terminal, agent and game sessions. Start with the shared layout in a 2D panel before optional independent spatial panels. | The 2D-first layout is confirmed. Pairing, transport and input design still need proof. |
| P14 (confirmed as D18) | Detach views while sessions remain in the sidecar, with an explicit Stop operation. | Owner also requires a session browser for managing retained sessions. |
| P15 (confirmed and extended as D19) | Implement the desktop workspace/terminal slice first. | Owner explicitly includes a flat game rendered into a new tab; terminal/layout-only work does not complete the first milestone. |

These are planning defaults, not settled runtime interfaces or implementation authorization.

## Interview tree

Ask small rounds, in dependency order; answer source questions through inspection.

1. **Purpose — direction answered, concrete proof pending.** D07 makes the quality library base
   primary. D24 settles the minimum powered-by commitment; operational authority and the precise
   training bridge remain scoped design work.
2. **Library ownership and first proof — answered.** D08/D09/D23 confirm curated upstream
   plus our own gaps and iklib in both games first. Specify the parity slice and applicable
   quality criteria next; do not ask the settled selection questions again.
3. **Quality and composition.** Agree the admission bar, first subsystem coverage, portability,
   performance/ownership contracts, host adapter rules and the agent's usable context package.
   Establish infra-vr's role, dependency pins and the first selected library's integration slice.
4. **Orchestrator — scope, lifecycle, priority and root association answered.** macOS/Windows from the start,
   adapters first, Quest 2D-first, and tree/previews/basic editor with optional Vim mode are
   confirmed, as are retained sessions, session browser and desktop-first execution with a live flat
   game tab. Multiple project/worktree roots share a workspace with explicitly bound sessions.
   NOLF is the first game; editor recovery uses local drafts with explicit saves.
   Next resolve the concrete host baseline, editor/Vim details and
   later agent recipes/Windows Bash setup; do not repeat settled questions.
   The specification is `002-orchestrator.md`.
5. **Operational model.** Set resource/time budgets, hardware verification ownership, unattended
   authority and concurrent-work coordination. Distinguish terminal sessions from bounded check jobs.
6. **AI/training boundary.** Decide whether first-class agent support means development tooling,
   training feedback, in-game AI, or some combination; define what may leave a game workspace.
7. **Scope and commitment.** Review feature proposals, exclusions, milestone order, evidence
   requirements, and the point where an unsuccessful extraction should stop.

## Questions to challenge before freezing the roadmap

- What would be measurably easier in the games after the first milestone?
- What do we provide beyond linking an agent to a library's existing documentation?
- Which composition problems should an agent solve locally, and which should we solve once?
- If only one game needs a component, what justifies maintaining it here?
- Can an engine decline a new rEngine version and still ship?
- Does the adoption record prove the selected capability and its claimed game/platform scope?
- Do we need new shared code, or would packaging the existing code solve the problem?
- What evidence would make us reject an abstraction and keep the code local?
- How much game progress can this foundation effort consume before it must show value?

Record subsequent answers here with their source, date, and which proposal they confirm or
replace. Do not infer approval from silence or from a generated review artifact.

## Revision record

2026-09-05, owner answer 1: shifted the draft's primary path from shared command tooling to
library quality, curation and real game adoption. Proposed IDs remain traceable, but their
milestones/priorities/dependencies are revised while the inventory is unapproved. No accepted
feature history or completion evidence is changed.

2026-09-05, subsequent owner answer: confirmed D08/D09 and added the orchestrator scope D10–D12.
The new IDE branch explicitly supersedes the earlier editor deferral. Preserve the library proof
as an independent deliverable; the relative implementation priority of IDE and library work is
still to be decided.

2026-09-05, platform/surface and editing answers: recorded D13–D17. Researched official Quest
2D/PWA/Spatial SDK paths, native Operator, Windows window parenting/capture and macOS capture.
Evidence supports candidate architectures, not a tested port, universal embedding or distribution
approval. 2D-first Quest and basic built-in editing supersede the earlier pending recommendations.

2026-09-05, lifecycle/order answer: D18/D19 require an independent session owner, a session
browser and a first desktop slice that includes actual flat game output. Library adoption remains
independent of IDE completion, but implementation starts with the desktop workflow.

2026-09-05, project-scope answer: D20 confirms multiple roots with explicit per-session binding.
It does not approve the whole feature inventory, select a toolkit or select the named library.

2026-09-05, first-game/editor answer: D21 selects NOLF then VtMB; D22 selects local recovery
drafts with explicit working-file saves. The desktop acceptance draft is `032-desktop-v0.md`.
The exact host revisions, toolkit and measurement budgets remain unselected; D23 below settles
the named library.

2026-09-05, library/adoption answer: D23 selects iklib. D24 sets verified pinned capability
adoption as the powered-by minimum, with optional IDE/shared harness. The “GO” answers those two
presented recommendations; the complete feature proposal still needs concrete roadmap review.

2026-09-06, rendering answer: D29–D30 select full GPU rendering with OpenGL, Metal and Vulkan
adapters and name the renderer a future approved-library candidate. This supersedes the roadmap's
blanket “no new renderer” deferral for the workspace only; games keep their own renderers. The
design source is the Claude Design project pulled into `design/`; requirements, architecture and
phases are in `066-gpu-rendering.md`.

2026-09-06, renderer inventory corrections (owner decisions during the F58 interview, spec 072):
F56's dependencies on F34 and F42 were removed because they were qualification gates rather than
code the draw-list contract needs, and no desktop feature passes yet; F57's criteria and
description narrow to macOS while the new F62 carries the Windows OpenGL evidence that KI-014
still blocks; F56 and F57 are marked passing on their recorded macOS evidence. The two-desktop
requirement is unchanged: it is tracked by F62 and KI-014 instead of hiding finished work.

2026-09-06, Vulkan interview (spec 073): D31 names the Windows verification host and authorizes
the commits-only transfer KI-014 was blocked on; D32 sets the Vulkan floor at the Quest 3 maximum,
researched as 1.3. The open “first Vulkan platform” question is answered: Windows carries the
criterion, macOS through MoltenVK is the development and evidence path. The OpenGL floor question
stays open.

2026-09-06, Vulkan memory ceiling on Windows (owner decision after the F59 Windows run, spec 073):
spec 068 decision 6 is amended to a 64 MiB resident-memory delta for Vulkan on Windows, because the
NVIDIA Vulkan driver's process baseline sits about 30 MiB above OpenGL's on the same driver DLL while
the adapter's own allocations were trimmed and the same adapter sits below SDL on macOS; every other
backend and platform keeps 32 MiB. The Windows default still flips to Vulkan only once F62's suite
passes there (decision 8).

2026-09-06, design update interview (spec 076): D33 answers spec 066's open control-layer question
with owned additions over pristine microui, and D34 sets the reach and trust of theme files. The
remaining open questions from spec 066 are answered there too: icons are pinned Bootstrap Icons
rasterised as a third face, the UI face is bundled Inter in three weights, and the hue gradient
becomes a draw-list primitive (list version 2) rather than a texture, at the owner's decision
against the recommendation. F60 narrows to the foundations plus toolbar, tab strip and status bar;
F67 takes the views, F68 the menus, theme panel and theme files, F69 the Windows card evidence.
F60's dependencies on F37 and F54 move to F67 with the surfaces they describe; F60 keeps F57.
The two-desktop requirement is unchanged: it is tracked by F69 and KI-038.

2026-09-06, settings interview (spec 080): the explorer's nested-versus-flat behaviour becomes an
explicit setting rather than an automatic threshold, replacing the answer given one round earlier;
settings live in their own popover opened from the toolbar; F68's theme panel is dropped, so the
popover is the only appearance surface and theme files are imported and exported from it. Both are
accepted-criteria corrections, recorded on F68 and F73, and F73 now depends on F68 because the
toggle needs the surface. The single-overlay rule of spec 066 is unchanged: one overlay at a time.

