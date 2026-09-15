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
    /// One write at a time per project, for the two routes that change a tracker (spec 103).
    writes: red_worker::tasks::Writes,
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
        writes: red_worker::tasks::Writes::new(),
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
    let _ = body;
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
        /* The three routes that CHANGE a project, and the one that changes the workspace. Each is
           the same shape: resolve the project, ask the gate, do the work, tell the feed. */
        ("POST", "/api/update-workspace") => answered_or_faulted(update_workspace(worker, head, body)),
        ("POST", "/api/task") => answered_or_faulted(task(worker, head, body)),
        ("POST", "/api/agent-spawn") => answered_or_faulted(agent_spawn(worker, head, body)),
        ("POST", "/api/script-open") => answered_or_faulted(script_open(worker, head, body)),
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
/// Attaching is the DOOR's (spec 143): the desktops register on its socket, so the worker asks it.
fn shown(
    worker: &Worker,
    data: &serde_json::Value,
    root_id: &str,
    session: &serde_json::Value,
    answer: serde_json::Value,
    detail: &str,
) -> serde_json::Value {
    let Some(desktop) = data.get("desktopId").and_then(serde_json::Value::as_str) else { return answer };
    let asked = serde_json::json!({ "rootId": root_id, "desktopId": desktop, "id": session.get("id") });
    let mut answer = answer.as_object().cloned().unwrap_or_default();
    match ask_host(worker, "POST", "/api/session-view", &asked.to_string()) {
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
    let state = ask_host(worker, "GET", "/api/state", "")?;
    let empty = Vec::new();
    let roots = state.get("roots").and_then(serde_json::Value::as_array).unwrap_or(&empty);
    let found = roots
        .iter()
        .find(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(id))
        .ok_or_else(|| "404|Unknown project root.".to_string())?;
    Ok((
        id.to_string(),
        found.get("path").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
    ))
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
