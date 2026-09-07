# Pack manifest regressions, observed failing for their own reasons

Date: 2026-09-07. Feature F109, [spec 107](../specs/107-pack-manifest.md), charter D39 and D24 clarified.
Subject: `orchestrator/tests/packs.test.mjs` against `contracts/project-v1.schema.json` and
`orchestrator/server/formats.mjs`.

`AGENTS.md`: *"A regression counts as established only once it has been observed failing for its own
reason: break the implementation in the specific way the test claims to catch, confirm it goes red for
that and not for something earlier, then restore."* Fourteen sabotages, one at a time, each restoring
the tree before the next; the suite was confirmed green before the first and after the last.

## Before anything was implemented

The four tests were written first and run against the unchanged reader. Three were red, one green:

```
not ok 1 - contract 9 carries a pack whose facets are a library and a plugin (spec 107)
not ok 2 - packs on contract 8 is refused for the contract it needs, not as an unknown key
not ok 3 - each pack refusal names the pack and the key (spec 107)
ok 4 - a declaration that does not name packs reads exactly as it did (the ten blocks of contracts 1-8)
```

Test 4 being green from the start is the point of it: it is the control, and its job is to stay green
while the other three go from red to green. Sabotage S14 is what proves it can go red at all.

## The sabotage table

Each row: the change made to the implementation, and the assertion that caught it. "First red" is the
assertion in `orchestrator/tests/packs.test.mjs` that failed first in that test, so the failure is
attributable to the sabotage rather than to something earlier in the file.

| # | Sabotage | First red | The assertion |
| --- | --- | --- | --- |
| S1 | `CONTRACTS` back to `[1…8]` | `packs.test.mjs:40` — *the ceiling moved with the packs block* | `assert.equal(CONTRACTS.at(-1), 9)` |
| S2 | the schema's `contract` enum stops at 8 while `CONTRACTS` says 9 | `:41` — *the schema knows contract 9 too* | `schema.properties.contract.enum.includes(9)` |
| S3 | `section(result, 'packs', undefined, …)` — the block never reaches its section | `:55` — *the pack reaches the reader whole rather than being dropped in silence* | `deepEqual(read.packs, [renderer])` |
| S4 | `SECTIONS.packs.minimum` lowered from 9 to 8 | `:93` — *a reader that has the block still refuses it below its floor* | `match(eight.packsError, /packs requires contract 9 \(declared contract 8\)/)` |
| S5 | the whole block removed from the reader (`packs` left in `base`, no `packs` property in the schema) — the pre-implementation state | `:91` — *packs is a known key at every contract; a reader that has the block refuses the contract, never the key* | `!/unknown key packs/.test(eight.error)` |
| S6 | the cross-facet loop compares each facet against itself (`other !== facet`) | `:118` — regex did not match | `match(…, /\$\.packs\[0\] \(iklib\)\.plugin\.target belongs to the library facet/)` |
| S7 | the "declares no facet" check replaced with `if (false)` | `:130` — `packsError` was `undefined` | `match(facetless.packsError, /declares no facet; a pack declares library, plugin or both/)` |
| S8 | the duplicate-name push disabled | `:135` — `packsError` was `undefined` | `match(twice.packsError, /\$\.packs\[1\]\.name repeats "iklib"/)` |
| S9 | **D24 inverted**: `poweredBy` required a `plugin` facet instead of a `library` one | `:63` — *iklib should be accepted: `$.packs[0] (iklib).poweredBy is earned by a library facet…`* | `equal(adopted.packsError, undefined)` |
| S10 | `REVISION` widened to `/^[0-9A-Za-z]+$/`, so a tag passes as a pin | `:148` — *main must be refused as a revision* | `match(named.packsError, /pin\.revision must be a 40- or 64-character hex digest/)` |
| S11 | the `rootRelative` check on `library.path` / `plugin.module` disabled | `:158` — *../elsewhere/iklib must be refused* | `match(out.packsError, /\$\.packs\[0\] \(iklib\)\.library\.path must be root-relative/)` |
| S12 | `packName` always interpolates, so a nameless pack prints `(undefined)` | `:165` — regex did not match | `match(anonymous.packsError, /\$\.packs\[0\]\.library\.path must be root-relative/)` |
| S13 | `required: ["name", "pin"]` removed from `$defs.pack` | `:172` — `packsError` was `undefined` | `match(nameless.packsError, /\$\.packs\[0\] requires name/)` |
| S14 | `packs: value.packs ?? []` added to the result, so the block leaks into declarations that never named it | `:211` — *a declaration without packs carries neither packs nor packsError* | `deepEqual(Object.keys(read).sort(), […])` |

### Reading the table honestly

- **Nine of the fourteen also reddened later tests**, which is expected and not a defect in the
  sabotage: a broken contract ceiling (S1, S2, S5) makes every contract-9 fixture unreadable, and a
  leaking result key (S14) is visible from three directions. The column that matters is *first red*,
  which in every case is the assertion whose sentence names the thing that was broken.
- **Five rows failed as `assert.match(undefined, …)`**, reported by Node as *The "string" argument must
  be of type string*. That is the correct red for its own reason — the refusal did not merely say the
  wrong thing, it did not happen at all — but the message names the argument type rather than the
  missing sentence. Recorded here so nobody later reads that error as a broken test.
- **S9 is the row worth keeping.** Inverting D24 — earning "Powered by rEngine" on the plugin facet
  instead of the library one — is a one-word edit that leaves every structural check green and every
  document valid. It was caught not by the refusal test but by the acceptance one: `iklib`, a
  library-facet pack with `poweredBy: true`, stopped being accepted. A suite that only tested the
  refusal would have gone green on an implementation that had the decision exactly backwards.
- **S6 and S12 fail on the regex rather than on a missing message**, because `packsError` still holds
  a different sentence. S6 leaves the structural `$.packs[0].plugin has unknown key target` — which is
  precisely why the by-name rule exists on top of it: the structural refusal says a key is unknown,
  and only the rule says which facet it belongs to.

## The refusals as they actually read

Produced by calling `readDeclaration` on real files under a temporary root, after the sabotages were
restored:

```
misplaced facet key
    .rengine/project.json: $.packs[0].plugin has unknown key target; $.packs[0] (iklib).plugin.target belongs to the library facet
no facet
    .rengine/project.json: $.packs[0] (iklib) declares no facet; a pack declares library, plugin or both
repeated name
    .rengine/project.json: $.packs[1].name repeats "iklib"
poweredBy on a plugin
    .rengine/project.json: $.packs[0] (red-inspector).poweredBy is earned by a library facet; an editor plugin does not earn it
a tag as a revision
    .rengine/project.json: $.packs[0] (iklib).pin.revision must be a 40- or 64-character hex digest, not "main"
an escaping path
    .rengine/project.json: $.packs[0] (iklib).library.path must be root-relative
contract 8
    error=undefined
    packsError=.rengine/project.json: packs requires contract 9 (declared contract 8)
```

The last one is the shape the contract floor is supposed to have: `packsError` names the contract the
block needs, and `error` is unset, so the formats and every other block of that declaration still read.

## Gates

| Command | Result |
| --- | --- |
| `./init.sh` | passed; 60 features validated |
| `npm test` | 217 tests, 217 pass, 0 fail (213 before this change; the four new ones are `packs.test.mjs`) |
| `python3 tools/features.py validate` | passed |
| `python3 tools/design.py check` | passed; native theme, 19 design cards, token mirror and 3 presets consistent |

## What is not evidenced here, and is not claimed

Nothing in this feature acquires, downloads, unpacks, loads or interprets a pack, and no test claims
it does. `library.path` and `plugin.module` are never opened; a declared `pin.revision` is never
compared against any bytes. Acquisition is KI-008's, loading is D38's own spec, editions are D40's,
and the meaning of `plugin.abi` belongs to the plugin-ABI lane. The consumer path exercised here is
the declaration reader, reading real files from disk.
