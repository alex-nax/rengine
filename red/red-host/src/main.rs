//! red-host: the workspace's front door (F188/F189, F152, spec 129, KI-101).
//!
//!   red-host --state <dir> --backend <url> --backend-token <token> [--port N]
//!
//! `server/main.mjs` is a **dispatcher**: 33 `/api/*` routes and two sockets, and thirteen of those
//! routes still delegate to JS modules F153–F156 have not moved. A Rust host that owned the port
//! and answered nothing else would have to reach back into JavaScript for most of a workspace.
//!
//! So this is the shape the workspace already runs one layer up, where the root-bound worker fronts
//! the session host and forwards `/api/*` to it: **red-host owns the port, answers what it owns,
//! and forwards the rest to a JS backend beside it.** Each row moves routes from the backend into
//! this process until the forwarder has nothing left to forward and the JS host is deleted.
//!
//! What it owns today is everything F152 names:
//!
//! - the **store routes** — `state`, `tree`, `file`, `save`, `draft`, `discard`, `layout`,
//!   `preferences`, `roots` — from the state directory's own store service (charter D61);
//! - the **session routes** — `session`, `input`, `resize`, `stop`, `terminal`, `agent-restart`,
//!   `agent-conversation` — from that directory's PTY service and the pane records it holds
//!   (D60/D62), with the pane composition itself red-agents' (F168) rather than restated here;
//! - the **`/events` socket** and the desktops that register on it.
//!
//! Everything else is forwarded **verbatim**, including the `/surface` upgrade, which is spliced
//! byte for byte after its handshake rather than re-framed: it carries a game's frames, games have
//! not moved, and a proxy that re-frames a protocol it does not own is a proxy that can corrupt it.
//!
//! Authentication is per REQUEST, not per connection: a keep-alive connection carries many, and a
//! front door that checked only the first would be a door that stopped checking.

use std::io;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

mod desktops;
mod events;
mod handoff;
mod head;
mod images;
mod panes;
mod routes;

use desktops::Desktops;
use events::Hub;
use head::Head;
use routes::{answer_about_pane, answer_desktop_action, answer_from_store, answer_state, faulted, http_json, session_route, store_route};

/// The number `pty-client.mjs` speaks: a service on another number belongs to another build, and
/// this door refuses it the way a host does rather than guessing at its answers.
const PTY_PROTOCOL: u64 = 2;
const STORE_PROTOCOL: u64 = 1;

const USAGE: &str = "usage: red-host --state <dir> --backend <url> --backend-token <token> [--port N] [--pid N]";

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
    /// What the descriptor says is running this workspace. A door started BY the host it fronts
    /// publishes that host's pid, because that is the process the launcher started, the one
    /// `replace.mjs` stops and the one `discoverSidecar` asks whether the workspace is alive. The
    /// pair is the workspace; the process the launcher can name is the pair's handle.
    announced_pid: u32,
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
        announced_pid: match map.get("pid") {
            Some(value) => value.parse().map_err(|_| "--pid is not a number".to_string())?,
            None => std::process::id(),
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
        "url": front.url, "token": front.token, "instance": front.instance, "pid": options.announced_pid,
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

    /* A door started by the host it fronts dies with it. The pair is the workspace: a door left
       behind would answer `/health` and every route it owns for a backend that is gone, which reads
       as a healthy workspace to everything that asks. On unix an orphan's parent becomes pid 1, and
       that is the signal. A door started on its own — by a test, or by hand — has a parent that
       outlives it and this never fires. */
    #[cfg(unix)]
    if options.announced_pid != std::process::id() {
        let parent = std::os::unix::process::parent_id();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if std::os::unix::process::parent_id() != parent {
                    eprintln!("red-host: the host this door fronts is gone; stopping with it.");
                    std::process::exit(0);
                }
            }
        });
    }

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
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* The store routes, answered here from the directory's own store (D61). A route this door
           owns is never forwarded, so the backend's copy of the state is not consulted and cannot
           disagree. */
        if let Some(method) = store_route(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            let answer = answer_from_store(&front, method, &head, &body);
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* The session routes, answered from the same pane records the JS host reads (D62). */
        if let Some(method) = session_route(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            let answer = answer_about_pane(&front, method, &head, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        if head.path() == "/api/terminal" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = panes::terminal(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        if head.path() == "/api/agent-restart" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = panes::restart(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        if head.path() == "/api/agent-conversation" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = panes::record_conversation(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* The one route whose answer is bytes rather than JSON. */
        if head.path() == "/api/image" && head.method == "GET" {
            let answer = images::image(&front, &head.query("rootId").unwrap_or_default(), &head.query("path").unwrap_or_default()).await;
            client.write_all(&answer).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        if head.path() == "/api/state" && head.method == "GET" {
            let answer = answer_state(&front);
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
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
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        if head.path() == "/api/desktop-action" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = answer_desktop_action(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
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


/// The same refusal with its status taken off, which is all a socket client is told.
pub(crate) fn plain(fault: String) -> String {
    fault.split_once('|').map(|(_, message)| message.to_string()).unwrap_or(fault)
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
