# Editions: the business and entertainment streams (charter D42–D43)

Date: 2026-09-08. Status: **design interview complete; nothing implemented.** Continues
[spec 105](105-packs-editions-and-the-name.md), which established the mechanism (D40) and the name
(D41). The owner supplied the split:

> business stream(RED Suite) - kohai(~/hirebase-v2, note on external state dir)
> entertainment(rEngine) - ~/nolf-improved, ~/vtmb-vr

## The split is already visible in what these projects declare

Measured on 2026-09-08 before anything was asked, because a design that contradicts the declarations
would be wrong on arrival.

| Project | Declaration | Contract | Blocks |
| --- | --- | --- | --- |
| **Kohai** `~/hirebase-v2` | **external**, `~/.local/share/redit/hirebase-v2/project.json` | 8 | title, icon, **wordmark**, formats, dashboard, tracker — and **no `games`** |
| `~/nolf-improved` | in-checkout `.rengine/project.json` | 3 | formats, **games**, dashboard |
| `~/vtmb-vr` | in-checkout `.rengine/project.json` | 6 | formats, devices, **games**, dashboard, tracker, agents |

Two facts fall out of that table and shape everything below:

1. **The business project is externally declared and the entertainment ones are not.** Kohai is not
   ours to put files in, so its declaration and its state live under `~/.local/share/redit/` and
   `~/.local/state/redit/` through the external-declaration path (F81). Any edition mechanism that
   assumed a file in the checkout would fail on the first business project there is.
2. **The line falls where the declarations already differ.** Every entertainment project declares
   `games`; the business one declares none, and is the only one carrying a `wordmark`. The edition
   boundary is not a marketing overlay on identical installs.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| D42 | **Red is the product; the editions are the brands.** The binary is Red, and its name stays the single generated value of D41 and F110. An **edition** carries its own brand on top: **RED Suite** for the business stream, **rEngine** for entertainment. This refines D41, which called Red Suite "the umbrella": it is not an umbrella over both, it is the business edition's brand, and rEngine — the name this repository has always carried — becomes the entertainment edition's. | Owner, 2026-09-08, confirming the recommendation |
| D43 | **An edition is declared in the workspace state directory**, not in any project and not in the rEngine checkout. An edition spans projects, so no project can own it; and an install must be able to differ from the checkout, or a business customer receives the entertainment manifest in their tree. It sits beside the state that is already there — including the external declaration and the Linear token that Kohai's workspace already keeps under `~/.local/{share,state}/redit/`. A project stays ignorant of which edition opened it, so the same checkout works in either. | Owner, 2026-09-08, confirming the recommendation |
| D40 (extended) | **An edition varies packs, branding, and the default workspace layout** — which tabs a *fresh* workspace opens: Tasks first for business, a game tab for entertainment. D40 said packs over one binary; this adds branding and first-run layout. It does **not** vary which declaration blocks exist: a contract means the same thing in every install, which is the property contracts exist to provide. | Owner, 2026-09-08, **overruling the recommendation** of packs-and-branding-only. The recommendation lost on first-run experience: two editions that open identically are not two products to the person opening them. |

## What this costs, named rather than discovered

**`PRODUCT_SUITE` shipped this morning meaning something else.** F110 generated `RE_PRODUCT_SUITE`
and `PRODUCT_SUITE` from `theme.json`'s `product.suite`, deliberately unconsumed — that lane wrote
that editions would be its first consumer. D42 makes editions that consumer and changes what the
value means: `"Red Suite"` is not the umbrella, it is one edition's brand, and it belongs in the
edition manifest where the other edition's brand also lives. Leaving a global constant that names
one edition would make the entertainment build ship the business name.

The correction is small and belongs to whoever implements this: the brand moves into the edition
manifest, and `product.suite` is removed from the generated product block rather than quietly
redefined. `product.name` — the binary's own name, Red — is unaffected and stays exactly as it is.
`orchestrator/tests/product-name.test.mjs` asserts `PRODUCT_SUITE === 'Red Suite'` today, so the
removal is a visible edit to a test rather than a silent drift.

**A default layout is not an override.** The store already persists a workspace's layout, and D22's
draft/save rules and spec 038's recovery both depend on that persistence being the workspace's own.
An edition supplies the layout a *fresh* workspace starts with; it never reasserts itself over one a
person has arranged. An implementation that re-applied the edition layout on every start would
silently undo people's panes.

## The four open questions, resolved 2026-09-08

### 1. The names, corrected — and why

The owner: *"rEdit is the name for EDITOR in entertainment, RED Suite - business edition, red - editor"*,
because *"we had a CD Project Red studio with similar naming"*.

**The editor's name is per-edition**, and the reason is a real-world collision rather than taste: in a
games context "Red" borrows CD Projekt Red's identity; in a business context it does not. So:

| | Edition brand | The editor is called |
| --- | --- | --- |
| Entertainment | **rEngine** | **rEdit** |
| Business | **RED Suite** | **red** |

This **revises D42**, which said the binary keeps one generated name and editions brand it. One binary
still, but the *name it wears* comes from the edition. And it **revises D41 further**: rEdit was not
retired, it is the entertainment edition's editor name; `Red` is the family word that rEdit produced
and that the business edition wears.

**The live contradiction this creates, and it is in the tree right now.** F110 shipped with
`product.retired: ["rEdit"]` and a guard that fails the build when a retired name appears in shipping
code — verified on 2026-09-08: writing `"rEdit"` into any shipping file makes `design.py check` exit 1
naming it. rEdit is a live name again, so that guard currently rejects a correct one. The first
implementation task is therefore: the editor name comes from the edition manifest, `rEdit` leaves
`retired`, and the guard protects *whichever names are live* rather than one. Its purpose is unchanged —
no name is typed into shipping code — and F110's plumbing survives; only what it holds changes.

### 2. How the manifest gets there

An **install action in the suite**, now: `orchestrator/actions/install-edition.sh` creating the state
directory and writing the manifest, opening as a retained script tab like `restart-supervisor.sh` and
`integrate-project.sh`. A platform installer later calls the same code rather than reimplementing it;
packaging is still unresolved (KI-008) and this does not wait for it.

### 3. A workspace holding both streams

Nothing special happens: the install's brand wins. A workspace wears its edition's identity whatever
it opens, so adding Kohai to an entertainment workspace works and looks like rEngine. No rule to
remember, and no project is second-class for where it was opened. The alternatives — a status-line
note, or refusing the bind — were both rejected; refusing would stop the owner working across their
own projects in one window today.

### 4. What packs each edition names

Answered from the inventory rather than invented. **Entertainment** has three candidates and none is
finished: the renderer (D30, F61 still open), the owned microui controls (D33, which the owner already
called "part of our library packs"), and iklib (D23, its own repository). **Business has none yet.**
An edition naming zero packs is legitimate — it still carries a brand and a first-run layout — and a
business pack list will be written when a business pack exists.

## Open questions, deliberately not answered here

1. **What packs each edition actually names.** The mechanism is decided; the contents are not, and
   inventing a business pack list before a business pack exists would be fiction.
2. **Whether an edition is chosen or detected at first run.** D43 puts the manifest in the state
   directory but does not say how it gets there — an installer, a first-run choice, or a flag.
3. **What a workspace does when it holds projects from both streams.** Today's rEngine workspace
   binds `~/rengine`, `~/nolf-improved` and `~/vtmb-vr`; a person could add Kohai to it. The edition
   is per-install, so nothing breaks, but the answer to "which brand does the window wear" is
   currently "whichever the install declares", and nobody has said that is right.
4. **Whether `rEngine` as an edition brand collides with `rEngine` the repository and harness.** D01
   already anticipates the project being renamed to realEngine; if that happens the edition brand and
   the project name diverge, which may be a feature or a confusion.

## What this spec does not do

It records decisions and stops. No manifest schema, no inventory rows, no code — the work protocol
puts the spec before the implementation, and the build order is the owner's next call.
