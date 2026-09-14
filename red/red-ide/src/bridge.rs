//! The socket Claude Code connects to (spec 102 decisions 5, 7, 8 and 8b; spec 133).
//!
//! One WebSocket server on loopback, one MCP conversation per accepted connection. A connection
//! is accepted for presenting the lock's token in `x-claude-code-ide-authorization`, the one
//! place `claude` 2.1.263 was measured to put it, and for nothing else — not for being local. The
//! port belongs to the runtime, not to this worker: a successor whose predecessor still holds it
//! retries rather than settling for another, because another port is a session the CLI cannot get
//! back (KI-066).
//!
//! Every socket is reached through a channel, the way `red-host::events` does it, so no lock is
//! ever held across an `.await`.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message};

use crate::discovery::as_integer;
use crate::lock::{self, RETAKE_INTERVAL_MS};
use crate::mcp::{self, Reply};

/// Where `getDiagnostics` reads from: the language servers, wherever they are. `Ok(Null)` is the
/// empty list; `Err` is answered as the SDK answered a handler that threw.
pub type SourceFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type Source = Arc<dyn Fn(Value) -> SourceFuture + Send + Sync>;

/// `startIdeBridge`'s options, exactly.
pub struct Options {
    pub roots: Value,
    pub host_pid: Value,
    pub worker_pid: Value,
    pub port: u16,
    pub directory: PathBuf,
    pub host: String,
    pub retake_timeout_ms: u64,
}

struct State {
    published: bool,
    port: Option<u16>,
    lock: Option<PathBuf>,
    reason: Option<String>,
    closed: bool,
    accepting: Option<JoinHandle<()>>,
    retake: Option<JoinHandle<bool>>,
    connections: Vec<JoinHandle<()>>,
}

pub struct Bridge {
    /// Empty when nothing was published: the JavaScript's refusal carried no token at all.
    pub auth_token: String,
    options: Options,
    state: Mutex<State>,
    sockets: Mutex<HashMap<u64, UnboundedSender<Message>>>,
    observed: Mutex<Vec<Value>>,
    next: AtomicU64,
    source: Option<Source>,
    ready: watch::Sender<Option<bool>>,
}

/// A server's own sentence for a bind that failed for a reason other than the port being held.
fn listen_error(error: &std::io::Error, host: &str, port: u16) -> String {
    let (code, description) = error.raw_os_error().map(lock::errno_words).unwrap_or(("EIO", "i/o error"));
    format!("listen {code}: {description} {host}:{port}")
}

/// `Some` when bound, `None` when the port is still held — the retake case — and the OS's sentence
/// for anything else, re-thrown as the JavaScript re-threw it.
async fn listen(host: &str, port: u16) -> Result<Option<TcpListener>, String> {
    match TcpListener::bind((host, port)).await {
        Ok(listener) => Ok(Some(listener)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Ok(None),
        Err(error) => Err(listen_error(&error, host, port)),
    }
}

impl Bridge {
    fn new(options: Options, source: Option<Source>, auth_token: String, published: bool, reason: Option<String>) -> Arc<Bridge> {
        let (ready, _) = watch::channel(None);
        Arc::new(Bridge {
            auth_token,
            options,
            state: Mutex::new(State { published, port: None, lock: None, reason, closed: false, accepting: None, retake: None, connections: Vec::new() }),
            sockets: Mutex::new(HashMap::new()),
            observed: Mutex::new(Vec::new()),
            next: AtomicU64::new(0),
            source,
            ready,
        })
    }

    /// `startIdeBridge`: publish, or say why not. `Err` is what the JavaScript threw — a directory
    /// that cannot be created, a bind that failed for a reason other than the port being held.
    pub async fn start(options: Options, source: Option<Source>) -> Result<Arc<Bridge>, String> {
        /* Without the host's pid there is nothing to publish: the CLI checks that the lock's pid is
           one of its own first ten ancestors, and the host is the only process in a pane's chain
           (spec 102 D2). Nothing is created and nothing is swept. */
        if as_integer(Some(&options.host_pid)).is_none() {
            let bridge = Bridge::new(options, source, String::new(), false,
                Some("the session host process could not be identified, so no lock was written".to_string()));
            let _ = bridge.ready.send(Some(false));
            return Ok(bridge);
        }
        lock::create_directory(&options.directory)?;
        lock::sweep(&options.directory, &lock::alive);
        let auth_token = red_core::service::secret();
        let (host, wanted, timeout) = (options.host.clone(), options.port, options.retake_timeout_ms);
        let bridge = Bridge::new(options, source, auth_token, false, None);
        if let Some(listener) = listen(&host, wanted).await? {
            bridge.serve(listener)?;
            return Ok(bridge);
        }
        bridge.state.lock().expect("state").reason = Some(format!("port {wanted} is still held by the worker being replaced"));
        let retaking = bridge.clone();
        let retake = tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_millis(timeout);
            while !retaking.closed() && Instant::now() < deadline {
                /* The wait is bounded and `close` ends it. */
                tokio::time::sleep(Duration::from_millis(RETAKE_INTERVAL_MS)).await;
                if retaking.closed() {
                    break;
                }
                match listen(&host, wanted).await {
                    Ok(Some(listener)) => {
                        return match retaking.serve(listener) {
                            Ok(()) => true,
                            Err(error) => {
                                retaking.state.lock().expect("state").reason = Some(error);
                                let _ = retaking.ready.send(Some(false));
                                false
                            }
                        };
                    }
                    Ok(None) => continue,
                    Err(error) => {
                        retaking.state.lock().expect("state").reason = Some(error);
                        let _ = retaking.ready.send(Some(false));
                        return false;
                    }
                }
            }
            retaking.state.lock().expect("state").reason = Some(format!("port {wanted} was never released by the worker being replaced"));
            let _ = retaking.ready.send(Some(false));
            false
        });
        bridge.state.lock().expect("state").retake = Some(retake);
        Ok(bridge)
    }

    /// Bound: write the lock, start accepting, and say so.
    fn serve(self: &Arc<Self>, listener: TcpListener) -> Result<(), String> {
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let path = self.options.directory.join(format!("{port}.lock"));
        lock::write_lock(&path, &lock::lock_text(&self.options.host_pid, &self.options.roots, &self.auth_token, &self.options.worker_pid))?;
        let bridge = self.clone();
        let accepting = tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        continue;
                    }
                };
                let task = tokio::spawn(connection(bridge.clone(), stream));
                let mut state = bridge.state.lock().expect("state");
                state.connections.retain(|task| !task.is_finished());
                state.connections.push(task);
            }
        });
        let mut state = self.state.lock().expect("state");
        state.accepting = Some(accepting);
        state.published = true;
        state.port = Some(port);
        state.lock = Some(path);
        state.reason = None;
        drop(state);
        let _ = self.ready.send(Some(true));
        Ok(())
    }

    fn closed(&self) -> bool {
        self.state.lock().expect("state").closed
    }

    pub fn source(&self) -> Option<Source> {
        self.source.clone()
    }

    pub fn published(&self) -> bool {
        self.state.lock().expect("state").published
    }
    pub fn port(&self) -> Option<u16> {
        self.state.lock().expect("state").port
    }
    pub fn lock_path(&self) -> Option<PathBuf> {
        self.state.lock().expect("state").lock.clone()
    }
    pub fn reason(&self) -> Option<String> {
        self.state.lock().expect("state").reason.clone()
    }

    /// `bridge.ready`: settles once the port is taken or given up on.
    pub async fn ready(&self) -> bool {
        let mut receiver = self.ready.subscribe();
        loop {
            if let Some(outcome) = *receiver.borrow_and_update() {
                return outcome;
            }
            if receiver.changed().await.is_err() {
                return false;
            }
        }
    }

    pub fn clients(&self) -> usize {
        self.sockets.lock().expect("sockets").len()
    }

    pub fn observed(&self) -> Vec<Value> {
        self.observed.lock().expect("observed").clone()
    }

    /// One notification to every connected CLI, in the CLI's own vocabulary; the count is how many
    /// were reached. Sends are fire-and-forget, as the JavaScript's were.
    pub fn notify(&self, method: &str, params: &Value) -> usize {
        let senders: Vec<UnboundedSender<Message>> = self.sockets.lock().expect("sockets").values().cloned().collect();
        let text = json!({ "method": method, "params": params, "jsonrpc": "2.0" }).to_string();
        for sender in &senders {
            let _ = sender.send(Message::Text(text.clone().into()));
        }
        senders.len()
    }

    pub fn selection(&self, value: &Value) -> usize {
        self.notify("selection_changed", value)
    }

    pub fn mention(&self, value: &Value) -> usize {
        self.notify("at_mentioned", value)
    }

    /// Retire: the lock is unlinked BEFORE the socket closes, so the successor waiting for this
    /// port cannot bind and write its lock in the gap and then have this one delete it. Then every
    /// CLI is closed and the listener released. Safe to call twice.
    pub async fn close(self: &Arc<Self>) {
        let retake = {
            let mut state = self.state.lock().expect("state");
            state.closed = true;
            state.retake.take()
        };
        if let Some(retake) = retake {
            let _ = retake.await;
        }
        let (accepting, connections, path) = {
            let mut state = self.state.lock().expect("state");
            (state.accepting.take(), std::mem::take(&mut state.connections), state.lock.take())
        };
        if let Some(path) = path {
            let _ = std::fs::remove_file(path);
        }
        let senders: Vec<UnboundedSender<Message>> = self.sockets.lock().expect("sockets").values().cloned().collect();
        for sender in senders {
            let _ = sender.send(Message::Close(None));
        }
        if let Some(accepting) = accepting {
            accepting.abort();
            let _ = accepting.await;
        }
        /* The JavaScript's `server.close` waited for every connection to finish its close
           handshake, bounded by ws's own thirty-second close timer. */
        for task in connections {
            if tokio::time::timeout(Duration::from_secs(30), task).await.is_err() {
                /* The handle is consumed by the timeout; the task ends when its socket does. */
            }
        }
    }
}

/// Node's `request.headers`: lowercase names, duplicates joined with `, ` except for the headers
/// Node keeps the first of, values as they arrived. `sec-websocket-key` is left out of what is
/// observed, as it always was.
fn node_headers(request: &Request) -> Vec<(String, String)> {
    const FIRST_WINS: [&str; 18] = ["content-type", "content-length", "user-agent", "referer", "host", "authorization", "proxy-authorization",
        "if-modified-since", "if-unmodified-since", "from", "location", "max-forwards", "retry-after", "etag", "last-modified", "server", "age", "expires"];
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in request.headers() {
        let name = name.as_str().to_ascii_lowercase();
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match headers.iter_mut().find(|(known, _)| *known == name) {
            Some((_, existing)) => {
                if !FIRST_WINS.contains(&name.as_str()) {
                    existing.push_str(", ");
                    existing.push_str(&value);
                }
            }
            None => headers.push((name, value)),
        }
    }
    headers
}

/// ws's `subprotocol.parse`: a comma-separated list of tokens, no duplicates, nothing else.
fn parse_protocols(header: &str) -> Result<Vec<String>, ()> {
    let mut protocols: Vec<String> = Vec::new();
    for part in header.split(',') {
        let token = part.trim_matches([' ', '\t']);
        if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)) {
            return Err(());
        }
        if protocols.iter().any(|known| known == token) {
            return Err(());
        }
        protocols.push(token.to_string());
    }
    Ok(protocols)
}

fn bad_request(message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::BAD_REQUEST;
    response.headers_mut().insert("Connection", "close".parse().expect("a header"));
    response.headers_mut().insert("Content-Type", "text/html".parse().expect("a header"));
    response
}

/// One CLI's connection: the handshake decides, the loop answers.
async fn connection(bridge: Arc<Bridge>, stream: TcpStream) {
    let verdict = Arc::new(Mutex::new(false));
    let callback = {
        let bridge = bridge.clone();
        let verdict = verdict.clone();
        move |request: &Request, mut response: Response| -> Result<Response, ErrorResponse> {
            let headers = node_headers(request);
            let offered = match headers.iter().find(|(name, _)| name == "sec-websocket-protocol") {
                Some((_, value)) => parse_protocols(value).map_err(|_| bad_request("Invalid Sec-WebSocket-Protocol header"))?,
                None => Vec::new(),
            };
            /* Measured, not assumed: `claude` 2.1.263 sends the lock's token in this header. One
               place is checked because one place is what it uses; a version that moves it fails the
               handshake loudly rather than being let in on a guess. */
            let presented = headers.iter().find(|(name, _)| name == "x-claude-code-ide-authorization").map(|(_, value)| value.as_str());
            let accepted = presented.is_some_and(|value| !value.is_empty() && red_core::service::same_secret(value, &bridge.auth_token));
            let mut recorded = Map::new();
            for (name, value) in &headers {
                if !name.starts_with("sec-websocket-key") {
                    recorded.insert(name.clone(), json!(value));
                }
            }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            bridge.observed.lock().expect("observed").push(json!({
                "at": red_core::time::iso(now), "accepted": accepted, "where": if accepted { json!("header") } else { Value::Null }, "headers": recorded,
            }));
            *verdict.lock().expect("verdict") = accepted;
            if offered.iter().any(|protocol| protocol == "mcp") {
                response.headers_mut().insert("Sec-WebSocket-Protocol", "mcp".parse().expect("a header"));
            }
            Ok(response)
        }
    };
    let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
    let (mut writing, mut reading) = socket.split();
    if !*verdict.lock().expect("verdict") {
        let _ = writing.send(Message::Close(Some(CloseFrame { code: CloseCode::Policy, reason: "A valid IDE token is required.".into() }))).await;
        let _ = tokio::time::timeout(Duration::from_secs(30), async { while let Some(Ok(_)) = reading.next().await {} }).await;
        return;
    }
    let id = bridge.next.fetch_add(1, Ordering::SeqCst);
    let (out, mut queue) = unbounded_channel::<Message>();
    bridge.sockets.lock().expect("sockets").insert(id, out.clone());
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let closing = matches!(message, Message::Close(_));
            if writing.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = writing.close().await;
    });
    while let Some(Ok(message)) = reading.next().await {
        /* A frame is one JSON-RPC message, text or binary alike: the JavaScript parsed
           `data.toString()` without asking which. */
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Some(request) = mcp::request_from(&text) else { continue };
        match mcp::reply(&bridge, request) {
            Reply::Now(answer) => {
                let _ = out.send(Message::Text(answer.into()));
            }
            Reply::Later(pending) => {
                /* Answered when the source answers, without holding the next frame behind it. */
                let out = out.clone();
                tokio::spawn(async move {
                    let answer = pending.await;
                    let _ = out.send(Message::Text(answer.into()));
                });
            }
            Reply::Silent => {}
        }
    }
    bridge.sockets.lock().expect("sockets").remove(&id);
    let _ = out.send(Message::Close(None));
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subprotocol_header_is_parsed_as_ws_parses_it() {
        assert_eq!(parse_protocols("mcp"), Ok(vec!["mcp".to_string()]));
        assert_eq!(parse_protocols("other,mcp"), Ok(vec!["other".to_string(), "mcp".to_string()]));
        assert_eq!(parse_protocols("other, mcp"), Ok(vec!["other".to_string(), "mcp".to_string()]));
        assert!(parse_protocols("mcp, mcp").is_err(), "a duplicate is a 400");
        assert!(parse_protocols("").is_err());
        assert!(parse_protocols("mcp,").is_err());
        assert!(parse_protocols("m cp").is_err());
    }

    #[test]
    fn a_bind_that_fails_for_another_reason_is_the_os_sentence() {
        let error = std::io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(listen_error(&error, "127.0.0.1", 80), "listen EACCES: permission denied 127.0.0.1:80");
    }
}
