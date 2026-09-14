# F191 — creating and removing a worktree, and the declaration rEngine offers (2026-09-14)

Spec 134 D1/D5/D6, **charter D63**. The half that writes.

## Where a worktree lands, and the `..` the schema had to learn

D5 chose a declared directory over git's `../<repo>-<branch>` convention, and implementing it found
a tension the interview had not reached: `$defs/relativePath` refuses `..`, so a declared directory
would put worktrees **inside the checkout** — which is a mistake git itself warns about, and, when
gitignored, is exactly the invisibility this feature exists to end. That is how 15 GB accumulated.

So the schema gained `$defs/siblingPath`: relative, permitted to leave the root, absolute still
refused because a declaration is committed and shared and a machine's own path is not a fact about
the project (AGENTS.md forbids required `~/...` paths). The `worktrees` block takes one
`directory` of that type, at **contract 11**.

## D63's bound is the implementation, not a note beside it

The offer is **two calls on purpose**. `declaration_offer` composes what the file would become and
returns it as text; it touches nothing. `accept_offer` writes the offer it is handed back. A caller
cannot compose its own text, so what lands is what was shown — the bound is structural rather than
a discipline someone has to remember.

Three refusals carry the rest of it:

- a declaration that will not parse is **reported and not rewritten**, with `it was not changed.`
  in the sentence, because a file this cannot read is one whose shape it must not guess at;
- an offer made against a declaration that has **since changed** is refused rather than applied
  over the change — `accept_offer` re-composes and compares before it writes;
- raising the contract is **part of the edit and shown with it**: the block needs 11, and a raised
  contract is what makes an older reader answer "unknown contract" rather than "unknown key".

## Removal is the survey, by name

F190 computes `removable`; this refuses everything else with the reason, in the order a person can
act on it: the repository's own checkout, a lock, a directory that is gone, the count of
uncommitted paths, then the branch that is not merged into its base. **The branch is never
deleted** — a worktree is a checkout, and removing the checkout of a branch somebody may still want
is not removing their work.

`git worktree add -- <path> <branch>` and `remove -- <path>`: the `--` because a branch named like
an option is still a branch and git must not read one as a flag.

## The macOS symlink, again

Git reports a worktree by its **real** path, and a scratch directory reached through `/var` is
`/private/var` once resolved. The first removal test failed on it. Both sides are canonicalised
before they are compared now — and for the worktree whose directory is gone, whose leaf cannot
resolve, the **parent** is canonicalised and the name put back, which still settles a symlinked
ancestor. This repository has been caught by that symlink before; it is written down here because
the fix is not obvious from the failure.

## Sabotages

| Sabotage | Red for |
| --- | --- |
| removal ignores the survey | the dirty, unmerged, missing and main cases all remove |
| the offer writes while it shows | `the offer did not touch the file` |
| unparseable JSON overwritten instead of reported | the broken declaration is replaced |
| a stale offer applied over the change | the rename made underneath is lost |
| the block lands without raising the contract | `contract` stays 2 where 11 is needed |

**The first attempt at the second one printed nothing and proved nothing.** Its escaping was wrong,
it never compiled, and a grep for `FAILED` hid the compile error — the same trap this workspace hit
this morning with a `copytree` restore that fooled cargo's freshness check. It was redone so it
compiled, and then it failed for its own reason. A sabotage that produces no output has not passed;
it has not run.

## The ceiling moved, and three checks said so

Raising the enum to 11 turned three JS specs red, and each was right to go red:

- **two tripwires** — `packs.test.mjs` and `task-writes.test.mjs` — carry a written protocol
  ("whoever raises the ceiling comes here and confirms the assertions below still read as they
  do") and a `Confirmed for N` line per bump. Both confirmations were made and recorded: the
  `worktrees` block names one directory, has its own SECTIONS floor, and reaches neither packs nor
  `tracker.write` nor `agents`.
- **the frozen declaration record** refused because its `unknown contract` sentence enumerates the
  supported set, and a contract added to the schema must move it. The record cannot be regenerated
  — the JavaScript that produced it is gone — so the **enumeration is folded**, on both sides, the
  way that corpus already folds the JSON parser's own phrasing. What stays compared is the rule:
  an unknown contract is refused by name and the supported set is given in the reader's own
  sentence. The list is the document's to change.

That last one is the frozen-record tension in its sharpest form, and folding is the honest answer:
the record stops asserting data that another document owns, and asserts the rule it was taken for.

## Gates

`npm test` 352/352 · `cargo test --workspace` 139/139 · `./init.sh` passes. No JavaScript retired;
F192 (the Projects modal) is the rest of spec 134.
