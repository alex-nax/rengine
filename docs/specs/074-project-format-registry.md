# Project format registry (contract 1)

Date: 2026-09-06. Owner-directed continuation of the NOLF workspace goal: `*.rez` files in the
nolf-improved project open in the editor in a raw hex mode by default and offer a Preview mode
that shows the archive's contents in the pane. Implemented generically: a project declares its
own file formats and the executables that produce their previews; rEngine owns the editor modes,
the hex view, the execution boundary and the contract. The consumer proposal is
`nolf-improved/docs/specs/feature-1614-rez-format-registration.md`; this spec is the authority
once merged and the consumer bumps its pin to validate against `contracts/project-v1.schema.json`.

## Declaration and discovery

`<root>/.rengine/project.json` is read on demand for a bound root (list, open, refresh), never
during tree listing, and is bounded to 256 KiB. `contract` must equal 1; `project` names the
project; `formats` lists records with `id` (kebab-case, unique), `title`, `match` (case-insensitive
shell globs on the file name: `*`, `?`, `[…]`), `modes` ⊆ {`raw`, `preview`, `text`} (non-empty,
unique), `default` ∈ `modes`, and up to two commands. `preview` (required when `preview` ∈ `modes`)
has `kind` `tree` or `text`; `entry` is optional with `kind` `bytes`. Each command has a literal
argv `command` (non-empty strings), `timeoutMs` (default 10,000; at most 600,000) and `maxBytes`
(default 4 MiB; at most 64 MiB). The only placeholders are `${file}` and `${entry}`: a preview
command names `${file}`, an entry command names both. `argv[0]` is literal and may not contain
`|`, `;`, `&`, `$` or a backtick. Unknown keys are rejected so a typo cannot silently disable a
mode. The JSON Schema is the machine-readable contract; the service applies the same subset of
Draft 2020-12 (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`,
`pattern`, numeric and length bounds, `uniqueItems`, local `$ref`) plus the cross-field rules above.

A missing declaration means an undeclared root. A malformed declaration, an unknown contract or an
unreadable file is reported in the listing (`declared: true`, `error`, empty `formats`) and by the
status line; it never disables the workspace, the editor or other roots. Case-insensitive matching
is deliberate: LithTech data mixes `NOLF.REZ` and `.rez`.

## Execution boundary

The service runs a command only on an explicit open or refresh of a matching file, or an explicit
agent call. `${file}` is the absolute path resolved through the existing authenticated root-relative
boundary (traversal and external symlinks rejected); `${entry}` is the tree entry's `path` passed
as one literal argument. `argv[0]` resolves: absolute as given; containing a separator relative to
the project root (a `.exe` suffix is tried on Windows); a bare name through the sidecar's PATH.
The child runs with cwd = project root, the sidecar's shell environment (`shellEnvironment`), no
shell, stdin closed. It is killed on `timeoutMs` or when stdout exceeds `maxBytes`; a non-zero
exit, a timeout, an oversized output, an unparseable tree or invalid UTF-8 text fail with stderr's
first line (or the reason) and the substituted argv so the pane and the agent name what ran. No
output is cached across requests; paging an entry re-runs its command. A project's executables
can have effects, as with `open_script`: the pane names the command it ran.

Routes (host and replaceable worker, capability `formatRegistry: 1`):

- `GET /api/formats?rootId` → `{ rootId, declared, project?, contract?, error?, formats }`.
- `POST /api/format-preview { rootId, path, formatId?, entry?, offset?, length? }` → for a preview
  `{ kind: "tree"|"text", format, title, path, command, durationMs, bytes, tree | text }`; the tree
  is sanitized to `{ name, dirs, files: [{ name, path, size }] }` with depth ≤ 64 and at most
  200,000 nodes; text must be UTF-8 without NUL. With `entry`: `{ kind: "entry", format, path,
  entry, command, durationMs, size, sha256, text?, window: { offset, length, hex } }` where `text`
  is present when the bytes are UTF-8 without NUL and at most 2 MiB, and the window is at most
  64 KiB of hex at `offset`. `formatId` selects among several matching formats; otherwise the
  first match wins.
- `GET /api/bytes?rootId&path&offset&length` → `{ rootId, path, size, modified, offset, length,
  hex }`, a bounded 64 KiB window of any regular file, for the raw view of files `readText`
  rejects. No write path exists; drafts and Save are untouched.

## Editor behaviour

An editor tab whose file name matches a registered format opens in the declaration's `default`
mode with a visible mode switch among its `modes`. `raw` is a read-only hex view: offset column,
16 bytes per row, ASCII column, a bounded 64 KiB window with page controls and its own scrollbar.
It is also the automatic fallback for every file the text read rejects with a content error,
registered or not; an explicit mode choice is never overridden. `preview` for `kind` `tree` shows
a collapsible tree with sizes; selecting a file when an `entry` command exists shows that entry
below the tree, read-only, as text when it is UTF-8 without NUL and otherwise as hex. `kind`
`text` shows a read-only text pane. `text` is the existing editor. A failing command shows
stderr's first line and a Retry; Refresh re-runs the command. Preview and raw are read-only:
Save, Discard and drafts apply to text mode only. The chosen mode persists with the layout and
survives GUI restart; the format list for a root is fetched once per connection and after a root
is added. Mode buttons, page controls, tree rows and Retry are inspectable controls.

## Agents

`preview_file` (`path`, optional `entry`, `dir`, `depth`) runs the identical declared command
through the bound root and returns the sanitized subtree at `dir` to `depth` levels (default 1,
at most 8) or the text; with `entry` it returns size and SHA-256 plus the text when UTF-8. It is
marked open-world because it executes the project's own program; it never writes. The live
connector predates the tool and picks it up only through a layered `connector` update.

## Acceptance and verification

1. Service tests fail before the routes exist, then cover discovery, schema rejections (unknown
   contract, shell-style `argv[0]`, unknown placeholder, missing keys, non-array command, default
   outside modes), case-insensitive globs, placeholder substitution with a literal `$(…)` entry,
   root boundary, tree/text/entry results, hex windows, timeout, oversized output and non-zero
   exit with stderr's first line, through the host, the replaceable worker and the MCP tool, using
   a temporary project with a small script producer and no dependency on nolf-improved.
2. A native fixture opens a declared binary file in raw mode, switches to preview, expands the
   tree, opens one entry, switches back, restores its mode after GUI restart, surfaces a failing
   command with Retry, and falls back to hex for an undeclared binary file while text files keep
   the editor and Save.
3. One recorded check runs the real nolf-improved declaration with `build/relith-rez` on
   `nolf/NOLF.REZ` through the same service and tool paths.
4. `npm test`, `npm run test:desktop`, CTest, `./init.sh`, design check and sidecar validation pass.
   The owner verifies the real project window after a layered update; Windows stays unqualified.

Boundaries: no new npm or C dependency; C/microui/SDL2 only; no write path, no automatic
execution, no global agent configuration; Windows `.exe` resolution is untested there (KI-014).
