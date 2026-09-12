//! The red-store stdio service (F174, F170a, spec 129, KI-095): the workspace store as a
//! process, speaking newline-delimited JSON-RPC over stdin/stdout — the house's LSP/MCP-worker
//! shape, and the channel F175's swap and the later host slices (F151/F152/F158) build on.
//!
//!   red-store-serve <state-dir>
//!
//! One request per line: `{"id": N, "method": "addRoot", "args": [...]}`. One answer per line:
//! `{"id": N, "result": ...}` or `{"id": N, "error": {"message": ..., "status": ...|null}}`,
//! with the store's current `state` riding every answer so the client's snapshot stays current.
//! A request the store refuses comes back with the fail() message and status intact; a request
//! that is malformed comes back with a protocol error and no status. stdin closing ends the
//! process — a dead host leaves no store behind.
//!
//! Harness-only: RED_STORE_MINT_SEQUENCE / RED_STORE_NOW_SEQUENCE inject comma-separated ids
//! and stamps (exhausted sequences fall through to the real generator/clock), because the
//! corpus replay's byte parity includes what the service mints.

use std::io::{BufRead, Write};
use std::process::ExitCode;

use red_store::store::{resolve_in_root, IdShape, Store};
use serde_json::{json, Value};

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn mint_sequence() -> impl FnMut() -> String {
    let mints: std::collections::VecDeque<String> = std::env::var("RED_STORE_MINT_SEQUENCE")
        .unwrap_or_default()
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    let mints = std::cell::RefCell::new(mints);
    move || mints.borrow_mut().pop_front().unwrap_or_else(uuid_v4)
}

/// The harness clock: RED_STORE_NOW_SEQUENCE is the stamp list, answered by REQUEST index —
/// sequence[min(requests answered, len-1)] — because the recorded run's Date.now was pinned to
/// the op count, not to how often a single op asked for the time. The main loop owns the count
/// (`tick` after each request); the closure only reads.
fn clock(tick: std::rc::Rc<std::cell::Cell<usize>>) -> impl FnMut() -> i64 {
    let stamps: Vec<i64> = std::env::var("RED_STORE_NOW_SEQUENCE")
        .unwrap_or_default()
        .split(',')
        .filter_map(|part| part.parse::<i64>().ok())
        .collect();
    move || {
        if stamps.is_empty() {
            now_millis()
        } else {
            stamps[tick.get().min(stamps.len() - 1)]
        }
    }
}

/// The conversation id-shape a recipe declares, from its parser name in the registry document
/// (the shape families the store knows; arbitrary regexes are F170's recorded boundary).
fn registry_text() -> Option<String> {
    if let Ok(declared) = std::env::var("RENGINE_AGENT_REGISTRY") {
        return std::fs::read_to_string(declared).ok();
    }
    let exe = std::env::current_exe().ok()?;
    let path = exe
        .parent()
        .and_then(|directory| directory.ancestors().nth(3))
        .map(|root| root.join("orchestrator/agents/registry.toml"))?;
    std::fs::read_to_string(path).ok()
}

fn shape_for(agent: &str) -> IdShape {
    let parser = registry_text()
        .and_then(|text| red_agents::load_registry(&text, "registry.toml", None).ok())
        .and_then(|recipes| {
            recipes
                .iter()
                .find(|(name, _)| name == agent)
                .and_then(|(_, raw)| raw.get("conversation"))
                .and_then(|talk| talk.get("parser"))
                .and_then(red_agents::Value::string)
                .map(str::to_string)
        });
    match parser.as_deref() {
        Some("kimi-flags") => IdShape::KimiSession,
        _ => IdShape::Uuid,
    }
}

fn dispatch(store: &mut Store, method: &str, args: &Value) -> Result<Value, red_store::store::Fail> {
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    match method {
        "addRoot" => {
            let declaration = arg(1).as_str().map(str::to_string);
            store.add_root(arg(0).as_str().unwrap_or(""), declaration.as_deref())
        }
        "root" => store.root(arg(0).as_str().unwrap_or("")),
        "resolveInRoot" => {
            let (absolute, relative) = resolve_in_root(
                arg(0).as_str().unwrap_or(""),
                arg(1).as_str().unwrap_or(""),
                arg(2).as_bool().unwrap_or(false),
            )?;
            Ok(json!([absolute, relative]))
        }
        "resolve" => {
            let (absolute, relative) = store.resolve(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""), arg(2).as_bool().unwrap_or(false))?;
            Ok(json!([absolute, relative]))
        }
        "list" => store.list(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""), arg(2).as_bool().unwrap_or(false)),
        "readText" => store.read_text(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or("")),
        "getDraft" => Ok(store.get_draft(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""))),
        "putDraft" => store.put_draft(&arg(0)),
        "discardDraft" => {
            store.discard_draft(arg(0).as_str().unwrap_or(""), arg(1).as_str().unwrap_or(""))?;
            Ok(Value::Null)
        }
        "saveText" => store.save_text(&arg(0)),
        "saveLayout" => {
            store.save_layout(&arg(0))?;
            Ok(Value::Null)
        }
        "listConversations" => Ok(store.list_conversations(arg(0).as_str().unwrap_or(""))),
        "recordConversation" => {
            let input = arg(1);
            let shape = input
                .get("agent")
                .and_then(Value::as_str)
                .map(shape_for)
                .unwrap_or(IdShape::Uuid);
            store.record_conversation(arg(0).as_str().unwrap_or(""), &input, shape)
        }
        "preferences" => store.preferences(&arg(0)),
        "validateSchema" => {
            let root = if arg(2).is_null() { arg(0) } else { arg(2) };
            let at = arg(3).as_str().unwrap_or("$").to_string();
            let errors = red_store::schema::validate_schema_at(&arg(0), &arg(1), &root, &at);
            Ok(json!(errors))
        }
        _ => Err(red_store::store::Fail { message: format!("Unknown store method {method}."), status: None }),
    }
}

fn main() -> ExitCode {
    let Some(directory) = std::env::args().nth(1) else {
        eprintln!("usage: red-store-serve <state-dir>");
        return ExitCode::from(2);
    };
    let requests = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let mut store = match Store::open(std::path::Path::new(&directory)) {
        Ok(mut store) => {
            let mint = std::cell::RefCell::new(mint_sequence());
            let now = std::cell::RefCell::new(clock(requests.clone()));
            store.mint = Box::new(move || (mint.borrow_mut())());
            store.now = Box::new(move || (now.borrow_mut())());
            store.temp = Box::new(uuid_v4);
            store
        }
        Err(fail) => {
            eprintln!("red-store-serve: {}", fail.message);
            return ExitCode::from(1);
        }
    };
    let stdout = std::io::stdout();
    // The first line is the startup outcome and the initial state: the client's open() awaits
    // exactly this (or the process's exit), which is how a damaged state fails open() the way
    // the JS store's open does.
    {
        let started = json!({ "started": true, "state": store.state });
        let _ = writeln!(stdout.lock(), "{started}");
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
                let answer = json!({ "id": null, "error": { "message": format!("not JSON: {error}"), "status": null } });
                let _ = writeln!(stdout.lock(), "{answer}");
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        let mut answer = serde_json::Map::new();
        answer.insert("id".to_string(), id);
        match dispatch(&mut store, method, &args) {
            Ok(result) => {
                answer.insert("result".to_string(), result);
            }
            Err(fail) => {
                answer.insert("error".to_string(), json!({ "message": fail.message, "status": fail.status }));
            }
        }
        answer.insert("state".to_string(), store.state.clone());
        let _ = writeln!(stdout.lock(), "{}", Value::Object(answer));
        requests.set(requests.get() + 1);
    }
    ExitCode::SUCCESS
}
