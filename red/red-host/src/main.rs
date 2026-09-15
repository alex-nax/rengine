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
mod games;
mod handoff;
mod images;
mod panes;
mod routes;
mod surface_socket;
mod surfaces;

use red_core::desktops::Desktops;
use events::Hub;
use red_core::head::Head;
use routes::{answer_about_pane, answer_desktop_action, answer_from_store, answer_state, faulted, http_json, session_route, store_route};

/// The number `pty-client.mjs` speaks: a service on another number belongs to another build, and
/// this door refuses it the way a host does rather than guessing at its answers.
const PTY_PROTOCOL: u64 = 2;
const STORE_PROTOCOL: u64 = 1;
/// The ledger service's protocol, as `token-client.mjs` names it.
const TOKEN_PROTOCOL: u64 = 1;

const USAGE: &str = "usage: red-host --state <dir> --backend <url> --backend-token <token> [--port N] [--pid N]";

impl Front {
    /// The next surface viewer's number.
    fn next_viewer(&self) -> u64 {
        self.viewers.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }
}

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
    /// Where the ledger this door pushes segments from lives, once a worker has said.
    ///
    /// The ledger is in the WORKER's directory rather than this one — an accident of which
    /// `--state` each process was given, and spec 143 recommends moving it here beside the store and
    /// the PTYs. Until that move, the worker says where it is on its way up: it is the process that
    /// knows, and the door is the process that needs to know. One call, replaced by nothing when the
    /// ledger moves.
    ledger_directory: Mutex<Option<String>>,
    /// The directory's token ledger, attached for the desktop's sake alone (spec 095, spec 143).
    ///
    /// The worker owns the token's ROUTES; the door owns the desktop's view of it, because the
    /// registry is the door's and the pinned status-bar segment is pushed over the socket a desktop
    /// registered on. That is what lets the segment never poll — and, with the registry here rather
    /// than in a worker, what makes a worker being replaced something no desktop can notice.
    ///
    /// Attached lazily, because at start-up there is no worker yet and so no ledger to attach to.
    tokens: Mutex<Option<red_core::service::Client>>,
    /// Roots whose segment is wanted, for the task that does the asking: the client's event callback
    /// runs on the client's own reader and a call from there would be the reader waiting for itself.
    wants: tokio::sync::mpsc::UnboundedSender<String>,
    /// The surfaces games stream into (F155, spec 142): the loopback listener this door opened, the
    /// reservations it has minted, and the viewers attached to each. `None` when the listener could
    /// not be opened, and then a game that streams into a pane is refused rather than launched
    /// blind — a pane with no surface behind it is a black rectangle with no way to say why.
    surfaces: Option<crate::surfaces::Surfaces>,
    /// Numbers a surface viewer, so an eviction can name an owner without holding its socket.
    viewers: std::sync::atomic::AtomicU64,
    /// The token this workspace's clients present. The backend has its own, and this process never
    /// hands a client the backend's.
    token: String,
    instance: String,
    /// The directory this door serves, said out loud in `/api/state` for the layer above (spec 101).
    state: String,
    url: String,
    backend: String,
    backend_token: String,
    /// The device probes this door has taken, kept for as long as it is running.
    ///
    /// A probe is a bounded spawn against a box that may be unreachable, so one listing must cost
    /// one probe per device and not one per action. The JavaScript kept this in the worker; a door
    /// is the longer-lived of the two, so keeping it here is the same optimisation with a longer
    /// life — and the worker's client keeps its own for the routes it still answers.
    probes: red_project::devices::Probes,
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
    /* Opened before the PTY client, because the pane events that client delivers are how a
       reservation LEARNS its game is gone (F155, spec 142). */
    let surfaces = match crate::surfaces::Surfaces::listen().await {
        Ok(surfaces) => Some(surfaces),
        Err(error) => {
            eprintln!("red-host: no surface listener ({error}). Games that stream into a pane will be refused.");
            None
        }
    };
    let releasing = surfaces.clone();
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
                    /* A game that has exited has no more pictures to send: the reservation goes and
                       its viewers are closed, rather than left watching one that will never change
                       again. `games.mjs` did this on the same event. */
                    if session.get("state").and_then(serde_json::Value::as_str) == Some("exited") {
                        if let Some(surfaces) = &releasing {
                            if let Some(token) = surfaces.token_of(id) {
                                for viewer in surfaces.remove(&token) {
                                    let _ = viewer.send(crate::surfaces::ToViewer::Text(
                                        serde_json::json!({ "type": "closed", "reason": "Game session exited" }).to_string(),
                                    ));
                                }
                            }
                        }
                    }
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
    /* The registry exists before the ledger client does, because the client's event callback pushes
       INTO it: the service starts pushing the moment it is attached, and a desktop that registered
       in that instant would miss the first transition. */
    let desktops = Desktops::new();
    /* The callback cannot ASK the ledger — it runs on the client's own reader, and a call from
       there would be the reader waiting for itself. So it names the project and a task does the
       asking. */
    let (wants, mut wanted) = tokio::sync::mpsc::unbounded_channel::<String>();
    let front = Arc::new(Front {
        store,
        pty,
        panes,
        hub: hub.clone(),
        desktops,
        ledger_directory: Mutex::new(None),
        tokens: Mutex::new(None),
        wants,
        surfaces,
        viewers: std::sync::atomic::AtomicU64::new(0),
        token: secret(),
        instance: uuid_v4(),
        state: options.state.clone(),
        url: format!("http://127.0.0.1:{port}"),
        backend: options.backend.clone(),
        backend_token: options.backend_token.clone(),
        probes: red_project::devices::Probes::default(),
    });
    {
        let front = front.clone();
        tokio::spawn(async move {
            while let Some(root) = wanted.recv().await {
                push_segment(&front, &root, None).await;
            }
        });
    }
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
        /* Pressing a dashboard action that becomes a terminal (F156). `None` is the door declining
           a GAME action, which reserves a workspace surface the session host owns. */
        /* Chunked framing is not read here: `read_body_bytes` frames by `content-length`, so a
           chunked request would be read as empty and its bytes then parsed as the next request's
           head. This route may DECLINE, and a declined request has to reach the forwarder whole —
           `forward_body` copies chunked framing correctly, so an unframed body is left to it. */
        if head.path() == "/api/dashboard-run"
            && head.method == "POST"
            && !head.header("transfer-encoding").is_some_and(|value| value.to_ascii_lowercase().contains("chunked"))
        {
            let body = head.read_body_bytes(&mut client, &mut buffered).await?;
            match panes::dashboard_run(&front, &String::from_utf8_lossy(&body)).await {
                Some(answer) => {
                    client.write_all(answer.as_bytes()).await?;
                    if !head.keeps_alive() { return Ok(()); }
                    continue;
                }
                None => {
                    /* Declined after the body was read. Those bytes are off the socket now, so they
                       go back in front of whatever is still buffered — the forwarder frames what it
                       sends from `content-length`, and it must find the same request here. */
                    let mut restored = body;
                    restored.append(&mut buffered);
                    buffered = restored;
                }
            }
        }
        /* The last route the JS host uniquely served (F155, spec 142). It is here rather than
           forwarded because everything it needs is already this door's: the preflight from
           `red_project`, the pane records it holds, the PTY service it spawns through, and the
           surface listener it opened. */
        if head.path() == "/api/game" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = games::launch(&front, &body).await;
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
        /* What the project itself declares and leaves behind (F156). The last two are POSTs, asked
           with a JSON document rather than a query string; the capture is the one that writes. */
        if (head.method == "GET"
            && matches!(
                head.path().as_str(),
                "/api/formats" | "/api/recordings" | "/api/recording" | "/api/dashboard" | "/api/devices" | "/api/game-config" | "/api/tracker" | "/api/bytes" | "/api/worktrees" | "/api/conversations"
            ))
            || (head.method == "POST" && matches!(head.path().as_str(), "/api/format-preview" | "/api/dashboard-capture"))
        {
            let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
            /* `None` is this door declining after all — a remote tracker, whose providers need a
               network client F154 owns — and it falls through to the forwarder below. */
            if let Some(answer) = routes::answer_about_project(&front, &head.path(), &head, &body).await {
                client.write_all(answer.as_bytes()).await?;
                if !head.keeps_alive() { return Ok(()); }
                continue;
            }
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
        /* Showing a retained pane in a desktop's own tab, which is the registry's other action.
           It is the door's for the same reason the registry is: the desktop that has to draw it is
           on the door's socket. */
        if head.path() == "/api/session-view" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let answer = routes::answer_session_view(&front, &body).await;
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* A worker saying where the ledger it serves lives, so this door can push a desktop's token
           segment from it. Only a worker can reach this: it is an api route behind this door's own
           token. Idempotent, so every worker that starts may say so. */
        if head.path() == "/api/ledger" && head.method == "POST" {
            let body = head.read_body(&mut client, &mut buffered).await?;
            let named: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            let directory = named.get("directory").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let answer = if directory.is_empty() {
                faulted("400|Name the directory the ledger is served from.")
            } else {
                let told = front.clone();
                match tokio::task::spawn_blocking(move || attach_ledger(&told, &directory)).await {
                    Ok(Ok(attached)) => http_json(200, "OK", &serde_json::json!({ "attached": attached })),
                    Ok(Err(message)) => faulted(&format!("409|{message}")),
                    Err(error) => faulted(&format!("500|{error}")),
                }
            };
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* Every desktop on this workspace, whatever root it is bound to, and the last registration
           this door refused. A launcher waiting for a window it just started has no root to filter
           by yet, and needs the reason when none appears (spec 098). */
        if head.path() == "/api/runtime-desktops" && head.method == "GET" {
            let answer = http_json(200, "OK", &front.desktops.registry());
            client.write_all(answer.as_bytes()).await?;
            if !head.keeps_alive() { return Ok(()); }
            continue;
        }
        /* The two sockets this door serves itself. `/events` carries a pane's bytes and the
           desktops that register on it; `/surface` carries ONE game's frames to the viewers of its
           pane, and moved here with games (F155, spec 142). */
        if head.upgrade && head.path() == "/events" {
            let key = head.header("sec-websocket-key").unwrap_or_default();
            client.write_all(events::accepted(&key).as_bytes()).await?;
            let stream = events::Prefixed { buffered: std::mem::take(&mut buffered), inner: client };
            events::serve(front, stream).await;
            return Ok(());
        }
        if head.upgrade && head.path() == "/surface" {
            let key = head.header("sec-websocket-key").unwrap_or_default();
            let session = head.query("id").unwrap_or_default();
            client.write_all(events::accepted(&key).as_bytes()).await?;
            let stream = events::Prefixed { buffered: std::mem::take(&mut buffered), inner: client };
            surface_socket::serve(front, stream, session).await;
            return Ok(());
        }
        /* Everything else is the backend's, for now. The head is replayed with this door's token
           swapped for the backend's — a client never learns the backend's credential — and the body
           is forwarded by its own framing. */
        let (backend_host, _) = red_core::http::address(&front.backend).map_err(io::Error::other)?;
        let mut upstream = TcpStream::connect(&backend_host).await?;
        upstream.write_all(head.replayed(&front.backend, &front.backend_token).as_bytes()).await?;
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

/// The same, to the token ledger — the desktop's half of it, which is all the door asks about.
pub(crate) async fn ask_token(front: &Arc<Front>, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let front = front.clone();
    let method = method.to_string();
    match tokio::task::spawn_blocking(move || {
        front.tokens.lock().expect("tokens lock").as_ref().map(|client| client.call(&method, args))
    })
    .await
    {
        Ok(Some(outcome)) => outcome,
        Ok(None) => Err("409|This workspace does not serve the project token ledger.".to_string()),
        Err(error) => Err(format!("500|{error}")),
    }
}

/// Attach to the ledger a worker has just named, unless this door already has one.
///
/// Told rather than found: the ledger is in the worker's directory rather than this one, and the
/// worker is the process that knows. Idempotent, because every worker that starts says so and a
/// second attach would be a second reader of one stream.
pub(crate) fn attach_ledger(front: &Arc<Front>, directory: &str) -> Result<bool, String> {
    {
        let held = front.ledger_directory.lock().expect("ledger directory");
        if held.as_deref() == Some(directory) && front.tokens.lock().expect("tokens lock").is_some() {
            return Ok(false);
        }
    }
    let wants = front.wants.clone();
    let client = red_core::service::Client::attaching(
        std::path::Path::new(directory),
        "token",
        TOKEN_PROTOCOL,
        Box::new(move |event: &serde_json::Value| {
            /* A `token.*` frame moved the ledger, so every desktop bound to that project is pushed
               the pinned segment — which is what lets the status bar never poll. Any other frame is
               somebody else's business and reaches a desktop over the feed, not over this socket. */
            let moved = event.get("event").and_then(serde_json::Value::as_str) == Some("frame")
                && event
                    .get("frame")
                    .and_then(|frame| frame.get("type"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| kind.starts_with("token."));
            if !moved {
                return;
            }
            if let Some(root) = event.get("rootId").and_then(serde_json::Value::as_str) {
                let _ = wants.send(root.to_string());
            }
        }),
    )?;
    let attached = client.is_some();
    if attached {
        *front.tokens.lock().expect("tokens lock") = client;
        *front.ledger_directory.lock().expect("ledger directory") = Some(directory.to_string());
    }
    Ok(attached)
}

/// A desktop acting on the project token, over the socket it registered on.
///
/// A desktop has more actions than an agent does — settling, assigning, rejecting on someone's
/// behalf — so this does not narrow them the way an agent's are narrowed; the ledger judges them.
/// What is judged HERE is that the frame came from a registered desktop bound to the project it
/// names, because a socket that had not said it was a desktop is not one.
pub(crate) async fn desktop_token(
    front: &Arc<Front>,
    viewer: &Arc<events::Viewer>,
    message: &serde_json::Value,
) -> Result<(), String> {
    let (root, desktop, _socket) = desktop_acting(front, viewer, message, "token actions")?;
    /* An assign resolves an agent id against the conversations this project remembers, and a
       function does not cross a socket — so what the worker's `lookup` would have answered is
       looked up here and sent with the request. */
    let asked = message.get("agentId").and_then(serde_json::Value::as_str);
    let lookup = match asked {
        Some(agent) => conversation_identity(front, &root, agent).await,
        None => serde_json::Value::Null,
    };
    ask_token(
        front,
        "desktop",
        serde_json::json!([root, message.get("action"), {
            "contestId": message.get("contestId"),
            "desktopId": desktop,
            "reason": message.get("reason"),
            "agentId": asked,
            "lookup": lookup,
        }]),
    )
    .await
    .map_err(plain)?;
    push_segment(front, &root, None).await;
    Ok(())
}

/// A desktop announcing a capture it started or committed (spec 081): the recorder lives in the
/// desktop, so this is the only place the frame can come from.
pub(crate) async fn desktop_recording(
    front: &Arc<Front>,
    viewer: &Arc<events::Viewer>,
    message: &serde_json::Value,
) -> Result<(), String> {
    let (root, desktop, _socket) = desktop_acting(front, viewer, message, "recording frames")?;
    let kind = match message.get("event").and_then(serde_json::Value::as_str) {
        Some("started") => "capture.started",
        Some("committed") => "capture.committed",
        _ => return Err("A recording frame carries event started or committed.".to_string()),
    };
    let clip = |name: &str, limit: usize| {
        message.get(name).and_then(serde_json::Value::as_str).map(|value| value.chars().take(limit).collect::<String>())
    };
    let mut fields = serde_json::json!({
        "sessionId": message.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "gameId": message.get("gameId").cloned().unwrap_or(serde_json::Value::Null),
        "recordingId": message.get("recordingId").cloned().unwrap_or(serde_json::Value::Null),
        "kind": if message.get("kind") == Some(&serde_json::json!("explicit")) { "explicit" } else { "ring" },
    });
    if let Some(at) = clip("at", 40) {
        fields["startedAt"] = serde_json::json!(at);
    }
    if let Some(error) = clip("error", 400) {
        fields["error"] = serde_json::json!(error);
    }
    let by = serde_json::json!({ "kind": "desktop", "desktopId": desktop });
    ask_token(front, "frame", serde_json::json!([root, kind, by, fields])).await.map_err(plain)?;
    let _ = ask_token(front, "persist", serde_json::json!([root])).await;
    Ok(())
}

/// The project and the desktop a frame on this socket is acting as — or why it is neither.
fn desktop_acting(
    front: &Arc<Front>,
    viewer: &Arc<events::Viewer>,
    message: &serde_json::Value,
    what: &str,
) -> Result<(String, String, u64), String> {
    let root = message.get("rootId").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let socket = front.hub.identify(viewer).ok_or_else(|| format!("Register the desktop before sending {what}."))?;
    let Some(desktop) = front.desktops.identify(socket) else {
        return Err(format!("Register the desktop before sending {what}."));
    };
    if !front.desktops.bound(socket).iter().any(|bound| *bound == root) {
        return Err("That project is not bound to this desktop.".to_string());
    }
    Ok((root, desktop, socket))
}

/// An agent the Tasks pane can list is not necessarily one the ledger has met on the wire, so a
/// desktop's assign resolves through the conversations this project remembers (spec 103).
async fn conversation_identity(front: &Arc<Front>, root_id: &str, agent_id: &str) -> serde_json::Value {
    let Ok(listed) = ask(front, "listConversations", serde_json::json!([root_id])).await else {
        return serde_json::Value::Null;
    };
    let empty = Vec::new();
    let rows = listed.as_array().unwrap_or(&empty);
    let Some(found) = rows.iter().find(|row| row.get("id").and_then(serde_json::Value::as_str) == Some(agent_id)) else {
        return serde_json::Value::Null;
    };
    let name = found.get("agent").and_then(serde_json::Value::as_str).unwrap_or("agent");
    let printable: String = name.chars().filter(|c| (' '..='~').contains(c)).take(32).collect();
    let printable = if printable.is_empty() { "agent".to_string() } else { printable };
    serde_json::json!({ "agentId": agent_id, "label": format!("{printable} {}", &agent_id[..agent_id.len().min(8)]) })
}

/// The pinned segment, to every desktop bound to this project — or to one of them.
///
/// Flat holder/contest/windowMs plus the sequence of the last `token.*` frame (spec 095, Native
/// desktop). Pushed when a desktop registers and after every transition, so the status-bar segment
/// never polls.
pub(crate) async fn push_segment(front: &Arc<Front>, root_id: &str, only: Option<u64>) {
    let Ok(frame) = ask_token(front, "segment", serde_json::json!([root_id])).await else { return };
    front.desktops.push(root_id, &frame.to_string(), only);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn front() -> Front {
        Front {
            surfaces: None,
            viewers: std::sync::atomic::AtomicU64::new(0),
            store: None, pty: None, panes: Arc::new(Mutex::new(std::collections::HashMap::new())),
            hub: Arc::new(Hub::new()), desktops: Desktops::new(),
            ledger_directory: Mutex::new(None), tokens: Mutex::new(None),
            wants: tokio::sync::mpsc::unbounded_channel().0,
            token: "a".repeat(64), instance: "i".into(), state: "/tmp/x".into(), url: "http://127.0.0.1:1".into(),
            backend: "http://127.0.0.1:2".into(), backend_token: "b".repeat(64),
            probes: red_project::devices::Probes::default(),
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
        let door = front();
        let replayed = head(&raw).replayed(&door.backend, &door.backend_token);
        assert!(replayed.contains(&format!("Authorization: Bearer {}", "b".repeat(64))), "{replayed}");
        assert!(!replayed.contains(&"a".repeat(64)), "the client's token is not passed upstream: {replayed}");
    }
}
