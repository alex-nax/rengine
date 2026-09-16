//! Which process gets a SIGTERM, and which must not (F159, spec 144; spec 098).
//!
//! Replacing a session host is the one operation in this workspace that signals things a person
//! cares about. It starts from a descriptor that names a pid, and a pid is recycled in minutes on a
//! busy machine — so almost everything here is a **refusal to signal**:
//!
//! - a pid that is alive but is **not a session host**;
//! - a host that serves a **different state directory**;
//! - a launcher running **inside the workspace it would replace**, which would die with the host it
//!   signalled, halfway through.
//!
//! Two things are deliberately not stopped with the host: the state directory's **PTY service** and
//! its **store** (charter D60/D61). They are children in `ps` only because the parent that started
//! them has not exited yet, and stopping either would take from the next host exactly what those
//! decisions gave it — the panes in one case, the state in the other. They are named by the
//! descriptor each published, never by a command line.
//!
//! The report is the other half, and it is read by a person deciding whether their editor is about
//! to vanish. Every line of it says what happened to a process.

use serde_json::{json, Value};

/// One row of `ps -A -ww -o pid=,ppid=,command=`.
#[derive(Debug, Clone, PartialEq)]
pub struct Process {
    pub pid: i64,
    pub ppid: i64,
    pub command: String,
}

/// `ps`, never `pgrep`: the full command line is what tells a host from a supervisor from a pane,
/// and `pgrep -f` answers with pids alone.
pub fn parse_process_table(text: &str) -> Vec<Process> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let mut parts = trimmed.splitn(3, char::is_whitespace);
        let (Some(pid), Some(rest)) = (parts.next(), parts.next().map(|_| trimmed)) else { continue };
        let Ok(pid) = pid.parse::<i64>() else { continue };
        /* The COMMAND is everything after the second number, spaces and all: a state directory with
           a space in its name is one directory, and a split on whitespace would make it two. */
        let after_pid = rest[pid.to_string().len()..].trim_start();
        let mut second = after_pid.splitn(2, char::is_whitespace);
        let Some(ppid) = second.next().and_then(|value| value.parse::<i64>().ok()) else { continue };
        let command = second.next().unwrap_or_default().trim().to_string();
        rows.push(Process { pid, ppid, command });
    }
    rows
}

/// The state directory a session host serves, read off its command line — `red_core`'s, because a
/// worker looking for its workspace's credential reads the same table for the same reason, and two
/// answers to "is that a session host?" is two chances to refuse a live one.
pub use red_core::descriptor::host_arguments;

/// Every pid between this one and the top of the tree.
pub fn ancestors_of(pid: i64, processes: &[Process]) -> Vec<i64> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = processes.iter().find(|entry| entry.pid == pid);
    while let Some(entry) = current {
        if entry.ppid <= 0 || !seen.insert(entry.ppid) {
            break;
        }
        chain.push(entry.ppid);
        current = processes.iter().find(|candidate| candidate.pid == entry.ppid);
    }
    chain
}

/// Is the process asking for this replacement running inside the workspace it would replace?
///
/// A pane inside the host dies with it, halfway through — so this is refused rather than attempted,
/// and the refusal says where to run the command instead.
pub fn inside_host(host_pid: i64, processes: &[Process], self_pid: i64) -> bool {
    ancestors_of(self_pid, processes).contains(&host_pid)
}

/// Is this command line an update supervisor?
///
/// Two spellings, because the supervisor is a binary now and a workspace started before that upgrade
/// is still running the module. A check that knew only one would leave a live supervisor running
/// through a host replacement.
pub fn supervises(command: &str) -> bool {
    command.contains("runtime/supervisor.mjs") || is_red_supervisor(command)
}

fn is_red_supervisor(command: &str) -> bool {
    let first = command.split_whitespace().next().unwrap_or_default();
    first.rsplit('/').next() == Some("red-supervisor")
}

/// What the descriptor's pid turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum Host {
    /// Nothing is recorded for this directory.
    None,
    /// A descriptor, naming a process that is gone.
    Stale,
    /// The live session host of this directory.
    Live { pid: i64 },
}

/// The host of a state directory, or the refusal that says why that pid is not it.
///
/// `resolve` is handed in because the comparison is about where two paths END UP: a state directory
/// reached through a symlink is the same directory, and a check on the strings would replace a host
/// somebody else is using or refuse to replace one that is ours.
pub fn find_host(
    state_dir: &str,
    descriptor: Option<&Value>,
    processes: &[Process],
    alive: &dyn Fn(i64) -> bool,
    resolve: &dyn Fn(&str) -> String,
) -> Result<Host, String> {
    let Some(descriptor) = descriptor else { return Ok(Host::None) };
    let pid = descriptor.get("pid").and_then(Value::as_i64).filter(|pid| *pid > 0);
    let entry = pid.and_then(|pid| processes.iter().find(|candidate| candidate.pid == pid));
    let (Some(pid), Some(entry)) = (pid, entry) else { return Ok(Host::Stale) };
    if !alive(pid) {
        return Ok(Host::Stale);
    }
    let Some((_, served)) = host_arguments(&entry.command) else {
        return Err(format!(
            "{}/sidecar.json names PID {pid}, but that process is not a session host: {}. Nothing was signalled.",
            state_dir, entry.command
        ));
    };
    if resolve(&served) != resolve(state_dir) {
        return Err(format!("PID {pid} is the session host of {served}, not {state_dir}. Nothing was signalled."));
    }
    Ok(Host::Live { pid })
}

/// The refusal a launcher inside the workspace gets. It says where to run the command instead,
/// because "run it somewhere else" is useless without somewhere.
pub fn inside_refusal(pid: i64) -> String {
    format!(
        "This launcher is running inside the workspace it would replace: session host PID {pid} is one of its ancestors, \
and a pane inside dies with the host. Run the same command from a terminal outside rEngine, such as Terminal.app. \
Nothing was signalled."
    )
}

fn text(value: &Value, name: &str) -> String {
    value.get(name).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The report a person reads after a replacement.
///
/// Every line is what happened to a process, in the order it happened. The sessions are **handed
/// over** rather than ended — since charter D60 the PTYs belong to the state directory and the next
/// host adopts them — and they are still listed, because somebody replacing a host wants to know
/// which agent panes are about to change hands.
pub fn describe_report(report: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    let state_dir = text(report, "stateDir");
    let previous = report.get("previous").filter(|value| !value.is_null());
    match previous {
        None => lines.push(format!("No session host was recorded in {state_dir}; nothing to replace.")),
        Some(previous) if previous.get("stale") == Some(&Value::Bool(true)) => lines.push(format!(
            "sidecar.json in {state_dir} named PID {}, which is gone; the stale descriptor was removed.",
            previous.get("pid").and_then(Value::as_i64).unwrap_or(0)
        )),
        Some(previous) => {
            lines.push(format!("Replaced the session host of {state_dir}:"));
            let started = previous.get("startedAt").and_then(Value::as_str).map(|at| format!(", started {at}")).unwrap_or_default();
            lines.push(format!(
                "  stopped host PID {} ({}, instance {}{started})",
                previous.get("pid").and_then(Value::as_i64).unwrap_or(0),
                text(previous, "url"),
                text(previous, "instance")
            ));
            for item in report.get("stopped").and_then(Value::as_array).cloned().unwrap_or_default() {
                lines.push(format!(
                    "  {} PID {}: {}",
                    text(&item, "role"),
                    item.get("pid").and_then(Value::as_i64).unwrap_or(0),
                    text(&item, "outcome")
                ));
            }
            let ended = report.get("ended").and_then(Value::as_array).cloned().unwrap_or_default();
            lines.push(if ended.is_empty() {
                "  no running sessions to hand over".to_string()
            } else {
                format!("  handed {} running session(s) to the next host:", ended.len())
            });
            for session in &ended {
                let agent = session.get("agent").and_then(Value::as_str).map(|name| format!(" ({name})")).unwrap_or_default();
                let named = session
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| text(session, "id"));
                let conversation = session
                    .get("conversation")
                    .and_then(Value::as_str)
                    .map(|id| format!(", conversation {id}"))
                    .unwrap_or_default();
                lines.push(format!("    {}{agent} — {named}{conversation}", text(session, "type")));
            }
            for service in report.get("retained").and_then(Value::as_array).cloned().unwrap_or_default() {
                lines.push(format!(
                    "  left the {} running (PID {}): it belongs to {state_dir}, not to a host",
                    text(&service, "role"),
                    service.get("pid").and_then(Value::as_i64).unwrap_or(0)
                ));
            }
            if let Some(note) = report.get("note").and_then(Value::as_str) {
                lines.push(format!("  note: {note}"));
            }
        }
    }
    let started = report.get("started").cloned().unwrap_or(json!({}));
    lines.push(format!(
        "Started host PID {} ({}, instance {}) from {}.",
        started.get("pid").and_then(Value::as_i64).unwrap_or(0),
        text(&started, "url"),
        text(&started, "instance"),
        text(&started, "checkout")
    ));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|red| red.parent())
            .expect("the checkout")
            .join("tests/replace-host-corpus.json");
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the recorded answers")).expect("a record")
    }

    /// The reports the record describes, rebuilt here from the same fixture data.
    fn report(name: &str, started: &str) -> Value {
        let base = "/home/x/.local/state/redit/hirebase-v2";
        let start = json!({ "pid": 70001, "url": "http://127.0.0.1:61999", "instance": "ab12cd34", "checkout": "/home/x/rengine/" });
        let host = json!({ "pid": 68944, "url": "http://127.0.0.1:61942", "instance": "d5fe12fe", "startedAt": started });
        match name {
            "full" => json!({
                "stateDir": base, "previous": host,
                "ended": [
                    { "id": "s1", "type": "agent", "title": "claude · hirebase", "agent": "claude", "conversation": "287bba3a" },
                    { "id": "s2", "type": "terminal", "title": "build" },
                ],
                "stopped": [
                    { "role": "supervisor", "pid": 9599, "outcome": "stopped on SIGTERM" },
                    { "role": "supervisor child", "pid": 82044, "outcome": "ignored SIGTERM, killed" },
                    { "role": "host", "pid": 68944, "outcome": "stopped on SIGTERM" },
                    { "role": "host child", "pid": 12336, "outcome": "already gone" },
                ],
                "retained": [{ "role": "pty service", "pid": 10282 }, { "role": "store service", "pid": 10280 }],
                "started": start,
            }),
            "empty" => json!({
                "stateDir": base,
                "previous": { "pid": 68944, "url": "http://127.0.0.1:61942", "instance": "d5fe12fe" },
                "ended": [], "stopped": [{ "role": "host", "pid": 68944, "outcome": "stopped on SIGTERM" }],
                "retained": [], "started": start,
            }),
            "stale" => json!({
                "stateDir": base,
                "previous": { "pid": 68944, "url": "http://127.0.0.1:61942", "instance": "d5fe12fe", "stale": true },
                "ended": [], "stopped": [], "retained": [], "started": start,
            }),
            "none" => json!({ "stateDir": base, "previous": Value::Null, "ended": [], "stopped": [], "retained": [], "started": start }),
            "silent" => json!({
                "stateDir": base, "previous": host, "ended": [],
                "stopped": [{ "role": "host", "pid": 68944, "outcome": "stopped on SIGTERM" }], "retained": [],
                "note": "the host did not answer /api/state before it was stopped (fetch failed); its running sessions could not be listed",
                "started": start,
            }),
            other => panic!("unknown report {other}"),
        }
    }

    #[test]
    fn the_answers_are_the_ones_the_javascript_gave() {
        let record = recorded();
        let table = parse_process_table(record["table"].as_str().expect("the table"));
        /* Only the pids the case says are alive, because this table belongs to another machine. */
        let mut seen = 0;
        for case in record["cases"].as_array().expect("cases") {
            let op = &case["op"];
            let name = case["name"].as_str().unwrap_or_default();
            let answer = &case["answer"];
            match op["call"].as_str().expect("a call") {
                "parseProcessTable" => {
                    let rows: Vec<Value> = table
                        .iter()
                        .map(|row| json!({ "pid": row.pid, "ppid": row.ppid, "command": row.command }))
                        .collect();
                    assert_eq!(Value::Array(rows), answer["value"], "{name}");
                }
                "hostArguments" => {
                    let seen = host_arguments(op["command"].as_str().expect("a command"))
                        .map(|(script, state_dir)| json!({ "script": script, "stateDir": state_dir }))
                        .unwrap_or(Value::Null);
                    assert_eq!(seen, answer["value"], "{name}");
                }
                "ancestorsOf" => {
                    let chain: Vec<Value> = ancestors_of(op["pid"].as_i64().expect("a pid"), &table).into_iter().map(Value::from).collect();
                    assert_eq!(Value::Array(chain), answer["value"], "{name}");
                }
                "insideHost" => {
                    let seen = inside_host(op["hostPid"].as_i64().expect("a pid"), &table, op["self"].as_i64().expect("a pid"));
                    assert_eq!(json!(seen), answer["value"], "{name}");
                }
                "supervises" => assert_eq!(json!(supervises(op["command"].as_str().expect("a command"))), answer["value"], "{name}"),
                "findHost" => {
                    let live: Vec<i64> = op["alive"].as_array().cloned().unwrap_or_default().iter().filter_map(Value::as_i64).collect();
                    let descriptor = op.get("descriptor").filter(|value| !value.is_null());
                    let found = find_host(
                        op["stateDir"].as_str().expect("a directory"),
                        descriptor,
                        &table,
                        &|pid| live.contains(&pid),
                        &|path| path.to_string(),
                    );
                    match found {
                        Ok(host) => {
                            let (pid, stale) = match host {
                                Host::Live { pid } => (json!(pid), false),
                                Host::Stale => (Value::Null, true),
                                Host::None => (Value::Null, false),
                            };
                            assert_eq!(
                                json!({ "descriptor": descriptor.cloned().unwrap_or(Value::Null), "pid": pid, "stale": stale }),
                                answer["value"],
                                "{name}"
                            );
                        }
                        Err(why) => assert_eq!(json!(why), answer["refused"], "{name}"),
                    }
                }
                "describeReport" => {
                    let which = op["report"].as_str().expect("a report");
                    /* The JavaScript wrote a Date, which `toISOString` rendered; the record holds
                       what a person saw. */
                    let started = if which == "full" || which == "silent" { "2026-09-10T08:30:00.000Z" } else { "" };
                    let built = report(which, started);
                    let mut fields = built.as_object().cloned().unwrap_or_default();
                    if started.is_empty() {
                        if let Some(previous) = fields.get_mut("previous").and_then(Value::as_object_mut) {
                            previous.remove("startedAt");
                        }
                    }
                    assert_eq!(json!(describe_report(&Value::Object(fields))), answer["value"], "{name}");
                }
                other => panic!("unknown call {other}"),
            }
            seen += 1;
        }
        assert!(seen >= 24, "the whole record was replayed: {seen}");
    }

    /* The host is a BINARY now (F152), and a workspace started before that upgrade is still running
       the module. The frozen record predates the binary — it is what the JavaScript said on the day
       — so the new spelling gets its own case rather than a regenerated record. A check that knew
       only one spelling would refuse to replace a live host, which is a refusal nobody can act on. */
    #[test]
    fn both_spellings_of_a_session_host_name_the_directory_they_serve() {
        for command in [
            "/usr/bin/node /x/orchestrator/server/main.mjs --state /home/x/My Workspaces/with space",
            "/x/red/target/debug/red-host --state /home/x/My Workspaces/with space",
            "red-host --state /home/x/My Workspaces/with space",
        ] {
            let (_, directory) = host_arguments(command).unwrap_or_else(|| panic!("a host: {command}"));
            assert_eq!(directory, "/home/x/My Workspaces/with space", "{command}");
        }
        /* And the two processes that are NOT hosts, both of which sit beside one in the table. */
        for command in [
            "/x/red/target/debug/red-supervisor --state /x/.cache/runtime/d5fe12fe",
            "/x/red/target/debug/red-worker --state /x --host http://127.0.0.1:1234",
            "/usr/bin/node /x/orchestrator/runtime/supervisor.mjs",
            "/x/red-hostile --state /x",
        ] {
            assert_eq!(host_arguments(command), None, "{command}");
        }
    }

    /* The refusal that keeps a person from replacing the host their own terminal lives in. */
    #[test]
    fn a_launcher_inside_the_workspace_is_told_where_to_run_instead() {
        let said = inside_refusal(68944);
        assert!(said.contains("PID 68944 is one of its ancestors"), "{said}");
        assert!(said.contains("Terminal.app"), "'somewhere else' is useless without somewhere: {said}");
        assert!(said.ends_with("Nothing was signalled."), "{said}");
    }

    /* A path that reaches the same directory by another name is the same directory. Compared on the
       RESOLVED path, because a string comparison would refuse to replace a host that is ours. */
    #[test]
    fn a_state_directory_reached_through_a_link_is_the_same_directory() {
        let table = parse_process_table(" 68944     1 /usr/bin/node /x/orchestrator/server/main.mjs --state /real/state\n");
        let descriptor = json!({ "pid": 68944 });
        let resolve = |path: &str| if path == "/link/state" { "/real/state".to_string() } else { path.to_string() };
        assert_eq!(
            find_host("/link/state", Some(&descriptor), &table, &|_| true, &resolve),
            Ok(Host::Live { pid: 68944 })
        );
        /* And one that does not is still refused. */
        assert!(find_host("/other/state", Some(&descriptor), &table, &|_| true, &resolve).is_err());
    }
}
