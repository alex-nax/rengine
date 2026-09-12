# Where a document opens, and what a dragged tab looks like (F145)

Date: 2026-09-12. Owner-reported, in their words:

> when we open file in project tree - it opens in the same pane, not the other(bigger), i think that
> the behavior should be like - if we have one pane opened - than yes - open in a new tab in the same
> pane(remember scrolling of tree when we switch back), but if more panes are available - then open
> in other(a question still what to do if open > 2)

> Also when I move a tab between panes - i should be able to see the preview of moving tab under
> cursor

Three separate defects live in that paragraph, and they have three different causes.

## 1. A document opens wherever the click came from

`re_app_tab` adds every new view to `a->layout.active`, and clicking the tree sets `layout.active` to
the tree's pane. So the file lands on top of the explorer that opened it — the one pane guaranteed to
be the wrong one, because the person is still using it to find the next file.

**The rule.** A document opens in the most recently used pane that is not the pane it was opened
from. With one pane that is the same pane, which is the single-pane behaviour the owner asked for.
With two it is always "the other one". With three or more it is whichever the person last worked in.

Owner decision, 2026-09-12, chosen over "largest by area" and "nearest sibling in the split":
most-recently-used is **stable**. Area changes every time a divider moves, so the target would
silently migrate between panes while the layout is being adjusted; the split sibling is fixed but can
be a sliver under a nested split. MRU also degrades to exactly the two-pane answer without a special
case for it.

**Every browser pane is excluded, not just the originating one.** The first version of this rule
only skipped the pane the open came from, and the desktop suite caught what that misses: a dashboard
action's script terminal landed in the **explorer's** pane — 33 columns wide, so its output wrapped
mid-word — because the explorer was the most recently used pane that was not the dashboard's. Being
"not where the click came from" was never the point; being a pane that holds work is. The caller
marks every pane currently showing a browser and the rule skips all of them, falling back to the
originating pane when nothing else is left. That fallback is what makes a dashboard in a two-pane
window open its terminal beside itself rather than on top of the explorer.

**What counts as "from".** Not "the tree" — the rule needs no notion of tree-ness. It is the pane
holding the view that issued the open. That makes the same rule serve every opener, which is the
owner's second decision in the same exchange: file links in terminal output, Reveal, and dashboard
artifacts retarget exactly as the tree does, so two ways of opening the same file cannot disagree.

**What it does not do.** A navigator opening a navigator is left alone: choosing the tree from the
command palette, or `re_app_reveal` bringing an explorer forward, still uses the active pane. The
rule fires when a *document* view (editor, terminal, game, plugin) is opened from a pane currently
showing a *navigator* (tree, sessions, dashboard, devices, tracker) — the grouping `workspace.c`
already makes for which views scroll. Restore does not go through `re_app_tab` at all, so a restored
layout is untouched.

The MRU is promoted once per frame from `layout.active` rather than at each of the seven places that
assign it. One hook cannot be forgotten by the eighth.

## 2. The tree forgets where it was scrolled

This is not a tree bug and it is not about opening at all. Every pane built its content window as

```c
snprintf(title, sizeof(title), "Pane content %d", n);
```

— **keyed by the pane**. microui keeps `scroll` on the container behind that name, so every tab in a
pane shares one scroll offset: scroll an editor down, switch to the tree, and the tree is scrolled to
wherever the editor was. Switching back and forth loses the position every time, and with the file
opening into the tree's own pane (defect 1) that happened on every single file opened.

The name is now keyed by the view and its generation (`Pane view <tab>.<generation>`), so the offset
belongs to the thing being scrolled. The generation matters because view slots are reclaimed
(spec 125): without it a recycled slot would inherit the previous view's scroll. A tab dragged to
another pane keeps its position, which is the same property seen from the other side.

## 3. A dragged tab is invisible

`drag_tab` was recorded on mouse-down and read on mouse-up, with nothing in between: no ghost, no
drop indicator, no cursor change. The tab jumped when the button came up, and a drag that missed
landed the tab somewhere the person had no way to predict.

The drop target — which pane, and which index within its strip — was computed inside the mouse-up
handler. It is now `drop_target()`, called by both the mouse-up handler and the draw pass, because a
preview that is allowed to disagree with the drop is worse than no preview: it would teach a person
to aim somewhere the tab will not go. The regression asserts they are the same function, not that
they happen to agree today.

The preview is the tab's own face (`re_ui_tab`, the control the strip draws) at reduced alpha,
centred under the cursor, with the target pane's content area tinted and an insertion caret drawn at
the index the drop would use. It is drawn in `re_app_draw`, above the replayed microui commands and
below the overlay layer — a dropdown must stay on top, and the two cannot be open at once anyway.

A drag is "active" only past the same 8-pixel threshold the drop already used, so a click on a tab
does not flash a ghost.

## What the existing suite had recorded about the old placement

Four desktop specs failed on this change, and each was asserting the old behaviour rather than
finding a defect — which is worth naming, because "the suite went red" and "the change is wrong" are
different things and only one of them was true here:

- **`native-dashboard`** and **`native-game-declaration`** were the real finding, described above:
  the first rule sent documents into the explorer's narrow pane. The rule changed; the specs did not.
- **`native-plugin`** asserted a plugin view opens *in the left pane*. A plugin view is a document,
  so it now opens in the work pane, and the assertion that survives is the one it was really making:
  the view occupies one pane of a split window rather than the whole width.
- **`native-layout`** forced tab overflow by opening six files into the narrow explorer pane. They
  open into the wide one now, so overflow needs ten; its cross-pane drag runs the other way; and the
  tab it scrolls away from sits at a different place in the merged strip, so the scroll goes in
  whichever direction actually hides it.
- **`native-format-hardening`** scrolled a format view by putting the pointer at a fixed `(150, 600)`
  — a point that was inside the pane that view used to open in. It now hovers one of the view's own
  reported rows, which is where it actually is. (A format view sets no tab rectangle at all, so its
  rows are the only thing that names its position; the first attempt to use `tab.rect` aimed the
  wheel at `0,0`.)
