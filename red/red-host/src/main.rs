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
//! What it owns today is the door itself: the loopback bind, the origin rule, the bearer check and
//! `/health`. Everything else is forwarded **verbatim** — including the `/events` and `/surface`
//! upgrades, which are spliced byte for byte after their handshake rather than re-framed, because a
//! proxy that re-frames a protocol is a proxy that can corrupt it.
//!
//! Authentication is per REQUEST, not per connection: a keep-alive connection carries many, and a
//! front door that checked only the first would be a door that stopped checking.

use std::io;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

mod head;

use head::Head;

const USAGE: &str = "usage: red-host --state <dir> --backend <url> --backend-token <token> [--port N]";

struct Front {
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
    let front = Arc::new(Front {
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
            token: "a".repeat(64), instance: "i".into(), url: "http://127.0.0.1:1".into(),
            backend: "http://127.0.0.1:2".into(), backend_token: "b".repeat(64),
        }
    }

    fn head(raw: &str) -> Head {
        Head::parse(raw).expect("a request")
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
