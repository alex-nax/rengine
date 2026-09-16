//! red-supervisor: the update supervisor in Rust (F159, spec 144, charter D57).
//!
//! The supervisor is the layer a layered update cannot replace, because it *performs* updates. It
//! owns the workspace worker's lifecycle, the managed desktop windows, and the durable transport two
//! agents exchange integration findings over — and the session host beneath it keeps every PTY,
//! every agent and every draft while all of that is swapped out.
//!
//! The modules are the pieces that can be judged on their own:
//!
//! - [`windows`] — project windows, layouts and the integration transport. No process in it, so it
//!   is frozen exactly against what the JavaScript said.
//! - [`desktop`] — what a window is launched with, and the channel it is asked things over.
//! - [`jobs`] — what a caller may ask an update for, in what order it is refused, and the status it
//!   polls afterwards.
//! - [`worker`] — the workspace worker as a child, and the three things a candidate has to do
//!   before anything is switched to it.
//! - [`views`] — the managed desktop windows, the snapshot each one runs, and the exit code that
//!   means "I detached for an update" rather than "I closed".
//! - [`replace`] — which process gets a SIGTERM when a session host is replaced, and the several
//!   that must not.
//! - [`stop`] — the acting half of that: reading `ps`, sending the signal, watching a port close.
//! - [`host`] — the session host as a launcher deals with it: find the binary, start one, say how
//!   old the running one is.

pub mod desktop;
pub mod host;
pub mod jobs;
pub mod replace;
pub mod runtime;
pub mod stop;
pub mod update;
pub mod views;
pub mod windows;
pub mod worker;

/// Where the runtime descriptor lives for a host, when nobody names a directory: the path
/// `runtimeDirectory(host)` computes on the JavaScript side (KI-110, spec 095).
pub fn runtime_directory(checkout: &std::path::Path, instance: &str) -> std::path::PathBuf {
    checkout.join(".cache/runtime").join(instance)
}

/// Why an ask was refused, and the status the route answers with.
///
/// One type for the whole crate, because it is one fact: a caller is told a sentence and a status,
/// and a second definition of that would be a second set of statuses to keep in step.
#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub message: String,
    pub status: u16,
}

impl Refused {
    pub fn new(message: &str, status: u16) -> Self {
        Self { message: message.to_string(), status }
    }
}
