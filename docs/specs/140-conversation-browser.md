# Spec 140 — the conversations an agent CLI already has

Owner request, 2026-09-15: *"So if I'm in claude and write `/resume` - I see the list of
conversations. Can we expose it for the editor?"*

Status: **design; nothing implemented.** Rows F210–F212.

## Why this is not the same as what rEngine already does

Spec 096 already mints a conversation at launch (D3), records it on the session (D5), and
`actions/pane/posix/agent.sh` already offers a chooser from a `RENGINE_AGENT_CONVERSATIONS` file. That covers
**panes rEngine started**.

`/resume` lists something larger: every conversation the CLI itself holds for this project,
including ones begun outside the editor — a terminal, another machine's checkout, a session that
predates the workspace. This session is one of those: it was not launched by rEngine and so appears
in no session record, yet it is in Claude's own store.

So the two are complements. rEngine's record knows which pane a conversation belongs to; the CLI's
store knows every conversation there is. A browser that reads the store and *joins* rEngine's record
onto it can show both facts: what exists, and which of those the workspace has a pane for.

## What each CLI actually stores (measured 2026-09-15)

| CLI | location | grouped by | identity | title |
|---|---|---|---|---|
| **claude** | `~/.claude/projects/<slug>/<uuid>.jsonl` | project, by a **path-derived slug** | filename is the session id | last `ai-title` entry's `aiTitle` |
| **codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | **date, not project** | in the filename | inside the file |
| **kimi** | `~/.kimi-code/sessions/wd_<name>_<hash>/`, indexed by `session_index.jsonl` | **working directory**, via a real index | `sessionId` in the index | — |

Three consequences follow from the table and none of them are guesses:

1. **Only kimi can be listed without opening files.** Its index carries `{sessionDir, sessionId,
   workDir}`, so filtering to a project is a read of one file. claude needs a directory listing plus
   a tail of each file for the title. codex is the expensive one: its tree is partitioned by date,
   so "which of these belong to this project" cannot be answered without opening every candidate.
2. **claude and kimi key by PATH**, so a checkout at a different location on another machine does
   not match — the identical problem spec 137 met for memories, with the identical answer: identity
   is the declared project and root id, and the path-derived key is an implementation detail of the
   CLI that rEngine maps rather than adopts.
3. **A title is not guaranteed.** Of four claude transcripts for this project, one had an `ai-title`
   and three had none. The list needs a fallback — the first user message reads well and is already
   in the file — and must not show a bare UUID.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **Read the CLI's store; never write it.** The transcripts are the CLI's own format and its to change. rEngine lists and resumes; it does not edit, prune or migrate. A store it cannot parse is reported as unreadable, never repaired. | Recommended |
| 2 | **One adapter per CLI**, shaped like spec 137's per-agent slots, each answering: which conversations exist for this root, and for each an id, a modified time and a title. An agent with no store says so; it does not show an empty list. | Recommended |
| 3 | **Resume through the path that already exists** — spec 096's `--resume` capability and `RENGINE_AGENT_RESUME` — rather than a second mechanism. Choosing a conversation spawns a pane on it exactly as the chooser does today. | Spec 096 applied |
| 4 | **Join rEngine's record onto the store, and show which is which.** A conversation the workspace has a pane for is marked; one the CLI holds but the workspace never launched is listed all the same. Showing only the first is what the owner already cannot see; showing only the second discards what rEngine knows. | Recommended |
| 5 | **Identity is the declared project and root id.** The CLI's path-derived key is mapped, never adopted. | Spec 137 precedent |
| 6 | **Listing is on demand**, not on a timer — the devices/tasks rule. codex's date-partitioned tree in particular must not be walked on every frame. | Recommended |

## What this does not do

- It does not write, prune or migrate any CLI's conversation store.
- It does not invent a conversation for a CLI that has none.
- It does not replace spec 096's minting: a pane rEngine launches still gets a named conversation,
  and that is what makes the join in decision 4 possible.
- It does not make a conversation from another machine resumable here. The transcript is local; only
  its existence would be knowable remotely, and that is not in scope.

## Acceptance

1. For a root, the view lists the conversations claude holds for it, each with an id, a modified
   time and a title — falling back to the first user message where `ai-title` is absent, and never
   showing a bare id.
2. A conversation the workspace has a session for is marked as such; one it does not is still listed.
3. Choosing one starts a pane resumed on it through the existing capability; a CLI that does not
   declare resume has the action refused by name rather than hidden.
4. An agent with no conversation store reports that, distinguishably from an empty list and from a
   store it failed to read.
5. Nothing under `~/.claude`, `~/.codex` or `~/.kimi-code` is modified by any of it, asserted rather
   than assumed.

## Prerequisite

**KI-116**: the live host advertises one capability of twelve because it predates them. Decision 4's
join needs `agentConversations`, so this feature cannot be demonstrated end to end against a host
that old — replacing it comes first, and that ends its sessions, which is the owner's call.
