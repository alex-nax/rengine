# F174 (F170a) — the red-store stdio service and its thin client (2026-09-12)

The channel half of F170 (spec 129, KI-095, filed under the KI-092 standing rule). The
workspace store now runs as a process — `red-store-serve <state-dir>`, newline-delimited
JSON-RPC over stdio, the house's LSP/MCP-worker shape — and `orchestrator/server/store-client.mjs`
presents the exact WorkspaceStore surface: methods, results, and `fail` statuses over the hop.
This is the first JS-host→Rust channel the epic builds (F175's swap and the F151/F152/F158 host
slices ride the same shape). Nothing rewired, nothing deleted.

## Acceptance criteria and where each is proved

1. **The thin client is indistinguishable from the JS WorkspaceStore on the F169 corpus.** The
   same corpus the crate replay proved (exported as `store-corpus.mjs`, a non-test module —
   importing a `.test.mjs` runs its tests in the importer, which bit mid-run) replays through
   client+service: every state op, the readback, the file ops, the schema cases, and the
   workspace.json bytes after each op — drift-free. The harness injects the recorded mints and
   stamps (`RED_STORE_MINT_SEQUENCE`/`RED_STORE_NOW_SEQUENCE`, harness-only, documented in the
   binary's header) because byte parity includes what the service mints; the clock answers by
   REQUEST index, matching the capture's op-count pinning.
2. **`fail` statuses survive the hop.** Every corpus error (400/403/404/409 plus raw ENOENT
   with no status) round-trips; the client rethrows with `.status` set exactly as the JS
   `fail()` produced. The service answers malformed JSON with a protocol error and keeps
   serving.
3. **Lifecycle is self-reaping.** The service exits when its stdin closes — a dead host leaves
   no store process behind; `close()` reaps it (proven by PID poll), and a reopened client on
   the same directory reads the same state. `state` rides every answer, so the client's
   snapshot reads like the JS store's own field.
4. **The registry rides too.** `recordConversation`'s id-shape comes from the recipe's parser
   name in the registry document (resolved `$RENGINE_AGENT_REGISTRY`, else exe-relative), so a
   kimi `session_` id passes and a bare uuid under kimi is refused, as on the JS side.

## Gates (green after the change)

- `node --test orchestrator/tests/store-service.test.mjs red-store.test.mjs` — 4/4.
- `npm test` — 294/294. `ctest --test-dir .cache/desktop` — 17/17. `./init.sh`,
  `python3 tools/design.py check` — green.

## Red-for-own-reason record

Harness red before implementation (no service, no client). After implementation, four
sabotages, each red for its own reason and restored from a file backup:

1. **Client drops the error status over the hop** → the corpus error judgements red.
2. **Service stops riding `state` on answers** → the readback red (the snapshot never updates).
3. **The request clock never ticks** → every timestamped judgement red.
4. **Client dispatches `save-text` instead of `saveText`** → the save ops red with the named
   unknown-method error.

## Design notes for F175 (the swap)

- The channel is newline-delimited JSON-RPC: one request, one answer per line, `id`-matched,
  `state` riding every answer. The client's `resolve` maps the `[absolute, relative]` pair to
  the JS object shape; standalone `resolveInRoot`/`validateSchema` are answered by the most
  recently opened store (they were stateless helpers that happened to live in store.mjs) and
  refuse by name with no store open.
- `WorkspaceStore.open` awaits the service's first line (`{"started": true, "state"}`) or the
  process's exit — a damaged state fails open() the way the JS store's open fails.
- The binary resolves as `$RENGINE_RED_STORE_SERVE`, then debug/release in the repo; a missing
  binary is named, never silently worked around.
- Consumer rewires for F175: every `from './store.mjs'` / `from '../agents/schema.mjs'` import
  moves to this client; `store.directory`/`store.filename` are data properties already.
