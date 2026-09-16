//! red-supervisor: the update supervisor as a process (F159, spec 144, charter D57).
//!
//!   red-supervisor --state <dir> --host <url> --host-token <token>
//!
//! It binds a loopback port, announces it on stdout as one JSON line, writes the runtime descriptor
//! that names it, and serves. Everything it does not answer itself is forwarded to the workspace
//! worker it started — which is what makes it the layer in front: a client holds ONE address for the
//! whole life of a workspace while the worker behind it is replaced underneath.
//!
//! The routes it answers rather than forwards are the ones that are the supervisor's own business:
//! the project windows, the desktops it manages, and the updates it performs. `/api/state` is
//! composed rather than either — the worker's state with this layer's capability added, and the
//! HOST's state with a note when the worker cannot answer, because a workspace whose worker is down
//! is still a workspace a person can look at.

use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use red_core::head::Head;
use red_supervisor::runtime::{self, Supervisor};
use red_supervisor::{windows, worker, Refused};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

const USAGE: &str = "usage: red-supervisor --state <dir> --host <url> --host-token <token> [--worker PATH] [--connector PATH] [--desktop PATH] [--port N] [--inspect-ui] [--initial JSON]";

struct Options {
    state: String,
    host: String,
    host_token: String,
    worker: Option<String>,
    connector: Option<String>,
    desktop: Option<String>,
    port: u16,
    inspect_ui: bool,
    initial: Option<String>,
}

fn options() -> Result<Options, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let named = |name: &str| argv.iter().position(|value| value == name).and_then(|at| argv.get(at + 1)).map(String::from);
    Ok(Options {
        state: named("--state").ok_or(USAGE)?,
        host: named("--host").ok_or(USAGE)?,
        host_token: named("--host-token").ok_or(USAGE)?,
        worker: named("--worker"),
        connector: named("--connector"),
        desktop: named("--desktop"),
        port: named("--port").map(|value| value.parse::<u16>().map_err(|_| "--port takes a number".to_string())).transpose()?.unwrap_or(0),
        inspect_ui: argv.iter().any(|value| value == "--inspect-ui"),
        initial: named("--initial"),
    })
}

/// Ask the OS for a free port and let go of it.
///
/// There is a window in which something else could take it; the worker that then cannot bind says
/// so and the IDE bridge stays unpublished, which is a named absence rather than a silently moved
/// port. One port for this runtime's whole life, because Claude Code reconnects to the port it first
/// read and never re-reads the directory (KI-066).
fn free_port() -> Result<u16, String> {
    let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("no free port: {error}"))?;
    probe.local_addr().map(|address| address.port()).map_err(|error| format!("no free port: {error}"))
}

/// The desktop binary this supervisor launches windows from.
fn desktop_binary(named: Option<String>) -> std::path::PathBuf {
    if let Some(named) = named {
        return std::path::PathBuf::from(named);
    }
    let checkout = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().nth(4).map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    red_supervisor::desktop::native_binary(&checkout)
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let chosen = match options() {
        Ok(chosen) => chosen,
        Err(message) => {
            eprintln!("red-supervisor: {message}");
            return std::process::ExitCode::from(2);
        }
    };
    match start(chosen).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("red-supervisor: {message}");
            std::process::ExitCode::from(1)
        }
    }
}

async fn start(chosen: Options) -> Result<(), String> {
    let state = std::path::PathBuf::from(&chosen.state);
    if !state.is_absolute() {
        return Err("Runtime directory must be absolute.".to_string());
    }
    create_private(&state)?;
    /* The host is asked who it is before anything else is started: a supervisor that adopted a host
       it could not reach would publish a descriptor for a workspace that does not answer. */
    let asking = red_core::descriptor::Connection {
        url: chosen.host.clone(),
        token: chosen.host_token.clone(),
        instance: String::new(),
        pid: None,
    };
    let host_state = red_core::descriptor::request(&asking, "state", None, &[])?;
    let instance = host_state.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();
    let host = red_core::descriptor::check_connection(&json!({
        "url": chosen.host, "token": chosen.host_token, "instance": instance,
        "pid": host_state.get("pid").cloned().unwrap_or(Value::Null),
    }))?;

    let worker_binary = match chosen.worker {
        Some(named) => std::path::PathBuf::from(named),
        None => red_core::service::serve_binary("RENGINE_RED_WORKER", "red-worker")?,
    };
    let named_connector = chosen.connector.is_some();
    let connector = match chosen.connector {
        Some(named) => std::path::PathBuf::from(named),
        None => red_core::service::serve_binary("RENGINE_RED_MCP", "red-mcp").unwrap_or_default(),
    };
    let ide_port = free_port()?;
    let current = worker::Child::start(&host, &worker_binary, &chosen.state, ide_port)?;
    let store = windows::Windows::open(&state).map_err(|refused| refused.message)?;
    let supervisor = Supervisor::new(
        state,
        host,
        ide_port,
        worker_binary,
        connector,
        named_connector,
        desktop_binary(chosen.desktop),
        chosen.inspect_ui,
        current,
        store,
    );

    let listener = TcpListener::bind(("127.0.0.1", chosen.port)).await.map_err(|error| format!("cannot listen: {error}"))?;
    let port = listener.local_addr().map(|address| address.port()).unwrap_or(0);
    *supervisor.url.lock().expect("url") = format!("http://127.0.0.1:{port}");
    supervisor.persist()?;

    if let Some(initial) = chosen.initial.as_deref().filter(|value| !value.is_empty()) {
        let asked: Value = serde_json::from_str(initial).map_err(|error| format!("--initial is not JSON: {error}"))?;
        let held = supervisor.clone();
        /* An initial desktop is opened before this announces itself, exactly as `startRuntime` did:
           whoever asked for a workspace asked for a window in it. */
        tokio::task::spawn_blocking(move || held.open_desktop(&asked))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|refused| refused.message)?;
    }

    println!(
        "{}",
        json!({ "started": true, "url": supervisor.url.lock().expect("url").clone(), "token": supervisor.token,
                "instance": supervisor.host.instance, "pid": std::process::id() })
    );
    use std::io::Write;
    let _ = std::io::stdout().flush();

    /* A worker that goes away on its own is replaced once. Checked rather than watched, because the
       worker's own exit is on a thread inside `worker::Child` and a supervisor that only noticed on
       the next request would leave a workspace answering 502 until somebody clicked something. */
    {
        let held = supervisor.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if held.closing.load(Ordering::SeqCst) {
                return;
            }
            if !held.worker().alive() {
                held.recover();
            }
        });
    }

    loop {
        let Ok((client, _)) = listener.accept().await else { continue };
        let held = supervisor.clone();
        tokio::spawn(async move {
            let _ = connection(held, client).await;
        });
    }
}

/// One client, for as long as it keeps the connection.
async fn connection(supervisor: Arc<Supervisor>, mut client: TcpStream) -> io::Result<()> {
    let mut buffered = Vec::new();
    loop {
        let Some(head) = Head::read(&mut client, &mut buffered).await? else { return Ok(()) };
        if head.method == "GET" && head.path() == "/health" {
            let body = json!({ "protocol": 1, "instance": supervisor.host.instance, "layeredUpdates": 1 }).to_string();
            client.write_all(answer(200, "OK", &body).as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }
        if !authorized(&supervisor, &head) {
            client.write_all(refusal(401, runtime::AUTH_REQUIRED).as_bytes()).await?;
            return Ok(());
        }
        if head.upgrade {
            /* `/events` and `/surface` belong to whoever answers the session routes, so they are
               tunnelled byte for byte: a client that reached this layer for a pane's bytes gets the
               worker's, and never a second opinion. */
            let worker = supervisor.worker();
            worker.streams.fetch_add(1, Ordering::SeqCst);
            let outcome = tunnel(&worker.connection, client, buffered, &head).await;
            worker.streams.fetch_sub(1, Ordering::SeqCst);
            supervisor.retire(&worker);
            return outcome;
        }
        let body = if head.method == "POST" { head.read_body(&mut client, &mut buffered).await? } else { String::new() };
        let owned = {
            let (held, asked, sent) = (supervisor.clone(), head.clone(), body.clone());
            tokio::task::spawn_blocking(move || own_route(&held, &asked, &sent))
                .await
                .unwrap_or_else(|_| Some(Err(Refused::new("This supervisor failed while answering.", 500))))
        };
        if let Some(outcome) = owned {
            let said = match outcome {
                Ok((status, value)) => answer(status, "OK", &value.to_string()),
                Err(refused) => refusal(refused.status, &refused.message),
            };
            client.write_all(said.as_bytes()).await?;
            if !head.keeps_alive() {
                return Ok(());
            }
            continue;
        }
        /* Everything else is the worker's, replayed with this layer's credential swapped for its. */
        let worker = supervisor.worker();
        worker.requests.fetch_add(1, Ordering::SeqCst);
        let forwarded = forward(&worker.connection, &mut client, &head, &body).await;
        worker.requests.fetch_sub(1, Ordering::SeqCst);
        supervisor.retire(&worker);
        match forwarded {
            Ok(keep) if keep && head.keeps_alive() => continue,
            _ => return Ok(()),
        }
    }
}

/// The routes this supervisor answers itself. `None` means "not mine — forward it".
fn own_route(supervisor: &Arc<Supervisor>, head: &Head, body: &str) -> Option<Result<(u16, Value), Refused>> {
    let path = head.path();
    let asked: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let query = |name: &str| head.query(name).unwrap_or_default();
    let answer = match (head.method.as_str(), path.as_str()) {
        ("GET", "/api/state") => Ok(state(supervisor, head.query("windowId").as_deref())),
        ("POST", "/api/layout") => {
            let window = query("windowId");
            if window.is_empty() {
                return None;
            }
            supervisor
                .windows
                .lock()
                .expect("windows")
                .layout(&window, asked.get("layout").unwrap_or(&Value::Null))
        }
        ("GET", "/api/project-windows") => supervisor.window_list(&query("rootId")),
        ("POST", "/api/project-window-open") => supervisor.open_project(&asked),
        ("POST", "/api/project-window-action") => supervisor.window_action(&asked),
        ("POST", "/api/integration-report") => {
            let root = asked.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string();
            supervisor
                .own_root(&root)
                .and_then(|_| supervisor.windows.lock().expect("windows").report(&root, &asked, runtime::now()))
        }
        ("GET", "/api/integration-inbox") => {
            let root = query("rootId");
            let options = json!({
                "after": head.query("after").and_then(|value| value.parse::<i64>().ok()).unwrap_or(0),
                "windowId": head.query("windowId"),
                "projectSide": query("projectSide") == "true",
            });
            supervisor.own_root(&root).and_then(|_| supervisor.windows.lock().expect("windows").inbox(&root, &options))
        }
        ("GET", "/api/update-status") => supervisor.status(&query("rootId")),
        ("GET", "/api/desktops") => supervisor.desktops(&query("rootId")).map(|desktops| json!({ "desktops": desktops })),
        ("POST", "/api/update-workspace") => return Some(supervisor.update(&asked).map(|queued| (202, queued))),
        ("POST", "/api/open-desktop") => supervisor.open_desktop(&asked),
        ("POST", "/api/desktop-action") => {
            /* The only desktop action this layer performs is a reload, which IS a desktop-layer
               update. Anything else is the worker's registry to answer, and is refused here by name
               rather than forwarded, because a caller that asked this layer meant this layer. */
            if asked.get("action").and_then(Value::as_str) != Some("reload") {
                Err(Refused::new(runtime::UNKNOWN_ACTION, 400))
            } else {
                let mut with_layers = asked.as_object().cloned().unwrap_or_default();
                with_layers.insert("layers".into(), json!(["desktop"]));
                return Some(supervisor.update(&Value::Object(with_layers)).map(|queued| (202, queued)));
            }
        }
        _ => return None,
    };
    Some(answer.map(|value| (200, value)))
}

/// `GET /api/state`, composed rather than forwarded.
///
/// The worker's state with this layer's own capability added — and, when the worker cannot answer,
/// the HOST's state with a note saying so. A workspace whose worker is down is still a workspace a
/// person can look at, and the capabilities it claims there are the ones this layer provides.
fn state(supervisor: &Arc<Supervisor>, window_id: Option<&str>) -> Value {
    let worker = supervisor.worker();
    let layout = window_id.map(|id| supervisor.windows.lock().expect("windows").state_layout(id).unwrap_or(Value::Null));
    match red_core::descriptor::request(&worker.connection, "state", None, &[]) {
        Ok(state) => {
            *worker.error.lock().expect("error") = None;
            compose(state, &[("projectWindows", 1)], layout, false)
        }
        Err(why) => {
            *worker.error.lock().expect("error") = Some(why);
            let host = supervisor.host_state().unwrap_or_else(|_| json!({}));
            compose(host, &[("desktopActions", 1), ("layeredUpdates", 1), ("projectWindows", 1)], layout, true)
        }
    }
}

fn compose(state: Value, added: &[(&str, i64)], layout: Option<Value>, unavailable: bool) -> Value {
    let mut fields = state.as_object().cloned().unwrap_or_default();
    let mut capabilities = fields.get("capabilities").and_then(Value::as_object).cloned().unwrap_or_default();
    for (name, value) in added {
        capabilities.insert((*name).to_string(), json!(value));
    }
    fields.insert("capabilities".into(), Value::Object(capabilities));
    if let Some(layout) = layout {
        fields.insert("layout".into(), layout);
    }
    if unavailable {
        fields.insert("workspaceWorkerUnavailable".into(), json!(true));
    }
    Value::Object(fields)
}

/// Who may speak to this supervisor.
///
/// On an UPGRADE the query's token is the credential, because a browser cannot set a header on one.
/// An `Origin` that is not this supervisor's own is refused: a page on another origin holding the
/// token is a page that got it somewhere it should not have.
fn authorized(supervisor: &Arc<Supervisor>, head: &Head) -> bool {
    let presented = if head.upgrade {
        head.query("token")
    } else {
        head.header("authorization").and_then(|value| value.strip_prefix("Bearer ").map(str::to_string))
    };
    let ours = match head.header("origin") {
        None => true,
        Some(origin) => origin == *supervisor.url.lock().expect("url"),
    };
    ours && presented.is_some_and(|value| red_core::service::same_secret(&value, &supervisor.token))
}

async fn forward(
    upstream: &red_core::descriptor::Connection,
    client: &mut TcpStream,
    head: &Head,
    body: &str,
) -> io::Result<bool> {
    let (address, _) = red_core::http::address(&upstream.url).map_err(io::Error::other)?;
    let mut target = TcpStream::connect(&address).await?;
    target.write_all(head.replayed(&upstream.url, &upstream.token).as_bytes()).await?;
    target.write_all(body.as_bytes()).await?;
    let mut buffered: Vec<u8> = Vec::new();
    let Some(said) = Head::read(&mut target, &mut buffered).await? else { return Ok(false) };
    client.write_all(said.raw.as_bytes()).await?;
    said.forward_body(&mut target, &mut buffered, client).await?;
    Ok(!said.closes())
}

async fn tunnel(
    upstream: &red_core::descriptor::Connection,
    mut client: TcpStream,
    buffered: Vec<u8>,
    head: &Head,
) -> io::Result<()> {
    let (address, _) = red_core::http::address(&upstream.url).map_err(io::Error::other)?;
    let mut target = TcpStream::connect(&address).await?;
    target.write_all(head.replayed(&upstream.url, &upstream.token).as_bytes()).await?;
    if !buffered.is_empty() {
        target.write_all(&buffered).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut target).await;
    Ok(())
}

fn answer(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn refusal(status: u16, message: &str) -> String {
    answer(status, "Error", &json!({ "error": message }).to_string())
}

fn create_private(path: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("{} cannot be created: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}
