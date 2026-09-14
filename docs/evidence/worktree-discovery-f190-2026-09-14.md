# F190 — a repository's worktrees, as a record the workspace can draw (2026-09-14)

Spec 134 D1/D2. `red_project::worktrees` answers what git already knows about the repository
behind a root: every worktree, its branch, whether its tree is clean, whether its branch is
already contained in its base, and — the one field every caller actually asks for — whether it
may be removed.

## Why this shape

The survey is the feature. Thirty worktrees accumulated in this repository unseen (14 GB under
`.cache/worktrees/`, 1.9 GB under `.claude/worktrees/`), and pruning them safely on 2026-09-14
meant checking each one by hand for uncommitted work and for whether its branch had landed. That
check is mechanical and it is exactly what a Remove button must not skip, so it is computed here
and `removable` is a field rather than a judgement left to the caller.

`removable` is true only when the worktree is present on disk, is not the main checkout, holds
nothing uncommitted, is already merged into its base, and is not locked. **A `null` in either
fact is not a yes** — a worktree whose directory is gone cannot be read, so `dirty` and `merged`
are null and `removable` is false, which is spec 002's rule for a checkout that is not there:
report the state, do not guess.

"Its base" is the branch the MAIN worktree has checked out — what a person means by "merged" in a
repository they are working in. A detached main worktree has no such branch and `base` is null;
then `merged` is null too, rather than invented.

## Read-only, and bounded

Discovery runs git's own plumbing (`worktree list --porcelain`, `status --porcelain`,
`merge-base --is-ancestor`) through `red_project::command`, so it inherits the bounds every
declared command has: a 15-second deadline on the call, an 8 MiB ceiling enforced while reading,
its own process group. It never writes. Creation and removal are F191's, and F191 is refused
unless this module's survey says yes.

`--is-ancestor` answers by exit code, and the distinction matters: exit 1 is "no", while any other
failure is a question that could not be asked — an unknown ref, a corrupt object — and answers
`null` rather than "no". A false "not merged" only annoys; a false "merged" deletes work.

## The checks

`git worktree list --porcelain` is parsed as the blank-line-separated record set it is, rather
than scanned: `locked` and `prunable` carry an optional reason, and a scan for the word would find
it inside a path.

A fixture repository is built per test with one worktree of each shape the criteria name — clean
and merged, ahead of its base, merged but dirty, and one whose directory is deleted underneath
git. Three cases: the full listing, a directory outside any repository (`This project is not in a
git repository.`, 415), and a plain checkout with no worktrees of its own (which still lists
itself, because a checkout is a worktree).

| Sabotage | Red for |
| --- | --- |
| `dirty` dropped from the survey | the dirty worktree reports `removable: true` |
| an unmerged branch counted as merged | the branch ahead of main reports `merged: true` |
| a missing directory treated as present | the deleted worktree reports `present: true` |
| the main checkout removable | a plain checkout reports its own `removable: true` |

Each was observed failing at its own assertion, and restored.

## The consumer path

`red-project worktrees <rootPath>`, run against this repository:

```
repository: /Users/alex/rengine
base: main
  main main                   dirty=5 merged=True  removable=False
       feat/live-hot-update   dirty=0 merged=True  removable=False
```

The second row is the worktree left behind on 2026-09-14 because it is **locked**: clean, merged,
and correctly refused on the lock alone. That is the hand survey of that morning, now mechanical.

## Gates

`cargo test --workspace` 133/133 · `./init.sh` passes. No JavaScript changed.
