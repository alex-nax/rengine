# The conversation IS the identity: reconciling specs 095 and 096

Date: 2026-09-07. Machine: macos. Branch: `feat/conversation-is-identity`, merged from
`main` (0b2359d, then 49ab287) and `origin/main` (c550214).

## What was wrong

Two lanes taught `orchestrator/agents/config.mjs` to pass Claude's `--session-id`, from two ends.

| lane | where the UUID came from | what it injected |
| --- | --- | --- |
| spec 095 (F90), `origin/main` c550214 | `agentIdentity()` minted it, or read it out of the launch's own flags; the `agentId` IS that session id | `--session-id <agentId>` beside `--mcp-config` |
| spec 096 (F91/F92), local `main` 0b2359d | `sessions.mjs spawnTerminal` minted it, passed it as `RENGINE_AGENT_CONVERSATION`, and `agentLaunch` read the `CONVERSATIONS` table | `--session-id <conversation>` appended to `consumes.args` |

Merged as they stood, one pane launch would have carried **both** flags with **two different UUIDs**.
The observable damage is not a crash: the CLI would take one of them, the workspace would record the
other, and `restart_agent` would then "resume" a conversation the CLI had never been in — a second
conversation wearing the name of the first.

## The reconciliation

The owner's rule, verbatim (2026-09-07, vtmb-vr workspace):

> "Each claude session has identifier … on every session exit claude tells us to use
> `claude resume <id>`, token should be bound to that identifier."

Taken literally there is one identifier, so the conversation IS the identity.
`claudeIdentity()` is the single place that decides which UUID that is, in this order:

1. the launch's own flags (`--session-id`/`--resume`/`-r <uuid>`) — `source: 'flag'`, nothing injected;
2. `bind.mjs --session <id>` — `source: 'bound'`, injected as `--resume`;
3. the host's `RENGINE_AGENT_CONVERSATION` — `source: 'workspace'`, injected once as `--session-id`,
   or `--resume` when `RENGINE_AGENT_RESUME=1`;
4. a mint — `source: 'minted'`, injected as `--session-id`.

`-c`, a search-term `--resume` and `--fork-session` are `known: false`: nothing is injected and
`plan.conversation` is `null`, which tells the host to claim nothing for that pane.

A person's own flags beat the host's conversation rather than being refused, because `launch.mjs`
reports the decided id back over `POST /api/agent-conversation`: the record follows what actually
launched. Refusing would have made the launcher's decision and the host's record two authorities
again, which is the defect being removed.

## Sabotage table

Each regression was observed failing **for its own reason**: the implementation was broken in the
specific way the test claims to catch, the red was confirmed to be that and not something earlier,
then the change was restored. Every case produced exactly one failing test.

| # | sabotage | file | test that went red | the assertion it failed on |
| --- | --- | --- | --- | --- |
| 1 | drop the `conversation` branch from `claudeIdentity`, so the host's conversation is ignored and a UUID is minted instead | `agents/config.mjs` | a pane launch carries exactly one conversation… | "the host's conversation IS the agentId, not a second uuid beside it" — got `7650f5e7-…`, wanted `aaaaaaaa-…` |
| 2 | make `conversationArgs` always `talk.start`, so a resume is started with `--session-id` | `agents/config.mjs` | a pane launch carries exactly one conversation… | "a resume names the same conversation with --resume, and still only once" — argv had `--session-id` where `--resume` was expected |
| 3 | make `conversationArgs` also inject for `source: 'flag'` | `agents/config.mjs` | a person's own --resume wins… | "the args pass through untouched, with no second identifier injected beside them" — argv carried `--session-id` *and* the person's flag |
| 4 | check `conversation` before the launch's own flags in `claudeIdentity` | `agents/config.mjs` | a person's own --resume wins… | "--session-id names the conversation this launch will be" — got the host's `aaaaaaaa-…`, wanted the person's `bbbbbbbb-…` |
| 5 | set `plan.conversation = bound.agentId` unconditionally | `agents/config.mjs` | a launch that continues or forks reports no conversation… | "null, not undefined: the host is told to claim nothing for this pane" — got a minted uuid, wanted `null` |
| 6 | make a `null` report keep the pane's existing conversation | `server/sessions.mjs` | the host record follows the launch… | "a launch that claims nothing leaves the pane holding nothing" — pane still held `bbbbbbbb-…` |
| 7 | make `restartAgent` spawn with `conversation: undefined, resume: false` | `server/sessions.mjs` | a restart puts the pane back on the same conversation… | the spawn options differed on `conversation` and `resume` |
| 8 | drop the id prefix from `agentTitle` | `server/sessions.mjs` | binding outside the workspace mints and injects… | "so does the pane title" — got `claude · project`, wanted `claude 0cb75de0 · project` |
| 9 | drop the prefix from the picker row `printf` | `scripts/agent.sh` | a pane offers the conversations this project already has | "each row leads with the prefix the conversation goes by" — rows printed only the age and the full id |
| 10 | make `agentLabel` ignore the `agentId` | `agents/config.mjs` | a conversation the workspace persisted is a known identity to the token ledger… | "under the label derived from that id and the agent" — got `claude`, wanted `claude aaaaaaaa` |

Cases 1–8 and 10 were driven by `/tmp/sabotage.py` (apply, run the one test by name, restore);
case 9's red was re-observed by hand to capture the printed rows, which the harness could not
extract from a `assert.match` failure.

## Tests

New, `orchestrator/tests/conversation-identity.test.mjs`:

| test | establishes |
| --- | --- |
| a pane launch carries exactly one conversation, and that conversation is the identity | the host's conversation is the `agentId`; exactly one of `--session-id`/`--resume` on the argv; `session.source: 'workspace'`, `known: true`; the label is `claude <first eight>`; a resume names the same id with `--resume` and the identity is unchanged across it |
| a person's own `--resume` wins over the host's conversation, and the record follows the launch | for `--session-id`, `--resume` and `-r`: the identity is the person's uuid, the args pass through untouched, the host's uuid is nowhere on the argv, and `plan.conversation` is the person's uuid; `--resume=UUID` in the inline spelling, lowercased |
| a launch that continues or forks reports no conversation rather than claiming a minted one | `-c`, `--continue`, a search-term `--resume` and `--fork-session` all give `known: false`, inject nothing, and report `conversation: null`; codex, absent from the table, reports nothing at all |
| the host record follows the launch, including when the launch claims nothing | a reported id replaces the pre-minted one in the pane and in the persisted list, and refreshes the pane title; a `null` report clears the pane and persists nothing, so `restart_agent` refuses by name |
| a restart puts the pane back on the same conversation, so the identity survives it | `restartAgent` spawns with the same conversation and `resume: true`, and the plan that produces has the same `agentId` and label — so the token holder survives a restart |
| binding outside the workspace mints and injects, and the eight characters are the same everywhere | `bind.mjs` with no host conversation mints, injects `--session-id` exactly once, and the same prefix appears in the label, in `agentTitle` and in the per-launch context the tool worker sends |
| a conversation the workspace persisted is a known identity to the token ledger after a restart | a store reopened on the same directory still lists the conversation, and a ledger reopened on the same runtime directory knows it by the very same id under `claude <first eight>` — the persisted-state agreement, with nothing to migrate |

Extended: `orchestrator/tests/conversation-picker.test.mjs` (each row leads with the prefix).
Unchanged and still green: `agent-config.test.mjs`, `agent-identity.test.mjs`, `sessions.test.mjs`,
`conversations.test.mjs`, `environment.test.mjs`, `project-token.test.mjs`.

## Gates

Run in `.cache/worktrees/reconcile` at `0c80bcd` (both merges in):

| gate | result |
| --- | --- |
| `node --test orchestrator/tests/*.test.mjs` | 145/145 |
| `npm run test:desktop` | 48/48, including `native-token`, `native-token-e2e`, `native-tracker` and `native-sessions` together |
| `ctest` (`.cache/desktop`) | 6/6 |
| `node orchestrator/build.mjs` | clean, zero warnings under the picky flag set |
| `python3 tools/features.py validate` | 49 features |
| `python3 tools/design.py check` | consistent |

Before `npm run build:surface` had been run in this fresh worktree, five desktop specs failed on the
missing SDL surface fixture; with it built, two remained (`native-explorer` cap,
`native-render` metal edge band) and both passed when run on their own here **and** on a control
worktree at `0b2359d`, so they were the known timing/GPU flake rather than the merge. The full
desktop suite is green on the final tip.

## Not verified here

A live pane. The same gap specs 096 and 098 record: this session runs inside a session host that
predates all of it, so the first workspace started from a host carrying this change should record —
under `docs/evidence/` — that a pane launched with one `--session-id`, that `token_status` names the
holder by the conversation's first eight characters, and that `restart_agent` kept the token.
