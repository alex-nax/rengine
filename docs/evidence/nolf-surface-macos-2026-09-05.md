# macOS NOLF surface qualification checkpoint

Scope: existing game launch, rendered menu, native keyboard input, pane movement/detach,
normal GUI restart, same-process reattachment and explicit Stop. Full gameplay and the broader
desktop feature criteria remain open. No NOLF source or asset edits were made by this work.

- Host: macOS 15.7.3 arm64, Node 25.3.0, AppleClang 17.0.0, SDL2 2.32.10.
- NOLF checkout HEAD: `9ec64e5c4682b29dc0d60f9af735b76ff3e90a8d`, branch `integ/2026-09-05`.
- Existing NOLF executable SHA-256: `85761e577b977919cbfb61b72e2c8d8f4f22cb8625f4174e34dd0797f220365e`.
- Native adapter SHA-256 during run: `a688af055cd30a47bae971abe0615a8a9fb86d82b42fc60f8c50185e63bba7f3`.
- The host worktree retained its pre-existing untracked handoff/diagnostic files and dirty SDK
  submodule. The executable hash identifies the actual tested build; HEAD alone is not its pin.
- Command: `RENGINE_NOLF_ROOT=/Users/alex/nolf-improved node --test orchestrator/tests/nolf.spec.mjs`.
- Latest strengthened result: pass, about 11.1 seconds. Observed PID 80221, 111 frames before interaction, 960×600,
  all 256 channel values. The host's local display configuration selected 960×600 despite launch
  dimensions of 1280×720; the pane followed actual frame dimensions.
- The menu input check compares the lower menu's dark text pixels before/after Enter and the
  inspected screenshot shows Single player. It does not infer input success from frame count.
- After a tab drag with an asserted change in pane position and close, GUI restart and Session browser reattachment, the same game PID
  continued streaming. Explicit Stop reached the actual exited state.
- Native SDL fixture separately passed key-down/release color changes, bottom-row orientation
  and restoration of pixel-pack alignment/row length; about 13.4 seconds, exit 0.

Local evidence (ignored, contains rendered proprietary game content):

| Artifact under `.cache/evidence/` | SHA-256 |
| --- | --- |
| `nolf-single-player.png` | `6f521936b576e6085e24cfc00a14407f10e84fbf063ad4fdc5d20e0413165996` |
| `nolf-reattached.png` | `92f600e6ccd3e3fb19c8b975c143c5de8fddad033cfa7abed20958a93480d138` |

The first NOLF test run failed because its browser polling expression converted an unawaited
Promise to a number. After correcting that check, live frames passed; the subsequent expanded
input/lifecycle test also passed. This test-code failure is not a runtime pass or a game failure.

The earlier drag assertion proved that the process survived the gesture, but did not verify a
new pane position. The stronger check exposed that Playwright's short drag emitted no drop on
this profile. Intermediate pointer movements now generate dragover/drop, and the test asserts
the live canvas moved into the destination pane. This latest run supersedes the earlier move
claim and refreshes the local screenshot hashes above.
