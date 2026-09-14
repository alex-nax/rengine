//! red-ide: Red as a Claude Code IDE (F161, spec 102, spec 133).
//!
//! Claude Code finds an editor by reading `<config>/ide/<port>.lock` and connecting to the port the
//! filename names. This crate is that editor's side: the lock and who may be named in it (`lock`),
//! which published editors a pane's directory is inside and whether its CLI is told to connect
//! (`discovery`), and the WebSocket that speaks MCP to a connected CLI (`bridge`, `mcp`).
//!
//! Everything here was read out of one CLI binary and checked against the running CLI; every rule
//! is a distrust rule, and each is judged against the answers the JavaScript gave before it was
//! replaced (`orchestrator/tests/ide-corpus.json`, `ide-connect-corpus.json`).

pub mod bridge;
pub mod discovery;
pub mod lock;
pub mod mcp;
