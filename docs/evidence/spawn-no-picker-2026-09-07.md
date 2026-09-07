# A spawned pane resumed the conversation of the agent that spawned it (KI-068)

Date: 2026-09-07. Machine: macos. Branch: `fix/spawn-no-picker`, from `origin/main` at `e1d9408`,
tip `aeb5430`. Not merged.
Parents: [spec 097](../specs/097-agent-conversation-persistence.md) (the pane offers the project's
conversations), [spec 103](../specs/103-task-driven-agents.md) (the Tasks pane spawns an agent on a
task). Found live, by the first `spawn_agent` there ever was.

## What happened

`spawn_agent` reached the worker, which called the host's `terminal` route with
`{ type: 'agent', agent: 'claude', action: 'launch', args: ['--model', …, '<rendered prompt>'] }`.
The host minted a conversation, wrote the project's remembered conversations to
`<id>.conversations.tsv`, set `RENGINE_AGENT_CONVERSATIONS`, and `scripts/agent.sh` put the spec 097
picker in the new pane:

```
Conversations for claude in this project:
  1) claude 5b8d47c2  2 hours ago   5b8d47c2-…
Resume which? (Enter starts a new conversation):
```

and blocked on stdin. The first spawned pane received a `1` — a click into a pane is enough — and
**resumed the spawning agent's own conversation** (`5b8d47c2`) in a second process; the report-session
hook then rewrote the pane's record to that id, so rEngine's own account of who was where was correct
about a thing that should never have happened. The second spawned pane sat on the prompt for an hour,
until Enter was sent through `/api/input`, after which it started correctly on its minted conversation
with its prompt.

The picker is right for a person opening a bare agent pane. It is wrong for a pane the workspace
launches on a task with an initial prompt, and wrong for any launch whose conversation the caller
already named (a Resume from the Sessions tab, a `restart_agent`).

## The second defect, found on the way

The suite is run from an rEngine agent pane as often as not, and on `origin/main`, run from one, five
tests fail. Four are `conversation-picker.test.mjs`, whose fixture spread `process.env` and so let the
*running* pane's `RENGINE_AGENT_CONVERSATION`/`_RESUME`/`_CONVERSATIONS` decide every assertion. The
fifth is spec 103's own spawn test:

```
not ok 183 - a spawn starts the chosen CLI with its own model flag and the rendered prompt, …
    on the conversation the workspace named
    +  '--mcp-config'      (actual: --session-id was not in the argv at all)
    -  'ac7a00a4-7828-41cc-bd92-8fa8bb959eaf'
```

That one is not a fixture problem. `Sessions.spawnTerminal` clears the pane-identity family
(`RENGINE_HANDOFF_*`, `RENGINE_ORCHESTRATOR_SESSION`, `RENGINE_AGENT_CONVERSATION`,
`RENGINE_AGENT_RESUME`) by passing `undefined` overrides to `shellEnvironment()` — and then composes
the child's environment with a **second** `shellEnvironment()` call, which starts from `process.env`
again and inherits every one of them straight back. A session host running inside an agent pane
therefore handed each pane it spawned that host's own pane identity. In the failure above the leaked
`RENGINE_AGENT_RESUME=1` turned the CLI's `--session-id` into `--resume`: a *spawn* continuing
somebody else's conversation, by exactly the mechanism the live defect used, from a different
direction.

## The fix, by layer

| Layer | Change | Reaches a running workspace |
| --- | --- | --- |
| `scripts/agent.sh` | The picker runs for an interactive **bare** launch only: never with trailing arguments after `--` (a pane launched on a task, whose prompt is already written), never with `RENGINE_AGENT_RESUME=1`. `Enter starts a new conversation` is unchanged for the bare case. `extra_count` is captured at option parsing rather than read as `${#extra[@]}` in the function, so the guard is a plain integer under `set -u` on bash 3.2. | Immediately — the launcher is read from the checkout at every pane launch (the correction session 71 recorded for F103). |
| `orchestrator/server/sessions.mjs` | The listing is written, and `RENGINE_AGENT_CONVERSATIONS` set, **only when the caller named no conversation and passed no args**. `chosen` is read before the mint, because after it every pane looks like one that had chosen — the mistake spec 097 decision 5 already records once. Separately, the cleared family is applied to **both** environment compositions, and gains `RENGINE_AGENT_CONVERSATIONS`. | At the next `--replace-host`. Until then the launcher's own guard covers the spawn case, which is why both halves exist. |
| `orchestrator/runtime/worker.mjs` | `spawnAgent` names the conversation it mints on the host call (`conversation: randomUUID()`), so the host knows this launch has decided; `task` is still recorded on it. | At the next `update_workspace` with the `workspace` layer. |

The three are deliberately redundant. A listing can arrive from a stale environment as well as from
this host, and the host can be older than the worker; either guard alone closes the observed failure,
and neither is asked to be the only one.

## Tests, each observed red for its own reason before the fix

| Test | Established | The red it was first seen giving |
| --- | --- | --- |
| `conversation-picker.test.mjs` — *a launch that carries an initial prompt is never asked which conversation to resume* | a launch with trailing arguments shows no list, starts on the conversation it was given, does not turn it into a resume, and the prompt reaches the CLI rather than the picker's `read`; the same launch **without** its arguments is still offered the list and its answer still honoured | `a pane started on a task is not asked to choose: true !== false` |
| `conversation-picker.test.mjs` — *the picker stays out of the way when there is nothing to offer* (existing) | `RENGINE_AGENT_RESUME=1` is not asked again | unchanged behaviour; kept as the resume half of the rule |
| `sessions.test.mjs` — *the project's conversations are offered to a bare pane only* | bare + history → listing written and containing what the project remembers; `args` → no listing; `conversation` + `resume` → no listing, and the pane is put back into the one it was told | `a pane launched on a task is offered nothing: true !== false` |
| `sessions.test.mjs` — *a listing inherited from the host's own environment never reaches a pane* | a pane's environment carries no `RENGINE_AGENT_CONVERSATIONS` the host merely inherited | `listing=/…/somebody-elses.tsv` reached the pane |
| `task-writes.test.mjs` — *a spawn names the conversation it mints, and its pane is offered no history to mis-answer* | the worker's host call carries a uuid **and** args; the answer, the persisted pane record (with `task: F1`) and the `agent.spawned` frame all carry that same id; it is never the conversation already on the root; no listing file exists for the pane; the CLI starts with `--session-id <that id>` and no `--resume` | `the worker names the conversation on the host call: '' did not match /^[0-9a-f]{8}…/` |

The picker fixture now filters `RENGINE_*` out of the inherited environment (KI-031's shape), so the
suite means the same thing run from a workspace pane as from a bare shell.

## Sabotage table

Each row breaks the implementation in the specific way the test claims to catch, on the committed
fix; every one was observed red for that assertion and restored.

| # | Sabotage | Test | Red on |
| --- | --- | --- | --- |
| 1 | `agent.sh`: drop the `extra_count` guard (prompt despite args) | picker · initial prompt | `a pane started on a task is not asked to choose` |
| 2 | `sessions.mjs`: `const remembered = this.store.listConversations(root.id)` — write the listing for everyone | host · bare pane only; worker · spawn names | `a pane launched on a task is offered nothing`; `the host writes this pane no listing, so there is nothing for a stray keystroke to answer` |
| 3 | `worker.mjs`: omit `conversation` from the host call | worker · spawn names | `the worker names the conversation on the host call` |
| 4 | `sessions.mjs`: compose the child environment as before (`cleared` only in the first pass) | host · inherited listing | `the inherited listing is cleared with the rest of its family` |
| 5 | `sessions.mjs`: `const chosen = true` — nobody is ever offered the list (spec 097 decision 5's original mistake, from the other side) | host · bare pane only | `a bare pane with history is offered it` |
| 6 | `agent.sh`: `return 0` unconditionally — the picker never appears | picker (3 of 5) | `a pane offers the conversations this project already has`; `a workspace-minted conversation is still offered the history`; and the bare-launch control inside the new test |

Rows 5 and 6 are the controls: they establish that the two new guards did not simply delete the
feature they narrow, and that the new test's own bare-launch half fires.

## Numbers

| Run | Result |
| --- | --- |
| `npm test` on `aeb5430` (warm) | **213 tests, 213 pass, 0 fail**, 11.5 s |
| `node --test orchestrator/tests/*.test.mjs` on `origin/main` `e1d9408`, from a workspace agent pane | 209 tests, 204 pass, **5 fail** — 4 `conversation-picker` + spec 103's spawn test, all from the inherited `RENGINE_*` environment described above |
| First `npm test` on the branch, cold `.cache` | 213 tests, 210 pass, 3 fail, 70.6 s — `headless.test.mjs` built the desktop from scratch (45 s) and starved two parallel launcher tests into their timeouts. The same three files pass in isolation on the branch (14/14) and the whole suite passes on the re-run once `.cache/native` is warm. Not a code failure; recorded because the first run of a fresh worktree will do it again. |
| `sidecar_tool.py check` on the three edited sources | `status: clean` (anchors repaired, three notes added, stamped) |

**Not verified here:** the live path. This branch is not merged and the workspace that produced the
defect still runs the host and worker that have it. The first workspace started from this change
should record, under `docs/evidence/`, a `spawn_agent` whose pane comes up on its own conversation
with its prompt and no picker in it — which is the criterion this evidence cannot meet from a test.
