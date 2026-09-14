//! red-lsp: the Language Server Protocol client the workspace runs (F161, charter D37, spec 102).
//!
//! Only the DIAGNOSTIC half of the protocol is here. Completion, hover and definition are the
//! editor's features and belong with the editor's own work; diagnostics are what an agent and a
//! person have to agree about, because the editor pane and `mcp__ide__getDiagnostics` read one
//! store and a file cannot be broken for one of them and fine for the other.
//!
//! rEngine runs a server the project DECLARES and never installs one, so a machine without it gets
//! a named absence rather than a silent empty list.

pub mod servers;
pub mod wire;
