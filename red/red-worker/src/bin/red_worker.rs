//! red-worker: the root-bound workspace worker (F158, spec 129, charter D57).
//!
//!   red-worker --host <url> --host-token <token> [--port N]
//!
//! It binds a loopback port, announces it on stdout as one JSON line, and serves. The supervisor
//! writes the runtime descriptor that names it (`runtime.json`), exactly as it does for the JS
//! worker — this process does not describe itself, because the descriptor is the supervisor's
//! record of which worker is current and a worker writing its own would race a retirement.
//!
//! **What it answers and what it hands on** is `serve`'s table. The short version: the ledger and
//! the feed are the worker's, everything else is the host's and is forwarded unchanged — nineteen
//! of the thirty-two routes the JS worker serves are already answered by `red-host`, and they reach
//! it by being passed along.
//!
//! A route this port has not reached yet is forwarded too, so a half-ported worker behaves exactly
//! like the whole one. That is what makes the port safe to do a route at a time.

use std::io;
use std::sync::Arc;

use red_core::head::Head;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const USAGE: &str = "usage: red-worker --state <dir> --host <url> --host-token <token> [--port N]";
/// The ledger service's protocol, as `token-client.mjs` names it. A worker that attached over a
/// version the service does not speak would be told so by name rather than answering from a guess.
const TOKEN_PROTOCOL: u64 = 1;

struct Worker {
    /// The state directory's token ledger and lifecycle feed, ATTACHED rather than opened: the feed
    /// has one writer and one sequence (spec 103), and a worker that opened a second in-memory copy
    /// would hand two watchers two different histories. `None` when no service is running, and then
    /// the feed says so rather than answering from nothing.
    ledger: Option<red_core::service::Client>,
    /// The session host this worker belongs to, and the credential it forwards with. A client never
    /// learns this one: it presents the worker's own.
    host: String,
    host_token: String,
    /// What this worker's own clients present.
    token: String,
    url: String,
}

fn options() -> Result<(String, String, String, u16), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let named = |name: &str| {
        argv.iter().position(|value| value == name).and_then(|at| argv.get(at + 1)).map(String::from)
    };
    let state = named("--state").ok_or(USAGE)?;
    let host = named("--host").ok_or(USAGE)?;
    let host_token = named("--host-token").ok_or(USAGE)?;
    let port = named("--port").map(|value| value.parse::<u16>().map_err(|_| "--port takes a number".to_string()));
    Ok((state, host, host_token, port.transpose()?.unwrap_or(0)))
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let (state, host, host_token, port) = match options() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("red-worker: {message}");
            return std::process::ExitCode::from(2);
        }
    };
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("red-worker: cannot listen: {error}");
            return std::process::ExitCode::from(1);
        }
    };
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(0);
    let ledger = match red_core::service::Client::attaching(
        std::path::Path::new(&state),
        "token",
        TOKEN_PROTOCOL,
        Box::new(|_event: &serde_json::Value| {}),
    ) {
        Ok(client) => client,
        Err(message) => {
            eprintln!("red-worker: {message} The feed and the token will say so rather than answer.");
            None
        }
    };
    let worker = Arc::new(Worker {
        ledger,
        host,
        host_token,
        token: red_core::service::secret(),
        url: format!("http://127.0.0.1:{port}"),
    });
    /* One line, then serve: the supervisor reads this to learn where the worker is before it writes
       the descriptor that names it. */
    println!(
        "{}",
        serde_json::json!({ "started": true, "url": worker.url, "token": worker.token, "pid": std::process::id() })
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();

    loop {
        let Ok((client, _)) = listener.accept().await else { continue };
        let worker = worker.clone();
        tokio::spawn(async move {
            let _ = connection(worker, client).await;
        });
    }
}

/// One client, for as long as it keeps the connection.
async fn connection(worker: Arc<Worker>, mut client: TcpStream) -> io::Result<()> {
    let mut buffered = Vec::new();
    loop {
        let Some(head) = Head::read(&mut client, &mut buffered).await? else { return Ok(()) };
        /* Loopback and a token, the same two questions every service here asks. A socket carries its
           token in the query string because an upgrade cannot carry a header. */
        if !authorized(&worker, &head) {
            client.write_all(refusal(401, "Unauthorized", "This workspace worker's token is required.").as_bytes()).await?;
            return Ok(());
        }
        if !red_worker::serve::known(&head) {
            client.write_all(refusal(404, "Not Found", "Unknown workspace endpoint.").as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }
        if head.path() == "/health" && head.method == "GET" {
            let body = serde_json::json!({ "ok": true, "protocol": "worker/1" }).to_string();
            client.write_all(json(200, "OK", &body).as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }
        if red_worker::serve::implemented(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            let answer = answer_own(&worker, &head, &body);
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }

        /* Everything else is the host's. The head is replayed with this worker's credential swapped
           for the host's — a client never learns the host's — and the body is forwarded by its own
           framing. */
        let (address, _) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
        let mut upstream = TcpStream::connect(&address).await?;
        upstream.write_all(head.replayed(&worker.host, &worker.host_token).as_bytes()).await?;
        head.forward_body(&mut client, &mut buffered, &mut upstream).await?;
        let mut answer = Vec::new();
        upstream.read_to_end(&mut answer).await?;
        client.write_all(&answer).await?;
        return Ok(());
    }
}

/// The routes this worker answers itself.
fn answer_own(worker: &Worker, head: &Head, body: &str) -> String {
    match (head.method.as_str(), head.path().as_str()) {
        ("GET", "/api/feed") => {
            let Some(root) = head.query("rootId").filter(|value| !value.is_empty()) else {
                return refusal(400, "Bad Request", "A project root is required to read its feed.");
            };
            let Some(ledger) = &worker.ledger else {
                return refusal(409, "Conflict", "This workspace worker does not serve the project token ledger.");
            };
            let cursor = red_worker::feed::cursor_of(head.query("after").as_deref());
            answered(ledger.call("feedAfter", serde_json::json!([root, cursor, serde_json::Value::Null])))
        }
        ("GET", "/api/token") => {
            let Some(root) = head.query("rootId").filter(|value| !value.is_empty()) else {
                return refusal(400, "Bad Request", "A project root is required to read its token.");
            };
            let Some(client) = &worker.ledger else {
                return refusal(409, "Conflict", "This workspace worker does not serve the project token ledger.");
            };
            /* The caller's own view of the token: who holds it, and whether THIS caller does. A
               status read without an identity is still an answer — a person's desktop reads it. */
            let who = identity_of(head);
            answered(client.call("callerStatus", serde_json::json!([root, who])))
        }
        ("POST", "/api/token-action") => {
            let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
            let root = data.get("rootId").and_then(serde_json::Value::as_str);
            let who = identity_of(head);
            /* The desktop a RETIRED worker forwards for one of its retained desktops, honoured only
               in the absence of an agent: the person at a desktop is never gated, whichever worker
               carries the frame, and an agent claiming to be one would be claiming its way past the
               arbitration (spec 095, Retirement). */
            let desk = who.is_none().then(|| red_worker::identity::desktop(|name| head.header(name))).flatten();
            let action = data.get("action").and_then(serde_json::Value::as_str);
            if let Some((status, message)) =
                red_worker::serve::token_refusal(worker.ledger.is_some(), root, who.as_ref(), desk.as_deref(), action)
            {
                return refusal(status, "Error", message);
            }
            let (client, root, action) = (worker.ledger.as_ref().expect("a ledger"), root.expect("a root"), action.expect("an action"));
            let acted = match &desk {
                Some(desk) => client.call("desktop", serde_json::json!([root, action, {
                    "contestId": data.get("contestId"), "desktopId": desk,
                    "reason": data.get("reason"), "agentId": data.get("agentId"),
                }])),
                None => client.call(
                    action,
                    serde_json::json!([root, who, data.get("reason").and_then(serde_json::Value::as_str).unwrap_or("")]),
                ),
            };
            match acted {
                Ok(result) => match client.call("callerStatus", serde_json::json!([root, who])) {
                    /* `{ ...result, status }`: the action's answer and the view it leaves behind, in
                       one reply, so a caller does not read a status from before its own act. */
                    Ok(status) => {
                        let mut out = result.as_object().cloned().unwrap_or_default();
                        out.insert("status".to_string(), status);
                        json(200, "OK", &serde_json::Value::Object(out).to_string())
                    }
                    Err(fault) => faulted(&fault),
                },
                Err(fault) => faulted(&fault),
            }
        }
        _ => refusal(404, "Not Found", "Unknown workspace endpoint."),
    }
}

/// Who this request says it is, for a route that records a name.
fn identity_of(head: &Head) -> Option<serde_json::Value> {
    red_worker::identity::agent(|name| head.header(name))
}

/// A service's answer, or its refusal with the status it chose.
fn answered(result: Result<serde_json::Value, String>) -> String {
    match result {
        Ok(value) => json(200, "OK", &value.to_string()),
        Err(fault) => faulted(&fault),
    }
}

/// A refusal that arrived as `status|message`, which is how every service here answers one.
fn faulted(fault: &str) -> String {
    match fault.split_once('|') {
        Some((status, message)) => refusal(status.parse().unwrap_or(500), "Error", message),
        None => refusal(500, "Error", fault),
    }
}

fn authorized(worker: &Worker, head: &Head) -> bool {
    let presented = head
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
        .or_else(|| head.query("token"));
    presented.is_some_and(|value| red_core::service::same_secret(&value, &worker.token))
}

fn json(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn refusal(status: u16, reason: &str, message: &str) -> String {
    json(status, reason, &serde_json::json!({ "error": message }).to_string())
}
