# Native C/microui desktop checkpoint

Date: 2026-09-05. Owner decisions D26–D27 replace the former Electron desktop with C/microui
and keep a later web interface separate. This is progress on the active NOLF goal; all 15
feature gates remain open. Earlier browser-specific tests have been retired, with history
retained at `916a204`.

## Build and provenance

macOS 15.7.3 (24G419), arm64, Apple Clang 17.0.0, CMake 3.31.2, SDL2 2.32.10.
`npm run build` now builds the C executable through CMake. No Electron, React, xterm.js,
CodeMirror, Playwright or esbuild package remains in `package.json`/`package-lock.json`.
The native executable uses microui, SDL2, stb text/font support, libvterm, cJSON and a static
loopback HTTP/WebSocket libcurl. `third_party/sources.json` hashes match every vendored source.
The curl archive SHA-256 is pinned in `orchestrator/native/curl.cmake`.

The local first build used an explicit `FETCHCONTENT_SOURCE_DIR_CURL` pointing to the official
8.22.0 archive extracted in the ignored build cache after verifying its recorded archive hash.
Fresh normal builds use CMake's verified archive download. There is no sibling-library lookup.
The separate Node service remains the process/file owner; this checkpoint does not claim its
replacement with C or a complete installable native package.

## Verified paths

| Check | Result / scope |
| --- | --- |
| `npm test` | All 19 retained service/PTY/file/agent/MCP checks pass, about 4.3 s. |
| CTest native layout/editor | Nested split/move/persistence, invalid graph rejection, fixed microui capacity, Unicode codepoint editing, undo and Vim mode-entry handling pass. Assertions remain enabled in Release tests. |
| `native.spec.mjs` | Actual C window, real project-tree file opening, executed PTY output, Unicode editor Save, external conflict/Discard, dirty editor drag to another pane, normal GUI close/restart draft recovery and same shell PID pass. |
| `native-game.spec.mjs` | Real SDL/GL producer streams native textures. Actual SDL relative capture, held W release on first Escape, next Escape delivery, retained process on GUI close and explicit asynchronous Stop pass. |
| `native-nolf.spec.mjs` | Actual NOLF main menu renders; native Enter reaches Single Player. GUI restart keeps the same game PID and subsequent frames; explicit Stop exits it. About 3.3 s of test work. |
| `native-agent.spec.mjs` | Installed Codex 0.153.4 boots through `scripts/agent.sh` in the native VT terminal for the real NOLF root. Its banner/TUI and project MCP bootstrap line are rendered. No coding prompt is sent. This proves startup, not full native MCP interaction. |

Native GUI tests run sequentially because concurrent windows compete for operating-system focus
and capture. The acceptance channel is opt-in local stdin JSON translated into ordinary SDL
events, plus read-only state and rendered BMP snapshots. No browser/CDP or remote UI endpoint is used.

The first PTY assertion was strengthened to distinguish executed command output from local echo.
A Vim check was corrected to position the cursor explicitly after undo; content undo and mode-entry
behavior remain asserted. The game check waits for asynchronous process exit after Stop instead of
treating the initial `stopping` response as an error. Native font rasterization follows drawable
density; glyph coverage still depends on the chosen font.

## Actual NOLF evidence

Host source: `9ec64e5c4682b29dc0d60f9af735b76ff3e90a8d`; its pre-existing working-tree changes
were preserved. The executable was copied into `.cache/native-nolf-4oLexl`; only `.rez` files in
`nolf`, `nolf/Custom` and `assets` were linked. All generated config/save/state files stay in that
isolated directory. The native adapter remains SHA-256
`a688af055cd30a47bae971abe0615a8a9fb86d82b42fc60f8c50185e63bba7f3`.

Inspected native-rendered evidence, retained locally:

| Artifact | SHA-256 |
| --- | --- |
| NOLF main menu PNG | `d3307977d8ac10bb06a6816af84e8304473e15e32f55ee8eafee3616d4a6fc05` |
| Single Player after Enter PNG | `5ef925ac801f56dd376ec6f4a4b8c43db678680e4ff4a66668649d80b382f599` |
| Native Codex startup PNG | `df9c344da188c7caa1a83c3f739494a9416008bb94f911186d4cefcbaf8139f6` |

Screenshots, assets, tokens, local paths/state and process logs are not committed as payloads.
Test-owned GUI/game/agent processes are stopped explicitly during cleanup.

## Remaining qualification

Repeat the complete normal launch-command workflow in the native GUI, including installed-agent
MCP/TUI interaction and multi-root scenarios. Native image previews, terminal scrollback/selection,
editor/Vim breadth, transport/failure recovery, actual in-level aiming, logical/drawable game input
mapping, packaging, CPU/memory/frame/input budgets and Windows runtime evidence remain open.
The pending Windows source-transfer rejection remains in force; no transfer to that host occurred.
The initial native executable is under 1 MiB on this build, which is not a memory/CPU budget pass.
