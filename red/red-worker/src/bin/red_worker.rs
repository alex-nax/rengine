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

const USAGE: &str = "usage: red-worker --host <url> --host-token <token> [--port N]";

struct Worker {
    /// The session host this worker belongs to, and the credential it forwards with. A client never
    /// learns this one: it presents the worker's own.
    host: String,
    host_token: String,
    /// What this worker's own clients present.
    token: String,
    url: String,
}

fn options() -> Result<(String, String, u16), String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let named = |name: &str| {
        argv.iter().position(|value| value == name).and_then(|at| argv.get(at + 1)).map(String::from)
    };
    let host = named("--host").ok_or(USAGE)?;
    let host_token = named("--host-token").ok_or(USAGE)?;
    let port = named("--port").map(|value| value.parse::<u16>().map_err(|_| "--port takes a number".to_string()));
    Ok((host, host_token, port.transpose()?.unwrap_or(0)))
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let (host, host_token, port) = match options() {
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
    let worker = Arc::new(Worker {
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
        /* Not yet: the feed socket and the routes land next, each with its evidence. Until one does,
           it is forwarded, which is what makes a half-ported worker behave like the whole one. */
        let _ = red_worker::serve::implemented(&head.method, &head.path());

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
