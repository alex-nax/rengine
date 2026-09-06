# Native terminal mouse reporting — macOS

Date: 2026-09-06. [Spec 063](../specs/063-terminal-mouse-reporting.md) repairs the owner's
unclickable/unscrollable Claude fullscreen pane under the active F36 scope. All feature gates
remain false; no live Remote Control operation, new provider conversation or Windows pass.

## Observed consumer and regressions

Root-bound MCP and `RENGINE_ORCHESTRATOR_SESSION` again identify the current rEngine agent.
The selected retained Claude session is `00014b6f-d2a4-4f18-9a1a-1bee12785b19`, PID 92674.
A private read-only snapshot contains 583,846 characters at sequence 11483, columns 143/rows 38.
Its actual stream requests alternate screen 1049 and tracking 1000/1002/1003 with SGR 1006.
No input was sent to that live conversation. Official Claude mouse requirements and the separate
meaning of `/rc` are linked in spec 063; no Claude-specific runtime branch was added.

The pre-fix real PTY/native pointer check failed to change ITEM closed after a native click
(8.71 s, `.cache/session19-mouse-red.log`). The initial repair passed basic and expanded checks,
but actual-stream replay exposed a backlog of obsolete cursor-query replies. A separate native
check also proved GUI close lost the last held mouse-up (6.83 s, mouse-detach-red log).

The terminal now uses libvterm's negotiated tracking/encoding for buttons, hover/drag and signed
precise wheel input. Logical cell coordinates exclude chrome/gutters, keep old-history clicks
local and clamp a held release outside its originating pane. Focus, pane movement and view close
preserve process/root ownership. Snapshot reconstruction creates a fresh emulator and suppresses
historical query replies; live queries still reply. Close/reload releases holds before waiting
for queued/in-flight outgoing transport, with a visible two-second cancellation if still busy.
That drain is transport completion, not an application acknowledgement; lost/offline input remains
discarded. Upstream sources are unchanged.

## Final checks

Test children remove only the live conversation's `RENGINE_HANDOFF_FILE` and
`RENGINE_HANDOFF_GATE`. Commands below run with normal local loopback/PTY/native-window access.

```sh
env -u RENGINE_HANDOFF_FILE -u RENGINE_HANDOFF_GATE npm test
env -u RENGINE_HANDOFF_FILE -u RENGINE_HANDOFF_GATE npm run test:desktop
ctest --test-dir .cache/desktop --output-on-failure
env -u RENGINE_HANDOFF_FILE -u RENGINE_HANDOFF_GATE \
  RENGINE_MOUSE_REPLAY=/Users/alex/rengine/.cache/evidence/claude-mouse-session.json \
  node --test orchestrator/tests/native-terminal-mouse.spec.mjs
```

- Service/MCP: 21 passes, 4.41 s.
- Native desktop: eight passes, 48.00 s, including previous keyboard/MCP reload, game fixture,
  pane navigation, scrollbars, terminal history, burst/reconnection and editor/PTY workflows.
- CTest: three passes, 0.58 s.
- Actual recorded Claude replay: pass, 9.03 s. An isolated real PTY replays the selected stream,
  reattaches with its requested mode, emits no historical query replies, delivers SGR click/wheel
  packets and still answers a new live cursor query. This proves native protocol delivery, not a
  live Claude menu action or live Remote Control availability.
- Native mouse checks cover clickable state, application scroll state, fractional/system signs,
  horizontal wheel, negotiated click/drag/hover modes, legacy X10, modifiers, primary and alternate
  screens, local history override, old-history click suppression, resize, pane movement, keyboard
  focus isolation, same-PID reattachment and final release on GUI close.
- Screenshots inspected: the item is expanded with application SCROLL 2 after moving/reopening,
  while the other shell retains keyboard focus. Actual recorded content is clipped/wrapped in
  the narrower replay pane; its screenshot is not proof of a faithfully resized live Claude UI.
- Harness/inventory, source-size/document-link checks, reviewed sidecar validation and diff checks pass.
- Final native tests include concurrent theme commit b86f953. Its five stale sidecar source
  fingerprints were reviewed and refreshed without changing their notes or the theme code.
  Feature inventory/criteria and generated roadmap graph are unchanged.

An initial sandboxed service run failed loopback access and was terminated. The first unrestricted
baseline had 20 passes and one unrelated failure because the custom-launcher fixture inherited
the real handoff file for another project; the isolated environment passes (KI-031). The first
full desktop build transiently reported its just-built static archive missing; the archive was
present on inspection, no build remained running, and one sequential rerun built and passed all
checks. Its cause is unestablished; the failed log remains local instead of being counted as a pass.

## Live state and limits

At completion, root-bound MCP still reports Claude PID 92674, this Codex PID 20049 and original
shell PIDs 33500/39735 running. Tests clean only their own fixtures. The tested build loads with
Cmd/Ctrl+Shift+R. The original retained service/connector still lack agent desktop-action support;
this turn does not restart them or repeat the previously denied OS shortcut injection. No live
reload or live Claude click result is claimed. Windows qualification, broader terminal clipboard/
hyperlink/keyboard compatibility and KI-024 NOLF menu-state work remain separate, with existing
Windows-transfer and optional service-migration approval boundaries preserved.

## Local SHA-256 evidence

Recordings/screenshots/logs stay ignored and private; only their hashes are tracked.

| Artifact | SHA-256 |
| --- | --- |
| `.cache/desktop/bin/rengine` | `df3816eaeee09fb70c03520ba5e162398c1db803edb5ff1bf895b3cbb74c21cd` |
| `.cache/evidence/native-terminal-mouse.png` | `71ddfe4ff130523137d6ff52b8a03a2f77da85147fb68104e56ab02158568946` |
| `.cache/evidence/native-claude-mouse-replay.png` | `5e14483ed5627a63042eee87d2650e3545923f9b77632231a9c9d12e9b42f94d` |
| `.cache/evidence/claude-mouse-session.json` | `9dbe2853310f586c9cceca0a492fd03f26b7a1c06f5831f3afb4626abad9451a` |
| `.cache/session19-mouse-red.log` | `d0e123a0702819b7ad185a1374ff598ab3d8809e78c9df8ea03e3ecfde8dd20c` |
| `.cache/session19-mouse-detach-red.log` | `156ea5a9d3f21868bed13b40f448dff684e6c572c412f2f87058198902350ba7` |
| `.cache/session19-claude-final.log` | `9a135442e5a4a4666a79fe9115642fecd25411f1236082a381b45ee0f46acf16` |
| `.cache/session19-desktop-final.log` | `d48cf271f99626f3baa0f5a765c514c9660cc32e9c47a701bad05594f96c13ca` |
| `.cache/session19-service-final.log` | `b472c705dd2e2d81a3ba6a12ade865247c86b704bc94569c185ad52d71acb1df` |
