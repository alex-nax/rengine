# The preview and the byte window are red-project's (2026-09-14)

F156e, spec 129. The last of `orchestrator/server/formats.mjs`: a module that was 386 lines when
this epic reached it, 152 after the declaration reader left, and **80 now** — of which 62 are the
one thing that has not moved yet.

## What moved

`formatPreview` and `readBytes` are `red/red-project/src/preview.rs`. `formats.mjs` keeps their
names and their signatures and asks the binary, the shape `store-client.mjs` established: the
answer comes from Rust, no caller changes, and a refusal arrives as `{error, status}` and is thrown
as the same `fail()` the module raised, so a route answers the status it always answered.

## The record

29 cases, `orchestrator/tests/preview-corpus.json`, taken from the JavaScript while it still ran
these itself (be626ea) and **frozen**: the generator was deleted with the implementation it asked,
because a record regenerated afterwards would judge the replacement against itself. The fixtures use
`/bin/cat` and two scripts the fixture writes, so the record is the same on any machine; `${file}`'s
project path, a run's duration and a file's modification time are folded.

Every refusal is recorded word for word. A preview that will not run is what a person sees instead
of their file, and the sentence is the whole explanation.

One case is held to a prefix rather than a string: `a declaration that would not read` ends in the
JSON parser's own parenthetical, and V8 and serde word that differently. It is marked in the corpus
rather than excused.

## Three defects the record found, and one it could not

Each of the first three was found by **extending the record while the JavaScript still existed to
extend it from** — which is the only time a record can be extended.

**An invented status.** `red_project::recordings::Fail.status` was `u16`, so a refusal the store
raised with none — `realpath` on a file that is not there — was answered with a 500 this side made
up. The JS carried `status: null` there, because the store's refusal crossed the store service and
`store-client` rebuilds an error from `{message, status}` alone. `Option<u16>` now, like
`red_store::store::Fail`; turning an absent status into a number is the **route's** rule, and
`red-host::routes::refusal` does it where `main.mjs` did (`error.status ?? 500` — the `ENOENT → 404`
arm never fired for a store refusal, because `code` did not survive the service either).

**A window that guessed.** An entry's byte window fell back to offset 0 for a value it could not
read, where the JavaScript refused; and `as_window` read only decimal integers, where `/api/bytes`
is a query string and delivers `offset=` empty (`Number('')` is 0) and `1e1` (10). Six cases added,
`window_bounds` now shared by both windows. What a route cannot deliver — a boolean, an array — is
not recorded and refuses rather than following `Number()` into coercions this project does not rely
on.

**A confinement the port dropped**, and the one no record could have caught. `read_bytes` resolved
the name, stat'd the name and opened the name — which confines what the name pointed at, not what
was read. The rule is `raw-read-confinement` in the sidecar: open first, fstat the handle, resolve
the same relative path again, and require the same file; a swap in between is a 409. It is about a
**race**, and a record of answers has no case for a race. The sidecar entry is what caught it, when
it was moved from `formats.mjs` to `preview.rs` because its code had moved.

## Sabotages

| Sabotage | Observed |
| --- | --- |
| a store refusal's absent status is filled in with 500 | `a byte window of a file that is not there` answers `status: 500` where the record has `null` |
| `${file}` substitutes the relative path | every declared command runs against a path the producer cannot open |
| an empty query parameter refuses instead of reading from the start | `a byte window whose offset arrived empty` refuses where the record reads 4 bytes |
| the identity predicate compares size instead of the inode | two different files of equal size pass as one file |

## What is left in `formats.mjs`

`runCommand` (62 lines), because a dashboard **capture** still runs a project's command here and
writes the bytes it produced into the project. It goes with that write, not with this.

## Gates

`npm test` 341/341 (344 before: the record test and its duplicated import went with the JavaScript
it judged, and its rules moved into the parity spec). `cargo test --workspace` 96/96. `./init.sh`
passes.

JavaScript on the app path: **5,456**, from 5,524.

---

# The dashboard capture is red-project's, and `formats.mjs` runs nothing (2026-09-14)

F156f, spec 129. The second half of the same day's work, and the end of `formats.mjs` as anything
but a client: **33 lines**, four functions, no `spawn`.

## What a capture is

The one declared action that WRITES. It runs the project's own command, judges the bytes, and lands
a PNG and a manifest row inside the project — so the ORDER of its steps is its contract, not an
implementation detail:

1. the board decides whether the action may be pressed at all, and a grey button's reason is this
   refusal's sentence;
2. `into` is checked **lexically**, before anything is created;
3. the directory is created, and only then is the path resolved and required to be a directory;
4. the command runs under this route's own bounds — 10 s, 8 MiB — not the declaration's;
5. the PNG signature is checked **before anything is written**;
6. the image and the manifest land through temp-and-rename.

## The record holds what is on disk

14 cases, `orchestrator/tests/capture-corpus.json`, taken from `dashboard.mjs` while it still
captured (5f84f05) and frozen the same way the preview's was — the generator deleted with the
implementation it asked. Each case records three things: the answer, the capture directory
afterwards, and the manifest as it now reads. That is not thoroughness for its own sake: several of
these refusals **promise that nothing was written**, and only what is on disk can check a promise
like that.

Two rules the record pins that reading the code would not have settled:

- a contract-1 project is not a project *without* a dashboard, it is a project whose dashboard is
  empty — so the action is simply unknown (**404**, not the 415 the `!board.declared` branch
  suggests). The 415 belongs to a project with no declaration at all.
- `into` naming an existing **file** refuses with the filesystem's own `EEXIST: file already exists,
  mkdir '…'` and **no route status**, because step 3 creates before it resolves. `Fail::raw` exists
  for exactly this: an error the filesystem raised carried no status in the JavaScript either, and
  `main.mjs` decided what such a thing answered.

One rule is **not recordable**: a second capture in the same millisecond is named `<time>-2.png`,
and nothing in a corpus can make two calls share a millisecond. It is a function — `free_name` —
with a unit test, rather than a line inside the one that writes.

## Sabotages

| Sabotage | Observed |
| --- | --- |
| the manifest is replaced instead of appended to | the second capture's manifest holds one row where the record has two |
| the signature is not checked before the write | `bad-shot` lands a file of text named `.png` and answers as a capture |
| the collision loop stops after one bump | a third capture in one millisecond reuses `-2` |

The manifest file was also compared **byte for byte** against the JavaScript's, not only its parsed
value: `serde_json::to_string_pretty` and `JSON.stringify(…, null, 2)` leave the same file, and
`preserve_order` keeps the row's keys in the order they were written.

## What the deletion took with it

`runCommand` and its helpers (62 lines) — nothing in this workspace spawns a project's command from
JavaScript now. `devices.mjs`'s `present` and `store-client.mjs`'s `MAX_TEXT_BYTES` went with their
last readers. `formats-hardening.test.mjs`'s re-confinement spec drives the **route** now, which is
where a caller reaches that rule and the only place it can still be observed.

## Gates

`npm test` 343/343, `cargo test --workspace` 97/97, `./init.sh` passes.

JavaScript on the app path: **5,388**, from 5,456.
