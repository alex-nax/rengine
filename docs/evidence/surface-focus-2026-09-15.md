# What the JavaScript surface actually does with focus (spec 142, F189 criterion 2)

F189 requires the focus-eviction semantic *preserved verbatim*. "Verbatim" is only meaningful
against an observation, so this is the observation: `server/surfaces.mjs` driven directly, with a
stand-in input channel recording the **kind** of every packet it was written.

```
no focus yet, a key    -> []
one takes focus        -> [6,5]
the owner's key        -> [1]
two takes focus        -> [6,5]
the evicted one's key  -> []
two loses focus        -> [5,6]
```

Four things are in that trace, and the Rust port reproduces each:

1. **A viewer with no focus delivers nothing.** Not a refusal — nothing.
2. **A release (kind 6) precedes EVERY focus gain, including the first.** `item.owner` starts unset
   and the JavaScript compares it to the viewer, so `undefined !== viewer` releases before there is
   anything to release. It reads like an oversight. It is not one to fix in a port: a game that
   receives a release it was holding nothing for ignores it, and changing it here would make the
   two implementations disagree about a byte on the wire.
3. **Eviction is release-then-take, in that order.** The previous owner's held keys are let go
   before the new owner's focus packet arrives, which is what stops a game keeping a key down for a
   pane the person has left.
4. **Losing focus is packet-then-release**, so the game sees the focus change and then the release
   it caused.

The Rust side asserts this sequence rather than counting receives, and five sabotages were observed
failing for their own reasons: dropping the eviction, delivering a non-owner's input, refusing a
non-owner aloud instead of silently, holding the input through a focus loss, and holding it through
a viewer leaving.

Reproduce with `orchestrator/server/surfaces.mjs` and a stand-in `item.input` whose `write` records
`bytes.readInt32LE(0)`; the Rust side is `red/red-host/src/surfaces.rs`'s test module.
