//! red-worker: the root-bound workspace worker in Rust (F158, spec 129, charter D57).
//!
//! `runtime/worker.mjs` is a **dispatcher**: 32 `/api/*` routes, of which **19 are already answered
//! by red-host** and reach it by forwarding. What is genuinely the worker's is the pair it owns —
//! the project token ledger and the lifecycle feed — and the thin routes over `red-ide`, `red-lsp`,
//! `red-token` and `red-project`, all of which are crates that already exist.
//!
//! So this crate is not a rewrite of 733 lines. It is a server around work that is already done,
//! and it moves a route at a time the way the door did.
//!
//! `feed` is first because it is the one thing nothing else can serve: one writer, one sequence,
//! and a watcher that resumes from a cursor.

pub mod feed;
pub mod identity;
pub mod menu;
pub mod scripts;
pub mod serve;
