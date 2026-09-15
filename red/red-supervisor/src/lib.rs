//! red-supervisor: the update supervisor in Rust (F159, spec 144, charter D57).
//!
//! The supervisor is the layer a layered update cannot replace, because it *performs* updates. It
//! owns the workspace worker's lifecycle, the managed desktop windows, and the durable transport
//! two agents exchange integration findings over.
//!
//! `windows` is the half with no process in it, and it lands first for that reason: it can be
//! judged exactly against what the JavaScript said, case by case, before anything that spawns a
//! child is moved.

pub mod windows;
