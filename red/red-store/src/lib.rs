//! red-store: the workspace store in Rust (F169, F147a, spec 129, KI-091).
//!
//! `store` is WorkspaceStore with byte-compatible on-disk behavior; `schema` is the bounded
//! JSON Schema subset with identical error strings. Nothing is deleted in this slice: the JS
//! host keeps serving while this crate proves the bytes against the corpus the JS host wrote
//! (orchestrator/tests/red-store.test.mjs drives it; red-store-check is the judge).

pub mod schema;
pub mod store;
