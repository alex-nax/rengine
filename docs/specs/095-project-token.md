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
| 3 | A contest may be **rejected by the holder** — the notification lands on its monitor for exactly this — **or by the person at the desktop**. The person may also grant at once, revoke, or free the token. The owner's sentence names "owner" for the rejecting party; this reads it as the token owner with the human always able to override, which is a superset of both readings. | Owner's wording; the superset is recommended and the owner has not yet ruled on it |
| 4 | The **extended set** is every tool that starts, stops, replaces or captures something the project owns: `launch_game`, `stop_session`, `open_script`, `dashboard_capture`, `reload_desktop`, `update_workspace`, and the recording controls when they exist. Reading never needs the token. | Owner ("an extended set of mcp commands"); the membership is recommended |
| 5 | Without the token those tools **refuse by name**: who holds it, since when, and that `token_contest` is the way forward. Nothing is attempted. | House discipline (spec 078, *Who serves what*) |
| 6 | The person at the desktop is **never gated**. A dashboard click, a Stop, a record toggle are the owner's acts; the token arbitrates agents. | Recommended; follows from decision 3 |
| 7 | The **feed** is a stream of lifecycle frames only — token transitions, game sessions starting and ending, device-bound actions starting and ending, captures starting and being committed, workspace layers replaced — each with a monotonic sequence, resumable by cursor. PTY output never appears on it. | Owner (the listed events, "but not limited to"); the frame set is recommended |
| 8 | The feed is readable by **every** agent bound to the root. The token decides who may act, not who may watch; a contester has to see whether it was rejected. | Recommended |
| 9 | The window is a **workspace preference** with a default of 60 s, not an environment variable and not a declaration key. | Owner ("no envs"); the default is recommended |
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

Each agent launch mints an **agent identity**: `{ agentId, label, pid, startedAt }` — a UUID, the CLI's
name (`claude`, `codex`, `gemini`, `opencode`, or the executable's basename), the launcher's process
id, and a wall time. It is written into a **per-launch context file** beside the MCP configuration
that `config.mjs` already creates, and that file — not the shared root file — is what the facade and
the tool worker read. Two agents on one root therefore differ, and a replaced tool worker keeps the
identity because it re-reads the file.

The tool worker sends the identity on every call as a header, `X-Rengine-Agent: <agentId>`, and the
workspace worker reads it. A request without the header is the desktop's. The host ignores unknown
headers, so this costs no host change.

When an agent is spawned by the workspace, `launch.mjs` also records the pty session it runs under
where it can, so the desktop can show *claude · vtmb-vr* rather than a UUID. This spec first said the
launcher's *parent* is the session's shell whose pid the host lists; that is wrong. `sessions.mjs`
spawns `bash scripts/agent.sh …` and `launch_agent()` ends in `exec node …/launch.mjs`, so the
launcher replaces that shell and its own pid **is** the pid the host lists. The implementation matches
either the launcher's pid or its parent's, and records `sessionId` when one of them is a listed agent
session. Where neither matches, the label and pid stand.

**Binding from outside.** `node orchestrator/agents/bind.mjs --project DIR [--agent NAME] [--state DIR]`
walks the sidecar descriptors under the state directory, asks each live instance for its roots, picks
the one whose root is `DIR`, mints an identity, writes the per-launch context and MCP configuration,
and prints the configuration path and the CLI flag that consumes it. Without `--state` it scans both
the base directory and each of its children: a consumer's `editor.sh` nests one state directory per
checkout at `<base>/<name>-<cksum>`, while this checkout's own default state directory *is* the base,
so `main.mjs` writes `sidecar.json` straight into it. A consumer's launcher (vtmb-vr's
`editor.sh`, nolf-improved's) wraps that as `--bind`. Two instances claiming the same root is a
refusal that names both. This is the mechanism the owner asked for when a session that could not
press a button asked the owner to press it.

## The token and the contest

A **ledger** per root, owned by the workspace worker and persisted atomically as `token.json` in the
runtime directory:

```
{ version: 1, rootId, holder: { agentId, label, pid, since } | null,
  contest: { id, contester: {...}, openedAt, deadline, reason } | null,
  cooldown: { [agentId]: until }, sequence, history: [ ...last 50 transitions ] }
```

Transitions, each a feed frame:

| From | Call | Result |
| --- | --- | --- |
| free | `token_contest` | `token.claimed` at once; caller holds it |
| held, holder alive | `token_contest` by another | `token.contested` with `deadline = now + window`; the holder's monitor carries this frame |
| contest open | `token_reject` by the holder, or *reject* at the desktop | `token.rejected` with the reason; the contester enters a cooldown of one window and cannot re-contest before it |
| contest open | *grant* at the desktop | `token.claimed` at once, `by: desktop` |
| contest open, deadline passed | (timer, or the next call) | `token.claimed` by the contester, `by: deadline` |
| held, holder pid gone | `token_contest` | `token.claimed` at once, `by: holder-gone` |
| held | `token_release` by the holder, or *free* at the desktop | `token.released` |
| held | *revoke* at the desktop | `token.revoked`; nobody holds it |

A second contest while one is open is refused naming the open one; a holder contesting its own token
is a no-op that reports it holds it. Deadlines are absolute wall times so a replaced worker resumes
the countdown from the file rather than restarting it (decision 10).

**What the token is not.** Every participant already holds the workspace capability, the sixty-four
hex characters that authenticate every route. The token is **arbitration among cooperating agents**,
not an access boundary: an agent that lies about its identity gains nothing it did not already have,
and the design does not pretend otherwise. The access boundary remains the capability and loopback.

## The feed

`GET /feed?rootId=…&token=…&after=N`, a WebSocket on the workspace worker (and only there — the host
never sees it), carrying one JSON frame per event, replaying from `after` out of a retained ring of
1,000 frames persisted beside the ledger:

```
{ sequence, at, rootId, type, by: { kind: 'agent', agentId, label } | { kind: 'desktop', desktopId } | { kind: 'deadline' | 'holder-gone' }, ... }
```

| type | carries | source |
| --- | --- | --- |
| `token.claimed` `token.contested` `token.rejected` `token.released` `token.revoked` | holder, contester, deadline, reason | the ledger |
| `game.started` `game.ended` | sessionId, gameId, surface, args, exitCode | `session` events for `type: game` on `/events`, which the worker already receives |
| `device-action.started` `device-action.ended` | sessionId, actionId, deviceId, kind | dashboard actions bound to a non-local device (contract 4) — the owner's "deploying to device", named generally so `quest-deploy`, `quest-data`, `pcvr` and `remote-rengine` all qualify |
| `capture.started` `capture.committed` | sessionId, gameId, recordingId, kind `ring` or `explicit` | the desktop, which owns the recorder, sends a `recording` frame on `/events` when its toggle fires; the worker intercepts it as it does `desktop-register` |
| `workspace.updated` | layers, generation | the worker's own update path |

The worker learns of sessions by subscribing to the host's `/events` itself, once, as a client — it
already opens that socket per desktop; this is one more, with no desktop behind it. It maps `session`
events to `game.*` by the session's `type`, and to `device-action.*` by remembering which sessions
`/api/dashboard-run` created for which action.

Two MCP tools expose it: `feed_url` returns the socket URL with cursor, for a `Monitor` with a
WebSocket source; `feed_read` returns frames after a cursor, bounded, for an agent that polls. The
first is the owner's monitor. Both are read tools and need no token.

## Native desktop

One **status-bar segment** (`re_app_status`, `workspace.c`) per window: *Token · free*,
*Token · claude*, or *Contest · codex · 42s* counting down. Pressing it opens a popover in the spec
080 pattern listing the holder, the open contest with **Reject** and **Grant**, and **Revoke** and
**Free** for a held token. The desktop sends
`{ type: 'token-action', rootId, action, contestId, reason }` on `/events`, which the worker
intercepts before forwarding; the worker pushes `{ type: 'token', … }` frames to every desktop on the
same socket so the segment updates without polling. No new pane.

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

The recorder's frame is
`{ type: 'recording', rootId, sessionId, gameId, event: 'started' | 'committed', recordingId, kind:
'ring' | 'explicit', at }`, sent from `recording.c` through a callback the recorder carries, on the
same socket. Two things about it:

- **`kind` is the feed's vocabulary, not the manifest's.** Spec 081 writes `kind: "segment"` into a
  manifest for the explicit gesture; the feed says `explicit`. The feed names the gesture, the
  artifact names its shape, and a worker mapping these onto `capture.*` must not expect the
  manifest's word.
- **An explicit segment's id is minted when the toggle starts it**, not when it commits, so
  `started` and `committed` name one directory. A ring commit has no start and announces only
  `committed`. This moves the segment directory's timestamp from the commit instant to the start
  instant, which is the instant `startedAt` in its own manifest already reports.

Not shipped here: the ledger, the feed socket, the MCP tools and the gates (stage 2), and the
recording controls over MCP (stage 4). The native fixture drives a stand-in for the worker's
interception, so nothing in this stage asserts what a `token-action` does to a ledger.

## MCP tools

| tool | token | does |
| --- | --- | --- |
| `token_status` | read | holder, open contest with seconds remaining, whether the caller holds it, cooldowns, identities seen |
| `token_contest` | — | opens a contest or claims a free token; returns `{ state: 'claimed' \| 'pending', deadline }`; refuses during the caller's cooldown, naming when it ends |
| `token_reject` | holder | rejects the open contest with a reason the contester will read |
| `token_release` | holder | frees the token |
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
  redesign the route, not to extend the host; spec 065's status text stays true.
- **Nothing here launches on a remote device.** A device-bound action is still the project's script;
  the feed reports it, the token arbitrates it.

## Implementation order

1. Identity and binding (`config.mjs`, `launch.mjs`, new `bind.mjs`; the facade and tool worker read
   the per-launch context). Ships as a connector update; a pane-spawned agent reopened after it has
   an identity.
2. Ledger, contest, gating and the feed in the workspace worker; the tool worker's header and gates;
   `token_*` and `feed_*` tools. Ships as `workspace` + `connector`.
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
