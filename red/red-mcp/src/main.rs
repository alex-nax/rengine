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
//! F184 serves `initialize`, `tools/list` and `ping`. `tools/call` is F185, and until it lands a
//! call is refused by name rather than answered wrongly.
//!
//! The binding is checked at startup exactly as the JS worker checks it — the context must name a
//! loopback host with a 64-hex token, the host must still be the instance the context names, and
//! the bound root must still exist — so a pane whose workspace moved is told at once instead of on
//! its first tool call.

use std::io::{BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

/// The surface, as the JS worker answered it. Captured once; regenerating it from this binary
/// would be judging the port against itself.
const DECLARATION: &str = include_str!("tools.json");

/// What the SDK on the other end knows how to speak. A client asking for one of these is answered
/// in its own version; anything else is answered in ours, which is what the JS SDK does.
const SUPPORTED: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const LATEST: &str = "2025-11-25";

struct Context {
    url: String,
    token: String,
    instance: String,
    root_id: String,
}

fn context_from(argv: &[String]) -> Result<Context, String> {
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
    Ok(Context { url, token, instance, root_id })
}

/// The same two questions the JS worker asks before it serves anything: is this still the host the
/// context was written for, and is the bound project still there.
fn check(context: &Context) -> Result<(), String> {
    let state = red_core::http::get(&context.url, &context.token, "/api/state")?;
    let instance = state.get("instance").and_then(Value::as_str).unwrap_or_default();
    if instance != context.instance {
        return Err("The original sidecar instance is no longer available. Reopen this agent from the workspace.".into());
    }
    let known = state
        .get("roots")
        .and_then(Value::as_array)
        .map(|roots| roots.iter().any(|root| root.get("id").and_then(Value::as_str) == Some(context.root_id.as_str())))
        .unwrap_or(false);
    if !known {
        return Err("The bound project is no longer available.".into());
    }
    Ok(())
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

fn answer(method: &str, params: &Value, surface: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": negotiated(params.get("protocolVersion").and_then(Value::as_str)),
            "capabilities": surface.get("capabilities").cloned().unwrap_or_else(|| json!({ "tools": {} })),
            "serverInfo": surface.get("server").cloned().unwrap_or_else(|| json!({ "name": "rengine-workspace", "version": "1.0.0" })),
            "instructions": surface.get("instructions").cloned().unwrap_or(Value::Null),
        })),
        "tools/list" => Ok(json!({ "tools": surface.get("tools").cloned().unwrap_or_else(|| json!([])) })),
        "ping" => Ok(json!({})),
        /* Named rather than answered: a tool call that returned something plausible from a server
           that cannot yet make it happen is worse than a refusal (F185 carries the calls). */
        "tools/call" => Err((-32601, "red-mcp serves the tool surface; tool calls are not implemented in this build.".into())),
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
    let context = match context_from(&argv).and_then(|context| check(&context).map(|_| context)) {
        Ok(context) => context,
        Err(message) => {
            eprintln!("red-mcp: {message}");
            return ExitCode::FAILURE;
        }
    };
    let _ = &context;
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
        let reply = match answer(method, &params, &surface) {
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
    fn a_tool_call_is_refused_by_name_rather_than_answered() {
        let (code, message) = answer("tools/call", &json!({}), &declaration()).expect_err("not implemented yet");
        assert_eq!(code, -32601);
        assert!(message.contains("not implemented"), "{message}");
    }
}
