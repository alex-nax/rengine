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

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use red_pty::{Fail, PtyHost};
use serde_json::{json, Value};

/// The wire this service speaks. A host that needs another number is told both, and the client
/// ends this service rather than adopting it — spec 131.
const PROTOCOL: u64 = 1;
const DESCRIPTOR: &str = "pty.json";

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

/// 64 hex characters, the shape `discoverSidecar` already validates for the session host.
fn secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// No early exit on the first differing byte: the comparison takes the same time either way.
fn same_secret(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes().zip(right.bytes()).fold(0u8, |differences, (a, b)| differences | (a ^ b)) == 0
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
                let id = (mint.lock().expect("mint lock"))();
                host.spawn(id, file, &argv, &env, cwd, cols, rows)
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

/* The per-state-directory service. */

struct Client {
    out: Arc<Mutex<TcpStream>>,
}

/// Everything the reaper and the connections share. `idle_since` is the moment the last client
/// left (or the moment the service started, so a service nobody ever attaches to still reaps).
struct Service {
    host: Arc<Mutex<Host>>,
    mint: Mutex<Mint>,
    clients: Arc<Mutex<Vec<Client>>>,
    idle_since: Mutex<Instant>,
    token: String,
    instance: String,
    descriptor: PathBuf,
}

fn send(out: &Arc<Mutex<TcpStream>>, line: &str) -> bool {
    let mut stream = out.lock().expect("client lock");
    stream.write_all(line.as_bytes()).and_then(|_| stream.flush()).is_ok()
}

fn descriptor_of(directory: &Path) -> PathBuf {
    directory.join(DESCRIPTOR)
}

/// tmp + rename, 0600 — a reader never sees half a descriptor, and nobody else can read the
/// token out of it.
fn write_descriptor(path: &Path, document: &Value) -> std::io::Result<()> {
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("{document}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, path)
}

/// A service already serving this directory answers its own port. Asking the port rather than
/// the PID is the portable question and the more honest one: it tests the service, not a number.
fn already_serving(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let document: Value = serde_json::from_str(&text).ok()?;
    let url = document.get("url").and_then(Value::as_str)?;
    let address = url.strip_prefix("tcp://")?;
    let target: std::net::SocketAddr = address.parse().ok()?;
    TcpStream::connect_timeout(&target, Duration::from_millis(500)).ok()?;
    Some(document)
}

fn serve_state(directory: &Path) -> ExitCode {
    if let Err(error) = std::fs::create_dir_all(directory) {
        eprintln!("red-pty-serve: {} cannot be created: {error}", directory.display());
        return ExitCode::from(1);
    }
    let descriptor = descriptor_of(directory);
    if let Some(existing) = already_serving(&descriptor) {
        eprintln!(
            "red-pty-serve: {} is already served by PID {} at {}. Nothing was started.",
            directory.display(),
            existing.get("pid").and_then(Value::as_u64).unwrap_or(0),
            existing.get("url").and_then(Value::as_str).unwrap_or("?")
        );
        return ExitCode::from(3);
    }
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("red-pty-serve: loopback is unavailable: {error}");
            return ExitCode::from(1);
        }
    };
    let port = listener.local_addr().expect("the bound address").port();
    let clients: Arc<Mutex<Vec<Client>>> = Arc::new(Mutex::new(Vec::new()));
    let broadcast = clients.clone();
    let host: Arc<Mutex<Host>> = Arc::new(Mutex::new(PtyHost::new(Box::new(move |event: Value| {
        let line = format!("{event}\n");
        broadcast.lock().expect("clients lock").retain(|client| send(&client.out, &line));
    }))));
    let service = Arc::new(Service {
        host,
        mint: Mutex::new(mint_sequence()),
        clients,
        idle_since: Mutex::new(Instant::now()),
        token: secret(),
        instance: uuid_v4(),
        descriptor: descriptor.clone(),
    });
    let document = json!({
        "url": format!("tcp://127.0.0.1:{port}"),
        "token": service.token,
        "instance": service.instance,
        "pid": std::process::id(),
        "protocol": PROTOCOL,
    });
    if let Err(error) = write_descriptor(&descriptor, &document) {
        eprintln!("red-pty-serve: {} cannot be written: {error}", descriptor.display());
        return ExitCode::from(1);
    }
    println!("red-pty serving {} at tcp://127.0.0.1:{port}", directory.display());
    let _ = std::io::stdout().flush();
    reap_when_idle(service.clone());
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let service = service.clone();
        std::thread::spawn(move || connection(service, stream));
    }
    ExitCode::SUCCESS
}

/// A service that holds nothing and that nobody is attached to removes its own descriptor and
/// goes away. A service holding sessions never does, however long it waits — that is what
/// "the sessions belong to the state directory" means.
fn reap_when_idle(service: Arc<Service>) {
    let limit = Duration::from_secs(
        std::env::var("RED_PTY_IDLE_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(600),
    );
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let attached = !service.clients.lock().expect("clients lock").is_empty();
        let holding = !service.host.lock().expect("host lock").list().is_empty();
        if attached || holding {
            continue;
        }
        if service.idle_since.lock().expect("idle lock").elapsed() < limit {
            continue;
        }
        forget_descriptor(&service);
        std::process::exit(0);
    });
}

/// Only ours. A successor's descriptor is not this process's to delete.
fn forget_descriptor(service: &Service) {
    let ours = std::fs::read_to_string(&service.descriptor)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|document| document.get("instance").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|instance| instance == service.instance);
    if ours {
        let _ = std::fs::remove_file(&service.descriptor);
    }
}

fn connection(service: Arc<Service>, stream: TcpStream) {
    let Ok(reading) = stream.try_clone() else { return };
    let out = Arc::new(Mutex::new(stream));
    let mut attached = false;
    for line in BufReader::new(reading).lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                send(&out, &format!("{}\n", fail_out(&Value::Null, format!("not JSON: {error}"))));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "attach" {
            match attach(&service, &request) {
                Ok(result) => {
                    if !attached {
                        attached = true;
                        service.clients.lock().expect("clients lock").push(Client { out: out.clone() });
                    }
                    send(&out, &format!("{}\n", json!({ "id": id, "result": result })));
                }
                Err(fail) => {
                    send(&out, &format!("{}\n", json!({ "id": id, "error": { "message": fail.message, "status": fail.status } })));
                    break;
                }
            }
            continue;
        }
        if !attached {
            let fail = Fail::new("red-pty: attach with this service's token before anything else.", 401);
            send(&out, &format!("{}\n", json!({ "id": id, "error": { "message": fail.message, "status": fail.status } })));
            continue;
        }
        let answer = answer(&service.host, &service.mint, &request);
        if !send(&out, &format!("{answer}\n")) {
            break;
        }
    }
    if attached {
        let mut clients = service.clients.lock().expect("clients lock");
        clients.retain(|client| !Arc::ptr_eq(&client.out, &out));
        if clients.is_empty() {
            *service.idle_since.lock().expect("idle lock") = Instant::now();
        }
    }
}

/// The token gates everything; the protocol number is checked too, so a host that would
/// misread this service is told rather than served.
fn attach(service: &Service, request: &Value) -> std::result::Result<Value, Fail> {
    let options = request.get("args").and_then(Value::as_array).and_then(|args| args.first()).cloned().unwrap_or(Value::Null);
    let token = options.get("token").and_then(Value::as_str).unwrap_or("");
    if !same_secret(token, &service.token) {
        return Err(Fail::new("red-pty: the attach token does not match this service.", 401));
    }
    let protocol = options.get("protocol").and_then(Value::as_u64).unwrap_or(PROTOCOL);
    if protocol != PROTOCOL {
        return Err(Fail::new(
            format!("red-pty: this service speaks protocol {PROTOCOL}; the client asked for {protocol}."),
            409,
        ));
    }
    Ok(json!({
        "started": true,
        "instance": service.instance,
        "protocol": PROTOCOL,
        "pid": std::process::id(),
        "sessions": service.host.lock().expect("host lock").list(),
    }))
}
