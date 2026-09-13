//! The red-pty service (F176 stdio core, F177 retention; spec 129/131, KI-096, charter D60):
//! PTY sessions as a process, behind the newline-delimited JSON-RPC channel red-store
//! established (F174). The JS host talks to it through orchestrator/server/pty-client.mjs.
//!
//!   red-pty-serve                  the stdio service: one client, dies with its parent
//!   red-pty-serve --state DIR      the per-state-directory service: PTYs outlive the host
//!
//! In `--state` mode the sessions belong to the state directory rather than to whichever host
//! is running (D60), so replacing the host leaves the agent CLIs inside them alive. The service
//! listens on loopback, writes `pty.json` — `{url, token, instance, pid, protocol}`, 0600,
//! through tmp+rename — and a starting host finds it, attaches with the token, and rebuilds its
//! view from `list` and snapshots. That is the same discipline `sidecar.json` and
//! `discoverSidecar` already use for the session host, for the same reasons.
//!
//! One request per line: `{"id": N, "method": "spawn", "args": [...]}`. One answer per line
//! with `result` or `error`, and unsolicited event lines for output chunks and session exits —
//! `{ "type": "output", ... }` / `{ "type": "session", ... }`, the JS host's own two shapes.
//! Events reach every attached client, because during a replacement two hosts briefly overlap
//! and each rebuilds from the scrollback anyway. The scrollback rides every snapshot as base64
//! UTF-16LE, because a JS string holds even a lone surrogate at the slice boundary and plain
//! JSON text cannot. In stdio mode, stdin closing ends the process; in `--state` mode the
//! service exits when it holds no sessions and no client has been attached for
//! RED_PTY_IDLE_SECONDS (default 600) — a service holding sessions never reaps itself, however
//! long nobody is listening, which is the whole point of it. Harness mint injection follows
//! RED_STORE_MINT_SEQUENCE's precedent (RED_PTY_MINT_SEQUENCE).

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use red_pty::{Fail, PtyHost};
use serde_json::{json, Value};

/// The wire this service speaks. A host that needs another number is told both, and the client
/// ends this service rather than adopting it — spec 131.
const PROTOCOL: u64 = 1;

type Host = PtyHost<Box<dyn FnMut(Value) + Send>>;
type Mint = Box<dyn FnMut() -> String + Send>;

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn mint_sequence() -> Mint {
    let mut mints: std::collections::VecDeque<String> = std::env::var("RED_PTY_MINT_SEQUENCE")
        .unwrap_or_default()
        .split(',')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    Box::new(move || mints.pop_front().unwrap_or_else(uuid_v4))
}

fn fail_out(id: &Value, message: impl std::fmt::Display) -> Value {
    json!({ "id": id, "error": { "message": message.to_string(), "status": null } })
}

/// One request, one answer. Both transports run every method through this, so the socket cannot
/// drift from the stdio service the F176 scenarios pinned.
fn answer(host: &Mutex<Host>, mint: &Mutex<Mint>, request: &Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let args = request.get("args").cloned().unwrap_or_else(|| json!([]));
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    let outcome: std::result::Result<Value, Fail> = (|| {
        let mut host = host.lock().expect("host lock");
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
                /* The caller may name the session: the JS host mints the pane's id before it
                   composes the launch (the id is in the pane's own environment), and a session
                   known by two different ids cannot be adopted by its id. */
                let named = options.get("id").and_then(Value::as_str).filter(|id| !id.is_empty());
                let id = match named {
                    Some(id) => id.to_string(),
                    None => (mint.lock().expect("mint lock"))(),
                };
                /* The caller's own record of the pane, kept as it was sent: this service has no
                   opinion about what a session means to the host that made it. */
                let meta = options.get("meta").cloned().unwrap_or(Value::Null);
                host.spawn(id, file, &argv, &env, cwd, cols, rows, meta)
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
    Value::Object(answer)
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.len() {
        0 => serve_stdio(),
        2 if arguments[0] == "--state" => serve_state(Path::new(&arguments[1])),
        _ => {
            eprintln!("usage: red-pty-serve [--state DIR]");
            ExitCode::from(2)
        }
    }
}

fn serve_stdio() -> ExitCode {
    let stdout = std::io::stdout();
    let out = Arc::new(Mutex::new(stdout));
    let writer = out.clone();
    let host: Arc<Mutex<Host>> = Arc::new(Mutex::new(PtyHost::new(Box::new(move |event: Value| {
        let _ = writeln!(writer.lock().expect("stdout lock"), "{event}");
    }))));
    let mint = Mutex::new(mint_sequence());
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
        let answer = answer(&host, &mint, &request);
        let _ = writeln!(out.lock().expect("stdout lock"), "{answer}");
    }
    ExitCode::SUCCESS
}

/* ---- the per-state-directory service (D60) --------------------------------------------------- */

/* The descriptor, the attach handshake, the client list and the idle reaper are
   `red_core::service` — the store needs the same machinery under D61, and two copies of it would
   be two chances to drift. What stays here is what is actually about PTYs: the dispatch, and
   "holding" meaning a session exists. */

struct Sessions {
    host: Arc<Mutex<Host>>,
    mint: Mutex<Mint>,
}

impl red_core::service::Served for Sessions {
    fn answer(&self, request: &Value) -> Value {
        answer(&self.host, &self.mint, request)
    }

    /// A service holding a session never reaps itself, however long nobody is listening: that is
    /// the whole point of it.
    fn holding(&self) -> bool {
        !self.host.lock().expect("host lock").list().is_empty()
    }

    /// What a host is given the moment it attaches: everything this service is already holding,
    /// which is how a replaced host learns what it inherited.
    fn greeting(&self) -> Value {
        json!({ "sessions": self.host.lock().expect("host lock").list() })
    }
}

fn serve_state(directory: &Path) -> ExitCode {
    let idle = Duration::from_secs(
        std::env::var("RED_PTY_IDLE_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(600),
    );
    /* The emit closure needs the client list, and the host needs the emit closure, so the service
       hands the emitter back once it exists and the host is built around it. */
    let shared: Arc<Mutex<Option<red_core::service::Emitter>>> = Arc::new(Mutex::new(None));
    let for_host = shared.clone();
    let host: Arc<Mutex<Host>> = Arc::new(Mutex::new(PtyHost::new(Box::new(move |event: Value| {
        if let Some(emitter) = for_host.lock().expect("emitter lock").as_ref() {
            emitter.say(&event);
        }
    }))));
    let sessions = Sessions { host, mint: Mutex::new(mint_sequence()) };
    match red_core::service::serve(directory, "pty", PROTOCOL, idle, sessions, |emitter| {
        *shared.lock().expect("emitter lock") = Some(emitter);
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("red-pty-serve: {message}");
            ExitCode::from(3)
        }
    }
}
