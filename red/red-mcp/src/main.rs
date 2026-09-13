//! red-mcp: the root-bound MCP server of the Rust orchestrator (F184/F150a, spec 129, KI-100).
//!
//!   red-mcp --context <workspace-context.json>
//!
//! This is the connection every agent pane talks to the workspace through. It speaks MCP over
//! stdio — newline-delimited JSON-RPC 2.0 — and serves the same tool surface `mcp-worker.mjs`
//! serves, from `tools.json`: **the declaration was captured from that worker while it was
//! running**, so the descriptions and schemas are the ones agents already read rather than prose
//! retyped into Rust. Fifteen kilobytes of hand-transcribed description is a transcription error
//! waiting to happen; a captured declaration is a diff.
//!
//! F184 brought the surface; F185 brings the calls: `tools/call` runs the same three steps the JS
//! worker ran — the capability this workspace declares, the token where the tool is gated, and the
//! workspace's own route — and answers in the same envelope, with the project's absolute path
//! redacted out of any refusal.
//!
//! The binding is checked at startup exactly as the JS worker checks it — the context must name a
//! loopback host with a 64-hex token, the host must still be the instance the context names, and
//! the bound root must still exist — so a pane whose workspace moved is told at once instead of on
//! its first tool call.

use std::io::{BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

mod tools;
mod workspace;

use workspace::{Binding, Workspace};

/// The surface, as the JS worker answered it. Captured once; regenerating it from this binary
/// would be judging the port against itself.
pub const DECLARATION: &str = include_str!("tools.json");

/// What the SDK on the other end knows how to speak. A client asking for one of these is answered
/// in its own version; anything else is answered in ours, which is what the JS SDK does.
const SUPPORTED: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST: &str = "2025-11-25";

fn context_from(argv: &[String]) -> Result<(Binding, Option<workspace::Identity>), String> {
    let named = argv
        .iter()
        .position(|argument| argument == "--context")
        .and_then(|at| argv.get(at + 1))
        .cloned();
    let snapshot = std::env::var("RENGINE_MCP_CONTEXT_SNAPSHOT").ok();
    let text = match (snapshot, named.as_deref()) {
        (Some(snapshot), _) if !snapshot.is_empty() => snapshot,
        (_, Some(file)) => std::fs::read_to_string(file).map_err(|error| format!("cannot read {file}: {error}"))?,
        _ => return Err("A workspace context file is required.".into()),
    };
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("the workspace context is not JSON: {error}"))?;
    let url = value.get("url").and_then(Value::as_str).unwrap_or_default().to_string();
    let token = value.get("token").and_then(Value::as_str).unwrap_or_default().to_string();
    let instance = value.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
    let root_id = value.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string();
    if !url.starts_with("http://127.0.0.1:") || token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) || root_id.is_empty() {
        return Err("Invalid local workspace context.".into());
    }
    let runtime_directory = value.get("runtimeDirectory").and_then(Value::as_str).map(str::to_string);
    Ok((
        Binding { url, token, instance, root_id, runtime_directory, context_file: named },
        workspace::identity_of(&value),
    ))
}

fn declaration() -> Value {
    serde_json::from_str(DECLARATION).expect("the captured tool declaration is JSON")
}

fn negotiated(asked: Option<&str>) -> String {
    match asked {
        Some(version) if SUPPORTED.contains(&version) => version.to_string(),
        _ => LATEST.to_string(),
    }
}

/// A tool's answer, in the envelope the SDK's client unwraps: the JSON as text for a reader, the
/// same JSON as `structuredContent` for a program.
fn answered(output: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": output.to_string() }],
        "structuredContent": output,
    })
}

/// A refusal, with the project's absolute path out of it — a pane's own root is not news to the
/// pane, and a path in an error is a path in a transcript.
fn refused(message: &str, root_path: &str) -> Value {
    let text = if root_path.is_empty() { message.to_string() } else { message.replace(root_path, "<root>") };
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}

fn answer(method: &str, params: &Value, surface: &Value, workspace: &mut Workspace) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": negotiated(params.get("protocolVersion").and_then(Value::as_str)),
            "capabilities": surface.get("capabilities").cloned().unwrap_or_else(|| json!({ "tools": {} })),
            "serverInfo": surface.get("server").cloned().unwrap_or_else(|| json!({ "name": "rengine-workspace", "version": "1.0.0" })),
            "instructions": surface.get("instructions").cloned().unwrap_or(Value::Null),
        })),
        "tools/list" => Ok(json!({ "tools": surface.get("tools").cloned().unwrap_or_else(|| json!([])) })),
        "ping" => Ok(json!({})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            if !tools::names().contains(&name.as_str()) {
                /* A RESULT, not a JSON-RPC error, and in the SDK's own words: that is what the JS
                   server answers, and `mcp.mjs` recognises exactly this text to tell a pane its
                   tool list moved under it. A thrown error instead would reach the pane as a
                   transport failure rather than an answer it can read. */
                return Ok(json!({
                    "isError": true,
                    "content": [{ "type": "text", "text": format!("MCP error -32602: Tool {name} not found") }],
                }));
            }
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            /* The root path for the redaction is read before the call, because a call that fails
               has no state to read it from afterwards. */
            let root_path = workspace
                .scoped_state()
                .ok()
                .and_then(|state| state.get("root").and_then(|root| root.get("path")).and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default();
            Ok(match tools::call(workspace, &name, &arguments) {
                Ok(output) => answered(output),
                Err(message) => refused(&message, &root_path),
            })
        }
        other => Err((-32601, format!("Method not found: {other}"))),
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("--version") {
        println!("{} red-mcp {} ({} tools)", red_core::theme::PRODUCT_NAME, env!("CARGO_PKG_VERSION"),
                 declaration().get("tools").and_then(Value::as_array).map(Vec::len).unwrap_or(0));
        return ExitCode::SUCCESS;
    }
    let mut workspace = match context_from(&argv).and_then(|(binding, identity)| {
        let mut workspace = Workspace::open(binding, identity);
        /* The same check the JS worker makes before serving anything, and for the same reason: a
           pane whose workspace moved is told at once rather than on its first tool call. */
        workspace.scoped_state().map(|_| workspace)
    }) {
        Ok(workspace) => workspace,
        Err(message) => {
            eprintln!("red-mcp: {message}");
            return ExitCode::FAILURE;
        }
    };
    let surface = declaration();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message): Result<Value, _> = serde_json::from_str(&line) else {
            let _ = writeln!(out, "{}", json!({ "jsonrpc": "2.0", "id": Value::Null, "error": { "code": -32700, "message": "Parse error" } }));
            let _ = out.flush();
            continue;
        };
        /* A notification has no id and takes no answer — `notifications/initialized` is the one
           every client sends, and answering it is a protocol error rather than a nicety. */
        let Some(id) = message.get("id").cloned() else { continue };
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let reply = match answer(method, &params, &surface, &mut workspace) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        };
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_declaration_is_the_surface_the_worker_answered() {
        let surface = declaration();
        let tools = surface.get("tools").and_then(Value::as_array).expect("tools");
        assert_eq!(tools.len(), 38, "the captured surface is the whole one");
        for tool in tools {
            assert!(tool.get("name").and_then(Value::as_str).is_some_and(|name| !name.is_empty()), "every tool is named");
            assert!(tool.get("description").and_then(Value::as_str).is_some_and(|text| !text.is_empty()),
                    "every tool keeps the description agents read");
            assert_eq!(tool.get("inputSchema").and_then(|schema| schema.get("type")).and_then(Value::as_str), Some("object"),
                       "every tool carries the JSON Schema the client validates against");
        }
    }

    #[test]
    fn a_client_is_answered_in_its_own_protocol_version_when_we_know_it() {
        assert_eq!(negotiated(Some("2025-06-18")), "2025-06-18");
        assert_eq!(negotiated(Some("1999-01-01")), LATEST);
        assert_eq!(negotiated(None), LATEST);
    }

    #[test]
    fn a_refusal_carries_the_message_without_the_project_path() {
        let out = refused("File /work/project/secret.txt is outside the selected project root.", "/work/project");
        assert_eq!(out["isError"], json!(true));
        assert_eq!(out["content"][0]["text"], json!("File <root>/secret.txt is outside the selected project root."));
    }

    #[test]
    fn an_answer_carries_the_same_json_twice_the_way_a_client_unwraps_it() {
        let out = answered(json!({ "sessions": [] }));
        assert_eq!(out["structuredContent"], json!({ "sessions": [] }));
        assert_eq!(out["content"][0]["text"], json!("{\"sessions\":[]}"));
    }
}
