# Integrate a project with rEngine

The recipe nolf-improved followed on 2026-09-06 and vtmb-vr is following now, generalised. It
takes a game project from "no rEngine" to "opens in a project window with its own formats,
dashboard and game targets, and keeps tests that prove the declaration still works". Spec: `077`.
rEngine owns the contracts, the editor, the tabs and the execution boundary; the project owns its
declarations, its CLIs, its scripts and its tests.

## External integration for an unchanged project

For a project whose Red capabilities must live outside its checkout, use the external
installer (spec 085). All four paths are explicit and absolute:

```sh
node orchestrator/external-project.mjs \
  --project /absolute/path/to/web-project \
  --profile /absolute/path/to/redit-profiles/web-project \
  --launcher /absolute/path/to/open-web-project.command \
  --state /absolute/path/to/redit-state/web-project \
  --title 'Web project'
```

This writes a declaration and helper in `--profile`, plus an executable launcher. It leaves
the project unchanged. `--dry-run` prints destinations without writing; `--minimal` includes
only status, package-script discovery and JSON preview. The default also exposes existing
`dev`, `docs:dev`, `lint`, `typecheck`, `test` and `build` package scripts as dashboard controls.
Selecting a control runs it in a retained terminal in the real project directory. Opening
the workspace runs none of those scripts. The profile requires an existing `package.json`
and local rEngine build prerequisites; no tools or project dependencies are installed.

Run the generated launcher to open the workspace, then use the native agent toolbar when
needed. `launcher.command --agent codex` explicitly starts or reattaches that project's agent.
The launcher defaults to `--no-agent`. Future extensions belong beside the external
`project.json`; literal command argv can point at their absolute executables. Existing
root-relative script/file restrictions still apply. JSON files retain ordinary text editing
and gain a formatted preview. Edit an installed profile directly; rerunning the installer
refuses differing files so it cannot overwrite custom extensions.

The underlying launcher accepts `--project DIR --declaration FILE --state DIR`. The declaration
binding is retained with that root in workspace state, survives reopen without the option,
and never follows another focused project. An explicit profile replaces project-local
discovery. A missing or invalid profile names its actual path and does not fall back.
Use a separate state directory with an older session host; the launcher refuses hosts that
cannot persist the binding. This external path does not use the in-project recipe below.

The mechanical part is one command. Run it from this checkout:

```sh
bash orchestrator/actions/integrate-project.sh \
  --project /absolute/path/to/game-project \
  --name my-project \
  --game-title "My game" --game-exe build/my-game --game-surface external
```

It verifies the project is a git repository and that the remote advertises the pin, adds
`third_party/rengine` at that pin, installs `editor.sh`, writes `.rengine/project.json` and copies
the declaration test, then prints the follow-ups. `--dry-run` prints the plan and writes nothing;
`--no-submodule` skips the pin stage; `--contract 1` writes a formats-only declaration; existing
files are reported and skipped. The game arguments scaffold **one** record in the declaration's
`games` array (at `contract: 3`); further targets on the same engine are added by hand from the
multi-record reference in `orchestrator/templates/project/project.json`. Everything below is what
that command does, why, and the parts it deliberately leaves to a human.

## 1. Prerequisites

| Tool | Requirement | macOS fallback |
| --- | --- | --- |
| git | any current version | `brew install git` |
| CMake | at least the pinned tree's `cmake_minimum_required` (3.24 at the time of writing) | `brew install cmake` |
| C compiler | `cc` (macOS: `xcode-select --install`) | — |
| Node | ≥ 22.12 (`RENGINE_NODE` wins over `PATH`) | `brew install node` |
| SDL2 | **exactly** the version the pinned tree's `find_package(SDL2 X EXACT …)` names (2.32.10 at the time of writing) | `brew install sdl2` |
| Python 3.9+ | the declaration test | preinstalled |

`./editor.sh --check` reports all of them and the three build outputs, changes nothing and exits 1
when something is missing. It reads the CMake and SDL2 requirements **out of the pinned tree**, so
a pin bump moves the check with it. An SDL2 at the wrong version is reported as a problem, never
silently "fixed".

## 2. Pin rEngine as a submodule

```sh
git -C /path/to/project submodule add git@github.com:<owner>/rengine.git third_party/rengine
git -C /path/to/project/third_party/rengine checkout --detach <sha>
git -C /path/to/project add third_party/rengine .gitmodules
git -C /path/to/project commit -m "chore(rengine): pin <sha> — <reason>"
```

- The pin must be a commit that exists on rEngine's `origin/main`; `git ls-remote` confirms the
  remote before the clone. The wizard warns (and continues) when the SHA is not a current ref tip,
  because a valid pin can be an older commit on the branch.
- The pin **is** the contract version the project's bindings were written against. `git submodule
  status` must show it without `+`/`-` at every gate.
- **Never edit anything inside `third_party/rengine` from the project.** rEngine changes go through
  the rEngine checkout and its own gate; findings come back through `report_integration`.
- rEngine is not a build input: the project's CMake never adds it, and the live orchestrator keeps
  running from its own checkout with its own `.cache/` and `node_modules`.

## 3. `editor.sh` — the launching point

Copy `orchestrator/templates/project/editor.sh` to the project root (mode 755). It bootstraps what
is missing and `exec`s the launcher on the project root:

```sh
./editor.sh --check           # prerequisites and build state, changes nothing (1 if missing)
./editor.sh --dry-run         # print every command as "+ …"
./editor.sh --bootstrap-only  # submodule init, npm ci, build:surface, build — no desktop
./editor.sh --rebuild         # redo npm ci and both native builds
./editor.sh --agent codex --launch-game -- --extra-launcher-flag
```

`--agent`, `--state`, `--launch-game`, `--no-agent`, `--inspect-ui` and everything after `--` are
forwarded to `orchestrator/launch.mjs`. Everything installed lands under
`third_party/rengine/{node_modules,.cache}`, which the pinned tree's own `.gitignore` covers, so
the project's `git status` stays clean. State defaults to rEngine's `~/.local/state/rengine`;
`--state DIR` isolates a workspace so a consumer never disturbs the development orchestrator.

## 4. Declare the project: `.rengine/project.json`

The contracts nest: contract 1 is `contract`, `project` and `formats`; contract 2 adds an optional
`dashboard`; contract 3 adds an optional `games` array. Declare the lowest contract that carries
what you write, and a declaration that carries `games` **must** say `contract: 3`. There is no
singular `game` key. The full reference is `orchestrator/templates/project/project.json`; the rules
are specs 074 (formats), 075 (dashboard) and 078 (game targets).

```json
{
  "contract": 3,
  "project": "my-project",
  "formats": [
    { "id": "my-archive", "title": "My archive", "match": ["*.pak"], "modes": ["raw", "preview"], "default": "raw",
      "preview": { "kind": "tree", "command": ["build/my-cli", "--json", "tree", "${file}"], "timeoutMs": 10000, "maxBytes": 4194304 },
      "entry":   { "kind": "bytes", "command": ["build/my-cli", "cat", "${file}", "${entry}"], "timeoutMs": 10000, "maxBytes": 16777216 } }
  ],
  "games": [
    { "id": "my-game", "title": "My game", "executable": ["build/my-game", "build/Release/my-game"],
      "args": ["--flat"], "env": { "MY_SKIP_INTRO": "1" }, "cwd": "build", "requires": ["data/my.pak"], "surface": "embedded" },
    { "id": "my-game-vr", "title": "My game (VR)", "executable": ["build/my-game-vr"], "surface": "external" }
  ],
  "dashboard": { "title": "My project", "groups": [ { "id": "quick-start", "title": "Quick start", "actions": [
    { "id": "editor-check", "title": "Editor prerequisites (editor.sh --check)", "kind": "script", "script": "editor.sh", "args": ["--check"] } ] } ] }
}
```

Rules that bite:

- **Formats** are produced by the project's **own CLI**. `command` is literal argv — no shell, no
  interpolation except `${file}` (the opened file) and `${entry}` (a tree entry's `path`). A
  preview command names `${file}`; an entry command names both. `argv[0]` is absolute, or
  root-relative when it contains a separator, or a bare PATH name; it may not contain
  ``| ; & $ ` ``. Bounds default to 10 s / 4 MiB and are capped at 600 s / 64 MiB. Globs match the
  **base name**, case-insensitively. Unknown keys are rejected, so a typo cannot silently disable
  a mode. Every contract requires **at least one** format record: a project with no format yet
  declares the inert placeholder the wizard writes (KI-042).
- **Games** is an **array** of launch targets (1–16, in declaration order), so one engine can
  expose several — a flat build, a VR build, a second title on the same runtime. Declaring it at
  all requires `contract: 3`, so an older pin answers "unknown contract" rather than "unknown key".
  Per record:
  - `id` — kebab-case, at most 64 characters, **unique across the array**. It is what the session
    carries and what `game_preflight`/`launch_game` name.
  - `title` — 1–32 characters, the toolbar label. One game gives a button with that label; several
    give a `Games` menu, in which an entry whose preflight fails is a disabled label reading
    `<title> — unavailable: <first issue>`. No games declared means no game control at all.
  - `executable` — 1–8 candidates **in order**; the first that exists and is executable wins, so a
    single record covers `build/…` and `build/Release/…`. Each is resolved like a format `argv[0]`:
    absolute as given, relative to the project root when it contains a separator (`.exe` is also
    tried on Windows), or a bare name through PATH. Never a shell expression — ``| ; & $ ` ``
    are rejected.
  - `args` — literal argv, 0–64 strings, no interpolation at all: `${…}` is rejected, unlike a
    format command. There is no shell, so quoting and globs are not expanded either.
  - `env` — optional, added over the sidecar's shell environment. Keys match `^[A-Z][A-Z0-9_]*$`
    and values are literal strings; keys beginning `RENGINE_`, `DYLD_` or `LD_` are reserved for
    the workspace and rejected **by name**, because those are what the surface reservation uses.
  - `cwd` — optional root-relative directory the process starts in; an absent key or `""` means
    the project root. No absolute path, no `..` segment, no backslash.
  - `requires` — optional root-relative files that must exist. Each missing one is a named
    preflight issue, so a target with no data yet reports why instead of failing at launch.
  - `surface` — `embedded` (rEngine injects its SDL2 adapter and hosts the game's frames in a game
    tab), `external` (the game opens its own operating-system window; rEngine starts the session and
    tracks it, and the tab carries its output with Stop), or `cooperative` (the same game tab, but
    the game speaks the surface protocol in its own engine: rEngine reserves the surface and passes
    `RENGINE_SURFACE_PORT`/`RENGINE_SURFACE_TOKEN` and injects nothing). Pick `cooperative` when the
    adapter cannot be interposed — a statically linked or non-SDL2 runtime — and the engine can
    connect for itself; `external` when it cannot. Never declare `embedded` for a game that also
    connects on its own: two producers would greet the same token on one channel and the surviving
    one would be a restart race (spec 078).
  - rEngine names no game anywhere: the tools are `game_preflight(gameId?)` and `launch_game(gameId?)`,
    both defaulting to the first declared target.
- **Dashboard**: kebab-case group and action ids, unique across the dashboard. `script` actions
  name a root-relative `.sh` inside the root and get a retained script tab (`open_script` rules,
  spec 071) with literal `args` and `UPPER_SNAKE` `env`; `log` actions run a literal argv in a
  terminal tab; `capture` actions produce one PNG on stdout into a root-relative `into` directory
  with a `manifest.json`. `requires` (root-relative files) and `tools` (bare PATH names) decide
  whether the button renders enabled; `artifacts` are revealed in the tree. `stream` and
  `operator` are reserved kind names.
- A malformed declaration never disables the workspace: the root is reported as
  declared-with-error and text files still open.

## 5. Tests the project keeps

Copy `orchestrator/templates/project/test_rengine_project_decl.py` to `tests/`. It has three tiers
and needs no network and no running orchestrator:

| Tier | Runs | Checks |
| --- | --- | --- |
| Structure | always | contract, format records, placeholders, argv shape, bounds, every `games` record (unique ids, candidate resolution, literal args, reserved env prefixes, root-relative `cwd`/`requires`), dashboard ids/kinds/paths, and that every declared script exists and passes `bash -n` |
| PinnedContract | when `third_party/rengine` carries the schema **and** its schema accepts the declared contract, otherwise skips with the reason | rEngine's own `validateSchema` accepts the declaration and rejects a typo key and an unknown contract; `readDeclaration`/`matchFormat` read it without error |
| Behaviour | per format, when the declared executable is built and a matching file exists | runs the declared command exactly as rEngine does (substituted argv, cwd = root, no shell) and checks the tree/text shape, the entry bytes and the declared bounds |

Run it standalone with `python3 tests/test_rengine_project_decl.py --root DIR --rengine DIR`
(`--rengine` points at an rEngine checkout before a pin bump). Register it with the project's own
runner — the wizard does not, because the syntax is project-specific:

```cmake
add_test(NAME test_rengine_project_decl
         COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tests/test_rengine_project_decl.py)
```

Keep an `editor.sh` test next to it (nolf-improved's `tests/test_editor_launcher.py` is the
model): `bash -n`, `--help` exits 0, an unknown option exits 2, `--dry-run --rebuild` prints the
three bootstrap commands plus exactly one launch line naming the project root, `--bootstrap-only`
prints none, and `--check` reports every prerequisite while running no command.

## 6. Wire the project's agents

- Keep skills under `.claude/skills/` and commit `.agents/skills` as a symlink to it so Codex/Kimi
  discover the same set.
- Add **one line** to the project's CLAUDE.md/AGENTS.md naming the launching point, for example:
  "Open this checkout in the rEngine orchestrator with `./editor.sh` (pinned at
  `third_party/rengine`; prerequisites: `./editor.sh --check`)."
- Do not copy rEngine's workflow into the consumer. The project keeps its own authority; the
  runbook lives here.

## 7. Review gate

Before the consumer depends on a new rEngine capability, run a cross-vendor **read-only** review of
the rEngine side (`ask-codex`, or `ask-kimi` when codex is out of quota) over the branch that
implements it, and record the verdict **in the consumer**, with the dispositions and what changed
in response. nolf-improved keeps
`docs/findings/rengine-format-registry-codex-review-2026-09-06.md`, which turned six findings into
a fix branch before the pin moved. A review that requests changes holds the pin, not the recipe.

## 8. Open the project window with the retained agent

```sh
bash orchestrator/actions/project-window.sh \
  --context /absolute/path/to/existing-context.json \
  --project /absolute/path/to/game-project \
  --agent <current-retained-agent-id>
```

This adopts the original session host if needed and opens or reuses one window bound to the
project root, with the existing agent still bound to its own root. Details, inspection, focus,
close/reopen and the durable `report_integration` transport: `docs/runbooks/project-window-dogfooding.md`.

## 8b. Bind an agent the workspace never spawned

An agent started in a plain terminal — a second lane, a session opened before the window was, an
agent on a machine where the desktop is not running — has no MCP binding and can only ask a human to
press the controls it cannot. Bind it by discovery from the rEngine checkout:

```sh
npm run bind -- --project /absolute/path/to/game-project --agent claude            # a new session
npm run bind -- --project /absolute/path/to/game-project --agent claude --session UUID   # one that exists
```

It reads no `RENGINE_*` environment variable. It scans the sidecar descriptors under
`${XDG_STATE_HOME:-$HOME/.local/state}/rengine` — the base directory and each of its children, since
a consumer's `editor.sh` nests one state directory per checkout while this checkout's own default
state directory is the base — asks every live instance which roots it serves, and picks the one whose
root is that directory. Two instances claiming it is a refusal naming both, and `--state DIR` names
the one you mean; none claiming it is a refusal listing every directory scanned, which usually means
the project's `editor.sh` has not been run yet. The bound agent gets exactly what a pane-spawned one
gets — its own identity in its own context file — and the command prints the MCP configuration path
and the line that starts the agent on it.

**The identity is the agent's session id** (spec 095, *Identity*), so that line names the session as
well as the configuration: without `--session` an id is minted and the start line is
`claude --mcp-config <path> --settings <path> --session-id <id>`; with `--session UUID` — the id Claude prints on exit
as `claude --resume <id>` — the binding *is* that session and the start line resumes it,
`claude --mcp-config <path> --settings <path> --resume <id>`. Bind the session you are already in,
and the project token follows it through every exit and resume instead of being stranded on a dead
pid. Without `--agent` the command prints the line for each CLI that can consume the configuration as
written (`codex -c mcp_servers.…` among them).

**Start it with the `--settings` file the command prints.** That file is written per launch beside
the MCP configuration and contains one thing: a `SessionStart` hook that reports back which
conversation the CLI is actually running (spec 095, *The CLI reports what it runs*). Without it the
binding is only correct until someone resumes a different conversation from inside the running CLI —
a `/resume` in the picker moves the process, and nothing else can see that it has. With it, the
workspace record, `workspace_info` and the token identity all follow the CLI, and a pane started with
`-c` becomes restartable as soon as the CLI names its own conversation. It adds nothing else and does
not read, write or override the person's or the project's settings files. A pane the workspace opens
gets the flag automatically.

## 9. Layered update after rEngine lands something

```sh
node orchestrator/runtime/client.mjs update --context FILE --desktop ID --layers workspace,desktop,connector
```

Or MCP `update_status` → `list_desktops` → `update_workspace`, then poll the job. Re-inspect the
window and verify the agent PID is unchanged. A connector loaded before a tool existed only picks
it up through the `connector` layer.

## 10. Consumer gates

The consumer's feature stays open until the owner verifies it **in the real window**: the format
opens in its declared default mode and the preview shows the archive; the dashboard lists the
groups and a quick-start action opens its script tab; the game control lists every declared target
and starts each on its declared surface. Automated declaration tests are necessary, never
sufficient — they prove the
declaration is well-formed and its commands run, not that the pane looks right.

## 11. When the pin bumps

1. rEngine merges and pushes the commit; only then is it a legal pin.
2. `git -C third_party/rengine fetch && git -C third_party/rengine checkout --detach <sha>`,
   `git add third_party/rengine`, commit as `chore(rengine): pin <sha> — <reason>`.
3. `./editor.sh --rebuild` (the pinned tree's dependencies and native outputs move with the pin).
4. Re-run the declaration test: the PinnedContract tier now validates against the newer schema, and
   a contract the previous pin could not read stops skipping.
5. Move anything the new contract absorbs — for example a staged `.rengine/dashboard.json` merges
   into `project.json` with `contract: 2` once the pin carries the dashboard, and a single `game`
   object becomes a one-record `games` array at `contract: 3` once the pin carries game targets.

## Worked instance — nolf-improved (reLith), 2026-09-06

The formats, dashboard and tests below are live; the `games` array is **the shape this project is
adopting** for contract 3, not a verified running state — one engine, three declared targets.

| Piece | Value |
| --- | --- |
| Specs | `feature-1700-rengine-submodule.md` (pin policy), `feature-1703-editor-launcher.md`, `feature-1704-rez-format-registration.md`, `feature-1705-project-dashboard.md` |
| Submodule | `third_party/rengine`, private SSH remote, pinned per commit; not built by the project's CMake |
| Formats | `lithtech-rez` — `*.rez`, modes `raw`+`preview`, default `raw`, preview `build/relith-rez --json tree ${file}` (tree), entry `build/relith-rez cat ${file} ${entry}` (16 MiB bound) |
| Games (adopting) | Three targets on the one LithTech engine, all `embedded`: `relith-nolf` (NOLF), `relith-avp2` (AVP2), `relith-nolf2` (NOLF 2). Each is its own record with its own title, args and `requires`; the toolbar shows a menu because there is more than one |
| Dashboard | `quick-start` (Quest RELEASE/DEBUG, PCVR over SSH, AVP2 flat, `editor.sh --check`), `distribution` (`make-dist.sh` → `dist/…`), `device` (`adb logcat` log, `adb exec-out screencap` capture into `.cache/captures/quest`, deploy, push data) |
| Tests | `tests/test_editor_launcher.py`, `tests/test_rengine_project_decl.py`, `tests/test_rengine_dashboard_decl.py`, all registered with ctest |
| Review gate | `docs/findings/rengine-format-registry-codex-review-2026-09-06.md` — codex read-only, 6 findings, fixed on a branch before the pin moved |
| Measured | `tree --json` of `NOLF.REZ`: 598 KB / 4,754 entries in 52 ms; `AVP2.REZ`: 997 KB / 7,216 entries in 70 ms — the 10 s / 4 MiB defaults are generous |

## Worked instance — vtmb-vr (reSource), in progress 2026-09-06

Same caveat: the `games` array below is the shape this project is adopting, not verified live state.

| Piece | Value |
| --- | --- |
| Formats | `troika-vpk` over the project's own `build/vtmb-vpk` CLI (Troika VPK archives) |
| Games (adopting) | Two targets today, both `external`: `build/vtmb` (flat) and the Windows-only `build/vtmb-vr`. Neither can be `embedded` — the project links SDL3 statically, so there is no dynamic SDL2 symbol for the adapter to interpose. That is what `cooperative` exists for (spec 078, F77): the engine implements the surface protocol itself, and the flat target moves to a workspace pane by declaring that value, with no injection and nothing for rEngine to interpose. Further Source-engine titles would be added as further records on the same engine |
| Dashboard | `quick-start`, `device`, `distribution` |
| Notes | Same submodule/`editor.sh`/declaration-test shape; the second consumer is the check that the recipe is a recipe and not a description of one project, and its two targets are the check that `games` is genuinely an array |

## What the orchestrator UI will automate

Today this recipe is a runbook plus a wizard, and the wizard is meant to be run **in a script tab**:
`open_script` on `orchestrator/actions/integrate-project.sh` gives a retained PTY where a human
answers the prompts and reads the follow-ups (spec 071 — interactive scripts are a first-class
workflow UI before native controls exist).

The toolbar's **Add project** button should run exactly this: pick a directory, ask for the name
and the optional first game target, run the same stages in a script tab, and open the project window
on the result. Native controls come after that — a declaration editor that writes `formats`, `games`
and `dashboard` rows through the schema, a pin-bump action that re-runs the consumer's declaration
test, and a review-gate reminder before the pin moves. That work is tracked as F70 with KI-042;
until it lands, the button opens a window on an already-integrated project only, and this runbook
is the path for everything else.
