# The pack manifest: contract 9 `packs` and its facets

Date: 2026-09-07. Status: **implemented; declaration only.** Feature F109.
Owner decisions: charter **D39** (a pack is one pinned, versioned artifact whose manifest declares
facets), **D24 clarified** ("Powered by rEngine" is earned on the library facet), with **D01/D08/D09**
(curate and author), **D23** (iklib first), **D30** (the renderer is a candidate curated library) and
**D33** (owned microui control additions join the library packs) as the things the format has to fit.
The interview that settled them is [spec 105](105-packs-editions-and-the-name.md).

This spec implements D39 as written. Where I think D39 will cost something, it says so at the end and
implements it anyway.

## What this adds, and what it deliberately does not

Contract 9 adds one optional block to the project declaration, `packs`. It is the eleventh block
across the nine contracts and it arrives the way the other ten did: a schema block, a `SECTIONS`
entry with a minimum contract, and a rules function. Nothing else in the declaration changes, and a
declaration that does not name `packs` reads exactly as it does today.

A pack is **declared**, not acquired. KI-008 (licence, distribution, packaging) is open, and the
boundary in `AGENTS.md` forbids hidden downloads, so **where a pack's bytes come from is out of scope
here and is not encoded anywhere in this block**. The manifest names an artifact and pins it; it
contains no URL, no registry, no fetch command, and the reader never creates, downloads, unpacks or
verifies a file. Concretely, out of scope and named so nobody has to guess:

| Out of scope | Where it belongs |
| --- | --- |
| Acquiring a pack's bytes; any URL, registry or fetch step | KI-008; spec 105 open question 2 |
| Loading a `plugin` module into the desktop, and the registration surface it links against | D38's own implementation spec; spec 105 open question 1 |
| What the `abi` string *means* — this spec validates its shape and never reads it | the plugin-ABI lane |
| Editions: a bundle of packs over one binary | D40; spec 105 open question 3 |
| Per-platform module selection (`.dylib` / `.dll`) | spec 105 open question 4, with KI-038 open |
| Checking that a declared path exists, or that a revision matches the bytes on disk | acquisition, above; see "A pin declared is not a pin verified" |

## The block

`packs` is an array of 1–32 pack entries. One list, not two, because D39 makes a pack one concept: a
declaration says which packs this project stands on, and each entry's facets say on which side of the
build/run boundary it stands there.

| Key | Required | Meaning |
| --- | --- | --- |
| `name` | yes | `^[a-z][a-z0-9-]{0,63}$`. The word people say — `iklib`, `rengine-render`. Unique within the declaration. |
| `pin` | yes | `{ version, revision }`. See below; this is the part of the design that had a choice in it. |
| `library` | one of the two | `{ path, target }`: source a game consumes at **build** time through CMake. |
| `plugin` | one of the two | `{ module, abi }`: a module the editor loads at **run** time. |
| ~~`poweredBy`~~ | — | **Removed by charter D45 on 2026-09-08** ([spec 112](112-poweredby-removed.md)): an adoption is recorded by the owner's sign-off in a spec, never claimed in a declaration. The key is refused by name on either facet. The rows below describing it record what shipped for one day. |

A pack declaring neither facet is refused: an artifact with no facet is a name and a version with
nothing on the other end of them.

### The pin, which is the heart of it

**A pin is two strings: a `version` that is said and a `revision` that is checked.** Both are
required.

```json
"pin": { "version": "0.4.0", "revision": "9f1c0b2a7d5e4c3b8a06f2d1e9c7b5a4302f1e8d" }
```

- `version` is a bounded human string (`^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`). It is what a changelog,
  a powered-by record and a future edition manifest quote. rEngine does not parse it and does not
  order it: semver is a convention a pack may follow, not a rule this contract imposes.
- `revision` is an immutable content identity: 40 or 64 lowercase hex characters — a git SHA-1 or
  SHA-256 object id, or a SHA-256 digest of the artifact for a pack that is not a git tree. Which of
  those it is, is not the manifest's business; the shape is, and the shape is what is enforced.

Why both, rather than one:

- **A version alone is a claim, not a pin.** Tags move, `0.4.0` is re-cut, and two machines that both
  say `0.4.0` can hold different bytes. D24 requires "a pinned version"; a string that can be
  re-pointed does not pin anything, and an integration check passed against one `0.4.0` says nothing
  about another. Spec 001 already asks for "an immutable pin" in as many words.
- **A revision alone cannot be spoken.** Nobody writes "reLith is powered by iklib
  9f1c0b2a…" on a page, and nobody diffs two 40-character hex strings to see which is newer. D40's
  editions will name packs in prose. The human half has to be in the record too.
- So the pin carries both, and they are not interchangeable: **the version is the label, the revision
  is the identity.** A refusal that catches `revision: "main"` is therefore not pedantry; it is the
  difference between the two halves being kept apart.

Rejected forms, and why:

| Rejected | Why |
| --- | --- |
| A bare version string, `"pin": "0.4.0"` | pins nothing; see above |
| A locator, `{ url, ref }` | acquisition, which KI-008 has not decided and the boundary constrains. A URL in the manifest is a download waiting for a reader that resolves it. |
| A lockfile beside the declaration | a second file with its own staleness story, for two fields |
| A digest only | unspeakable; loses the half D24 and D40 actually quote |
| Allowing a short revision (`9f1c0b2`) | a prefix is unique until it is not, and the failure arrives years later on someone else's clone |

**A pin declared is not a pin verified.** This block records what a project says it stands on. Nothing
here opens the tree at `library.path` to confirm the revision, because doing so means acquiring and
identifying bytes, which is exactly what is out of scope. A declaration whose path does not exist yet
is a project that has not fetched its pack, not a malformed declaration — and reporting it as
malformed would turn a missing prerequisite into a schema error, which is the inverse of the rule in
`AGENTS.md` about never turning missing evidence into something else. Verification arrives with
acquisition, and it will have this pin to verify against, which is the point of writing it down now.

### The `library` facet

```json
"library": { "path": "third_party/iklib", "target": "iklib::ik" }
```

- `path` — root-relative, the directory a consumer adds. Refused when absolute, when it contains `..`
  or a backslash, exactly like every other declared path in this contract.
- `target` — the CMake target a game links, `^[A-Za-z0-9_][A-Za-z0-9_.+-]*(::[A-Za-z0-9_][A-Za-z0-9_.+-]*)*$`.

Two keys, because two is what a consumer needs: **source-tree consumption is the only form offered.**
Spec 001 rules out the alternatives in its own words — "No nonexistent installed package or implicit
sibling lookup belongs in the recipe" — so there is no `find_package` mode, no package name, and no
version range to solve. A consumer adds the declared directory and links the declared target; the pin
says which bytes that directory is supposed to be. Anything richer (cache options, components,
per-configuration targets) is a key a later contract can add when a real consumer needs it, and
inventing it now would be inventing a consumer.

### The `plugin` facet

```json
"plugin": { "module": "build/plugins/red-inspector.dylib", "abi": "re-plugin-1" }
```

- `module` — root-relative path to the loadable module, refused when it escapes.
- `abi` — **an opaque version string.** Its shape is checked
  (`^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`) so a declaration cannot carry a shell fragment or a
  kilobyte of prose in it. Its **meaning is not this lane's**: the reader never parses it, never
  orders two of them, never compares one to a version of its own, and never refuses one for being
  "too old". The plugin-ABI lane owns what the string says and what a loader does about it; when that
  lane lands, it reads this string from a declaration that has already been shape-checked.

`module` names one file. Per-platform selection is not in this contract — spec 105's fourth open
question, with KI-038 (the Windows desktop repair) still outstanding. That is a later key rather than
a later reinterpretation of this one: a declaration that must differ per platform will grow a key in
contract 10, and a reader that predates it will say "unknown contract" rather than loading the wrong
file.

### ~~`poweredBy`, which is where D24 becomes legible~~ — removed by D45, spec 112

> Superseded the day after it shipped. Kept because it is the reasoning D45 answered, and a spec that
> quietly deletes the case it lost is worth less than one that leaves it standing.

D24 is clarified by D39, not redefined: the claim is earned through the **library** facet at a pinned
version with passing game integration checks. An editor plugin does not earn it. The manifest makes
that distinction checkable:

```json
{ "name": "iklib", "pin": { … }, "poweredBy": true, "library": { … } }
```

`poweredBy` on a pack with no `library` facet is refused by name. What the key asserts is bounded and
should be read exactly: **it names the pack the claim rests on.** It does not assert that the
integration checks passed — a declaration cannot prove that, and F21/F29 are where that evidence
lives. A project that declares `poweredBy` on a pinned library facet has said which adoption it is
standing on; it has not said the adoption is proven, and this block never claims it has.

## Worked examples

### iklib, in a game's declaration (D23, D24, spec 001)

The library facet is the whole of iklib's relationship to a game: a source tree the game's CMake adds
and one target it links. Nothing about the editor is involved, and the game does not have to use the
editor at all — which is D24's "IDE and shared harness are optional", intact.

```json
{
  "contract": 9,
  "project": "nolf-improved",
  "formats": [ … ],
  "packs": [
    {
      "name": "iklib",
      "pin": { "version": "0.4.0", "revision": "9f1c0b2a7d5e4c3b8a06f2d1e9c7b5a4302f1e8d" },
      "poweredBy": true,
      "library": { "path": "third_party/iklib", "target": "iklib::ik" }
    }
  ]
}
```

### An editor plugin

```json
{
  "name": "red-inspector",
  "pin": { "version": "0.1.2", "revision": "4c2f8b1d0e6a9375c4b8d2e1f0a763958c1d4e2b0f7a6394d8c2b1e0f5a39476" },
  "plugin": { "module": "build/plugins/red-inspector.dylib", "abi": "re-plugin-1" }
}
```

Declaring `poweredBy: true` here is refused: `$.packs[0] (red-inspector).poweredBy is earned by a
library facet; an editor plugin does not earn it`.

### The renderer, which declares both (D30)

One artifact, one pin, two ways of being consumed — the case D39 was shaped around. A game adopts the
renderer through the library facet and never loads a plugin; the editor loads the same pinned artifact
as a module.

```json
{
  "name": "rengine-render",
  "pin": { "version": "0.2.0", "revision": "1d7c3a90b5e2f486a0c9d3b71e5f28a4c6091b3d" },
  "library": { "path": "render", "target": "rengine::render" },
  "plugin": { "module": "build/plugins/rengine-render.dylib", "abi": "re-plugin-1" }
}
```

### D33's owned control additions

The second thing the format had to fit, and it fits without a special case: a library facet over the
owned layer that sits on pristine microui.

```json
{
  "name": "rengine-ui",
  "pin": { "version": "0.1.0", "revision": "5b8e0f2c7a13d946b0e8c25f7a1d34906bce2f18" },
  "library": { "path": "orchestrator/native/ui", "target": "rengine::ui" }
}
```

## Refusals

Every one is by name and specific, in the shape the other ten blocks use. A problem in `packs` is
reported as `packsError` and takes nothing else with it: the formats, the dashboard and the rest of
the declaration read exactly as they would have.

| Mistake | Refusal |
| --- | --- |
| `packs` on contract 8 | `packs requires contract 9 (declared contract 8)` — refused for the contract it needs, never as an unknown key |
| A facet key under the wrong facet | `$.packs[0] (iklib).plugin.target belongs to the library facet` (and the mirror for `library.module`) |
| A pack with no facet | `$.packs[0] (iklib) declares no facet; a pack declares library, plugin or both` |
| A repeated pack name | `$.packs[1].name repeats "iklib"` — placed by the occurrence's index, so the second one is what you go and look at |
| `poweredBy` on a plugin-only pack | `$.packs[0] (red-inspector).poweredBy is earned by a library facet; an editor plugin does not earn it` |
| A branch or tag as a revision | `$.packs[0] (iklib).pin.revision must be a 40- or 64-character hex digest, not "main"` |
| An escaping path | `$.packs[0] (iklib).library.path must be root-relative` |

A record with no `name` is placed by its index alone and never printed as `undefined`, the way spec
078's records are.

## Consumer path and verification

The consumer this feature ships against is the declaration reader itself, `readDeclaration` in
`orchestrator/server/formats.mjs` — the same consumer every other block had on the day it landed. A
contract-9 declaration with both facets reads back through the real reader, from a real file on disk,
and each refusal is observed through it rather than against the rules function in isolation.

There is no loader and no build integration in this feature, and this spec does not claim either. The
plugin lane consumes `plugin.abi` and `plugin.module`; a game's own CMake consumes `library.path` and
`library.target` from its own workspace under its own authority.

Every regression in `orchestrator/tests/packs.test.mjs` was observed failing for its own reason before
it was believed: the sabotage table is
[`docs/evidence/pack-manifest-2026-09-07.md`](../evidence/pack-manifest-2026-09-07.md).

## Acceptance criteria (F109)

1. A contract-9 declaration whose pack declares both facets reads back through `readDeclaration` with
   its name, pin, library and plugin intact, and `packsError` unset.
2. A contract-8 declaration that names `packs` is refused with `packs requires contract 9`, not with
   an unknown-key error, and its formats still read.
3. Each refusal above fires by name: a misplaced facet key says which facet it belongs to; a facet-less
   pack, a repeated name, `poweredBy` without a library facet, a non-digest revision and an escaping
   path each name the pack and the key.
4. A declaration that does not name `packs` is unchanged: the ten existing blocks read exactly as they
   do today, and the contract ceiling is 9.
5. Nothing in this feature acquires, downloads, unpacks, loads or interprets a pack; the reader never
   opens `library.path` or `plugin.module`.
6. Each regression was observed failing for its own reason, recorded in the evidence document.

## Where I think D39 will cost something

Implemented as decided; recorded because the reasoning is worth having later.

1. **One pin over two facets forces lockstep.** D39's strength — one word, one unit, one pinning story
   — means the renderer's version moves when its editor plugin changes, and a game that only builds
   the library facet sees churn it has no interest in. The alternative (a pin per facet) was worse for
   the reason D39 gives, but the renderer is precisely the artifact where the cost lands, and the first
   time a game re-pins for a plugin-only change is the moment to remember this paragraph.
2. **`poweredBy` in a declaration is a subject, not a proof.** The claim needs passing game integration
   checks and a declaration cannot carry them. The key is honest as specified and documented that way
   here, but "declared powered-by" will read to somebody as "earned powered-by", and the evidence for
   the second lives in F21/F29 rather than in any file this contract validates.
3. **A facet says a role, not a direction.** There is no way to say whether a pack is one this project
   *provides* or one it *consumes*, and rEngine's own declaration would list `rengine-render` and
   `rengine-ui` as packs it builds while a game lists `iklib` as one it consumes — identical rows,
   opposite meanings. It costs nothing today because nothing reads the block across projects. D40's
   editions name packs across projects by definition, and that is where the missing direction will
   have to be added.
