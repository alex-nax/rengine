# 133 — Red as a Claude Code IDE, in Rust (F161, second half)

Status: implemented 2026-09-14. The first half of F161 — the language-server client — is
`red-lsp` (`docs/evidence/lsp-f161-2026-09-14.md`). This is the other half: the bridge that
publishes `<config>/ide/<port>.lock`, serves MCP over the WebSocket the lock names, and the
discovery that decides whether a pane's CLI is told to connect. Parent: [spec 102](102-editor-as-claude-ide.md)
for every rule the bridge keeps and [spec 129](129-js-retirement-epic.md) for the row. The rules
themselves do not change here; where they live does.

## What moves

| Was | Is | Reached through |
| --- | --- | --- |
| `runtime/ide.mjs` (199): the lock, the sweep, the socket, the MCP tools, `selection`/`mention` | `red/red-ide/src/{lock,bridge}.rs`, run as `red-ide serve` | `runtime/ide.mjs` (a thin client, same exports) |
| `agents/ide-connect.mjs` (76): `offeredEditors`, `autoConnect` | `red/red-ide/src/discovery.rs`, run as `red-ide offered` / `red-ide auto-connect` | `agents/ide-connect.mjs` (a thin client, same exports) |
| `ideDirectory()` — `RENGINE_IDE_DIRECTORY`, else `CLAUDE_CONFIG_DIR/ide`, else `~/.claude/ide` | `red_ide::lock::directory`, run as `red-ide directory` | `ideDirectory()` in `ide.mjs`, synchronous as before |

`ide-connect.mjs` comes with this slice on purpose. F161's first criterion is "editor lock
**discovery** honors `CLAUDE_CONFIG_DIR` and every distrust rule of the evidence document", and
discovery is `offeredEditors`: which locks are read, which are believed, and which one is ours.
Leaving it in JavaScript would leave the criterion's subject in JavaScript. It stays a **caller's
probe** — `agents-client.mjs` still resolves it before asking `red-agents` for a launch plan, which
is the owner's 2026-09-13 placement — only the decision inside it is Rust.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | **A new crate, `red-ide`.** The bridge needs a WebSocket server, which means tokio and `tokio-tungstenite` — both already linked by `red-host`, so no new registry decision — and `red-lsp` is deliberately a thread-and-pipe crate that links neither. Putting an async server into it would make every language-server process carry a runtime it does not use. `red-host` is the door's binary and not a library the worker can spawn. So: one crate, one lib with three modules, one binary. | Recommended |
| 2 | **A process per worker, not a service of a state directory.** The port belongs to the *runtime* (spec 102 decision 8b: the supervisor reserves it and every worker retakes it); the socket, the token and the lock belong to the *worker* that published them and are unlinked when it retires. That is `red-lsp-serve`'s shape — spawned by the client, stdio, dying when stdin closes — and not `red-store-serve`'s, which outlives the host that found it. A bridge that outlived its worker would keep a token the successor cannot know and a `rengineWorker` naming a process that is gone, which is precisely the stale lock the sweep exists to collect. | Recommended; the KI-066 retake rule is kept verbatim |
| 3 | **Diagnostics are asked back over the same pipe.** `getDiagnostics` reads what the project's language servers published, and those are `red-lsp-serve` processes the *worker* owns (per root, lazily). The bridge cannot reach them; it writes `{"ask": N, "method": "diagnostics", "args": [uri]}` to stdout and the client answers `{"answer": N, "result": [...]}` on stdin. The library takes the source as a trait object, so when F158 ports the worker the Rust worker hands it the `Servers` directly and the reverse ask disappears with the client that needed it. | Recommended |
| 4 | **`selection()` and `mention()` become awaited.** The JavaScript returned `sockets.size` synchronously; a count that lives in another process is a round trip. The worker's two routes gain an `await` each, which is the same correction spec 132 recorded for the ledger: a client-side mirror of the count updated by events would race the WebSocket answer the test just awaited, and a `delivered` that is sometimes one short is worse than one that is asked for. `published`, `port`, `lock`, `authToken`, `reason` and `ready` keep their shapes; `clients()` and `observed()` are asked for too. | Recommended, after spec 132 |
| 5 | **Liveness stays two different rules, because it was.** `ide-connect.mjs`'s `living` counted `EPERM` as alive (a process one cannot signal exists); `ide.mjs`'s sweep default counted it dead. They are `discovery::living` and `lock::alive`, each with its own unit test, and the record holds a case for each (pid 1). Unifying them would be an improvement made in a port, which spec 129 forbids. | Recommended |
| 6 | **NFC through `icu_normalizer`.** `covers()` normalises both paths to NFC before the boundary test, because a macOS path can arrive decomposed. The crate is already in the lockfile through `idna`; `unicode-normalization` would be a new one. | Recommended |
| 7 | **`workerPid` defaults to the parent process.** The JavaScript defaulted to `process.pid`, meaning the worker; the binary's own pid is the bridge's, not the worker's, and the pid a caller's pid means is its parent's. On unix that is `getppid()`; elsewhere the binary's own. The thin client passes `process.pid` explicitly regardless, so the default is exercised only by the harness. | Recommended |
| 8 | **The MCP answers are byte-identical to the SDK's.** Key order (`result, jsonrpc, id` for an answer; `jsonrpc, id, error` for a refusal; `method, params, jsonrpc` for a notification), the `-32601 Method not found` text, `-32603` for a handler that throws, and the strict request shape — a frame without `jsonrpc: "2.0"`, with an extra top-level key, or with a non-integer id is **not answered**, because the SDK's `isJSONRPCRequest` rejects it. The record holds every one of these as text, not as parsed JSON. | Recommended |

## The protocol between the client and `red-ide serve`

Newline-delimited JSON, the `red-lsp-serve` shape. Client to service: `{"id", "method", "args"}`
with methods `start`, `selection`, `mention`, `clients`, `observed`, `close`, `sweep`. Service to
client: `{"id", "result"}` or `{"id", "error": {"message"}}`; unprompted `{"event": "published",
"port", "lock"}` and `{"event": "unpublished", "reason"}` when a retake settles; and the reverse
ask of decision 3. The process exits when stdin closes, after unlinking its lock.

`start` takes exactly `startIdeBridge`'s options — `roots`, `hostPid`, `workerPid`, `port`,
`directory`, `host`, `retakeTimeoutMs`, and `diagnostics: true` when the client will answer asks —
and answers `{published, port, lock, authToken, reason}`. A refused start (no integer host pid)
answers with `published: false` and the reason, creates no directory and sweeps nothing, exactly as
the JavaScript returned before touching the filesystem.

The one-shot subcommands take their inputs as arguments or a JSON document on stdin and print one
JSON answer: `red-ide directory`, `red-ide sweep <directory>`, `red-ide offered` and
`red-ide auto-connect`. A refusal is `{"error", "status": null}` and the thin client throws it.

## Verification

Two records, taken from the JavaScript while it still answered and then frozen (spec 129's device):

- `tests/ide-corpus.json` — the bridge, driven through a raw WebSocket client so every
  frame is recorded as the text that crossed the socket. Cases: the lock as written, the four ways a
  host pid can be missing, the startup sweep on thirteen lock shapes, the MCP handshake and every
  silence, `getDiagnostics` and its sources, the token gate in nine presentations, the subprotocol,
  fan-out, close, the retake, the port never released, a successor closed while waiting, a slow
  source, a directory that cannot be created, and the directory rule under eight environments.
- `tests/ide-connect-corpus.json` — discovery: containment and the sibling, NFC,
  liveness on five pids, the lock's shape, the port read off the filename, and every sentence
  `autoConnect` can answer with.

Folded, because they are a machine's and not a rule's: the port, the token, the temporary
directory, this process's pid, the product's name, and the `host` header. Not folded: the retake
interval, every refusal, every reason.

`ide-parity.test.mjs` and `ide-connect-parity.test.mjs` drive the binary through the same steps and
compare; after the wiring commit the record tests are deleted with the implementation they judged,
and their rule assertions move into the parity tests. Every rule is sabotaged once and observed red
for its own reason; the evidence document lists them.

## What a record cannot see, handled at the site

- Every JSON-RPC answer is built in the order the SDK built it (decision 8), and `serde_json`'s
  `preserve_order` keeps a lock's keys in the order the CLI's parser has always read them.
- A `MutexGuard` is never held across an `.await`: sockets are reached through an unbounded channel
  per connection, the way `red-host::events` does it, and the sets that hold them are locked for a
  clone and released.
- The reverse ask has no timeout, as the JavaScript's `await diagnosticsFor(uri)` had none; a
  client that dies closes stdin and the process exits, so nothing is held. Stated rather than hidden.
- A bind error other than `EADDRINUSE` is a refusal with the OS's own sentence, as the JavaScript
  re-threw it; `EADDRINUSE` alone is the retake.
