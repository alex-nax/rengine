# 147 — The repository layout, and the platform split it prepares (charter D71)

**Status**: decided, not started. **Depends on**: spec 129 and 146 (the JavaScript retirement, which
is what made `orchestrator/` stop describing itself). **Prepares**: the no-bash Windows arc, which
is its own spec.

Decided in a `/grill-me` interview with the owner, 2026-09-16. Every decision below is attributed.
Two of them overrule a recommendation, and both did so for a reason worth recording.

## Why now

`orchestrator/` was named when it held a Node orchestrator. It now holds the **editor** (93 C
files), the **test suite** (272 files), the **dashboard actions** (13 shell), the **agent registry**
(1) and the **templates** (9). None of those is an orchestrator; the orchestrator is `red/`.

A directory whose name describes none of its contents is not untidy, it is instructional — it is the
first thing every new session reads about where things belong, and it teaches the wrong answer.

## The layout

| from | to | what it is |
| --- | --- | --- |
| `orchestrator/native/` | `editor/` | the C/microui desktop |
| `orchestrator/tests/` | `tests/` | the whole suite, unsplit |
| `orchestrator/actions/` | `actions/posix/`, `actions/win/` | dashboard actions, per platform |
| `scripts/agent.sh` | `actions/pane/posix/agent.sh` | the pane launcher, per platform |
| `orchestrator/agents/registry.toml` | `agents/registry.toml` | the CLI recipe table |
| `orchestrator/templates/` | `templates/` | project and profile scaffolding |

`orchestrator/` and `scripts/` both disappear. `red/`, `tools/`, `docs/`, `contracts/`, `design/`,
`adapters/`, `apps/`, `packs/`, `plugins/`, `third_party/` are untouched.

### Why `editor/` and not `redit/` or `native/`

*Recommended, confirmed.* Charter D67 makes the editor interface consumer-side C, and that rule is
invisible from a path called `orchestrator/native`. `editor/` makes the language rule legible from
the tree.

Not `redit/`: charter D41 declares the product's name **once**, in `theme.json`, and spec 108 makes a
rename a data edit. A directory named for the product would make a rename a tree edit again, which
is the thing D41 exists to prevent.

Not `native/`: "native" is a contrast word — native as opposed to web. It named the thing while an
Electron option was on the table. Charter D26–D27 removed that peer, so the contrast names nothing.

### Why one `tests/` and not a split by runner

*Recommended, confirmed.* The unit suite and the desktop suite share their fixtures heavily —
`red-host-fixture`, `cargo.mjs`, `state-services`, `agents-fixtures`. A split by runner cuts across
those rather than along them. The distinction already lives in the filename (`.test.mjs` vs
`.spec.mjs`) and in the two npm scripts, which is where it costs nothing.

### Why `actions/` and not `tools/`

*Recommended, confirmed.* Audience. `tools/*.py` is what an agent runs to pass a gate;
`actions/*` is what a person presses in a dashboard. `python3 tools/features.py validate` is a
documented gate line in AGENTS.md, and putting a dashboard button beside it blurs what `tools` means.

### Why `agents/` for one file

*Recommended, confirmed.* `red-agents` resolves the registry from the **checkout** at runtime — three
binaries ask, deliberately, so a CLI added as data needs no rebuild. A short runtime path
(`<checkout>/agents/registry.toml`) serves that better than a buried one. Not `contracts/`, which
holds the *schemas* declarations must satisfy; the registry **is** a declaration, and mixing the two
would make a reader looking for "what shape must my project.json be" find a CLI roster.

## The platform split

**Owner decision, overruling a recommendation.** I recommended against OS-bundled directories: seven
of the eight actions audit as portable, only `replace-host.sh` is POSIX-only (a `setsid` double
fork), and `contracts/project-v1.schema.json:940` already states this project's idiom for
per-platform selection — *"deliberately a later key rather than a later reinterpretation"*.

That recommendation rested on a premise I did not have and the owner did:

> **"You should not use bash on windows even at transitional phases."** — owner, 2026-09-16

With Git Bash eliminated, there is no shared shell between the platforms, and "seven of these are
portable" stops being true. The bundling is right; my argument for a single directory was right only
for a world with `RENGINE_BASH`. This is recorded rather than quietly dropped because the reasoning,
not the conclusion, is what a later reader needs.

```
actions/
  posix/     lib/wizard.sh, 8 × *.sh        (moved)
  win/       8 × *.ps1                      (written this arc, UNVERIFIED)
  pane/
    posix/agent.sh                          (moved from scripts/)
    win/agent.ps1                           (next arc — 275 lines)
```

*Nine of each since 2026-09-17*: `grant-session-message` arrived on the `session-message` line
(F222, spec 148), which was written before this layout existed and declared its action the old way.
The merge is what converted it — the declaration to contract 9, the script to `actions/posix/`, and
a `.ps1` counterpart written and parse-checked with the other eight. F223's criteria still say
"eight", which is now one short; the count is the owner's to correct, and the row records it.

`pane/` splits too, *owner-decided*. I argued it should not, because `red_agent_launch` wraps the CLI
in `RENGINE_BASH` on win32 today so one bash file serves both. Under the no-bash rule that wrapping
is itself what has to go, so the split is correct and the Rust win32 branch is the next arc's work.

## Contract 9: invoke by name

**Owner decision.** An action is declared by **name**, and the reader resolves
`<root>/actions/<platform>/<name>.<ext>`:

```json
{ "id": "harness-gate", "kind": "script", "action": "verify", "args": ["harness"] }
```

replacing contract 8's `"script": "orchestrator/actions/verify.sh"`.

I had argued against a reader that resolves a platform segment, citing the schema's own warning. That
objection does not apply here, and the difference is exact: a declaration carrying a **path** would
be run literally by an older reader and be *silently* wrong on Windows. A declaration carrying a
**name** is an unknown key in a closed schema — an older reader refuses it by name, which is what the
schema asks for. The owner's answer is better than the option I was defending.

`script` is **replaced**, not kept alongside (*owner decision*): one concept, one way to declare an
action. Consumer projects migrate on their next pin.

### What a consumer migration actually costs, and the answer (vtmb-vr, 2026-09-17)

The interview priced this as "declaration edits". It is not, and the reason is worth carrying to the
next consumer: contract 9 resolves `actions/<platform>/<name>.<ext>`, so a project whose scripts live
elsewhere must either move them or bridge to them.

**Moving them is the wrong trade.** In vtmb-vr, `fast-start-quest.sh` is named by 27 files and
`deploy-quest.sh` by 20 — including `claude-progress.md` and `known-issues.md`, which are records
rather than code. Satisfying a layout by rewriting history is backwards.

**A consumer bridges instead.** `actions/posix/<name>.sh` is three lines that `exec` the project's
own script, so its argv, stdio and exit code are the action's with nothing in between. rEngine's own
actions live natively under `actions/`; a project with an established tree gets an adapter, and the
contract stops being something imposed on its layout.

`actions/win/` in a consumer is empty and says so. A Windows dashboard reports those actions
unavailable, which is TRUE — the scripts are bash, and porting them is the project's call. A Windows
form is a real port, never a forwarder.

**One thing confirmed by accident and worth keeping:** vtmb's declaration was refused *before* its
pin moved, with `has unknown key action` naming the key. A contract-8 reader meets an unknown key in
a closed schema and refuses by name, rather than running the posix file on Windows. That is the
whole argument for a name over a path, observed rather than reasoned.

### The second consumer, and where it differs (nolf-improved, 2026-09-17)

Nine action ids over eight names — `quest` and `quest-debug` are one action and two `env` blocks, so
a name serving two ids is normal rather than a smell. Eight forwarders, and the same conclusion about
not moving the scripts.

**What vtmb left open, this one answered.** `actions/win/` is not empty here: eight ports plus
`lib/adb-quest.ps1`, all parsed on the qualification host and none executed. Two of them are the
spec's own gap rule applied for the second time, and it held — `fast-start-pcvr` and
`avp2-fast-start-pc` reach Windows over ssh, and their far side was already committed in that project
as `.bat`, so the Windows action invokes what the box has been running rather than a second
implementation that can disagree with it.

**And a consumer's test told us something rEngine's own suite could not.** Its
`test_pinned_schema_accepts_the_declaration` drove `orchestrator/server/schema.mjs`, so it had been
*skipping* since the retirement — the strongest check in the file, quietly absent, in a project that
had no reason to notice. It now drives `red-project declaration`, which validates AND resolves, so
the test asserts every declared name comes back as a path that exists. Two things follow:

- **`red-project declaration` is the consumer-facing replacement for the deleted reader**, and it is
  better suited than the JS was, because resolution is the half a consumer cannot check for itself.
- **A consumer test that drives a compiled reader must build it first** (KI-120 again, one repository
  further out): on its first run it refused every action with `has unknown key action`, because the
  pinned checkout's `red-project` was built before contract 9. The pin had moved; the binary had not.

vtmb-vr has four such tests still skipping, and `nolf-improved` two more (the format-registry cases).
The port above is the worked example for them.

## What this arc does and does not do

**Does**: the moves; `actions/win/*.ps1` written; contract 9 and the consumer migration; charter D71;
this spec; AGENTS.md; and the Windows host brought current with a full build attempted, so the next
arc is scoped from evidence rather than from a `cfg` count.

**Does not**: make Windows work. That is its own spec, and its shape is already visible:

- `red_project::command::bash_path()` and its 8 live call sites need a Windows arm — `red-worker`
  (dashboard `run_payload`, the agent menu, `pipe`), `red-host` (`panes.rs`, including a terminal
  pane's default shell), `red-core`.
- `agent.ps1`, 275 lines' worth.
- The 8 ports actually **run**, with a feature row that closes on that evidence and not before
  (**F223**, renumbered from F221 — see below).

### A parallel line, and an id collision (2026-09-17)

A second session develops rEngine from **nolf-improved's submodule**, on `feat/session-message`,
branched from `fca8630` — the same commit this arc continued from. It filed **F221** (how a CLI is
handed the brief a spawn carries) and **F222** (saying one line to a pane that is already running),
and this arc filed its own F221 the same day.

Two rows with one id pass `features.py validate` on each branch in isolation, and collide only at
merge — quietly, because neither side is wrong on its own. This arc's row moved to **F223**: it is
the younger, and nothing referenced it.

Worth knowing rather than worth fixing: `features.py` cannot see a branch it is not on, so the
next id is only free with respect to the tree in front of it. Two lines of work on one inventory
will do this again.

### The Windows host

Recorded because the next arc needs it and finding it again costs a session:

```
pr0fe@192.168.31.217        Windows 10.0.26200
PowerShell 5.1.26100        (pwsh 7 NOT installed)
git, cargo, cmake, node, python 3.11 + 3.12
Git Bash present at C:\Program Files\Git\bin\bash.exe — OUT by owner rule
checkout C:\Users\pr0fe\rengine at 5ccadaf (50 commits), CMakeLists.txt modified,
untracked 84958f8/, e2c3fd9/, current.txt
```

**PowerShell 5.1, not 7**, is a constraint on every port: no `??`, no ternary, no
`ForEach-Object -Parallel`.

**And `Get-ExecutionPolicy -List` is Undefined at every scope**, which means Restricted: a `.ps1`
does not load at all until it is invoked with `-ExecutionPolicy Bypass`. Found by running one
(2026-09-17). Whatever runs these as dashboard actions must pass it, or every Windows action fails
for a reason that has nothing to do with the action — which is the kind of failure that gets blamed
on the port.

### A cross-machine action changes shape, it does not get ported

*Owner, 2026-09-17.* vtmb-vr has two actions that do not run on Windows — they REACH Windows from
the dev machine over ssh. The first thing they do is generate a `.bat`, `scp` it over and `cmd /c`
it, with a header explaining the two workarounds that forced it: a process started from sshd has no
desktop, and the build must be one command rather than three round trips.

Those generated files ARE the Windows action, and committing them is the port. What follows is the
part worth carrying to the next such pair: **once a rEngine instance runs on the far machine, the
near machine stops shipping shell over ssh and asks that workspace to run the native action** — in a
session that has a desktop, with the script already present. Both workarounds dissolve, and the ssh
script shrinks to a bootstrap.

So the rule is not "every posix action needs a PowerShell twin". It is: an action that was *about
crossing a gap* becomes two things — a native action on the far side, and a much smaller crossing.

The measurement that says the next arc is large: **62 `cfg(unix)` blocks in `red/` against 1
`cfg(windows)`**, with `red-host` (5) and `red-agents` (3) having unix-only code and no Windows arm
at all.

## Mechanics

*Recommended, confirmed.* **One commit per directory, each green** — `git mv` plus exactly the path
edits that commit needs. Every commit builds, every one is bisectable, and each is reviewable as
"nothing changed but paths". Not a pure-rename commit followed by a fixup, which leaves a hole in
bisect.

1. `editor/` — 56 `cmake.toml` paths, `design.py`; `CMakeLists.txt` regenerated by cmkr, never
   hand-edited (`design.py check` rejects hand-edited output).
2. `tests/` — the `package.json` globs.
3. `actions/` — `.rengine/project.json`, plus `scripts/agent.sh` and the two Rust resolvers that
   join `<checkout>/scripts/agent.sh` from `CARGO_MANIFEST_DIR`.
4. `agents/` — `red-agents/src/lib.rs`, `tools/agent_names.py`, `editor.sh`.
5. `templates/` — `red-project`'s `include_str!`.
6. Contract 9, the ports, and the consumer migration.

`._llm.json` sidecars move with their files (AGENTS.md).

### features.json

**Owner decision.** 115 rows name an `orchestrator/` path. Descriptions and deliverables are
**rewritten**; **evidence is left alone**. A path substitution changes no criterion, so a
forward-looking row stays actionable — but evidence records where something *was* verified, and
rewriting it would make it claim something that was never literally done. AGENTS.md requires a
recorded rationale and an owner decision for a correction to accepted rows; this is both.

### Cleanup found while surveying, not part of the move

- `dist/` (app.css, app.js, index.html) is referenced by nothing. The only `dist/` mentions in the
  tree are *other* projects' declarations naming their own.
- `orchestrator/prepare.mjs._llm.json` is an orphaned sidecar whose file moved in spec 146.

Both get their own commit, so a rename commit stays a rename commit.
