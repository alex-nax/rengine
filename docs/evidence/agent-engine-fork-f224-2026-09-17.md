# F224 — the engine fork, measured (2026-09-17)

Charter D72, spec 150. What was done, what was observed, and the one thing that turned out not to be
true.

## The fork

`llama_r.cpp` — <https://github.com/alex-nax/llama_r.cpp>, created as a GitHub fork of
`ggml-org/llama.cpp` so its history is upstream's rather than a copy.

| branch | commit | what it is |
|---|---|---|
| `master` | upstream's | untouched, never committed to |
| `red` | `29cf3dcb2` | **what this repository pins**, default branch |

`red` is based on the **release tag `v0.4.0`**, not on `master`: upstream merges continuously and a
fork that tracks a moving branch cannot say what it is. Three commits on top of it:

| commit | kind | what |
|---|---|---|
| `e2788fcad` | port | `FORK.md` — branches, upstream state, and the rule that every non-merge commit names itself a fix, a port or a cherry-pick |
| `f0c5e165c` | merge | upstream `v0.4.1` (released 2026-09-14), 155 commits, no conflicts |
| `29cf3dcb2` | port | the cherry-pick measurement below, correcting `FORK.md` |

**The merge is criterion 5** — the policy exercised rather than only written. `FORK.md`'s upstream
table was written first saying *"nothing yet; v0.4.0 is the base"*, which was true at that commit, and
moved to `v0.4.1` **inside the merge commit**, which is what its own rule asks. The first draft had
the table claiming the merge before it happened; that was corrected before pushing, because a record
that is approximately true is the kind this rule exists to prevent.

## Criterion 1: a cherry-pick from another derivative — and the assumption that was wrong

The criterion says *"the fork's history is upstream llama.cpp's, so a cherry-pick from another fork of
the same history applies as an ordinary git operation"*. **The operation works. The reason given for
it does not.**

```
$ git merge-base red ik/main
$ echo $?
1
```

There is **no merge base**. `ik_llama.cpp` and `llama.cpp` have **disjoint histories**: both begin
with commits named *"Initial release"* and *"Create README.md"*, at different object ids
(`4b5b86d6e`/`b2a7bb3e1` against `26c084662`/`775328064`). That repository is a **re-committed copy**
of llama.cpp, not a git fork of it.

The cherry-pick works anyway, because it never needed shared ancestry — it diffs a commit against its
own parent and three-way merges the result onto `HEAD`:

```
$ git cherry-pick -n 4b0afb3e7          # ik_llama.cpp, "Simdify sigmoid evaluations (#2457)"
Auto-merging ggml/src/ggml.c
CONFLICT (content): Merge conflict in ggml/src/ggml.c
```

Two ordinary content conflicts in `ggml/src/ggml.c`, a file both trees still have. An ordinary
operation with an ordinary conflict. **The change was not kept** — `FORK.md` requires a reason per
cherry-pick and no measurement justifies carrying that one; this was a demonstration and was reset.

Two further facts recorded while measuring:

- **Their file layout has moved.** `src/llama-build-context.cpp` and everything under
  `ggml/src/iqk/` have no counterpart in the upstream tree, so a cherry-pick touching those is not a
  merge conflict but a port.
- **`ik_llama.cpp` is actively maintained in 2026** — Gemma 4, Qwen4 and LFM2.5 support land there.
  "Last synced with upstream in August 2024" is about the direction *from* upstream, not about the
  project being dormant. Both statements are true and they are not the same statement.

**This is the criterion's wording, not its substance**: the demonstration it asks for was performed
and succeeded. The clause *"of the same history"* is false and should be reworded — flagged for the
owner rather than edited, because criteria are accepted text.

## Criterion 2: builds from the submodule, refuses when it is not there

The engine is behind `RENGINE_BUILD_MODEL_ENGINE`, **default OFF**. Nothing links it yet, and putting
minutes of engine compilation on a desktop inner loop that is currently seconds would be paid by
everyone for the benefit of no one. F201 is what turns it on for real.

```
$ cmake -S . -B build                                   # the default
engine targets in the build: 0

$ cmake -S . -B build -DRENGINE_BUILD_MODEL_ENGINE=ON
-- Metal framework found
-- Including METAL backend
-- Configuring done (25.1s)

$ cmake --build build --target llama llama-common -j8
[100%] Built target llama-common                         # 23s wall
```

Static libraries only: `libllama.a`, `libllama-common.a`, `libllama-common-base.a`, `libggml.a`,
`libggml-base.a`, `libggml-cpu.a`, `libggml-metal.a`, `libggml-blas.a`.

**The refusal**, observed by moving the submodule's `CMakeLists.txt` aside:

```
CMake Error at CMakeLists.txt:113 (message):
  third_party/llama_r.cpp is not initialised.  Run:

  	 git submodule update --init --recursive third_party/llama_r.cpp

$ echo $?
1
```

**"Fetches nothing at configure time", stated precisely.** Two download lines appear in the configure
output and neither is the engine's — they are `[cmkr] Fetching cmkr...` and its clone of the pinned
`v0.2.46` bootstrap into the build directory, which is this repository's own documented behaviour and
predates this row. The engine's two network-reaching options are forced off rather than left to their
defaults: `LLAMA_LLGUIDANCE` (an `ExternalProject_Add` that git-clones and cargo-builds a dependency)
and `LLAMA_USE_PREBUILT_UI` (*"use prebuilt UI from HF Bucket when available"*, which defaults **ON**
upstream). Those two are the reason the option list in `cmake.toml` is written out rather than
inherited.

## Criterion 4: no server, example or tool binary

Every engine target in the configured build is a library:

```
ggml  ggml-base  ggml-blas  ggml-cpu  ggml-metal  llama  llama-common  llama-common-base
```

`LLAMA_BUILD_TESTS`, `_TOOLS`, `_EXAMPLES`, `_SERVER`, `_APP` and `_UI` are all forced `OFF`. Most
already default to `LLAMA_STANDALONE`, which is off in a sub-build — but a default that happens to be
right today is not a decision, and this list is what somebody reads when they wonder where the server
binary went.

Two targets matching `server` do exist in the build (`servers`, `curl-example-http2-serverpush`).
**They are curl's, not the engine's**, and they predate this row.

## Environment

macOS 15 (Darwin 24.6.0), Apple Silicon, CMake with the pinned cmkr v0.2.46, Metal backend enabled.
Not measured here: Linux, Windows (`red/` does not compile there — F223), or any device.
