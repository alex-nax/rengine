# F178 (F151c) — sessions.mjs is deleted; the host's PTYs are red-pty's (2026-09-13)

Spec 129/131, KI-096. The third and last third of F151.

## What left JavaScript

`orchestrator/server/sessions.mjs` (330 lines) is gone. `orchestrator/server/sessions-client.mjs`
(302) stands in its place, and the difference is what a line owns rather than how many there are:

| left | to |
| --- | --- |
| `pty.spawn`, `onData`, `onExit`, `child.write`, `child.resize` | `red-pty` through `pty-client.mjs` |
| `signalTree` — the `ps`-walking tree kill and the TERM/2 s/KILL escalation | `signal_tree` and `PtyHost::stop` in the red-pty crate |
| `agentPaneComposition` — 45 lines that decide what a pane launches and claims | `agent_pane_composition` in red-agents, reached through the service's new `paneComposition` |
| `describeAge` | it went with the composition; nothing in JS asked for it |

**No production JS module imports `node-pty` any more.** The dependency stays in `package.json`
because two tests still use it — `pty.test.mjs`, which tests that the native module builds here,
and `shell-actions.test.mjs`, which uses it as a harness. Tests are allowed JavaScript; the
shipping path is not, and that is now true of this one.

What stayed is what the class is for: titles, conversation records, handoff gates and their
one-flight-per-project serialization, surfaces and games, the store writes, and the refusals. The
host's external API does not change by one field.

## Two decisions inside the swap

**Refusals stay synchronous.** `input` and `resize` validate and throw before anything is sent, and
return a promise only for the delivery. `main.mjs` answers `/api/input` from a synchronous throw,
and `assert.throws(() => sessions.input(dead, 'x'), /not running/)` is the whole of what "invalid
input" means to a caller; making the method `async` would have turned every one of those into a
rejection nobody was catching. Deliveries queue in call order behind the one host promise.

**The scrollback is still accumulated in the host.** Spec 060 counts `OUTPUT_LIMIT` in JavaScript
string characters, and a JS string is what does that exactly — lone surrogate at the slice boundary
included. The service keeps its own copy for the sessions it holds; the host's is what the pane
reads.

**The service is `PtyHost.open()`, not `PtyHost.attach()`.** F177 built the per-state-directory
service, and this row deliberately does not switch the host onto it: the sessions would outlive the
host, but the pane metadata — which root, which agent, which conversation, which handoff gate —
lives in this class's memory, so the next host would inherit processes it cannot name. See *What
this row does not do*.

## Parity when one side no longer exists

Two comparison tests had the deleted module as half of the comparison. Both were re-based on the
answers it gave while it still existed, captured from the module at the commit before its deletion
and never regenerated:

- **`pane-composition-fixtures.json`** — 12 cases, the pane-identity plan for every CLI shape.
  `agent-spawn-env.test.mjs` compares the crate against the record now, and gained one case that
  goes through the *service* rather than the fixture binary: a client that quietly stopped passing
  the mint or the clock would pass all 12 fixtures and still be wrong.
- **`pty-scenario-fixtures.json`** — the 7 terminal scenarios F176 used to run against both
  implementations. Running them against the service and calling that parity would be the service
  agreeing with itself.

## A real parity gap the swap exposed

`node-pty`'s `env` option **is** the child's whole environment. `portable-pty`'s `CommandBuilder`
starts from *this process's* environment and applies the caller's on top. So the first green run of
the swap had `RENGINE_AGENT_CONVERSATIONS` — inherited by the service from the host — reaching a
pane whose launch had explicitly cleared it. That is KI-068's leak (a pane inheriting another
pane's identity) arriving through a new door. `PtyHost::spawn` calls `env_clear()` first now.

F176's scenario set could not see this: both drivers ran inside the same test process, so both
inherited the same environment. The test that caught it is the one that sets a stale variable in
the host's own environment and asks the pane what it sees — a test that existed, and only had to be
run against the new path.

## Sabotages, each observed failing for its own reason

| Sabotage | Observed |
| --- | --- |
| the service mints its own id instead of taking the caller's | `Session condition timed out` — the pane's output reaches an item nobody is holding |
| `env_clear()` removed, so a pane inherits the service's environment | `the inherited listing is cleared with the rest of its family` |
| `stop` delegates nothing | `Session condition timed out` on the session that would not exit |
| the scrollback truncation drifts by one UTF-16 unit | `scenario: the surrogate edge at the slice boundary` |

And the deletion itself was observed: with `sessions.mjs` removed and the importers not yet
repointed, 20 suites failed with `ERR_MODULE_NOT_FOUND … imported from
/Users/alex/rengine/orchestrator/server/games.mjs`. That importer had been invisible to the search
that found the others, because `games.mjs` contains a literal NUL byte (a `\0` key separator) and
`rg` classifies the file as binary and skips it. Worth remembering: a repo-wide `rg` for an import
is not a complete answer.

## The gates

`npm test` — **309 of 309**, with `orchestrator/server/sessions.mjs` deleted in the same commit.
`cargo build -p red-pty -p red-agents` clean. `python3 tools/features.py validate` — 130 features.
`python3 tools/design.py check` clean.

## What this row does not do

- **It does not put the host on the retained service.** That is the row F179 proposes (filed under
  KI-096): the pane's metadata has to survive alongside its PTY, `replace.mjs` has to report a
  handover rather than an ending, and F94's tests — which assert today that sessions end with the
  old host — have to be amended, citing D60. Landing the swap and that change together would have
  changed two features' observable behavior in one commit.
- **It does not prune anything.** The service keeps exited sessions' scrollback as long as it
  lives, exactly as the host kept them for as long as *it* lived. F179 inherits the question,
  because that "as long as it lives" is what stops being the same sentence.
