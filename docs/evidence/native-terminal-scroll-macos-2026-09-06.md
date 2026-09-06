# Native terminal history evidence

Date: 2026-09-06. Parent checkpoint `59b52ea0986403191d49ae84aa3c81a71289dac6`.
Scope: [spec 060](../specs/060-native-terminal-scrollback.md), owner-reported inability to scroll
the currently running agent pane. This is an F36 slice; no complete feature gate changes.

The resumed agent environment identified `a0de60fe-eac8-4e75-8ea8-fe8f4aa3c83a`. Both actual
root-bound MCP calls returned `/Users/alex/rengine`, the matching running agent PID 20049 and
`waitingForView: false`. Development took place in this verified pane; the test never resumed
or created another coding-agent conversation. Existing owner sessions were left running.

## Regression and checks

Before implementation, a real PTY emitted 150 numbered ANSI/Unicode rows. Native wheel input
left only the newest screen visible; waiting for `HISTORY_100` failed. After implementation,
the same consumer test passed. Expanded checks cover:

- Older colored rows and Unicode cell text through native wheel and Shift+Home/PageUp/End.
- New PTY output while browsing preserves the visible text; typing returns to a real input reply.
- Actual alternate-screen output leaves primary history unchanged; returning restores the prompt.
- Native width/height changes and a tab move; hovering the left terminal scrolls its history
  while keyboard input still executes in the focused right shell.
- GUI close/restart preserves both PIDs and reconstructs available history from the same PTY.
- C checks exercise fractional/flipped wheel deltas, alternate-screen isolation, CSI 3 J history
  clearing, 2,000-line/8 MiB limits, stable viewed text under output and fresh-snapshot replacement.

An optional local replay of the ended Codex session's 803,215 retained ANSI bytes passed the
same native test plus scrolling its rendered history and returning to the live screen (5.55 s).
The source recording is the ignored file described in Session 16's recovery evidence, not a
new provider run or training export. Screenshots were inspected: colored early rows and the
position label render, and the replay exposes earlier actual Codex output in a narrow pane.
The selected system font lacks the tested CJK glyphs; parsed cell text is retained correctly.

## Final commands and artifacts

| Command | Result |
| --- | --- |
| Isolated `npm test`, removing inherited handoff context for test children | 20 passes, 4.29 s |
| `npm run test:desktop` | Build and six native tests passed, 39.54 s |
| `ctest --test-dir .cache/desktop --output-on-failure` | Three passes, 0.56 s |
| `RENGINE_TERMINAL_REPLAY=/Users/alex/rengine/.cache/session16-codex-replay.ansi node --test orchestrator/tests/native-terminal-scroll.spec.mjs` | Passed, 5.55 s |
| `./init.sh`, metadata and diff checks | Passed; inventory unchanged |

| Local ignored artifact | SHA-256 |
| --- | --- |
| `.cache/desktop/bin/rengine` | `fea432e0afdcca3afc9e58c3a5fddb482f76f07171b842d29ee9b35a15ea7c53` |
| `.cache/evidence/native-terminal-scroll.png` | `bcff8e24d5a75b828a0ca2b54f338e52ac75008564e0c2031b513022bf0c7193` |
| `.cache/evidence/native-terminal-scroll-replay.png` | `06318e615a29f4dae516d435773d7ac2dbe2980f96449094d2229e5570da7322` |
| `.cache/session17-scroll-red.log` | `ebf7fb8e6564bd369daac961674d7ad650adaf31aab740900d21bf7bbcc8500e` |
| `.cache/session17-scroll-replay.log` | `60fdb786334f6d4c4354f9c4ea08b3379f6fb2ecc19c08ed92fee7ac0b446662` |
| `.cache/session17-desktop.log` | `cd090e686c4a04e05f160353bc239050a223ae3a56c9f81fa12dcbfdb25526c2` |
| `.cache/session17-service.log` | `9379ee05cb69181346f280bed7de4381bc8a1d373882dd49d9129214885d347c` |

History is per native view, capped and reconstructed from the service's existing bounded raw
output. Old-width rows are clipped/padded; history reflow, selection/copy, saved scroll position,
complete font coverage and Windows runtime qualification remain open. Reload is required for an
already-running desktop to load the implementation; its sidecar and CLI remain retained.
