//! red-launch: the command that opens this workspace (F159, spec 145, charter D57).
//!
//! This is `orchestrator/launch.mjs` and the four modules under it —
//! `launcher/{headless,replace,restart-supervisor}.mjs` and `build.mjs`. It is one binary because
//! they were one command: a launcher that shelled back into Node for its own `--replace-host` would
//! be more moving parts than either arrangement, not fewer.
//!
//! ```text
//! red-launch [--project DIR] [--declaration FILE] [--agent NAME|EXEC] [--state DIR] …
//! red-launch build
//! red-launch replace-host --state DIR [--process-table FILE]
//! red-launch restart-supervisor --state DIR [--plan | --stop-only]
//! red-launch message-grant --state DIR (--list | --session ID (--revoke | --messages N --minutes M))
//! red-launch ancestors [--pid N]
//! ```
//!
//! The order of what it does is spec 090/098's and is not this file's to change: the refusals
//! before anything is started, the host before the desktop, and the desktop in a loop because exit
//! **75** means "I saved and detached for an update" rather than "I closed".

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use red_core::descriptor::{self, Connection};
use red_supervisor::{host, stop};
use serde_json::{json, Map, Value};

/// "I detached for an update", the same code the supervisor's views speak (spec 065).
const DETACHED: i32 = 75;

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match argv.first().map(String::as_str) {
        Some("build") => build().map(|()| 0),
        Some("replace-host") => replace_host_command(&argv[1..]).map(|()| 0),
        Some("restart-supervisor") => restart_command(&argv[1..]),
        Some("ancestors") => ancestors_command(&argv[1..]).map(|()| 0),
        Some("bootstrap") => bootstrap_command(&argv[1..]).map(|()| 0),
        Some("client") => client_command(&argv[1..]),
        Some("message-grant") => grant_command(&argv[1..]),
        _ => workspace(&argv),
    };
    match outcome {
        Ok(code) => ExitCode::from(code as u8),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

/* ---- where this checkout is ------------------------------------------------------------------ */

/// The checkout this binary was built in: `red/target/<profile>/red-launch`, four levels up.
fn checkout() -> PathBuf {
    if let Some(named) = std::env::var("RENGINE_CHECKOUT").ok().filter(|value| !value.is_empty()) {
        return PathBuf::from(named);
    }
    /* Canonical, because this path is PRINTED in the replacement report and compared between runs:
       invoked as `./red/target/debug/red-launch`, `current_exe` keeps the `.` and the report would
       name a checkout nobody typed. */
    std::env::current_exe()
        .ok()
        .and_then(|exe| std::fs::canonicalize(&exe).ok().or(Some(exe)))
        .and_then(|exe| exe.ancestors().nth(4).map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn absolute(value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/* ---- build ----------------------------------------------------------------------------------- */

/// `orchestrator/build.mjs`: configure and build the native desktop under a lock, so two launchers
/// racing for the same `.cache/desktop` do not build over each other.
///
/// The node executable is still passed to cmake, because the desktop still execs `actions/pane/posix/agent.sh`
/// and the MCP facade. That coupling is F163's to remove; naming it here is what makes it visible
/// when it goes.
fn build() -> Result<(), String> {
    let root = checkout();
    let directory = root.join(".cache/desktop");
    std::fs::create_dir_all(&directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
    let lock = directory.join("build.lock");
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut held) => {
                use std::io::Write;
                let _ = write!(held, "{{\"pid\":{}}}", std::process::id());
                let outcome = configure_and_build(&root, &directory);
                let _ = std::fs::remove_file(&lock);
                return outcome;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                /* A lock whose owner is gone is a lock nobody holds; one that has not been written
                   yet means somebody is starting, exactly as `descriptor::ensure` reads it. */
                let owner = match std::fs::read_to_string(&lock) {
                    Ok(text) => serde_json::from_str::<Value>(&text).ok().and_then(|held| held.get("pid").and_then(Value::as_i64)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => None,
                };
                if owner.is_some_and(|pid| !descriptor::alive(pid)) {
                    let _ = std::fs::remove_file(&lock);
                    continue;
                }
                if std::time::Instant::now() > deadline {
                    return Err("Another native build still owns build.lock; no competing build was started.".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("{} cannot be taken: {error}", lock.display())),
        }
    }
}

fn configure_and_build(root: &Path, directory: &Path) -> Result<(), String> {
    /* No node is passed, and none is needed: the desktop's bootstrap is `red-launch bootstrap` now,
       so the build bakes the CHECKOUT rather than an interpreter (F163, spec 146). */
    let configure: Vec<String> = vec![
        "-S".into(),
        root.to_string_lossy().into(),
        "-B".into(),
        directory.to_string_lossy().into(),
        "-DCMAKE_BUILD_TYPE=Release".into(),
    ];
    let compile: Vec<String> = vec![
        "--build".into(),
        directory.to_string_lossy().into(),
        "--config".into(),
        "Release".into(),
        "--parallel".into(),
        "6".into(),
    ];
    for args in [configure, compile] {
        let status = std::process::Command::new("cmake")
            .args(&args)
            .current_dir(root)
            .status()
            .map_err(|error| format!("cmake would not run: {error}"))?;
        if !status.success() {
            return Err(format!("Native desktop build failed ({}).", status.code().unwrap_or(1)));
        }
    }
    Ok(())
}

/* ---- the process-table commands -------------------------------------------------------------- */

fn named<'a>(argv: &'a [String], name: &str) -> Option<&'a String> {
    argv.iter().position(|value| value == name).and_then(|at| argv.get(at + 1))
}

fn process_table(argv: &[String]) -> Result<Vec<red_supervisor::replace::Process>, String> {
    match named(argv, "--process-table") {
        Some(path) => stop::read_process_table(Path::new(path)),
        None => stop::list_processes(),
    }
}

fn runtime_root(argv: &[String]) -> PathBuf {
    match named(argv, "--runtime-root") {
        Some(path) => PathBuf::from(path),
        None => checkout().join(".cache/runtime"),
    }
}

fn replace_host_command(argv: &[String]) -> Result<(), String> {
    let state = named(argv, "--state").ok_or("usage: red-launch replace-host --state DIR")?;
    let report = replace_host(&absolute(state), argv)?;
    println!("{}", red_supervisor::replace::describe_report(&report));
    Ok(())
}

fn replace_host(state_dir: &Path, argv: &[String]) -> Result<Value, String> {
    let root = checkout();
    let runtime = runtime_root(argv);
    stop::replace_host(&stop::Replacing {
        state_dir,
        checkout: &root,
        runtime_root: &runtime,
        processes: process_table(argv)?,
        self_pid: std::process::id() as i64,
    })
}

/// `--plan` reads and reports; without it the tool acts. The confirm prompt with no non-interactive
/// bypass lives in `actions/posix/restart-supervisor.sh`, which is where it always was.
fn restart_command(argv: &[String]) -> Result<i32, String> {
    let Some(state) = named(argv, "--state").cloned().or_else(|| std::env::var("RENGINE_STATE_DIR").ok()) else {
        eprintln!("Usage: red-launch restart-supervisor --state DIR [--plan | --stop-only]");
        return Ok(2);
    };
    let state_dir = absolute(&state);
    let processes = process_table(argv)?;
    let runtime = runtime_root(argv);
    if argv.iter().any(|value| value == "--plan") {
        let planned = stop::plan(&state_dir, &processes, &runtime)?;
        println!("Session host PID {} — NOT signalled, its sessions are kept.", planned.host.pid);
        if planned.supervisors.is_empty() {
            println!("No update supervisor is running for it; a restart would simply start one.");
        }
        for found in &planned.supervisors {
            println!("Supervisor PID {} at {}, with {} child process(es) that close with it.", found.pid, found.url, found.children.len());
        }
        return Ok(0);
    }
    let launch = !argv.iter().any(|value| value == "--stop-only");
    let done = stop::restart(&state_dir, &processes, &runtime, launch, &checkout())?;
    println!("{}", stop::describe_restart(&done));
    Ok(0)
}

/// Arming one pane for a relay, or taking the arming back (F222, spec 148).
///
/// The confirmation is NOT here. It is in `orchestrator/actions/grant-session-message.sh`, where
/// `restart-supervisor`'s is, for the same two reasons: a prompt with no non-interactive bypass has
/// to be a tty question rather than a flag a caller can pass, and a command a test can drive is a
/// command whose behaviour can be observed. This writes what it is told to write; the action is
/// what makes an owner tell it.
///
/// Both bounds are required and neither has a default. A grant with no count or no deadline is the
/// shape this feature exists to avoid: an open-ended permission to type into somebody's pane.
fn grant_command(argv: &[String]) -> Result<i32, String> {
    let usage = "Usage: red-launch message-grant --state DIR (--list | --session ID (--revoke | --messages N --minutes M))";
    let Some(state) = named(argv, "--state").cloned().or_else(|| std::env::var("RENGINE_STATE_DIR").ok()) else {
        eprintln!("{usage}");
        return Ok(2);
    };
    let state_dir = absolute(&state);
    let now = red_core::time::now_ms();
    if argv.iter().any(|value| value == "--list") {
        let grants = red_core::grants::list(&state_dir, now)?;
        println!("{}", json!({ "grants": grants.iter().map(red_core::grants::Grant::as_json).collect::<Vec<Value>>() }));
        return Ok(0);
    }
    let Some(session) = named(argv, "--session").cloned() else {
        eprintln!("{usage}");
        return Ok(2);
    };
    if argv.iter().any(|value| value == "--revoke") {
        let taken = red_core::grants::revoke(&state_dir, &session)?;
        println!("{}", json!({ "revoked": taken, "sessionId": session }));
        return Ok(0);
    }
    let number = |flag: &str| -> Result<i64, String> {
        named(argv, flag)
            .ok_or_else(|| format!("{flag} is required: a grant is bounded by a count AND a deadline, and neither has a default."))?
            .parse::<i64>()
            .map_err(|_| format!("{flag} takes a number."))
    };
    let written = red_core::grants::grant(&state_dir, &session, number("--messages")?, number("--minutes")?, now)?;
    println!("{}", written.as_json());
    Ok(0)
}

/// Every pid between one process and the top of the tree. `agents/launch.mjs` asks this to tell its
/// own editor from a machine-mate's; it is a fact about the process tree, not a decision.
fn ancestors_command(argv: &[String]) -> Result<(), String> {
    let pid = match named(argv, "--pid") {
        Some(value) => value.parse::<i64>().map_err(|_| "--pid takes a number".to_string())?,
        None => std::os::unix::process::parent_id() as i64,
    };
    let chain = red_supervisor::replace::ancestors_of(pid, &process_table(argv)?);
    println!("{}", json!({ "pid": pid, "ancestors": chain }));
    Ok(())
}

/* ---- the desktop's own bootstrap ------------------------------------------------------------- */

/// `orchestrator/runtime/bootstrap.mjs`, which the DESKTOP execs at startup (F163, spec 146).
///
/// This is the last thing the native binary needed an interpreter for. It is baked in at cmake
/// time as `RENGINE_BOOTSTRAP` and reached with `execv`, which is why spec 145 had to resolve the
/// node path to an absolute one first: a bare name made this fail silently and the window opened
/// with no update supervisor behind it.
///
/// What it does is small and is entirely about ORDER: the desktop already holds a workspace
/// capability, so this asks that workspace who it is, works out what the window should open with,
/// and makes sure a supervisor is serving it before the desktop draws anything.
fn bootstrap_command(argv: &[String]) -> Result<(), String> {
    let binary = named(argv, "--binary").ok_or("Native bootstrap requires its executable path.")?;
    let url = std::env::var("RENGINE_WORKSPACE_URL").unwrap_or_default();
    let token = std::env::var("RENGINE_WORKSPACE_TOKEN").unwrap_or_default();
    /* The same shape `checkConnection` insisted on, and for the same reason: the token is a
       capability, so a URL naming another machine would send it there. */
    let mut host = descriptor::check_connection(&json!({ "url": url, "token": token, "instance": "0".repeat(36) }))
        .map_err(|_| "Native bootstrap requires a local workspace capability.".to_string())?;
    let state = descriptor::request(&host, "state", None, &[])?;
    host.instance = state.get("instance").and_then(Value::as_str).unwrap_or_default().to_string();

    let value = |name: &str| std::env::var(name).ok().unwrap_or_default();
    /* A desktop launched with no root opens on whichever the workspace lists first, which is what a
       person sees when they open a workspace that already has one. */
    let mut root = value("RENGINE_INITIAL_ROOT");
    if root.is_empty() {
        root = state
            .get("roots")
            .and_then(Value::as_array)
            .and_then(|roots| roots.first())
            .and_then(|first| first.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
    }
    let initial = json!({
        "root": root,
        "terminal": value("RENGINE_INITIAL_TERMINAL"),
        "agent": value("RENGINE_INITIAL_AGENT"),
        "game": value("RENGINE_INITIAL_GAME"),
        "resume": value("RENGINE_RESUME_AGENT") == "1",
    });
    let runtime = ensure_runtime(&host, &absolute(binary), &checkout())?;
    println!(
        "rEngine update supervisor ready (PID {}); retained sessions are unchanged.",
        runtime.get("pid").and_then(Value::as_i64).unwrap_or(0)
    );
    /* The initial window is opened over the ROUTE, cold or warm, so there is one path for it rather
       than two that can disagree. A window that will not open leaves the workspace up and says so,
       which is what a person can act on. */
    let connection = descriptor::check_connection(&runtime)?;
    descriptor::request(&connection, "open-desktop", Some(&initial), &[])?;
    Ok(())
}

/// The supervisor serving this host, started detached if there is none — `ensureRuntime`, under the
/// same lock discipline every other one-per-directory process here takes (`descriptor::ensure`).
fn ensure_runtime(host: &Connection, desktop: &Path, root: &Path) -> Result<Value, String> {
    let directory = red_supervisor::runtime_directory(root, &host.instance);
    std::fs::create_dir_all(&directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
    ensure_runtime_in(host, Some(desktop), &directory)
}

/// The same, for a caller that already knows the directory and may have no desktop to name — the
/// client's `bootstrap`, which adopts a host without launching a window or a CLI.
fn ensure_runtime_in(host: &Connection, desktop: Option<&Path>, directory: &Path) -> Result<Value, String> {
    let binary = red_core::service::serve_binary("RENGINE_RED_SUPERVISOR", "red-supervisor")?;
    let mut args = vec![
        "--state".to_string(),
        directory.to_string_lossy().into_owned(),
        "--host".to_string(),
        host.url.clone(),
        "--host-token".to_string(),
        host.token.clone(),
    ];
    if let Some(desktop) = desktop {
        args.push("--desktop".to_string());
        args.push(desktop.to_string_lossy().into_owned());
    }
    let held = |path: &Path| format!("Runtime startup is still owned by another live process ({}).", path.display());
    let exited = |path: &Path| format!("Runtime exited during startup; inspect {}.", path.display());
    let slow = |pid: i64| format!("Runtime PID {pid} is still starting; inspect runtime.log.");
    let options = descriptor::Starting {
        directory,
        lock: "startup.lock",
        log: "runtime.log",
        deadline: Duration::from_secs(25),
        held: &held,
        exited: &exited,
        slow: &slow,
    };
    let owned = directory.to_path_buf();
    let connection = host.clone();
    descriptor::ensure(
        &options,
        &|| descriptor::discover_runtime(&connection, &owned),
        &|log| red_core::service::spawn_detached(&binary, &args, log),
    )
}

/* ---- the client the dashboard actions use ---------------------------------------------------- */

const CLIENT_USAGE: &str = "Usage: red-launch client bootstrap|status|update|open|windows|window|report|inbox|script|show-session --context FILE \
[--project DIR --agent ID] [--window ID --action inspect|focus|close|reopen --screenshot] [--report FILE] [--script FILE --desktop ID] \
[--session ID] [--after N --project-side] [--desktop ID --layers workspace,desktop,connector]";

/// `orchestrator/runtime/client.mjs` (F163, spec 146): the command two dashboard actions and the
/// dogfooding runbook drive a workspace's supervisor with.
///
/// Every route it asks for is one `red-supervisor` already serves, so this is argument parsing, one
/// refusal, and the update poll. It is here rather than in the supervisor because a client is not a
/// server: this is the process a person's shell action runs, and it exits.
fn client_command(argv: &[String]) -> Result<i32, String> {
    const ACTIONS: [&str; 10] =
        ["bootstrap", "status", "update", "open", "windows", "window", "report", "inbox", "script", "show-session"];
    let action = argv.first().map(String::as_str).filter(|value| ACTIONS.contains(value)).ok_or(CLIENT_USAGE)?;
    let mut options: Map<String, Value> = Map::new();
    let mut index = 1;
    while index < argv.len() {
        let flag = argv[index].as_str();
        match flag {
            "--screenshot" | "--project-side" => {
                options.insert(flag[2..].to_string(), Value::Bool(true));
            }
            "--context" | "--desktop" | "--layers" | "--project" | "--agent" | "--window" | "--action" | "--report"
            | "--after" | "--script" | "--session" => {
                let value = argv.get(index + 1).filter(|value| !value.is_empty()).ok_or(CLIENT_USAGE)?;
                options.insert(flag[2..].to_string(), Value::String(value.clone()));
                index += 1;
            }
            _ => return Err(CLIENT_USAGE.to_string()),
        }
        index += 1;
    }
    let text = |name: &str| options.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    let filename = match options.get("context").and_then(Value::as_str) {
        Some(named) => named.to_string(),
        None => std::env::var("RENGINE_WORKSPACE_CONTEXT").map_err(|_| CLIENT_USAGE.to_string())?,
    };
    let source = std::fs::read_to_string(&filename).map_err(|error| format!("{filename} cannot be read: {error}"))?;
    let context: Value = serde_json::from_str(&source).map_err(|error| format!("{filename} is not a workspace context: {error}"))?;
    let root_id = context.get("rootId").and_then(Value::as_str).unwrap_or_default().to_string();
    let host = descriptor::check_connection(&context)?;

    /* The original host has to still BE the one this context names, and still serve this root: a
       client that carried on against a replaced host would act on another workspace's windows. */
    let state = descriptor::request(&host, "state", None, &[])?;
    let same = state.get("instance").and_then(Value::as_str) == Some(host.instance.as_str());
    let serves = state
        .get("roots")
        .and_then(Value::as_array)
        .is_some_and(|roots| roots.iter().any(|root| root.get("id").and_then(Value::as_str) == Some(root_id.as_str())));
    if !same || !serves {
        return Err("The original project/session host is no longer available.".to_string());
    }

    let directory = match context.get("runtimeDirectory").and_then(Value::as_str) {
        Some(named) => PathBuf::from(named),
        None => red_supervisor::runtime_directory(&checkout(), &host.instance),
    };
    if action == "bootstrap" {
        std::fs::create_dir_all(&directory).map_err(|error| format!("{} cannot be created: {error}", directory.display()))?;
        let runtime = ensure_runtime_in(&host, None, &directory)?;
        println!(
            "{}",
            json!({ "supervisorPid": runtime.get("pid"), "instance": runtime.get("instance"),
                    "detail": "Original host adopted; no desktop or CLI launched." })
        );
        return Ok(0);
    }

    /* `resolveRuntime`: the supervisor when one is serving, the host itself when none is — so a
       workspace with no supervisor gets the capability refusal below rather than a connection error. */
    let runtime = match descriptor::discover_runtime(&host, &directory)? {
        Some(found) => descriptor::check_connection(&found)?,
        None => host.clone(),
    };
    let state = descriptor::request(&runtime, "state", None, &[])?;
    if state.get("capabilities").and_then(|value| value.get("layeredUpdates")).and_then(Value::as_i64) != Some(1) {
        return Err("Layered updates are not installed. Use explicit bootstrap with this same context.".to_string());
    }
    let scoped = |route: &str| format!("{route}?rootId={}", red_core::http::encode(&root_id));
    let result = match action {
        "status" => descriptor::request(&runtime, &scoped("update-status"), None, &[])?,
        "windows" => descriptor::request(&runtime, &scoped("project-windows"), None, &[])?,
        "open" => {
            let agent = match options.get("agent").and_then(Value::as_str) {
                Some(named) => named.to_string(),
                None => std::env::var("RENGINE_ORCHESTRATOR_SESSION").unwrap_or_default(),
            };
            descriptor::request(&runtime, "project-window-open",
                Some(&json!({ "rootId": root_id, "path": text("project"), "agentId": agent })), &[])?
        }
        "window" => descriptor::request(&runtime, "project-window-action",
            Some(&json!({ "rootId": root_id, "windowId": text("window"), "action": text("action"),
                          "screenshot": options.get("screenshot") == Some(&Value::Bool(true)) })), &[])?,
        "script" => {
            let file = options.get("script").and_then(Value::as_str)
                .ok_or("Provide --script FILE containing path and optional args. Choose --desktop ID.")?;
            let mut ask = read_json_object(file)?;
            ask.insert("rootId".into(), json!(root_id));
            ask.insert("desktopId".into(), json!(text("desktop")));
            descriptor::request(&runtime, "script-open", Some(&Value::Object(ask)), &[])?
        }
        "show-session" => descriptor::request(&runtime, "session-view",
            Some(&json!({ "rootId": root_id, "id": text("session"), "desktopId": text("desktop") })), &[])?,
        "report" => {
            let file = options.get("report").and_then(Value::as_str)
                .ok_or("Provide --report FILE containing windowId, key, kind, summary and optional detail/evidence/fromProject.")?;
            let mut ask = read_json_object(file)?;
            ask.insert("rootId".into(), json!(root_id));
            descriptor::request(&runtime, "integration-report", Some(&Value::Object(ask)), &[])?
        }
        "inbox" => {
            let after = options.get("after").and_then(Value::as_str).unwrap_or("0").to_string();
            let mut query = format!("integration-inbox?rootId={}&after={}&projectSide={}",
                red_core::http::encode(&root_id), red_core::http::encode(&after),
                options.get("project-side") == Some(&Value::Bool(true)));
            if let Some(window) = options.get("window").and_then(Value::as_str) {
                query.push_str(&format!("&windowId={}", red_core::http::encode(window)));
            }
            descriptor::request(&runtime, &query, None, &[])?
        }
        _ => return update_and_watch(&runtime, &root_id, &options, &scoped),
    };
    println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
    Ok(0)
}

fn read_json_object(file: &str) -> Result<Map<String, Value>, String> {
    let source = std::fs::read_to_string(file).map_err(|error| format!("{file} cannot be read: {error}"))?;
    let value: Value = serde_json::from_str(&source).map_err(|error| format!("{file} is not JSON: {error}"))?;
    value.as_object().cloned().ok_or_else(|| format!("{file} must contain a JSON object."))
}

/// Ask for an update and watch it to an OUTCOME. Completion is not acceptance (spec 144): the ask
/// answers 202 with a job id, and a caller that treated that as success would report a failed
/// update as a working one. A failed job is this command's failure too, which is what a shell
/// action's `set -e` needs.
fn update_and_watch(
    runtime: &Connection,
    root_id: &str,
    options: &Map<String, Value>,
    scoped: &dyn Fn(&str) -> String,
) -> Result<i32, String> {
    let layers: Vec<&str> = options
        .get("layers")
        .and_then(Value::as_str)
        .unwrap_or("workspace,desktop,connector")
        .split(',')
        .collect();
    let ask = json!({ "rootId": root_id, "desktopId": options.get("desktop").and_then(Value::as_str).unwrap_or(""), "layers": layers });
    let queued = descriptor::request(runtime, "update-workspace", Some(&ask), &[])?;
    println!("{queued}");
    let job_id = queued.get("jobId").and_then(Value::as_str).unwrap_or_default().to_string();
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        let status = descriptor::request(runtime, &scoped("update-status"), None, &[])?;
        let job = status
            .get("jobs")
            .and_then(Value::as_array)
            .and_then(|jobs| jobs.iter().find(|job| job.get("id").and_then(Value::as_str) == Some(job_id.as_str())))
            .cloned();
        if let Some(job) = job {
            match job.get("status").and_then(Value::as_str) {
                Some("succeeded") => {
                    println!("{}", serde_json::to_string_pretty(&job).unwrap_or_default());
                    return Ok(0);
                }
                Some("failed") => {
                    println!("{}", serde_json::to_string_pretty(&job).unwrap_or_default());
                    return Ok(1);
                }
                _ => {}
            }
        }
        if std::time::Instant::now() > deadline {
            return Err("Update observation timed out. Inspect status; the operation was not canceled.".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/* ---- the workspace launcher ------------------------------------------------------------------ */

struct Options {
    project: Option<String>,
    declaration: Option<String>,
    agent: Option<String>,
    state: String,
    handoff: Option<String>,
    no_agent: bool,
    headless: bool,
    launch_game: bool,
    inspect_ui: bool,
    replace_host: bool,
}

fn default_state() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".local/state/rengine").to_string_lossy().into_owned()
}

/// The agents are the registry's to list, not this line's: a CLI added as data appears here the day
/// it is declared, and none is named in source (F220, spec 141).
fn usage(names: &[String]) -> String {
    format!(
        "npm start -- [--project DIR] [--declaration FILE] [--agent {}|EXEC] [--state DIR] [--no-agent] [--headless] [--launch-game] [--handoff FILE] [--inspect-ui] [--replace-host]\n\
--declaration binds an external project.json without writing inside the project.\n\
--handoff resumes an explicit paused conversation once its native pane is presented.\n\
--launch-game requires an explicit --project. --inspect-ui enables native stdin automation.\n\
--headless runs the sidecar alone: no desktop build, no desktop and no agent, so it starts on a\n\
machine with no C toolchain. It stays in the foreground; npm run start:headless is the same command.\n\
Cmd/Ctrl+Shift+R saves, rebuilds and reloads the desktop, retaining sessions.\n\
The C/microui desktop detaches on exit; manage retained processes in Sessions.\n\
--replace-host stops this state directory's retained session host and its update supervisor, ending their sessions,\n\
then starts a fresh host from this checkout before continuing. Run it from a terminal outside rEngine.",
        names.join("|")
    )
}

fn parse(argv: &[String]) -> Result<Option<Options>, String> {
    let mut options = Options {
        project: None,
        declaration: None,
        agent: None,
        state: default_state(),
        handoff: None,
        no_agent: false,
        headless: false,
        launch_game: false,
        inspect_ui: false,
        replace_host: false,
    };
    let mut index = 0;
    while index < argv.len() {
        let flag = argv[index].as_str();
        let value = || -> Result<String, String> {
            let next = argv.get(index + 1).filter(|value| !value.is_empty()).cloned();
            next.ok_or_else(|| format!("Missing value for {flag}"))
        };
        match flag {
            "--project" => {
                options.project = Some(value()?);
                index += 1;
            }
            "--declaration" => {
                options.declaration = Some(value()?);
                index += 1;
            }
            "--agent" => {
                options.agent = Some(value()?);
                index += 1;
            }
            "--state" => {
                options.state = value()?;
                index += 1;
            }
            "--handoff" => {
                options.handoff = Some(value()?);
                index += 1;
            }
            "--no-agent" => options.no_agent = true,
            "--headless" => options.headless = true,
            "--launch-game" => options.launch_game = true,
            "--inspect-ui" => options.inspect_ui = true,
            "--replace-host" => options.replace_host = true,
            "--help" => {
                let names = recipe_names()?;
                println!("{}", usage(&names));
                return Ok(None);
            }
            other => return Err(format!("Unknown option: {other}")),
        }
        index += 1;
    }
    Ok(Some(options))
}

fn recipe_names() -> Result<Vec<String>, String> {
    Ok(red_agents::recipes()?.into_iter().map(|(name, _)| name).collect())
}

fn workspace(argv: &[String]) -> Result<i32, String> {
    let Some(mut options) = parse(argv)? else { return Ok(0) };
    if options.headless {
        let refusals: [(&str, bool, &str); 5] = [
            ("--agent", options.agent.is_some(), "a headless host serves sessions and starts no conversation"),
            ("--handoff", options.handoff.is_some(), "a handoff resumes a conversation in a native pane"),
            ("--launch-game", options.launch_game, "a game wants a pane; start one through the API deliberately"),
            ("--inspect-ui", options.inspect_ui, "there is no desktop to inspect"),
            ("--declaration", options.declaration.is_some(), "binding an external declaration is not wired here yet — see spec 090, Deferred"),
        ];
        if let Some((flag, _, why)) = refusals.into_iter().find(|(_, used, _)| *used) {
            return Err(format!("--headless cannot be combined with {flag}: {why}."));
        }
    }
    let mut resume = false;
    if let Some(manifest) = options.handoff.clone() {
        let read = read_handoff(&mut options, &manifest)?;
        options.project = Some(read.0);
        options.handoff = Some(read.1);
        resume = true;
    }
    if options.launch_game && options.project.is_none() {
        return Err("--launch-game requires --project DIR.".to_string());
    }
    if options.declaration.is_some() && options.project.is_none() {
        return Err("--declaration requires --project DIR.".to_string());
    }

    let state_dir = absolute(&options.state);
    let root = checkout();
    if options.headless {
        if options.replace_host {
            let report = replace_host(&state_dir, argv)?;
            println!("{}", red_supervisor::replace::describe_report(&report));
        }
        return headless(&options, &state_dir, &root);
    }

    build()?;
    if options.replace_host {
        let report = replace_host(&state_dir, argv)?;
        println!("{}", red_supervisor::replace::describe_report(&report));
    }
    let instance = host::ensure(&state_dir, &root)?;
    if !options.replace_host {
        if let Some(age) = host::age(&state_dir, &root, &host::CODE_AREAS)? {
            if age.stale {
                eprintln!(
                    "The retained session host (PID {}) started {}, before {} changed at {}; it keeps serving the code it loaded then. \
Start again with --replace-host to replace it (its sessions end; conversations can be resumed from the pane).",
                    instance.pid.unwrap_or(0),
                    host::iso(age.started_at),
                    age.newest_file,
                    host::iso(age.newest_at)
                );
            }
        }
    }
    let opened = open_workspace(&instance, &options, &state_dir)?;
    run_desktop(&root, &instance, &opened, resume, options.inspect_ui)
}

/// The manifest, judged by the reader three callers share (`red_agents::handoff`), and the CLI's own
/// resume prerequisites asked through `agent.sh`. Answers the project the handoff names and the
/// manifest's canonical path.
fn read_handoff(options: &mut Options, manifest: &str) -> Result<(String, String), String> {
    let recipes = red_agents::recipes()?;
    /* A manifest does not name a CLI, so the recipes do: whoever declares that a paused conversation
       can be handed to them. One is the answer; several means this has to be told which (F216). */
    let capable: Vec<String> = recipes
        .iter()
        .filter(|(name, _)| red_agents::launch::conversation_handoff(&recipes, name).is_some())
        .map(|(name, _)| name.clone())
        .collect();
    if options.no_agent {
        return Err("--handoff cannot use --no-agent.".to_string());
    }
    if let Some(named) = options.agent.as_deref() {
        if !capable.iter().any(|name| name == named) {
            return Err(format!(
                "--handoff requires a CLI that can be handed a conversation: {}.",
                if capable.is_empty() { "none is declared".to_string() } else { capable.join(", ") }
            ));
        }
    }
    let cli = match options.agent.clone() {
        Some(named) => named,
        None if capable.len() == 1 => capable[0].clone(),
        None => {
            return Err(format!(
                "--handoff needs --agent to say which CLI: {}.",
                if capable.is_empty() { "none is declared".to_string() } else { capable.join(", ") }
            ))
        }
    };
    /* `--project` is optional here and the resume command does not pass one: the manifest names its
       own project, and a flag that disagrees with it is what the cross-check is for. */
    let project = options.project.clone().map(|value| absolute(&value));
    let declared = red_agents::launch::conversation_handoff(&recipes, &cli).unwrap_or(Value::Null);
    let ids = red_agents::launch::conversation_ids(&recipes, &cli);
    let environment = environment_json(&recipes, &BTreeOverrides::none());
    let read = red_agents::handoff::read_handoff(manifest, project.as_deref(), &environment, &declared, ids.as_deref()).map_err(plain)?;
    let root = read.get("project").and_then(Value::as_str).unwrap_or_default().to_string();
    let filename = read.get("filename").and_then(Value::as_str).unwrap_or_default().to_string();
    let home = absolute(&options.state).join("agents").to_string_lossy().into_owned();
    let with_home = environment_json(&recipes, &BTreeOverrides::one("RENGINE_AGENT_HOME", &home));
    red_agents::handoff::check_resume(&bash_path()?, &cli, Path::new(&root), &with_home).map_err(plain)?;
    options.agent = Some(cli);
    Ok((root, filename))
}

/// The refusals the host encodes as `status|message`; a command line has no status to carry.
fn plain(message: String) -> String {
    message.split_once('|').map(|(_, said)| said.to_string()).unwrap_or(message)
}

struct BTreeOverrides(Map<String, Value>);

impl BTreeOverrides {
    fn none() -> Self {
        Self(Map::new())
    }
    fn one(name: &str, value: &str) -> Self {
        let mut map = Map::new();
        map.insert(name.to_string(), Value::String(value.to_string()));
        Self(map)
    }
}

/// The shell envelope a CLI is launched into — `sessions-client.mjs`'s `envelope()`, with the
/// declarations the recipes carry already fetched.
fn environment_json(recipes: &[(String, red_agents::Value)], overrides: &BTreeOverrides) -> Value {
    let inherited: Map<String, Value> =
        std::env::vars().map(|(name, value)| (name, Value::String(value))).collect();
    let identity = red_agents::launch::process_identity(recipes);
    let installs = red_agents::launch::install_paths(recipes);
    let home = std::env::var("HOME").unwrap_or_default();
    let composed = red_agents::spawn::shell_environment(&overrides.0, &inherited, std::env::consts::OS, &home, &identity, &installs);
    Value::Object(composed.into_iter().map(|(name, value)| (name, Value::String(value))).collect())
}

fn bash_path() -> Result<String, String> {
    if let Some(declared) = std::env::var("RENGINE_BASH").ok().filter(|value| !value.is_empty()) {
        return Ok(declared);
    }
    Ok("/bin/bash".to_string())
}

/* ---- headless ---------------------------------------------------------------------------------*/

/// A headless host is the sidecar and nothing else (spec 090). It stays in the foreground and
/// supervises; stopping it leaves the sidecar and its sessions running.
fn headless(options: &Options, state_dir: &Path, root: &Path) -> Result<i32, String> {
    let instance = host::ensure(state_dir, root)?;
    let root_id = match options.project.as_deref() {
        Some(project) => {
            let answered = descriptor::request(&instance, "roots", Some(&json!({ "path": absolute(project).to_string_lossy() })), &[])?;
            answered.get("id").and_then(Value::as_str).unwrap_or("-").to_string()
        }
        None => "-".to_string(),
    };
    let pid = instance.pid.unwrap_or(0);
    println!(
        "rengine headless ready url={} instance={} pid={pid} state={} root={root_id}",
        instance.url,
        instance.instance,
        state_dir.display()
    );
    println!(
        "Its token is in {}; the bind is loopback, so reach it from another machine through your own tunnel. Stopping this process leaves the sidecar and its sessions running.",
        state_dir.join("sidecar.json").display()
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("the supervision loop would not start: {error}"))?;
    runtime.block_on(async move {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(error) => return Err(format!("SIGTERM cannot be watched: {error}")),
        };
        let mut beat = tokio::time::interval(Duration::from_secs(1));
        beat.tick().await;
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    println!("rengine headless detaching; sidecar PID {pid} keeps its sessions.");
                    return Ok(0);
                }
                _ = term.recv() => {
                    println!("rengine headless detaching; sidecar PID {pid} keeps its sessions.");
                    return Ok(0);
                }
                _ = beat.tick() => {
                    if !descriptor::alive(pid) {
                        println!("rengine headless stopped: sidecar PID {pid} exited. See {}.", state_dir.join("sidecar.log").display());
                        return Ok(1);
                    }
                }
            }
        }
    })
}

/* ---- the desktop ------------------------------------------------------------------------------*/

#[derive(Default)]
struct Opened {
    root: String,
    terminal: String,
    agent: String,
    game: String,
}

/// Everything the desktop is told to open with, decided against the host's own state so that a
/// second launcher on a live workspace reattaches rather than starting a second of everything.
fn open_workspace(instance: &Connection, options: &Options, state_dir: &Path) -> Result<Opened, String> {
    let mut opened = Opened::default();
    let Some(project) = options.project.as_deref() else { return Ok(opened) };
    let state = descriptor::request(instance, "state", None, &[])?;
    let capability = |name: &str| state.get("capabilities").and_then(|value| value.get(name)).and_then(Value::as_i64) == Some(1);
    if options.declaration.is_some() && !capability("externalDeclarations") {
        return Err("This retained session host predates external declarations. Use a separate --state directory, or start again with --replace-host; no sessions were started.".to_string());
    }
    let mut ask = json!({ "path": absolute(project).to_string_lossy() });
    if let Some(declaration) = options.declaration.as_deref() {
        ask["declarationFile"] = Value::String(absolute(declaration).to_string_lossy().into_owned());
    }
    let root = descriptor::request(instance, "roots", Some(&ask), &[])?;
    if options.handoff.is_some() && !capability("handoff") {
        return Err("This retained sidecar predates handoff support. Use a new --state directory, or start again with --replace-host.".to_string());
    }
    let root_id = root.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    opened.root = root_id.clone();

    let sessions: Vec<&Value> = state.get("sessions").and_then(Value::as_array).map(|items| items.iter().collect()).unwrap_or_default();
    let running = |session: &Value, kind: &str| {
        session.get("rootId").and_then(Value::as_str) == Some(root_id.as_str())
            && session.get("type").and_then(Value::as_str) == Some(kind)
            && session.get("state").and_then(Value::as_str) == Some("running")
    };
    if options.launch_game && !sessions.iter().any(|session| running(session, "game")) {
        let route = format!("game-config?rootId={}", red_core::http::encode(&root_id));
        let game = descriptor::request(instance, &route, None, &[])?;
        if game.get("ready").and_then(Value::as_bool) != Some(true) {
            let issues: Vec<String> = game
                .get("issues")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            return Err(issues.join("\n"));
        }
    }

    let terminal = match sessions.iter().find(|session| running(session, "terminal")) {
        Some(session) => (*session).clone(),
        None => descriptor::request(instance, "terminal", Some(&json!({ "rootId": root_id })), &[])?,
    };
    opened.terminal = terminal.get("id").and_then(Value::as_str).unwrap_or_default().to_string();

    if !options.no_agent {
        let preferred = state.get("preferences").and_then(|value| value.get("agent")).and_then(Value::as_str).unwrap_or_default();
        let agent = options.agent.clone().unwrap_or_else(|| preferred.to_string());
        if options.agent.is_some() {
            descriptor::request(instance, "preferences", Some(&json!({ "agent": agent })), &[])?;
        }
        let existing = if options.handoff.is_some() {
            None
        } else {
            sessions
                .iter()
                .find(|session| {
                    running(session, "agent")
                        && session.get("agent").and_then(Value::as_str).unwrap_or_default() == agent
                        && session.get("handoff").map(Value::is_null).unwrap_or(true)
                })
                .map(|session| (*session).clone())
        };
        let session = match existing {
            Some(session) => session,
            None => {
                let mut ask = json!({
                    "rootId": root_id, "type": "agent", "agent": agent,
                    "action": if agent.is_empty() { "menu" } else { "launch" },
                });
                if let Some(manifest) = options.handoff.as_deref() {
                    ask["handoffFile"] = Value::String(manifest.to_string());
                }
                descriptor::request(instance, "terminal", Some(&ask), &[])?
            }
        };
        opened.agent = session.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    }

    if options.launch_game {
        let game = descriptor::request(instance, "game", Some(&json!({ "rootId": root_id })), &[])?;
        opened.game = game.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    }
    let _ = state_dir;
    Ok(opened)
}

/// The desktop binary this checkout built.
fn desktop_binary(root: &Path) -> PathBuf {
    if let Some(named) = std::env::var("RENGINE_NATIVE_BINARY").ok().filter(|value| !value.is_empty()) {
        return PathBuf::from(named);
    }
    if cfg!(windows) {
        root.join(".cache/desktop/bin/Release/rengine.exe")
    } else {
        root.join(".cache/desktop/bin/rengine")
    }
}

/// Run the desktop until it exits for a reason other than an update.
///
/// **75 is "I saved and detached"** (spec 065): the desktop persisted its drafts and let go so a new
/// binary can take its place. Any other code is this launcher's own exit code.
fn run_desktop(root: &Path, instance: &Connection, opened: &Opened, resume: bool, inspect_ui: bool) -> Result<i32, String> {
    let binary = desktop_binary(root);
    let args: Vec<String> = if inspect_ui { vec!["--automation".to_string()] } else { Vec::new() };
    loop {
        let mut command = std::process::Command::new(&binary);
        command
            .args(&args)
            .env("RENGINE_WORKSPACE_URL", &instance.url)
            .env("RENGINE_WORKSPACE_TOKEN", &instance.token)
            .env("RENGINE_INITIAL_ROOT", &opened.root)
            .env("RENGINE_INITIAL_TERMINAL", &opened.terminal)
            .env("RENGINE_INITIAL_AGENT", &opened.agent)
            .env("RENGINE_INITIAL_GAME", &opened.game)
            .env("RENGINE_CAN_RELOAD", "1");
        if resume {
            command.env("RENGINE_RESUME_AGENT", "1");
        }
        let status = command.status().map_err(|error| format!("{} would not run: {error}", binary.display()))?;
        let code = status.code().unwrap_or(1);
        if code != DETACHED {
            return Ok(code);
        }
        println!("Rebuilding rEngine; agent and other sessions remain in the sidecar.");
        if let Err(why) = build() {
            eprintln!("{why}");
            eprintln!("Reload build failed. Fix the build and run the same launch command to reattach retained sessions.");
            return Ok(1);
        }
    }
}
