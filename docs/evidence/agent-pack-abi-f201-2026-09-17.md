# F201 — `rengine::agent`, the C ABI over the engine (2026-09-17)

Charter D67/D68/D72, specs 139 and 150. **The row does not close.** Three of its six criteria need a
generative model on this machine and there is none; they SKIP, naming the prerequisite, which is what
the row was written to do. What follows separates what was proven from what was not.

## What exists

`packs/agent/`, beside `packs/gpu` and following it: `pack.json`, a hand-written standalone
`CMakeLists.txt`, `include/rengine/model.h`, `src/model.cpp`, `src/sha256.{c,h}`, `tests/model_test.c`.
Target `rengine_agent`, alias `rengine::agent`.

The ABI: open a model declared by path **and digest**, attach an adapter (refused by name in this
build), run one turn with an optional GBNF grammar, stream tokens, cancel, report identity and
counters, and digest a file so a person can write a declaration.

**The pack does not vendor the engine.** A consumer points `RENGINE_AGENT_ENGINE_DIR` at
`llama_r.cpp` and the pack configures it — static, `LLAMA_BUILD_COMMON` on, every binary off, and the
two network-reaching options forced off. That configuration moved *into the pack* during this work:
it had been in rEngine's root build only, which meant any other consumer of the pack would have got a
differently-configured engine. Standalone it was building a **shared** `libllama.dylib` against spec
139's `BUILD_SHARED_LIBS=OFF`; it builds `libllama.a` now.

## Proven

`npm run test:agent` configures `packs/agent` **as its own top-level project**, which is also how the
"standalone by construction" claim stops being an assertion:

```
1/2 Test #1: rengine_agent_digest .............   Passed
2/2 Test #2: rengine_agent_turn ...............***Skipped
```

`rengine_agent_digest`, nine assertions, all green:

- a file's digest is readable, and it is the SHA-256 the standard says it is (the FIPS 180-4 vector
  for `"abc"`, so the check tests the implementation and not only itself);
- a declaration with **no** digest is refused, and the refusal names what is missing;
- a file that does not match its declaration is refused **before it is loaded**, and the refusal
  shows both the declared and the found digest;
- a malformed digest is refused as malformed rather than as a mismatch;
- a missing file is refused as a missing file;
- nothing was opened by any of the refusals.

The SHA-256 is this pack's own, because the engine's copy lives under the tool binaries this build
does not compile. It was checked against all four FIPS 180-4 vectors including the 1,000,000-`a`
multi-block case, and then against `shasum -a 256` on a real 7.8 MB file — same digest.

**The engine really loads through the ABI.** Against a declared vocab-only GGUF:

```
opened:  | vocab 128256 | trained ctx 0 | load 768 ms | resident +73.7 MiB
run on a vocab-only model: refused by name
```

(`description` and `n_ctx_train` are empty for a vocab-only load, which is the engine having no
architecture metadata to report, not a defect. A turn on such a model is refused by name.)

## Observed failing for its own reason

Two sabotages, each **recompiled** before its run:

| sabotage | result |
|---|---|
| the digest comparison removed | exactly two assertions went red — *"refused BEFORE it is loaded"* and *"shows both digests"* — everything else stayed green |
| the requirement that a declaration carry a digest removed | **SIGSEGV**: with the guard gone, a NULL `sha256` reaches `strcmp`. The guard is load-bearing, not decorative |

**And the restore itself was caught not compiling.** `cp` followed immediately by `cmake --build`
landed in the same filesystem timestamp tick, make skipped the rebuild, and the next three runs
judged the *sabotaged* binary — a crash I spent time explaining before noticing the object file was
older than nothing. This is KI-120 in reverse: the rule says rebuild between the sabotage and the
run, and it applies just as much to the restore. `touch` then rebuild, and 9/9 returned.

## Not proven, and why

| criterion | state |
|---|---|
| 2 — identical tokens at temperature 0 across two runs | **SKIPPED.** No generative model is declared on this machine. The assertion is written and runs the moment one is. |
| 3 — cancel returns within one token | **NOT OBSERVED.** Implemented (the flag is read before the sample, so a cancel costs at most the token in flight) and asserted in `turn` mode, which skips. |
| 5 — load, resident and throughput recorded | **PARTIAL.** Load 768 ms and resident +73.7 MiB are measured, but for a *vocab-only* model — no weights, so the figures say nothing about a real load. Tokens per second is not measured at all. |

All three want one thing: **a small generative GGUF declared on this machine.** rEngine never
downloads weights (D68 decision 7), so this is a prerequisite in the same class as SDL2 —

```
RENGINE_AGENT_FIXTURE=<path to a small GGUF>
RENGINE_AGENT_FIXTURE_SHA256=<its digest>
```

The only GGUFs here are `~/llama.cpp/models/ggml-vocab-*.gguf`, which are tokenizers with no weights
and cannot generate a token. A fixture should be small — tens of megabytes — because the check is
determinism and cancellation, not quality.

## Criteria 1, 4 and 6

1 and 6 were established under F224 and re-verified after the build was restructured: zero engine
targets in the default build, every engine target a library, and an uninitialised submodule refused
by name with the init command (`exit 1`). 4 is the digest refusal above.

## Environment

macOS 15 (Darwin 24.6.0), Apple Silicon, AppleClang 17, engine `0.4.1-dev` from `llama_r.cpp` `red`.
Not measured: Linux, Windows (F223), any device, any GPU offload path.
