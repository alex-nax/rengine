# Known issues and open decisions

| ID | Issue | Consequence / next action |
| --- | --- | --- |
| KI-001 | Owner selected iklib as the first two-game library proof; exact profiles, parity measures and resource budgets remain open. | Complete `docs/specs/001-library-pilot.md`; shared command tooling remains supporting work. |
| KI-002 | The active NOLF workspace goal authorizes 15 scoped features; the larger proposal remains separate. | Follow `features.json` and F55. The historical interactive review is not a new implementation gate. |
| KI-003 | Powered-by minimum is confirmed as verified pinned capability adoption; its record format remains proposed. | Define exact capability/game/platform evidence rows. IDE/shared harness use stays optional. |
| KI-004 | Both engines use an optional local `infra-vr` source path. | Plan reproducible packaging without duplicating its reporting/backend work. |
| KI-005 | iklib host migrations are pending in its tracker. | Reference F131/F130/F133/F132; do not claim integration from presets alone. |
| KI-006 | Reference worktrees are active and contain edits. | Re-pin and recheck changed files before any actual integration. |
| KI-007 | No game, native library, device or training workload was executed during reconnaissance. | Treat inspected commands and past logs as reported evidence, not current green gates. |
| KI-008 | Future library license, distribution, platform and packaging policies are undecided. | Resolve at curation admission; no package publication or license declaration in setup. |
| KI-009 | Desktop v0 is macOS/Windows with a live NOLF tab, multi-root bindings, retained sessions/browser and basic editing/Vim with recovery drafts and explicit saves. The NOLF build baseline, toolkit, Vim subset and budgets remain open. | Complete the qualification inputs in `docs/specs/032-desktop-v0.md`; test terminal/editor/game surfaces, draft recovery and root isolation on both desktops. |
| KI-010 | Meta XR Operator has a documented native distribution, but neither game has been tested with it. | Verify actual runtime/graphics/profile compatibility and endpoint isolation; pane streaming is a separate requirement. |
| KI-011 | Quest distribution is supported in principle by upstream Android/PWA routes; no rEngine client or desktop link has been tested. | Prove paired sessions, keyboard/pointer input, game stream and package route on a real headset. |
| KI-012 | “Any app in a pane” has no universal proven mechanism. | Test native reparenting separately from capture/control; record per-app/platform support instead of a blanket claim. |
| KI-013 | Desktop UI, live NOLF surface and real agent-in-workspace proof are not implemented/verified yet. | Connect the tested sidecar to Electron/FlexLayout/CodeMirror/xterm, then prove the actual NOLF and CLI workflow. Keep the active goal incomplete. |
| KI-014 | Current sidecar/agent tests ran on macOS only. | Add Windows CI/native PTY/editor checks and actual Windows NOLF evidence before claiming the first desktop release. |
| KI-015 | Editor storage uses staged rename/version checks; power-loss durability and GUI checkpoint cadence remain unqualified. | Complete recovery behavior during editor integration; do not claim OS-level atomic compare-and-swap against external writers. |
