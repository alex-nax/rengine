# Agent identity, the header, and binding by discovery — sabotage record, 2026-09-07

Stage 1 of [spec 095](../specs/095-project-token.md): each agent launch mints its own identity, the
tool worker carries it on every call, and an agent the workspace never spawned binds by discovery.
Nine sabotages, each broken in the specific way one assertion claims to catch, observed red for that
assertion and not an earlier one, then restored. `orchestrator/tests/agent-identity.test.mjs`, run
with `node --test`.

| # | Broken | Assertion that went red | Notes |
| --- | --- | --- | --- |
| 1 | `agentIdentity()` returns a constant `agentId` instead of `randomUUID()` | `each launch mints its own agentId` | Test 1. The two launches are otherwise identical, so nothing else could distinguish them. |
| 2 | The facade is pointed back at the shared root context (`args: [mcpMain, '--context', contextFile ?? boundFile]`) | `claude's facade is started on its own context file` | Test 1. The diff names both paths: the `integrations/<rootId>.json` shape against the per-launch `…/context.json`. |
| 3 | The tool worker sends no headers (`const identityHeaders = {}`) | `every request the tool worker made carried this launch's agentId` | Test 2. The recording proxy saw `undefined` where the agentId belongs. |
| 4 | `request()` stamps a default identity on every caller | `the launcher's own session lookup runs before the identity exists and claims none` | Test 2. Red at the *first* anonymous request, which is the launcher's own state lookup. |
| 4b | Same defect, with assertion 4 lifted out of the way | `a request made the way the desktop makes them carries no identity` | The control masked the thing under test — case 3 of `blind-regressions-2026-09-06.md` in miniature. Both assertions were then confirmed to discriminate. |
| 5 | A replacement worker reads `RENGINE_MCP_CONTEXT_SNAPSHOT` but drops its `agent` | `a replacement worker keeps the identity` | Test 2. First run failed as a bare `TypeError` on `second.agent.agentId`; the assertion was changed to `second.agent?.agentId` so it names itself, and the sabotage was repeated. |
| 6 | A context with no identity is given a fabricated one | `and claims none` | Test 2. This is `probeTools`' context: an anonymous caller must stay anonymous. |
| 7 | `bind` matches any root path but the target (`!==` for `===`) | `the instance that serves the directory is the one chosen` | Test 3. A first, wider sabotage (claim every live instance) went red on the *two-instance* refusal instead — right family, wrong assertion — so it was narrowed until the intended one tripped. |
| 8 | `bind` picks a winner instead of refusing when two instances claim the directory | `Missing expected rejection: two instances claiming one directory is a refusal that names both` | Test 3. |
| 9 | The empty-scan refusal stops naming the directories it scanned | `The input did not match the regular expression /rengine\/alpha/` | Test 3. |

## What the fixtures had to be shaped like to discriminate

- **Test 3 puts the project on the second instance discovery finds.** Alpha is scanned before beta,
  so a `bind` that takes the first live instance would have been accidentally right had the project
  been on alpha. Sabotage 7 depends on that ordering.
- **Test 2 runs the tool worker through a recording reverse proxy in front of a real runtime worker,
  which forwards to a real session host.** The header is therefore observed on the wire on both hops
  rather than inferred from the code, and `list_files` — a route the worker does not serve, so it
  goes through `forward()` — proves the header is harmless to the retained host.
- **The anonymous cases are in the same test as the identified one**, because "the header is present"
  and "the header is absent where it should be" fail in opposite directions and one fixture proving
  both is cheaper to keep honest than two.

## Two facts the code corrected

- **`scripts/agent.sh` execs the launcher.** Spec 095's Identity section said the launcher's *parent*
  is the pty session whose pid the host lists. It is not: `sessions.mjs` spawns
  `bash scripts/agent.sh …` and `launch_agent()` ends in `exec node …/launch.mjs`, so the launcher
  inherits that pid and `process.pid` *is* the session pid. The implementation matches either, and
  the spec has been corrected.
- **The state directory to scan is the base as well as its children.** `orchestrator/launch.mjs`
  defaults `--state` to `~/.local/state/rengine` itself, and `main.mjs` writes `sidecar.json` into
  whatever `--state` names, so this checkout's own descriptor is at `<base>/sidecar.json` while a
  consumer's `editor.sh` nests one per checkout at `<base>/<name>-<cksum>/sidecar.json`. Scanning
  only `<base>/*/sidecar.json` would never find the development orchestrator.
