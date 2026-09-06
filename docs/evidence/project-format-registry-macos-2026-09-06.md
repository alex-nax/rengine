# Project format registry — macOS, 2026-09-06

Spec 074 implements contract 1 of the project format registry (F63) and the native raw/preview
modes (F64), authorized by the owner's 2026-09-06 direction for `*.rez` files in nolf-improved.
Work happened on branch `feat/format-registry` in a worktree; no game, conversation or goal was
launched and the live orchestrator, sidecar and Codex agent were not touched.

## Real consumer check (nolf-improved, read-only)

Run through `startServer` with a disposable state directory, `addRoot('/Users/alex/nolf-improved')`
and the same authenticated routes and MCP worker the desktop uses (`.cache/nolf-check.mjs`, not
committed):

- `formats`: `declared: true`, project `nolf-improved`, one format `lithtech-rez` with modes
  `[raw, preview]`, default `raw`, preview `build/relith-rez --json tree ${file}` (10 s / 4 MiB)
  and entry `build/relith-rez cat ${file} ${entry}` (10 s / 16 MiB). The declaration validates
  unchanged against `contracts/project-v1.schema.json`.
- `format-preview` on `nolf/NOLF.REZ`: kind `tree`, 598,364 bytes of producer output, command
  `/Users/alex/nolf-improved/build/relith-rez --json tree /Users/alex/nolf-improved/NOLF/NOLF.REZ`,
  producer 69 ms, round trip 86 ms; sanitized tree CHARS (971 files), GUNS (460), TEX (3,241),
  WORLDS (82); 4,754 files in total.
- Entry `CHARS/MODELS/VSSVER.SCC`: 1,760 bytes (matches the tree's declared size), SHA-256
  `f32fb66f…843a5c`, 44 ms; a 16-byte page at offset 65,536 of the 4,080,357-byte
  `CHARS/MODELS/ARCH_BASE.ABC` returns `9ebf48d6e5400000803ff6510ec1580a` with no text (binary).
- `bytes` window of the 618,254,258-byte archive: `0d0a52657a4d67722056657273696f6e…`
  (“\r\nRezMgr Version 1 Copyright (C)”).
- A missing entry fails as `Command failed (exit 1): relith-rez: no such file: Worlds/nope.dat`.
- MCP: 20 tools including `preview_file`; the top-level slice is 6,457 bytes instead of 598 KB
  (`totalFiles: 4754`, dirs CHARS/GUNS/TEX/WORLDS), `dir: WORLDS` lists 61 files
  (`WORLDS/M01S01.DAT:3101263`, …), and the entry call returns the identical SHA-256 without a
  hex window.

The real project window was not updated: the live workspace worker, desktop and connector
predate these routes and need `update_workspace` with all three layers. The owner's visual check
of `nolf/NOLF.REZ` opening raw by default and showing the tree in Preview remains outstanding.

## Fixtures

The service tests use a temporary project whose producer is `orchestrator/tests/pack-producer.mjs`
(a `PACK\0` header plus a JSON manifest; it can fail, sleep or bloat on request). They failed
before `formats.mjs` existed (`ERR_MODULE_NOT_FOUND`), then cover: eleven schema rejections plus
invalid JSON and an absent file (each reported with `declared: true`, `error`, `formats: []` while
`file`/`tree` keep working on that root), default bounds, case-insensitive globs including `[…]`
classes, tree sanitization (producer `offset/time/type` dropped), a literal `$(name)` entry
argument, UTF-8 and binary entries with hex windows and paging, traversal/symlink/foreign-root
rejection, `formatId`, undeclared and unmatched files, raw byte windows (cap, beyond-end,
directory), a `text`-kind preview, a project-relative `tools/pack.sh` executable resolved with
cwd = root, timeout (700 ms, child killed), oversized output, non-zero exit with stderr's first
line, unparseable output, a missing executable, and the same routes through the replaceable
worker and the `preview_file` MCP tool (dir/depth slicing, entry facts, errors).

The native fixture `native-format-registry.spec.mjs` drives real SDL events: `sample.pack` opens
in raw hex by default (`00000000  50 41 43 4b 00 7b …|PACK.{"entries":|`, no Save/Discard, mode
switch limited to raw/preview), Preview shows the tree (`Worlds` with 1 dir and 1 file, 4 files
in total) and names the command, collapsed directories hide their files, expanding `Worlds` and
selecting `t01.dat` shows a hex entry with size and SHA-256, `readme.txt` shows read-only text,
switching back to raw drops the entry, the preview mode survives GUI restart, `failing.pack`
shows `Command failed (exit 2): boom: archive is corrupt` with Retry and the command name,
`blob.bin` (unregistered) falls back to hex with text/raw modes, and `note.txt` keeps the editor
with Save. Snapshot `.cache/evidence/format-preview.bmp` was inspected: mode buttons, tree with
sizes, entry header and text render as designed.

## Gates

- `npm test`: 31 passes, 4.86 s (the four new format tests: 4.52 s alone).
- Native fixture alone: 1 pass, 5.15 s. `npm run test:desktop`: 14 passes, 216.23 s, exit 0.
- CTest in `.cache/desktop`: 4 passes, 0.74 s. `python3 tools/design.py check`: consistent
  (new `format` metric group generated into `theme.h`). `./init.sh`: passes (24 features).
- Sidecars: eleven touched or new files checked, stamped and clean.

Windows is unqualified (KI-014): the `.exe` fallback for relative `argv[0]` is code only.
Paging an entry re-runs the declared command by design; a cache is a later decision (KI-037).
