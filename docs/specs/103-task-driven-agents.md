# Task-driven agents: the token serialises writes, the Sessions tab revokes it, the Tasks pane spawns and decomposes (F105)

Date: 2026-09-07. Status: recorded from owner direction, given directly in the vtmb-vr workspace after
the project token (spec 095) was seen live:

> "On sessions tab - there should be a possibility to revoke token so that another agent can claim it.
> This token will be used in some mcp actions that require to be done serially, eg. we cannot write to
> one file simultaneously or 2 agents cannot edit features.json at the same time, our task system should
> be tighter coupled, going back to tasks pane - we need advanced controls there - up to spawn a selected
> agent/model for the task, or decompose it, etc."

Parent: [the project token](095-project-token.md), [task tracking](083-task-tracking.md), [the Sessions
tab](099-sessions-tab-resume.md), [agent conversations](096-agent-session-resume.md) and
[conversations that outlive the host](097-agent-conversation-persistence.md). This spec changes one
decision of spec 083 (its read-only rule, for the local backend only) and says why the token is what
makes that change safe.

## What the owner is asking for, in three parts

1. **The token is the serialiser for shared project state.** Two agents must never write the same
   file at once, and two agents must never edit `features.json` at once. The token already gates
   launching, stopping, scripts, captures and layer updates; the owner names writes as the next class.
2. **The Sessions tab revokes it.** The status-bar popover (spec 095 stage 3) can already reject, grant,
   revoke and free. The owner wants the revoke where the agents are listed, so "take it from that one
   so another can claim" is one gesture next to the agent it concerns.
3. **The Tasks pane becomes an orchestration surface**, not a list: pick a task and **spawn a chosen
   agent and model on it**, or **decompose it** into subtasks, "etc." — the pane drives work, and the
   task system and the agent system stop being two things that happen to share a file.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The Sessions tab marks which agent session **holds the token** and offers **Revoke** beside it (and **Free** when the holder is gone); a revoked token is free and the next `token_contest` claims it. The gestures send the same `token-action` frames the popover sends; no second path. | Owner (revoke on the Sessions tab); Free recommended |
| 2 | **Workspace-mediated writes to project state are token-gated and serialised.** New MCP tools `task_add`, `task_update` and `task_decompose` write the local task inventory through the project's own declared command, only for the holder, one at a time per root (a per-root write lock behind the gate). A non-holder is refused by name, as launch is. | Owner (serial writes); the tool set recommended |
| 3 | Spec 083 decision 1 is **amended for the local backend only**: the workspace writes `features.json` — never by editing JSON itself, always by invoking the project's declared write command, which is the validated path the project already trusts (`tools/features.py add …` in vtmb-vr). GitHub and Linear stay read-only: the token serialises one workspace, and the missing `If-Match` on those APIs is not solved by it. | Recommended; owner-implied ("2 agents cannot edit features.json at the same time") |
| 4 | Writes an agent performs with its **own** tools (its editor, its shell) cannot be gated by the workspace and are not pretended to be. For those, the token is a **convention**: an agent takes it with a reason before an exclusive edit ("editing src/…"), the hold and its reason are on the feed and in `token_status`, and the project's agent instructions say so. Enforcement covers what passes through the workspace; visibility covers the rest. | Recommended, stated so nobody reads the gate as a lock it is not |
| 5 | The Tasks pane gains per-task controls: **Spawn** opens a chooser of installed agents and their models and starts an agent pane on a fresh conversation seeded with the task; **Decompose** starts an agent pane with a decomposition brief whose only legitimate output is `task_add` calls that create subtasks under the task; **Hold token** claims the token for a chosen live agent from the pane (the human's grant, as the popover's Grant). | Owner (spawn a selected agent/model, decompose, "etc."); Hold token recommended |
| 6 | A conversation started from a task **records the task** (`task: "F123"` on the spec 097 conversation record), so the Sessions tab and `workspace_info` show which task an agent works, and the Tasks pane shows which agents work a task. | Recommended — "tighter coupled" needs a join, and the conversation record is the one durable per-agent thing |
| 7 | Prompts are **project files, not declaration keys**: `.rengine/prompts/task.md` and `.rengine/prompts/decompose.md`, templated with `${id}`, `${key}`, `${title}`, `${criteria}`, `${labels}`; rEngine ships defaults used when a project has none. A prompt file changes without a contract bump or a host replacement. | Recommended |
| 8 | The write command and the agent/model menu are **declaration keys**, contract 6: `tracker.write` (literal argv with `${json}` — the project's own tool, no shell) and `agents` (each: `cli`, `models[]`, `default`); absent, the menu is the installed CLIs with rEngine's known model lists. Per the schema-freeze rule (spec 098), code lands first, hosts are replaced, declarations change last. | Recommended; the owner already ruled that order today |
| 9 | Every task write and every spawn is a **feed frame** (`task.updated`, `task.added`, `agent.spawned` with the task, agent, model and conversation), so the holder's monitor sees the task system move. | Owner (the monitor carries the project's lifecycle) |

## Why the token makes writing safe where spec 083 said it was not

Spec 083 refused writes because neither remote API offers optimistic concurrency and a desktop writing
"last wins" over a teammate's web edit is worse than no write. That reasoning stands for GitHub and
Linear. For the local inventory the writer is a **file in this checkout**, the conflict is between
agents of this workspace, and the token is exactly a serialiser for agents of this workspace: one holder,
one write at a time, every hold and write on the feed. The project's own validated command does the
edit, so the schema stays the project's, and a merge conflict with another checkout stays what it is
today — a git merge a person resolves.

## Surfaces

**Sessions tab.** In the Conversations section a live agent row that holds the token carries a token
mark and **Revoke**; when the ledger's holder pid is gone the row carries **Free**. Both send
`token-action` (`revoke` | `free`) with the root, exactly as `re_token_ui` does; the ledger answers with
the next `token` frame and the row follows it. No new pane, no new tab type, no enum change.

**Tasks pane.** Each task row gains a control cluster: **Spawn ▾** (agent · model), **Decompose**,
**Hold token ▾** (live agents). The cluster reads the `agents` menu and the live agent list the
dashboard already has; availability follows the tracker's provider (`local` writes; remote rows offer
Spawn only). A task that agents are working shows their labels (`claude 5b8d47c2`).

**Workspace worker.** `POST /api/task` (`add` | `update` | `decompose`) — token-gated, one at a time
per root, running the declared `tracker.write` argv with the row as `${json}` on the project's own
tool; `POST /api/agent-spawn` — starts an agent pane through the host's existing terminal route with
the CLI's model flag in its args and the prompt as its initial argument, then records `task` on the
conversation. Both are worker routes so they arrive by a layered update.

**MCP tools.** `task_add`, `task_update`, `task_decompose` (holder only, refused by name otherwise),
`spawn_agent` (holder only: an agent spawning agents is an act on the project), `list_agents_menu`
(read). Descriptions name the token.

## Prompt defaults (shipped, overridable per project)

`task.md`: the task's key, title, criteria and labels; the instruction to read the project's agent
instructions first, to take the token before exclusive edits, and to record progress the project's way.
`decompose.md`: the same task, then: produce subtasks as `task_add` calls with `parent: ${key}`, each
with one acceptance criterion, none implemented; report the ids; release the token.

## Boundaries

- No environment variables. No credential in the declaration. Loopback only.
- The workspace never edits `features.json` text itself; it runs the project's declared command.
- Remote trackers remain read-only; Spawn works on their rows, Decompose does not.
- Decompose creates rows, never implementations; an agent that starts coding under a decomposition
  brief has misread the brief, and the brief says so.

## Acceptance criteria (F105)

1. On the Sessions tab, the live agent holding the token is marked and offers Revoke; pressing it frees
   the token (a `token.revoked` frame `by: desktop`), and another agent's `token_contest` then claims it.
   A holder whose process is gone offers Free, with the same effect.
2. `task_add`/`task_update`/`task_decompose` from a non-holder are refused naming the holder and
   `token_contest`, and nothing is written; from the holder they run the declared `tracker.write` command
   with the row as JSON and the inventory changes accordingly; two holders in sequence never interleave a
   write (proved with a slow fake write command and two callers).
3. A project without `tracker.write` is told so by name; GitHub/Linear providers refuse writes by name.
4. Spawn from the Tasks pane starts an agent pane with the chosen CLI and model, on a fresh conversation
   seeded with the task prompt, records `task` on the conversation, and the Sessions tab and
   `workspace_info` show the task beside the agent; `agent.spawned` is on the feed.
5. Decompose starts an agent on the decomposition prompt; in a fixture with a scripted agent, the
   resulting `task_add` calls create child rows with `parent` set and no other file changes.
6. `.rengine/prompts/*.md` override the shipped prompts; a missing file uses the default; a template
   placeholder the project misspells is reported, not silently emptied.
7. Contract 6 (`tracker.write`, `agents`) validates; a contract-5 declaration is accepted unchanged; an
   older host is refused by name on the new keys per the spec 098 order.
8. Everything above ships in replaceable layers (worker, connector, desktop); the host is unchanged
   except that the conversation record accepts `task`, which lands at the next replacement and is
   refused by name before it.

## What shipped (the workspace half, 2026-09-07)

Decisions 2–4 and 6–9, plus decision 5's `assign` for the Tasks pane's *Hold token*, are in
`contracts/project-v1.schema.json`, `orchestrator/server/tasks.mjs`, `orchestrator/runtime/worker.mjs`,
`orchestrator/runtime/token.mjs`, `orchestrator/agents/mcp-worker.mjs` and
`orchestrator/templates/prompts/`. The native halves — the Sessions tab's Revoke/Free and the Tasks
pane's control cluster — are separate lanes against the routes below. Evidence, including the
sabotage table, is [task-writes-2026-09-07](../evidence/task-writes-2026-09-07.md). Corrections
against the paragraphs above, each because the code says otherwise:

- **The host is not unchanged in one way; it is unchanged in two.** Criterion 8 says the host changes
  only to accept `task` on the conversation record. It also had to **forward an agent pane's `args`
  to its CLI**: `spawnTerminal` overwrites `argv` for `type: 'agent'` and, before this, accepted the
  caller's `args` and dropped them. A spawn through the unchanged route therefore started a CLI with
  no model flag and no prompt, and looked entirely successful doing it. Both changes are announced as
  one capability, `taskConversations: 1`, and `/api/agent-spawn` refuses by name without it — so the
  spec-098 order still holds, and the refusal covers the silent half as well as the visible one.
- **The neutral row gained `criteria`.** The prompt defaults say the brief carries the task's
  criteria, and spec 083's row carried none. `criteria` is now part of the row, filled from the local
  inventory's `acceptance_criteria` and empty for a remote provider, whose issue body is prose rather
  than criteria.
- **`task_decompose` writes one child row, not a plan.** Decision 2 lists it among the write tools and
  decision 5 gives Decompose to an agent brief; the tool is therefore the write a decomposition makes:
  the declared command with `action: "decompose"` and a **required** `parent`. A decompose write with
  no parent is refused rather than filed at the top level.
- **The `${json}` document is the row plus two fields the workspace knows.** `action` and, when there
  is one, `parent` are added to the row, with `action` written **last** so a row carrying its own
  `action` cannot rename the call.
- **`tracker.write`'s contract floor is checked inside the block.** The `tracker` block is contract 5
  and only this key is contract 6, so the floor is a tracker cross-rule rather than a section
  minimum; `agents` is a plain root field and is checked beside `title`/`icon`.
- **Three capabilities, not one.** `taskWrites: 1` and `agentSpawn: 1` are advertised only by a worker
  that owns the ledger, because both are gated and both mint a feed frame; `agentsMenu: 1` is
  advertised by every worker with the route, because reading the menu needs no ledger.
- **`assign` refreshes the host state first.** It resolves an id against the conversations the project
  remembers, and the desktop's `/events` socket has no other reason to re-read them, so a conversation
  started since the worker did would otherwise be an id the frame could not name.
- **The declaration template is prose, not JSON.** `orchestrator/templates/project/project.json` is a
  contract-3 reference a consumer copies from, and JSON carries no comments; contract 6's two keys are
  documented in `orchestrator/templates/project/README.md` instead, with the schema-freeze order
  (spec 098) stated beside them. rEngine's own `.rengine/project.json` stays where it is: declarations
  change last.
