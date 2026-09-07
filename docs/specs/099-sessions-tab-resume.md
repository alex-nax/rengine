# The Sessions tab resumes and attaches agent conversations (F95)

Date: 2026-09-07. Status: recorded from owner direction, given a third time after the picker shipped
on the wrong surface. Parent: [spec 097](097-agent-conversation-persistence.md), which persisted the
conversations and put the offer in `scripts/agent.sh` as a terminal prompt; and
[spec 096](096-agent-session-resume.md). This moves the offer to where the owner asked for it.

## The situation it answers

The owner has asked three times for one thing: the native Sessions tab should let them get back into
their agent work without typing `/resume` or pasting an id. In their words, it "should list all the
available ids to resume or be available to attach if session is active." Spec 097 built the picker as
a stdin prompt inside `agent.sh` — a real surface, but not the one asked for. The data it needs is now
all present as of 097 (merged at 64dc08e); what was missing is the native view over it.

Everything this needs already exists and is **not** re-derived or re-persisted here:

- Live agent panes come from the session list: `type === 'agent'`, each carrying `conversation` when
  it holds one (an agent that names its own conversations, such as `codex`, carries none).
- Past conversations are persisted per root by 097 and reach the desktop on `/api/state` as
  `conversations[rootId]`, each `{ id, agent, startedAt, lastSeenAt }`, bounded and most-recent-first.
- Resuming is `POST /api/terminal { rootId, type: 'agent', agent, conversation, resume: true }`, which
  `spawnTerminal` already honours: it sets `RENGINE_AGENT_RESUME`, so `agent.sh`'s own picker stays
  out of the way and the pane comes up already on that conversation.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The Sessions tab gains a **Conversations** section, above the existing recovery drafts and below the raw process list, that is the agent-centric view the owner asked for. The raw process list (every session, with Stop) stays, because stopping a runaway and seeing terminals and games is still its job. | Owner ("the sessions tab ... list all the available ids to resume or be available to attach if session is active") |
| 2 | A **live** agent pane offers **Attach** — the existing `session-view` path, opening a view onto the already-running pane — never Resume, because resuming a running conversation would fork it. | Owner ("be available to attach if session is active") |
| 3 | A **past** conversation — one the project remembers that no running pane holds — offers **Resume**, which starts an agent pane already on that conversation id. The person never types `/resume` and never pastes an id. | Owner ("list all the available ids to resume") |
| 4 | The two are **deduplicated by conversation**: a conversation a running pane holds appears once, as that live pane's Attach, and is not also listed as resumable. | Recommended; two rows for one conversation would invite forking it |
| 5 | A row that **cannot be resumed** — a live agent that names its own conversations, so rEngine recorded no id — is shown attach-only and marked *not resumable*, rather than offering a Resume that would silently start a second conversation. Because such an agent's conversations are never persisted, this case only arises for a live pane, and it is the one place a resume affordance had to be withheld on purpose. | Owner (requirement 5); the marker is recommended so a person understands why it will not return after it exits |
| 6 | Each row shows the **agent**, whether it is **live or past**, and **when it was last seen**, using the same age wording `describeAge` gives the terminal picker. The desktop formats the persisted `lastSeenAt`; it does not ask the service for a string. | Owner (requirement 4) |
| 7 | Rows use the existing session metrics and theme tokens only; no colour or row-size literal enters a native source, which the design guard enforces. | Codebase rule |

## What this does not do

It does not change the persistence, the bound, or the ordering of conversations (097 owns those). It
does not remove the `agent.sh` picker, which still serves a pane launched from a plain shell. It does
not write to any conversation or add a tool; the resume goes through the same `/api/terminal` a fresh
launch uses. It does not give `codex` a resumable id — it names its own — so its live panes are
attach-only and its conversations never appear as past rows.

## Verification

| Check | Establishes |
| --- | --- |
| `native-sessions.spec.mjs` — past conversations | with two conversations recorded for the root and no pane holding them, the Conversations section lists both, most-recent-first, each with a **resume** control keyed by its conversation id and no attach; the empty note is gone |
| `native-sessions.spec.mjs` — resume routes | pressing Resume on a past conversation creates an agent session **bound to that same conversation id** (not a freshly minted one) with the resume flag, proving the row wired `rootId`, `agent`, `conversation` and `resume` through rather than starting a new conversation |
| `native-sessions.spec.mjs` — live, not resumable | a running agent pane that holds no conversation (an agent menu) is listed with an **attach** control and marked not resumable, and offers no resume control — the one place a resume affordance is withheld |
| `native-sessions.spec.mjs` — the raw list still stops | the existing process list still lists every session with its Stop control, so the section that was there did not regress |

Each regression was observed failing for its own reason before the view existed — recorded in
`Codex-progress.md` Session 49. The controls are asserted through the automation bridge exactly as the
tracker and devices views are.

**Not verified here:** the live end-to-end resume of a real `claude` pane on the owner's machine, for
the same reason 096 and 097 carry it — a workspace whose host predates this cannot exercise it, and
this session runs inside that host. The first host started from this change should record, under
`docs/evidence/`, that the Sessions tab listed a prior conversation, that Resume brought it back rather
than starting a second, and that a live pane offered Attach — which, with 097's own live criterion,
closes the chain the owner has been asking about.
