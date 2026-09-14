//! The language-server client as a process, one per project root (F161).
//!
//!   red-lsp-serve <rootPath>
//!
//! stdio and newline-delimited JSON-RPC, the shape `red-store-serve` established — not a service of
//! a state directory, because a language server belongs to the worker that started it exactly as it
//! did in JavaScript: the worker holds one of these per root, and they die with it.
//!
//! One request per line: `{"id": N, "method": "open", "args": [...]}`. The declaration arrives once,
//! in `declare`, because a root's servers are decided by the project it is and change only when a
//! caller re-reads that project.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::Mutex;

use red_lsp::servers::Servers;
use serde_json::{json, Value};

fn main() -> ExitCode {
    let Some(root_path) = std::env::args().nth(1) else {
        eprintln!("usage: red-lsp-serve <rootPath>");
        return ExitCode::from(2);
    };
    let servers: Mutex<Servers> = Mutex::new(Servers::new(&root_path, &json!([])));
    let stdout = std::io::stdout();
    let _ = writeln!(stdout.lock(), "{}", json!({ "started": true }));
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(stdout.lock(), "{}", json!({ "id": Value::Null, "error": { "message": format!("not JSON: {error}") } }));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let string = |index: usize| args.get(index).and_then(Value::as_str).unwrap_or_default().to_string();
        let result = match method.as_str() {
            /* The declaration replaces whatever was declared before, and stops what it replaces:
               a project that changed which servers it wants must not leave the old ones running. */
            "declare" => {
                let mut held = servers.lock().expect("servers lock");
                held.stop();
                *held = Servers::new(&root_path, &arg(0));
                Value::Null
            }
            "open" => servers.lock().expect("servers lock").open(Path::new(&string(0)), &string(1)),
            "close" => {
                servers.lock().expect("servers lock").close(Path::new(&string(0)));
                Value::Null
            }
            /* What the diagnostics route answers, in one call: the version a caller polls with, the
               items for the file it asked about, and every named absence. */
            "diagnostics" => {
                let held = servers.lock().expect("servers lock");
                json!({ "version": held.version(), "items": held.items(&string(0)), "unavailable": held.unavailable() })
            }
            "version" => json!(servers.lock().expect("servers lock").version()),
            "unavailable" => json!(servers.lock().expect("servers lock").unavailable()),
            "stop" => {
                servers.lock().expect("servers lock").stop();
                Value::Null
            }
            other => {
                let _ = writeln!(stdout.lock(), "{}", json!({ "id": id, "error": { "message": format!("Unknown lsp method {other}.") } }));
                continue;
            }
        };
        let _ = writeln!(stdout.lock(), "{}", json!({ "id": id, "result": result }));
    }
    servers.lock().expect("servers lock").stop();
    ExitCode::SUCCESS
}
