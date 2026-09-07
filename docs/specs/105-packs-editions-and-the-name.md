# Packs, plugins, editions, and the name (charter D38–D41)

Date: 2026-09-07. Status: **design interview complete; nothing implemented.** Produced by `/grill-me`
with the owner, who opened it with: *"we want to design extension system and library packs, seen as
we went beyond game development we might need game different editions, like rEdit for business or
entertainment, recently I've thought of naming rEdit -> red, integrated tool suite, like 'Red suit'"*.

Every decision below is the owner's, taken in three rounds. Where a recommendation was overruled it
says so, because the reasoning that lost is the useful record.

## What the codebase already decided, and was not asked

- **Extensions already exist, declaratively.** `contracts/project-v1.schema.json` carries ten blocks
  across contracts 1–8 — formats, dashboard, games, devices, title, icon, tracker, agents,
  languageServers, wordmark — each added the same way: a schema block, a `SECTIONS` entry with a
  minimum contract, and rules. Executable parts are **declared commands** under the declared-command
  boundary. This is the baseline the new system extends, not a blank page.
- **The draw list is already a versioned C contract.** `render/draw_list.h` is
  `RE_DRAW_LIST_VERSION 2`, a command enum replayed identically by the SDL, OpenGL, Metal and Vulkan
  adapters (specs 066–067). It is the ABI a plugin needs, and it already exists.
- **The desktop is a layer whose loss is survivable.** Proven the same day: a supervisor restart
  closed the window and reopened it with all 13 sessions intact on session host 33465. Sessions,
  drafts and agents live on the host; the window does not hold work.
- **"Library" is already owner-defined**: curate upstream and author gaps (D01, D08), prove one in
  two games first (D09), iklib selected (D23), *"Powered by rEngine" = one curated capability at a
  pinned version with passing game integration checks* (D24). Licensing, distribution and packaging
  remain open (KI-008).
- **"Library packs" is the owner's own existing phrase.** D33, 2026-09-06: owned microui control
  additions *"will be also part of our library packs"*. Today's answer that a pack is one concept
  therefore continues a decision rather than starting one, and D33's controls are the second thing —
  after iklib — that the pack format has to fit.
- **The name already reaches only four strings in code** — `RE_DEFAULT_TITLE` (app.h), `IDE_NAME`
  (runtime/ide.mjs), the LSP `clientInfo.name`, and the OAuth callback page — plus documentation.
  And D01 already anticipates renaming: rEngine is *"eventually called realEngine"*.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| D38 | **An extension is an in-process native plugin.** It draws by appending to the draw list — already `RE_DRAW_LIST_VERSION 2` and backend-neutral, so a plugin author never touches a graphics API — and registers tabs and controls through the owned control layer (D33), never through pristine microui's context, which stays private. Plugins are declared by the project, with `root.declarationFile` (F81) for a project that cannot hold files; no installed registry, no required `~/...` path, no hidden download. | Owner, 2026-09-07, **overruling the recommendation**. Declared-commands-only was recommended as needing no new trust and no ABI; the owner chose in-process. The recommendation lost on capability: an extension that cannot draw is not an extension. |
| D39 | **A pack is one pinned, versioned artifact with declared facets.** A `library` facet is source and a CMake target a game consumes at build time; a `plugin` facet is a module the editor loads at run time. iklib declares one, an editor extension the other, and the renderer (D30) is expected to declare both. One word, one unit, one pinning story. | Owner, 2026-09-07; the alternatives were a `kind` field per pack or a metadata-only wrapper |
| D40 | **An edition is a declared bundle of packs over one binary.** "Red for business" is a manifest naming packs and branding, not a fork and not a build flag: no build matrix, no per-edition gate runs, and moving between editions is a change to what is declared. | Owner, 2026-09-07 |
| D41 | **The product is Red; the umbrella is Red Suite.** This **revises D36**, which made `rEdit` the default workspace title. In the same change the name stops being hard-coded: it becomes generated the way theme tokens are, so this rename is a data edit and the next one is too. `IDE_NAME` is externally visible — it is what Claude Code prints in other people's `/ide` menus — so the rename is a published change, not an internal one. | Owner, 2026-09-07: *"naming rEdit -> red, integrated tool suite, like 'Red suit'"* |
| D24 (clarified) | **"Powered by" is defined on the library facet.** A pack adopted at a pinned version through its `library` facet, with passing game integration checks, earns the claim; an editor plugin does not. The facet distinction of D39 rescues D24 exactly as written rather than redefining it. | Owner, 2026-09-07 |

## What a plugin crash costs, decided rather than discovered

In-process means a plugin fault can take the window down, and that was accepted knowingly: **it costs
the window and its layout, never a session.** The desktop is a supervisor-managed child that reopens
on the layout the store kept, and every terminal, agent and draft belongs to the session host. The
supervisor restart run earlier the same day is the evidence — the window died, 13 sessions did not.

This is a boundary, not an aspiration: anything a plugin could destroy that is *not* recoverable by
reopening the window would break the decision. Plugin access to the store, to sessions and to the
host connection is therefore outside D38's grant, and a later spec that wants to widen it has to say
so against this paragraph.

## A clause of D38 that cannot be implemented as written

Found by the implementation, recorded here rather than quietly narrowed. D38 says a plugin
"registers tabs **and controls** through the owned control layer (D33), never through pristine
microui's context". Those two halves conflict: every one of the fourteen owned controls in
`orchestrator/native/ui/ui.h` takes `mu_Context *` as its first parameter, by D33's own design. A
plugin can therefore register a **tab** — that goes through the app's own tab model and needs no
context — but cannot call a control without being handed the very thing the clause keeps private.

ABI v1 ships tabs and drawing, and no controls. Widening it needs a control handle that is not
`mu_Context`, which is a later ABI version's design; `docs/specs/106-plugin-abi.md` decision 8 holds
the detail. The decision is not wrong about the boundary — the owned layer *is* the right door, and
microui's context *should* stay private — it is under-specified about what a plugin holds when it
walks through it.

## A constraint the plugin ABI creates for the design lane

`render/icons.h` is included by the plugin header, so `RE_ICON_*` numbering is now frozen for every
plugin compiled against ABI 1. `design/icons.json` must be **append-only** from here: reordering or
removing an icon silently changes what an already-built plugin draws. Recorded in `known-issues.md`
because it binds a lane that has no reason to read this spec.

## Open questions, deliberately not answered here

1. **The plugin ABI's own versioning.** The draw list is versioned; the registration surface a plugin
   links against is not designed yet. Whether plugins are rebuilt per desktop version or a stable
   ABI is maintained is the first question of the implementation spec.
2. **Where a pack's bytes come from.** D38 fixes *declaration*, not *acquisition*. KI-008 still holds:
   licence, distribution and packaging are unresolved, and "no hidden downloads" constrains whatever
   answers it.
3. **What a business edition actually contains.** D40 fixes the mechanism; nobody has said which packs
   make an edition, and inventing that list is not this spec's job.
4. **Windows.** Loadable modules are `dlopen` on macOS and `LoadLibrary` on Windows, and the desktop
   suite's Windows repair (KI-038) is still outstanding. The first plugin spec has to say what it
   does on the platform that is not yet green.

## What this spec does not do

It records decisions and stops. No inventory rows, no contract bump, no rename — the work protocol
puts the spec before the implementation, and the implementation order is the owner's next call.
