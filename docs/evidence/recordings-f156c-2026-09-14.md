# The recording reader is Rust, and `recordings.mjs` is a client (2026-09-14)

F156c, spec 129. **KI-107's blocker was not a blocker**, and this is the commit that shows it.

## The correction

KI-107 said the remaining `server/*` modules cannot be deleted because `runtime/worker.mjs` imports
them and serves their routes from its own checkout, and that unpicking it needed an owner decision
about spec 065's layering. That framing was wrong. This repository has answered exactly this
question three times already: `store-client.mjs`, `pty-client.mjs` and `agents-client.mjs` are thin
JavaScript clients over Rust implementations. **The implementation leaves; the module's API stays;
every caller is untouched** — including the worker, which goes on serving the capability from its own
checkout exactly as spec 065 says it must, by running the checkout's Rust rather than importing the
checkout's JavaScript.

No decision is needed to keep going. The layering is preserved, and the JavaScript still goes.

## What moved

`red/red-project/` is the new crate for what a project declares and what it leaves behind — the
landing place for F153–F156. Its first module is the recording store: manifests, the artifact
composition, the newest-first listing, the keyframe paging and the log budget that is spent from the
end of the log backwards.

`orchestrator/server/recordings.mjs` went from 115 lines to 46, all of them client: the same
exports, the same bounds, and a refusal turned back into the same `fail()` the reader threw, so a
route answers the status it always answered. One question, one process — a recording list is opened
by a person clicking a tab, so the cost of starting a process is paid where somebody is already
waiting.

## The check

**`recordings.test.mjs` is unchanged — all 212 lines of it** — and so is `native-recording.spec.mjs`
and the worker. That is the point of the pattern: the spec that judged the JavaScript judges the
Rust, because the module it imports still answers.

| Sabotage | Observed |
| --- | --- |
| an incomplete recording is dropped instead of reported | `a commit that did not finish is a fact about the store` |
| the log tail is taken from the front | the oldest lines come back where the newest were |
| the keyframe page ignores its offset | the page starts at the beginning whatever was asked for |

`rust-workspace.test.mjs` now reads the workspace's members from its manifest rather than listing
them, because a new crate was reported as an unpinned registry dependency — a true statement about
the wrong thing.

## Gates

`npm test` — **328 of 328**. `cargo test` — all crates. `native-recording.spec.mjs`.

JavaScript on the app path: **6,743**, from 6,801.
