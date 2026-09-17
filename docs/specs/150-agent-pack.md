# Spec 150 — the agent pack: our fork, one model, and a phone that serves a headset

Owner request, 2026-09-17: *"let's begin the work on agent lib pack, note that it will have separate
repository, will be integrated as git submodule and will be based on llama.cpp fork (we need to
research on modern quantization that preserves both space and resources while retaining quality and
performance) also research on the possibility to unload it with a companion app to another local
machine or even smartphone"*.

This carries out **D68** and revises **spec 139 decision 1**. Charter rows: **D72** (the fork and the
pack's placement) and **D73** (a device borrowing a model from the device beside it).

Status: **design; nothing implemented.** Rows F201–F209 and F224–F227.

## What the codebase already decided

Not re-opened here, and not re-described:

- **The engine is C behind a C ABI, and the FFI direction is Rust-imports-C** (D67, D68). `red-model`
  is the Rust host; the C desktop links the same library. One implementation, two hosts — now three.
- **Weights are declared per machine by path and digest, verified, never fetched** (D68 decision 7).
- **Remote is red-link. No new wire contract** (D68 decision 3); red.v1 gains *the models a peer serves*.
- **The turn loop is C** with a host-supplied tool vtable (spec 139 decision 4), so every host runs one loop.
- **Discovery on a LAN is mDNS, identity is Ed25519 with QR pairing** (D58).
- **A pack is one pinned versioned artifact with declared facets** (D39), and `packs/gpu` is the
  worked example in this tree: a manifest, `include/`, `src/`, `examples/`, its own CMake, a `pin`.
- **Adapters are consumed, never trained**, and the first in-game version carries none (D69, spec 139
  decision 9). The training project's F30 gate is not ours to move.

## The research, and the two findings that changed the design

### Quantization: the lever is the checkpoint, not the quant

The largest available win is not choosing a cleverer generic quantization — it is consuming a
**quantization-aware-trained** checkpoint where the vendor ships one. Gemma 4 QAT, measured against
its own bf16:

| | quantized | original | top-1 retained |
|---|---|---|---|
| E2B | 2.62 GB | 9.31 GB | 98.16% |
| 26B-A4B | 14.2 GB | 50.5 GB | 85.63% |
| 31B | 17.29 GB | 61.4 GB | 96.67% |

**And a trap that lands squarely on "declared by digest".** Naively converting the QAT Q4_0
checkpoint to Q4_0 in llama.cpp *destroys most of the benefit*: llama.cpp stores F16 block scales
where QAT trained BF16 scales, giving 24.77% byte-exactness and **70.2%** top-1 on 26B-A4B against
**85.6%** for a correctly-derived `UD-Q4_K_XL`. For a QAT checkpoint, *higher*-precision quants score
*worse*. So two files of the same model, both digest-verified, can be fifteen points apart — a digest
proves a file is the one you meant and says nothing about whether it was made correctly. **The
declaration therefore records which quantization a file is and what measured it**, not only its hash.

For models with no QAT checkpoint: an importance matrix dominates at ≤3 bits; `Q4_K_M` is the safe
default; `IQ4_XS` is ~0.4 bpw smaller at near-identical perplexity, slower on prompt processing, and
only as good as its imatrix. A January 2026 unified evaluation of thirteen GGUF types on
Llama-3.1-8B puts `Q4_K_S` and `Q5_0` on the Pareto front and finds GSM8K by far the most
quantization-sensitive task — `Q3_K_S` loses 9.3 points there against 1 point on HellaSwag. That
study tested no imatrix, no I-quants, no GPU and no ARM, which is precisely this deployment, so it
sets expectations rather than the choice. New in llama.cpp during 2026: MXFP4, ternary `TQ1_0`/`TQ2_0`,
`Q1_0`, and tensor parallelism.

### Devices: the floor, and the format that is not portable

| target | what fits | measured |
|---|---|---|
| iPhone 15 Pro Max (8 GB) | **3–4B class at 4 bits** | iOS caps a foreground app well below installed RAM; `increased-memory-limit` / extended virtual addressing lift it |
| iPhone 17 Pro (12 GB) | 7–8B class | 40+ tok/s on small models; ~9 tok/s on a 7–8B Q4_K |
| Android floor | 1–3B at `Q4_K_M` on 6 GB; **12 GB+** for comfort | Snapdragon 8 Elite ≈ 10 tok/s on a 3B, CPU |
| Snapdragon Hexagon NPU | ~**3.5 GB virtual address space per session**, acts as a GPU device for `-ngl` | 1B `Q4_0`: 169 tok/s prompt, **51.5 tok/s** generation |
| every phone | — | **thermals, not RAM, are the sustained-inference ceiling** |

The answer to *"should an iPhone 15 Pro Max suffice"* is **yes, for a 4B-class model — not an 8B.**

The finding that shaped a decision: **the fastest path on Android wants a different file from the
best path on a desktop.** The Hexagon NPU publishes `Q4_0`/`Q8_0`; the best-quality artifact is a
K-quant. One file across devices means picking a side, and that side sets the floor.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **The engine is `llama_r.cpp`, our fork of upstream llama.cpp**, a separate repository pinned as a submodule at `third_party/llama_r.cpp`. The base is upstream rather than an existing fork: `ik_llama.cpp` states that CPU and CUDA are the only fully supported backends and asks that Metal issues not be filed, and was last synced with upstream in August 2024 — while Metal is macOS's path and iOS's only GPU path. Specific ik kernels or quant types may be **cherry-picked with a recorded reason per commit**. | Owner, 2026-09-17, choosing "fork upstream, cherry-pick from ik_llama" after the measurement |
| 2 | **This revises spec 139 decision 1.** "Pinned release archive plus SHA-256 at first configure" is replaced by the submodule pin, which git verifies. F201's description and its first acceptance criterion are amended with this rationale; its other five criteria are untouched. | Owner decision, 2026-09-17, as AGENTS.md requires for an accepted row |
| 3 | **The pack is `packs/agent/` in this tree**, beside `packs/gpu` and following it: `rengine-agent`, alias `rengine::agent`, a manifest with a `library` facet. It holds the C engine over the fork, the C turn loop, and **one host file per platform**. The Rust host `red-model` stays in `red/`, because D57 keeps server and network components in the cargo workspace. | Owner, 2026-09-17: the pack "is in `packs` directory and used the llama.cpp at third_party dir" |
| 4 | **The pack carries the per-platform host layer, not an application.** A host owns what inference actually needs from a platform: process and memory ownership, the iOS memory entitlement, thermal backoff, lifecycle. A thin harness app exists to run it standalone. `apps/companion/` stays the shipped app (D58 unchanged) and links the pack. This is the `editor/render/seam_host.h` pattern: one source, one host file per platform. | Recommended, confirmed |
| 5 | **A phone or a Windows PC serves an inference endpoint to a device that cannot host a model** — first case: a game on a Quest whose memory is spent on rendering. The consumer reaches it through **red-core's C ABI over red-link**, discovered by the mDNS path D58 declares, identified by its Ed25519 pairing, over red.v1 gaining *the models a peer serves*. A game links a static library and calls C; the only thing crossing the network is Rust, so D57 stands. | Owner, 2026-09-17: *"the game runs on quest with no headspace for llm - we need to install companion app that will provide the inference endpoint"* |
| 6 | **Rejected: a plain HTTP endpoint on the phone.** D68 already refused this shape for the second machine, and the reasons are unchanged: a second wire contract beside red.v1, and an unauthenticated listener on a person's phone on whatever network they are on. Recorded because it is the tempting one — any engine can call HTTP with no Rust and no pairing. | D68 applied |
| 7 | **One model file serves every host.** The floor rises by choosing a larger model, never by shipping a per-host artifact. The first model is **Gemma 4 E2B QAT (~2.62 GB, 98.16% top-1)**, which is comfortable on an 8 GB iPhone and 8 GB Android with headroom on a desktop; **E4B (~5 GB) is the named first escalation** and raises the Android floor to 12 GB and requires the iOS entitlement. | Owner, 2026-09-17: "we will start from one model across devices, if its response quality is unsatisfactory - we will try with more powerful model and raise the minimum system requirements" |
| 8 | **Decision 7 costs the Hexagon NPU, and that is recorded rather than discovered.** A K-quant file cannot run on the NPU, so Android runs on CPU or OpenCL at roughly a fifth of the NPU's generation rate. The trade is deliberate: one artifact that is correct everywhere, over a faster path on one vendor's silicon. Revisiting it means either a second artifact or a `Q4_0` floor for everyone. | Derived from decision 7; the measurement is in this spec |
| 9 | **A model declaration records its quantization and the measurement behind it**, not only its path and digest — because the QAT/Q4_0 result shows two correctly-digested files of one model differing by fifteen points. This extends F202's schema before it is built. | Recommended from the research, confirmed by decision 7's premise |
| 10 | **In-process hosting on the Quest is deferred** until a game asks. Offload targets first: a phone, then a Windows PC. | Owner, 2026-09-17: "first we offload to phone or windows PC" |

## What this does not do

- It does not train, export training data, or produce an adapter. rEngine consumes; F30 is not ours.
- It does not ship weights. The first model is *named*, not vendored (D68 decision 7 is unchanged).
- It does not claim "approved" or "powered by" — a game's adoption and the owner's sign-off do that
  (D24, D44b, D45), and F209's guard already fails a manifest that claims it.
- It does not give the Quest an in-process host, or the phone a second model artifact.
- It does not settle the D67-versus-spec-128 tension ("Rust imports C" against "C drives, Rust
  serves"), which spec 139 already recorded as pre-existing and out of its scope. Decision 5 sits on
  the C-calls-Rust side for the game consumer, which is spec 128's direction, and this is the second
  place that tension has surfaced — it now has two call sites and still no decision.

## Prerequisites that are not this spec's to satisfy

- **Offloading to a Windows PC is blocked behind F223.** `red/` does not compile on Windows — 62
  `cfg(unix)` blocks against 1 `cfg(windows)` — so the Windows half of decision 10 cannot be built
  before that row closes.
- **An adapter cannot exist** before the training project's F30 gate. F208 stays blocked, not failing.
- **Whether Corrosion can consume a CMake-built C static library into a cargo crate under cmkr** is
  still unproven (spec 139); F203 opens with that spike.
- **Whether `common`'s tool-call parser handles Gemma 4** is a bounded check against the fork before
  F204 is scheduled.

## Sources

The measurements above are external and dated 2026; they are recorded here because the decisions rest
on them.

- Unsloth, *Gemma 4 QAT* — sizes, retained accuracy, and the Q4_0 conversion result:
  <https://unsloth.ai/docs/models/gemma-4/qat>
- *Which Quantization Should I Use? A Unified Evaluation of llama.cpp Quantization on
  Llama-3.1-8B-Instruct* (arXiv 2601.14277) — the thirteen-type Pareto study and GSM8K sensitivity.
- llama.cpp, `docs/backend/snapdragon/README.md` — Hexagon NPU sessions, the ~3.5 GB address space,
  and the Q4_0 throughput figures.
- ikawrakow/ik_llama.cpp — the backend-support statement and the August 2024 upstream sync.
