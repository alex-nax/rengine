//! red-host: the workspace's front door (F188/F152a, spec 129, KI-101).
//!
//!   red-host --state <dir> --backend <url> --backend-token <token> [--port N]
//!
//! `server/main.mjs` is a **dispatcher**: 33 `/api/*` routes and two sockets, and most of those
//! routes still delegate to JS modules F153–F156 have not moved. A Rust host that owned the port
//! and answered nothing else would have to reach back into JavaScript for most of a workspace.
//!
//! So this is the shape the workspace already runs one layer up, where the root-bound worker fronts
//! the session host and forwards `/api/*` to it: **red-host owns the port, answers what it owns,
//! and forwards the rest to a JS backend beside it.** Each later row moves routes from the backend
//! into this process until the forwarder has nothing left to forward and the JS host is deleted.
//!
//! What it owns today is the door and the **store routes** — `tree`, `file`, `save`, `draft`,
//! `discard`, `layout`, `preferences` and `roots` — answered from the state directory's own store
//! service (charter D61), which is the same store the JS backend is attached to. One owner; this
//! process and that one are two readers of it, not two copies of it. Everything else is forwarded
//! **verbatim** — including the `/events` and `/surface`
//! upgrades, which are spliced byte for byte after their handshake rather than re-framed, because a
//! proxy that re-frames a protocol is a proxy that can corrupt it.
//!
//! Authentication is per REQUEST, not per connection: a keep-alive connection carries many, and a
//! front door that checked only the first would be a door that stopped checking.

use std::io;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

mod desktops;
mod events;
mod head;

use desktops::Desktops;
use events::Hub;
use head::Head;

/// The store routes this door answers itself, and the method each one is on the store service.
/// Everything about the answer is the store's: the shapes are the ones `store.mjs` wrote and
/// red-store replays byte for byte (F169), so a client cannot tell which host asked.
fn store_route(method: &str, path: &str) -> Option<&'static str> {
    Some(match (method, path) {
        ("GET", "/api/tree") => "list",
        ("GET", "/api/file") => "readText",
        ("POST", "/api/roots") => "addRoot",
        ("POST", "/api/save") => "saveText",
        ("POST", "/api/draft") => "putDraft",
        ("POST", "/api/discard") => "discardDraft",
        ("POST", "/api/layout") => "saveLayout",
        ("POST", "/api/preferences") => "preferences",
        _ => return None,
    })
}

/// The session routes this door answers itself. They are here rather than forwarded because the
/// pane's record is the service's now (charter D62): the refusals below are the JS host's, applied
/// to the same record the JS host applies them to, so the two cannot disagree about whether a pane
/// accepts input.
fn session_route(method: &str, path: &str) -> Option<&'static str> {
    Some(match (method, path) {
        ("GET", "/api/session") => "snapshot",
        ("POST", "/api/input") => "input",
        ("POST", "/api/resize") => "resize",
        ("POST", "/api/stop") => "stop",
        _ => return None,
    })
}

/// The pane as the JS host says it: the service's own fields, the host's record, and the two
/// shapes a caller reads — `waitingForView` for a handoff pane, and the scrollback on request.
///
/// Absence is meaningful here. `exitCode`, `signal` and `endedAt` are *missing* while a pane runs
/// rather than null, because the JS host leaves them undefined until it has an ending to report,
/// and a native client that asked `has exitCode` would read a null as an answer.
fn pane_snapshot(session: &serde_json::Value) -> serde_json::Value {
    let empty = serde_json::Map::new();
    let record = session.get("meta").and_then(|value| value.as_object()).unwrap_or(&empty);
    let held = |name: &str| record.get(name).filter(|value| !value.is_null()).cloned();
    let own = |name: &str| session.get(name).filter(|value| !value.is_null()).cloned();
    let kind = held("type").and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default();
    let ended = session.get("state").and_then(serde_json::Value::as_str) == Some("exited");
    let mut out = serde_json::Map::new();
    /* A field the JS host leaves undefined is a field its answer does not carry, so `None` here
       means "say nothing" rather than "say null". */
    fn put(out: &mut serde_json::Map<String, serde_json::Value>, name: &str, value: Option<serde_json::Value>) {
        if let Some(value) = value {
            out.insert(name.to_string(), value);
        }
    }
    put(&mut out, "id", own("id"));
    put(&mut out, "rootId", held("rootId"));
    put(&mut out, "type", held("type"));
    put(&mut out, "agent", held("agent"));
    put(&mut out, "title", held("title"));
    put(&mut out, "pid", own("pid"));
    put(&mut out, "state", own("state"));
    /* An ending the JS host has not seen is an ending it does not mention; one it has seen it
       mentions even when the service could not say how (`exitCode: null`). */
    if ended {
        out.insert("exitCode".to_string(), session.get("exitCode").cloned().unwrap_or(serde_json::Value::Null));
        out.insert("signal".to_string(), session.get("signal").cloned().unwrap_or(serde_json::Value::Null));
    }
    put(&mut out, "createdAt", held("createdAt"));
    if ended {
        put(&mut out, "endedAt", own("endedAt"));
    }
    put(&mut out, "cols", own("cols"));
    put(&mut out, "rows", own("rows"));
    put(&mut out, "sequence", own("sequence"));
    put(&mut out, "conversation", held("conversation"));
    put(&mut out, "task", held("task"));
    if kind == "game" {
        put(&mut out, "surface", held("surface"));
        put(&mut out, "game", held("game"));
        out.insert("args".to_string(), held("args").unwrap_or_else(|| serde_json::json!([])));
    }
    if let Some(handoff) = held("handoff") {
        out.insert("handoff".to_string(), serde_json::json!({
            "sessionId": handoff.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
            "checkpoint": handoff.get("checkpoint").cloned().unwrap_or(serde_json::Value::Null),
        }));
        out.insert("waitingForView".to_string(), serde_json::json!(!held("released").and_then(|value| value.as_bool()).unwrap_or(false)));
    }
    serde_json::Value::Object(out)
}

/// The snapshot as JSON TEXT, because its scrollback cannot travel through a Rust `String` — and
/// that is not a detail to route around. Spec 060 counts the history in JS string characters and
/// the service ships UTF-16 for exactly that reason: a chunk boundary can leave a LONE SURROGATE in
/// it, which is a legal JS string and not a legal Rust one. So `output` is written straight into the
/// answer from the UTF-16 units, every non-ASCII unit as its own `\uXXXX` escape, which `JSON.parse`
/// turns back into the same JS string with its unpaired halves intact. It goes last, where the JS
/// host puts it.
fn pane_answer(session: &serde_json::Value, with_output: bool) -> String {
    let text = pane_snapshot(session).to_string();
    if !with_output {
        return text;
    }
    let units = utf16_from_base64(session.get("output").and_then(serde_json::Value::as_str).unwrap_or_default());
    format!("{},\"output\":{}}}", &text[..text.len() - 1], json_from_utf16(&units))
}

fn json_from_utf16(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    for unit in units {
        match *unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            unit if (0x20..0x7f).contains(&unit) => out.push(unit as u8 as char),
            unit => out.push_str(&format!("\\u{unit:04x}")),
        }
    }
    out.push('"');
    out
}

/// Base64 (the wire form the service sends) back to the UTF-16 units it encodes.
fn utf16_from_base64(text: &str) -> Vec<u16> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let Some(value) = ALPHABET.iter().position(|entry| *entry == byte) else { continue };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect()
}

/// The number `pty-client.mjs` speaks: a service on another number belongs to another build, and
/// this door refuses it the way a host does rather than guessing at its answers.
const PTY_PROTOCOL: u64 = 2;
const STORE_PROTOCOL: u64 = 1;

const USAGE: &str = "usage: red-host --state <dir> --backend <url> --backend-token <token> [--port N]";

struct Front {
    /// The state directory's store, attached rather than opened: the JS backend is attached to the
    /// same one, and two in-memory owners of one set of files is stale reads and lost writes
    /// (KI-103). `None` when no service is running, and then every store route is forwarded — a
    /// door that raced the host to start one would be the second owner this prevents.
    store: Option<red_core::service::Client>,
    /// The directory's PTY service, attached for the same reason as the store (D60), and the pane
    /// RECORDS it broadcasts (D62). A door that kept its own idea of a pane would refuse input for
    /// one whose handoff gate the host serving the socket has already released.
    pty: Option<red_core::service::Client>,
    panes: Arc<Mutex<std::collections::HashMap<String, serde_json::Value>>>,
    /// Everyone watching `/events`, and the desktops among them.
    hub: Arc<Hub>,
    desktops: Desktops,
    /// The token this workspace's clients present. The backend has its own, and this process never
    /// hands a client the backend's.
    token: String,
    instance: String,
    /// The directory this door serves, said out loud in `/api/state` for the layer above (spec 101).
    state: String,
    url: String,
    backend: String,
    backend_token: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> std::process::ExitCode {
    let options = match parse(std::env::args().skip(1).collect()) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("red-host: {message}\n{USAGE}");
            return std::process::ExitCode::from(2);
        }
    };
    match serve(options).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("red-host: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

struct Options {
    state: String,
    backend: String,
    backend_token: String,
    port: u16,
}

fn parse(argv: Vec<String>) -> Result<Options, String> {
    let mut map = std::collections::HashMap::new();
    let mut rest = argv.iter();
    while let Some(flag) = rest.next() {
        let Some(name) = flag.strip_prefix("--") else { return Err(format!("{flag} is not an option")) };
        let Some(value) = rest.next() else { return Err(format!("--{name} needs a value")) };
        map.insert(name.to_string(), value.clone());
    }
    let want = |name: &str| map.get(name).cloned().ok_or_else(|| format!("--{name} is required"));
    Ok(Options {
        state: want("state")?,
        backend: want("backend")?,
        backend_token: want("backend-token")?,
        port: match map.get("port") {
            Some(value) => value.parse().map_err(|_| "--port is not a number".to_string())?,
            None => 0,
        },
    })
}

fn secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system answers randomness");
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// No early exit on the first differing byte, the way the JS host compares its token.
fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.bytes().zip(right.bytes()).fold(0u8, |seen, (a, b)| seen | (a ^ b)) == 0
}

async fn serve(options: Options) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", options.port))
        .await
        .map_err(|error| format!("loopback is unavailable: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let store = match red_core::service::Client::attach(std::path::Path::new(&options.state), "store", STORE_PROTOCOL) {
        Ok(client) => client,
        Err(message) => {
            /* A store this door cannot read is not a store it may guess at: say so and forward. */
            eprintln!("red-host: {message} Store routes will be forwarded.");
            None
        }
    };
    /* The pane records, kept current by the service rather than asked for: every line the service
       pushes about a session lands here, so the rule this door applies to the next request is the
       one the workspace is living under now. */
    let panes: Arc<Mutex<std::collections::HashMap<String, serde_json::Value>>> = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let recording = panes.clone();
    let watching = std::sync::Arc::new(Hub::new());
    let told = watching.clone();
    let pty = match red_core::service::Client::attaching(
        std::path::Path::new(&options.state),
        "pty",
        PTY_PROTOCOL,
        Box::new(move |event: &serde_json::Value| {
            match event.get("type").and_then(serde_json::Value::as_str) {
                /* A pane's bytes, forwarded as they are: the service's output event is already the
                   shape the JS host emits, down to the sequence a client counts on — and that
                   sequence is also the pane's own, so the record moves with it. A door that only
                   counted `session` events would answer `/api/state` with a pane frozen at the last
                   thing that happened TO it rather than the last thing it said. */
                Some("output") => {
                    if let Some(id) = event.get("id").and_then(serde_json::Value::as_str) {
                        if let Some(pane) = recording.lock().expect("panes lock").get_mut(id) {
                            if let Some(fields) = pane.as_object_mut() {
                                fields.insert("sequence".to_string(), event.get("sequence").cloned().unwrap_or(serde_json::Value::Null));
                            }
                        }
                    }
                    told.broadcast(&event.to_string());
                }
                Some("session") => {
                    let Some(session) = event.get("session") else { return };
                    let Some(id) = session.get("id").and_then(serde_json::Value::as_str) else { return };
                    recording.lock().expect("panes lock").insert(id.to_string(), session.clone());
                    told.pane(session);
                }
                _ => {}
            }
        }),
    ) {
        Ok(client) => client,
        Err(message) => {
            eprintln!("red-host: {message} Session routes will be forwarded.");
            None
        }
    };
    if let Some(client) = pty.as_ref() {
        /* What the service is already holding, before the first request: a pane whose host was
           replaced is one this door can answer for immediately, not one refresh later. */
        if let Some(sessions) = client.greeting.get("sessions").and_then(serde_json::Value::as_array) {
            let mut held = panes.lock().expect("panes lock");
            for session in sessions {
                if let Some(id) = session.get("id").and_then(serde_json::Value::as_str) {
                    held.insert(id.to_string(), session.clone());
                }
            }
        }
    }
    let hub = watching;
    let front = Arc::new(Front {
        store,
        pty,
        panes,
        hub: hub.clone(),
        desktops: Desktops::new(),
        token: secret(),
        instance: uuid_v4(),
        state: options.state.clone(),
        url: format!("http://127.0.0.1:{port}"),
        backend: options.backend.clone(),
        backend_token: options.backend_token.clone(),
    });
    /* The descriptor every consumer reads, written the way the JS host writes it: tmp then rename,
       0600, and the token this door checks rather than the backend's. */
    let descriptor = std::path::Path::new(&options.state).join("sidecar.json");
    let document = serde_json::json!({
        "url": front.url, "token": front.token, "instance": front.instance, "pid": std::process::id(),
    });
    let temporary = descriptor.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temporary, document.to_string()).map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).ok();
    }
    std::fs::rename(&temporary, &descriptor).map_err(|error| format!("cannot publish {}: {error}", descriptor.display()))?;
    println!("{}", serde_json::json!({ "role": "host", "url": front.url, "instance": front.instance, "pid": std::process::id() }));
    use std::io::Write;
    let _ = std::io::stdout().flush();

    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let front = front.clone();
        tokio::spawn(async move {
            let _ = connection(front, stream).await;
        });
    }
}

/// One client connection: every request on it is read, checked and either answered here or
/// forwarded. An upgrade ends the loop by splicing the two sockets together.
async fn connection(front: Arc<Front>, mut client: TcpStream) -> io::Result<()> {
    let mut buffered: Vec<u8> = Vec::new();
    loop {
        let Some(head) = Head::read(&mut client, &mut buffered).await? else { return Ok(()) };
        if let Some(answer) = refuse(&front, &head) {
            client.write_all(answer.as_bytes()).await?;
            return Ok(());
        }
        if head.path() == "/health" && head.method == "GET" {
            let body = serde_json::json!({ "protocol": 1, "instance": front.instance }).to_string();
            let answer = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        /* The store routes, answered here from the directory's own store (D61). A route this door
           owns is never forwarded, so the backend's copy of the state is not consulted and cannot
           disagree. */
        if let Some(method) = store_route(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            let answer = answer_from_store(&front, method, &head, &body);
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        /* The session routes, answered from the same pane records the JS host reads (D62). */
        if let Some(method) = session_route(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            let answer = answer_about_pane(&front, method, &head, &body).await;
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        if head.path() == "/api/state" && head.method == "GET" {
            let answer = answer_state(&front);
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        /* The desktops attached to this workspace, which are the clients of the socket below: the
           registry lives with whoever serves `/events`, because that is where a desktop says it
           exists. */
        if head.path() == "/api/desktops" && head.method == "GET" {
            let root = head.query("rootId").unwrap_or_default();
            let answer = match ask(&front, "root", serde_json::json!([root])).await {
                Ok(_) => http_json(200, "OK", &serde_json::json!({ "desktops": front.desktops.list(&root) })),
                Err(fault) => faulted(&fault),
            };
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        if head.path() == "/api/desktop-action" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = answer_desktop_action(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            continue;
        }
        /* The socket this door serves itself. `/surface` is still the backend's — it carries a
           game's frames, and games have not moved. */
        if head.upgrade && head.path() == "/events" {
            let key = head.header("sec-websocket-key").unwrap_or_default();
            client.write_all(events::accepted(&key).as_bytes()).await?;
            let stream = events::Prefixed { buffered: std::mem::take(&mut buffered), inner: client };
            events::serve(front, stream).await;
            return Ok(());
        }
        /* Everything else is the backend's, for now. The head is replayed with this door's token
           swapped for the backend's — a client never learns the backend's credential — and the body
           is forwarded by its own framing. */
        let (backend_host, _) = red_core::http::address(&front.backend).map_err(io::Error::other)?;
        let mut upstream = TcpStream::connect(&backend_host).await?;
        upstream.write_all(head.replayed(&front).as_bytes()).await?;
        if head.upgrade {
            /* After an upgrade there is no HTTP left to understand: copy bytes both ways until one
               side goes away. Whatever the protocol is, it arrives as it was sent. */
            if !buffered.is_empty() {
                upstream.write_all(&buffered).await?;
                buffered.clear();
            }
            let (mut client_read, mut client_write) = client.into_split();
            let (mut upstream_read, mut upstream_write) = upstream.into_split();
            let up = tokio::spawn(async move { tokio::io::copy(&mut client_read, &mut upstream_write).await });
            let down = tokio::spawn(async move { tokio::io::copy(&mut upstream_read, &mut client_write).await });
            let _ = tokio::try_join!(up, down);
            return Ok(());
        }
        head.forward_body(&mut client, &mut buffered, &mut upstream).await?;
        /* And the answer, framed as the backend framed it. */
        let mut upstream_buffered: Vec<u8> = Vec::new();
        let Some(answer) = Head::read(&mut upstream, &mut upstream_buffered).await? else { return Ok(()) };
        client.write_all(answer.raw.as_bytes()).await?;
        answer.forward_body(&mut upstream, &mut upstream_buffered, &mut client).await?;
        if answer.closes() {
            return Ok(());
        }
    }
}

/// The two rules the door keeps: this workspace's own origin, and this workspace's own token —
/// checked on every request, in the JS host's own words and statuses.
fn refuse(front: &Front, head: &Head) -> Option<String> {
    let refusal = |status: u16, reason: &str, message: &str| {
        let body = serde_json::json!({ "error": message }).to_string();
        Some(format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ))
    };
    if let Some(origin) = head.header("origin") {
        if origin != front.url {
            return refusal(403, "Forbidden", "Origin is not this workspace.");
        }
    }
    if head.path() == "/health" {
        return None;
    }
    if head.upgrade {
        /* A socket carries its token in the query string, because a browser cannot set a header on
           an upgrade — the JS host reads it from exactly there. */
        let ok = head.query("token").is_some_and(|value| same_secret(&value, &front.token));
        let known = matches!(head.path().as_str(), "/events" | "/surface");
        return if ok && known { None } else { Some("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n".to_string()) };
    }
    if head.path().starts_with("/api/") {
        let presented = head.header("authorization").map(|value| value.trim_start_matches("Bearer ").to_string());
        if !presented.is_some_and(|value| same_secret(&value, &front.token)) {
            return refusal(401, "Unauthorized", "Workspace authentication required.");
        }
        return None;
    }
    refusal(404, "Not Found", "Unknown workspace endpoint.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn front() -> Front {
        Front {
            store: None, pty: None, panes: Arc::new(Mutex::new(std::collections::HashMap::new())),
            hub: Arc::new(Hub::new()), desktops: Desktops::new(),
            token: "a".repeat(64), instance: "i".into(), state: "/tmp/x".into(), url: "http://127.0.0.1:1".into(),
            backend: "http://127.0.0.1:2".into(), backend_token: "b".repeat(64),
        }
    }

    fn head(raw: &str) -> Head {
        Head::parse(raw).expect("a request")
    }

    #[test]
    fn a_route_this_door_does_not_own_is_forwarded() {
        assert_eq!(store_route("GET", "/api/tree"), Some("list"));
        assert_eq!(store_route("POST", "/api/save"), Some("saveText"));
        /* The method is half the route: the store has no `list` to run for a POST, and a door that
           matched on the path alone would send one there. */
        assert_eq!(store_route("POST", "/api/tree"), None);
        assert_eq!(store_route("GET", "/api/save"), None);
        /* Everything F153–F156 has not moved still belongs to the backend. */
        assert_eq!(store_route("GET", "/api/dashboard"), None);
        assert_eq!(store_route("POST", "/api/terminal"), None);
    }

    #[test]
    fn a_request_without_this_workspaces_token_is_refused_in_its_own_words() {
        let answer = refuse(&front(), &head("GET /api/state HTTP/1.1\r\nHost: x\r\n\r\n")).expect("refused");
        assert!(answer.starts_with("HTTP/1.1 401"), "{answer}");
        assert!(answer.contains("Workspace authentication required."), "{answer}");
    }

    #[test]
    fn the_token_is_checked_on_every_request_not_only_the_first() {
        let with = format!("GET /api/state HTTP/1.1\r\nAuthorization: Bearer {}\r\n\r\n", "a".repeat(64));
        assert!(refuse(&front(), &head(&with)).is_none(), "the right token passes");
        assert!(refuse(&front(), &head("GET /api/state HTTP/1.1\r\n\r\n")).is_some(),
                "and the next request on the same connection is checked again");
    }

    #[test]
    fn another_origin_is_refused_before_anything_else() {
        let raw = "GET /health HTTP/1.1\r\nOrigin: http://example.com\r\n\r\n";
        let answer = refuse(&front(), &head(raw)).expect("refused");
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
        assert!(answer.contains("Origin is not this workspace."), "{answer}");
    }

    #[test]
    fn a_socket_carries_its_token_in_the_query_because_an_upgrade_cannot_carry_a_header() {
        let good = format!("GET /events?token={} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", "a".repeat(64));
        assert!(refuse(&front(), &head(&good)).is_none());
        let wrong = format!("GET /events?token={} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", "f".repeat(64));
        assert!(refuse(&front(), &head(&wrong)).is_some(), "a wrong token is refused");
        let elsewhere = format!("GET /nowhere?token={} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", "a".repeat(64));
        assert!(refuse(&front(), &head(&elsewhere)).is_some(), "and so is an upgrade to a path this host does not serve");
    }

    #[test]
    fn an_unknown_path_is_not_forwarded() {
        let answer = refuse(&front(), &head("GET /nowhere HTTP/1.1\r\n\r\n")).expect("refused");
        assert!(answer.starts_with("HTTP/1.1 404"), "{answer}");
    }

    #[test]
    fn the_backends_credential_never_reaches_a_client_and_the_door_uses_its_own() {
        let raw = format!("GET /api/state HTTP/1.1\r\nAuthorization: Bearer {}\r\nHost: front\r\n\r\n", "a".repeat(64));
        let replayed = head(&raw).replayed(&front());
        assert!(replayed.contains(&format!("Authorization: Bearer {}", "b".repeat(64))), "{replayed}");
        assert!(!replayed.contains(&"a".repeat(64)), "the client's token is not passed upstream: {replayed}");
    }
}

/// One store route, answered from the state directory's own store.
///
/// The arguments are the JS host's: `/api/tree` takes its root, path and hidden flag from the query
/// string, and every POST hands the store the body it was given. Nothing is reshaped on the way in
/// or out — the store's answers are the ones `store.mjs` wrote, so a client cannot tell which host
/// asked.
fn answer_from_store(front: &Front, method: &str, head: &Head, body: &str) -> String {
    let Some(client) = front.store.as_ref() else {
        return http_json(503, "Service Unavailable", &serde_json::json!({ "error": "This workspace's store is not attached." }));
    };
    let payload: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(body) {
            Ok(value) => value,
            Err(error) => return http_json(400, "Bad Request", &serde_json::json!({ "error": format!("Invalid JSON body: {error}") })),
        }
    };
    let args = match method {
        "list" => serde_json::json!([
            head.query("rootId").unwrap_or_default(),
            head.query("path").unwrap_or_default(),
            head.query("hidden").as_deref() == Some("true"),
        ]),
        "readText" => serde_json::json!([head.query("rootId").unwrap_or_default(), head.query("path").unwrap_or_default()]),
        "addRoot" => serde_json::json!([
            payload.get("path").cloned().unwrap_or(serde_json::Value::Null),
            payload.get("declarationFile").cloned().unwrap_or(serde_json::Value::Null),
        ]),
        "discardDraft" => serde_json::json!([
            payload.get("rootId").cloned().unwrap_or(serde_json::Value::Null),
            payload.get("path").cloned().unwrap_or(serde_json::Value::Null),
        ]),
        "saveLayout" => serde_json::json!([payload.get("layout").cloned().unwrap_or(serde_json::Value::Null)]),
        _ => serde_json::json!([payload]),
    };
    match client.call(method, args) {
        Ok(result) => {
            /* Two routes answer `{ok: true}` rather than what the store returned, because that is
               what the JS host answers and a caller checks. */
            let value = match method {
                "discardDraft" | "saveLayout" => serde_json::json!({ "ok": true }),
                _ => result,
            };
            http_json(200, "OK", &value)
        }
        Err(fault) => {
            /* The store's refusals carry their own status, and a client acts on it: 404 for a root
               that is not there, 409 for a save against a version that moved. */
            let (status, message) = fault.split_once('|').unwrap_or(("500", fault.as_str()));
            let code: u16 = status.parse().unwrap_or(500);
            http_json(code, reason(code), &serde_json::json!({ "error": message }))
        }
    }
}

/// `/api/input` and `/api/resize`, in the JS host's own order of refusals — the order matters,
/// because `input` names an unknown session before it judges the data and `resize` judges the
/// dimensions before it looks the session up, and a caller sees a different status if they swap.
async fn answer_about_pane(front: &Arc<Front>, method: &str, head: &Head, body: &str) -> String {
    let refusal = |status: u16, message: &str| http_json(status, reason(status), &serde_json::json!({ "error": message }));
    if front.pty.is_none() {
        return refusal(503, "This workspace's sessions are not attached.");
    }
    /* The two routes that ASK rather than decide. The record cache answers the refusals below
       because they have to be decided before anything is delivered; a snapshot is a different
       thing — its scrollback is current as of the question, and the only current copy is the
       service's. */
    if method == "snapshot" || method == "stop" {
        let id = if method == "snapshot" {
            head.query("id").unwrap_or_default()
        } else {
            match serde_json::from_str::<serde_json::Value>(body) {
                Ok(payload) => payload.get("id").and_then(|value| value.as_str()).unwrap_or_default().to_string(),
                Err(error) => return refusal(400, &format!("Invalid JSON body: {error}")),
            }
        };
        return match ask_pty(front, method, serde_json::json!([id])).await {
            /* `/api/session` carries the scrollback and `/api/stop` does not, because the JS host's
               `snapshot(id, true)` and its `stop`'s plain `snapshot(id)` differ in exactly that. */
            Ok(session) => http_text(200, "OK", &pane_answer(&session, method == "snapshot")),
            Err(fault) => faulted(&fault),
        };
    }
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return refusal(400, &format!("Invalid JSON body: {error}")),
    };
    if !payload.is_object() {
        return refusal(400, "Expected an object.");
    }
    let outcome = match method {
        "input" => deliver_input(front, &payload).await,
        _ => deliver_resize(front, &payload).await,
    };
    match outcome {
        /* Both routes answer `{ok: true}`, which is the JS host's answer and not the service's. */
        Ok(()) => http_json(200, "OK", &serde_json::json!({ "ok": true })),
        Err(fault) => faulted(&fault),
    }
}

/// `/api/state` — the route the desktop polls, and the one that names this host. Everything in it
/// is something this process now has: the store's own state (D61), the panes the service is holding
/// (D60/D62), and this door's identity.
///
/// `stateDir` and `pid` are said out loud for a worker above this host, so it can find a credential
/// and name the process a pane descends from without the process table (specs 101/102). They are
/// THIS process's now, which is the honest answer: the door is the host a client is talking to.
fn answer_state(front: &Arc<Front>) -> String {
    let store = front.store.as_ref().and_then(|client| client.state()).unwrap_or_else(|| serde_json::json!({}));
    let field = |name: &str| store.get(name).cloned();
    /* A draft's TEXT is not in this answer — it never was. The list says which files have one and
       when, and the text arrives with the file it belongs to. */
    let drafts: Vec<serde_json::Value> = field("drafts")
        .and_then(|value| value.as_object().cloned())
        .map(|held| {
            held.values()
                .map(|draft| serde_json::json!({
                    "rootId": draft.get("rootId").cloned().unwrap_or(serde_json::Value::Null),
                    "path": draft.get("path").cloned().unwrap_or(serde_json::Value::Null),
                    "updatedAt": draft.get("updatedAt").cloned().unwrap_or(serde_json::Value::Null),
                }))
                .collect()
        })
        .unwrap_or_default();
    let mut held: Vec<serde_json::Value> = front.panes.lock().expect("panes lock").values().cloned().collect();
    /* Oldest first. The JS host answers in the order it learned about its panes, which for a host
       that started them is creation order; a door that adopted them from the service has no such
       history, and the pane's own `createdAt` is the one order both can agree on. */
    held.sort_by_key(|session| {
        session.get("meta").and_then(|record| record.get("createdAt")).and_then(serde_json::Value::as_i64).unwrap_or(0)
    });
    let sessions: Vec<serde_json::Value> = held.iter().map(pane_snapshot).collect();
    http_json(200, "OK", &serde_json::json!({
        "instance": front.instance,
        "stateDir": front.state,
        "pid": std::process::id(),
        /* The same list the JS host publishes, because a client reads it to decide what it may ask
           for; a door that claimed less would turn features off in a desktop that has them. */
        "capabilities": {
            "taskConversations": 1, "handoff": 1, "desktopActions": 1, "formatRegistry": 1,
            "dashboard": 1, "projectGame": 1, "projectGameLaunch": 1, "recordings": 1,
            "projectDevices": 1, "externalDeclarations": 1, "agentConversations": 1, "tracker": 1,
        },
        "roots": field("roots").unwrap_or_else(|| serde_json::json!([])),
        "layout": field("layout").unwrap_or(serde_json::Value::Null),
        "preferences": field("preferences").unwrap_or_else(|| serde_json::json!({})),
        "conversations": field("conversations").unwrap_or_else(|| serde_json::json!({})),
        "drafts": drafts,
        "sessions": sessions,
    }))
}

/// `/api/desktop-action`: the only action the JS host takes here is a reload, and an unknown one is
/// refused by name rather than passed to a desktop that would not understand it.
async fn answer_desktop_action(front: &Arc<Front>, body: &str) -> String {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return faulted(&format!("400|Invalid JSON body: {error}")),
    };
    if payload.get("action").and_then(serde_json::Value::as_str) != Some("reload") {
        return faulted("400|Unknown desktop action.");
    }
    let root = payload.get("rootId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let desktop = payload.get("desktopId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    if let Err(fault) = ask(front, "root", serde_json::json!([root])).await {
        return faulted(&fault);
    }
    match front.desktops.act(&root, &desktop, "reload").await {
        Ok(value) => http_json(200, "OK", &value),
        Err(fault) => faulted(&fault),
    }
}

/// A service's refusal, or one of this door's own, as the HTTP answer a client acts on.
fn faulted(fault: &str) -> String {
    let (status, message) = fault.split_once('|').unwrap_or(("500", fault));
    let code: u16 = status.parse().unwrap_or(500);
    http_json(code, reason(code), &serde_json::json!({ "error": message }))
}

/// The same refusal with its status taken off, which is all a socket client is told.
pub(crate) fn plain(fault: String) -> String {
    fault.split_once('|').map(|(_, message)| message.to_string()).unwrap_or(fault)
}

/// Typing into a pane, from the route or from the socket — one set of rules, in the JS host's own
/// order: an unknown session is named before the data is judged, and a pane that is not accepting
/// input is named before either.
pub(crate) async fn deliver_input(front: &Arc<Front>, message: &serde_json::Value) -> Result<(), String> {
    let id = message.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return Err("404|Unknown session.".to_string());
    };
    if pane.get("state").and_then(serde_json::Value::as_str) != Some("running") {
        return Err("409|Session is not running.".to_string());
    }
    /* The handoff gate, which is the whole reason this record had to become the service's: a pane
       waiting for its native view refuses input, and until D62 only the host that launched it could
       know that. */
    let record = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    let gated = record("gate").is_some();
    let released = record("released").and_then(|value| value.as_bool()).unwrap_or(false);
    if gated && !released {
        return Err("409|Handoff is waiting for its native view.".to_string());
    }
    let data = message.get("data").and_then(serde_json::Value::as_str);
    if !data.is_some_and(|text| text.encode_utf16().count() <= 1024 * 1024) {
        return Err("400|Invalid terminal input.".to_string());
    }
    /* The delivery is not awaited, because the JS host does not await it either: its route answers
       `{ok: true}` the moment the refusals pass, and a failure after that reaches the pane's own
       event stream rather than this caller. */
    let _ = ask_pty(front, "input", serde_json::json!([id, data.unwrap_or_default()])).await;
    Ok(())
}

/// And resizing one. The dimensions are judged BEFORE the session is looked up, because that is the
/// order the JS host judges them in and a caller sees a different status if they swap.
pub(crate) async fn deliver_resize(front: &Arc<Front>, message: &serde_json::Value) -> Result<(), String> {
    let cols = message.get("cols").and_then(serde_json::Value::as_i64).unwrap_or(-1);
    let rows = message.get("rows").and_then(serde_json::Value::as_i64).unwrap_or(-1);
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("400|Invalid terminal dimensions.".to_string());
    }
    let id = message.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let Some(pane) = front.panes.lock().expect("panes lock").get(&id).cloned() else {
        return Err("404|Unknown session.".to_string());
    };
    /* A pane that is not running is not resized, and not refused either: the JS host returns from
       `resize` without a word, and the route still answers `{ok: true}`. */
    if pane.get("state").and_then(serde_json::Value::as_str) == Some("running") {
        let _ = ask_pty(front, "resize", serde_json::json!([id, cols, rows])).await;
    }
    Ok(())
}

/// A pane is on a person's screen: the gate it was waiting on is opened, and the record says so for
/// every host (D62). Doing nothing is the answer for a pane that has no gate, was already released,
/// or is no longer running — exactly as the JS host's `presented` does nothing in those cases.
pub(crate) async fn present(front: &Arc<Front>, id: &str) -> Result<(), String> {
    let Some(pane) = front.panes.lock().expect("panes lock").get(id).cloned() else {
        return Err("Unknown session.".to_string());
    };
    let record = |name: &str| pane.get("meta").and_then(|record| record.get(name)).filter(|value| !value.is_null()).cloned();
    let Some(gate) = record("gate").and_then(|value| value.as_str().map(str::to_string)) else { return Ok(()) };
    if record("released").and_then(|value| value.as_bool()).unwrap_or(false)
        || pane.get("state").and_then(serde_json::Value::as_str) != Some("running")
    {
        return Ok(());
    }
    /* The file first, then the record: the pane is watching for the file, and a record that said
       "released" before the gate existed would be a promise this host had not kept yet. */
    let path = std::path::PathBuf::from(&gate);
    let written = tokio::task::spawn_blocking(move || {
        std::fs::write(&path, b"")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok::<(), std::io::Error>(())
    })
    .await;
    match written {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error.to_string()),
        Err(error) => return Err(error.to_string()),
    }
    ask_pty(front, "describe", serde_json::json!([id, { "released": true }])).await.map(|_| ()).map_err(plain)
}

/// One call to the store service, off the runtime's threads. The client is blocking by design — it
/// is used by crates with no async runtime — so a door that called it inline would park a worker
/// thread for the length of a round trip.
pub(crate) async fn ask(front: &Arc<Front>, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let front = front.clone();
    let method = method.to_string();
    match tokio::task::spawn_blocking(move || {
        front.store.as_ref().map(|client| client.call(&method, args))
    })
    .await
    {
        Ok(Some(outcome)) => outcome,
        Ok(None) => Err("503|This workspace's store is not attached.".to_string()),
        Err(error) => Err(format!("500|{error}")),
    }
}

/// The same, to the PTY service.
pub(crate) async fn ask_pty(front: &Arc<Front>, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let front = front.clone();
    let method = method.to_string();
    match tokio::task::spawn_blocking(move || {
        front.pty.as_ref().map(|client| client.call(&method, args))
    })
    .await
    {
        Ok(Some(outcome)) => outcome,
        Ok(None) => Err("503|This workspace's sessions are not attached.".to_string()),
        Err(error) => Err(format!("500|{error}")),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

fn http_json(status: u16, reason: &str, value: &serde_json::Value) -> String {
    http_text(status, reason, &value.to_string())
}

fn http_text(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
