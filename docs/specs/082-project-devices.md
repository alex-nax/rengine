# Project devices: where a declared target actually runs (contract 4)

Date: 2026-09-06. Owner-directed. Extends spec 074 (contract 1, `formats`), spec 075 (contract 2,
`dashboard`) and spec 078 (contract 3, `games`) exactly as each extended its predecessor: a new
optional top-level key behind a contract bump, with every earlier declaration accepted unchanged.

## The defect: availability that does not mean availability

Contracts 1–3 have no way to say *where* a target runs, so they gate a remote target on a **proxy**:
`tools: ["adb"]` or `tools: ["ssh"]`. That asks whether a binary is on this machine's `PATH`. It
does not ask whether the device is there. The proxy is load-bearing today and it is wrong today —
measured in `nolf-improved/.rengine/project.json` on 2026-09-06:

| | count | what they gate on | what they report with nothing attached |
|---|---|---|---|
| dashboard actions | 14 | — | — |
| gated on `adb` | 6 (`quest`, `quest-debug`, `quest-log`, `quest-screen`, `quest-deploy`, `quest-data`) | `adb` on `PATH` | `available: true` |
| gated on `ssh` | 2 (`pcvr`, `avp2-pc`) | `ssh` on `PATH` | `available: true` |

Eight of fourteen actions are device actions. `adb` and `ssh` are always on that machine's `PATH`,
so all eight report `available: true` with the headset unplugged and the Windows rig powered off —
which it is, most of the time. Availability is computed, published through
`GET /api/dashboard`, `dashboard_actions` and the native dashboard, and means nothing.

The second consumer hit the sharper end of the same defect. `vtmb-vr` declares its PCVR target as a
**game record** rather than a script action, so preflight reaches the filesystem, and
`game_preflight` for `vtmb-vr` answers:

```
ready: false
issue: Game executable not found; expected build/vtmb-vr or build/Release/vtmb-vr in the selected project.
```

Every word is true and the conclusion a reader draws is wrong. It reads as *you forgot to build
it*, so the next move is to build it — on a macOS box where that target is `condition = "windows"`
in `cmake.toml` and can never be built. rEngine stat-ed the local filesystem for a path that lives
on another machine. The honest answer is not about a missing file; it is **"this target does not
run on this machine."**

Only one consumer sees that message because only one has promoted a remote target to a game record.
Any consumer that does so inherits it immediately. That is why the local-stat rule below is part of
the contract and not an implementation detail.

Consumer case and the declared shape: `vtmb-vr/docs/specs/feature-1146-device-targets.md`.

## Declaration

`contract` becomes an enum of 1, 2, 3, 4. Contract 4 adds an optional top-level `devices` array and
an optional `device` on a game record and on a dashboard action.

```json
"contract": 4,
"devices": [
  { "id": "local", "kind": "local", "title": "This machine" },
  { "id": "pcvr", "kind": "ssh", "title": "Windows PCVR box",
    "host": { "env": "VTMB_WIN_HOST" },
    "requires": ["pcvr-host.env"], "tools": ["ssh"],
    "probe": ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "${host}", "true"] },
  { "id": "quest", "kind": "adb", "title": "Quest 3",
    "selector": { "env": "QUEST_SERIAL" }, "tools": ["adb"],
    "probe": ["adb", "-s", "${selector}", "get-state"] }
],
"games": [
  { "id": "vtmb-flat", "device": "local", "…": "…" },
  { "id": "vtmb-vr", "device": "pcvr", "…": "…" }
]
```

- `devices`: 1–8 records. Declaring `devices`, or any `device` key on a game or an action,
  **requires `contract: 4`**. That is the whole point of the bump, and it is the discipline that
  carried `games` into contract 3: a reader that predates this contract answers *unknown contract
  4* and the operator updates the workspace, instead of *unknown key `devices`* and the operator
  deletes a key. Both gates are enforced — the top-level array by the section reader, the `device`
  sub-keys by a named cross-field rule, because the schema must accept `device` structurally for the
  error to say *requires contract 4* rather than *unknown key device*.
- `id`: kebab-case, ≤64, unique across the array.
- `title`: 1–32 characters. Names the device wherever rEngine shows it.
- `kind`: `local`, `ssh` or `adb`. `kind` is descriptive — rEngine runs the declared `probe` and
  reads its exit status, and holds no `ssh` or `adb` knowledge of its own.

### `local` is implicit

`local` is a reserved id bound to a reserved kind. At most one `kind: "local"` device may be
declared; a `kind: "local"` device must have `id: "local"` and a device with `id: "local"` must have
`kind: "local"`, so the implicit binding is never ambiguous.

A declaration need not declare it: every target without a `device` binds to `local`, and a
declaration with no `devices` array at all behaves exactly as contract 3 did. A declaration MAY
declare it to give it a title. It may not give `local` a `probe`, a `host` or a `selector` — all
three are about reaching somewhere else, and the local device is trivially reachable. `requires`
and `tools` are permitted on `local` and mean what they mean everywhere else.

### `host` and `selector`: naming which device

Both are optional objects with **exactly one** of `value` (a literal, 1–1024 characters) or `env`
(an UPPER_SNAKE variable read from the sidecar's shell environment at probe time). Both are
substituted into the probe argv, and they are the only two placeholder sources this contract adds:
`${host}` and `${selector}`.

- `host` is the ssh endpoint — a `user@address` or a `~/.ssh/config` alias.
- `selector` names **which** device, and it exists because a probe that passes on a one-device desk
  breaks on a two-device desk. With two Android targets attached, a bare `adb get-state` and every
  `adb` command after it fail with *more than one device/emulator* — and they fail at launch, not at
  probe. The consumer's own `fast-start-quest.sh:23-25` carries an `adb disconnect` for exactly
  this, commented *"A Wi-Fi endpoint left over from an earlier run (KI-253) makes every bare adb
  call below abort with 'more than one device'"*. A selector that is declared must be threaded into
  the probe rather than left to ambient state, so the probe answers about the device the target will
  actually use.

A probe naming `${host}` must declare `host`; a probe naming `${selector}` must declare `selector`.
Both are named cross-field errors, because the alternative is spawning a command with a literal
`${host}` in its argv.

Absent or empty **at probe time** — an `env` variable that is unset or empty — is an unreachable
device reporting that by name (*"pcvr: VTMB_WIN_HOST is not set in the workspace environment."*).
It is never a spawn with an empty argument and never a spawn with the placeholder left in.

### `probe`

`probe` is a literal argv array, 1–64 elements, with an optional sibling `probeTimeoutMs`
(default 5000, minimum 1, maximum 60000). `argv[0]` is resolved exactly as a format `argv[0]` is
(spec 074) and, as there, may not contain `$` at all — a placeholder can only ever appear in an
argument.

It runs under the **same execution boundary as every other declared command**: no shell, cwd the
project root, the sidecar's shell environment, stdin closed, output bounded to 64 KiB, killed as a
process group on timeout. It is the same `runCommand` body the format and capture paths use; the
only change there is that the placeholder pattern now also recognises `${host}` and `${selector}`,
which the schema still permits nowhere but a probe.

**Exit 0 means reachable.** Non-zero or timeout means unreachable, with the first non-blank line of
stderr as the reason.

**When it runs.** Only on an explicit availability check or refresh: `GET /api/devices`,
`GET /api/dashboard`, `GET /api/game-config`, and the MCP tools over them. Never on a timer, never
during tree listing, never from `GET /api/formats`.

**Two honest qualifications, both of which belong in the contract:**

1. **A probe is bounded and side-effect-light, not read-only.** Every other declared command in
   these contracts genuinely is read-only; a probe is not, and describing it that way would be
   false. `adb get-state` and `adb devices` both **start the adb server** when no daemon is
   running, leaving a process behind. That is the documented bar a probe must meet — cheap,
   bounded, no change to the project or the target — and no stronger claim is made anywhere in the
   surfaces or the tool descriptions.
2. **A green probe is reachability, never launchability.** `ssh host true` succeeds while the launch
   still cannot work, because an SSH logon session has no window station and therefore no GL
   context — which is exactly why the consumer's script dispatches through Task Scheduler with
   `/IT`. If probe success were allowed to *enable* an action, the PCVR entry would light up
   precisely when it cannot run. Availability therefore never claims more than "the device answered
   and this target's own local prerequisites are met", and every surface says reachable, not ready
   to launch.

### `requires` and `tools` on a device

They mean exactly what they mean on a dashboard action, and they are checked **before** the probe:
there is no point probing an ssh device when `ssh` is not on `PATH` or `pcvr-host.env` is missing,
and the message says which. A device that fails a `requires` or `tools` check is unreachable without
having been probed, and the reason names the missing file or tool.

**`requires` stays LOCAL, on a device and on a target alike, even when the device is remote.** This
is a rule and not an accident: the consumer's Quest data push is an adb action whose `requires`
names the local archive being pushed. If binding a `device` silently reinterpreted `requires` as
device-side paths, that action would break. A device-side prerequisite, if one is ever needed, gets
its own field; the name `deviceRequires` is **reserved** and unimplemented.

### `device` on a target

`device` on a game record and on a dashboard action is a kebab id naming a declared device, or the
implicit `"local"`. It defaults to `"local"`, so every contract-3 declaration keeps its exact
meaning. An unknown reference is a named cross-field error listing the declared ids and `local`, the
same shape spec 078 uses for an unknown `game` reference.

## The rule that matters most

**For a target bound to a non-local device, rEngine must not resolve or stat the executable against
the local filesystem.** That check is precisely what produces today's misleading message.

Concretely, in `inspectGame`:

- The executable candidates are **not** resolved. `executable` is `null` and the declared candidates
  are reported as `candidates`, described as living on that device.
- The `cwd` is **not** stat-ed — it is a directory on that device.
- The embedded-surface prerequisite is not evaluated; a non-local target is never an embedded
  surface in this contract.
- The target's own `requires` **are** stat-ed locally, per the rule above.

Preflight for such a target reports the device, its reachability and the target's own `requires`,
and says plainly where the executable lives:

```
device: { id: "pcvr", kind: "ssh", title: "Windows PCVR box", reachable: false,
          checkedAt: "2026-09-06T…Z", issues: ["Windows PCVR box (pcvr) is not reachable: …"] }
executable: null
candidates: ["build/vtmb-vr", "build/Release/vtmb-vr"]
location: "build/vtmb-vr on Windows PCVR box (pcvr), not on this machine"
issues: ["Windows PCVR box (pcvr) is not reachable: …"]
ready: false
```

**Availability composes**: a target is available when its device is reachable AND its own
`requires`/`tools` are met, and the reported reason names the failing half. A reachable device with
a missing local file reports the file; an unreachable device reports the device. The words
*executable not found* never appear for a non-local target.

## Probe result cache

Probe results are cached per root, device and **resolved argv** — so editing the declaration or
changing the environment variable invalidates the entry — for **15 seconds**.

15 s is chosen so that one dashboard listing probes each device once rather than once per action
(eight device actions across two devices in the live consumer), and a preflight followed by the
launch attempt it informs reuses one result; and so that a stale *reachable* cannot mislead for
longer than it takes to notice. An explicit refresh bypasses it.

A TTL alone is not sufficient, because `dashboardActions` resolves its actions concurrently and no
result exists yet when the first eight checks start. **In-flight probes are coalesced**: concurrent
checks for the same key join the running probe. Without that, one dashboard listing spawns six adb
probes at once — which is the behaviour the cache exists to prevent.

## Surfaces

**Service.** The reader gains the `devices` section, settled **before** `games` and `dashboard` so
both can resolve `device` references, and reported separately in the same way — a devices problem
disables neither the formats nor the games.

`GET /api/devices?rootId=…[&refresh=1]` returns every declared device (including the implicit
`local` when the declaration omits it, so a consumer never has to declare it to see it) with
`reachable`, `checkedAt`, `issues`, and the ids of the targets bound to it. It is served from the
**replaceable workspace worker** (`orchestrator/runtime/worker.mjs`), not the retained host, and the
worker advertises `projectDevices: 1`. The reason is on record in spec 078 and KI-043: a capability
served only by the retained host cannot be delivered by a layered update, and the last capability
that was cost a live workspace every game route.

**MCP.** A read-only `devices` tool listing declared devices and reachability, gated on
`projectDevices`. `game_preflight` and `dashboard_actions` report device-derived availability.
`devices` carries `openWorldHint`, and its description states the adb-daemon side effect rather than
claiming read-only.

**`launch_game` refuses on a non-local device**, by name, and points at the project's own script
action. Remote launching is deliberately out of scope: the consumers' scripts do it and hold
knowledge that does not belong in an orchestrator — the Task Scheduler `/IT` dispatch above, and APK
freshness compared against the installed `base.apk` mtime. The refusal is issued by the **worker**,
which computes the preflight itself, before anything is forwarded to the host; `Games.start` refuses
again for a direct caller. It names the script actions the declaration itself binds to that device,
so the message is derived from data and rEngine still names no specific script.

**Native.** A Devices section listing declared devices with status, a manual refresh, and the
targets bound to each, following the existing dashboard section's shape and the owned control layer.
An unreachable device shows **one** reason rather than repeating it per action — which is the
surface argument for the whole feature: a Quest that is not attached is one unreachable device with
a reason, not four separately disabled actions each restating it. Metrics and colours go through the
generated `RE_METRIC_*`/`RE_COLOR_*` constants; `python3 tools/design.py check` must pass.

## Acceptance criteria

1. `contract` accepts 1, 2, 3 and 4; contracts 1–3 read exactly as before, and both live consumer
   declarations (`vtmb-vr`, `nolf-improved`, both contract 3) still read clean and unchanged.
2. `devices` under contract 3, and a `device` key on a game or an action under contract 3, are each
   rejected by **version** — the message names *requires contract 4* and the declared contract —
   never by unknown key.
3. An unknown `device` reference on a game or an action is a named cross-field error listing the
   declared ids and `local`. Device rules are enforced: unique ids, the reserved `local`
   id/kind pairing, no `probe`/`host`/`selector` on `local`, exactly one of `value`/`env` on `host`
   and `selector`, and a probe placeholder whose source is not declared.
4. A target bound to a non-local device is **not** stat-ed locally: the misleading *executable not
   found* message is gone, the executable is unresolved, the device is named, and the target's own
   `requires` are still checked locally.
5. Probes: success, non-zero exit reporting the first stderr line, timeout killing the process
   group, and a missing or empty `host.env`/`selector.env` reported by name without a spawn.
6. `requires`/`tools` on a device short-circuit before the probe, naming the missing file or tool.
7. The cache serves a second check within the TTL without re-probing, concurrent checks coalesce
   into one probe, and an explicit refresh bypasses it.
8. `GET /api/devices` is served by the workspace worker, which advertises `projectDevices: 1`; the
   MCP `devices` tool is gated on it.
9. `launch_game` on a non-local device refuses with a message naming the device and the project's
   own script actions bound to it, and attempts nothing.
10. A native fixture drives the Devices section, including the unreachable case with one reason.

Tests use temporary projects with small script producers. No test depends on a real Quest or a
reachable SSH host, and no test probes the owner's actual machines.
