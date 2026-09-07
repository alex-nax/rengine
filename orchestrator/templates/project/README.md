# Consumer project templates

What `orchestrator/actions/integrate-project.sh` copies into a project that is adopting rEngine,
and what a person copies by hand when doing it without the wizard. The recipe around them is
`docs/runbooks/project-integration.md`; the contract they encode is spec 077 plus specs 074
(formats, contract 1), 075 (dashboard, contract 2) and 078 (game targets, contract 3).

| Template | Copied to | Purpose |
| --- | --- | --- |
| `editor.sh` | `<project>/editor.sh` (mode 755) | The project's launching point: bootstraps the pinned rEngine in `third_party/rengine` (submodule init, `npm ci`, `npm run build:surface`, `npm run build`) and `exec`s its launcher on the project root. Modes `--check`, `--dry-run`, `--bootstrap-only`, `--rebuild`; launcher options are forwarded. |
| `project.json` | `<project>/.rengine/project.json` | The complete contract-3 reference declaration: `formats` over the project's own CLI, a `games` array of launch targets (two records, one `embedded` and one `external`, showing `args`, `env`, `cwd` and `requires`) and a `dashboard` of grouped actions. The wizard **generates** a minimal version of this shape (project name, one inert placeholder format, a one-record `games` array when game arguments are given, a dashboard whose one action runs `editor.sh --check`); this file is the fuller reference to copy sections from — including further game targets. |
| `test_rengine_project_decl.py` | `<project>/tests/test_rengine_project_decl.py` | A generic declaration test: structural rules that always run, a pinned-schema tier that validates with rEngine's own `validateSchema`/`readDeclaration` and skips until the pin carries the declared contract, and a behavioural tier that executes the declared commands as rEngine does. Runnable standalone with `--root DIR --rengine DIR`; register it with the project's own runner. |

Rules for these files:

- They name no game, engine or file format. Every project-specific value is a placeholder the
  consumer replaces (`PROJECT_NAME`, `build/project-cli`, `example-*`).
- `project.json`'s placeholder format matches `*.example` and declares no command it needs to run,
  so a scaffolded declaration is valid on the first open. Every contract requires at least one
  format record, so the placeholder stays until the project declares a real one (KI-042).
- `editor.sh` reads its CMake and SDL2 requirements out of the pinned tree, so a pin bump moves
  the prerequisite check with it. Do not hard-code versions here.
- The wizard never overwrites an existing file; a project that already owns one of these keeps it.

Titles you declare (formats, dashboard groups and actions, games) are drawn as text in the desktop's own faces. A glyph those faces lack falls back to another loaded face and then to a small substitution table, so a symbol outside that set draws as a box. Expect the fallback rather than relying on it: a title that must show a symbol should say it in words, because icons are chosen by the desktop rather than by a declaration.

## Contract 6: the write command and the agent menu

`project.json` above is the contract-3 reference and stays that way — JSON carries no comments, and a
template that declared newer keys would be refused whole by any rEngine older than them. Contract 6's
two keys are therefore written out here, to be copied into a declaration whose `contract` is `6`.
Per the schema-freeze rule ([spec 098](../../../docs/specs/098-replace-session-host.md)): a session
host reads the schema once at start, so **code lands first, hosts are replaced, declarations change
last**. A declaration that gains a key its running host does not know is refused entirely, taking that
project's dashboard and formats with it.

```json
{
  "contract": 6,
  "tracker": {
    "provider": "local",
    "inventory": "features.json",
    "write": ["tools/features.py", "write", "${json}"]
  },
  "agents": [
    { "cli": "claude", "models": ["claude-opus-5", "claude-sonnet-5"], "default": "claude-opus-5" },
    { "cli": "codex", "models": ["gpt-5", "gpt-5-codex"], "default": "gpt-5-codex" }
  ]
}
```

`tracker.write` is the project's **own** command for writing one task row, as literal argv with no
shell, run in the project root and bounded like a preview. rEngine never edits the inventory text
itself: it replaces `${json}` with one JSON document — the caller's row plus `action` (`add`,
`update` or `decompose`) and, for a child row, `parent` — and hands it to this command. Whatever the
command prints is handed back, parsed if it is JSON. The key belongs to `provider: "local"` alone;
GitHub and Linear stay read-only, because neither offers concurrency control on an issue write. Writes
are gated by the project token and serialised one at a time per project
([spec 103](../../../docs/specs/103-task-driven-agents.md)).

`agents` is the CLI/model menu the Tasks pane offers when spawning an agent on a task. Each `cli` is
what rEngine launches, each `default` must be one of that record's own `models`, and rEngine passes the
model with that CLI's own flag (`claude --model`, `codex -m`); a CLI whose flag rEngine does not know
is refused by name rather than started without the model. Omit the block and the menu is the CLIs
rEngine can launch, with its own known model lists.

The prompts a spawned agent is seeded with are project **files**, not declaration keys, so changing one
needs no contract bump and no host replacement: put them at `.rengine/prompts/task.md` and
`.rengine/prompts/decompose.md`, templated with `${id}`, `${key}`, `${title}`, `${criteria}` and
`${labels}`. A missing file uses rEngine's shipped default; a placeholder outside that set is named in
the refusal rather than quietly emptied.
