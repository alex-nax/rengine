# The declaration reader's answers, frozen before it is replaced (2026-09-14)

F156b, spec 129, KI-107. `readDeclaration` in `orchestrator/server/formats.mjs` is the keystone of
the remaining JS host — `dashboard.mjs`, `devices.mjs`, `games.mjs` and `tracker.mjs` all read a
project through it — and it is the next thing to port. This is the step that comes first.

## Why a record rather than a comparison

The pattern is F148's, F172's and F178's: **a replacement cannot be compared against a module that
no longer exists.** So the module's answers are recorded while it is still here, and the Rust side is
judged against the record afterwards. `orchestrator/tests/declaration-fixtures.mjs` is the corpus and
the generator; `declaration-fixtures.json` is the evidence. Regenerating it after the port would be
judging the replacement against itself, which is why the header says to regenerate it only from a
checkout where `formats.mjs` still reads declarations — that is, never again after the deletion.

## What is in it

**53 cases, 40 of which record a refusal, chosen for the judgements rather than the happy path.** A declaration that is missing,
unreadable, too large, not JSON, not an object, or on an unknown contract. A schema refusal with one
problem and with several (the "and N more problems" clipping is part of the answer). A contract floor
for every key that has one — `title` and `icon` at 5, `agents` at 6, brand artwork at 8, `tests` at
10. Both halves of the icon's exactly-one rule, and an icon token that is not a design token. Artwork
that escapes the declaration's directory, that is not an `.svg`, and that simply is not there — the
last of which is *reported* while the artwork that did resolve is still handed over. A tracker
missing its provider's required key and a tracker wearing another provider's. A pack with a facet and
one with none. Two language servers sharing an id.

The section rules are in it too, one mistake per case, because a record that only held valid games
and dashboards would pass a port that omitted every rule about them: a dashboard action naming a
game nobody declared, a script action that is not a root-relative `.sh`, a capture writing outside
the root, an env key that is not UPPER_SNAKE, duplicate group, game, format and agent ids, a game
requiring a path outside the root or claiming a reserved `RENGINE_` key, a format whose default is
not one of its modes and one whose preview command never names `${file}`, an agent default that is
not one of its models, and a pack pinned to a tag rather than a digest.

Every path in the record is `<root>` or a constant: the corpus declares its own format rather than
borrowing the one that names this machine's node and this checkout's producer, because a record only
one machine can check is not a record.

## The half that runs today

`declaration-record.test.mjs` drives the live reader over the corpus and compares it to the record,
so the evidence cannot drift from the thing it froze. It also asserts the two properties the corpus
exists to keep honest: a declaration that cannot be read is **reported rather than thrown**, and a
bad block disables that block alone rather than the formats with it.

| Sabotage | Observed |
| --- | --- |
| the reader stops naming the contract floor for an icon | the recorded answers are no longer the ones the reader gives |
| artwork that cannot be read is dropped instead of reported | the same, on the `artworkError` the chrome shows |
| a dashboard action may name a game nobody declared | the `dashboardError` about an undeclared game id disappears |
| a game may claim a reserved `RENGINE_` environment key | the `gamesError` about it disappears |

## Gates

`npm test` — **328 of 328**.

## What this does not claim

Nothing is ported and nothing is deleted. This is the artifact the port is measured against, written
while the thing being measured still exists.
