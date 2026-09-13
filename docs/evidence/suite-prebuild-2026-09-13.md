# The suite was flaky, and it was not the tests' fault (2026-09-13)

Not a feature row: a defect found by watching something that had already been written down.

## The symptom

After F180 and F183 added test files that build Rust binaries, `npm test` began failing about one
run in three — never the same spec twice. Observed failures included *"a launch that continues or
forks reports no conversation"*, *"list and show are byte-exact with the registry.mjs CLI"*, *"a
restart puts the pane back on the same conversation"*, *"root identity and drafts survive restart"*,
*"game launch prerequisites fail before creating shell or agent sessions"* and *"every red.v1 shape
the façade emits still matches the live session host"*. Each passed alone. F180's evidence recorded
it as worth watching rather than solved, which is why it was still there to find.

## The wrong diagnosis, and how it was caught

The first hypothesis was a race in F178's new `Sessions` client: the service starts a session's
output pump and exit watcher the instant it spawns, so for a child that exits immediately the exit
event can arrive before the spawn response registers the item — and an event for an unknown id was
dropped. Twelve concurrent instant exits were written to pin it. **The sabotage passed**: removing
the guard did not make the test red on this machine, three times in a row. So the hypothesis was not
what the suite was complaining about, and guessing further would have been guessing.

The guard stays (dropping a child's exit is a session that reads as running forever, and the
ordering hazard is real), and the instant-exit spec stays as coverage — but neither is presented as
a sabotage-verified regression, because it is not one.

## The actual cause, caught in one run

Looping the suite and keeping the output produced the message:

```
not ok 212 - red-agents report-session matches the frozen JS answers on all fourteen cases
  error: 'red-agents was built at /Users/alex/rengine/red/target/debug/red-agents'
  expected: true / actual: false
```

`existsSync` on a binary that was built minutes ago. Several specs run `cargo build` before using a
binary; cargo **replaces** a binary in place when it relinks one; and the suite runs its files
concurrently. A spec that had already built could look at the same path in the instant another
spec's build was swapping it. Nothing to do with the tests' own subjects, which is exactly why the
failures looked random.

## The fix, and what proves it

`npm test` gains a `pretest` that builds every binary in the Rust workspace once, before
`node --test` starts. The in-spec builds become no-ops — cargo relinks nothing, so nothing is
replaced under another spec's feet — and a spec run on its own still builds what it needs.

- Before: failures in roughly one run in three, across six different specs.
- After: **six consecutive clean runs**, 314 of 314.

`suite-coverage.test.mjs` asserts the `pretest` exists and builds `--bins` from the workspace
manifest, because a `test` script that quietly lost it would bring the flake back with no other
symptom — the same reason that file asserts every spec is reachable at all.
