# The project token: one agent at a time holds the extended commands, and hears the feed (F90)

Date: 2026-09-07. Status: recorded from owner direction, given directly in the vtmb-vr workspace:

> "When working on a project, our rEngine instance can issue a token to the agent, each other agent
> can contest for the token and if owner does not reject the contest in a sensible amount of time -
> than the contester can claim token for himself, token owner can do an extended set of mcp commands
> and receives feed updates (a monitor shared with token contest notification) such updates should
> include but not limit to starting a game instance, deploying to device, start/end gameplay capture."

Parent: [orchestrator](002-orchestrator.md) and [layered workspace updates](065-layered-workspace-updates.md),
whose boundary this spec is designed inside of. It gates tools that [project game declaration](078-project-game-declaration.md),
[project devices](082-project-devices.md), [interactive script tabs](071-interactive-script-tabs.md) and
[game recording](081-game-recording.md) introduced, and it gives those specs the lifecycle feed they never had.

## The situation it answers

On 2026-09-06 and 2026-09-07 one checkout of vtmb-vr had three agents acting on it at once: an agent
pane opened by the workspace, a second lane in another terminal, and a session that was never spawned
by the workspace at all and so had no MCP binding — it launched games by hand, wrote a wizard that
tried to start a remote instance, and asked the owner to press buttons it could not press. Nothing
in rEngine could say *which* of them was allowed to start a game, deploy to the headset, or begin a
capture, and nothing told any of them that another had just done so. Two consequences followed:

- **Exclusive things were done concurrently.** `games.mjs` coalesces two launches of the same game
  and refuses differing args with a 409, which is the only arbitration that exists, and it is per
  call rather than per actor. A deploy to the Quest and a capture on the same device have no
  arbitration at all.
- **Nobody was told.** The desktop learns of a game session through `/events`; an agent learns only
  by polling `list_sessions`, and learns nothing about a recording being committed or a deploy
  script starting. The owner's phrase is exact: the token holder needs *a monitor*.

So this spec adds three things and refuses to add a fourth: an **identity** for each agent bound to
a project, a **token** per project that the identity can hold or contest, and a **feed** of
lifecycle events that the holder's monitor watches. It does **not** add an access boundary — see
*What the token is not*.

## Decisions

| # | Decision | Attribution |
| --- | --- | --- |
| 1 | The instance issues **one token per project root**. It is held by at most one agent identity at a time, or by nobody. | Owner |
| 2 | Any agent bound to that root may **contest**. A contest opens a window; if it is not rejected before the window closes, the token **transfers to the contester** at the deadline and the transfer is a feed frame. There is no separate claim call to forget. | Owner (contest, window, contester wins on silence); automatic transfer at the deadline recommended |
| 3 | A contest may be **rejected by the holder** — the notification lands on its monitor for exactly this — **or by the person at the desktop**. The person may also grant at once, revoke, or free the token. The holder's reject is a **liveness proof**: a holder that can answer a contest keeps the token, one that cannot is by definition not holding it, so the token is always held by an agent that is actually there. | Owner (2026-09-07): "Yes token holder may reject - it's the mechanism that ensures that token will be held by at least one agent." |
| 4 | The **extended set** is every tool that starts, stops, replaces or captures something the project owns: `launch_game`, `stop_session`, `open_script`, `dashboard_capture`, `reload_desktop`, `update_workspace`, and the recording controls when they exist. Reading never needs the token. Extended 2026-09-07, when spec 098 added one: **`restart_agent`** stops that pane's child and starts it again, which is `stop_session` by another name, so it is gated the same way and intercepted in the worker before the forward, exactly as `/api/stop` is. | Owner ("an extended set of mcp commands"); the membership is recommended |
| 5 | Without the token those tools **refuse by name**: who holds it, since when, and that `token_contest` is the way forward. Nothing is attempted. A **free** token is refused the same way, naming that it is free and that `token_contest` claims it at once — holding is deliberate, so every hold is a frame somebody can read. | House discipline (spec 078, *Who serves what*); the free-token reading is recommended |
| 6 | The person at the desktop is **never gated**. A dashboard click, a Stop, a record toggle are the owner's acts; the token arbitrates agents. | Recommended; follows from decision 3 |
| 7 | The **feed** is a stream of lifecycle frames only — token transitions, game sessions starting and ending, device-bound actions starting and ending, captures starting and being committed, workspace layers replaced — each with a monotonic sequence, resumable by cursor. PTY output never appears on it. | Owner (the listed events, "but not limited to"); the frame set is recommended |
| 8 | The feed is readable by **every** agent bound to the root. The token decides who may act, not who may watch; a contester has to see whether it was rejected. | Recommended |
| 9 | The window is a **workspace preference** with a default of 60 s, not an environment variable and not a declaration key. The retained host's preference store allowlists the keys it knows and drops the rest, so this one is owned by the workspace worker beside the ledgers: the worker intercepts `POST /api/preferences`, keeps `tokenWindowMs`, forwards the rest unchanged, and merges it back into `/api/state`. | Owner ("no envs"); the default is recommended, and the worker-side ownership follows from decision 10 |
| 10 | Everything ships through the **replaceable layers**. The ledger lives in the workspace worker and persists in the runtime directory; the tool worker adds identity to its calls; the desktop draws one status-bar segment. The retained session host is not touched, per spec 065. | Owner ("do not forget about our layered restarts") |
| 11 | A holder whose process is gone holds nothing. A contest against a dead holder resolves at once, without a window. | Recommended |
| 12 | An agent that was not spawned by the workspace **binds by discovery**: it asks the sidecars in the state directory which one serves its project, and receives the same identity and MCP configuration a pane-spawned agent gets. No environment variable is required to find the workspace. | Owner ("maybe init.sh should be tighter bound to the editor", "you should not use any envs") |

## What exists today, and what is missing

The facts below are from the code as of `8ca5bbf`, so a reader can check each in one step.

- **Every agent on a root shares one context.** `sessions.mjs:132` writes `integrations/<rootId>.json`
  and points `RENGINE_WORKSPACE_CONTEXT` at it; `config.mjs:24` mints a per-launch directory for the
  MCP configuration but the context it references is the shared file. The MCP worker's `scopedState()`
  filters by `rootId` and nothing else. **There is no agent identity anywhere in the tool path.**
- **The desktop has a live channel; agents do not.** The host broadcasts `session` and `output` events
  to every `/events` socket (`main.mjs:153`); the worker forwards that socket and already intercepts
  frames on it for its own purposes (`worker.mjs:122-125`, `desktop-register`). The MCP facade declares
  only `tools.listChanged` — no resources, no notifications — and the agent CLIs in use do not surface
  server notifications into a conversation anyway.
- **The agent's own runtime has a monitor.** Claude Code's `Monitor` tool takes a WebSocket source and
  turns each text frame into a notification, and warns that a firehose is suppressed. Codex and the
  others can hold a background process on a URL. So the feed must be a **dedicated, filtered socket**,
  never the desktop's `/events` stream.
- **Recordings are committed by the desktop.** The recorder in `native/recording.c` writes segments;
  the worker only lists them (`recordings.mjs`). Nothing announces a commit.
- **Launch arbitration is per call.** `games.mjs` coalesces same-args launches and refuses differing
  args; that is the whole of it, and it says nothing about who asked.

## Identity

Owner decision, 2026-09-07, given verbatim in the vtmb-vr workspace:

> "Each claude session has identifier … on every session exit claude tells us to use
> `claude resume <id>`, token should be bound to that identifier."

So the identity is not a number rEngine keeps *beside* the agent. Where the CLI names its own
conversation, the **`agentId` IS that session id**, decided at launch from the flags the launch was
given and never inferred afterwards — not from a transcript, a process tree or a hook, each of which
an earlier attempt got wrong by guessing after the fact. That is what makes the binding outlive the
process: a Claude session that exits and comes back through `claude --resume <id>` is the same
identity, still holding whatever it held, and a lane that has forgotten its own id is a lane whose
token has to be taken away by hand.

An identity is `{ agentId, label, pid, startedAt, session?, sessionId? }`:

| field | is |
| --- | --- |
| `agentId` | the CLI's own session id where one is known, else a minted UUID |
| `label` | `<cli> <first eight of agentId>`, e.g. `claude 5b8d47c2`, so two Claude sessions on one root are two different things in the status bar and in a refusal — and the prefix is the id the person resumes by |
| `pid` | the process the session is running in *now* (see liveness, below) |
| `session` | `{ provider, id, known, source, resume }`, for the CLIs whose session flags have been checked against their own `--help`: claude and codex. Absent for the rest; nothing is invented for a CLI we have not verified. |
| `sessionId` | the workspace pty session the launcher runs under, when there is one |

It is written into a **per-launch context file** beside the MCP configuration that `config.mjs`
already creates, and that file — not the shared root file — is what the facade and the tool worker
read. Two agents on one root therefore differ, and a replaced tool worker keeps the identity because
it re-reads the file.

**How a Claude launch's id is decided** (`claude --help`, read on this machine 2026-09-07:
`--session-id <uuid>` "Use a specific session ID for the conversation (must be a valid UUID)";
`-r, --resume [value]` "Resume a conversation by session ID, or open interactive picker with optional
search term"; `-c, --continue`; `--fork-session` "When resuming, create a new session ID instead of
reusing the original"):

| the launch's own args | `agentId` | what rEngine adds to the CLI args |
| --- | --- | --- |
| none of the flags below, and no host conversation | a minted UUID, `source: 'minted'` | `--session-id <agentId>`, beside `--mcp-config` |
| none of the flags below, under `RENGINE_AGENT_CONVERSATION` | that conversation, `source: 'workspace'` | `--session-id <agentId>`, or `--resume <agentId>` when `RENGINE_AGENT_RESUME=1` |
| `--session-id <uuid>`, `--resume <uuid>`, `-r <uuid>` | that uuid, `source: 'flag'` | nothing; the args pass through unchanged |
| `-c` / `--continue`, or `--resume` with no uuid — its picker/search form | a minted UUID, `session.known: false` | nothing |
| `--resume <uuid> --fork-session` | a minted UUID, `session.known: false` | nothing — a fork is a new conversation, and its id is minted inside the CLI |

`known: false` is the honest case, not a failure: the CLI names that conversation itself, rEngine
never sees the id, and the identity is rEngine's own for that launch. The launcher's printed line
says so instead of offering a `--resume` command that would not work.

### The conversation IS the identity (reconciled 2026-09-07)

The second and third rows above are the reconciliation of this spec with
[spec 096](096-agent-session-resume.md), which arrived at the same flag from the other end. 096 has
the session host mint a UUID for a pane, pass it as `RENGINE_AGENT_CONVERSATION`, and inject
`--session-id` for it; this spec minted an identity and injected `--session-id` for that. Both were
right on their own and wrong together: a merged pane launch would have carried two `--session-id`
flags with two different UUIDs, and the record would have named a conversation the CLI was not in.

There is **one UUID**, and `claudeIdentity()` in `config.mjs` is the single place that decides which:

1. **The launch's own flags win.** A `--resume X` a person typed is the conversation this launch will
   be, even under a host conversation `Y`. This is not refused, because the launcher's identity is the
   single source and `launch.mjs` reports the decided id back to the host over
   `POST /api/agent-conversation` — so the record follows what actually launched rather than what the
   host intended. Two independent mints racing to pass the same flag is the failure this replaces.
2. **`bind.mjs --session <id>`** next, for a session that already exists outside the workspace.
3. **The host's conversation** — an ordinary pane. `source: 'workspace'`, `known: true`, and the id
   is injected exactly once, from the `CONVERSATIONS` capability table, as `--session-id` or, on a
   restart, `--resume`.
4. **A mint** otherwise, as row one.

`-c`, a search-term `--resume` and `--fork-session` inject nothing and report `conversation: null`,
so the host's record claims nothing and `restart_agent` refuses by name rather than opening a second
conversation that looks like a resume.

`RENGINE_AGENT_CONVERSATION` and `RENGINE_AGENT_RESUME` are **plumbing between two rEngine
processes** — how the host tells the launcher which UUID it minted — not user configuration. They are
cleared from every inherited environment before a spawn, and `bind.mjs` neither reads nor sets them:
binding names its session with `--session`.

Because there is one UUID, the eight characters that name it are the same everywhere a person meets
it: the identity `label`, the pane title (`agentTitle`), the rows of the 097 conversation picker, and
the token segment in the status bar. And the conversations spec 097 persists per root **are
identities**: the same id the ledger's identities registry keys on, under the same
`claude <first eight>` label, on both sides of a host restart — there is nothing to migrate, because
there was never a second number. A `restart_agent` therefore keeps the `agentId`, and with it the
token: the ledger's pid refresh (see *Liveness*, below) handles the new process.

Evidence, with the sabotage table: `docs/evidence/conversation-is-identity-2026-09-07.md`.

**Codex** already carries one: the handoff manifest's `sessionId`, which `resumeArgs()` hands to
`codex resume <id>`. Where a handoff is present that id is the `agentId` too. Gemini and OpenCode get
a minted UUID and no `session` descriptor.

The tool worker sends the identity on every call as three headers — `X-Rengine-Agent: <agentId>`,
`X-Rengine-Agent-Label` and `X-Rengine-Agent-Pid` — and the workspace worker reads them. The label
and pid travel because a refusal has to *name* the holder and the ledger has to know whether the
holder's process is still there, and the worker has no table to look either up in. A request without
the first header is the desktop's. The host ignores unknown headers, so this costs no host change.

**Liveness is the pid, and the pid follows the session.** `scripts/agent.sh` execs the launcher, so a
pane-spawned agent's `process.pid` *is* the pty session pid the host lists; `bind.mjs` records
`process.ppid`, the terminal that will run the CLI. Both are a process alive exactly while the agent
is, so no `boundBy` discriminator is needed and none was added. Because the identity is the session
and not the process, an identified request from the **holder's own `agentId` under a different pid**
refreshes the holder's pid and the identities registry: the resumed session keeps its token, and
`holder-gone` goes on meaning what it says rather than firing at every resume.

When an agent is spawned by the workspace, `launch.mjs` also records the pty session it runs under
where it can, so the desktop can show *claude · vtmb-vr* rather than a UUID. This spec first said the
launcher's *parent* is the session's shell whose pid the host lists; that is wrong. `sessions.mjs`
spawns `bash scripts/agent.sh …` and `launch_agent()` ends in `exec node …/launch.mjs`, so the
launcher replaces that shell and its own pid **is** the pid the host lists. The implementation matches
either the launcher's pid or its parent's, and records `sessionId` when one of them is a listed agent
session. Where neither matches, the label and pid stand.

**Binding from outside.** `node orchestrator/agents/bind.mjs --project DIR [--agent NAME]
[--session UUID] [--state DIR]` walks the sidecar descriptors under the state directory, asks each
live instance for its roots, picks the one whose root is `DIR`, gives the agent an identity, writes
the per-launch context and MCP configuration, and prints the configuration path and the CLI line that
consumes it. `--session` is the other half of the owner's decision: pass the id an existing session
resumes by and the binding *is* that session, and the printed line is
`claude --mcp-config <path> --resume <id>`; omit it and one is minted, printed as
`claude --mcp-config <path> --session-id <id>`. Without `--state` it scans both the base directory
and each of its children: a consumer's `editor.sh` nests one state directory per checkout at
`<base>/<name>-<cksum>`, while this checkout's own default state directory *is* the base, so
`main.mjs` writes `sidecar.json` straight into it. A consumer's launcher (vtmb-vr's `editor.sh`,
nolf-improved's) wraps that as `--bind`. Two instances claiming the same root is a refusal that names
both. This is the mechanism the owner asked for when a session that could not press a button asked
the owner to press it.

## The token and the contest

A **ledger** per root, owned by the workspace worker and persisted atomically as `token.json` under
the runtime directory, at `<runtime>/tokens/<rootId>/token.json` with the root's retained feed beside
it as `feed.json`:

```
{ version: 1, rootId, holder: { agentId, label, pid, since } | null,
  contest: { id, contester: {...}, openedAt, windowMs, deadline, reason } | null,
  cooldown: { [agentId]: until }, sequence,
  identities: { [agentId]: { agentId, label, pid, firstSeenAt, lastSeenAt } },
  history: [ ...last 50 transitions ] }
```

`identities` is every identity the worker has seen on the header for this root, which is what
`token_status` lists as candidates. The workspace-wide `tokenWindowMs` and the worker generation live
in `<runtime>/tokens/preferences.json`, beside the ledgers rather than inside any one of them.

Transitions, each a feed frame:

| From | Call | Result |
| --- | --- | --- |
| free | `token_contest` | `token.claimed` at once; caller holds it |
| held, holder alive | `token_contest` by another | `token.contested` with `deadline = now + window`; the holder's monitor carries this frame |
| contest open | `token_reject` by the holder, or *reject* at the desktop | `token.rejected` with the reason; the contester enters a cooldown of one window and cannot re-contest before it |
| contest open | *grant* at the desktop | `token.claimed` at once, `by: desktop` |
| contest open, deadline passed | (timer, or the next call) | `token.claimed` by the contester, `by: deadline` |
| held, holder pid gone | `token_contest` | `token.claimed` at once, `by: holder-gone` |
| held, no contest open | `token_release` by the holder, or *free* at the desktop | `token.released` |
| contest open | `token_release` by the holder | `token.claimed` at once by the contester, `by: { kind: 'release', agentId, label }` naming the holder that let go |
| held | *revoke* at the desktop | `token.revoked`; nobody holds it |

A second contest while one is open is refused naming the open one; a holder contesting its own token
is a no-op that reports it holds it. Deadlines are absolute wall times so a replaced worker resumes
the countdown from the file rather than restarting it (decision 10).

**A contest is answered, or it times out; it is never left hanging.** Two defects were seen live on
2026-09-07 and are closed here, each with its own regression in
[`agent-session-identity-2026-09-07.md`](../evidence/agent-session-identity-2026-09-07.md):

- **A release under an open contest hands the token straight to the contester.** Releasing used to
  free the token and leave the contest open, which is the worst of both: the contester could not act
  (it does not hold it), could not re-contest (a second contest is refused while one is open) and had
  to wait out a window against a token nobody held. The release is the contest answered, so the frame
  is one `token.claimed` attributed to the release rather than a `token.released` followed by a
  transfer — the token was never free, and nothing on the feed should say it was. The desktop's
  *free* and *revoke* are left as they are: the person at that desktop has **Grant** for handing it
  over and **Reject** for refusing, and choosing one of those is what those controls are for.
- **A contest carries the window it opened under.** `contest.windowMs` is fixed at the instant the
  contest opens, along with the absolute `deadline` it implies and the cooldown a rejection of that
  contest costs. Changing the `tokenWindowMs` preference re-times nothing that is already open; the
  next contest is the first to use the new length. The pinned worker→desktop frame is unchanged:
  its `windowMs` remains the workspace preference and its `contest` keeps the four fields stage 3
  parses, so `windowMs` on the contest is ledger-side only.

**What the token is not.** Every participant already holds the workspace capability, the sixty-four
hex characters that authenticate every route. The token is **arbitration among cooperating agents**,
not an access boundary: an agent that lies about its identity gains nothing it did not already have,
and the design does not pretend otherwise. The access boundary remains the capability and loopback.

## The feed

`GET /feed?rootId=…&token=…&after=N`, a WebSocket on the workspace worker (and only there — the host
never sees it), carrying one JSON frame per event, replaying from `after` out of a retained ring of
1,000 frames persisted beside the ledger:

```
{ sequence, at, rootId, type, by: { kind: 'agent', agentId, label } | { kind: 'desktop', desktopId }
                                | { kind: 'deadline' | 'holder-gone' } | { kind: 'workspace', pid }
                                | { kind: 'release', agentId, label }, ... }
```

`workspace` is the fourth `by` the implementation needed: a frame nobody asked for — a game the
person started from the desktop pane, or the worker announcing its own generation.

| type | carries | source |
| --- | --- | --- |
| `token.claimed` `token.contested` `token.rejected` `token.released` `token.revoked` | holder, contester, deadline, reason | the ledger |
| `game.started` `game.ended` | sessionId, gameId, surface, args, exitCode | `session` events for `type: game` on `/events`, which the worker already receives |
| `device-action.started` `device-action.ended` | sessionId, actionId, deviceId, kind | dashboard actions bound to a non-local device (contract 4) — the owner's "deploying to device", named generally so `quest-deploy`, `quest-data`, `pcvr` and `remote-rengine` all qualify |
| `capture.started` `capture.committed` | sessionId, gameId, recordingId, kind `ring` or `explicit` | the desktop, which owns the recorder, sends a `recording` frame on `/events` when its toggle fires; the worker intercepts it as it does `desktop-register` |
| `workspace.updated` | layers, generation | the worker announcing itself. The runtime supervisor answers `/api/update-workspace` and never forwards it, so the worker cannot observe the update as a request; instead each worker process announces `{ layers: ['workspace'], generation }` once, on the first request it serves that is not `/health` or `/api/state`. A candidate the supervisor prepares and then discards only ever answers those two, so a worker that never served anybody never claims a generation. |

The worker learns of sessions by subscribing to the host's `/events` itself, once, as a client — it
already opens that socket per desktop; this is one more, with no desktop behind it. It maps `session`
events to `game.*` by the session's `type`, and to `device-action.*` by remembering which sessions
`/api/dashboard-run` created for which action.

Two MCP tools expose it: `feed_url` returns the socket URL with cursor, for a `Monitor` with a
WebSocket source; `feed_read` returns frames after a cursor, bounded, for an agent that polls. The
first is the owner's monitor. Both are read tools and need no token.

The URL `feed_url` hands back is the **workspace worker's own** loopback URL and capability, not the
supervisor's: the supervisor's upgrade handler allowlists `/events` and `/surface`, so a `/feed`
upgrade through it is refused, and extending that handler would be a change to a layer this spec
does not replace. The caller already reaches that worker through the supervisor, so this widens
nothing (see *What the token is not*); it does mean a monitor's socket ends when the workspace layer
is replaced, and the agent re-reads `feed_url` and reopens with the last sequence it saw — which is
what the cursor is for.

## Native desktop

One **status-bar segment** (`re_app_status`, `workspace.c`) per window: *Token · free*,
*Token · claude*, or *Contest · codex · 42s* counting down. Pressing it opens a popover in the spec
080 pattern listing the holder, the open contest with **Reject** and **Grant**, and **Revoke** and
**Free** for a held token. The frames below carry it: the worker intercepts the desktop's before
forwarding, and pushes its own to every desktop on the same socket, so the segment updates without
polling. No new pane.

**Where this meets spec 065.** `/events` is a stream, and spec 065 says existing streams finish
through the replaced worker rather than being interrupted to unload code. Putting a *stateful*
service on that stream meant that after `update_workspace` with `layers: ['workspace']` and a
desktop attached, two workers owned one ledger: the desktop read and wrote the retired one while
agents read and wrote the current one, and both minted feed frames into the same file with colliding
sequences. Measured end to end in [the e2e evidence](../evidence/project-token-e2e-2026-09-07.md),
recorded as **KI-061**, and answered by *Retirement* below.

The worker side of this is built (stage 2). The three frames that cross this socket are **pinned**
(owner-coordinated, 2026-09-07) and the worker conforms to them exactly.

**Worker → desktop**, to every desktop bound to the root, once per registered root at
`desktop-register` time and again after every transition:

```
{ type: 'token', rootId,
  holder:  { agentId, label, pid, since } | null,
  contest: { id, contester: { agentId, label, pid }, openedAt, deadline, reason } | null,
  windowMs, sequence }            // sequence: the feed sequence of the last token.* frame
```

**Desktop → worker**, the human's controls, never gated, intercepted before forwarding:

```
{ type: 'token-action', rootId, action: 'reject' | 'grant' | 'revoke' | 'free',
  contestId,      // required for reject and grant
  reason }        // optional, reject only
```

The reply is the next `token` frame. A refusal — no such contest, nothing held, a root this desktop
is not bound to, a contestId that is no longer the open one — is the socket's ordinary
`{ type: 'error', error }`, as the host's other errors on it are.

**Desktop → worker**, the recorder (spec 081), intercepted like `desktop-register` and turned into
`capture.started` / `capture.committed` on the feed, attributed to that desktop:

```
{ type: 'recording', rootId, sessionId, gameId, event: 'started' | 'committed',
  recordingId, kind: 'ring' | 'explicit', at }
```

`started` is sent when an explicit start begins; `committed` when a segment's manifest is written,
of either kind. A ring commit sends only `committed`, so a `capture.committed` with no
`capture.started` before it is the normal ring case, not a lost frame.

### What shipped (stage 3, 2026-09-07)

The per-window state, the segment, the popover and the recorder's announcement are
`orchestrator/native/token.{c,h}` beside `devices.c` and `tracker.c`; `app.c` parses the frame and
`workspace.c` places the segment and the surface. The segment is not a control: the status bar is
drawn outside microui, after every pane, so the face is `re_token_status` and the press is served in
`re_app_event` beside the pane strip's context menu, with the rectangle reported to automation. A
microui window of its own would have cost one of the 32 root containers that fifteen leaf panes with
a surface open already fill. Corrections against the paragraph above, each because the code says
otherwise:

- **`re_app_status` is in `workspace.c`**, not `app.c`. The declaration is `app.h:64`; the paragraph
  named the header's neighbour rather than the definition.
- **The countdown reads `42s`, not `42 s`** — the wire contract stage 2 was written against says
  `<seconds left>s`, and the segment is one of the narrowest things in the chrome.
- **Nothing is drawn before the ledger speaks.** *Token · free* is a claim about a ledger, and a
  window that has heard no `token` frame has no business making it, so the segment appears with the
  first frame for its root. `re_app_inspect` reports `token.known: false` until then.
- **The popover does not list the identities the ledger has seen.** The pinned `token` frame carries
  a holder and a contester and nothing else, so a list of identities would have to be invented here
  or fetched over a route this stage does not add. It belongs with the ledger's own status.
- **Reject carries a reason the person typed.** Decision 3 gives the desktop the rejection and the
  transition table gives the contester the reason; a reason invented by the chrome would be neither.
  The popover has a field for it, sent only with `reject` and only when it is non-empty.
- **Identity is the window's primary root** (spec 084 decision 3), so a frame for any other root is
  ignored. That is the assertion most worth having, and it is one: a second root's ledger naming a
  different holder leaves the segment unchanged.
- **A `disconnected` clears the state.** The ledger's last word does not outlive the socket that
  carried it; the worker re-sends per root after `desktop-register`, which is contract 1.
- **The countdown floors.** The desktop's wall clock is `time(NULL)`, so rounding up would open a
  60-second window reading `61s`. Nothing depends on the desktop's number: the ledger owns the
  deadline and the transfer.

The recorder's frame is the pinned one above, sent from `recording.c` through a callback the
recorder carries, on the socket the desktop already registers over. Two things about it:

- **`kind` is the feed's vocabulary, not the manifest's.** Spec 081 writes `kind: "segment"` into a
  manifest for the explicit gesture; the feed says `explicit`. The feed names the gesture, the
  artifact names its shape, and a worker mapping these onto `capture.*` must not expect the
  manifest's word.
- **An explicit segment's id is minted when the toggle starts it**, not when it commits, so
  `started` and `committed` name one directory. A ring commit has no start and announces only
  `committed`. This moves the segment directory's timestamp from the commit instant to the start
  instant, which is the instant `startedAt` in its own manifest already reports.

Not built in this stage: the ledger, the feed socket, the MCP tools and the gates, which are stage
2's and landed beside this one; and the recording controls over MCP, which are stage 4. The native
fixture drives a stand-in for the worker's interception rather than the worker, so nothing here
asserts what a `token-action` does to a ledger — those are criteria 3, 4 and 7, and stage 2's
evidence carries them.

## Retirement

Added 2026-09-07, closing KI-061. The two specs do not disagree about *whether* a replaced worker
keeps serving; they disagree about *what*. So retention is **by kind**, and the kinds are already
distinct: a terminal or surface view is a stream of somebody else's bytes, and the ledger is a
service with one writer. Views keep draining through the replaced worker exactly as spec 065 says —
its regression, `runtime.test.mjs:91`, is unchanged and stays the floor. The token/feed service hands
off to the current worker.

The supervisor's part is one message, `{ type: 'retired' }`, sent to the replaced worker's child at
the point the retirement is **committed** — the `finally` that releases it from `preserved`, and the
rollback that retires a rejected candidate. Not at the swap: a failed update restores the previous
worker as the current one, and a worker already told it was retired would then be forwarding requests
to itself. Under an older supervisor the message never arrives and the worker behaves exactly as it
did before, which is the pre-KI-061 behaviour rather than a new failure.

A worker that receives it:

- **terminates its subscription to the host's `/events` and never resubscribes**, and gives up its
  ledger, so it mints nothing and never writes `token.json` or `feed.json` again. One writer per
  root is what makes the sequence a monitor resumes by mean something.
- **closes its own `/feed` clients** with a close reason naming retirement, so a monitor re-reads
  `feed_url` and reattaches to the current worker from the cursor it had — which is what the cursor
  is for, and what the *feed* section already says happens when the workspace layer is replaced.
- **answers `GET /api/token`, `POST /api/token-action`, `GET /api/feed`, `POST /api/recording` and
  `POST /api/preferences` by forwarding to the current worker through the supervisor.** It finds the
  supervisor in the runtime descriptor already in its own directory (`runtime.json`, read by
  `discoverRuntime`) — no environment variable, no new descriptor. The preferences write forwards
  whole: the current worker splits `tokenWindowMs` from the rest exactly as this one did. Everything
  else the worker serves is unchanged, and in practice unreachable anyway, because the supervisor
  routes every HTTP request to the current worker; what makes forwarding worth having is the URL and
  capability `feed_url` handed out before the replacement.
- **forwards its retained desktops' frames.** A `token-action` or `recording` frame from a retained
  socket becomes `POST /api/token-action` / `POST /api/recording` on the current worker, with the
  desktop actor carried as `X-Rengine-Desktop: <desktopId>`. The current worker honours that header
  **only when no agent header is present**, and answers `by: { kind: 'desktop', desktopId }` exactly
  as it does for a desktop on its own socket. Like the agent header, this is loopback arbitration and
  not security: every participant already holds the workspace capability (*What the token is not*).
  A refusal comes back as the socket's ordinary `{ type: 'error', error }`, unchanged.
- **relays `token` pushes back.** For each root its retained desktops registered it subscribes to the
  current worker's feed (`GET /api/feed?rootId` through the supervisor hands back `socket`), and on
  every `token.*` frame it re-reads `GET /api/token?rootId` and pushes the pinned flat `token` frame
  to those sockets; also on a fresh `desktop-register` after retirement. `Ledger.segment()` and the
  relay build that frame through one function, so **the frame text on the desktop's socket is
  unchanged** and the desktop needs no change at all — `orchestrator/native/*` is untouched.

Consequences worth stating. A retained desktop's controls are answered a round trip later than a
locally-served one, and the answer arrives as the relayed push rather than as a locally-built one;
the desktop cannot tell. And the desktop keeps its identity: the `desktopId` is the one the retired
worker minted at `desktop-register`, which is also the id `GET /api/desktops` lists for it, because
the supervisor asks every retired worker as well as the current one.

Evidence: [`token-retirement-2026-09-07.md`](../evidence/token-retirement-2026-09-07.md), fifteen
sabotages including the reverted alternative as a control.

## MCP tools

The gate a tool applies has two halves. `agentToken: 1` says the worker serves the ledger; a tool
called by an *identified* agent against a worker that does not advertise it refuses naming the layer
to update, rather than calling a worker that would pass every request. An **anonymous** caller — a
`probeTools` context, an older launch with no identity — is not an agent and is never gated at all,
which is what keeps `update_workspace` able to prepare its own replacement.

| tool | token | does |
| --- | --- | --- |
| `token_status` | read | holder, open contest with seconds remaining, whether the caller holds it, cooldowns, identities seen — and, since 2026-09-07, the root's persisted conversations (spec 097) folded in as identities it has not yet seen on the wire, each marked `conversation: true`. The ledger only learns an `agentId` from a header, so a lane that has not called anything would otherwise be invisible here and un-nameable in a refusal. Nothing is minted, and an identity the ledger has actually seen always wins over the persisted record of the same id. |
| `token_contest` | — | opens a contest or claims a free token; returns `{ state: 'claimed' \| 'pending', deadline }`; refuses during the caller's cooldown, naming when it ends |
| `token_reject` | holder | rejects the open contest with a reason the contester will read |
| `token_release` | holder | frees the token, or hands it to an open contest's contester at once |
| `feed_url` | read | the WebSocket URL for the caller's monitor, with the current cursor |
| `feed_read` | read | frames after a cursor |

Gated tools (decision 4) send the identity and are refused as decision 5 says; their descriptions
name the token. Capability `agentToken: 1` is advertised **only by a worker that serves the ledger**,
and the tool worker's gate reads it, so an old worker under a new connector refuses by name rather
than passing every call — the spec 078 asymmetry, handled at design time this once.

## Boundaries

- **No environment variables** to find, hold or configure any of this. Binding is discovery; the
  window is a preference; identity is a file the launcher wrote.
- **Loopback only.** The feed is another route on the same bound worker with the same capability.
- **Agents do not contest on startup.** An agent contests when it is about to act. A contest loop is
  refused by the cooldown, and the frame it produces is visible on every monitor.
- **The host is unchanged.** If a route in this spec cannot be served by the worker, the answer is to
  redesign the route, not to extend the host; spec 065's status text stays true. `/api/stop` is the
  case in point: the host serves it and the worker only forwarded it, so the gate intercepts before
  the forward rather than asking the host to grow one.
- **Two gated routes are the supervisor's, not the worker's.** `/api/update-workspace` and
  `/api/desktop-action` are answered by the runtime supervisor, which forwards everything else to the
  worker, so `update_workspace` and `reload_desktop` read their gate from the ledger in the tool
  worker before the call. The worker gates them as well, for a caller addressing it directly.
- **Nothing here launches on a remote device.** A device-bound action is still the project's script;
  the feed reports it, the token arbitrates it.

## Implementation order

1. Identity and binding (`config.mjs`, `launch.mjs`, new `bind.mjs`; the facade and tool worker read
   the per-launch context). Ships as a connector update; a pane-spawned agent reopened after it has
   an identity. **Revised** 2026-09-07 by the owner decision at the head of *Identity*: the identity
   is the CLI's session id, `bind.mjs` grew `--session`, the label carries the id's first eight, and
   the ledger's holder pid follows a resumed session. Evidence:
   `docs/evidence/agent-session-identity-2026-09-07.md`.
2. Ledger, contest, gating and the feed in the workspace worker; the tool worker's header and gates;
   `token_*` and `feed_*` tools. Ships as `workspace` + `connector`. **Done** 2026-09-07:
   `orchestrator/runtime/{token,feed}.mjs` beside `worker.mjs`, the gates and routes in `worker.mjs`,
   the tools in `agents/mcp-worker.mjs`, evidence in `docs/evidence/project-token-2026-09-07.md`.
   One line of `runtime/supervisor.mjs` changed with it: the fork message now carries the runtime
   directory (`child.send({ host, directory })`) so a worker persists where its supervisor says,
   with `runtimeDirectory(host)` as the fallback an older supervisor leaves it. The retained host and
   `orchestrator/native/*` are untouched.
3. The status-bar segment and popover; the desktop's `recording` frame. Ships as `desktop`.
4. Recording controls over MCP (`recording_start`, `recording_stop`), in spec 081's terms, gated by
   the token; a follow-up to that spec, not this one.

## Acceptance criteria (F90)

1. Two agents launched on one root receive distinct identities in per-launch context files, and the
   shared root file is no longer what the tool worker reads. An agent bound from a plain terminal
   through `bind.mjs` receives the same shape and appears in `token_status` once it calls anything.
2. With the token held by A, each gated tool called by B is refused naming A, the time it has held
   the token and `token_contest`; nothing is launched, stopped, run or replaced. The same actions
   from the desktop succeed regardless of who holds the token.
3. B's contest opens a window of the configured length; A's `token_reject` within it keeps A's token
   and B reads the reason; silence transfers the token at the deadline; the transfer is a frame with
   `by: deadline`; a rejected B is refused a second contest until its cooldown ends, naming the time.
4. A contest against a holder whose pid is gone resolves at once, `by: holder-gone`.
5. Reject, Grant, Revoke and Free from the desktop take effect immediately and are frames with
   `by: desktop`.
6. Launching a game, a device-bound dashboard action starting and ending, a capture starting and
   being committed, a workspace layer replaced and every token transition each appear as one frame
   with a monotonic sequence; a monitor opened with `after=N` receives every frame after N that is
   still retained; no PTY output ever appears on the feed, proven by a session that prints while the
   feed is watched.
7. Replacing the workspace worker while a contest is open keeps the holder and the deadline; the
   contest resolves at the original time.
8. `agentToken: 1` is advertised only by a worker serving the ledger; against an older worker the
   tools refuse naming the layer to update.
9. The status-bar segment shows free, held and the countdown, and the popover's controls are the
   ones in criterion 5.

Each criterion's regression is established the house way: broken in the specific way it claims to
catch, observed red for that reason and not an earlier one, then restored.
