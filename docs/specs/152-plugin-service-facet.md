# Spec 152 — a plugin that is more than a module: the service facet

Owner, 2026-09-18, stopping an implementation in progress:

> *"Looks like we are violating plugins architecture by wiring in our core tools. JEV is a plugin and
> should be placed into `<root>/plugins` - we need some better plugin structure if there are both UI
> and server features"*

The correction was right and the violation was real: a JEV route had been added to `red_worker.rs`, a
`jev_triage` entry to red-mcp's **captured** `tools.json`, and a `red-jev` crate to the core cargo
workspace. That is a core feature with a switch on it, not a plugin. All of it is reverted; `red/` is
byte-identical to what it was.

Status: **design, with the JEV plugin as its first consumer.** Charter **D75**. Rows F232–F234.

## What a plugin is today, and what it cannot be

A plugin is a **pack with a `plugin` facet** (`contracts/project-v1.schema.json`): `{module, abi}` —
*"the RUN-time facet: a module the editor loads in process"* (charter D38, spec 106). It draws, it
clips, it measures text, it reads a theme colour, it takes pointer input inside its own tab, and it
reads `subject()`. `plugins/scene/` is the worked example.

What it has no way to be is **a capability that runs outside the window**. Anything needing the
network, a credential, or work that outlives a frame has nowhere to live — which is why the JEV work
drifted into core: there was no other shape for it to take.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **A pack may declare a `service` facet: an executable the workspace invokes.** The manifest names a command; the workspace runs it per call and speaks JSON over stdio. No long-lived process, no port, no lifecycle: a plugin's service that crashes takes nothing with it, and one that is never called costs nothing. This is the shape declared dashboard actions already have, and the shape `red-jev` was already written in. | Owner, 2026-09-18, choosing the service facet |
| 2 | **A service facet declares its own tools, and the workspace merges them only while the plugin is on.** The captured 38 in `tools.json` stay frozen and evidential — a guard defends their count, and it is what caught the violation. A plugin's tools are appended at list time and vanish when it is switched off, which is what makes the toggle mean something to an **agent** rather than only to a page. | Owner, choosing dynamic merge |
| 3 | **The merge is capped, and the cap is the answer to unbounded growth.** The owner's concern — *"we might have too many tools defined one day"* — is not answered by restraint, so: **at most 4 tools per plugin and 16 plugin tools in total**, refused **by name** when exceeded rather than silently truncated. A tool list that grows without bound costs every agent context on every call, and a limit nobody enforces is a wish. | Owner's concern, answered structurally |
| 4 | **A plugin's tools are namespaced by its name** — `jev.triage`, not `triage`. An agent reading its tool list can see which plugin put each one there, and two plugins cannot collide over a good name. | Recommended |
| 5 | **A plugin owns a directory under the state directory, named for it**, and core does not know what is in it. `<state>/plugins/<name>/` holds the plugin's settings, its credentials and whatever it records. Core reads exactly one file there — `enabled` — and never looks inside the rest. | Recommended; the `trackers/` precedent one level down |
| 6 | **The toggle is core's, the meaning is the plugin's.** Core owns "is this plugin on", because that is what the Plugins page edits and what gates the tool merge. Whether the plugin can *work* when on — a key present, a binary built — is the plugin's own answer, returned by its service when core asks it to describe itself. A plugin that cannot work says so in its own words. | Recommended |
| 7 | **The UI facet is unchanged, and JEV's tab needs no ABI movement.** A plugin tab already receives one string: `subject()`, the absolute path of what the desktop opened the tab for — this is how `plugins/scene` knows which `.obj` to draw. JEV's tab is opened on **its own record file**, reads it, and draws it. The host-to-plugin data channel that an earlier draft proposed as ABI v3, and that a review killed, is not needed and is not built. | Review finding 2, applied |
| 8 | **A plugin's service is invoked with the state directory and nothing ambient.** No inherited environment beyond what the manifest declares, and the working directory is the project root. What a service may read is its own state directory and what its manifest declares — the same rule a capability's state builder follows inside it. | Recommended |
| 9 | **A plugin teaches the agents, so nobody has to install a skill to discover it.** The MCP surface returns `instructions` at `initialize`; a plugin declares its own as a **file beside its manifest**, and the workspace appends them **while it is switched on**. An agent pane therefore knows the capability exists the moment it connects, and stops being told the moment the plugin is off. This replaces the vendor's own suggested bootstrap — *"Install the TypeSafe skill… run `claude plugin marketplace add`… or `npx skills add`"* — which asks a person to install, per agent, knowledge the workspace already has. Prose in a file rather than a string in JSON, so it is reviewable. | Owner, 2026-09-18: *"when plugin is enabled - any integrated agent should know about typesafe.ai without needing to bootstrap it with skill"* |
| 10 | **Instructions are capped exactly as tools are** — 4,000 characters per plugin, 12,000 in total, refused **by name** over the cap. Instructions are read on every connection, so their size is a tax on every agent; and they are refused rather than trimmed, because instructions cut in half still read as instructions. | The tool cap's reasoning |
| 11 | **A plugin declares the settings it needs and core never learns their values.** The manifest lists fields (`name`, `label`, `kind`, `detail`); the Plugins page renders them; the values go to the plugin's `configure` subcommand. A field of kind `secret` is **write-only by construction**: it can be set or replaced and is never read back, and the plugin reports only whether one is present. A setting the plugin did not declare is refused rather than passed through — an undeclared setting reaching a command line is an argument nobody designed. | Owner, 2026-09-18: the tab "should include Jev config (including editing already supplied api key, and later other providers eg. OpenRouter)" |

## The shape on disk

```
plugins/jev/
  plugin.json       the manifest: the service facet, its tools, its config, the UI facet
  instructions.md   what every agent is told while this plugin is on
  server/           the executable the workspace invokes (its own cargo crate, not in red/)
  ui/               the module the desktop loads, built against editor/plugin_abi.h
```

A second provider — OpenRouter was named — is either another declared field on this plugin or
another plugin entirely, and nothing above has to change for either.

`plugins/scene/` keeps its shape: a plugin with only a UI facet is normal, and so is one with only a
service facet.

## What this does not do

- It does not make plugins into long-lived processes, or give them a port.
- It does not let a plugin's tools into the captured declaration, which stays evidence.
- It does not move the plugin ABI, or add a data channel to it.
- It does not let core read a plugin's state beyond whether it is switched on.
