# Retirement by kind: the streams drain, the ledger hands off — 2026-09-07

[KI-061](../../known-issues.md) closed. The defect the end-to-end check found
([project-token-e2e](project-token-e2e-2026-09-07.md)) was two workers owning one ledger after
`update_workspace` with `layers: ['workspace']` and a desktop attached: spec 065 lets the desktop's
`/events` socket finish through the replaced worker, and [spec 095](../specs/095-project-token.md)
put a stateful service on that socket. The person's Reject landed on a ledger no agent read, and both
workers stayed subscribed to the host's `/events` and minted `game.*` into one `feed.json` with
colliding sequences.

The fix is a split by **kind of traffic**, not by process, and it is spec 095's new *Retirement*
section. Terminal and surface views keep draining through the retired worker, untouched — spec 065's
rule and its regression are unchanged. The token/feed service hands off to the current worker.

## What changed

| Where | What |
| --- | --- |
| `orchestrator/runtime/supervisor.mjs` | one helper and two call sites: `child.send({ type: 'retired' })` where a retirement is **committed** — the `finally` that releases a replaced worker from `preserved`, and the rollback that retires a rejected candidate. Not at the swap: a failed update restores the previous worker as the current one, and a worker told it was retired would then forward to itself. |
| `orchestrator/runtime/worker.mjs` | `retire()`: terminate the host `/events` subscription and never resubscribe; close its own `/feed` clients naming retirement; drop the ledger, so `token.json`/`feed.json` are never written again; then follow the current worker's feed for each root its retained desktops registered. Five routes forward through the supervisor; a retained desktop's `token-action`/`recording` frames forward with `X-Rengine-Desktop`; `token` pushes are relayed back. New `POST /api/recording`, sharing one function with the socket path. |
| `orchestrator/runtime/token.mjs` | `readDesktop(headers)` beside `readIdentity`, and `segmentFrame(status)` so `Ledger.segment()` and a relayed push are one definition — the frame on the desktop's socket is unchanged. |

Nothing under `orchestrator/server/` and nothing under `orchestrator/native/` was touched. No
environment variable was added: the retired worker finds the supervisor through the runtime
descriptor already in its own directory (`discoverRuntime`).

## The checks

`orchestrator/tests/token-retirement.test.mjs`, two cases under `npm test`, against a real session
host, a real supervisor, two real workspace workers and a stand-in desktop on the same `/events`
socket the real one uses:

- **a retained desktop keeps its streams, and its token service follows the worker that replaced
  them** — (a) spec 065's invariant, restated where it is now load-bearing: `retiring.length === 1`,
  the socket still `OPEN`, and input and output still crossing it to a live PTY; (f) the monitor on
  the retired worker closed with a reason naming retirement and re-attachable by cursor with no gap;
  (b) a `token-action` from that socket landing on the current ledger, attributed
  `by: { kind: 'desktop', desktopId }` with the id the retired worker registered; (c) an agent's
  transition against the current worker arriving on that socket as the pinned `token` frame; and the
  ledger's own routes — token, feed, token-action and the `tokenWindowMs` half of preferences —
  answered through the URL and capability `feed_url` handed out **before** the replacement.
- **a retired worker mints nothing: one writer, one `game.started`, and the file a third worker would
  load agrees** — (d) the retained desktop's `recording` frames becoming `capture.started` /
  `capture.committed` on the current feed; (e) one game session, one frame pair, and the ring on disk
  equal to the ring the current worker serves.

`orchestrator/tests/native-token-e2e.spec.mjs` gains the scenario its criterion 5 had to leave out:
after the replacement, with the **real** desktop still attached, the monitor is closed with the
retirement reason, **Reject on the real popover** reaches the ledger the replacement serves
(`by.desktopId` still the desktop the supervisor listed, the contest still the one open across the
replacement, the cooldown on the current ledger), and the segment follows that ledger.

**One measurement is not a race.** The collision KI-061 recorded is a second writer, and which of two
writers lands last is timing: sampling `feed.json` at the end can agree by luck. `writeAtomically`
names its temporary after the writing process, so the check watches the ledger directory and asserts
the set of pids that wrote it. That is why row 2 below goes red on a pid rather than on a sequence.

## Sabotage table

Each row: break the one mechanism the assertion claims to catch, run the check, read **which**
assertion went red, `git checkout` the file. Rows 1–12 are `token-retirement.test.mjs`, 13–14 are
`native-token-e2e.spec.mjs`, 15 is `runtime.test.mjs` and 16–19 are `project-token.test.mjs`. Every sabotage is JavaScript and the
desktop binary was built once, before the sweep, from an unmodified tree and never touched after —
the previous session's misattribution (a restored source tree is not a restored build) cannot apply.

| # | Broken | Assertion that went red |
| --- | --- | --- |
| 1 | the supervisor commits the retirement without telling the worker | `Timed out: the retired feed client is closed`; and in the second case `Timed out: the retained recorder's commit reaches the current feed` |
| 2 | `retire()` keeps its ledger and its subscription to the host's `/events` — the pre-fix minting half, exactly what KI-061 measured | `only the worker that owns the ledger wrote it; the retired one is pid 16927` |
| 3 | `retire()` does not close its own `/feed` clients | `Timed out: the retired feed client is closed` |
| 4 | a retained desktop's `token-action` is answered from the ledger this worker gave up, instead of forwarded | `Timed out: the retained desktop's rejection reaches the current worker's feed` |
| 5 | the forwarded `token-action` carries a generic desktop name instead of the id this worker registered | `naming the desktop the retired worker registered` |
| 6 | `follow()` never subscribes to the current worker's feed | `Timed out: the current ledger reaches the retained desktop as a token frame`; and `Timed out: the retained desktop hears the current ledger` |
| 7 | the relayed push drops `windowMs` from the pinned frame | `the frame on the desktop socket is the pinned flat shape, unchanged by the relay` |
| 8 | a retained desktop's `recording` frame is not forwarded | `Timed out: the retained recorder's commit reaches the current feed` |
| 9 | `POST /api/recording` attributes the frame without the desktop's id | `both naming the desktop that sent them` |
| 10 | the retired worker answers the ledger's own routes locally rather than forwarding | `token?rootId=… failed 409: This workspace worker does not serve the project token ledger: no runtime directory.` |
| 11 | the current worker ignores `X-Rengine-Desktop` | `Timed out: the retained desktop's rejection reaches the current worker's feed` |
| 12 | `X-Rengine-Desktop` is honoured even when an agent header is present | `a request carrying both headers is the agent's` |
| 13 | the supervisor commits the retirement without telling the worker (real desktop) | `Timed out: the retired worker closes its feed clients` |
| 14 | a retained desktop's `token-action` is not forwarded (real desktop, real popover) | `Timed out: the popover's Reject reaches the ledger the replacement serves` |
| 15 | **the control**: the fix that was tried and reverted — `retire()` ignores `worker.streams` and closes the replaced worker whatever it is carrying | `runtime.test.mjs:91` *"layered workspace and MCP replacement retain a legacy host and active PTY streams"*, `expected: 1 / actual: 0` — the same red the previous session recorded, unchanged by this lane |
| 16 | the worker does not intercept `POST /api/agent-restart`, so `restart_agent` reaches the host ungated | `agent-restart is refused with 409, not 400` |
| 17 | `withConversations` returns the ledger's identities unchanged | `a conversation the host persisted is an identity before it has called anything` |
| 18 | a persisted conversation is folded in even when the ledger has already seen that id | `one entry per identity, not one per source` |
| 19 | `restart_agent`'s description does not say it is gated | `restart_agent says it is gated` |

Row 15 is the reason retention is by kind. Rows 1–14 fail under the old code and row 15 fails under
the code that was rejected; only the split passes both.

Rows 16–19 are the two additions folded in after the 4aa340f reconciliation merge, both in
`project-token.test.mjs`: **`restart_agent` is gated like `stop_session`** — it stops that pane's
child, and the gate is an interception in the worker before the forward, exactly as `/api/stop` is,
so the person at the desktop stays ungated — and **`token_status` lists the root's persisted
conversations** (spec 097) as identities it has not yet seen on the wire, marked `conversation:
true`, minting nothing and never displacing an identity the ledger has actually seen.

## Commands

`npm test` 148/148 (145 on main after the 4aa340f reconciliation merge, plus this lane's three) ·
`npm run test:desktop` 48/48 ·
`python3 tools/features.py validate` 43 features · `python3 tools/design.py check` clean · sidecar
`check` clean on `runtime/worker.mjs` and `runtime/supervisor.mjs` (anchors repaired, a
`retirement-handoff` / `retirement-notice` note added to each, stamped); the pre-existing drift on
files this lane never touched is KI-052's pattern and is not repaired here.

Three flakes across the sweep, recorded because none of them is this lane's and all three are a
different spec: `native-dashboard.spec.mjs` at `dashboard-action shot not reached`, after the
desktop's own socket reported *"Session connection restored. Reattaching retained processes."*
mid-test; `native-format-hardening.spec.mjs` at `wide pack opens in preview not reached`; and
`native-render.spec.mjs` at `opengl: resident memory delta 34176 KiB exceeds 32768 KiB`. All three
drive the **session host directly** — their state dumps carry no `layeredUpdates` and no
`agentToken`, so no supervisor and no workspace worker is in any of them, and the render one measures
the desktop process's own resident memory — so nothing this lane changed can reach them. Each passes
alone, and the suite is 48/48 on a clean run. The machine carried 63 rEngine processes and a load
average around 12 throughout, from other lanes' live desktops and instances.

F90 stays `passes: false`. KI-061 was one of its two named blockers and is closed here; the other
stands — F74, F76 and F80 are all `passes: false`, and F74's own third criterion waits on the
owner's live verification.
