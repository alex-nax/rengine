# A closed view never gave its slot back (F134)

Date: 2026-09-11. Status: **fixed, with the regression observed failing twice.** Reported by the
owner against the running editor:

> new tabs seems not to be opening in this instance of editor anymore, eg. i click shell - it shows
> in sessions tab but I cannot neither attach to it nor new tab opens at all

## What was actually happening

The report is precise and the two halves have different causes, which is why it reads as two bugs.

**The session was made.** Clicking Shell asks the server for a terminal, and the server made it —
so it appeared in the Sessions tab, with a live PID.

**The tab was not.** The client then calls `re_app_tab`, which needs one of the window's **64** view
slots. There were none, so it returned −1 after writing one line to the status bar:
*"The workspace supports 64 retained views in this build."* Nothing else said anything, and a status
line is easy to miss.

### The leak

Closing a view removes it from its pane and **deliberately keeps its tab**:

```c
re_layout_remove(&a->layout, tab); a->focus = -1;
re_terminal_close(t->terminal); t->terminal = NULL; ...
```

`t->used` stays true, and that is on purpose — `re_app_tab` looks for an existing tab with the same
root, path and session before allocating, so reopening a file restores the view you had, and
reopening a directory is the refresh gesture spec 080 decision 10 describes. What nothing ever did
was give a slot back when the window needed one.

So a slot was claimed for the life of the window by every view ever opened. Measured in the owner's
own window, from `.cache/orchestrator-development/workspace.json`:

| | |
| --- | --- |
| slots used | **64 of 64** |
| views actually in a pane | **4** — Sessions, Project, one agent, one editor |
| orphans | **60**: 30 editors, 24 terminals and agents, 3 dashboards, Devices, Tasks, a Project tree |

**And a restart would not have fixed it.** The tabs are serialised and `re_app_restore` marks every
one of them `used` again, so the exhausted window came back exhausted. That is worth stating because
restarting is the first thing anyone would try.

## The fix

When every slot is taken, reclaim the **least recently used view that is closed** — one the window
still holds but no pane shows. If every slot is on screen, refuse, and say so in terms that are true:
*"Every one of the 64 views in this window is open; close one to open another."*

The explorer already had this exact problem and this exact answer a few functions away:
`enforce_row_cap` collapses the least recently opened folder when the tree hits its row cap, and says
which one it collapsed. This does the same for views, including saying which one it released.

Three details that are not incidental:

- **The generation survives and advances.** A reply or a tree expansion still in flight for the old
  view carries the generation it was made under, and both are checked; bumping it is what stops
  stale work landing on the view that takes the slot.
- **The name is copied before the clear**, because the status line names the view it released and
  everything below the copy wipes the buffer that name lives in. `enforce_row_cap` has the same
  comment about paths, for the same reason.
- **Only closed views are candidates.** Reclaiming one that is on screen would take a pane's content
  out from under someone, which is the second sabotage below.

## Evidence

`native-layout.spec.mjs` drives the gesture that was reported — clicking Shell, then closing it —
seventy times, more than the sixty-four slots. It counts what is shown **from the layout, never from
the tab array**: a closed view keeps its tab, which is the thing under test, so the tab array cannot
answer the question.

| Sabotage | Observed |
| --- | --- |
| nothing is ever reclaimed (the bug as it was) | `shell 63 opened a view; the window ran out of slots after 63 opens and closes` |
| a view still on screen is reclaimed | `shell 63 closed again not reached` — the reclaim took the visible terminal |

The first reproduces the report exactly: the sixty-fourth open is the one that fails.

Two earlier attempts at the test were wrong in ways worth recording, because both would have passed
for the wrong reason:

- **Opening files through the tree** ran out at `slot-4.txt`, and not because of any slot: the tree
  sorts alphabetically, so `slot-4` is the forty-fifth row and below the visible area. The test was
  measuring how tall the window was.
- **Counting terminals from the tab array** could never see a close at all, since the tab persists.
  That is the bug wearing the test's clothes.

`Cmd-W` rather than `Ctrl-W`, and the spec says why: a workspace command takes the **platform**
modifier before any pane sees the key, deliberately, so that `Ctrl+W` still reaches a shell in a pane
as delete-word.
