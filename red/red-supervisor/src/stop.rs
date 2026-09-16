//! Signalling: the acting half of a host replacement (F159, spec 145; spec 098, spec 102).
//!
//! [`crate::replace`] holds every DECISION — which process is a session host, which is a supervisor,
//! whose ancestor is whose, and what the report says. This module is what happens once those
//! decisions have been made: read `ps`, send a signal and wait for it to take, watch a port close,
//! start the next host. It is deliberately the smaller half, because the dangerous part of replacing
//! a session host is deciding, not doing.
//!
//! The order is the contract, and every line of it is a failure that has happened:
//!
//! 1. The refusals first, with nothing signalled.
//! 2. The **supervisor before the host**, so nothing recovers a worker against a dying host.
//! 3. The host, then its children — except the state directory's **PTY service** and **store**,
//!    which are named by the descriptors they published and left running (charter D60/D61).
//! 4. The port, watched until it stops accepting. A second host on a port the first still holds is
//!    a workspace nobody can reach.

use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use red_core::descriptor;
use serde_json::{json, Value};

use crate::replace::{self, Process};

/// How long a process has to honour SIGTERM, and then SIGKILL.
pub const GRACE: Duration = Duration::from_secs(8);
pub const AFTER_KILL: Duration = Duration::from_secs(3);
/// How long a port has to stop accepting connections after its owner exits.
pub const PORT_TIMEOUT: Duration = Duration::from_secs(5);
const KILL: i32 = 9;

/// The process table, from `ps` — never `pgrep`, whose `-f` answers with pids alone when the whole
/// command line is what tells a host from a supervisor from a pane.
pub fn list_processes() -> Result<Vec<Process>, String> {
    if cfg!(windows) {
        return Err("--replace-host is not supported on Windows yet: stop the session host from Task Manager, then start again."
            .to_string());
    }
    let output = std::process::Command::new("ps")
        .args(["-A", "-ww", "-o", "pid=,ppid=,command="])
        .output()
        .map_err(|error| format!("ps would not run: {error}"))?;
    if !output.status.success() {
        return Err(format!("ps failed ({})", output.status));
    }
    Ok(replace::parse_process_table(&String::from_utf8_lossy(&output.stdout)))
}

/// A table captured elsewhere, for reproducing a refusal from a machine that is not this one.
pub fn read_process_table(path: &Path) -> Result<Vec<Process>, String> {
    std::fs::read_to_string(path)
        .map(|text| replace::parse_process_table(&text))
        .map_err(|error| format!("{} cannot be read: {error}", path.display()))
}

/// One supervisor bound to a host instance, and the children that close with it.
pub struct Supervising {
    pub pid: i64,
    pub url: String,
    pub children: Vec<i64>,
}

/// The supervisors of this host instance: named by the runtime descriptor each published, confirmed
/// against the process table, and only if that pid is actually a supervisor. A descriptor left
/// behind by a different host names somebody else's process, and what follows a match here is a
/// SIGTERM.
pub fn find_supervisors(instance: &str, processes: &[Process], runtime_root: &Path) -> Result<Vec<Supervising>, String> {
    let entries = match std::fs::read_dir(runtime_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{} cannot be read: {error}", runtime_root.display())),
    };
    let mut names: Vec<std::path::PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    names.sort();
    let mut found = Vec::new();
    for directory in names {
        let Ok(text) = std::fs::read_to_string(directory.join("runtime.json")) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        if value.get("host").and_then(|host| host.get("instance")).and_then(Value::as_str) != Some(instance) {
            continue;
        }
        let Some(pid) = value.get("pid").and_then(Value::as_i64) else { continue };
        let Some(entry) = processes.iter().find(|candidate| candidate.pid == pid) else { continue };
        if !replace::supervises(&entry.command) {
            continue;
        }
        found.push(Supervising {
            pid,
            url: value.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
            children: processes.iter().filter(|candidate| candidate.ppid == pid).map(|candidate| candidate.pid).collect(),
        });
    }
    Ok(found)
}

/// What a signal achieved, in the words the report prints.
pub const ALREADY_GONE: &str = "already gone";
pub const ON_TERM: &str = "stopped on SIGTERM";
pub const AFTER_TERM: &str = "ignored SIGTERM, killed";

/// SIGTERM, then SIGKILL if it is ignored, and nothing at all at a pid that is already gone — which
/// may belong to somebody else by now.
pub fn stop_process(pid: i64, grace: Duration, after_kill: Duration) -> Result<String, String> {
    if !descriptor::alive(pid) {
        return Ok(ALREADY_GONE.to_string());
    }
    descriptor::signal(pid, descriptor::TERM);
    if gone(pid, grace) {
        return Ok(ON_TERM.to_string());
    }
    descriptor::signal(pid, KILL);
    if gone(pid, after_kill) {
        return Ok(AFTER_TERM.to_string());
    }
    Err(format!("PID {pid} is still alive after SIGKILL."))
}

fn gone(pid: i64, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while descriptor::alive(pid) {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

/// Has the port stopped accepting connections? A host that exited leaves its listener behind for as
/// long as the kernel holds it, and a second host bound to the same address is a workspace nobody
/// can reach.
pub fn port_released(url: &str, within: Duration) -> bool {
    use std::net::ToSocketAddrs;
    let Ok((socket, _)) = red_core::http::address(url) else { return true };
    let Ok(mut resolved) = socket.to_socket_addrs() else { return true };
    let Some(address) = resolved.next() else { return true };
    let deadline = Instant::now() + within;
    loop {
        match std::net::TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            Ok(_) => {
                if Instant::now() > deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return true,
        }
    }
}

/* The services that belong to the state directory rather than to the host: its PTYs (charter D60)
   and its store (D61). Each is a child in `ps` only because the parent that started it has not
   exited yet, and stopping either would take from the next host exactly what those decisions gave
   it — the panes in one case, the state in the other. */
const RETAINED: [(&str, &str); 2] = [("pty", "pty service"), ("store", "store service")];

/// The pids under this directory that are its own services, by the descriptor each published.
///
/// Only a missing or torn descriptor is "no service": a catch that swallowed everything once turned
/// a programming error in this function into "there is none", and the service was stopped anyway.
pub fn retained_services(state_dir: &Path) -> Result<Vec<(i64, String)>, String> {
    let mut found = Vec::new();
    for (name, role) in RETAINED {
        let path = state_dir.join(format!("{name}.json"));
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{} cannot be read: {error}", path.display())),
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(pid) = value.get("pid").and_then(Value::as_i64).filter(|pid| descriptor::alive(*pid)) {
            found.push((pid, role.to_string()));
        }
    }
    Ok(found)
}

/// Everything the acting half needs that is not a decision.
pub struct Replacing<'a> {
    pub state_dir: &'a Path,
    pub checkout: &'a Path,
    pub runtime_root: &'a Path,
    pub processes: Vec<Process>,
    pub self_pid: i64,
}

/// Replace the session host of a state directory, and answer the report a person reads.
///
/// The report is built as it goes, so a refusal halfway through still says what had already
/// happened — except that there is no halfway through: every refusal here comes before the first
/// signal.
pub fn replace_host(options: &Replacing) -> Result<Value, String> {
    let state_dir = options.state_dir;
    let display = state_dir.to_string_lossy().to_string();
    let mut report = json!({
        "stateDir": display, "previous": Value::Null,
        "ended": [], "stopped": [], "retained": [], "started": Value::Null,
    });
    let document = read_sidecar(state_dir)?;
    let found = replace::find_host(&display, document.as_ref(), &options.processes, &descriptor::alive, &resolved)?;
    match found {
        replace::Host::Live { pid } => {
            if replace::inside_host(pid, &options.processes, options.self_pid) {
                return Err(replace::inside_refusal(pid));
            }
            let document = document.expect("a live host has a descriptor");
            let connection = descriptor::check_connection(&document).ok();
            let mut previous = json!({
                "pid": pid,
                "url": document.get("url").cloned().unwrap_or(Value::Null),
                "instance": document.get("instance").cloned().unwrap_or(Value::Null),
            });
            if let Ok(at) = std::fs::metadata(state_dir.join("sidecar.json")).and_then(|meta| meta.modified()) {
                previous["startedAt"] = Value::String(crate::host::iso(at));
            }
            report["previous"] = previous;

            /* Asked before it is stopped, because afterwards nobody can: a person replacing a host
               wants to know which agent panes are about to change hands. A host that will not answer
               is a note, never a refusal — it is being stopped either way. */
            match connection.as_ref().map(|connection| descriptor::request(connection, "state", None, &[])) {
                Some(Ok(state)) => report["ended"] = Value::Array(running_sessions(&state)),
                Some(Err(why)) => {
                    report["note"] = Value::String(format!(
                        "the host did not answer /api/state before it was stopped ({why}); its running sessions could not be listed"
                    ))
                }
                None => {}
            }

            let instance = document.get("instance").and_then(Value::as_str).unwrap_or_default();
            let mut stopped: Vec<Value> = Vec::new();
            // Supervisor first, so nothing recovers a worker against a dying host.
            for supervisor in find_supervisors(instance, &options.processes, options.runtime_root)? {
                stopped.push(json!({ "role": "supervisor", "pid": supervisor.pid, "outcome": stop_process(supervisor.pid, GRACE, AFTER_KILL)? }));
                for child in supervisor.children {
                    if descriptor::alive(child) {
                        stopped.push(json!({ "role": "supervisor child", "pid": child, "outcome": stop_process(child, GRACE, AFTER_KILL)? }));
                    }
                }
            }
            stopped.push(json!({ "role": "host", "pid": pid, "outcome": stop_process(pid, GRACE, AFTER_KILL)? }));

            let services = retained_services(state_dir)?;
            let mut retained: Vec<Value> = Vec::new();
            for child in options.processes.iter().filter(|entry| entry.ppid == pid) {
                if let Some((_, role)) = services.iter().find(|(service, _)| *service == child.pid) {
                    retained.push(json!({ "role": role, "pid": child.pid }));
                    continue;
                }
                if descriptor::alive(child.pid) {
                    stopped.push(json!({ "role": "host child", "pid": child.pid, "outcome": stop_process(child.pid, GRACE, AFTER_KILL)? }));
                }
            }
            report["stopped"] = Value::Array(stopped);
            report["retained"] = Value::Array(retained);

            let url = document.get("url").and_then(Value::as_str).unwrap_or_default();
            if !port_released(url, PORT_TIMEOUT) {
                return Err(format!("{url} still accepts connections after PID {pid} exited; not starting a second host."));
            }
            let _ = std::fs::remove_file(state_dir.join("sidecar.json"));
        }
        replace::Host::Stale => {
            let mut previous = document.clone().unwrap_or(json!({}));
            previous["stale"] = Value::Bool(true);
            report["previous"] = previous;
            let _ = std::fs::remove_file(state_dir.join("sidecar.json"));
        }
        replace::Host::None => {}
    }

    let started = crate::host::ensure(state_dir, options.checkout)?;
    report["started"] = json!({
        "pid": started.pid, "url": started.url, "instance": started.instance,
        /* With the trailing separator the JavaScript's `new URL('../../')` produced: this string is
           printed, and the report is a record a person compares against another run. */
        "checkout": format!("{}/", options.checkout.to_string_lossy().trim_end_matches('/')),
    });
    Ok(report)
}

fn read_sidecar(state_dir: &Path) -> Result<Option<Value>, String> {
    let path = state_dir.join("sidecar.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|error| format!("{} is not readable JSON: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} cannot be read: {error}", path.display())),
    }
}

fn resolved(path: &str) -> String {
    std::fs::canonicalize(path).map(|found| found.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string())
}

fn running_sessions(state: &Value) -> Vec<Value> {
    state
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|session| session.get("state").and_then(Value::as_str) == Some("running"))
        .map(|session| {
            let mut kept = serde_json::Map::new();
            for name in ["id", "type", "title", "agent", "conversation"] {
                if let Some(value) = session.get(name) {
                    kept.insert(name.to_string(), value.clone());
                }
            }
            Value::Object(kept)
        })
        .collect()
}

/* ---- restart-supervisor: the other tool, for the other layer ---------------------------------- */

/// What a restart would do, without doing any of it.
pub struct Plan {
    pub host: Held,
    pub supervisors: Vec<Supervising>,
}

/// The host a restart keeps: the two fields the report names it by.
///
/// Deliberately NOT a [`Connection`]: nothing here talks to the host, and demanding a well-formed
/// one would refuse a restart with "invalid workspace connection" for a workspace that is running
/// perfectly well — a refusal nobody could act on.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub pid: i64,
    pub instance: String,
}

/// Refused by name rather than signalled: a state directory's host and its supervisor are different
/// processes, and the failure worth preventing is stopping the one that holds the sessions.
///
/// `find_host`'s own refusals are more specific than anything here could say, so they travel; only
/// "there is no host at all" is answered as a plan.
pub fn plan(state_dir: &Path, processes: &[Process], runtime_root: &Path) -> Result<Plan, String> {
    let display = state_dir.to_string_lossy().to_string();
    let document = read_sidecar(state_dir)?;
    let found = replace::find_host(&display, document.as_ref(), processes, &descriptor::alive, &resolved)?;
    let replace::Host::Live { pid } = found else {
        return Err(format!("No live session host serves {display}; there is no supervisor of its own to restart."));
    };
    let document = document.expect("a live host has a descriptor");
    let host = Held { pid, instance: document.get("instance").and_then(Value::as_str).unwrap_or_default().to_string() };
    let supervisors = find_supervisors(&host.instance, processes, runtime_root)?;
    Ok(Plan { host, supervisors })
}

/// What a restart did.
pub struct Restarted {
    pub host: Held,
    pub stopped: Vec<(i64, String, usize)>,
    pub started: Option<i64>,
}

/// Stop this host's supervisors and start a fresh one from this checkout, leaving the host alone.
///
/// The new launcher is **detached in its own session**: whoever asked for the restart is usually a
/// pane inside the workspace being restarted, and a supervisor that stayed its child would die with
/// it. The host is adopted rather than replaced — no `--replace-host` here, deliberately.
pub fn restart(state_dir: &Path, processes: &[Process], runtime_root: &Path, launch: bool, checkout: &Path) -> Result<Restarted, String> {
    let planned = plan(state_dir, processes, runtime_root)?;
    let mut stopped = Vec::new();
    for supervisor in &planned.supervisors {
        /* The desktops are this supervisor's children and go with it; naming them is the whole
           warning, because a person watching their editor vanish should find it predicted here. */
        let outcome = stop_process(supervisor.pid, GRACE, AFTER_KILL)?;
        stopped.push((supervisor.pid, outcome, supervisor.children.len()));
        if !supervisor.url.is_empty() {
            let _ = port_released(&supervisor.url, PORT_TIMEOUT);
        }
    }
    if !launch {
        return Ok(Restarted { host: planned.host, stopped, started: None });
    }
    /* `$RENGINE_RED_LAUNCH` names the launcher everywhere else in this tree, so it names it here
       too — including to a spec that wants to see what a restart starts without starting a
       workspace. */
    let launcher = match std::env::var("RENGINE_RED_LAUNCH").ok().filter(|value| !value.is_empty()) {
        Some(named) => std::path::PathBuf::from(named),
        None => std::env::current_exe().map_err(|error| format!("this launcher cannot name itself: {error}"))?,
    };
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state_dir.join("sidecar.log"))
        .map_err(|error| format!("{} cannot be opened: {error}", state_dir.join("sidecar.log").display()))?;
    let args = restart_arguments(state_dir);
    let _ = checkout;
    let pid = red_core::service::spawn_detached(&launcher, &args, log)?;
    Ok(Restarted { host: planned.host, stopped, started: Some(pid) })
}

/// What a restart starts: this same launcher, on this state directory, with no agent.
///
/// `--replace-host` is deliberately **absent**. The host is adopted rather than replaced — ending
/// every session is the other tool's job, and doing it here would take the terminals, agents and
/// drafts that this one exists to keep.
pub fn restart_arguments(state_dir: &Path) -> Vec<String> {
    vec!["--state".to_string(), state_dir.to_string_lossy().to_string(), "--no-agent".to_string()]
}

/// The report `restart-supervisor` prints. Its first line is the promise it keeps.
pub fn describe_restart(result: &Restarted) -> String {
    let mut lines = vec![format!(
        "Session host PID {} ({}) was not signalled; its sessions are intact.",
        result.host.pid, result.host.instance
    )];
    if result.stopped.is_empty() {
        lines.push("No update supervisor was running for it.".to_string());
    }
    for (pid, outcome, desktops) in &result.stopped {
        let closing = if *desktops > 0 { format!(", closing {desktops} managed desktop window(s)") } else { String::new() };
        lines.push(format!("Supervisor PID {pid}: {outcome}{closing}."));
    }
    if let Some(pid) = result.started {
        lines.push(format!("Started detached: PID {pid}. The desktop reopens on the layout the store kept."));
    }
    lines.join("\n")
}

/// Read what a child said, for a caller that wants its first line. Kept here because two commands
/// want it and neither is a place for it.
pub fn first_line(mut source: impl Read) -> String {
    let mut text = String::new();
    let _ = source.read_to_string(&mut text);
    text.lines().next().unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Vec<Process> {
        replace::parse_process_table(
            "\n    1     0 /sbin/launchd\n 9599     1 /usr/bin/node /home/x/rengine/orchestrator/runtime/supervisor.mjs\n 9603  9599 /home/x/rengine/red/target/debug/red-worker --state /x --host http://127.0.0.1:1234\n82044  9599 /home/x/rengine/.cache/runtime/d5fe12fe/versions/ccd74ad2/bin/rengine --control\n90359     1 /usr/bin/node /home/x/vtmb-vr/third_party/rengine/orchestrator/runtime/supervisor.mjs\n",
        )
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!("rengine-stop-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("scratch");
        directory
    }

    fn put(root: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(root.join(name)).expect("directory");
        std::fs::write(root.join(name).join("runtime.json"), body).expect("descriptor");
    }

    /* The JavaScript's own case, moved here with the function: only a supervisor bound to THIS host
       instance, alive, and actually a supervisor is selected. Each of the others is a real shape —
       another workspace's, a pid reused by a worker, a descriptor whose process is gone, a torn
       file, an empty directory. */
    #[test]
    fn only_a_supervisor_bound_to_this_host_instance_and_actually_a_supervisor_is_selected() {
        let root = scratch("runtime");
        put(&root, "ours", r#"{"version":1,"pid":9599,"url":"http://127.0.0.1:54352","host":{"instance":"d5fe12fe"}}"#);
        put(&root, "theirs", r#"{"version":1,"pid":90359,"url":"http://127.0.0.1:1","host":{"instance":"vtmb"}}"#);
        put(&root, "reused-pid", r#"{"version":1,"pid":9603,"url":"http://127.0.0.1:2","host":{"instance":"d5fe12fe"}}"#);
        put(&root, "gone", r#"{"version":1,"pid":40404,"url":"http://127.0.0.1:3","host":{"instance":"d5fe12fe"}}"#);
        put(&root, "broken", "{not json");
        std::fs::create_dir_all(root.join("empty")).expect("empty");

        let found = find_supervisors("d5fe12fe", &table(), &root).expect("read");
        assert_eq!(found.len(), 1, "one supervisor, not four");
        assert_eq!(found[0].pid, 9599);
        assert_eq!(found[0].url, "http://127.0.0.1:54352");
        assert_eq!(found[0].children, vec![9603, 82044], "the children that close with it");

        assert!(find_supervisors("d5fe12fe", &table(), &root.join("absent")).expect("read").is_empty());
    }

    /* A pid that is already gone is not signalled at all: it may belong to somebody else by now. */
    #[test]
    fn nothing_is_signalled_at_a_pid_that_is_already_gone() {
        assert_eq!(stop_process(2_147_483_000, Duration::from_millis(1), Duration::from_millis(1)), Ok(ALREADY_GONE.to_string()));
    }

    /* A process that honours SIGTERM gets nothing else — and one that ignores it is killed, in
       that order. Each is started as a GRANDchild that outlives the shell which spawned it, because
       a child of this test would linger as a zombie and read as alive after it was signalled: what
       this function stops is never its own child. */
    fn orphan(script: &str) -> i64 {
        let done = std::process::Command::new("/bin/sh")
            /* The grandchild's own stdout is closed, or `output()` would wait for an end-of-file
               that only arrives when the process this test means to outlive has exited. */
            .args(["-c", &format!("{script} >/dev/null 2>&1 & echo $!")])
            .output()
            .expect("a shell");
        String::from_utf8_lossy(&done.stdout).trim().parse::<i64>().expect("a pid")
    }

    #[test]
    fn a_process_that_honours_sigterm_gets_nothing_else() {
        let pid = orphan("sleep 30");
        assert_eq!(stop_process(pid, GRACE, AFTER_KILL), Ok(ON_TERM.to_string()));
    }

    #[test]
    fn a_process_that_ignores_sigterm_is_killed() {
        let ready = scratch("stubborn").join("ready");
        let pid = orphan(&format!("sh -c 'trap \"\" TERM; : > {}; while :; do sleep 0.1; done'", ready.display()));
        /* Waited for, and this is the whole reason the first run of this test passed for the wrong
           reason: the trap is installed by the child, and `$!` is printed by its PARENT. A signal
           sent in between reaches a process that has not yet said it will ignore it, and the test
           watches SIGTERM work on a process meant to survive it. */
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "the stubborn child never started");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(stop_process(pid, Duration::from_millis(300), AFTER_KILL), Ok(AFTER_TERM.to_string()));
    }

    /* A port nobody is listening on is released; one that is accepting is not, and the wait is
       bounded rather than forever. */
    #[test]
    fn a_port_is_released_when_it_stops_accepting() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
        let url = format!("http://127.0.0.1:{}", listener.local_addr().expect("address").port());
        assert!(!port_released(&url, Duration::from_millis(1)), "it is accepting");
        drop(listener);
        assert!(port_released(&url, Duration::from_millis(1)), "and now it is not");
    }

    /* The one thing a restart must not do is end the sessions it exists to keep. */
    #[test]
    fn a_restart_adopts_the_host_rather_than_replacing_it() {
        let args = restart_arguments(Path::new("/state/dir"));
        assert_eq!(args, vec!["--state".to_string(), "/state/dir".to_string(), "--no-agent".to_string()]);
        assert!(!args.iter().any(|value| value == "--replace-host"), "{args:?}");
    }

    /* Only a missing or torn descriptor is "no service". A descriptor naming a dead pid is not a
       service either — and one naming a live one is, by the descriptor it published rather than by
       any command line. */
    #[test]
    fn the_directorys_own_services_are_named_by_the_descriptors_they_published() {
        let directory = scratch("services");
        assert!(retained_services(&directory).expect("read").is_empty());
        std::fs::write(directory.join("pty.json"), r#"{"pid":2147483000}"#).expect("descriptor");
        std::fs::write(directory.join("store.json"), "{not json").expect("descriptor");
        assert!(retained_services(&directory).expect("read").is_empty(), "a dead pid and a torn file are both no service");
        std::fs::write(directory.join("pty.json"), format!(r#"{{"pid":{}}}"#, std::process::id())).expect("descriptor");
        assert_eq!(retained_services(&directory).expect("read"), vec![(std::process::id() as i64, "pty service".to_string())]);
    }
}
