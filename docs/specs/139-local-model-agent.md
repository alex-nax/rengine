# Spec 139 — a local model in the editor: one C engine, two hosts

Owner request, 2026-09-15: *"we will need to implement the lightweight agent(using llama.cpp or its
forks) to drive both development(delegating hard tasks to cli agents via transport) and future game
engine integration(+ lora adapter) to become the new approved engine pack"*.

Placement, same day: *"it can be either in-process in a C app, or if we want to offload it to another
machine - then it is also a C app but communicating via network"*. Language: **D67**.

Status: **design; nothing implemented.** Rows F201–F209.

## What the codebase already decided

- **The transport is ACP** (D46) and the session kind is **F114** — the same one spec 138 uses. This
  agent is one more recipe, not a second mechanism.
- **The tool surface exists once**: red-mcp's captured `tools.json` and `tools::call`, already
  forwarded over red-link (F185). It is not re-described here.
- **Delegation exists**: `task_add`, `task_decompose` and `spawn_agent` behind the project token
  (spec 103), with the feed as the return channel.
- **The seam pattern is the shape**: one source with one host file per platform
  (`orchestrator/native/render/seam_host.h`); the companion proves a second binary from the same
  modules.
- **Weights are prerequisites, not sources** — the SDL2/protoc rule: checked for, installed by the
  owner, never fetched silently.
- **Training is not ours**: `~/vr-port-agent-training` F30 is the sole gate before any adapter
  exists, and `AGENTS.md` says recording a run authorises no training, export or model creation.

## Where the turn runs, and why it is not literally in the window

The owner's answer allowed in-process. Measured facts argued for a refinement, and the owner chose
it:

- The desktop's resident-memory ceiling is **32 MiB above the SDL baseline** (spec 068 decision 6).
  The GGUFs on this machine are 1.1–5.2 GiB. Linking a model into the window process is two orders
  of magnitude outside every budget the desktop has recorded.
- **Sessions, drafts and agents belong to the retained session host; the window does not hold work**
  (spec 105, architecture constraint 11, D18). A turn running inside the window dies with the window.

So the agent's turn runs in a Rust host that imports the C engine, **and the desktop links the same
C engine** only for small-model editor-local completion, measured against spec 068 as its own row
(F207). One implementation, two hosts — not two implementations.

## The D57 question, answered

The engine **opens no socket in either deployment**. Locally the desktop already talks to its host
over loopback only, and the C client rejects non-loopback service addresses by design. Remotely,
`red-model` sits behind that machine's `red-link`, which already carries the read surface, the feed,
the lifecycle ring and `tools/call` over libp2p. **The only thing crossing a machine boundary is
Rust.** So the owner's "a C app communicating via network" is honoured as: the C engine inside a
Rust host, the network being the Rust host's. D57 stands unchanged.

The rejected alternative is recorded because it is the tempting one: a standalone C executable with
its own listener on the second machine would be the first non-loopback C listener in the tree and a
second wire contract beside red.v1.

**A tension this creates, recorded rather than discovered later:** D67's "Rust imports C, never the
reverse" is the opposite direction from spec 128 decision 7 ("C drives; Rust serves") for the
companion. That is pre-existing and outside this spec's scope; it needs settling on its own.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **`re_model` is a C library with a C ABI** over pinned llama.cpp (release archive plus SHA-256 at first configure, `BUILD_SHARED_LIBS=OFF`, Metal on macOS, no server/tools/examples binaries), with `common` linked behind the ABI for chat templates and tool-call parsing. Its ABI: open a declared model, attach declared adapters, run one turn with a grammar, stream tokens, cancel, report identity and counters. | D67 |
| 2 | **Two hosts, one implementation.** The Rust service `red-model` imports it over FFI and is where the agent's turn runs, locally and offloaded. The C desktop links the same library for editor-local completion only. | Owner, 2026-09-15, choosing "Rust host imports the C engine" |
| 3 | **Remote is red-link.** No new wire contract; red.v1 gains "the models a peer serves". Weights never cross the link. | D57, D58, D67 |
| 4 | **The turn loop is C** (`re_agent`) inside the library, with a host-supplied vtable for tools, so both hosts run one loop. | D67 FFI direction |
| 5 | **Tools through one route**: `POST /api/tools/call` on red-host with red-mcp linked as a library, **agent identity explicit** — because the token ledger never gates the person at the desktop, so a loop calling routes *as the desktop* would bypass the serialiser spec 103 exists for. | Recommended; sabotage-checked in F204 |
| 6 | **Delegation is the existing gesture**: hold the token, file the task, spawn the chosen CLI on it, watch `agent.spawned` and `task.updated` and the row. It never types into a pane. Policy lives in `.rengine/prompts/delegate.md` with a shipped default. | Spec 103 applied |
| 7 | **Weights and adapters are declared per machine** in the workspace state directory by path and SHA-256, verified by a guided action, never downloaded by rEngine; an adapter names its base digest and is refused on mismatch. | D43 and D63 precedents |
| 8 | **The pack is the engine library** with a `library` facet (`rengine::model`) and a measured quality record. **"Approved" and "powered by" are not claimed** until a game adopts it and the owner signs off. | Owner, 2026-09-15, choosing "Build the library, defer the claim" |
| 9 | **In-game inference is the first integration target, and its first version carries no adapter** — a base model only, which needs no trainer gate and unblocks the whole path. An adapter of either domain can exist only after `vr-port-agent-training` F30's GO; in-game adaptation comes then, and integration-knowledge adaptation after it. | Owner, 2026-09-15: *"First in-game inference, then after F30 is green we'll go there too"*, confirmed: *"First version of in game inference will not have adapter but later will"* |

## What this does not do

- It does not choose a model, and ships no weights.
- It does not train, export training data, or touch held-out material. rEngine consumes an adapter;
  it never produces one.
- It does not claim "approved" or "powered by" for anything.
- It does not hold the agent's turn in the desktop process.
- It does not claim Windows: KI-038 is open and Metal is the only GPU path with evidence here.

## Prerequisites that are not rEngine's to satisfy

- **An adapter cannot exist** until `~/vr-port-agent-training` F30 — *"Pass the explicit human
  LoRA-readiness review; no adapter creation begins before this gate is green"* — is green. It is at
  21 of 30 rows. F208 is therefore **blocked, not failing**, and says so.
- Whether Corrosion can consume a CMake-built C static library into a cargo crate under cmkr is
  unproven here. F203 opens with a spike before it is scheduled.
- Whether `common`'s tool-call parser handles the model family on disk is a ten-minute check
  against the existing `~/llama.cpp` build, to be done before F204 is scheduled.
