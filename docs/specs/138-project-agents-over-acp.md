# Spec 138 — another project's agents in the editor, over ACP

Owner request, 2026-09-15: *"for kohai: integration with app an enable to drive kohai agents within
editor interface with added current computer use"*.

Status: **design; nothing implemented.** Rows F198–F200; the session kind they stand on is F114.

## What the codebase already decided

- **D46 chose the transport**: embedding an agent is "a later, separate step … and ACP is the
  transport it would use anyway". Its row is **F114**, unbuilt. Spec 129 left F114's language open;
  **D67 closes it — Rust**, a per-state-directory service in the D60 shape, so a conversation
  survives host replacement.
- **Kohai already speaks it.** `~/hirebase-v2/packages/acp-bridge` is `kohai-acp`, an ACP adapter
  over stdio. A session becomes a kohai task on its first prompt and **cannot be loaded back**
  (`loadSession: false`).
- **Approvals never ride ACP — that is kohai's decision, not ours** (its ADR 0098). A gated turn
  pauses and surfaces "approval needed" plus a link as an ACP plan entry, and the decision is made
  in Kohai. So the tab draws a *link* for a kohai turn, not an approve button.
- **The plugin ABI is the wrong door.** A plugin reaches nothing that touches the store, a session
  or the host connection (spec 106, `orchestrator/native/plugin_abi.h`). An agent is a session.
- **The registry already extends from outside** (`RENGINE_AGENT_REGISTRY_EXTRA`), and contract 6
  already admits "an installed executable" as a `cli`.
- **rEngine holds no kohai credential.** The bridge reads `~/.config/kohai/credentials.json`
  itself; this matches the standing rule that a credential never lives in a declaration (spec 095).

## The wall this feature meets, stated before it is built

`kohai-acp`'s `session/new` takes no parameters, and **nothing in the bridge reads `mcpServers`** —
zero occurrences across its source. Kohai's agents run as Mastra turns in Cloudflare Durable
Objects and take MCP servers from a server-side environment. **A cloud process cannot reach a
laptop's loopback.**

The ACP SDK kohai links (1.3.0) does carry `NewSessionRequest.mcpServers` and an experimental
`type: "acp"` MCP transport, where the server "is provided by an ACP component and communicates
over the ACP channel using `mcp/connect`, `mcp/message`, and `mcp/disconnect`". That is the
protocol's own answer for exactly this case — and implementing it is **kohai's work, not rEngine's**.

Therefore F200 builds the generic half and asserts nothing about kohai's consumption: rEngine
offers declared servers and reports, by name, which ones an agent did not take.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | A kohai agent enters the editor as **one ACP recipe** through F114. The tab, the session service, the transcript record and the Sessions row are the same for every ACP agent, and the local model of spec 139 uses them unchanged. | D46 applied |
| 2 | **F114 is built in Rust**: an ACP session service per state directory owning the agent child process and the transcript; the desktop's tab is a C view over that state. | D67, D60 |
| 3 | **The recipe is kohai's.** Its external declaration names `cli: "kohai-acp"`; its launcher supplies the recipe through `RENGINE_AGENT_REGISTRY_EXTRA`. rEngine's `registry.toml` never mentions kohai — a test greps for it. | AGENTS.md boundary: apps own their architecture |
| 4 | Contract 6 admits a **model-less ACP recipe**: `agents[].models` and `default` become optional when the resolved recipe declares `acp`; a non-ACP entry without them is refused exactly as today. | Recommended; recorded here |
| 5 | **Computer use is offered, not injected.** A project declares extra MCP servers; the workspace lists them at `session/new` beside its own; the tab names them; an agent that does not advertise matching `mcpCapabilities` has them reported as *not taken by this agent* rather than dropped silently. | Owner, 2026-09-15, choosing "Generic offer now, kohai implements later" |
| 6 | A session the agent cannot load back is shown **ended, with where it continues**, and its transcript stays readable. rEngine never invents a resume. | F114 criterion 5 |
| 7 | **One Agent tab for every ACP agent**, kohai and the local model alike — one C view to hold to D67's standard. | Owner, 2026-09-15 |
| 8 | The tab is held to **D67's consumer-side requirement**: transcript, composer, one button per decision, links as buttons, tool calls summarised in words. No protocol vocabulary on screen — a snapshot test asserts the strings "MCP", "ACP" and "JSON-RPC" never appear. | D67 |

## What this does not do

- It does not make kohai agents run locally, and it does not give them local tools until kohai's
  bridge implements the ACP MCP transport. That is filed as an external prerequisite and
  referenced, never asserted as done.
- It does not hold, mint or forward a kohai credential.
- It does not add an approval gate for kohai turns; that gate is Kohai's by its own ADR.
- It does not put a kohai persona, task model or vocabulary into rEngine.

## Open, and deliberately not decided here

Whether kohai implements the experimental ACP MCP transport. That is a ticket in kohai's tracker
(prefix `BAS-`), drafted at `docs/integration/kohai-acp-mcp-servers.md` for the owner to file. F200
passes on the generic behaviour and records what `kohai-acp` takes as measured fact.
