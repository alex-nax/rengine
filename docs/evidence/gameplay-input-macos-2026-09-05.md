# NOLF gameplay input qualification checkpoint

The game pane now releases mouse buttons when a press begins inside the canvas and ends
outside it. The failing native regression received button-down and W-down but no button-up.
Pointer capture fixes that delivery; normal mouse-up preserves held movement. Unexpected capture
loss, cancellation and pane blur release controls, and the next focused key-down reacquires
sidecar input ownership even when DOM focus never changed.

`node --test orchestrator/tests/game-input.spec.mjs orchestrator/tests/sdl.spec.mjs` passes both
checks (about 13.1 seconds total). The input check uses actual Electron actions and a native SDL
process: outside release, W still held until its key-up, right-button capture loss, subsequent
keyboard recovery, chorded left/right releases and focus loss. The GL check still verifies
orientation, key-driven pixels and restored pixel-pack state. The simple fixture's added event
logging needs no separate commentary sidecar. These checks do not claim pointer lock or NOLF
playability by themselves.

## Actual world and movement

macOS 15.7.3 arm64, Node 25.3.0, Electron 44.2.0, SDL2 2.32.10. Host checkout HEAD and preserved
pre-existing changes match [the native surface checkpoint](nolf-surface-macos-2026-09-05.md).
Copied executable SHA-256: `85761e577b977919cbfb61b72e2c8d8f4f22cb8625f4174e34dd0797f220365e`.
Adapter SHA-256: `a688af055cd30a47bae971abe0615a8a9fb86d82b42fc60f8c50185e63bba7f3`.

The disposable root copied the executable and linked archive files only. Config, caches and
autosaves were written under that root; the owner's saves/config were not used or overwritten.
The actual desktop launched NOLF PID 20023, session `d2ce94dc-a7f7-4e5b-a697-2539da82f9fe`, at
1280×720. Enter through Single player, mission selection, The Assignment and difficulty reached
the briefing; Enter started the world. Escape skipped opening cinematic sequences. Native logs
record `Worlds\t01s02`, 401 spawned entities, the isolated autosave, cinematic end at `(800 94 -1664)`
and transition to playing state.

Inspected screenshots show the playable UNITY lobby. Holding A for 700 ms moved left relative
to the fixed benches/wall columns; holding W for 900 ms moved forward beside the central bench.
Later screenshots after release preserve the camera's location relative to fixed geometry while
the rotating sculpture/characters continue animating. This is qualitative movement/release
evidence, not a measured speed or numerical pose assertion. The same game remained live beyond
7,600 frames. Mouse locking failed, so relative aiming is explicitly **unverified**.

Local artifacts under `.cache/gameplay-direct-hUd8en/` remain ignored:

| Artifact | SHA-256 |
| --- | --- |
| `before-move.png` | `13e7cee513aa7afd75fadafaa3803a22e692e7a5cfdba6ee4a466dfe56e85eb4` |
| `after-strafe.png` | `785f313b97664f090699008a89655c66cc3b472bc4c37fd60b51d4f901a4a355` |
| `forward.png` | `df53b0dc929b9aada9d24daf2d399988edb3a420766d66af6b5d801a5832459f` |
| `forward-released.png` | `31d491127df315b9040cf7dfb1c8f6d4f09fca6bad645be3e72ff2988814ea5b` |
| `game.log` | `18dca9e411d8ca3cd9ebd3fbc8b5d036050d7f146b9ff98c63dad8df50c5028c` |

## Qualification tools and remaining conditions

After building the UI/native adapter, run the explicit macOS interactive probe:

```sh
RENGINE_NOLF_ROOT=/absolute/checkout node orchestrator/tests/gameplay-probe.mjs
```

It prints the isolated runtime, desktop/game PIDs and session ID. Send JSON lines on stdin,
for example `{"key":"Enter"}`, `{"hold":"w","ms":900,"shot":"forward"}`,
`{"click":"Capture mouse"}`, `{"move":[800,400]}` and `{"shot":"world","log":1000}`.
`{"quit":true}` stops this probe's game/desktop and writes local logs. This utility never marks
a feature passed. The checked-in version was separately launched, navigated to Single player,
and quit with a `closed: true` report and process exit 0. Its inspected menu screenshot under
`.cache/gameplay-direct-1uYiew/menu-check.png` hashes to
`eec0893ecb9787bace3539634d025640ff29c39265a40a4760c8e2cdb549e310`.

The first sustained Playwright probe stalled after world entry. Its Electron main-process
footprint reached 6.2 GiB in a one-second sample; the renderer was about 233 MiB RSS. Playwright's
installed network manager enables `Network` and subscribes to every WebSocket frame, copying the
raw video stream through inspection. Direct CDP input/screenshots without that domain stayed
responsive in the same world, with main-process RSS 143,824 KiB at a sampled point. This supports
inspection overhead as the explanation, not a proven general memory/performance budget.
The interactive probe therefore uses [CDP input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)
and [screenshots](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
without video-frame tracing. Short Playwright UI checks remain separate.

Mouse lock returned `WrongDocumentError` before the permission callback. The native fixture
confirmed DOM focus but no native window focus, even after explicit activation and a five-second
poll. A read-only CoreGraphics session query returned `CGSSessionScreenIsLocked = true`.
Chromium's [macOS pointer-lock gate](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/renderer_host/render_widget_host_view_mac.mm)
requires native focus and a key window, consistent with this failure. No session unlock or
permission bypass was attempted. An owner request to unlock the Mac is pending.

On an unlocked active console, run
`RENGINE_REQUIRE_POINTER_LOCK=1 node --test orchestrator/tests/game-input.spec.mjs` to require the
additional native-focus, lock and Escape-release subtest, then verify aiming in the real game.
The ordinary input test covers button capture/release only; it cannot close this extra gate.
Windows source-transfer approval, Windows host integration, drawable/logical DPI conversion,
relative aiming across pane sizes, performance budgets and broader failure recovery remain open.
No feature or goal completion is claimed.
