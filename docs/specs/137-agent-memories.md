# Spec 137 — the Memories tab: agent memories that survive a change of machine

Owner request, 2026-09-15: *"project memories of agents, they seem to be non-transferrable so if I
will start in another machine - I will not have access to them, so maybe we can implement
'Memories' tab - so we can see local memories and sync them onto state dir, so on another machine
we can sync them to that local machine agent"*.

## What is actually broken

Claude Code keeps per-project memory in `~/.claude/projects/<slug>/memory/` — a `MEMORY.md` index
and one file per fact. Twenty-five projects on this machine have one. Two properties make them
non-transferrable:

1. **They live outside every repository**, in the person's home directory, so nothing carries them.
2. **The slug is derived from the checkout PATH** (`-Users-alex-rengine`). A second machine with a
   different home directory, username or checkout location produces a different slug, so even a
   copied home directory would not line up.

(2) is settled by the codebase and is not an owner question: a sync keys on **project identity** —
the declared `project` name and the root id rEngine already mints (spec 084) — never on the path.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| D1 | **The backend is per project, declared in `.rengine/project.json`.** A `memories` block names `store: "repo"` with a path, or `store: "workspace"`. It travels with the project, both machines read the same answer, and it sits beside `dashboard`, `games`, `devices` and `worktrees`, which are already shaped this way. | Owner, 2026-09-15, choosing "Declared in .rengine/project.json" |
| D2 | **Projects that own a repo use it; kohai does not.** `~/nolf-improved` and `~/vtmb-vr` carry memories in-repo, where git already moves them between machines. `~/hirebase-v2` does not: its declaration is external and its memories stay in the workspace state directory, fetched over the network. | Owner, 2026-09-15: *"for projects like ~/nolf-improved and ~/vtmb-vr in repo, but not for ~/hirebase-v2 (sync with network connection, given we have headless helper, will help here)"* |
| D3 | **Installing onto a machine is shown and confirmed, never silent.** The tab lists exactly which files would be written and how they differ, and writes only on confirmation; a refusal leaves `~/.claude/...` untouched. This is the rule `bootstrap-agent-hooks` already follows for the one global-CLI edit this workspace makes (spec 127). | Owner, 2026-09-15, choosing "Shown and confirmed, never silent" |
| D4 | **A conflict is chosen per file, never resolved by a rule.** When both sides changed a memory, each differing file is shown with both sides and the person picks keep-local, take-remote or keep-both. A memory is prose someone wrote deliberately; losing one to an mtime comparison is worse than being asked. | Owner, 2026-09-15, choosing "List them, choose per file, never silent" |
| D5 | **kimi gets memories rEngine defines and points it at**, rather than being reserved until kimi ships a memory store of its own. | Owner, 2026-09-15, choosing "rEngine defines the file and points kimi at it" over the recommended "reserve the slot" |
| D6 | **Every other agent is an empty reserved slot.** codex (a single global `AGENTS.md`, not per-project memory), gemini and opencode have no per-project memory store. Their rows say so. | Owner, 2026-09-15: *"others do not touch but create an abstraction so we can implement later"* |

## The transport, which the codebase already has

The owner named "the headless helper". `launch.mjs --headless` (`orchestrator/launcher/headless.mjs`)
runs the sidecar alone — no desktop build, no desktop, no agent — and serves the workspace's HTTP API
with the token in `sidecar.json`. Its own message says the bind is loopback and a second machine
reaches it "through your own tunnel".

It does not have to. **red-link is the designed path** (charter D57/D58, spec 128, F140/F180): a
libp2p façade fronting that same internal HTTP API, reached **through a circuit relay on purpose**,
so the NAT path a second machine takes is the only path it can take. `run_facade` serves, `run_probe`
asks. A `workspace`-store project's memories are therefore fetched the way every other remote
workspace read will be, rather than over a hand-rolled tunnel.

Per charter D57, the route that answers memories is **Rust in `red/`** — a `red-project` module
behind red-host — not a new subsystem in the JS backend.

## kimi (D5), and what the interview changed about it

The recommendation was to reserve kimi's slot, on the grounds that rEngine would be inventing a
format no CLI reads. The owner chose otherwise, and inspecting kimi afterwards makes the choice
sounder than the objection allowed:

`~/.kimi-code/config.toml` supports `[[hooks]]` with `event = "SessionStart"` and a `command`, and
**rEngine already owns one there** — the report-session hook `bootstrap-agent-hooks` installs. A
SessionStart hook is kimi's own documented mechanism, so memories reach it by feeding content at
session start rather than by teaching kimi a new file to read.

**The open question this leaves, which must be answered before implementation:** whether kimi injects
a SessionStart hook's stdout into the session's context, or merely runs it. If it injects, the
existing hook can carry memories and there is **no second global edit at all** — the better outcome,
and the one to aim at. If it does not, D5 needs either a second hook or a different mechanism, and
that is a decision to bring back rather than to guess.

**The tradeoff D5 accepts either way**, recorded because the owner chose it with the objection
visible: rEngine defines where kimi's memories live, so a kimi release that adds its own memory
store leaves two, and one of them is rEngine's.

## The declaration

Contract **12** (the enum runs to 11 today). The block is optional; a project that declares nothing
has no memories surface, which is what every project has today.

```json
"memories": {
  "store": "repo",
  "path": ".rengine/memories"
}
```

```json
"memories": { "store": "workspace" }
```

- `store`: `"repo"` — carried in the project's own tree at `path`, default `.rengine/memories`;
  `"workspace"` — carried in the workspace state directory and fetched over red-link.
- `path` is refused when `store` is `"workspace"`, and is a **sibling path** that may not escape the
  root, reusing `$defs/siblingPath` from the worktrees block (spec 134).
- Under D63 rEngine may **offer** to write this block, shown in full and only on confirmation.

Per-agent layout under either store, so D6's reserved slots cost nothing to add later:

```
memories/
  claude/   MEMORY.md + one file per fact
  kimi/     (D5)
  codex/    reserved, empty
```

## Privacy, which the repo backend changes

A memory is a personal note about how to work. `store: "repo"` makes it visible to everyone with
repository access and puts it in the project's history permanently. That is acceptable for the
owner's own checkouts and is why kohai — whose declaration is external — was deliberately excluded
(D2). The tab must say which store a root uses **before** the first sync, not after, and a memory
naming a credential must never be written to either store; the existing rule that tokens live in the
workspace state directory and the declaration schema refuses a `token` key applies here unchanged.

## Acceptance

1. A root declaring `memories` shows a Memories tab listing each agent, its memory files and their
   sizes; an agent with no memory store says so rather than showing an empty list (the not-yet
   versus not-there rule this repository keeps relearning).
2. A `repo` root writes its memories under the declared path and a second checkout of the same
   repository sees them after a pull.
3. A `workspace` root keeps them in the state directory, and a second machine fetches them over
   red-link's façade rather than from the repo.
4. Installing onto a machine shows every file that would be written, with its change, and writes
   nothing without confirmation; a refusal leaves `~/.claude/projects/<slug>/memory/` byte-identical.
5. A file that differs on both sides is presented with both versions and keep-local / take-remote /
   keep-both; no rule resolves it, and declining leaves both stores untouched.
6. Identity is the declared project and root id, not the path: a checkout at a different absolute
   path on the second machine still matches.
7. The route that answers memories is Rust behind red-host, and the desktop reads it through the
   same client every other workspace read uses.

## What this does not do

- **It does not sync automatically.** Every write is a person's decision (D3, D4). A background
  reconciler is a later question and would need its own conflict story.
- **It does not carry conversations or transcripts.** Memories only. Sessions already have their own
  retention and resume path (spec 096).
- **It does not manage codex's global `AGENTS.md`.** That file affects every project on a machine,
  not one, which is a different blast radius and a different feature (D6).
- **It does not give rEngine a second owned edit to a global CLI configuration without asking.** If
  the kimi open question forces one, that comes back to the owner first.
