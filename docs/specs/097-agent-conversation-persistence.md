# Conversations that outlive the host, and a pane that offers them (F93)

Date: 2026-09-07. Status: recorded from owner direction, given directly in the hirebase-v2 workspace
immediately after [spec 096](096-agent-session-resume.md) shipped and did not solve their problem:

> "I've even created new agent tab and resumed the session (I thought you've made the interface for
> sessions not to do manual /resume)"

Parent: [spec 096](096-agent-session-resume.md), which named the conversation a pane holds. This
finishes the job it started.

## The situation it answers

Spec 096 recorded a pane's conversation on the session record and let `restart_agent` put a new pane
back into it. That is genuinely useful and genuinely insufficient, for a reason the owner found
before we did: **session records live only in the session host's memory**. `Sessions` keeps them in a
Map; the workspace state file persists roots, drafts, layout and preferences, and nothing else. So
every conversation a host knows about dies with that host.

The consequence is that 096 solved the smaller half. Inside one host's lifetime a pane could be
restarted into its conversation. Across a host restart — which is exactly what the owner had to do,
twice, to clear the environment defect 096 was written for — the workspace remembered nothing, and
the only way back into yesterday's work was to type `/resume` by hand and pick from the CLI's own
list. The feature was shaped for the wrong event. It has to survive precisely the event that a
person reaches for it after.

There is a second gap of the same shape. 096 could restart an **existing** pane. It could not help
someone opening a **new** one, which is what a person actually does after a restart, because the old
pane is gone. Choosing which conversation a new pane attaches to was deferred as a native session
browser, and that deferral is what the owner ran into.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | Conversations are **persisted per project root** in the workspace state file, beside roots and drafts, so they survive the session host that recorded them. Nothing about resuming is meaningful without this. | Owner ("Persistance first") |
| 2 | The list is **bounded** at 20 per root, most recently seen first, so a long-lived project cannot grow the state file without limit. Re-recording an existing conversation touches it and moves it to the front rather than adding a row. | Recommended |
| 3 | A conversation is recorded when a pane **actually launches with it**, not when one is minted, so the record follows what happened. The workspace still mints eagerly, and also records that, so a new conversation is remembered from its first moment. | Recommended |
| 4 | The **pane offers the choice**, in the terminal where the agent is already chosen, rather than waiting for a native browser. The workspace writes the project's conversations for the pane and the launcher lists them; Enter starts a new one. | Owner ("list sessions by the agent session list so we better control what session we are attaching into"); the pane as the place is recommended, and is what removes the manual `/resume` now |
| 5 | Only an **explicit resume** suppresses the offer. A workspace-minted identifier means "this pane is new", not "this pane has chosen", so a fresh pane still sees what it could resume instead. A `restart_agent` that already named its conversation is never asked. | Recommended; the first draft got this wrong and the offer never appeared |
| 5a | **The offer is for an interactive bare launch only.** A launch that carries an initial prompt — a pane the workspace started on a task (spec 103) — is never asked either, and the workspace writes it no listing. Amended 2026-09-07 from the live failure in decision 5's own shape, from the other side; see *The scope decision 5 was missing* below. | Owner-observed failure; the narrowing is recommended |
| 6 | The listing is written **only when there is something to offer**, and excludes the pane's own new conversation, so a project with no history never prompts and a first pane is never asked to resume itself. | Recommended |
| 6a | **The listing is written only for a bare pane.** A caller that names `conversation` (a Sessions-tab Resume, `restart_agent`) or passes `args` (a spawn) has already decided what its pane is and is never offered a list. Amended 2026-09-07. | Recommended, with 5a |
| 7 | The pane **reports what it launched** back to the workspace, because the person may have chosen something other than what was minted. The session record and the persisted list both follow the pane, not the intention. | Recommended; follows from decision 3 |
| 8 | Conversations appear in `workspace_info` for the bound root, so an agent can see the project's history without a new tool. | Recommended |

## What this does not do

It does not add the native session browser. Decision 4 puts the choice in the pane, which is where
the agent is already selected and where it removes the manual `/resume` today; drawing a browser over
the same persisted list stays available and is now a presentation change rather than a data one. It
does not give Codex a mintable conversation, so nothing is recorded for it and its rows never appear.
It does not attempt to verify that a remembered conversation still exists in the CLI's own storage:
if a person deletes it there, the resume fails in the CLI, which is the only component that knows.

## Verification

| Check | Establishes |
| --- | --- |
| `conversations.test.mjs` | a conversation recorded by one store is listed by a second store opened on the same directory, ordered most recent first, not duplicated when re-recorded, scoped to its own root, refused for a bad identifier or an unknown root, and bounded at 20 with the oldest dropped |
| `conversation-picker.test.mjs` | the pane lists what the project has with when each was last seen, resumes the chosen one, keeps a minted id on Enter, refuses an out-of-range choice rather than guessing, stays silent with no listing / an empty listing / another agent's rows, is not asked again after an explicit resume, and — decision 5a — is not asked at all when the launch carries an initial prompt, while the same launch without its arguments still is |
| `sessions.test.mjs` (2026-09-07) | decision 6a: the listing is written for a bare pane with history, and for neither a launch that passes `args` nor one that names its `conversation`; and a listing the host merely inherited never reaches a pane |
| `sessions.test.mjs`, `agent.test.mjs` | the 096 guards and the existing launcher behaviour still hold |

Observed failing for their own reason first: the store methods did not exist, the offer never
appeared, and — after the first implementation — a workspace-minted identifier silently suppressed
the offer entirely, which is decision 5 and was caught by the test that pins it.

## The scope decision 5 was missing (amended 2026-09-07)

Decision 5 asks the right question — *has this launch already chosen?* — and answers it with the only
signal that existed when it was written. Spec 103 then added a second kind of launch that has chosen:
a pane the workspace starts **on a task**, whose rendered prompt is the CLI's own initial argument.
Nothing about it sets `RENGINE_AGENT_RESUME`, so decision 5 let it through, and the first
`spawn_agent` there ever was came up on the picker and blocked on stdin. It received a `1` — a click
into a pane is enough — and resumed the **spawning** agent's conversation in a second process.

So the rule is one step wider than decision 5 states it: the offer belongs to an interactive **bare**
launch, and both an explicit resume and an initial prompt are launches that have already chosen. The
guard lives in two places on purpose — `scripts/agent.sh` refuses to ask, and the workspace refuses to
write the listing for a caller that named a conversation or passed arguments — because a listing can
reach a pane from a stale environment as well as from this host, and the host can be older than the
worker that spawns through it. Evidence, with the reds and the sabotage table:
[spawn-no-picker-2026-09-07](../evidence/spawn-no-picker-2026-09-07.md) (KI-068).

The same evidence records a second defect found on the way, in this spec's own plumbing rather than
its decisions: `Sessions.spawnTerminal` composed the pane environment twice, and the second
composition re-inherited the pane-identity variables the first had deleted — so a host running inside
an agent pane handed every pane it spawned that host's own conversation, resume flag and listing.

**Not verified here:** the same live gap spec 096 records. A workspace whose host predates this
cannot exercise it. The first host started from this change should record, under `docs/evidence/`,
that a pane offered a prior conversation, that choosing it resumed rather than starting a second
one, and that the offer survived a host restart — which is the criterion 096 could not meet.
