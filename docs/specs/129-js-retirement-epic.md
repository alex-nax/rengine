# The JS retirement epic (J0): hourly slices off the Node orchestrator

Date: 2026-09-11. Status: **decisions taken, rows filed.** Asked for by the owner: *"we need an
epic for js retirement thus I can set up a loop pointing this epic that every hour it takes a
little (spec'ed and documented) slice in favour of getting rid ourselves of js code. Rust is much
safer."*

This spec is the epic. It operationalizes charter **D57** (Rust is the orchestrator's target
language; retirement by strangler path) and the strangler sequence of
[spec 128](128-rust-retirement-and-companion.md), whose on-ramp rows F139–F145 (toolchain, proto
contract, façade, pairing, reachability, companion app) are filed beside these in lane **N0**.
The retirement slices live in lane **J0**, rows **F146–F165**.

## The loop contract

The owner runs an hourly loop pointed at this epic. The canonical loop instruction is:

> Read `AGENTS.md`, then this spec. Run `python3 tools/features.py next` and take the **first
> ready row whose milestone is J0**. Implement exactly that row to its acceptance criteria under
> the repository work protocol — failing check established first, bounded change, relevant gates,
> the real consumer path verified, `Codex-progress.md` entry, coherent commit. **One row per
> run, never two.** If no J0 row is ready, stop and say why. If the row cannot fit one run, stop
> and file a split proposal in `known-issues.md` — never land a partial slice.

Readiness is mechanical: every slice depends on the slices it truly needs, so `features.py next`
(ordered by priority, then id) always surfaces the correct next cut. A slice that is `ready` is
by definition unblocked; a slice that is not is nobody's invitation to improvise.

## Invariants every slice keeps

1. **The host's external API and the façade's proto contract do not change shape.** The native
   desktop, the phone, the agent panes and the scripts must be unable to tell which language
   answered. Any unavoidable change is a new contract version, not an edit.
2. **A slice deletes its JS in the same commit its Rust replacement passes.** No parallel
   implementations kept alive "just in case" — git is the rollback. The ported tests go red for
   their own reason at least once before they pass (the AGENTS.md regression rule), which
   normally means: port the test against the JS module, watch it pass, delete the module, watch
   the test fail for the absence, then implement until green.
3. **Coverage is ported, never dropped.** `orchestrator/tests/suite-coverage.test.mjs` is the
   ledger: every spec it names keeps a named check (Rust-side or native-side) or a recorded
   reason. A test that silently leaves the suite is invisible in a green report.
4. **Behavior discovered but undocumented gets documented in the slice's evidence** — the JS
   modules carry two years of load-bearing quirks (see the hazards below), and a port is the
   last good chance to write them down.

## Live-coupling hazards (read before taking a slice)

- **`agents/mcp-worker.mjs` is the connection every agent pane uses right now** — including the
  agent executing the slice. F150's cutover must land with a real pane of each CLI reconnecting
  to the Rust server; do the swap so the running pane survives (the pane's MCP is spawned per
  launch — only new launches pick up the change).
- **`build.mjs` injects `RENGINE_NODE_EXECUTABLE` into the CMake configure**, and the native
  desktop uses it to spawn the JS MCP worker. F150 teaches the native side to exec `red-mcp`;
  F163 removes the variable and the node coupling entirely.
- **`runtime/worker.mjs` is 736 lines and carries the layered-update protocol** (spec 065:
  completion distinct from acceptance) and token-frame forwarding (spec 095/101). F158 is the
  largest slice; if it does not fit one run, the loop contract says split, don't sprawl.
- **`server/tracker.mjs` re-implements the features.py readiness rule** and the schema
  description wrongly says it shells out (spec 114 finding 1). F153 ports the real behavior,
  not the documented one — and corrects the schema text.
- **`surfaces.mjs` focus eviction** (`:72-76`) is a deliberate, spec'd semantic. F152 preserves
  it verbatim; "improving" it is out of scope.

## The slices

Dependencies are the honest ones; `features.json` is authoritative, this table is the tour.
"Retires" names the JS deleted by the slice's commit.

| Row | Slice | Retires (JS) | Replacement | Proof |
| --- | --- | --- | --- | --- |
| F146 | Generated data for Rust | (nothing deleted; unblocks) | `tools/design.py` emits a Rust target beside `.mjs`/`.h` | `design.py check` fails on hand-written product name in Rust sources; rename rehearsal touches only `theme.json` |
| F147 | red-store | `server/store.mjs`, `server/schema.mjs` (260+) | Rust store, on-disk format unchanged | byte-exact read/write parity on the fixture corpus, both directions |
| F148 | red-agents I: registry as data | (registry.mjs's table becomes data) | one TOML recipe document parsed by JS (until F149) and Rust | resolved-recipe parity for every CLI; spawn env matches for kimi/claude/codex |
| F149 | red-agents II | `agents/registry.mjs`, `agents/config.mjs`, `agents/report-session.mjs`, `agents/bind.mjs`; `agent.sh` keeps its CLI, dispatches to Rust | `red-agents` binary | hook payload parity on recorded fixtures for all five CLIs; codex `codexHookKey`/`codexHookTrustHash` byte-exact vs the 2026-09-11 evidence fixtures |
| F150 | red-mcp | `agents/mcp-worker.mjs`, `runtime/tools.mjs` | Rust MCP stdio server on the façade/host API; native execs `red-mcp`, not node | fixture-identical `tools/list`+`tools/call`; **one live pane per CLI** completes an action through the Rust MCP |
| F151 | red-pty | `server/sessions.mjs` (305) | Rust PTY retention on `portable-pty` | spawn/attach/scrollback/resize/kill per the ported terminal suite; retention across host restart (spec 059/060) |
| F152 | red-host I | `server/main.mjs`, `server/desktops.mjs`, `server/surfaces.mjs`, `server/surface-protocol.mjs` | Rust host core | native desktop connects with zero native changes; focus-eviction semantics verbatim; surface suite green |
| F153 | red-host II | `server/tasks.mjs`, local half of `server/tracker.mjs` | Rust local tracker + serialized `tracker.write` | byte-compared rows for this repo's own `features.json`; exactly-once ordering under two writers |
| F154 | red-host III | remote half of `server/tracker.mjs`, `server/tracker-auth.mjs` | Rust GitHub/Linear read-only providers | denied/unavailable/invalid taxonomy identical on recorded fixtures; writes refused by name |
| F155 | red-host IV | `server/dashboard.mjs`, `server/dashboard-rules.mjs`, `server/devices.mjs`, `server/device-rules.mjs`, `server/games.mjs`, `server/game-rules.mjs` | Rust dashboard/devices/games | availability composition and preflight identical on the native-dashboard/native-devices scenarios |
| F156 | red-host V | `server/formats.mjs`, `server/images.mjs`, `server/recordings.mjs` | Rust formats/images/recordings | preview budgets/paging and recording reads identical on the format-hardening and recording fixtures; image sniffing parity on the fuzz corpus |
| F157 | red-feed + red-token | `runtime/feed.mjs`, `runtime/token.mjs` | Rust feed + token protocol | token frames byte-identical to the pinned shapes; contest/reject/transfer/retire per spec 095/101 on the ported e2e |
| F158 | red-worker | `runtime/worker.mjs` (736) | Rust root-bound worker | MCP routes, token/recording forwarding, layered updates with completion≠acceptance; hot-update suite retains every session across replacement |
| F159 | red-supervisor + launchers | `runtime/supervisor.mjs`, `launcher/headless.mjs`, `launcher/replace.mjs`, `launcher/restart-supervisor.mjs`, `launcher/sidecar.mjs` | Rust supervisor + launchers | restart-supervisor keeps its no-bypass confirm and read-only `--plan`; spec 098 host replacement preserves PTY host and CLI; spec 090 headless works |
| F160 | red-client | `runtime/client.mjs`, `runtime/discovery.mjs` | Rust routine-update CLI | update_status/update_workspace identical against the Rust host; discovery keeps spec 101's distrust rules |
| F161 | red-ide | `runtime/ide.mjs`, `runtime/lsp.mjs` | Rust editor integration | lock discovery honors `CLAUDE_CONFIG_DIR` (F113 repair) and the editor-as-IDE distrust rules; LSP per spec 079 or recorded re-scope |
| F162 | red-util | `runtime/scripts.mjs`, `runtime/windows.mjs`, `runtime/desktop.mjs`, `runtime/bootstrap.mjs`, `orchestrator/external-project.mjs` | Rust script tabs, project windows, bootstrap | spec 071 script-tab and spec 069 dogfooding semantics identical on their suites |
| F163 | Entry points | `orchestrator/build.mjs`, `orchestrator/launch.mjs`, `orchestrator/prepare.mjs`, `package.json`'s runtime role | cmake/cargo are the only entry points | `RENGINE_NODE_EXECUTABLE` and the build.lock dance replaced; `node_modules` not needed to build or run; no gate references `npm test` |
| F164 | Suite sunset | `orchestrator/tests/*.mjs` | Rust-side + native-side suites | every suite-coverage row has a named equivalent or recorded reason; `node --test` in no gate; `./init.sh` passes with no node installed |
| F165 | **Epic close: node-free dogfood day** | node itself | — | one full dogfood day on the Rust-only stack (every CLI's panes, terminals, updates, recordings, dashboard actions, this MCP), evidence in `Codex-progress.md`; AGENTS.md's D57 bullet rewritten past tense |

After F165, `node` is gone from the boot path and this epic is complete. What remains in JS by
design: nothing. What remains in other languages by design: the C desktop and companions
(charter), the Python tools (charter), and the games' own stacks (their authority).

## Bookkeeping

- Rows F139–F165 filed in `features.json` on 2026-09-11 with this spec and spec 128 as their
  documentation; `docs/roadmap.md` gained the N0 and J0 lanes; the graph was regenerated.
- The N0 rows F144/F145 (companion app) dangle off F143 and are **not** on the J0 loop's path —
  they advance through ordinary `rengine-continue` sessions.
- F114 (ACP session kind) stays the open O2 row; it is unaffected by this epic and may land in
  JS first (retired later by F148/F149's data-driven registry) or wait for Rust — either is
  consistent with D46.
