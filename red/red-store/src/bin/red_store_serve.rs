//! The red-store stdio service (F174, F170a, spec 129, KI-095): the workspace store as a
//! process, speaking newline-delimited JSON-RPC over stdin/stdout — the house's LSP/MCP-worker
//! shape, and the channel F175's swap and the later host slices (F151/F152/F158) build on.
//!
//!   red-store-serve <state-dir>            the stdio service: one client, dies with its parent
//!   red-store-serve --state <state-dir>     the per-state-directory service (charter D61)
//!
//! In `--state` mode the store belongs to the directory rather than to whichever host is running,
//! because moving a route into red-host moves the state it owns and two hosts cannot own one store
//! (KI-103). The machinery — descriptor, attach handshake, idle reaper — is `red_core::service`,
//! the same one red-pty runs under D60; what is here is the dispatch and the fact that a store
//! holds nothing that must outlive an idle moment: its state is on disk, so a reaped service costs
//! the next attach a file read.
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

use red_store::store::{resolve_in_root, Store};
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
    let mints = std::sync::Mutex::new(mints);
    move || mints.lock().expect("mint lock").pop_front().unwrap_or_else(uuid_v4)
}

/// The harness clock: RED_STORE_NOW_SEQUENCE is the stamp list, answered by REQUEST index —
/// sequence[min(requests answered, len-1)] — because the recorded run's Date.now was pinned to
/// the op count, not to how often a single op asked for the time. The main loop owns the count
/// (`tick` after each request); the closure only reads.
fn clock(tick: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> impl FnMut() -> i64 {
    let stamps: Vec<i64> = std::env::var("RED_STORE_NOW_SEQUENCE")
        .unwrap_or_default()
        .split(',')
        .filter_map(|part| part.parse::<i64>().ok())
        .collect();
    move || {
        if stamps.is_empty() {
            now_millis()
        } else {
            stamps[tick.load(std::sync::atomic::Ordering::Relaxed).min(stamps.len() - 1)]
        }
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
            let shape = input.get("agent").and_then(Value::as_str).and_then(red_store::recipes::shape_for);
            store.record_conversation(arg(0).as_str().unwrap_or(""), &input, shape.as_deref())
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

/// The store as a service of its state directory (D61).
struct Shared {
    store: std::sync::Mutex<Store>,
    /* Every attached host is told when the state changes. One owner is only half of the answer:
       a client keeps a snapshot (`root()` is a lookup in it, not a call), so a root added through
       one host has to reach the other or the second host answers "Unknown project root." for
       something that exists. The stdio service never needed this — it had one client. */
    listeners: std::sync::Arc<std::sync::Mutex<Option<red_core::service::Emitter>>>,
}

impl red_core::service::Served for Shared {
    fn answer(&self, request: &Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
        let mut store = self.store.lock().expect("store lock");
        let before = store.state.clone();
        let mut answer = serde_json::Map::new();
        answer.insert("id".to_string(), id);
        match dispatch(&mut store, method, &args) {
            Ok(result) => { answer.insert("result".to_string(), result); }
            Err(fail) => { answer.insert("error".to_string(), json!({ "message": fail.message, "status": fail.status })); }
        }
        /* Every answer carries the state, exactly as the stdio service does: a client's snapshot
           reads like the JS store's own. */
        answer.insert("state".to_string(), store.state.clone());
        let changed = before != store.state;
        let state = store.state.clone();
        drop(store);
        if changed {
            if let Some(emitter) = self.listeners.lock().expect("listener lock").as_ref() {
                /* An unsolicited line, so every OTHER attached host updates its snapshot too. The
                   one that asked has the same state on its own answer. */
                emitter.say(&json!({ "state": state }));
            }
        }
        Value::Object(answer)
    }

    /// The state is on disk. A reaped store costs the next attach a file read, and nothing else —
    /// which is why this service reaps where the PTY service holding a shell never does.
    fn holding(&self) -> bool {
        false
    }

    fn greeting(&self) -> Value {
        json!({ "state": self.store.lock().expect("store lock").state })
    }
}

fn serve_state(directory: &str) -> ExitCode {
    let store = match open_store(directory) {
        Ok(store) => store,
        Err(code) => return code,
    };
    let idle = std::time::Duration::from_secs(
        std::env::var("RED_STORE_IDLE_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(600),
    );
    let listeners: std::sync::Arc<std::sync::Mutex<Option<red_core::service::Emitter>>> = std::sync::Arc::new(std::sync::Mutex::new(None));
    let shared = Shared { store: std::sync::Mutex::new(store), listeners: listeners.clone() };
    match red_core::service::serve(std::path::Path::new(directory), "store", 1, idle, shared, |emitter| {
        *listeners.lock().expect("listener lock") = Some(emitter);
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("red-store-serve: {message}");
            ExitCode::from(3)
        }
    }
}

fn open_store(directory: &str) -> Result<Store, ExitCode> {
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    match Store::open(std::path::Path::new(directory)) {
        Ok(mut store) => {
            let mint = std::sync::Mutex::new(mint_sequence());
            let now = std::sync::Mutex::new(clock(requests.clone()));
            store.mint = Box::new(move || (mint.lock().expect("mint lock"))());
            store.now = Box::new(move || (now.lock().expect("clock lock"))());
            store.temp = Box::new(uuid_v4);
            Ok(store)
        }
        Err(fail) => {
            eprintln!("red-store-serve: {}", fail.message);
            Err(ExitCode::from(1))
        }
    }
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.len() == 2 && argv[0] == "--state" {
        return serve_state(&argv[1]);
    }
    let Some(directory) = argv.first().cloned() else {
        eprintln!("usage: red-store-serve <state-dir> | red-store-serve --state <state-dir>");
        return ExitCode::from(2);
    };
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut store = match Store::open(std::path::Path::new(&directory)) {
        Ok(mut store) => {
            let mint = std::sync::Mutex::new(mint_sequence());
            let now = std::sync::Mutex::new(clock(requests.clone()));
            store.mint = Box::new(move || (mint.lock().expect("mint lock"))());
            store.now = Box::new(move || (now.lock().expect("clock lock"))());
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
        requests.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    ExitCode::SUCCESS
}
