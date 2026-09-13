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

mod head;

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

const USAGE: &str = "usage: red-host --state <dir> --backend <url> --backend-token <token> [--port N]";

struct Front {
    /// The state directory's store, attached rather than opened: the JS backend is attached to the
    /// same one, and two in-memory owners of one set of files is stale reads and lost writes
    /// (KI-103). `None` when no service is running, and then every store route is forwarded — a
    /// door that raced the host to start one would be the second owner this prevents.
    store: Mutex<Option<red_core::service::Client>>,
    /// The token this workspace's clients present. The backend has its own, and this process never
    /// hands a client the backend's.
    token: String,
    instance: String,
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
    let store = match red_core::service::Client::attach(std::path::Path::new(&options.state), "store", 1) {
        Ok(client) => client,
        Err(message) => {
            /* A store this door cannot read is not a store it may guess at: say so and forward. */
            eprintln!("red-host: {message} Store routes will be forwarded.");
            None
        }
    };
    let front = Arc::new(Front {
        store: Mutex::new(store),
        token: secret(),
        instance: uuid_v4(),
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
            store: Mutex::new(None),
            token: "a".repeat(64), instance: "i".into(), url: "http://127.0.0.1:1".into(),
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
    let mut guard = front.store.lock().expect("store lock");
    let Some(client) = guard.as_mut() else {
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
    let body = value.to_string();
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
