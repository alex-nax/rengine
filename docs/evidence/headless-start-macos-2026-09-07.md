# Headless start — sabotage pass and gates, macOS, 2026-09-07

Feature F85, spec [090](../specs/090-headless-workspace-start.md). Fixture:
`orchestrator/tests/headless.test.mjs`, eight checks, run by the `npm test` glob.

## Sabotage pass

Every check was observed failing for the reason it exists. Each sabotage was applied alone and
reverted before the next; the fixture was confirmed green again after each revert.

| Check | Sabotage | What it named when it went red |
| --- | --- | --- |
| a headless start writes a usable descriptor and answers as the launcher's own sidecar | `runHeadless` publishes its own `sidecar.json` and serves a hand-rolled `/health` + `/api/state` with `capabilities: {}` instead of calling `ensureSidecar` — a second kind of service, which decision 4 forbids | `a headless host reports the full workspace capability set`, after the descriptor and authentication assertions passed |
| the headless sidecar listens on loopback only | `server.listen(port, '0.0.0.0', …)` in `orchestrator/server/main.mjs`; the descriptor still says `127.0.0.1`, which is what makes this regression invisible without the check | `the sidecar answered on 192.168.31.172:60433; the bind must stay 127.0.0.1` |
| a headless start needs no C toolchain | `await import('./build.mjs')` moved back above the branch, so it runs for every start — the exact shape of the bug this feature fixes | `the launcher exited 1 before it was ready. Error: spawnSync cmake ENOENT` |
| `--project` registers the root | the `POST /api/roots` call in `runHeadless` dropped | `the ready line reports the registered root` |
| a headless start creates no agent session | `runHeadless` creates one, the way the desktop path does: `request(instance, 'terminal', { rootId, type: 'agent', agent: '', action: 'menu' })` | `a headless host serves sessions; it starts no conversation` — the agent-specific assertion, ahead of the broader "and starts no terminal either" |
| `--headless` refuses the desktop-only flags, `--declaration` included | the refusal block deleted from `launch.mjs` | `The input did not match the regular expression /--headless cannot be combined with --launch-game/` |
| the full start path still builds the desktop and spawns it | `if (options.headless)` changed to `if (true)`, so every start becomes headless | `the desktop build ran configure and build; recorded nothing and the launcher failed: Command failed: … launch.mjs --state …` |
| a headless start stays up, and stopping it leaves the sidecar and its sessions | (a) the `SIGINT`/`SIGTERM` handler kills the sidecar before it exits | `the sidecar keeps serving, and keeps the session it was retaining` |
| — same check | (b) `runHeadless` returns as soon as the sidecar is up, instead of supervising | `the headless start is still supervising:` followed by everything it had printed |

Two sabotages taught the fixture something before they were useful. Deleting the refusals and
forcing the headless path both make the launcher *succeed* and then supervise a sidecar for ever,
so the first attempt at each produced a bare test timeout that named nothing. Both invocations now
carry an `execFile` kill timeout, and the desktop check reads the recording files rather than the
exit status, so a lost desktop path reports "recorded nothing" instead of "command failed".

Sabotage (a) went red on the wrong line twice before it went red on the right one. The check first
asserted `alive(pid)` and then the retained session, and a signalled sidecar stops its sessions well
before its process goes — so the liveness read passed while the sidecar was on its way out, and the
session line took the failure. Waiting a bounded second for the death did not fix it; the sidecar
was still alive at one second with its sessions already gone. What the sidecar is still *serving* is
the property, and it is observable immediately, so that assertion now comes first and pid liveness
second. This is the shape of case 3 in the blind-regressions note: correct assertions, wrong order.

A further correction came out of the same pass: `node:test` runs after-hooks in registration order,
which was verified directly. The temporary-directory hook was registered first, so it deleted
`sidecar.json` before the hook that reads a pid out of it — every failed run leaked a sidecar for
the machine's uptime. Stopping the sidecar and removing the directory are now one hook. A full run
of the fixture now leaves zero `orchestrator/server/main.mjs` processes behind, checked by `ps`.

## Gates

Run in `.cache/worktrees/headless`, after merging `origin/main` at `8ca5bbf` (F79 and F81 landed from
another lane while this was in flight; `origin/main` was fetched again immediately before these). It
moved twice more afterwards, `80d0aae`, with a spec and inventory pair carrying no code; that is
merged in too and changes none of these numbers.

| Gate | Result |
| --- | --- |
| `npm test` | 92 tests, 92 pass, 0 fail, 0 cancelled, 8.2 s |
| `npm run test:desktop` | 35 tests before the merge / 37 after, all pass — see the session entry for the per-run numbers and the two load-induced flakes |
| Native build, wiped `.cache/scratch-build`, Release | exit 0, **0 warnings** |
| CTest in that build | 6/6 pass, 1.00 s |
| `./init.sh` | passed |
| `python3 tools/design.py check` | consistent |
| `python3 tools/features.py validate` | 42 features, types, evidence and dependency graph valid |
| llm-sidecar `check --fix-anchors` then `stamp`, `--index .cache/sidecars-headless.sqlite`, sequential | clean |
| End-to-end by hand | `node orchestrator/launch.mjs --headless --state DIR --project DIR` printed its ready line, wrote a mode-0600 `sidecar.json`, registered the root, answered `/api/state` with nine capabilities and zero sessions |

Two runs of the desktop suite failed on load rather than on the change, and both are recorded because
the number alone would misrepresent them: the first because a fresh worktree has no `.cache/native`
surface fixture (run `npm run build:surface` first — it is a prerequisite, not a regression), and one
later run because the sidecar indexer was hashing the tree on the same machine while GUI tests were
waiting on frames. Do not run either alongside this suite.

## Not proved here

The Windows path. The failure this fixes was observed on `pr0fe@192.168.31.217` in
`C:\Users\pr0fe\rengine\<pin>\.state\headless.log`; the fix is verified on macOS with the toolchain
removed from the child's `PATH`, which is the same condition by construction and not the same
machine. What would settle it: re-running the consumer's `scripts/wizards/remote-rengine.sh` with
the launcher line changed to `--headless`, and seeing `rengine headless ready` in that log followed
by the capability list through the tunnel. KI-060 carries this.
