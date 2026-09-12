# F176 (F151a) — red-pty: the PTY core in Rust, scenario-parity with the JS host (2026-09-13)

The core half of F151 (spec 129, KI-096, filed under the KI-092 standing rule). `red-pty` on
portable-pty runs retained PTY sessions behind the F174 channel shape (`red-pty-serve`,
newline-delimited JSON-RPC + output/session event lines); `orchestrator/server/pty-client.mjs`
is its thin client with the loop-retention discipline F175 established. One scripted scenario
set drives BOTH the real JS `Sessions` class and the service and they agree everywhere a person
can look. Nothing deleted; the retention architecture is F177, the swap is F178.

## Acceptance criteria and where each is proved

1. **Spawn/attach/scrollback/resize/kill behave identically on the scenario set.**
   `orchestrator/tests/pty-service.test.mjs`, seven scenarios, both drivers compared per scenario:
   - echo + exit code (output byte-exact, state, exit code),
   - a 300 KB paste arrives whole (`head -c` counts what actually arrived — a lost byte stalls
     it; raw mode and a READY marker because canonical mode and startup races are platform
     truths, not ports),
   - resize changes what `stty size` reports,
   - stop kills the whole tree (a **nohup'd** sleep — a plain sleep dies of SIGHUP when the
     leader exits and the test proves nothing; this fixture was added when the sabotage passed
     on it),
   - the scrollback truncates at the UTF-16 limit with the tail intact (spec 060's "JavaScript
     string characters"),
   - the surrogate edge: one unit over the limit drops the emoji's HIGH surrogate and the
     scrollback starts with its LOW half — mirrored by keeping the scrollback as UTF-16 units
     and carrying it as base64 UTF-16LE, decoded to a JS string by the client (plain JSON text
     cannot hold a lone surrogate),
   - multibyte decode across a forced read split (a 3+1 byte emoji over a 0.5 s gap): held
     exactly as node's string_decoder holds it, no stray U+FFFD.

## Gates (green after the change)

- `node --test orchestrator/tests/pty-service.test.mjs` — 7/7 scenarios.
- `cd red && cargo test -p red-pty` — 3/3 (decode tail, truncation math, base64 round-trip).
- `npm test` — 296/296. `ctest --test-dir .cache/desktop` — 18/18 (`rust_red_pty` added; cmkr
  regenerated; Cargo.lock gained portable-pty under the F140 pin policy). `./init.sh`,
  `python3 tools/design.py check` — green.

## Red-for-own-reason record

Harness red before implementation (no `red-pty` package). After implementation, four sabotages
— two of which first **proved nothing**, and the fixture fixes are the evidence:

1. **Lossy decode** (incomplete sequence → U+FFFD immediately): green until the multibyte
   scenario gained a forced 3+1-byte split across a 0.5 s gap; then red. Restored.
2. **Truncation by chars instead of UTF-16 units**: red on the truncation and surrogate
   scenarios. Restored.
3. **stop signals only the direct pid, never the tree**: **green** — a plain `sleep 300` dies
   of SIGHUP when the session leader exits, so the tree-kill was invisible to the test. The
   scenario's sleep became `nohup sleep 300` (SIGHUP-immune); the sabotage is red with it.
   Restored.
4. **resize accepted but never applied**: red (isolated probe: `stty size` reports 24 80 after
   a sabotaged resize to 40 120). Restored.

## Boundaries recorded for F177/F178

- **KI-097 (filed)**: a single >64 KB `input()` write can die silently (`EIO` on a full tty,
   both node-pty and portable-pty). The JS host has it too — parity holds — but the host input
   path owes chunked, drain-paced writes. F178 is the natural place; it is a decision there,
   not an accident.
- **Signal reporting**: portable-pty 0.8 exposes `exit_code()` but not the signal (private
   field). Normal exits report exactly; the signal number in snapshots is F178's recorded
   decision (name table, Debug parse, or waitpid interposition).
- **Event chunk boundaries are implementation-defined by nature**: the harness compares
   concatenated event data, never boundaries. The desktop merges chunks the same way.
- The service is in-memory (no state dir) for F176; retention-across-restart is F177's
   architecture decision, recorded in KI-096.
