# 134 — The Projects modal: repositories, worktrees and the toolbar that loses two controls

Status: designed 2026-09-14 through a `/grill-me` interview. Not implemented.
Charter: D20 (multiple project/worktree roots), **D63** (this spec's boundary change).
Supersedes the toolbar's project controls described in spec 080's menus card.

## Why

Thirty git worktrees accumulated in this repository — 14 GB under `.cache/worktrees/` and 1.9 GB
under `.claude/worktrees/` — and nothing in the product ever showed them. They are gitignored, so
they never appeared in a tree or a `git status`; the only way to see them was `git worktree list`
from a shell. They were all clean and all merged, which is the point: no one had to decide
anything, because no one could see anything.

The workspace has supported worktree roots since D20. What it has never had is a surface where a
repository's worktrees are visible as a set.

A second, smaller thing pushed the same way. The Add-project flow is split across two controls and
the code apologises for it:

```c
else re_copy(a->status, sizeof(a->status), "Type a project path in the toolbar, then choose Add project.");
```

And the field it refers to promises more than the backend accepts — the placeholder reads
`Project path or repository URL…` while `red_store::store::add_root` answers
`Choose an absolute project directory.` to anything that does not start with `/`.

## What the codebase already decided, and nobody should re-ask

These came out of the repository during the interview rather than out of the owner, and they are
recorded here so the next session does not spend the owner's time on them.

| Question | Answer | Where |
| --- | --- | --- |
| Is a worktree a root, or a view of one? | **A distinct root.** Root IDs are "distinct from repository identity, checkout revision and display labels"; "two worktrees of one repository remain distinct roots" | D20, spec 002 |
| Do sessions follow when the focused tree changes? | **No.** "tab placement and the currently focused tree do not retarget an existing session" | spec 002 |
| Does root binding sandbox a terminal or an agent? | **No.** "identifies context; it does not by itself sandbox" | spec 002 |
| A root whose directory has gone? | Report the state, require explicit resolution, **"do not guess replacement checkouts"** | spec 002 |
| Two roots holding the same relative filename? | "Show the root alongside session/file labels where names collide" | spec 002 |
| Refresh git state on a timer? | **No** — tab-open or an explicit Refresh, the rule the Devices and Tasks tabs already follow because a remote provider spends a rate-limited request on every read | spec 083, `app.c:236` |
| What shape is the Agent control? | A **select**, not a textbox: `<span class="re-button re-select agent"><span>codex</span></span>` | `design/previews/workspace/toolbar.html` |
| Would removing toolbar controls break the design gate? | **No.** The generated card pins `height`, `background` and `brand` only | `design/cards.json`, `native-design.spec.mjs` |

## Decisions

**D1 — The browser owns discover, create and remove.** *(recommended, owner-confirmed)*
It lists every worktree of a root's repository with its branch and its state, can add one, and can
remove one. Removal runs the survey this session ran by hand: a worktree is removable only when it
is **clean and merged into its base**, and anything else is refused by name rather than forced.
Discovery alone would have found the 30; creation is where they came from, and an unsurveyed
Remove button is how the next 15 GB gets deleted instead of accumulated.

**D2 — A repository is a grouping in the view, never a record in the store.** *(recommended,
owner-confirmed)* Roots stay flat and independent in identity and binding exactly as D20 requires.
The browser groups them under a repository heading for display and shows a branch per root.
Nothing in `red-store` learns what a repository is, so spec 002's deliberate separation of root ID
from repository identity is left intact.

**D3 — The toolbar loses the root switcher and the project field.** *(owner-decided, against the
recommendation offered)* Owner, 2026-09-14: *"I think that we do not need project switcher and
input in top toolbox, if we want to open another project - there should be better a modal window
open"*. `RE_OVERLAY_ROOTS` and its "Add project…" item go with them; the modal is the one place a
project is chosen, added or created. The design preview at
`design/previews/workspace/toolbar.html` still shows both controls and goes stale here — it
updates through spec 064's route, and the machine-checked card is unaffected.

**D4 — The modal opens from the status bar and from a keyboard command.** *(recommended,
owner-confirmed)* The status bar names the current project; pressing that segment opens the modal.
This is already a proven pattern in this desktop — the token segment is a clickable rectangle
drawn outside microui and served by `re_app_event`, precisely because "a window of its own would
cost a root container, and fifteen panes with a surface open already sit at microui's root list of
32" (`workspace.c:740`). A command joins the existing set (`\`, backspace, `t`, `e`, `w`).

**D5 — A created worktree lands where the project's declaration says.** *(owner-decided, against
the recommendation offered)* A new `worktrees` block in `.rengine/project.json` names the
directory, at **contract 11** — the next number; the ceiling is the schema's own enum, read by
`red_project::declaration::CONTRACTS` and by `orchestrator/tests/contract.mjs`. The alternative
offered was git's `../<repo>-<branch>` convention; the declaration was chosen instead, so a
project owns where its worktrees live the way it already owns its dashboard, games and tracker.

**D6 — An undeclared repository is asked, and offered the declaration.** *(owner-decided)* Creating
a worktree in a repository that declares nothing prompts for a directory and offers to write the
`worktrees` block into that project's `.rengine/project.json`. **This is a boundary change and is
recorded as charter D63**: until now rEngine has read a project's declaration and never written it.
D47's precedent is adjacent but weaker — there a judgement is written back through the project's
*own declared* `tracker.write` command, never by rEngine editing the project directly.

The bound, which the implementation must keep: the edit is **offered, shown in full before it is
made, and confirmed** — never silent, never a side effect of creating a worktree. A refusal leaves
the file untouched. A declaration that will not parse is reported and not rewritten, the rule
`bootstrap-agent-hooks.sh` already follows for the one global file this workspace edits.

**D7 — The Agent control becomes the dropdown design already specifies.** *(owner-decided,
design-derived)* Owner: *"It should be a dropdown, like in design"*. The design source has said
`re-button re-select` since spec 064; the native drifted to `re_ui_textbox_ex`. Its contents are
the agent menu that already exists — `red_project::tasks::known_agents` filtered by
`parse_installed`, served at `/api/agents-menu`. This is drift repair, not new design.

## Acceptance

- A repository with several worktrees shows them as one group, each with its branch and its state,
  and switching between them retargets no existing session (spec 002's rule, exercised).
- Removing a clean merged worktree succeeds and leaves its branch; removing a dirty one, or one
  whose branch is unmerged, is refused by name and changes nothing on disk.
- Creating a worktree in a declaring project lands it where the declaration says, at contract 11;
  a project below contract 11 reports the block by name and keeps every other capability, the
  rule `SECTIONS` already applies.
- Creating one in an undeclared project shows the exact declaration edit, writes it only on
  confirmation, and leaves the file untouched on refusal or on unparseable JSON.
- The toolbar carries no project switcher, no project path field and no Add-project button; the
  status bar names the current project and opens the modal when pressed; the Agent control is a
  dropdown listing the installed agents.
- `native-design.spec.mjs` stays green across all three presets.

## Built so far

- **F190** `red_project::worktrees` — the survey, with `removable` computed rather than judged.
- **F191** the `worktrees` block at contract 11, create/remove, and D63's declaration offer.
- **F192** `/api/worktrees` at the door and the worker; the Agent control as the select design
  always specified; and the Projects modal with the status-bar opener, the `Cmd/Ctrl P` shortcut,
  and the toolbar's switcher and path field removed.

What the modal does NOT do yet: create or remove a worktree from the UI. The survey, the refusals
and D63's offer all exist underneath it (F191); wiring the two buttons is what remains.

A select's popover is sized to its **widest row**, not to the control it hangs from, plus twice
microui's body padding — a window's layout is inset by that on each side. `re_ui_menu_item` also
reserves the hint's room and clips the label into what is left. Both, because either alone leaves a
row that can put two strings in one place, which is what D7's first build did to `gemini` and
`not installed`.

The automation channel reports **text runs**: every string the last frame drew, its box, and the
clip in force. A control's rectangle says a row exists and nothing about the strings inside it, so
two strings drawn on top of each other was invisible to every spec and plain in a screenshot. The
clip is part of the answer rather than an afterthought — without it a clipped label reads as an
overlap and an elided name reads as whole.

## Not decided here

- Whether the Agent dropdown's *placement* stays in the toolbar at all. D7 fixes its shape; its
  home is a separate question against this spec.
- Cloning a repository from a URL. D3 removes the field that promised it; nothing replaces that
  promise yet, and AGENTS.md's "no hidden downloads" means it needs its own decision when it comes.
- Pruning the workspace's own leftovers. The 30 worktrees removed on 2026-09-14 were an agent
  harness's, under `.claude/worktrees/` and `.cache/worktrees/`; this spec covers a *project's*
  worktrees, not the harness's.
