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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use red_core::head::Head;
use red_worker::feed::{Close, Sent, Watcher, Watchers};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const USAGE: &str = "usage: red-worker --state <dir> --host <url> --host-token <token> [--port N] [--ide-port N] [--no-ide]";
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
    /// One write at a time per project, for the two routes that change a tracker (spec 103).
    writes: red_worker::tasks::Writes,
    /// Everyone watching a feed, and the root each is watching. The ledger pushes one stream of
    /// events for the whole state directory and this is what turns it into per-root feeds.
    watchers: Arc<Watchers>,
    /// One set of language servers per project, started the first time a file under it is asked
    /// about — a workspace with three projects open does not run three toolchains nobody looked at.
    servers: Arc<red_worker::editing::PerRoot>,
    /// Red as a Claude Code IDE, published once for this worker. `None` when it could not be, and
    /// then the routes over it deliver to nobody rather than refusing.
    bridge: Option<red_worker::editing::Bridge>,
    /// The generation this worker claimed, once, on the first request that was not a probe.
    generation: std::sync::Mutex<Option<i64>>,
    /// Who asked for which launch, and which games are open. The feed carries a PAIR for a game and
    /// this is what keeps it trustworthy across a launch that has not been given an id yet.
    launches: red_worker::launches::Launches,
    /// The desktops attached through this worker, and the actions it can ask them to perform.
    ///
    /// The worker's rather than the door's, and the reason is the reason for every route it answers
    /// rather than forwards: **the host beneath may predate the desktop routes entirely** (spec 065,
    /// KI-043). A worker that forwarded them would answer from a host that never had them, and
    /// `capabilities.desktopActions` is the promise it makes that they work.
    ///
    /// Holding them here means terminating `/events` rather than tunnelling it — which is what
    /// `worker.mjs` did, and the four frames below are the four it understood. Everything else on
    /// that socket passes through, which is what "a pane's bytes are never a second opinion" is
    /// actually about.
    desktops: red_core::desktops::Desktops,
    /// Numbers a socket, so a registration can be keyed by one without holding it.
    sockets: std::sync::atomic::AtomicU64,
    /// Replaced, but still draining (spec 095, Retirement).
    ///
    /// A retired worker keeps answering everything it can, because its streams are still somebody's
    /// pane. What it stops doing is **minting**: the worker that replaced it follows the same host
    /// stream, and two workers minting `game.*` on one ledger would put every transition on the
    /// feed twice. Its feed watchers are told where to go, once.
    ///
    /// The ledger itself needs no hand-off any more. It is a SERVICE (F157) and both workers attach
    /// to the same one, so there is one writer and one sequence however many workers are alive —
    /// which is what retires spec 095's relay along with `worker.mjs`.
    retired: std::sync::atomic::AtomicBool,
    /// The device probes this worker has taken, kept for as long as it is running.
    probes: red_project::devices::Probes,
    /// The tracker sign-in in flight, if there is one. At most one per workspace (F154, spec 083).
    signing_in: red_worker::signin::SigningIn,
    /// What the remote providers have said lately. One poll every thirty seconds is about 5% of a
    /// key's budget, and two callers arriving together share one request rather than spending it
    /// twice.
    trackers: red_project::tracker_remote::Cache,
    /// Feed sockets still writing. A worker is told it is retired and told to close in the same
    /// breath, and the retirement has to REACH its watchers before the process goes: a monitor that
    /// got a dropped connection instead of the close frame has no sequence to resume from and no
    /// reason to re-read `feed_url`.
    draining: Arc<std::sync::atomic::AtomicUsize>,
}

struct Options {
    state: String,
    host: String,
    host_token: String,
    port: u16,
    /// The port the IDE bridge publishes on; 0 is "any". `--no-ide` starts none at all, which is
    /// what a test wants: a bridge writes a lock into the person's own `/ide` menu.
    ide_port: u16,
    ide: bool,
}

fn options() -> Result<Options, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let named = |name: &str| {
        argv.iter().position(|value| value == name).and_then(|at| argv.get(at + 1)).map(String::from)
    };
    let number = |name: &str| named(name).map(|value| value.parse::<u16>().map_err(|_| format!("{name} takes a number")));
    Ok(Options {
        state: named("--state").ok_or(USAGE)?,
        host: named("--host").ok_or(USAGE)?,
        host_token: named("--host-token").ok_or(USAGE)?,
        port: number("--port").transpose()?.unwrap_or(0),
        ide_port: number("--ide-port").transpose()?.unwrap_or(0),
        ide: !argv.iter().any(|value| value == "--no-ide"),
    })
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let chosen = match options() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("red-worker: {message}");
            return std::process::ExitCode::from(2);
        }
    };
    let Options { state, host, host_token, port, ide_port, ide } = chosen;
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("red-worker: cannot listen: {error}");
            return std::process::ExitCode::from(1);
        }
    };
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(0);
    /* Built before the client, because the client's event callback delivers INTO it: the ledger
       starts pushing the moment it is attached, and a fan-out that did not exist yet would drop
       whatever arrived first. */
    let watchers = Arc::new(Watchers::default());
    let fan_out = watchers.clone();
    /* A `token.*` frame moved the ledger, so every desktop bound to that project is pushed the
       pinned segment — which is what lets the status bar never poll. The callback cannot ASK for the
       segment: it runs on the client's own reader, and a call from there would be the reader waiting
       for itself. So it names the project and a task does the asking. */
    let (wants, mut wanted) = tokio::sync::mpsc::unbounded_channel::<String>();
    /* Started if nobody has: a worker is the layer that owns the ledger's routes, so it is the layer
       that makes sure there is one to own. `attaching` only attaches — deliberately, because two
       in-memory owners of one set of files is stale reads and lost writes — so the start is a
       separate act, taken under a lock that two workers cannot both win. A failure here is not
       fatal: the feed and the token say so by name, and everything else still serves. */
    match red_core::service::serve_binary("RENGINE_RED_TOKEN_SERVE", "red-token-serve")
        .and_then(|binary| {
            red_core::service::start_service(
                std::path::Path::new(&state),
                "token",
                TOKEN_PROTOCOL,
                &binary,
                &["--state".to_string(), state.clone()],
            )
        }) {
        Ok(()) => {}
        Err(message) => eprintln!("red-worker: no token ledger ({message})"),
    }
    let ledger = match red_core::service::Client::attaching(
        std::path::Path::new(&state),
        "token",
        TOKEN_PROTOCOL,
        Box::new(move |event: &serde_json::Value| {
            for behind in fan_out.deliver(event) {
                fan_out.close(behind, Close::Behind);
            }
            let moved = event.get("event").and_then(serde_json::Value::as_str) == Some("frame")
                && event
                    .get("frame")
                    .and_then(|frame| frame.get("type"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| kind.starts_with("token."));
            if moved {
                if let Some(root) = event.get("rootId").and_then(serde_json::Value::as_str) {
                    let _ = wants.send(root.to_string());
                }
            }
        }),
    ) {
        Ok(client) => client,
        Err(message) => {
            eprintln!("red-worker: {message} The feed and the token will say so rather than answer.");
            None
        }
    };
    /* The bridge asks back for diagnostics, so the servers exist before it does: the editor pane and
       a connected CLI read ONE store (spec 133, D3), and that store is this. */
    let servers = Arc::new(red_worker::editing::PerRoot::new());
    let bridge = if ide { started_bridge(&host, &host_token, ide_port, &servers) } else { None };
    let worker = Arc::new(Worker {
        ledger,
        host,
        host_token,
        token: red_core::service::secret(),
        url: format!("http://127.0.0.1:{port}"),
        writes: red_worker::tasks::Writes::new(),
        watchers,
        servers,
        bridge,
        generation: std::sync::Mutex::new(None),
        launches: red_worker::launches::Launches::new(),
        retired: std::sync::atomic::AtomicBool::new(false),
        probes: red_project::devices::Probes::default(),
        desktops: red_core::desktops::Desktops::new(),
        sockets: std::sync::atomic::AtomicU64::new(0),
        signing_in: red_worker::signin::SigningIn::new(),
        trackers: red_project::tracker_remote::Cache::new(),
        draining: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    });
    /* One line, then serve: the supervisor reads this to learn where the worker is before it writes
       the descriptor that names it. The instance is the HOST's — a worker is only ever a front for
       one, and the layer above checks the two agree before it keeps a candidate. */
    let instance = ask_host(&worker, "GET", "/api/state", "")
        .ok()
        .and_then(|state| state.get("instance").cloned())
        .unwrap_or(serde_json::Value::Null);
    println!(
        "{}",
        serde_json::json!({ "started": true, "url": worker.url, "token": worker.token,
                            "instance": instance, "pid": std::process::id() })
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();

    /* The supervisor's channel, one JSON line at a time — the same shape this worker speaks to its
       own children with. Not a route, because this is control of the PROCESS and not of the
       workspace; not a signal, because there is no second signal on every platform this runs on.
       A supervisor hands it a PIPE, and that pipe closing is the supervisor going away: a worker
       nobody can retire or replace goes too. Stdin that is not a pipe — a terminal, `/dev/null`, a
       file — is not a channel at all, and its end means nothing: a worker started by hand to look at
       it keeps serving. */
    let supervised = supervising_pipe();
    {
        let worker = worker.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                match message.get("type").and_then(serde_json::Value::as_str) {
                    Some("retired") => retire(&worker),
                    /* Drained first. The supervisor sends `retired` and `close` back to back, and a
                       process that went away between them would leave every watcher with a dropped
                       connection instead of the sentence that tells it where to go. */
                    Some("close") => {
                        drained(&worker);
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
            if supervised {
                drained(&worker);
                std::process::exit(0);
            }
        });
    }

    {
        let worker = worker.clone();
        tokio::spawn(async move {
            while let Some(root) = wanted.recv().await {
                let held = worker.clone();
                let _ = tokio::task::spawn_blocking(move || push_segment(&held, &root, None)).await;
            }
        });
    }
    /* The open pairs this worker inherits, and then the stream that closes them. A worker replaced
       mid-game reads its predecessor's `game.started` frames back out of the ring, so the `ended`
       half still lands and a monitor is not left with a game that never stopped. */
    inherit_open_games(&worker);
    {
        let worker = worker.clone();
        tokio::spawn(async move { follow_host(worker).await });
    }

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
        /* The two kinds of socket, and the difference IS the worker. `/feed` is served here because
           nothing else can serve it — one writer, one sequence. `/events` and `/surface` belong to
           whoever answers the session routes, so they are tunnelled byte for byte: a client that
           reached the worker for a pane's bytes gets the host's, and never a second opinion. */
        if head.upgrade && head.path() == "/feed" {
            let key = head.header("sec-websocket-key").unwrap_or_default();
            client.write_all(accepted(&key).as_bytes()).await?;
            serve_feed(worker, client, buffered, &head).await;
            return Ok(());
        }
        if head.upgrade && red_worker::serve::own_socket(&head.path()) {
            let key = head.header("sec-websocket-key").unwrap_or_default();
            client.write_all(accepted(&key).as_bytes()).await?;
            serve_events(worker, client, buffered, &head).await;
            return Ok(());
        }
        if head.upgrade {
            return tunnel(&worker, client, buffered, &head).await;
        }
        /* A route the DOOR answers that this worker must not simply hand on: the token gate, asked
           before the forward rather than by asking the door to grow one (spec 065). A refusal ends
           the request here; a pass falls through to the forwarder below unchanged. */
        if !red_worker::serve::implemented(&head.method, &head.path())
            && red_worker::serve::gated(&head.method, &head.path()).is_some()
        {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let refusal = {
                let (worker, head, asked) = (worker.clone(), head.clone(), body.clone());
                tokio::task::spawn_blocking(move || gate_for(&worker, &head, &asked))
                    .await
                    .unwrap_or_else(|_| Some("500|This worker failed while asking the ledger.".to_string()))
            };
            if let Some(fault) = refusal {
                client.write_all(faulted(&fault).as_bytes()).await?;
                if !head.keeps_alive() {
                    return Ok(());
                }
                continue;
            }
            /* Past the gate: replayed at the door with the body already in hand. */
            let (address, _) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
            let mut upstream = TcpStream::connect(&address).await?;
            upstream.write_all(head.replayed(&worker.host, &worker.host_token).as_bytes()).await?;
            upstream.write_all(body.as_bytes()).await?;
            let mut upstream_buffered: Vec<u8> = Vec::new();
            let Some(answer) = Head::read(&mut upstream, &mut upstream_buffered).await? else { return Ok(()) };
            client.write_all(answer.raw.as_bytes()).await?;
            answer.forward_body(&mut upstream, &mut upstream_buffered, &mut client).await?;
            if answer.closes() || !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }
        if red_worker::serve::implemented(&head.method, &head.path()) {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            /* Off the async workers. Every one of these routes blocks — a CLI's `--help`, a call to
               the door, a project's own write command — and a runtime whose workers were all inside
               one would stop accepting the connection that was waiting to be told so. */
            let answer = {
                let (worker, head) = (worker.clone(), head.clone());
                tokio::task::spawn_blocking(move || answer_own(&worker, &head, &body))
                    .await
                    .unwrap_or_else(|_| refusal(500, "Error", "This worker failed while answering."))
            };
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }

        /* Everything else is the host's. The head is replayed with this worker's credential swapped
           for the host's — a client never learns the host's — and the body is forwarded by its own
           framing. The ANSWER is framed the same way: reading it to end-of-connection instead would
           wait out the host's keep-alive on every forwarded route, which is nineteen of them. */
        let (address, _) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
        let mut upstream = TcpStream::connect(&address).await?;
        upstream.write_all(head.replayed(&worker.host, &worker.host_token).as_bytes()).await?;
        head.forward_body(&mut client, &mut buffered, &mut upstream).await?;
        let mut upstream_buffered: Vec<u8> = Vec::new();
        let Some(answer) = Head::read(&mut upstream, &mut upstream_buffered).await? else { return Ok(()) };
        client.write_all(answer.raw.as_bytes()).await?;
        answer.forward_body(&mut upstream, &mut upstream_buffered, &mut client).await?;
        if answer.closes() || !head.keeps_alive() {
            return Ok(());
        }
    }
}

/// `GET /api/state`, composed rather than forwarded.
fn state(worker: &Worker) -> Result<serde_json::Value, String> {
    let mut state = ask_host(worker, "GET", "/api/state", "")?;
    let window = worker.ledger.as_ref().and_then(|ledger| ledger.call("window", serde_json::json!([])).ok());
    let host_capabilities = state.get("capabilities").cloned().unwrap_or_else(|| serde_json::json!({}));
    if let Some(out) = state.as_object_mut() {
        out.insert("capabilities".to_string(), red_worker::serve::capabilities(&host_capabilities, worker.ledger.is_some()));
        if let Some(window) = window {
            let mut preferences = out.get("preferences").and_then(|value| value.as_object()).cloned().unwrap_or_default();
            preferences.insert("tokenWindowMs".to_string(), window);
            out.insert("preferences".to_string(), serde_json::Value::Object(preferences));
        }
    }
    Ok(state)
}

/// `POST /api/preferences`, split.
///
/// The host's preference store allowlists its keys and drops the ones it does not know, so the token
/// window is kept beside the LEDGER and the rest is forwarded unchanged. A worker that passed the
/// whole body on would have the window silently dropped and the person's setting never take.
fn preferences(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let mut rest = data.as_object().cloned().unwrap_or_default();
    let window = rest.remove("tokenWindowMs");
    if let Some(window) = window.filter(|value| !value.is_null()) {
        let Some(ledger) = &worker.ledger else {
            return Err("409|This workspace worker does not serve the project token ledger.".to_string());
        };
        ledger.call("setWindow", serde_json::json!([window]))?;
    }
    let mut answer = ask_host(worker, "POST", "/api/preferences", &serde_json::Value::Object(rest).to_string())?
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(ledger) = &worker.ledger {
        if let Ok(window) = ledger.call("window", serde_json::json!([])) {
            answer.insert("tokenWindowMs".to_string(), window);
        }
    }
    Ok(serde_json::Value::Object(answer))
}

/// `POST /api/recording`: the desktop's own frame, arriving over HTTP.
///
/// The recorder lives in the desktop (spec 081), so a commit is announced BY the desktop. This is
/// the route a retired worker forwards one to; the same body, the same frames, the same attribution.
fn recording(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, _) = root_of(worker, named(&data, "rootId"))?;
    /* WHO before what: a frame from somebody who is not a desktop is refused as theirs, not as one
       this worker cannot mint. An agent that sent one would be claiming to be the recorder, and the
       recorder is the thing in front of the person — so its header is honoured only in the ABSENCE
       of an agent's. The order is the JavaScript's, and it is the opposite of a token action's,
       where a worker with no ledger says so whoever is asking. */
    let desk = red_worker::identity::agent(|name| head.header(name))
        .is_none()
        .then(|| red_worker::identity::desktop(|name| head.header(name)))
        .flatten();
    let Some(desk) = desk else {
        return Err("403|A recording frame is the desktop's; this request carried no X-Rengine-Desktop header.".to_string());
    };
    if worker.ledger.is_none() {
        return Err("409|This workspace worker does not serve the project token ledger.".to_string());
    }
    let event = data.get("event").and_then(serde_json::Value::as_str);
    let kind = match event {
        Some("started") => "capture.started",
        Some("committed") => "capture.committed",
        _ => return Err("400|A recording frame carries event started or committed.".to_string()),
    };
    let mut fields = serde_json::json!({
        "sessionId": data.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "gameId": data.get("gameId").cloned().unwrap_or(serde_json::Value::Null),
        "recordingId": data.get("recordingId").cloned().unwrap_or(serde_json::Value::Null),
        "kind": if data.get("kind") == Some(&serde_json::json!("explicit")) { "explicit" } else { "ring" },
    });
    if let Some(at) = data.get("at").and_then(serde_json::Value::as_str) {
        fields["startedAt"] = serde_json::json!(at.chars().take(40).collect::<String>());
    }
    if let Some(error) = data.get("error").and_then(serde_json::Value::as_str) {
        fields["error"] = serde_json::json!(error.chars().take(400).collect::<String>());
    }
    let by = serde_json::json!({ "kind": "desktop", "desktopId": desk });
    let frame = note(worker, &root_id, kind, &by, fields);
    Ok(serde_json::json!({
        "rootId": root_id,
        "type": frame.as_ref().and_then(|frame| frame.get("type").cloned()).unwrap_or(serde_json::Value::Null),
        "sequence": sequence_of(&frame),
    }))
}

/// Replaced: stop minting, and tell every watcher where the next worker is.
///
/// Told ONCE — a second `retired` must not close a feed a client has since reopened on this worker,
/// which it may legitimately have done while this one was still draining.
fn retire(worker: &Arc<Worker>) {
    if worker.retired.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    /* The bridge goes at retirement rather than at close, so `/ide` lists one editor again as soon
       as the supervisor has switched: a CLI connects only when exactly one is offered. */
    if let Some(bridge) = &worker.bridge {
        bridge.close();
    }
    worker.watchers.close_all(Close::Retired);
}

/// Is stdin a supervisor's pipe, or is it nothing?
///
/// The difference decides what its END means. A pipe closing is the process that spawned this one
/// going away; `/dev/null` or a terminal was never a channel, and reading nothing from it is not an
/// instruction to stop serving a workspace.
fn supervising_pipe() -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        use std::os::unix::io::FromRawFd;
        /* Borrowed, never owned: this must not close the descriptor it is asking about. */
        let held = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(0) });
        return held.metadata().map(|about| about.file_type().is_fifo() || about.file_type().is_socket()).unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Wait for the feed sockets to finish saying what they were told to say. Bounded, because a client
/// that has stopped reading must not keep a replaced worker alive.
fn drained(worker: &Arc<Worker>) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while worker.draining.load(std::sync::atomic::Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// What this worker's predecessor left open, read back out of each project's ring.
fn inherit_open_games(worker: &Arc<Worker>) {
    let Some(ledger) = &worker.ledger else { return };
    let Ok(state) = ask_host(worker, "GET", "/api/state", "") else { return };
    let empty = Vec::new();
    for root in state.get("roots").and_then(serde_json::Value::as_array).unwrap_or(&empty) {
        let Some(id) = root.get("id").and_then(serde_json::Value::as_str) else { continue };
        let Ok(read) = ledger.call("feedAfter", serde_json::json!([id, 0, serde_json::Value::Null])) else { continue };
        let frames = read.get("frames").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
        worker.launches.inherit(&frames);
    }
    /* And anything that is no longer running gets its ending now: the pane may have stopped while
       there was no worker to hear it. */
    let sessions = state.get("sessions").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    for id in worker.launches.still_open() {
        let found = sessions.iter().find(|session| session.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()));
        let running = found.is_some_and(|session| session.get("state").and_then(serde_json::Value::as_str) == Some("running"));
        if !running {
            let record = found.cloned().unwrap_or_else(|| serde_json::json!({ "id": id, "type": "game", "state": "exited" }));
            told_the_feed(worker, &record);
        }
    }
}

/// The host's own session stream, read for transitions and nothing else.
///
/// An `output` frame is never even parsed into a feed frame, which is what makes "no PTY output on
/// the feed" structural rather than a filter somebody can forget. The socket is reopened when it
/// drops, because a host that restarted is one this worker still fronts.
async fn follow_host(worker: Arc<Worker>) {
    let mut attempts = 0;
    loop {
        if follow_once(&worker).await.is_ok() {
            attempts = 0;
        }
        attempts += 1;
        if attempts > 20 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

async fn follow_once(worker: &Arc<Worker>) -> io::Result<()> {
    let (address, authority) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
    let mut upstream = TcpStream::connect(&address).await?;
    upstream
        .write_all(
            format!(
                "GET /events?token={} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
                worker.host_token,
                tokio_tungstenite::tungstenite::handshake::client::generate_key()
            )
            .as_bytes(),
        )
        .await?;
    let mut buffered = Vec::new();
    let Some(answer) = Head::read(&mut upstream, &mut buffered).await? else { return Ok(()) };
    if !answer.raw.starts_with("HTTP/1.1 101") {
        return Err(io::Error::other("the session host refused the stream"));
    }
    let stream = Prefixed { buffered, inner: upstream };
    let socket = WebSocketStream::from_raw_socket(stream, Role::Client, None).await;
    let (_writing, mut reading) = socket.split();
    while let Some(Ok(message)) = reading.next().await {
        let Message::Text(text) = message else { continue };
        let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if event.get("type").and_then(serde_json::Value::as_str) != Some("session") {
            continue;
        }
        let Some(session) = event.get("session").cloned() else { continue };
        let worker = worker.clone();
        let _ = tokio::task::spawn_blocking(move || told_the_feed(&worker, &session)).await;
    }
    Ok(())
}

/// One session transition, as the feed hears it.
fn told_the_feed(worker: &Arc<Worker>, session: &serde_json::Value) {
    /* A retired worker mints nothing: the one that replaced it follows the same stream, and two
       minting on one ledger would put every transition on the feed twice. */
    if worker.ledger.is_none() || worker.retired.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let id = session.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0);
    let root = worker.launches.root_of(&id, session);
    /* The frame names itself: two pairs ride on this stream — a game a person watches, and a
       device-bound dashboard action whose session bounds it. */
    match worker.launches.heard(session, now) {
        red_worker::launches::Says::Started { kind, by, fields } | red_worker::launches::Says::Ended { kind, by, fields } => {
            note(worker, &root, kind, &by, fields);
        }
        red_worker::launches::Says::Nothing => {}
    }
}

/// Claim a generation and tell every project about it — once, on the first request that is not a
/// probe (`lifecycle::announces`).
///
/// This is what the layer above reads to know a new worker took over: `workspace.updated` on each
/// root's feed, carrying the generation this worker claimed. A worker with no ledger claims none,
/// because a generation that nothing recorded is a number nobody can compare against.
fn announce(worker: &Worker) {
    let Some(ledger) = &worker.ledger else { return };
    {
        let held = worker.generation.lock().expect("generation");
        if held.is_some() {
            return;
        }
    }
    let Ok(claimed) = ledger.call("bumpGeneration", serde_json::json!([])) else { return };
    let generation = claimed.as_i64().or_else(|| claimed.get("generation").and_then(serde_json::Value::as_i64)).unwrap_or(0);
    {
        let mut held = worker.generation.lock().expect("generation");
        if held.is_some() {
            return;
        }
        *held = Some(generation);
    }
    let Ok(state) = ask_host(worker, "GET", "/api/state", "") else { return };
    let empty = Vec::new();
    let roots = state.get("roots").and_then(serde_json::Value::as_array).unwrap_or(&empty);
    let by = serde_json::json!({ "kind": "workspace", "pid": std::process::id() });
    for root in roots {
        let Some(id) = root.get("id").and_then(serde_json::Value::as_str) else { continue };
        note(worker, id, "workspace.updated", &by, serde_json::json!({ "layers": ["workspace"], "generation": generation }));
    }
}

/// The socket a monitor opens to follow one project's feed, credential and all.
fn feed_url(worker: &Worker, root_id: &str) -> String {
    format!("{}/feed?rootId={root_id}&token={}", worker.url.replacen("http:", "ws:", 1), worker.token)
}

/// `POST /api/game`: gated here, launched there, and attributed on the way past.
///
/// The door owns the launch and its refusals (F155). What this adds is the arbitration and the
/// ATTRIBUTION: the host announces the new session before the launch call returns, so who asked
/// cannot be looked up by session id at that moment. The asker is queued on the root first, and the
/// frame takes it — which is the only reason a monitor can say who started a game.
fn game(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, _) = root_of(worker, named(&data, "rootId"))?;
    let by = gate(worker, &root_id, "launch_game", head)?;
    /* Refused HERE, from this worker's own preflight, before anything reaches the host: spec 078 and
       KI-043's lesson is that the host must not be the one to answer, because the host beneath may
       be the one that cannot. */
    let config = about_project(worker, &head_for(head, "/api/game-config", &data), "")?;
    if let Some(refusal) = config.get("refusal").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty()) {
        return Err(format!("409|{refusal}"));
    }
    let state = ask_host(worker, "GET", "/api/state", "")?;
    red_worker::spawn::host_can_launch(&state).map_err(refused)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0);
    /* What was already running, read BEFORE the launch: a session id that was there a moment ago is
       one the door coalesced onto, not one this call started. */
    let running: Vec<String> = ask_host(worker, "GET", "/api/state", "")
        .ok()
        .and_then(|state| state.get("sessions").and_then(serde_json::Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|session| session.get("id").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect();
    worker.launches.queue(&root_id, &by, now);
    let session = match ask_host(worker, "POST", "/api/game", body) {
        Ok(session) => session,
        Err(fault) => {
            /* The launch was refused, so the asker takes its entry back rather than leaving it to
               attach to somebody else's game ten seconds from now. */
            let _ = worker.launches.next(&root_id, now);
            return Err(fault);
        }
    };
    if let Some(id) = session.get("id").and_then(serde_json::Value::as_str) {
        worker.launches.landed(&root_id, id, &by, running.iter().any(|held| held == id), now);
    }
    Ok(session)
}

/// The gate for a route the door answers. `None` means it may go through.
///
/// The project is the one the route NAMES, and for a pane route that is the pane's own record —
/// only the pane knows which project it runs in, and a caller's claim about it would let an agent
/// gate itself against a project it is not in.
fn gate_for(worker: &Worker, head: &Head, body: &str) -> Option<String> {
    let (tool, names) = red_worker::serve::gated(&head.method, &head.path())?;
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let root = match names {
        red_worker::serve::Names::Root => root_of(worker, named(&data, "rootId")).map(|(id, _)| id),
        red_worker::serve::Names::Session => {
            let id = named(&data, "id");
            ask_host(worker, "GET", &format!("/api/session?id={id}"), "")
                /* A route's own refusal arrives as its sentence and a pane that is not there is the
                   only way this one refuses, so it is 404 — the JavaScript's `snapshot(id)`. A host
                   that could not be reached at all is a different answer and says so. */
                .map_err(|fault| match fault.contains("cannot reach") || fault.contains("no answer from") {
                    true => format!("502|{fault}"),
                    false => "404|Unknown session.".to_string(),
                })
                .and_then(|pane| {
                    pane.get("rootId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| "404|Unknown session.".to_string())
                })
        }
    };
    match root.and_then(|root| gate(worker, &root, tool, head)) {
        Ok(_) => None,
        Err(fault) => Some(fault),
    }
}

/// Red as a Claude Code IDE, for as long as this worker lives.
///
/// A worker that cannot publish one still serves everything else and says so: the CLI's `/ide` menu
/// is a convenience, and a workspace that refused to start because another editor held the lock
/// would be a workspace nobody could open. The reason travels to stderr, where the supervisor that
/// started this reads it.
fn started_bridge(
    host: &str,
    host_token: &str,
    port: u16,
    servers: &Arc<red_worker::editing::PerRoot>,
) -> Option<red_worker::editing::Bridge> {
    let state = red_core::http::get(host, host_token, "/api/state").ok()?;
    let roots: Vec<String> = state
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items.iter().filter_map(|item| item.get("path").and_then(serde_json::Value::as_str).map(str::to_string)).collect()
        })
        .unwrap_or_default();
    /* The lock Claude Code reads must name a process that is one of a pane's own ancestors, and only
       the session host is (spec 102). The host says its own pid; a worker that was told none
       publishes without one rather than naming itself, which would be naming the wrong process. */
    let host_pid = state.get("pid").and_then(serde_json::Value::as_i64);
    let answering = servers.clone();
    let options = serde_json::json!({
        "roots": roots,
        "hostPid": host_pid,
        "workerPid": std::process::id(),
        "port": port,
        "host": "127.0.0.1",
    });
    match red_worker::editing::Bridge::start(
        options,
        Some(Box::new(move |method: &str, args: &[serde_json::Value]| {
            if method != "diagnostics" {
                return Err(format!("this worker cannot answer {method}."));
            }
            Ok(answering.about(args.first().and_then(serde_json::Value::as_str).unwrap_or_default()))
        })),
    ) {
        Ok(bridge) => {
            if !bridge.published {
                eprintln!("red-worker: no editor published: {}", bridge.reason.clone().unwrap_or_else(|| "no reason given".to_string()));
            }
            Some(bridge)
        }
        Err(message) => {
            eprintln!("red-worker: no editor published: {message}");
            None
        }
    }
}

/// The 101 a client gets before the frames start.
fn accepted(key: &str) -> String {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes())
    )
}

/// The `/feed` socket: the frames a watcher has not seen, and then the ones that happen next.
///
/// **The subscription is taken BEFORE the replay.** A watcher that subscribed first and replayed
/// second would see a frame twice; one that replayed first without holding the subscription would
/// miss whatever happened in between. So it joins the fan-out at its cursor, replays over the top,
/// and the watcher's own de-duplication makes the overlap invisible.
async fn serve_feed(worker: Arc<Worker>, client: TcpStream, buffered: Vec<u8>, head: &Head) {
    let stream = Prefixed { buffered, inner: client };
    let socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut writing, mut reading) = socket.split();
    let (out, mut queue) = unbounded_channel::<Sent>();
    let queued = Arc::new(AtomicUsize::new(0));
    /* Counted for as long as this socket has anything left to write, so a retirement reaches its
       watcher before the process that was told to close goes away. */
    worker.draining.fetch_add(1, Ordering::SeqCst);
    let draining = worker.draining.clone();

    /* The writer owns the socket's sending half, so a close travels down the same queue the frames
       do and cannot overtake them. */
    let writer = tokio::spawn(async move {
        while let Some(sent) = queue.recv().await {
            let message = match sent {
                Sent::Frame(text) => {
                    queued.fetch_sub(text.len().min(queued.load(Ordering::SeqCst)), Ordering::SeqCst);
                    Message::Text(text.into())
                }
                Sent::Close(why) => {
                    let (code, reason) = why.frame();
                    let _ = writing
                        .send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() })))
                        .await;
                    break;
                }
            };
            if writing.send(message).await.is_err() {
                break;
            }
        }
        let _ = writing.close().await;
        draining.fetch_sub(1, Ordering::SeqCst);
    });

    let refuse = |out: &tokio::sync::mpsc::UnboundedSender<Sent>, why: Close| {
        let _ = out.send(Sent::Close(why));
    };
    let root = head.query("rootId").unwrap_or_default();
    let cursor = red_worker::feed::cursor_of(head.query("after").as_deref());
    match &worker.ledger {
        _ if worker.retired.load(std::sync::atomic::Ordering::SeqCst) => refuse(&out, Close::Retired),
        _ if root.is_empty() => refuse(&out, Close::Refused("A project root is required to read its feed.".to_string())),
        None => refuse(&out, Close::Refused("This workspace worker does not serve the project token ledger.".to_string())),
        Some(ledger) => {
            let queued = Arc::new(AtomicUsize::new(0));
            let watcher = Arc::new(Watcher::new(out.clone(), queued, cursor));
            let id = worker.watchers.join(&root, watcher.clone());
            /* Replayed over the live subscription. A frame that arrives both ways is sent once. */
            match ledger.call("feedAfter", serde_json::json!([root, cursor, serde_json::Value::Null])) {
                Ok(history) => {
                    let empty = Vec::new();
                    let frames = history.get("frames").and_then(serde_json::Value::as_array).unwrap_or(&empty);
                    for frame in frames {
                        if watcher.send(frame).is_err() {
                            worker.watchers.close(id, Close::Behind);
                            break;
                        }
                    }
                }
                Err(fault) => {
                    worker.watchers.close(id, Close::Refused(fault.split_once('|').map(|(_, why)| why).unwrap_or(&fault).to_string()));
                }
            }
            /* A watcher sends nothing: the feed is one-way, and a client that talks is simply read
               until it goes away. What ends this is the socket closing, either end. */
            while let Some(Ok(message)) = reading.next().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
            }
            worker.watchers.leave(id);
        }
    }
    drop(out);
    let _ = writer.await;
}

/// One desktop's end of its socket, as the registry sees it.
struct Desk(tokio::sync::mpsc::UnboundedSender<String>);

impl red_core::desktops::Says for Desk {
    fn say(&self, line: String) {
        let _ = self.0.send(line);
    }
}

/// The `/events` socket: the host's, with four frames taken out of it.
///
/// A desktop registering, a desktop answering an action, a person acting on the token, and a
/// capture the desktop recorded are all **this worker's** — the host beneath may predate every one
/// of them (spec 065), and a worker that passed them through would answer from a host that never
/// had them. Everything else goes upstream unchanged, which is what "a pane's bytes are never a
/// second opinion" is actually about: this reads four frame TYPES and forwards the rest.
async fn serve_events(worker: Arc<Worker>, client: TcpStream, buffered: Vec<u8>, head: &Head) {
    let socket = worker.sockets.fetch_add(1, Ordering::SeqCst);
    let stream = Prefixed { buffered, inner: client };
    let downstream = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let (mut writing, mut reading) = downstream.split();
    let (out, mut queue) = unbounded_channel::<String>();

    /* The host's own socket, opened as a client: everything it says reaches the desktop, and
       everything the desktop says that is not one of the four reaches it. */
    let upstream = match dial_events(&worker, head).await {
        Ok(upstream) => upstream,
        Err(_) => {
            let _ = writing.close().await;
            return;
        }
    };
    let (mut to_host, mut from_host) = upstream.split();

    let writer = tokio::spawn(async move {
        while let Some(line) = queue.recv().await {
            if writing.send(Message::Text(line.into())).await.is_err() {
                break;
            }
        }
        let _ = writing.close().await;
    });
    let downward = out.clone();
    let carrying = tokio::spawn(async move {
        while let Some(Ok(message)) = from_host.next().await {
            let Message::Text(text) = message else { continue };
            if downward.send(text.to_string()).is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = reading.next().await {
        let Message::Text(text) = message else { continue };
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
            let _ = to_host.send(Message::Text(text)).await;
            continue;
        };
        let kind = frame.get("type").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        if !matches!(kind.as_str(), "desktop-register" | "desktop-action-result" | "token-action" | "recording") {
            if to_host.send(Message::Text(text)).await.is_err() {
                break;
            }
            continue;
        }
        let said = out.clone();
        let held = worker.clone();
        let answered = tokio::task::spawn_blocking(move || desktop_frame(&held, socket, &kind, &frame, said)).await;
        if let Ok(Err(refusal)) = answered {
            /* The JS host's `{type:'error'}`, which is how every refusal on this socket reaches a
               person. */
            let _ = out.send(serde_json::json!({ "type": "error", "error": refusal }).to_string());
        }
    }
    worker.desktops.disconnected(socket);
    drop(out);
    carrying.abort();
    let _ = writer.await;
}

/// One of the four frames on `/events` that are this worker's.
///
/// The order of the checks in each is the JavaScript's, and load-bearing: a frame from somebody who
/// is not a registered desktop is refused as theirs before anything is asked of the ledger.
fn desktop_frame(
    worker: &Arc<Worker>,
    socket: u64,
    kind: &str,
    frame: &serde_json::Value,
    said: tokio::sync::mpsc::UnboundedSender<String>,
) -> Result<(), String> {
    match kind {
        "desktop-register" => {
            let registered = register_desktop(worker, socket, frame, Arc::new(Desk(said)));
            if let Err(message) = &registered {
                worker.desktops.refused(message, now_ms());
            }
            registered?;
            /* The pinned segment, straight away: a desktop that has just registered draws its status
               bar from this and would otherwise have nothing until the next transition. */
            for root in worker.desktops.bound(socket) {
                push_segment(worker, &root, Some(socket));
            }
            Ok(())
        }
        "desktop-action-result" => worker.desktops.acknowledge(socket, frame),
        "token-action" => desktop_token(worker, socket, frame),
        "recording" => desktop_recording(worker, socket, frame),
        _ => Ok(()),
    }
}

/// A registration, with its bindings resolved against the workspace this worker fronts.
fn register_desktop(
    worker: &Arc<Worker>,
    socket: u64,
    frame: &serde_json::Value,
    says: Arc<dyn red_core::desktops::Says>,
) -> Result<(), String> {
    if let Some(refusal) = red_core::desktops::Desktops::malformed(frame, 0) {
        return Err(refusal.to_string());
    }
    let state = ask_host(worker, "GET", "/api/state", "").map_err(|fault| plain(&fault))?;
    let empty = Vec::new();
    let known: Vec<String> = state
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .filter_map(|root| root.get("id").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect();
    let roots = red_core::desktops::unique(listed(frame, "rootIds"));
    for root in &roots {
        if !known.contains(root) {
            return Err("Unknown project root.".to_string());
        }
    }
    /* A session this workspace has never had is NOT an invalid binding: it ended with the host that
       owned it and the desktop's saved layout outlived that process. Refusing the frame would leave
       the desktop unregistered and every desktop action, and the whole runtime layer, invisible. */
    let panes = state.get("sessions").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let (mut sessions, mut unknown) = (Vec::new(), Vec::new());
    for id in red_core::desktops::unique(listed(frame, "sessionIds")) {
        match panes.iter().find(|pane| pane.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())) {
            Some(pane) => {
                if pane.get("rootId").and_then(serde_json::Value::as_str).map(str::to_string) != roots.iter().find(|root| Some(root.as_str()) == pane.get("rootId").and_then(serde_json::Value::as_str)).cloned() {
                    return Err("Desktop session has a different root.".to_string());
                }
                sessions.push(id);
            }
            None => unknown.push(id),
        }
    }
    worker.desktops.register(
        socket,
        says,
        frame,
        red_core::desktops::Bindings { roots, sessions, unknown },
        red_core::service::uuid_v4(),
    );
    Ok(())
}

fn listed(frame: &serde_json::Value, key: &str) -> Vec<String> {
    frame
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(serde_json::Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// A desktop acting on the project token, over the socket it registered on.
///
/// A desktop has more actions than an agent does — settling, assigning, rejecting on someone's
/// behalf — so this does not narrow them the way an agent's are narrowed; the ledger judges them.
/// What is judged HERE is that the frame came from a registered desktop bound to the project.
fn desktop_token(worker: &Arc<Worker>, socket: u64, frame: &serde_json::Value) -> Result<(), String> {
    let (root, desktop) = acting(worker, socket, frame, "token actions")?;
    let Some(ledger) = &worker.ledger else {
        return Err("This workspace worker does not serve the project token ledger.".to_string());
    };
    /* An assign resolves an agent id against the conversations this project remembers, and a
       function does not cross a socket — so what a `lookup` would have answered comes with it. */
    let asked = frame.get("agentId").and_then(serde_json::Value::as_str);
    let lookup = match asked {
        Some(agent) => conversation_identity(worker, &root, agent),
        None => serde_json::Value::Null,
    };
    ledger
        .call(
            "desktop",
            serde_json::json!([root, frame.get("action"), {
                "contestId": frame.get("contestId"), "desktopId": desktop,
                "reason": frame.get("reason"), "agentId": asked, "lookup": lookup,
            }]),
        )
        .map_err(|fault| plain(&fault))?;
    push_segment(worker, &root, None);
    Ok(())
}

/// A desktop announcing a capture it started or committed (spec 081).
fn desktop_recording(worker: &Arc<Worker>, socket: u64, frame: &serde_json::Value) -> Result<(), String> {
    let (root, desktop) = acting(worker, socket, frame, "recording frames")?;
    if worker.ledger.is_none() {
        return Err("This workspace worker does not serve the project token ledger.".to_string());
    }
    let kind = match frame.get("event").and_then(serde_json::Value::as_str) {
        Some("started") => "capture.started",
        Some("committed") => "capture.committed",
        _ => return Err("A recording frame carries event started or committed.".to_string()),
    };
    let by = serde_json::json!({ "kind": "desktop", "desktopId": desktop });
    note(worker, &root, kind, &by, capture_fields(frame));
    Ok(())
}

/// The project and the desktop a frame on this socket is acting as — or why it is neither.
fn acting(worker: &Arc<Worker>, socket: u64, frame: &serde_json::Value, what: &str) -> Result<(String, String), String> {
    let root = frame.get("rootId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let Some(desktop) = worker.desktops.identify(socket) else {
        return Err(format!("Register the desktop before sending {what}."));
    };
    if !worker.desktops.bound(socket).iter().any(|bound| *bound == root) {
        return Err("That project is not bound to this desktop.".to_string());
    }
    Ok((root, desktop))
}

/// An agent the Tasks pane can list is not necessarily one the ledger has met on the wire, so a
/// desktop's assign resolves through the conversations this project remembers (spec 103).
fn conversation_identity(worker: &Arc<Worker>, root_id: &str, agent_id: &str) -> serde_json::Value {
    let Ok(state) = ask_host(worker, "GET", "/api/state", "") else { return serde_json::Value::Null };
    let listed = state.get("conversations").and_then(|held| held.get(root_id)).cloned().unwrap_or(serde_json::Value::Null);
    let empty = Vec::new();
    let Some(found) = listed
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .find(|row| row.get("id").and_then(serde_json::Value::as_str) == Some(agent_id))
    else {
        return serde_json::Value::Null;
    };
    let name: String = found
        .get("agent")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("agent")
        .chars()
        .filter(|c| (' '..='~').contains(c))
        .take(32)
        .collect();
    let name = if name.is_empty() { "agent".to_string() } else { name };
    serde_json::json!({ "agentId": agent_id, "label": format!("{name} {}", &agent_id[..agent_id.len().min(8)]) })
}

/// The pinned segment, to every desktop bound to this project — or to one of them.
fn push_segment(worker: &Arc<Worker>, root_id: &str, only: Option<u64>) {
    let Some(ledger) = &worker.ledger else { return };
    let Ok(frame) = ledger.call("segment", serde_json::json!([root_id])) else { return };
    worker.desktops.push(root_id, &frame.to_string(), only);
}

/// What a capture frame leaves on the feed. The same fields however it arrived — over this socket
/// from the desktop that recorded it, or over HTTP from a worker forwarding one.
fn capture_fields(data: &serde_json::Value) -> serde_json::Value {
    let mut fields = serde_json::json!({
        "sessionId": data.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "gameId": data.get("gameId").cloned().unwrap_or(serde_json::Value::Null),
        "recordingId": data.get("recordingId").cloned().unwrap_or(serde_json::Value::Null),
        "kind": if data.get("kind") == Some(&serde_json::json!("explicit")) { "explicit" } else { "ring" },
    });
    if let Some(at) = data.get("at").and_then(serde_json::Value::as_str) {
        fields["startedAt"] = serde_json::json!(at.chars().take(40).collect::<String>());
    }
    if let Some(error) = data.get("error").and_then(serde_json::Value::as_str) {
        fields["error"] = serde_json::json!(error.chars().take(400).collect::<String>());
    }
    fields
}

/// A refusal's sentence, with the status a socket client is never told.
fn plain(fault: &str) -> String {
    fault.split_once('|').map(|(_, message)| message.to_string()).unwrap_or_else(|| fault.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// This worker's own connection to the host's `/events`.
async fn dial_events(worker: &Worker, head: &Head) -> io::Result<WebSocketStream<TcpStream>> {
    let (address, authority) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
    let mut upstream = TcpStream::connect(&address).await?;
    upstream
        .write_all(
            format!(
                "GET {} HTTP/1.1\r\nHost: {authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
                head.replaced_target_for(&worker.host_token),
                tokio_tungstenite::tungstenite::handshake::client::generate_key()
            )
            .as_bytes(),
        )
        .await?;
    let mut buffered = Vec::new();
    let Some(answer) = Head::read(&mut upstream, &mut buffered).await? else {
        return Err(io::Error::other("the session host closed the stream"));
    };
    if !answer.raw.starts_with("HTTP/1.1 101") {
        return Err(io::Error::other("the session host refused the stream"));
    }
    /* Anything read past the head belongs to the socket, so it is handed over rather than dropped. */
    let _ = buffered;
    Ok(WebSocketStream::from_raw_socket(upstream, Role::Client, None).await)
}

/// A socket the host owns, carried through byte for byte.
///
/// Not decoded and re-encoded: a pane's bytes and a game's frames are the host's answer, and a
/// worker that parsed them would be a second opinion about a stream it has no view of.
async fn tunnel(worker: &Worker, mut client: TcpStream, buffered: Vec<u8>, head: &Head) -> io::Result<()> {
    let (address, _) = red_core::http::address(&worker.host).map_err(io::Error::other)?;
    let mut upstream = TcpStream::connect(&address).await?;
    upstream.write_all(head.replayed(&worker.host, &worker.host_token).as_bytes()).await?;
    if !buffered.is_empty() {
        upstream.write_all(&buffered).await?;
    }
    /* Both halves at once, for as long as either end has anything to say. */
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

/// A stream whose first bytes were already read off the socket while the head was being parsed.
/// Dropping them would eat the first frame of every upgrade that arrived in one packet.
struct Prefixed {
    buffered: Vec<u8>,
    inner: TcpStream,
}

impl tokio::io::AsyncRead for Prefixed {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        if !self.buffered.is_empty() {
            let take = self.buffered.len().min(buffer.remaining());
            let held: Vec<u8> = self.buffered.drain(..take).collect();
            buffer.put_slice(&held);
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl tokio::io::AsyncWrite for Prefixed {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, context: &mut std::task::Context<'_>, bytes: &[u8]) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(context, bytes)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, context: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(context)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, context: &mut std::task::Context<'_>) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

/// The routes this worker answers itself.
fn answer_own(worker: &Worker, head: &Head, body: &str) -> String {
    if red_worker::lifecycle::announces(&head.method, &head.path()) {
        announce(worker);
    }
    match (head.method.as_str(), head.path().as_str()) {
        ("GET", "/api/feed") => {
            let Some(root) = head.query("rootId").filter(|value| !value.is_empty()) else {
                return refusal(400, "Bad Request", "A project root is required to read its feed.");
            };
            let Some(ledger) = &worker.ledger else {
                return refusal(409, "Conflict", "This workspace worker does not serve the project token ledger.");
            };
            let cursor = red_worker::feed::cursor_of(head.query("after").as_deref());
            let limit = head.query("limit").and_then(|value| value.parse::<i64>().ok()).map(|limit| limit.clamp(0, 1000));
            match ledger.call("feedAfter", serde_json::json!([root, cursor, limit])) {
                Ok(read) => {
                    /* The read, plus the way to keep reading: `feed_url` composes its monitor URL
                       from `socket`, so a feed answered without one is a feed nothing can follow. */
                    let mut out = read.as_object().cloned().unwrap_or_default();
                    out.insert("rootId".to_string(), serde_json::json!(root));
                    out.insert("socket".to_string(), serde_json::json!(feed_url(worker, &root)));
                    json(200, "OK", &serde_json::Value::Object(out).to_string())
                }
                Err(fault) => faulted(&fault),
            }
        }
        ("GET", "/api/agents-menu") => {
            let Some(root) = head.query("rootId").filter(|value| !value.is_empty()) else {
                return refusal(400, "Bad Request", "A project root is required to list its agents.");
            };
            /* The host knows which roots there are and what is running in them; this worker knows
               how to run a CLI and ask it what it offers. So the menu is built here and the live
               panes come from there — the same relationship every forwarded route has. */
            let Ok(state) = ask_host(worker, "GET", "/api/state", "") else {
                return refusal(502, "Bad Gateway", "The session host did not answer.");
            };
            let empty = Vec::new();
            let roots = state.get("roots").and_then(serde_json::Value::as_array).unwrap_or(&empty);
            let Some(selected) = roots.iter().find(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(root.as_str()))
            else {
                return refusal(404, "Not Found", "Unknown project root.");
            };
            let path = selected.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let recipes = red_agents::projection(&red_agents::shipped_recipes());
            let declared = red_project::declaration::read(&path, None);
            let mut machine = Machine { root: path };
            let built = red_worker::menu::build(&root, &recipes, &declared, &mut machine);
            let short = |agent: &str, id: &str| {
                red_agents::launch::short_agent_id(&red_agents::shipped_recipes()[..], agent, id)
            };
            let live = red_worker::menu::live(
                state.get("sessions").unwrap_or(&serde_json::Value::Null),
                &root,
                &|agent, id| format!("{agent} {}", short(agent, id)),
            );
            let mut answer = built.menu.as_object().cloned().unwrap_or_default();
            answer.insert("live".to_string(), live);
            json(200, "OK", &serde_json::Value::Object(answer).to_string())
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
            let tool: String = head.query("tool").unwrap_or_default().chars().filter(|c| c.is_ascii_lowercase() || *c == '_').take(40).collect();
            match client.call("callerStatus", serde_json::json!([root, who, tool])) {
                Ok(answer) => {
                    /* The STATUS itself, with the caller and the refusal beside it — not a status
                       nested inside one, which is the service's shape and not the route's. */
                    let status = answer.get("status").cloned().unwrap_or(serde_json::Value::Null);
                    /* The workspace's OWN record of which conversations this project has (spec 097),
                       which is `state.conversations` — not `/api/conversations`, which scans a CLI's
                       rollout store for candidates and is a different question entirely. */
                    let conversations = ask_host(worker, "GET", "/api/state", "")
                        .ok()
                        .and_then(|state| state.get("conversations").and_then(|held| held.get(&root)).cloned())
                        .unwrap_or(serde_json::Value::Null);
                    let folded = red_worker::lifecycle::with_conversations(&status, &conversations, |value| {
                        value.len() == 36 && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                    });
                    let mut out = folded.as_object().cloned().unwrap_or_default();
                    out.insert("caller".to_string(), who.unwrap_or(serde_json::Value::Null));
                    out.insert("refusal".to_string(), answer.get("refusal").cloned().unwrap_or(serde_json::Value::Null));
                    out.insert("feed".to_string(), serde_json::json!(feed_url(worker, &root)));
                    json(200, "OK", &serde_json::Value::Object(out).to_string())
                }
                Err(fault) => faulted(&fault),
            }
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
                       one reply, so a caller does not read a status from before its own act.
                       The STATUS itself — `callerStatus` answers a status with a refusal beside it,
                       which is the service's shape, and a `status.status` is not one a caller reads. */
                    Ok(answered) => {
                        let status = answered.get("status").cloned().unwrap_or(answered);
                        let mut out = result.as_object().cloned().unwrap_or_default();
                        out.insert("status".to_string(), status);
                        json(200, "OK", &serde_json::Value::Object(out).to_string())
                    }
                    Err(fault) => faulted(&fault),
                },
                Err(fault) => faulted(&fault),
            }
        }
        /* The three routes that CHANGE a project, and the one that changes the workspace. Each is
           the same shape: resolve the project, ask the gate, do the work, tell the feed. */
        ("POST", "/api/update-workspace") => answered_or_faulted(update_workspace(worker, head, body)),
        ("POST", "/api/task") => answered_or_faulted(task(worker, head, body)),
        ("POST", "/api/agent-spawn") => answered_or_faulted(agent_spawn(worker, head, body)),
        ("POST", "/api/script-open") => answered_or_faulted(script_open(worker, head, body)),
        /* The three the editor pane reads and writes. All of them are about ONE FILE, and all of
           them name it the way every other route names one: a root, and a path within it. */
        /* The workspace as a caller reads it, which is the host's answer plus what having a worker
           in front of it adds: the capabilities this worker serves, and the token window, which
           lives beside the ledger rather than in the host's preference store. */
        ("GET", "/api/state") => answered_or_faulted(state(worker)),
        ("POST", "/api/preferences") => answered_or_faulted(preferences(worker, body)),
        ("POST", "/api/recording") => answered_or_faulted(recording(worker, head, body)),
        ("POST", "/api/game") => answered_or_faulted(game(worker, head, body)),
        ("POST", "/api/dashboard-run") => answered_or_faulted(dashboard_run(worker, head, body)),
        /* The tracker's sign-in, which is the worker's because the grant it writes lives beside the
           WORKSPACE state and never in the committed declaration (spec 101). */
        ("POST", "/api/tracker/signin") => answered_or_faulted(tracker_signin(worker, body)),
        ("POST", "/api/tracker/signout") => answered_or_faulted(tracker_signout(worker, body)),
        /* The desktop registry's own routes, which are the worker's because the registry is: the
           host beneath may have none of them (spec 065). */
        ("GET", "/api/desktops") => answered_or_faulted(
            root_of(worker, &head.query("rootId").unwrap_or_default())
                .map(|(root, _)| serde_json::json!({ "desktops": worker.desktops.list(&root) })),
        ),
        ("GET", "/api/runtime-desktops") => json(200, "OK", &worker.desktops.registry().to_string()),
        ("POST", "/api/desktop-action") => answered_or_faulted(desktop_action(worker, head, body)),
        ("POST", "/api/session-view") => answered_or_faulted(session_view(worker, body)),
        ("GET", "/api/diagnostics") => answered_or_faulted(diagnostics(worker, head)),
        /* Everything a PROJECT declares about itself and leaves behind, answered here and never
           forwarded — the host beneath may predate these routes, and forwarding would answer from a
           host that never had them (spec 065, KI-043). The answer is `red_project::serve`'s, which
           is also the door's, so the two cannot disagree about what a project declares. */
        (method, path) if red_project::serve::owns(method, path) => answered_or_faulted(about_project(worker, head, body)),
        ("POST", "/api/ide-mention") => answered_or_faulted(ide_mention(worker, body)),
        ("POST", "/api/ide-selection") => answered_or_faulted(ide_selection(worker, body)),
        _ => refusal(404, "Not Found", "Unknown workspace endpoint."),
    }
}

/// Updating the workspace itself: the gate is the worker's, the work is the host's.
///
/// The host serves this route and this worker only forwards it, so the gate has to intercept before
/// the forward rather than ask the host to grow one (spec 065). That is the whole of what is here.
fn update_workspace(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, _) = root_of(worker, named(&data, "rootId"))?;
    gate(worker, &root_id, "update_workspace", head)?;
    ask_host(worker, "POST", "/api/update-workspace", body)
}

/// Writing a row to the project's tracker (spec 103, decision 2).
///
/// Token-gated and serialised, in that order: the gate refuses a non-holder before the queue, so a
/// refusal never waits behind somebody else's write. The frame is minted AFTER the project's own
/// command returned rather than when it was asked for — a feed that announced a write that then
/// failed would be a feed a reader could not trust.
fn task(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, root_path) = root_of(worker, named(&data, "rootId"))?;
    let action = data.get("action").and_then(serde_json::Value::as_str);
    let by = gate(worker, &root_id, &red_worker::tasks::tool_of(action), head)?;
    let written = {
        let lock = worker.writes.of(&root_id);
        let _held = red_worker::tasks::Writes::taken(&lock);
        let declared = red_project::declaration::read(&root_path, None);
        let environment: Vec<(String, String)> = std::env::vars().collect();
        red_project::tasks::task_write(&root_id, &root_path, &declared, &data, &environment)
            .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))?
    };
    let key = written.get("key").cloned().unwrap_or(serde_json::Value::Null);
    let frame = note(worker, &root_id, red_worker::tasks::frame_of(action), &by,
        serde_json::json!({ "key": key, "action": action }));
    /* Read back through the door, which answers a local tracker itself and forwards a remote one —
       so the worker needs no tracker of its own to tell a caller what its write left behind. */
    let tracker = ask_host(worker, "GET", &format!("/api/tracker?rootId={root_id}&refresh=1"), "")
        .unwrap_or(serde_json::Value::Null);
    let mut answer = written.as_object().cloned().unwrap_or_default();
    answer.insert("sequence".to_string(), sequence_of(&frame));
    answer.insert("tracker".to_string(), tracker);
    Ok(serde_json::Value::Object(answer))
}

/// Starting an agent CLI on a task, in a pane (spec 103).
///
/// The refusals come first and each is one a caller can act on — `spawn`'s three decisions — and
/// then nothing is started until every one of them has passed. What makes the ORDER matter is that
/// this route launches a process: a caller that gets a refusal here can be certain nothing ran.
fn agent_spawn(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, root_path) = root_of(worker, named(&data, "rootId"))?;
    let by = gate(worker, &root_id, "spawn_agent", head)?;
    let state = ask_host(worker, "GET", "/api/state", "")?;
    red_worker::spawn::host_can_spawn(&state).map_err(refused)?;
    let agent = red_worker::spawn::agent_name(data.get("agent").and_then(serde_json::Value::as_str)).map_err(refused)?;
    let brief = data.get("brief").and_then(serde_json::Value::as_str).unwrap_or("task").to_string();
    let listed = ask_host(worker, "GET", &format!("/api/tracker?rootId={root_id}"), "")?;
    let row = red_worker::tasks::row_of(&listed, data.get("taskKey")).map_err(refused)?;
    let recipes = red_agents::projection(&red_agents::shipped_recipes());
    let model = data.get("model").and_then(serde_json::Value::as_str);
    let mut args = red_project::tasks::model_args(&recipes, &agent, model)
        .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))?;
    /* The CLI's own initial prompt is a positional argument after the model flag, which is how both
       of the CLIs that take one take it. The pane's launcher appends these after the MCP wiring. */
    let written = red_project::tasks::prompt_for(&root_path, &brief, &red_project::tasks::prompt_values(&row), &shipped_prompts())
        .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))?;
    args.push(written.get("text").and_then(serde_json::Value::as_str).unwrap_or_default().to_string());
    let mut payload = serde_json::json!({ "rootId": root_id, "type": "agent", "agent": agent, "action": "launch", "args": args });
    /* Named here rather than left to the host, and only for a CLI that accepts being told which
       conversation to start: one that can only resume, or that names its own, is started unnamed
       and records none — never a refusal for a spawn that named nothing the caller chose. */
    if red_worker::spawn::names_the_conversation(&recipes, &agent) {
        payload["conversation"] = serde_json::json!(red_core::service::uuid_v4());
    }
    let session = ask_host(worker, "POST", "/api/terminal", &payload.to_string())?;
    let conversation = session.get("conversation").cloned().filter(|value| !value.is_null());
    if let Some(conversation) = &conversation {
        let told = serde_json::json!({ "id": session.get("id"), "conversation": conversation,
            "agent": agent, "task": row.get("key") });
        ask_host(worker, "POST", "/api/agent-conversation", &told.to_string())?;
    }
    let frame = note(worker, &root_id, "agent.spawned", &by, serde_json::json!({
        "taskKey": row.get("key"), "agent": agent, "model": model,
        "conversation": conversation, "sessionId": session.get("id"),
    }));
    let mut answer = serde_json::Map::new();
    answer.insert("rootId".to_string(), serde_json::json!(root_id));
    answer.insert("taskKey".to_string(), row.get("key").cloned().unwrap_or(serde_json::Value::Null));
    answer.insert("agent".to_string(), serde_json::json!(agent));
    answer.insert("model".to_string(), serde_json::json!(model));
    answer.insert("brief".to_string(), serde_json::json!(brief));
    answer.insert("conversation".to_string(), conversation.unwrap_or(serde_json::Value::Null));
    answer.insert("session".to_string(), session.clone());
    answer.insert("sequence".to_string(), sequence_of(&frame));
    Ok(shown(worker, &data, &root_id, &session, serde_json::Value::Object(answer),
        "The agent pane was started and is retained. Use show_session; do not spawn it again."))
}

/// Opening a project script as an interactive tab.
///
/// The rules are `scripts`'s and are judged on the RESOLVED path. What is here is the rest of the
/// route: the gate, the pane, and the desktop that shows it.
fn script_open(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, root_path) = root_of(worker, named(&data, "rootId"))?;
    gate(worker, &root_id, "open_script", head)?;
    /* The same rules a declared action's env is judged by, asked of the one implementation of them.
       `env` is read as a FIELD rather than as a value, so an absent one and a null one stay
       different answers — a caller that sent nothing is not a caller that sent nothing valid. */
    if data.get("env").is_some() {
        if let Some(problem) = red_project::rules::env_rules(data.get("env"), "env").first() {
            return Err(format!("400|Script env: {problem}"));
        }
    }
    /* The desktop FIRST, before the path is even looked at: a caller whose desktop cannot show a
       script tab is told to update it, rather than told a moment later that the pane it started
       is unattachable. The order is the JavaScript's, and it is what a person reads. */
    if let Some(desktop) = data.get("desktopId").and_then(serde_json::Value::as_str) {
        worker.desktops.may(&root_id, desktop, "attach-session")?;
    }
    let resolve = |path: &std::path::Path| std::fs::canonicalize(path).ok();
    let script = red_worker::scripts::script_path(std::path::Path::new(&root_path), data.get("path").and_then(serde_json::Value::as_str), &resolve)
        .map_err(|refused| format!("{}|{}", refused.status, refused.message))?;
    /* A directory is not a script, and only the filesystem knows which this is. */
    if !script.is_file() {
        return Err("403|Script escapes the bound project.".to_string());
    }
    let arguments = red_worker::scripts::script_arguments(data.get("args"))
        .map_err(|refused| format!("{}|{}", refused.status, refused.message))?;
    let mut args = vec![script.to_string_lossy().to_string()];
    args.extend(arguments);
    let payload = serde_json::json!({ "rootId": root_id, "command": red_project::command::bash_path(),
        "args": args, "env": data.get("env").cloned().unwrap_or_else(|| serde_json::json!({})) });
    let mut session = ask_host(worker, "POST", "/api/terminal", &payload.to_string())?;
    let name = script.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    if let Some(record) = session.as_object_mut() {
        record.insert("title".to_string(), serde_json::json!(format!("Script · {name}")));
    }
    Ok(shown(worker, &data, &root_id, &session, serde_json::json!({ "session": session }),
        "The script was started and is retained. Use show_session; do not launch it again."))
}

/// Show a pane this route just started in the desktop the caller named, if it named one.
///
/// **A failure to show is reported, never retried.** The pane is already running and retained, so a
/// caller that tried again would start a second one — which is why the detail says so in words.
fn shown(
    worker: &Worker,
    data: &serde_json::Value,
    root_id: &str,
    session: &serde_json::Value,
    answer: serde_json::Value,
    detail: &str,
) -> serde_json::Value {
    let Some(desktop) = data.get("desktopId").and_then(serde_json::Value::as_str) else { return answer };
    let mut answer = answer.as_object().cloned().unwrap_or_default();
    match show(worker, root_id, desktop, session) {
        Ok(view) => {
            answer.insert("view".to_string(), view);
        }
        Err(fault) => {
            let message = fault.split_once('|').map(|(_, message)| message).unwrap_or(&fault);
            answer.insert("view".to_string(), serde_json::json!({ "status": "not_attached", "error": message }));
            answer.insert("detail".to_string(), serde_json::json!(detail));
        }
    }
    serde_json::Value::Object(answer)
}

/// What the language servers have said about one file, for the editor pane to draw.
///
/// The version lets a poller skip a render: the desktop asks twice a second and almost always gets
/// told nothing changed. **`since` is asked for by presence, not by value** — `Number(null)` is 0
/// and a version starts at 0, so a caller that omitted it was being told nothing had changed since
/// a version it never held.
///
/// One call, and the version it answers is current: asking for the version first and the items
/// afterwards would hand a poller a version drawn before the publish it is waiting for.
fn diagnostics(worker: &Worker, head: &Head) -> Result<serde_json::Value, String> {
    let (root_id, root_path) = root_of(worker, &head.query("rootId").unwrap_or_default())?;
    let declared = red_project::declaration::read(&root_path, None);
    let servers = worker.servers.of(&root_id, &root_path, &declared)?;
    let file = red_worker::editing::file_in(&root_path, head.query("path").as_deref());
    let answer = servers.diagnostics(&red_worker::editing::uri_for(&file))?;
    let version = answer.get("version").cloned().unwrap_or(serde_json::Value::Null);
    let since = head.query("since").and_then(|value| value.parse::<i64>().ok());
    if since.is_some() && since == version.as_i64() {
        return Ok(serde_json::json!({ "version": version, "unchanged": true }));
    }
    Ok(serde_json::json!({
        "version": version,
        "items": answer.get("items").cloned().unwrap_or_else(|| serde_json::json!([])),
        "unavailable": answer.get("unavailable").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// The person pressed a button that says so. Deliberate, unlike the selection stream, and the CLI
/// treats the two differently.
fn ide_mention(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (_, root_path) = root_of(worker, named(&data, "rootId"))?;
    let file = red_worker::editing::file_in(&root_path, data.get("path").and_then(serde_json::Value::as_str));
    let Some(bridge) = &worker.bridge else { return Ok(serde_json::json!({ "delivered": 0 })) };
    let sent = bridge.mention(serde_json::json!({
        "filePath": file,
        "lineStart": data.get("lineStart"),
        "lineEnd": data.get("lineEnd"),
    }));
    Ok(serde_json::json!({ "delivered": red_worker::editing::delivered(sent) }))
}

/// The desktop reports a fact about itself — which file, which range — and this turns it into the
/// notification a connected CLI understands.
///
/// The path is resolved here because ROOTS live here: the desktop names a root and a path within
/// it, as every other route does.
fn ide_selection(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, root_path) = root_of(worker, named(&data, "rootId"))?;
    let file = red_worker::editing::file_in(&root_path, data.get("path").and_then(serde_json::Value::as_str));
    /* The buffer the person is looking at, not the file on disk: the desktop sends what it holds and
       that is what the servers are told, so a diagnostic describes the unsaved edit. */
    let opened = match data.get("buffer").and_then(serde_json::Value::as_str) {
        Some(buffer) => {
            let declared = red_project::declaration::read(&root_path, None);
            worker
                .servers
                .of(&root_id, &root_path, &declared)
                .and_then(|servers| servers.open(&file, buffer))
                .ok()
                .and_then(|answer| answer.get("servers").cloned())
        }
        None => None,
    };
    let sent = match &worker.bridge {
        Some(bridge) => bridge.selection(serde_json::json!({
            "filePath": file,
            "text": data.get("text").cloned().unwrap_or_else(|| serde_json::json!("")),
            "selection": data.get("selection"),
        })),
        None => Ok(serde_json::json!(0)),
    };
    Ok(serde_json::json!({
        "delivered": red_worker::editing::delivered(sent),
        "servers": opened.unwrap_or_else(|| serde_json::json!([])),
    }))
}

/// `POST /api/dashboard-run`: a button on the project's board, pressed.
///
/// An action is one of three things and each becomes something different, which is why this cannot
/// be a forward. A **game** action is a launch and takes the launch's refusals and its attribution.
/// A **device-bound** one — the owner's "deploying to the box", named generally as any action whose
/// declared device is not this machine — becomes a pane whose SESSION bounds a pair on the feed. And
/// an ordinary one becomes a pane and nothing else.
fn dashboard_run(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let (root_id, root_path) = root_of(worker, named(&data, "rootId"))?;
    let by = gate(worker, &root_id, "dashboard_run", head)?;
    let record = root_record(worker, &root_id)?;
    let declaration_file = record.get("declarationFile").and_then(serde_json::Value::as_str).map(str::to_string);
    let environment: Vec<(String, String)> = std::env::vars().collect();
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_millis() as i64).unwrap_or(0);
    let declared = red_project::declaration::read(&root_path, declaration_file.as_deref());
    let context = red_project::devices::Context {
        root_id: &root_id,
        root_path: &root_path,
        environment: &environment,
        probes: &worker.probes,
        refresh: false,
        refreshed: Default::default(),
        controls: false,
        now: &now,
    };
    let action = red_project::dashboard::dashboard_action(&context, &declared, data.get("actionId").and_then(serde_json::Value::as_str))
        .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))?;

    /* A game action IS a launch, so it takes the launch's route rather than a copy of it: the
       preflight, the old-host refusal, the queued asker and the attribution are all one thing. */
    if action.get("kind").and_then(serde_json::Value::as_str) == Some("game") {
        let asked = serde_json::json!({
            "rootId": root_id,
            "gameId": action.get("game").cloned().unwrap_or(serde_json::Value::Null),
            "args": action.get("args").cloned().unwrap_or_else(|| serde_json::json!([])),
        });
        return game(worker, head, &asked.to_string());
    }

    let payload = red_project::dashboard::run_payload(&root_id, &root_path, &red_project::command::bash_path(), &action)
        .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))?;
    let created = ask_host(worker, "POST", "/api/terminal", &payload.to_string())?;
    let session_id = created.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    /* The owner's "deploying to the device", named generally: any action whose declared device is
       not this machine is device-bound, and its session bounds the pair. */
    let device = action.get("device").filter(|device| !device.is_null());
    let remote = device.and_then(|device| device.get("kind")).and_then(serde_json::Value::as_str);
    if !session_id.is_empty() && remote.is_some_and(|kind| kind != red_project::devices::LOCAL) {
        let device = device.expect("a device");
        let fields = serde_json::json!({
            "sessionId": session_id,
            "actionId": action.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "deviceId": device.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "kind": device.get("kind").cloned().unwrap_or(serde_json::Value::Null),
        });
        worker.launches.device_action(&session_id, &root_id, &by, &fields);
        note(worker, &root_id, "device-action.started", &by, fields);
    }
    let mut answer = created.as_object().cloned().unwrap_or_default();
    /* The retained host may predate session titles, so the one this composed is the one answered. */
    if let Some(title) = payload.get("title") {
        answer.insert("title".to_string(), title.clone());
    }
    Ok(serde_json::Value::Object(answer))
}

/// `POST /api/desktop-action`: the only action the workspace takes here is a reload, and an unknown
/// one is refused by name rather than passed to a desktop that would not understand it.
fn desktop_action(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    if data.get("action").and_then(serde_json::Value::as_str) != Some("reload") {
        return Err("400|Unknown desktop action.".to_string());
    }
    let (root, _) = root_of(worker, named(&data, "rootId"))?;
    gate(worker, &root, "reload_desktop", head)?;
    worker.desktops.act(&root, named(&data, "desktopId"), "reload", serde_json::Value::Null, &red_core::service::uuid_v4)
}

/// `POST /api/session-view`: show a retained pane in a named desktop's own tab.
///
/// What travels is the pane RECORD, because a desktop told only an id would have to ask for it back,
/// and the one thing it must not do between being asked and answering is make another round trip.
fn session_view(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let session = ask_host(worker, "GET", &format!("/api/session?id={}", named(&data, "id")), "")
        .map_err(|_| "404|Unknown session.".to_string())?;
    show(worker, named(&data, "rootId"), named(&data, "desktopId"), &session)
}

/// The same attach, for a route that has just started the pane it is showing.
fn show(worker: &Worker, root_id: &str, desktop_id: &str, session: &serde_json::Value) -> Result<serde_json::Value, String> {
    /* The pane's own root, not the caller's claim about it: a desktop bound to one project must
       never be handed another's pane, and only the record knows which it is. */
    if session.get("rootId").and_then(serde_json::Value::as_str) != Some(root_id) {
        return Err("403|Session belongs to another root.".to_string());
    }
    worker.desktops.act(
        root_id,
        desktop_id,
        "attach-session",
        serde_json::json!({ "session": session }),
        &red_core::service::uuid_v4,
    )
}

/// Start a browser sign-in for this project's tracker.
///
/// Before an application is registered there is nothing to open, so the answer is **what to do**
/// rather than a refusal: a person who has never done this has no other way to find out.
fn tracker_signin(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let (state_directory, project) = tracker_context(worker, body)?;
    if red_project::tracker_auth::client(&state_directory).is_none() {
        return Ok(serde_json::json!({ "ok": false, "setup": red_project::tracker_auth::setup_instructions(&state_directory) }));
    }
    worker.signing_in.begin(&state_directory, &project, Box::new(|_outcome| {}))
}

/// Sign out: drop the grant, telling the provider if it can be reached.
fn tracker_signout(worker: &Worker, body: &str) -> Result<serde_json::Value, String> {
    let (state_directory, project) = tracker_context(worker, body)?;
    worker.signing_in.cancel();
    red_project::tracker_auth::revoke(&state_directory, &project)
        .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))
}

/// Where the credential lives, and what this project is called in it.
///
/// The project's own name, not its root id: a checkout moved or re-added keeps its tracker, because
/// the declaration is what names the project and the root id is this workspace's bookkeeping.
fn tracker_context(worker: &Worker, body: &str) -> Result<(String, String), String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let asked = named(&data, "rootId").to_string();
    let record = root_record(worker, &asked)?;
    let root_path = record.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let declaration_file = record.get("declarationFile").and_then(serde_json::Value::as_str).map(str::to_string);
    let state = ask_host(worker, "GET", "/api/state", "")?;
    let instance = state.get("instance").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let directory = red_worker::signin::host_state_directory(&state, &instance, &process_table())
        .map_err(|why| format!("409|{}", red_worker::signin::unknown_directory(&why)))?;
    let declared = red_project::declaration::read(&root_path, declaration_file.as_deref());
    let project = declared
        .get("project")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(&asked)
        .to_string();
    Ok((directory, project))
}

/// A tracker somebody else's server holds.
///
/// Without the workspace's state directory no credential was looked for, so "not signed in" would be
/// a GUESS: the answer says the directory is unknown instead, and the local backend still reads.
fn remote_tracker(worker: &Worker, root_id: &str, root_path: &str, declaration_file: Option<&str>, refresh: bool) -> Result<serde_json::Value, String> {
    let declared = red_project::declaration::read(root_path, declaration_file);
    let state = ask_host(worker, "GET", "/api/state", "")?;
    let instance = state.get("instance").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0);
    let directory = match red_worker::signin::host_state_directory(&state, &instance, &process_table()) {
        Ok(directory) => directory,
        Err(why) => {
            let mut answer = red_project::tracker::project_tracker(root_id, root_path, &serde_json::json!({}))
                .as_object()
                .cloned()
                .unwrap_or_default();
            answer.insert("provider".to_string(), declared.get("tracker").and_then(|block| block.get("provider")).cloned().unwrap_or(serde_json::Value::Null));
            answer.insert("rows".to_string(), serde_json::json!([]));
            answer.insert("unavailable".to_string(), serde_json::json!(red_worker::signin::unknown_directory(&why)));
            return Ok(serde_json::Value::Object(answer));
        }
    };
    /* The declared project NAME, which is what the token file is keyed by — so a checkout that moved
       or was re-added keeps its tracker. */
    let identity = declared
        .get("project")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(root_id)
        .to_string();
    /* A signed-in grant is refreshed before it lapses; a pasted personal key never expires and is
       handed back untouched. */
    let grant = red_project::tracker_auth::stored(&directory, &identity).map(|grant| {
        if red_project::tracker_auth::expiring(&grant, now) {
            red_project::tracker_auth::refresh(&directory, &identity, &grant, now)
        } else {
            grant
        }
    });
    let token = grant.as_ref().and_then(|grant| grant.get("accessToken").and_then(serde_json::Value::as_str).map(str::to_string));
    Ok(red_project::tracker::remote_tracker(
        root_id,
        root_path,
        &declared,
        token.as_deref(),
        &red_project::tracker_remote::Network,
        &worker.trackers,
        refresh,
        now,
    ))
}

/// The process table, or nothing — which is an answer a caller can act on rather than a crash.
fn process_table() -> String {
    std::process::Command::new("ps")
        .args(["-A", "-ww", "-o", "pid=,ppid=,command="])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
        .unwrap_or_default()
}

/// The same request, asked about a different route.
///
/// A launch runs the project's own preflight first, and that preflight IS `/api/game-config` — so
/// it is asked for by name rather than reached into, and there is one path from a declaration to a
/// refusal however a caller arrives at it.
fn head_for(head: &Head, path: &str, data: &serde_json::Value) -> Head {
    let mut query = vec![format!("rootId={}", named(data, "rootId"))];
    if let Some(game) = data.get("gameId").and_then(serde_json::Value::as_str) {
        query.push(format!("gameId={game}"));
    }
    Head {
        raw: head.raw.clone(),
        method: "GET".to_string(),
        target: format!("{path}?{}", query.join("&")),
        headers: head.headers.clone(),
        upgrade: false,
    }
}

/// One project route, answered from the project itself.
///
/// The worker keeps its own probe cache, which is the honest life for one: a probe answers for as
/// long as the process that took it, and a replaced worker should ask again rather than repeat what
/// a worker that is gone believed about a device.
fn about_project(worker: &Worker, head: &Head, body: &str) -> Result<serde_json::Value, String> {
    let data: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let asked = head
        .query("rootId")
        .or_else(|| data.get("rootId").and_then(serde_json::Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let root = root_record(worker, &asked)?;
    /* One of these WRITES — a capture puts a file in the project — and it is gated for that reason.
       Answering it here rather than forwarding it is what made this necessary: the gate was on the
       way past, and there is no way past any more. */
    if let Some(tool) = red_worker::serve::gates_internally(&head.method, &head.path()) {
        gate(worker, &asked, tool, head)?;
    }
    let root_path = root.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let declaration_file = root.get("declarationFile").and_then(serde_json::Value::as_str).map(str::to_string);
    let path = head.path();
    /* A remote tracker is answered HERE too, and it is the clearest case for why: the retained host
       beneath may have no tracker route at all, so forwarding would answer 404 for a project whose
       tasks are perfectly readable. The credential lives beside the WORKSPACE state, which is why
       this is the worker's rather than the project's (spec 101). */
    if path == "/api/tracker" && !red_project::serve::local_tracker(&root_path, declaration_file.as_deref()) {
        return remote_tracker(worker, &asked, &root_path, declaration_file.as_deref(), head.query("refresh").as_deref() == Some("1"));
    }
    let environment: Vec<(String, String)> = std::env::vars().collect();
    red_project::serve::route(&red_project::serve::Asked {
        root_id: &asked,
        root_path: &root_path,
        declaration_file: declaration_file.as_deref(),
        path: &path,
        data: &data,
        query: &|name: &str| head.query(name),
        query_last: &|name: &str| head.query_last(name),
        environment: &environment,
        probes: &worker.probes,
    })
    .map_err(|fail| format!("{}|{}", fail.status.unwrap_or(500), fail.message))
}

/// The briefs rEngine ships, beside the registry it ships.
fn shipped_prompts() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(|checkout| checkout.join("orchestrator/templates/prompts")))
        .unwrap_or_default()
}

/// A field a route names a project by.
fn named<'a>(data: &'a serde_json::Value, field: &str) -> &'a str {
    data.get(field).and_then(serde_json::Value::as_str).unwrap_or_default()
}

/// One of this crate's own refusals, as the `status|message` every service here answers with.
fn refused<R: Refusing>(refused: R) -> String {
    format!("{}|{}", refused.status(), refused.message())
}

/// The two refusal types this binary composes, said once. They are separate types because they are
/// separate decisions — what a spawn may do, and what a script may be — and neither borrows the
/// other's statuses.
trait Refusing {
    fn status(&self) -> u16;
    fn message(&self) -> String;
}

impl Refusing for red_worker::spawn::Refused {
    fn status(&self) -> u16 {
        self.status
    }
    fn message(&self) -> String {
        self.message.clone()
    }
}

impl Refusing for red_worker::tasks::Refused {
    fn status(&self) -> u16 {
        self.status
    }
    fn message(&self) -> String {
        self.message.clone()
    }
}

/// A composed route's answer, or its refusal with the status it chose.
fn answered_or_faulted(result: Result<serde_json::Value, String>) -> String {
    match result {
        Ok(value) => json(200, "OK", &value.to_string()),
        Err(fault) => faulted(&fault),
    }
}

/// Running the CLIs a menu has to ask. Bounded the way the JavaScript bounds them: eight seconds
/// and a quarter-megabyte, and a CLI that does not answer contributes nothing rather than failing.
struct Machine {
    root: String,
}

impl red_worker::menu::Ask for Machine {
    fn installed(&mut self) -> String {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(std::path::Path::parent)
            .map(|checkout| checkout.join("scripts/agent.sh"))
            .unwrap_or_default();
        bounded("/bin/bash", &[&script.to_string_lossy(), "--project", &self.root, "--action", "list"])
    }

    fn help(&mut self, cli: &str) -> String {
        bounded(cli, &["--help"])
    }
}

/// One process, with a deadline and a cap. Its failure is an empty answer, because a CLI that will
/// not describe itself is a CLI with nothing to add to a menu — not a reason to refuse one.
fn bounded(file: &str, args: &[&str]) -> String {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(file).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
    else {
        return String::new();
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(red_worker::menu::HELP_TIMEOUT_MS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            /* Past its deadline, or unwaitable: killed, and whatever it managed to say is dropped —
               a half-written help is not a model list. */
            _ => {
                let _ = child.kill();
                return String::new();
            }
        }
    }
    let mut text = String::new();
    if let Some(out) = child.stdout.take() {
        use std::io::Read;
        let mut buffer = Vec::new();
        let _ = out.take(red_worker::menu::HELP_LIMIT as u64).read_to_end(&mut buffer);
        text = String::from_utf8_lossy(&buffer).to_string();
    }
    text
}

/// The project this request named, as the host knows it: its id and its path on disk.
///
/// Asked of the host every time rather than cached, because roots are the WORKSPACE's and a project
/// added since this worker started is one a caller may legitimately name.
fn root_of(worker: &Worker, id: &str) -> Result<(String, String), String> {
    let found = root_record(worker, id)?;
    Ok((
        id.to_string(),
        found.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
    ))
}

/// The project as the WORKSPACE records it: its id, its path, and the declaration it was registered
/// with where that is not the default one.
fn root_record(worker: &Worker, id: &str) -> Result<serde_json::Value, String> {
    let state = ask_host(worker, "GET", "/api/state", "")?;
    let empty = Vec::new();
    state
        .get("roots")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .find(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(id))
        .cloned()
        .ok_or_else(|| "404|Unknown project root.".to_string())
}

/// The token gate: may this caller do this, on this project?
///
/// A request with no agent header is the DESKTOP's, and the desktop is never gated (spec 095,
/// decision 6) — the header is arbitration among cooperating agents, not authentication. So a
/// caller that named nobody passes, and what comes back is who the feed will say did it.
fn gate(worker: &Worker, root_id: &str, tool: &str, head: &Head) -> Result<serde_json::Value, String> {
    let who = identity_of(head);
    let Some(ledger) = &worker.ledger else {
        /* No ledger to arbitrate with: the JavaScript lets the call through for the same reason it
           lets an unidentified one through — there is nothing to be refused BY. The routes that
           cannot work without one refuse on their own account. */
        return Ok(actor(who, head));
    };
    let Some(who) = who else { return Ok(actor(None, head)) };
    let answer = ledger.call("gate", serde_json::json!([root_id, who, tool]))?;
    match answer.get("refusal").and_then(serde_json::Value::as_str) {
        Some(refusal) => Err(format!("409|{refusal}")),
        None => Ok(actor(Some(who), head)),
    }
}

/// Who the feed will say did this. An agent by its id and label; otherwise the person at a desktop,
/// named when a retired worker is carrying their frame and anonymous when they are here themselves.
fn actor(who: Option<serde_json::Value>, head: &Head) -> serde_json::Value {
    match who {
        Some(who) => serde_json::json!({
            "kind": "agent",
            "agentId": who.get("agentId").cloned().unwrap_or(serde_json::Value::Null),
            "label": who.get("label").cloned().unwrap_or(serde_json::Value::Null),
        }),
        None => match red_worker::identity::desktop(|name| head.header(name)) {
            Some(desktop) => serde_json::json!({ "kind": "desktop", "desktopId": desktop }),
            None => serde_json::json!({ "kind": "desktop" }),
        },
    }
}

/// A frame on this project's feed, minted and persisted. `None` when there is no ledger to mint it
/// on, which is not an error: the route's own work is done and the frame is what announced it.
fn note(worker: &Worker, root_id: &str, kind: &str, by: &serde_json::Value, fields: serde_json::Value) -> Option<serde_json::Value> {
    let ledger = worker.ledger.as_ref()?;
    let frame = ledger.call("frame", serde_json::json!([root_id, kind, by, fields])).ok()?;
    let _ = ledger.call("persist", serde_json::json!([root_id]));
    Some(frame)
}

/// The sequence a frame landed at, as a route answers it: the number a caller reads the feed from.
fn sequence_of(frame: &Option<serde_json::Value>) -> serde_json::Value {
    frame
        .as_ref()
        .and_then(|frame| frame.get("sequence").cloned())
        .unwrap_or(serde_json::Value::Null)
}

/// One question for the session host, answered as JSON.
fn ask_host(worker: &Worker, method: &str, route: &str, body: &str) -> Result<serde_json::Value, String> {
    if method == "GET" {
        red_core::http::get(&worker.host, &worker.host_token, route)
    } else {
        red_core::http::post(&worker.host, &worker.host_token, route, &serde_json::from_str(body).unwrap_or(serde_json::Value::Null), &[])
    }
}

/// Who this request says it is, for a route that records a name.
fn identity_of(head: &Head) -> Option<serde_json::Value> {
    red_worker::identity::agent(|name| head.header(name))
}

/// A refusal that arrived as `status|message`, which is how every service here answers one.
fn faulted(fault: &str) -> String {
    match fault.split_once('|') {
        Some((status, message)) => refusal(status.parse().unwrap_or(500), "Error", message),
        None => refusal(500, "Error", fault),
    }
}

/// Who may speak to this worker.
///
/// **On an UPGRADE the query's token is the credential, and any header is ignored.** A browser
/// cannot set a header on an upgrade, so the token rides in the query — and the layer above this one
/// forwards the socket with its OWN `Authorization` header still attached, because that is the
/// header the client sent it. A check that preferred the header would refuse every socket that
/// arrived through a proxy, which is every socket in a running workspace. The JavaScript worker
/// wrote the query's token over the header before checking, which is the same rule said differently.
fn authorized(worker: &Worker, head: &Head) -> bool {
    let presented = if head.upgrade {
        head.query("token")
    } else {
        head.header("authorization").and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
    };
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
