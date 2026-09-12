//! The red-pty stdio service (F176, F151a, spec 129, KI-096): PTY sessions as a process,
//! behind the same newline-delimited JSON-RPC channel the red-store service established (F174).
//! The JS host (F178's swap) talks to it through orchestrator/server/pty-client.mjs.
//!
//!   red-pty-serve
//!
//! One request per line: `{"id": N, "method": "spawn", "args": [...]}`. One answer per line
//! with `result` or `error`, and unsolicted event lines for output chunks and session exits —
//! `{ "type": "output", ... }` / `{ "type": "session", ... }`, the JS host's own two shapes.
//! The scrollback rides every snapshot as base64 UTF-16LE, because a JS string holds even a
//! lone surrogate at the slice boundary and plain JSON text cannot. stdin closing ends the
//! process; harness mint injection follows RED_STORE_MINT_SEQUENCE's precedent
//! (RED_PTY_MINT_SEQUENCE).

use std::io::{BufRead, Write};
use std::process::ExitCode;

use red_pty::{Fail, PtyHost};
use serde_json::{json, Value};

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn mint_sequence() -> impl FnMut() -> String {
    let mut mints: std::collections::VecDeque<String> = std::env::var("RED_PTY_MINT_SEQUENCE")
        .unwrap_or_default()
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    move || mints.pop_front().unwrap_or_else(uuid_v4)
}

fn fail_out(id: &Value, message: impl std::fmt::Display) -> Value {
    json!({ "id": id, "error": { "message": message.to_string(), "status": null } })
}

fn main() -> ExitCode {
    if std::env::args().len() > 1 {
        eprintln!("usage: red-pty-serve");
        return ExitCode::from(2);
    }
    let stdout = std::io::stdout();
    let out = std::sync::Arc::new(std::sync::Mutex::new(stdout));
    let writer = out.clone();
    let mut mint = mint_sequence();
    let mut host: PtyHost<Box<dyn FnMut(Value) + Send>> = PtyHost::new(Box::new(move |event: Value| {
        let _ = writeln!(writer.lock().expect("stdout lock"), "{event}");
    }));
    {
        let started = json!({ "started": true });
        let _ = writeln!(out.lock().expect("stdout lock"), "{started}");
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let _ = writeln!(out.lock().expect("stdout lock"), "{}", fail_out(&Value::Null, format!("not JSON: {error}")));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let outcome: std::result::Result<Value, Fail> = (|| {
            match method {
                "spawn" => {
                    let options = arg(0);
                    let file = options.get("command").and_then(Value::as_str).unwrap_or("");
                    let argv: Vec<String> = options
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                        .unwrap_or_default();
                    let env: std::collections::HashMap<String, String> = options
                        .get("env")
                        .and_then(Value::as_object)
                        .map(|map| map.iter().filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string()))).collect())
                        .unwrap_or_default();
                    let cwd = options.get("cwd").and_then(Value::as_str).unwrap_or("/");
                    let cols = options.get("cols").and_then(Value::as_u64).unwrap_or(100) as u16;
                    let rows = options.get("rows").and_then(Value::as_u64).unwrap_or(30) as u16;
                    host.spawn(mint(), file, &argv, &env, cwd, cols, rows)
                }
                "input" => host.input(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or("")).map(|_| Value::Null),
                "resize" => {
                    host.resize(
                        arg(0).as_str().unwrap_or(""),
                        arg(1).as_u64().unwrap_or(0) as u16,
                        arg(2).as_u64().unwrap_or(0) as u16,
                    )
                    .map(|_| Value::Null)
                }
                "stop" => host.stop(arg(0).as_str().unwrap_or("")),
                "snapshot" => host.snapshot(arg(0).as_str().unwrap_or("")),
                "list" => Ok(json!(host.list())),
                _ => Err(Fail::new(format!("Unknown pty method {method}."), 400)),
            }
        })();
        let mut answer = serde_json::Map::new();
        answer.insert("id".to_string(), id);
        match outcome {
            Ok(result) => {
                answer.insert("result".to_string(), result);
            }
            Err(fail) => {
                answer.insert("error".to_string(), json!({ "message": fail.message, "status": fail.status }));
            }
        }
        let _ = writeln!(out.lock().expect("stdout lock"), "{}", Value::Object(answer));
    }
    ExitCode::SUCCESS
}
