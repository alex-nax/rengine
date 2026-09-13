//! red-link: the libp2p façade and relay of the Rust orchestrator (charter D57, spec 128).
//!
//! F140 gave it a contract to speak; F180 (F141a) gives it the wire and the workspace behind it.
//! `host` faces the workspace over its existing internal HTTP API; `net` faces clients over
//! libp2p, and does it **through a circuit relay on purpose** — the façade opens no direct
//! listener at all, so the NAT path every phone will take is the only path anything here can take.

pub mod host;
pub mod net;

pub use host::{Endpoint, Workspace};
